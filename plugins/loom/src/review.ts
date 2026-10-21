// Reviewers: separate agent threads that judge a ticket that passed its checks. The plugin counts a verdict only
// from the reviewer row it started for the ticket's current round, and one transaction stores the verdict and
// applies the round outcome, so a crash cannot leave a verdict without one. The tick replays what a crash cut short.
import { randomBytes } from "node:crypto";
import { delivers, workerOf } from "./checks";
import type { ProjectRow, ReviewRow, Store, ThreadRow, TicketRow } from "./db/store";
import { changesRequestedText, findingsList, reviewerBrief, reviewerNudgeText } from "./prompts";
import { LoomError } from "./projects";
import { idleAction } from "./scheduler";
import type { Spec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { applyMove, endLiveRows, endThread, freshBase, pauseProject, released, resolveEnvironment, resumeEnding, retryRateLimited, specOf, toWorking, type EndReason, type EngineCtx, type TurnFailure } from "./workers";

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

type Standing = "live" | "ending" | "dead";

function standingOf(store: Store, review: ReviewRow): Standing {
  const row = review.thread_row_id === null ? null : store.thread(review.thread_row_id);
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
  | { kind: "changes"; worker: ThreadRow; review: ReviewRow }
  | { kind: "requeued" }
  | { kind: "blocking"; worker: ThreadRow }
  | { kind: "blocked" }
  | { kind: "deferred" };

/**
 * Applies the outcome of a decided round, synchronously and idempotently: approvals reaching the requirement move the
 * ticket to approved; a changes-requested verdict sends it back to its worker (or the queue), or blocks it at max_rounds.
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
    const reason = `review requested changes in ${rounds} rounds`;
    // Claiming the worker here makes its ending, which carries the ticket's move to blocked, replayable by the tick.
    if (worker.standing === "active" && !store.claimThread(worker.row.id, "blocked")) return { kind: "deferred" };
    store.updateTicket(ticket.id, { blocked_reason: reason });
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
    if (worker.standing === "active") return { kind: "blocking", worker: store.thread(worker.row.id)! };
    applyMove(ctx, ticket, { to: "blocked", patch: { ...released, blocked_reason: reason } }, LOOM_ACTOR, { reason });
    return { kind: "blocked" };
  }
  if (worker.standing === "active") {
    toWorking(ctx, ticket, worker.row, { round: ticket.review_round });
    return { kind: "changes", worker: worker.row, review };
  }
  applyMove(ctx, ticket, { to: "queued", patch: released }, LOOM_ACTOR, { reason: "the worker is gone" });
  return { kind: "requeued" };
}

/** What follows a committed outcome: the message to the worker, the blocked worker's ending, and the reviewers the round no longer needs. */
async function afterOutcome(ctx: EngineCtx, ticketId: number, outcome: Outcome | null, exclude?: number): Promise<void> {
  const { store } = ctx;
  try {
    if (outcome?.kind === "changes" && outcome.worker.thread_id !== null) {
      const ticket = store.ticket(ticketId)!;
      if (delivers(ctx, ticket.project_id)) {
        const { review } = outcome;
        const text = changesRequestedText(ticket.key, review.round, review.summary ?? "", JSON.parse(review.findings_json) as Finding[]);
        await ctx.bb.send(outcome.worker.thread_id, text).catch((error) => ctx.bb.log("warn", `Could not message ${outcome.worker.thread_id}: ${errText(error)}`));
      }
    }
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

/** The tick's review step: end stale reviewers, settle decided rounds, block a ticket whose reviewers keep ending, and start the reviewers a round still needs. */
export async function spawnReviewers(ctx: EngineCtx, project: ProjectRow, spec: Spec): Promise<number> {
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
      await blockForReviewers(ctx, ticket);
      continue;
    }
    spawned += await startReviewers(ctx, project, spec, ticket, spec.review.approvals - round.approved - round.live);
  }
  return spawned;
}

async function blockForReviewers(ctx: EngineCtx, ticket: TicketRow): Promise<void> {
  const reason = "reviewers ended without a verdict";
  ctx.store.tx(() => {
    ctx.store.updateTicket(ticket.id, { blocked_reason: reason });
    ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
  });
  await endLiveRows(ctx, ctx.store.ticket(ticket.id)!, "blocked");
  ctx.kick();
}

type Diff = { stat: string; patch: string; truncated: boolean };

async function startReviewers(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, needed: number): Promise<number> {
  if (needed <= 0 || ticket.head_sha === null) return 0;
  const diff = await readDiff(ctx, project, spec, ticket);
  if (diff === null) return 0;
  let started = 0;
  for (let n = 0; n < needed; n++) {
    if (!(await startReviewer(ctx, project.id, ticket, diff))) break;
    started += 1;
  }
  return started;
}

// A project that cannot show the reviewers their diff pauses with the reason instead of retrying every tick.
async function readDiff(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<Diff | null> {
  try {
    const checkout = project.host_id === null ? null : await ctx.bb.projectCheckout(project.bb_project_id, project.host_id);
    if (project.host_id === null || checkout === null) throw new Error(`the bb project has no checkout on the machine ${project.host_id ?? "(unknown)"}`);
    return await ctx.host.call(project.host_id, "diff", { repo: checkout, base: freshBase(spec), head: ticket.head_sha!, maxBytes: PATCH_BYTES });
  } catch (error) {
    pauseProject(ctx, project.id, `Could not read the diff of ${ticket.key} for review: ${errText(error)}`);
    return null;
  }
}

async function startReviewer(ctx: EngineCtx, projectId: number, seen: TicketRow, diff: Diff): Promise<boolean> {
  const { store } = ctx;
  const token = randomBytes(12).toString("hex");
  const round = seen.review_round;

  // The final eligibility check and the reservation share one synchronous transaction, as for workers.
  const reserved = store.tx(() => {
    const project = store.project(projectId);
    const ticket = store.ticket(seen.id);
    if (project?.state !== "running" || ticket === null || ticket.state !== "review" || ticket.review_round !== round || ticket.head_sha !== seen.head_sha) return null;
    const spec = specOf(store, project);
    const current = tally(store, ticket, spec);
    const live = store.threads({ projectId, role: "reviewer", states: ["spawning", "active"] }).length;
    if (current.decided || current.approved + current.live >= spec.review.approvals || live >= spec.agents.max_reviewers) return null;
    const created = store.addThread({ project_id: projectId, ticket_id: ticket.id, role: "reviewer", state: "spawning", spawn_token: token });
    store.updateThread(created.id, { review_round: round, clock_at: ctx.now() });
    store.addReview({ ticket_id: ticket.id, round, thread_row_id: created.id });
    return { row: store.thread(created.id)!, project, spec, ticket };
  });
  if (reserved === null) return false;

  const { row, project, spec, ticket } = reserved;
  const agent = spec.agents.reviewer;
  const brief = reviewerBrief({ project, spec, ticket, round, diff, checkPost: store.posts(ticket.id).filter((post) => post.kind === "check").at(-1) ?? null, earlierReviews: store.reviews(ticket.id).filter((review) => review.round < round) });
  let spawned;
  try {
    spawned = await ctx.bb.spawnThread({
      bbProjectId: project.bb_project_id,
      hostId: project.host_id!,
      baseBranch: ticket.branch ?? freshBase(spec),
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
    failReviewerSpawn(ctx, row, errText(error));
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
  const state = await ctx.host.call(environment.hostId, "worktreeState", { worktree: environment.path, base: freshBase(spec) }).catch((error) => {
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

/** A failed turn: rate limits are retried at the window's reset, even while paused, since pausing never stops a reviewer; anything else counts like an idle. */
export async function onReviewerTurnFailed(ctx: EngineCtx, event: TurnFailure): Promise<void> {
  const row = ctx.store.threadByThreadId(event.threadId);
  if (row === null || row.state !== "active" || row.role !== "reviewer") return;
  const project = ctx.store.project(row.project_id);
  if (project === null) return;
  if (event.errorInfo?.category === "rate-limit" && (await retryRateLimited(ctx, row, project, event))) return;
  await onReviewerIdle(ctx, row, "failed");
}

/** The human archived or deleted a reviewer thread. Its review stays pending and the tick starts a replacement. */
export async function onReviewerGone(ctx: EngineCtx, seen: ThreadRow): Promise<void> {
  const row = ctx.store.thread(seen.id);
  if (row === null || row.state !== "active" || row.role !== "reviewer") return;
  await endThread(ctx, row, "gone", { commit: false, move: null });
}
