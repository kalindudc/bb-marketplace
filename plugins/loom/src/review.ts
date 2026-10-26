// Reviewers: separate agent threads that judge a ticket that passed its checks. The plugin counts a verdict only
// from the reviewer row it started for the ticket's current round, and one transaction stores the verdict and
// applies the round outcome, so a crash cannot leave a verdict without one. The tick replays what a crash cut short.
import { randomBytes } from "node:crypto";
import { workerOf } from "./checks";
import { repoCheckout, ticketRepo } from "./checkouts";
import type { ProjectRow, ReviewRow, Store, ThreadRow, TicketRow } from "./db/store";
import { spawnEnvironment, threadBranch, ticketInputsOf } from "./environments";
import { plural } from "./format";
import { changesRequestedText, findingsList, reviewerBrief, reviewerNudgeText } from "./prompts";
import { openFeedback } from "./pull-requests";
import { nextWait, provisioningFailure, startProblemOf, startWaits, unavailableReason, waitOf, waitPost, type StartProblem, type StartWait } from "./starts";
import { LoomError } from "./projects";
import { NOT_PARKED, freeReviewerSlots, idleAction, type Parked } from "./scheduler";
import { deliverHandBacks, handBack } from "./slots";
import type { Spec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { applyMove, baseOf, endLiveRows, endThread, freshBase, otherCheckouts, pauseProject, released, resolveEnvironment, resumeEnding, retryRateLimited, specOf, type EndReason, type EngineCtx, type TurnFailure } from "./workers";

export interface Finding {
  severity: "blocking" | "should-fix";
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

const PATCH_BYTES = 60_000;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------- reading a round

type Standing = "live" | "ending" | "dead" | "unstarted";

/** A reviewer that did not start and waits to try again counts neither as live nor as one that ended without a verdict. */
export const UNSTARTED = "unstarted";

function standingOf(store: Store, review: ReviewRow): Standing {
  const row = review.thread_row_id === null ? null : store.thread(review.thread_row_id);
  if (row?.state === "ended" && row.end_reason === UNSTARTED) return "unstarted";
  if (row === null || row.state === "ended") return "dead";
  return row.state === "ending" ? "ending" : "live";
}

/** The current round of a ticket in review. Pending rows without a live thread count toward neither approvals nor `live`. */
function tally(store: Store, ticket: TicketRow, spec: Spec) {
  const rows = store.reviews(ticket.id, ticket.review_round);
  const approved = rows.filter((review) => review.verdict === "approved").length;
  const changes = rows.find((review) => review.verdict === "changes_requested") ?? null;
  const pending = rows.filter((review) => review.verdict === "pending");
  return {
    rows,
    approved,
    changes,
    live: pending.filter((review) => standingOf(store, review) === "live").length,
    dead: pending.filter((review) => standingOf(store, review) === "dead").length,
    decided: changes !== null || approved >= spec.review.approvals,
  };
}

/** Changes-requested verdicts on the ticket since its last requeue (blocked to queued), or since creation. */
function changesRequestedSinceRequeue(store: Store, ticketId: number): number {
  let count = 0;
  for (const event of store.ticketEvents(ticketId, ["ticket.state", "review.verdict"])) {
    const data = JSON.parse(event.data_json) as { from?: string; to?: string; verdict?: string };
    if (event.kind === "ticket.state" && data.from === "blocked" && data.to === "queued") count = 0;
    else if (event.kind === "review.verdict" && data.verdict === "changes_requested") count += 1;
  }
  return count;
}

// ---------------------------------------------------------------- the round outcome

type Outcome =
  | { kind: "approved" }
  | { kind: "changes" }
  | { kind: "requeued" }
  | { kind: "blocking"; worker: ThreadRow }
  | { kind: "blocked" }
  | { kind: "deferred" };

/**
 * Applies the outcome of a decided round, synchronously and idempotently: approvals reaching the requirement move the
 * ticket to approved; a changes-requested verdict hands it back to its worker, who gets the findings once a worker slot
 * is free (or sends it to the queue), or blocks it at max_rounds.
 * A worker that is still ending owns the ticket's move, so the outcome waits ("deferred") and the tick tries again.
 */
function decideRound(ctx: EngineCtx, ticketId: number): Outcome | null {
  const { store } = ctx;
  return store.tx(() => {
    const ticket = store.ticket(ticketId);
    if (ticket === null || ticket.state !== "review") return null;
    const spec = specOf(store, store.project(ticket.project_id)!);
    const round = tally(store, ticket, spec);
    if (round.changes !== null) return changesOutcome(ctx, ticket, spec, round.changes);
    if (round.approved < spec.review.approvals) return null;
    store.setTicketState(ticket.id, "approved", LOOM_ACTOR, { round: ticket.review_round, approvals: round.approved });
    return { kind: "approved" } as const;
  });
}

function changesOutcome(ctx: EngineCtx, ticket: TicketRow, spec: Spec, review: ReviewRow): Outcome {
  const { store } = ctx;
  const worker = workerOf(store, ticket);
  if (worker.standing === "ending") return { kind: "deferred" };

  const rounds = changesRequestedSinceRequeue(store, ticket.id);
  if (rounds >= spec.review.max_rounds) {
    const reason = `review requested changes in ${plural(rounds, "round")}`;
    // Claiming the worker here makes its ending, which carries the ticket's move to blocked, replayable by the tick.
    if (worker.standing === "active" && !store.claimThread(worker.row.id, "blocked")) return { kind: "deferred" };
    store.updateTicket(ticket.id, { blocked_reason: reason });
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
    if (worker.standing === "active") return { kind: "blocking", worker: store.thread(worker.row.id)! };
    applyMove(ctx, ticket, { to: "blocked", patch: { ...released, blocked_reason: reason } }, LOOM_ACTOR, { reason });
    return { kind: "blocked" };
  }
  if (worker.standing === "active" && worker.row.thread_id !== null) {
    const text = changesRequestedText(ticket.key, review.round, review.summary ?? "", JSON.parse(review.findings_json) as Finding[]);
    handBack(ctx, ticket, worker.row, worker.row.thread_id, text, { round: ticket.review_round });
    return { kind: "changes" };
  }
  applyMove(ctx, ticket, { to: "queued", patch: released }, LOOM_ACTOR, { reason: "the worker is gone" });
  return { kind: "requeued" };
}

/** What follows a committed outcome: the findings to the worker once it has a slot, the blocked worker's ending, and the reviewers the round no longer needs. */
async function afterOutcome(ctx: EngineCtx, ticketId: number, outcome: Outcome | null, exclude?: number): Promise<void> {
  const { store } = ctx;
  try {
    if (outcome?.kind === "changes") await deliverHandBacks(ctx, store.ticket(ticketId)!.project_id);
    if (outcome?.kind === "blocking") await resumeEnding(ctx, outcome.worker);
    await endStaleReviewers(ctx, { ticketId }, exclude);
  } finally {
    if (outcome !== null && outcome.kind !== "deferred") {
      store.changed(store.ticket(ticketId)!.project_id);
      ctx.kick();
    }
  }
}

async function settleRound(ctx: EngineCtx, ticketId: number): Promise<void> {
  await afterOutcome(ctx, ticketId, decideRound(ctx, ticketId));
}

// ---------------------------------------------------------------- stale reviewers

/** Why a live reviewer row has nothing left to do: it answered, or its ticket left review, moved to a new round, or was decided. */
function staleReason(store: Store, row: ThreadRow): "verdict" | "superseded" | null {
  const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
  if (ticket === null || ticket.state !== "review" || ticket.review_round !== row.review_round) return "superseded";
  const own = store.reviews(ticket.id, ticket.review_round).find((review) => review.thread_row_id === row.id);
  if (own !== undefined && own.verdict !== "pending") return "verdict";
  return tally(store, ticket, specOf(store, store.project(ticket.project_id)!)).decided ? "superseded" : null;
}

async function endStaleReviewers(ctx: EngineCtx, scope: { projectId?: number; ticketId?: number }, exclude?: number): Promise<void> {
  for (const row of ctx.store.threads({ ...scope, role: "reviewer", states: ["active"] })) {
    if (row.id === exclude) continue;
    const why = staleReason(ctx.store, row);
    if (why !== null) await endThread(ctx, row, why, { commit: false, move: null });
  }
}

// The reviewer's own thread is busy running the verdict tool, so its ending is not awaited by the tool.
const endingOwn = new WeakMap<Store, Set<Promise<void>>>();
const endingOwnOf = (store: Store) => endingOwn.get(store) ?? endingOwn.set(store, new Set()).get(store)!;

/** Waits for the reviewer endings that verdict tools started. For tests. */
export async function settleReviews(ctx: EngineCtx): Promise<void> {
  const pending = endingOwnOf(ctx.store);
  while (pending.size > 0) await Promise.all([...pending]);
}

// ---------------------------------------------------------------- spawning

/**
 * The tick's review step: end stale reviewers, settle decided rounds, block a ticket whose reviewers keep ending, and
 * start the reviewers a round still needs, within the reviewer slots. A reviewer that waits for the human (`parked`)
 * holds no slot.
 */
export async function spawnReviewers(ctx: EngineCtx, project: ProjectRow, spec: Spec, parked: Parked = NOT_PARKED): Promise<number> {
  const { store } = ctx;
  await endStaleReviewers(ctx, { projectId: project.id });
  let spawned = 0;
  for (const seen of store.tickets(project.id, ["review"])) {
    if (store.project(project.id)?.state !== "running") break;
    const ticket = store.ticket(seen.id)!;
    if (ticket.state !== "review") continue;
    const round = tally(store, ticket, spec);
    if (round.decided) {
      await settleRound(ctx, ticket.id);
      continue;
    }
    if (round.dead >= spec.review.approvals + 2) {
      await blockForReviewers(ctx, ticket, "reviewers ended without a verdict");
      continue;
    }
    if (startWaits(ticket, "reviewer", ctx.now())) continue;
    if (freeReviewerSlots(spec.agents.max_reviewers, store.threads({ projectId: project.id, role: "reviewer" }), parked.reviewers) === 0) continue;
    spawned += await startReviewers(ctx, project, spec, ticket, spec.review.approvals - round.approved - round.live, parked);
  }
  return spawned;
}

export const REVIEWER_REFUSED = "bb refused to start a reviewer";
export const REVIEWER_UNAVAILABLE = "no reviewer could start";

/** A blocked ticket whose last block was bb refusing its reviewer, or its provider staying unavailable. Its work passed the checks at its head commit, and no worker has touched it since. */
export function blockedAtReview(ticket: TicketRow): boolean {
  const reason = ticket.blocked_reason ?? "";
  return ticket.state === "blocked" && ticket.head_sha !== null && (reason.startsWith(`${REVIEWER_REFUSED}:`) || reason.startsWith(`${REVIEWER_UNAVAILABLE}:`));
}

/** Blocked back to review for the same head. The round is new, so the refused reviewer's pending review no longer counts as a reviewer that ended. */
export function backToReview(ctx: EngineCtx, ticket: TicketRow, note: string): void {
  const { store } = ctx;
  const round = ticket.review_round + 1;
  store.tx(() => {
    store.setTicketState(ticket.id, "review", LOOM_ACTOR, { head: ticket.head_sha, round, reason: "bb refused its reviewer, and a new spec version is approved" });
    store.updateTicket(ticket.id, { review_round: round, blocked_reason: null });
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "reply", body: note });
  });
  store.changed(ticket.project_id);
  ctx.kick();
}

async function blockForReviewers(ctx: EngineCtx, ticket: TicketRow, reason: string): Promise<void> {
  ctx.store.tx(() => {
    ctx.store.updateTicket(ticket.id, { blocked_reason: reason });
    ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
  });
  await endLiveRows(ctx, ctx.store.ticket(ticket.id)!, "blocked");
  ctx.kick();
}

type Diff = { stat: string; patch: string; truncated: boolean };

async function startReviewers(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, needed: number, parked: Parked): Promise<number> {
  if (needed <= 0 || ticket.head_sha === null) return 0;
  const diff = await readDiff(ctx, project, spec, ticket);
  if (diff === null) return 0;
  const checkouts = await otherCheckouts(ctx, project, spec, ticket);
  let started = 0;
  for (let n = 0; n < needed; n++) {
    if (!(await startReviewer(ctx, project.id, ticket, diff, checkouts, parked))) break;
    started += 1;
  }
  return started;
}

// A project that cannot show the reviewers their diff pauses with the reason instead of retrying every tick.
async function readDiff(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<Diff | null> {
  try {
    const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
    return await ctx.host.call(checkout.hostId, "diff", { repo: checkout.path, base: baseOf(spec, ticket), head: ticket.head_sha!, maxBytes: PATCH_BYTES });
  } catch (error) {
    pauseProject(ctx, project.id, `Could not read the diff of ${ticket.key} for review: ${errText(error)}`);
    return null;
  }
}

async function startReviewer(ctx: EngineCtx, projectId: number, seen: TicketRow, diff: Diff, checkouts: ReadonlyMap<string, string>, parked: Parked): Promise<boolean> {
  const { store } = ctx;
  const token = randomBytes(12).toString("hex");
  const round = seen.review_round;

  // The final eligibility check and the reservation share one synchronous transaction, as for workers. A reviewer that
  // waits after a failed start tries again with its own row and pending review.
  const reserved = store.tx(() => {
    const project = store.project(projectId);
    const ticket = store.ticket(seen.id);
    if (project?.state !== "running" || ticket === null || ticket.state !== "review" || ticket.review_round !== round || ticket.head_sha !== seen.head_sha) return null;
    if (startWaits(ticket, "reviewer", ctx.now())) return null;
    const spec = specOf(store, project);
    const current = tally(store, ticket, spec);
    const free = freeReviewerSlots(spec.agents.max_reviewers, store.threads({ projectId, role: "reviewer" }), parked.reviewers);
    if (current.decided || current.approved + current.live >= spec.review.approvals || free === 0) return null;
    const waiting = store.threads({ ticketId: ticket.id, role: "reviewer", states: ["ended"] }).find((row) => row.end_reason === UNSTARTED && row.review_round === round);
    if (waiting !== undefined) {
      store.updateThread(waiting.id, { state: "spawning", spawn_token: token, thread_id: null, environment_id: null, ended_at: null, end_reason: null, clock_at: ctx.now(), idle_count: 0, rate_limit_retries: 0 });
      return { row: store.thread(waiting.id)!, project, spec, ticket };
    }
    const created = store.addThread({ project_id: projectId, ticket_id: ticket.id, role: "reviewer", state: "spawning", spawn_token: token });
    store.updateThread(created.id, { review_round: round, clock_at: ctx.now() });
    store.addReview({ ticket_id: ticket.id, round, thread_row_id: created.id });
    return { row: store.thread(created.id)!, project, spec, ticket };
  });
  if (reserved === null) return false;

  const { row, project, spec, ticket } = reserved;
  const agent = spec.agents.reviewer;
  const brief = reviewerBrief({ project, spec, ticket, round, diff, checkPost: store.posts(ticket.id).filter((post) => post.kind === "check").at(-1) ?? null, earlierReviews: store.reviews(ticket.id).filter((review) => review.round < round), prFeedback: openFeedback(store.posts(ticket.id)), checkouts });
  let spawned;
  try {
    spawned = await ctx.bb.spawnThread({
      bbProjectId: ticketRepo(spec, ticket).bbProjectId ?? project.bb_project_id,
      hostId: project.host_id!,
      baseBranch: ticket.branch ?? freshBase(spec, ticket.repo),
      environment: spawnEnvironment(ticketRepo(spec, ticket), { branch: threadBranch(project.slug, ticket.key, `review-${round}-${row.id}`), base: ticket.branch ?? freshBase(spec, ticket.repo) }, "reviewer", ticketInputsOf(ticket)),
      title: `Review ${ticket.key} · round ${round}`,
      prompt: brief,
      sectionId: project.section_id,
      metadata: { project: project.slug, role: "reviewer", ticket: ticket.key, round: String(round), spawnToken: token },
      providerId: agent.provider,
      model: agent.model,
      reasoningLevel: agent.reasoning,
      permissionMode: agent.permission_mode,
    });
  } catch (error) {
    const problem = startProblemOf(error);
    if (problem.kind === "refused") {
      failReviewerSpawn(ctx, row, problem.message);
      await blockForReviewers(ctx, ticket, `${REVIEWER_REFUSED}: ${problem.message}`);
    } else {
      await reviewerStartFailed(ctx, row, problem);
    }
    return false;
  }

  const active = store.tx(() => {
    const current = store.thread(row.id)!;
    if (current.state !== "spawning") return null;
    store.updateThread(row.id, { state: "active", environment_id: spawned.environmentId, thread_id: current.thread_id ?? spawned.threadId });
    return store.thread(row.id)!;
  });
  if (active === null) return true;
  store.changed(project.id);
  if (staleReason(store, active) !== null || store.project(projectId)?.state === "archived") await endThread(ctx, active, "superseded", { commit: false, move: null });
  return true;
}

/**
 * A reviewer that did not start, or whose environment could not be provisioned, for a reason other than bb refusing it.
 * It waits and tries again (StartWait) with the same row and review; a failure counts as a reviewer that ended without a
 * verdict only once it has happened START_GRACE times in a row, and one bb or the provider says cannot start now never does.
 */
export async function reviewerStartFailed(ctx: EngineCtx, row: ThreadRow, problem: StartProblem): Promise<void> {
  const { store } = ctx;
  const expired = store.tx((): StartWait | null => {
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    const previous = ticket === null ? null : waitOf(ticket, "reviewer");
    const wait = nextWait(previous, { role: "reviewer", row: row.id, problem, now: ctx.now() });
    const counted = problem.kind === "broken" || wait.counted;
    store.updateThread(row.id, { state: "ended", ended_at: ctx.now(), end_reason: counted ? "failed" : UNSTARTED });
    if (ticket === null || ticket.state !== "review" || ticket.review_round !== row.review_round) return null;
    store.updateTicket(ticket.id, { start_wait_json: wait.expired ? null : JSON.stringify({ ...wait, row: counted ? null : row.id }) });
    if (wait.expired) return wait;
    const text = counted ? `Could not start a reviewer: ${problem.message}` : waitPost("a reviewer", wait, previous, ctx.now());
    if (text !== null) store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body: text });
    return null;
  });
  store.changed(row.project_id);
  ctx.kick();
  // A provider unavailable for the whole limit blocks the ticket, so triage hears of it.
  if (expired !== null) await blockForReviewers(ctx, store.ticket(row.ticket_id!)!, `${REVIEWER_UNAVAILABLE}: ${unavailableReason(expired)}`);
}

/** A reviewer that never started: only its threads row ends. Its review stays pending and counts as a reviewer that ended without a verdict. */
export function failReviewerSpawn(ctx: EngineCtx, row: ThreadRow, error: string): void {
  const { store } = ctx;
  store.tx(() => {
    store.updateThread(row.id, { state: "ended", ended_at: ctx.now(), end_reason: "failed" });
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    if (ticket !== null) store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body: `Could not start a reviewer: ${error}` });
  });
  store.changed(row.project_id);
}

// ---------------------------------------------------------------- verdicts

export function approve(ctx: EngineCtx, threadId: string, summary: string): Promise<string> {
  return verdict(ctx, threadId, "approved", summary, []);
}

export function requestChanges(ctx: EngineCtx, threadId: string, summary: string, findings: Finding[]): Promise<string> {
  return verdict(ctx, threadId, "changes_requested", summary, findings);
}

/** The reviewer row, its ticket and its pending review, or the reason this thread has no verdict to give. */
function pendingReview(store: Store, threadId: string): { row: ThreadRow; ticket: TicketRow; review: ReviewRow; spec: Spec } {
  const row = store.threadByThreadId(threadId);
  if (row === null || row.role !== "reviewer") throw new LoomError("loom_forbidden", "This tool is for a Loom reviewer thread.");
  if (row.state !== "active") throw new LoomError("loom_invalid_state", "This reviewer thread has ended, so its verdict is not needed. End your turn.");
  const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
  if (ticket === null || ticket.state !== "review" || ticket.review_round !== row.review_round) {
    throw new LoomError("loom_invalid_state", "This review round is over, so there is nothing to decide. End your turn.");
  }
  const spec = specOf(store, store.project(ticket.project_id)!);
  const round = tally(store, ticket, spec);
  const review = round.rows.find((candidate) => candidate.thread_row_id === row.id);
  if (review === undefined || review.verdict !== "pending") throw new LoomError("loom_invalid_state", "You already gave your verdict for this round. End your turn.");
  if (round.decided) throw new LoomError("loom_invalid_state", "This round is already decided by another reviewer. End your turn.");
  return { row, ticket, review, spec };
}

async function verdict(ctx: EngineCtx, threadId: string, kind: "approved" | "changes_requested", summary: string, findings: Finding[]): Promise<string> {
  const { store } = ctx;
  const text = summary.trim();
  if (text === "") throw new LoomError("loom_invalid_input", "The summary is empty. Say how each acceptance criterion holds, or what is wrong.");
  if (kind === "changes_requested" && findings.length === 0) throw new LoomError("loom_invalid_input", "Give at least one finding: a severity, a title and a detail.");

  const seen = pendingReview(store, threadId);
  await requireHeadCheckedOut(ctx, seen.row, seen.ticket, seen.spec);

  const outcome = store.tx(() => {
    const { row, ticket, review } = pendingReview(store, threadId);
    store.setVerdict(review.id, kind, text, findings);
    const body = kind === "approved" ? `Approved (round ${review.round}): ${text}` : `Changes requested (round ${review.round}): ${text}\n\nFindings:\n${findingsList(findings)}`;
    store.addPost({
      project_id: ticket.project_id,
      ticket_id: ticket.id,
      parent_id: null,
      author_kind: "reviewer",
      author_thread_id: row.thread_id,
      kind: "review",
      body,
      data_json: JSON.stringify({ round: review.round, verdict: kind, review: review.id, findings }),
    });
    return decideRound(ctx, ticket.id);
  });

  const { row, ticket } = seen;
  await afterOutcome(ctx, ticket.id, outcome, row.id);
  const ending = endThread(ctx, store.thread(row.id)!, "verdict", { commit: false, move: null })
    .then(() => undefined)
    .catch((error) => ctx.bb.log("warn", `Could not end reviewer ${threadId}: ${errText(error)}`))
    .finally(() => endingOwnOf(store).delete(ending));
  endingOwnOf(store).add(ending);
  return kind === "approved"
    ? `Your approval of ${ticket.key} (round ${seen.review.round}) is recorded. End your turn.`
    : `Your request for changes on ${ticket.key} (round ${seen.review.round}) is recorded and goes to the worker. End your turn.`;
}

// The reviewer's worktree starts at the branch tip, which the live worker can move; the verdict must be about the commit that merges.
async function requireHeadCheckedOut(ctx: EngineCtx, row: ThreadRow, ticket: TicketRow, spec: Spec): Promise<void> {
  const environment = await resolveEnvironment(ctx, row).catch((error) => {
    throw new LoomError("loom_unavailable", `Could not find your worktree: ${errText(error)}`);
  });
  if (environment?.path == null) throw new LoomError("loom_invalid_state", "Your worktree is not available yet. Try again in a moment.");
  const state = await ctx.host.call(environment.hostId, "worktreeState", { worktree: environment.path, base: baseOf(spec, ticket) }).catch((error) => {
    throw new LoomError("loom_unavailable", `Could not read your worktree: ${errText(error)}`);
  });
  if (state.head !== ticket.head_sha) throw new LoomError("loom_invalid_state", `Check out ${ticket.head_sha} first, then review again.`);
}

// ---------------------------------------------------------------- idle, failed turns, vanished threads

/** The first idle of a reviewer without a verdict gets a nudge; the next one ends the row, and the tick starts a replacement. */
export async function onReviewerIdle(ctx: EngineCtx, seen: ThreadRow, reason: EndReason = "abandoned"): Promise<void> {
  const { store } = ctx;
  const row = store.thread(seen.id);
  if (row === null || row.state !== "active" || row.role !== "reviewer" || row.thread_id === null) return;
  if (store.project(row.project_id)?.state === "archived") return;
  const over = staleReason(store, row);
  if (over !== null) {
    await endThread(ctx, row, over, { commit: false, move: null });
    return;
  }
  if (idleAction(row.idle_count) === "nudge") {
    store.updateThread(row.id, { idle_count: row.idle_count + 1 });
    const ticket = store.ticket(row.ticket_id!)!;
    await ctx.bb.send(row.thread_id, reviewerNudgeText(ticket.key, row.review_round));
  } else {
    await endThread(ctx, row, reason, { commit: false, move: null });
  }
}

/**
 * A failed turn: rate limits are retried at the window's reset, even while paused, since pausing never stops a reviewer;
 * a thread whose environment bb could not provision is a reviewer that did not start; anything else counts like an idle.
 */
export async function onReviewerTurnFailed(ctx: EngineCtx, event: TurnFailure): Promise<void> {
  const row = ctx.store.threadByThreadId(event.threadId);
  if (row === null || row.state !== "active" || row.role !== "reviewer") return;
  const project = ctx.store.project(row.project_id);
  if (project === null) return;
  if (event.errorInfo?.category === "rate-limit") {
    if (await retryRateLimited(ctx, row, project, event)) return;
  } else {
    const failure = await ctx.bb.latestSystemError(event.threadId).catch(() => null);
    if (failure?.code === "thread_provisioning_failed") {
      if (!ctx.store.claimThread(row.id, UNSTARTED)) return;
      if (row.thread_id !== null) await ctx.bb.archive(row.thread_id).catch((error) => ctx.bb.log("warn", `Could not archive ${row.thread_id}: ${errText(error)}`));
      await reviewerStartFailed(ctx, ctx.store.thread(row.id)!, provisioningFailure(failure));
      return;
    }
  }
  await onReviewerIdle(ctx, row, "failed");
}

/** The human archived or deleted a reviewer thread. Its review stays pending and the tick starts a replacement. */
export async function onReviewerGone(ctx: EngineCtx, seen: ThreadRow): Promise<void> {
  const row = ctx.store.thread(seen.id);
  if (row === null || row.state !== "active" || row.role !== "reviewer") return;
  await endThread(ctx, row, "gone", { commit: false, move: null });
}
