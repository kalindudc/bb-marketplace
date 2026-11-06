// The final review: with auto_merge.final_review, one short agent turn right before Loom asks to merge, once every other
// merge hold has cleared, on the exact commit it would merge. It judges only what changed since Loom's reviewers approved
// the ticket: did anything break the acceptance criteria, is the pull request's text still true, and is anything alarming.
//
// Where it runs: a bb thread in an empty scratch directory in the user's cache on the project's machine, with
// everything it judges inline in its brief; nothing to provision and nothing of the person's to damage. It never runs in
// the repo's checkout: should bb refuse the scratch directory, the merge holds. The threat is an accident, not an
// adversary: a reviewer that wanders into the checkout. So Loom takes a cheap fingerprint of the checkout before the
// thread starts and, once the thread has really stopped, again before it counts a pass: any change, or a fingerprint it
// cannot take, holds the merge for the human, and Loom never resets the checkout.
//
// Its whole state is ticket events, keyed by the head: a run is recorded, with its deadline, before its thread is spawned,
// so a restart neither runs a second review for a head nor merges without one. Runs are kept up separately from whether a
// merge may start (maintainRuns): a deadline, a new push, a pause, an `off`, a block or the pull request no longer being
// ready stops the run and archives its thread, whatever else happens.
import { randomBytes } from "node:crypto";
import type { EventRow, ProjectRow, Store, TicketRow } from "./db/store";
import { repoCheckout, type RepoCheckout } from "./checkouts";
import { hostCallTransient } from "./forge-waits";
import { REPLY_MARK } from "./host-contract";
import { clip, type FeedbackItem } from "./prompts";
import { appliedOf, blockOpenPr, mergeFixRound } from "./pull-requests";
import { autoMergeOf, repoSettings, type AutoMergeSettings } from "./repos";
import type { Spec } from "./spec";
import { SpawnRefusedError } from "./ports";
import { HUMAN_ACTOR, LOOM_ACTOR } from "./states";
import { specOf, type EngineCtx } from "./ctx";
import { mergePostNow } from "./posts";

export const FINAL_STARTED = "ticket.final_review_started";
export const FINAL_BOUND = "ticket.final_review_bound";
export const FINAL_VERDICT = "ticket.final_review_verdict";
export const FINAL_VERIFIED = "ticket.final_review_verified";
export const FINAL_ENDED = "ticket.final_review_ended";
export const FINAL_NUDGED = "ticket.final_review_nudged";
export const FINAL_ACTED = "ticket.final_review_acted";
export const FINAL_CLOSED = "ticket.final_review_closed";
export const FINAL_HELD = "ticket.final_review_held";
export const FINAL_RESET = "ticket.final_review_reset";
export const FINAL_ACCEPTED = "ticket.final_review_accepted";
export const FINAL_CLEANUP_FAILED = "ticket.final_review_cleanup_failed";
const KINDS = [FINAL_CLEANUP_FAILED, "ticket.state", "ticket.auto_merge", FINAL_STARTED, FINAL_BOUND, FINAL_VERDICT, FINAL_VERIFIED, FINAL_ENDED, FINAL_NUDGED, FINAL_ACTED, FINAL_CLOSED, FINAL_HELD, FINAL_RESET, FINAL_ACCEPTED];

/** Runs per head that may end without a verdict before Loom holds the merge and says so. */
export const FINAL_TRIES = 3;
/** How long after a run that ended without a verdict the next one may start: this times the runs that did so far. */
export const FINAL_RETRY_MS = 5 * 60_000;
export const FINAL_TIMEOUT_MINUTES = 10;
export const FINAL_REASONING = "low";
/** Ends that count toward FINAL_TRIES: the review itself did not finish. One Loom stopped (a hold, a pause, a push) does not count. */
const COUNTED = new Set(["timeout", "gone", "error", "idle", "start", "restart"]);
/** A run with no thread recorded this long after it was recorded lost its spawn to a restart. */
const SPAWN_GRACE_MS = 2 * 60_000;
/** A scratch directory whose removal failed is tried again this long after, doubling to CLEANUP_LONGEST_MS. */
const CLEANUP_RETRY_MS = 60_000;
const CLEANUP_LONGEST_MS = 30 * 60_000;
/** How often the tick sweeps the scratch directories no outstanding run owns. */
const SWEEP_MS = 30 * 60_000;
/** An idle thread this long after its nudge ended its turn twice without a verdict. */
const NUDGE_GRACE_MS = 30_000;
/** The brief's bounds: patches, the files shown by name, and its whole size. Past them it says what it left out, and is incomplete. */
const PATCH_BYTES = 30_000;
const PATCH_FILES = 12;
const NAMED_FILES = 30;
const PR_FILES_SHOWN = 50;
const LIST_FILES = 5000;
export const BRIEF_MAX = 40_000;
const BODY_CHARS = 6000;
const ITEMS_MAX = 10;

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const parse = (event: EventRow) => JSON.parse(event.data_json) as Record<string, unknown>;

/** The final review the spec sets for a repo's merges, with each unset key filled in; null when it sets none. */
export interface FinalReviewSettings {
  provider: string | undefined;
  model: string | undefined;
  reasoning: string;
  timeoutMs: number;
}

export function finalReviewOf(spec: Spec, settings: AutoMergeSettings | null): FinalReviewSettings | null {
  const own = settings?.finalReview;
  if (own == null) return null;
  const reviewer = spec.agents.reviewer;
  return { provider: own.provider ?? reviewer.provider, model: own.model ?? (own.provider === undefined ? reviewer.model : undefined), reasoning: own.reasoning ?? FINAL_REASONING, timeoutMs: (own.timeout_minutes ?? FINAL_TIMEOUT_MINUTES) * 60_000 };
}

export interface FinalRun {
  id: number;
  at: number;
  sha: string;
  url: string;
  token: string;
  /** When the run's thread must have answered; a verdict after it is refused. */
  deadline: number | null;
  /** The checkout whose fingerprint the run took before it started, and the fingerprint. */
  repo: string | null;
  print: string | null;
  /** The scratch directory key it started in. */
  scratch: string | null;
  /** What the brief left out; a pass of an incomplete brief needs the human's accept. */
  incomplete: string[];
  thread: string | null;
  verdict: { pass: boolean; reason: string; fixable: boolean; at: number } | null;
  /** A pass Loom counted: its thread stopped and the checkout was as it was. */
  verified: boolean;
  ended: { why: string; message: string | null; at: number } | null;
  nudgedAt: number | null;
  acted: boolean;
  closed: boolean;
  /** Failed removals of its scratch directory, and when the last one failed. */
  cleanup: { failures: number; at: number } | null;
}

export interface FinalState {
  runs: FinalRun[];
  /** The run of this head that has neither a verdict nor an end. */
  open: FinalRun | null;
  /** The newest run of this head whose verdict is a pass, counted or not. */
  passRun: FinalRun | null;
  /** A pass that authorizes the merge: verified, and for an incomplete brief also accepted by the human. */
  passed: FinalRun | null;
  /** The newest failed verdict for this head. */
  failed: FinalRun | null;
  /** Runs of this head that ended without a verdict, in a way that counts toward FINAL_TRIES, since the last reset. */
  unfinished: FinalRun[];
  /** Why Loom holds this head's final review, since the last reset: "tries", "checkout" or "partial". */
  held: string | null;
  accepted: boolean;
}

/**
 * The ticket's final reviews since its last reset (a requeue out of blocked, the human's `on` or `retry` for it), the head
 * `sha`'s among them. Older verdicts do not count: the human sending the ticket back is a new judgement.
 */
export function finalState(store: Store, ticketId: number, sha: string | null): FinalState & { all: FinalRun[] } {
  const all: FinalRun[] = [];
  const byId = new Map<number, FinalRun>();
  let since = 0;
  const heldFor = new Map<string, string>();
  const acceptedFor = new Set<string>();
  for (const event of store.ticketEvents(ticketId, KINDS)) {
    const data = parse(event);
    if (event.kind === "ticket.state") {
      if (data.from === "blocked" && (data.to === "queued" || data.requeued === true || data.to === "pr_open")) since = event.id;
      continue;
    }
    if ((event.kind === "ticket.auto_merge" && data.on === true) || event.kind === FINAL_RESET) {
      since = event.id;
      heldFor.clear();
      acceptedFor.clear();
      continue;
    }
    if (event.kind === FINAL_STARTED) {
      const run: FinalRun = {
        id: event.id,
        at: event.at,
        sha: String(data.sha),
        url: String(data.url),
        token: String(data.token),
        deadline: typeof data.deadline === "number" ? data.deadline : null,
        repo: typeof data.repo === "string" ? data.repo : null,
        print: typeof data.print === "string" ? data.print : null,
        scratch: typeof data.scratch === "string" ? data.scratch : null,
        incomplete: Array.isArray(data.incomplete) ? (data.incomplete as unknown[]).map(String) : [],
        thread: null,
        verdict: null,
        verified: false,
        ended: null,
        nudgedAt: null,
        acted: false,
        closed: false,
        cleanup: null,
      };
      all.push(run);
      byId.set(run.id, run);
      continue;
    }
    if (event.kind === FINAL_HELD) {
      if (event.id > since) heldFor.set(String(data.sha), String(data.reason ?? "tries"));
      continue;
    }
    if (event.kind === FINAL_ACCEPTED) {
      if (event.id > since) acceptedFor.add(String(data.sha));
      continue;
    }
    const run = byId.get(Number(data.run));
    if (run === undefined) continue;
    if (event.kind === FINAL_BOUND) run.thread = String(data.thread);
    else if (event.kind === FINAL_VERDICT && run.verdict === null && run.ended === null) run.verdict = { pass: data.pass === true, reason: String(data.reason ?? ""), fixable: data.fixable === true, at: event.at };
    else if (event.kind === FINAL_VERIFIED) run.verified = true;
    else if (event.kind === FINAL_ENDED && run.verdict === null && run.ended === null) run.ended = { why: String(data.why), message: typeof data.message === "string" ? data.message : null, at: event.at };
    else if (event.kind === FINAL_NUDGED) run.nudgedAt = event.at;
    else if (event.kind === FINAL_ACTED) run.acted = true;
    else if (event.kind === FINAL_CLOSED) run.closed = true;
    else if (event.kind === FINAL_CLEANUP_FAILED) run.cleanup = { failures: (run.cleanup?.failures ?? 0) + 1, at: event.at };
  }
  const runs = all.filter((run) => run.id > since && run.sha === sha);
  const accepted = sha !== null && acceptedFor.has(sha);
  const passRun = [...runs].reverse().find((run) => run.verdict?.pass === true) ?? null;
  return {
    all,
    runs,
    open: runs.find((run) => run.verdict === null && run.ended === null) ?? null,
    passRun,
    passed: passRun !== null && passRun.verified && (passRun.incomplete.length === 0 || accepted) ? passRun : null,
    failed: [...runs].reverse().find((run) => run.verdict !== null && !run.verdict.pass) ?? null,
    unfinished: runs.filter((run) => run.ended !== null && COUNTED.has(run.ended.why)),
    held: sha === null ? null : (heldFor.get(sha) ?? null),
    accepted,
  };
}

/** The deadline of a run: recorded with it, or for a run from before Loom recorded one, its start and the spec's time limit. */
const deadlineOf = (run: FinalRun, timeoutMs: number) => run.deadline ?? run.at + timeoutMs;

/** Whether the ticket's pull request may merge as far as the final review goes: it needs none, or one passed for the head Loom pushed. */
export function finalReviewPassed(store: Store, spec: Spec, ticket: TicketRow): boolean {
  if (finalReviewOf(spec, autoMergeOf(repoSettings(spec, ticket.repo).forge)) === null) return true;
  return finalState(store, ticket.id, ticket.pushed_sha).passed !== null;
}

/** What the Merge order tab says of a ticket's final review; null when its repo sets none or it has no pushed commit. */
export type FinalBadge = { state: "waiting" | "running" | "passed" | "failed" | "held"; reason: string | null };
export function finalBadge(store: Store, spec: Spec, ticket: TicketRow): FinalBadge | null {
  if (ticket.pushed_sha === null || ticket.state === "done" || ticket.state === "cancelled") return null;
  if (finalReviewOf(spec, autoMergeOf(repoSettings(spec, ticket.repo).forge)) === null) return null;
  const state = finalState(store, ticket.id, ticket.pushed_sha);
  if (state.passed !== null) return { state: "passed", reason: null };
  if (state.failed !== null) return { state: "failed", reason: state.failed.verdict!.reason };
  if (state.held === "checkout") return { state: "held", reason: "the repo's checkout changed while it ran, or Loom could not fingerprint it" };
  if (state.held === "scratch") return { state: "held", reason: "Loom had no scratch directory outside bb's data directory, or bb would not start it in one" };
  if (state.held === "partial") return { state: "held", reason: "it passed on an incomplete brief; the human accepts it" };
  if (state.held !== null) return { state: "held", reason: state.unfinished.at(-1)?.ended?.message ?? state.unfinished.at(-1)?.ended?.why ?? null };
  if (state.open !== null || state.passRun !== null) return { state: "running", reason: null };
  return { state: "waiting", reason: null };
}

/** Makes the ticket's pull request due for its next read now, and wakes the loop: a final review's verdict or end acts at once. */
function readSoon(ctx: EngineCtx, ticketId: number): void {
  const ticket = ctx.store.ticket(ticketId);
  if (ticket === null) return;
  ctx.store.updateTicket(ticket.id, { pr_checked_at: null });
  ctx.store.changed(ticket.project_id);
  ctx.kick();
}

/** The runs whose spawn this process is waiting on: a run with no thread outside it lost its spawn to a restart. */
const spawning = new WeakMap<Store, Set<number>>();
const spawningOf = (store: Store) => spawning.get(store) ?? spawning.set(store, new Set()).get(store)!;

/**
 * The runs not closed yet, by run id, with their ticket and scratch key: what the tick's upkeep and sweep work on, so they
 * never read finished history. Read once per process from the started and closed events, then kept as Loom records them.
 */
type Outstanding = Map<number, { ticketId: number; projectId: number; scratch: string | null }>;
const outstandingRuns = new WeakMap<Store, Outstanding>();
function outstandingOf(store: Store): Outstanding {
  const known = outstandingRuns.get(store);
  if (known !== undefined) return known;
  const runs: Outstanding = new Map();
  for (const event of store.eventsByKinds([FINAL_STARTED, FINAL_CLOSED])) {
    const data = parse(event);
    if (event.kind === FINAL_STARTED && event.ticket_id !== null) runs.set(event.id, { ticketId: event.ticket_id, projectId: event.project_id, scratch: typeof data.scratch === "string" ? data.scratch : null });
    else runs.delete(Number(data.run));
  }
  outstandingRuns.set(store, runs);
  return runs;
}

/** Records a run's start, before anything it needs exists, and counts it outstanding. */
function recordStarted(ctx: EngineCtx, ticket: TicketRow, data: Record<string, unknown>): FinalRun {
  const runs = outstandingOf(ctx.store);
  ctx.store.event(ticket.project_id, ticket.id, FINAL_STARTED, LOOM_ACTOR, data);
  const run = finalState(ctx.store, ticket.id, String(data.sha)).all.at(-1)!;
  runs.set(run.id, { ticketId: ticket.id, projectId: ticket.project_id, scratch: run.scratch });
  return run;
}

/** The tickets with a run not closed yet. */
export function ticketsWithOutstandingRuns(store: Store): Array<{ ticketId: number; projectId: number }> {
  const seen = new Map<number, number>();
  for (const run of outstandingOf(store).values()) seen.set(run.ticketId, run.projectId);
  return [...seen].map(([ticketId, projectId]) => ({ ticketId, projectId }));
}

/** Whether the ticket has a run not closed yet. */
export function needsUpkeep(store: Store, ticketId: number): boolean {
  for (const run of outstandingOf(store).values()) if (run.ticketId === ticketId) return true;
  return false;
}

const swept = new WeakMap<Store, number>();

/**
 * Removes, every SWEEP_MS, the scratch directories on each machine that no outstanding run owns: a run's directory
 * is recorded before it is made, so these are left by a crash between a removal and its record, or by an older Loom.
 */
export async function sweepScratch(ctx: EngineCtx, hostsOf: () => readonly string[]): Promise<void> {
  // The first sweep comes SWEEP_MS after the process starts, so a tick never lists the projects only to find nothing due.
  const last = swept.get(ctx.store);
  if (last === undefined) return void swept.set(ctx.store, ctx.now());
  if (ctx.now() - last < SWEEP_MS) return;
  swept.set(ctx.store, ctx.now());
  const hosts = hostsOf();
  const keep = [...outstandingOf(ctx.store).values()].flatMap((run) => (run.scratch === null ? [] : [run.scratch]));
  for (const host of new Set(hosts)) {
    const answer = await ctx.host.call(host, "finalScratch", { key: "loom-sweep", action: "sweep", keep }).catch((error: unknown) => {
      ctx.bb.log("warn", `Could not sweep the final reviews' scratch directories on ${host}: ${errText(error)}`);
      return null;
    });
    if (answer !== null && answer.entries.length > 0) ctx.bb.log("info", `Removed ${answer.entries.length} final review scratch directories no run owns on ${host}.`);
  }
}

/** What the merge read gives the final review: the pull request's head, author, title, description and items. */
export interface FinalRead {
  head?: string | null;
  author?: string | null;
  text?: { title: string | null; body: string | null } | null;
  items: ReadonlyArray<{ key: string; createdAt?: number | null; kind: string; author: string; bot?: boolean; body: string; url: string | null; state?: string | null }> | null;
}

function endRun(ctx: EngineCtx, ticket: TicketRow, run: FinalRun, why: string, message: string | null): void {
  ctx.store.event(ticket.project_id, ticket.id, FINAL_ENDED, LOOM_ACTOR, { run: run.id, sha: run.sha, why, ...(message === null ? {} : { message: clip(message, 1000) }) });
  if (why === "superseded" || why === "refused") return;
  if (!COUNTED.has(why)) {
    mergePostNow(ctx.store, ticket, `Loom stopped its final review of ${run.url} on ${run.sha.slice(0, 12)}: ${message ?? why}. It starts a new one once the pull request is ready to merge again.`, { outcome: "final_review_stopped", url: run.url, sha: run.sha, why });
    return;
  }
  const left = FINAL_TRIES - finalState(ctx.store, ticket.id, run.sha).unfinished.length;
  mergePostNow(ctx.store, ticket, `Loom's final review of ${run.url} on ${run.sha.slice(0, 12)} ended without a verdict: ${message ?? why}. It does not merge without one${left > 0 ? `, and tries again in ${Math.round((FINAL_RETRY_MS * (FINAL_TRIES - left)) / 60_000)} minutes` : ""}.`, { outcome: "final_review_unfinished", url: run.url, sha: run.sha, why });
}

/**
 * Whether a run's thread has really stopped: archived, deleted, idle or failed. A thread still running is asked to stop,
 * and read again; one that is only "stopping" has not stopped yet, so the caller waits for a later read. A thread Loom
 * cannot read is not known to be stopped.
 */
async function stopped(ctx: EngineCtx, threadId: string): Promise<boolean> {
  try {
    const done = (thread: Awaited<ReturnType<EngineCtx["bb"]["getThread"]>>) => thread === null || thread.archivedAt !== null || thread.deletedAt !== null || thread.status === "idle" || thread.status === "error";
    if (done(await ctx.bb.getThread(threadId))) return true;
    await ctx.bb.stop(threadId);
    return done(await ctx.bb.getThread(threadId));
  } catch (error) {
    ctx.bb.log("warn", `Could not stop the final reviewer ${threadId}: ${errText(error)}`);
    return false;
  }
}

/**
 * Stops and archives the thread of each run that is over, a passed one included, once its stop is confirmed, and removes
 * its scratch directory; only then is the run recorded closed, with the tokens it used. A pass needs no live thread to be
 * counted: verifyPass needs it stopped, and an archived thread is. A removal that fails is tried again later, with backoff.
 */
async function closeRuns(ctx: EngineCtx, ticket: TicketRow, runs: readonly FinalRun[]): Promise<void> {
  for (const run of runs) {
    if (run.closed || (run.verdict === null && run.ended === null) || spawningOf(ctx.store).has(run.id)) continue;
    if (run.cleanup !== null && ctx.now() < run.cleanup.at + Math.min(CLEANUP_LONGEST_MS, CLEANUP_RETRY_MS * 2 ** (run.cleanup.failures - 1))) continue;
    let tokens: number | null = null;
    if (run.thread !== null) {
      if (!(await stopped(ctx, run.thread))) continue;
      try {
        const thread = await ctx.bb.getThread(run.thread);
        if (thread !== null && thread.archivedAt === null && thread.deletedAt === null) await ctx.bb.archive(run.thread);
        tokens = await ctx.bb.threadTokens(run.thread).catch(() => null);
      } catch (error) {
        ctx.bb.log("warn", `Could not archive the final reviewer ${run.thread}: ${errText(error)}`);
        continue;
      }
    }
    const removed = await removeScratch(ctx, ticket, run);
    // Read again after the awaits: another pass may have closed it meanwhile.
    if (finalState(ctx.store, ticket.id, null).all.find((each) => each.id === run.id)?.closed !== false) continue;
    if (!removed) {
      ctx.store.event(ticket.project_id, ticket.id, FINAL_CLEANUP_FAILED, LOOM_ACTOR, { run: run.id });
      continue;
    }
    ctx.store.event(ticket.project_id, ticket.id, FINAL_CLOSED, LOOM_ACTOR, { run: run.id, tokens });
    outstandingOf(ctx.store).delete(run.id);
  }
}

/** Whether the run's scratch directory is gone: it had none, or the machine confirmed its removal. */
async function removeScratch(ctx: EngineCtx, ticket: TicketRow, run: FinalRun): Promise<boolean> {
  if (run.scratch === null) return true;
  const host = ctx.store.project(ticket.project_id)?.host_id ?? null;
  if (host === null) return false;
  try {
    await ctx.host.call(host, "finalScratch", { key: run.scratch, action: "remove" });
    return true;
  } catch (error) {
    ctx.bb.log("warn", `Could not remove the final review's scratch directory ${run.scratch}: ${errText(error)}`);
    return false;
  }
}

/**
 * Keeps up the ticket's final reviews whatever else happens, before anything decides whether a review or a merge may
 * start. An open run ends at its deadline (a timeout, which counts), on a new push or another pull request (superseded),
 * and when `stop` says why it may not go on: the project is paused, auto-merge is off, the ticket is blocked or cancelled,
 * or the pull request is not ready to merge any more. Then every run that is over has its thread stopped and archived.
 */
export async function maintainRuns(ctx: EngineCtx, ticketId: number, stop: string | null, timeoutMs: number | null): Promise<void> {
  const { store } = ctx;
  const ticket = store.ticket(ticketId);
  if (ticket === null) return;
  const now = ctx.now();
  for (const run of finalState(store, ticket.id, null).all) {
    if (run.verdict !== null || run.ended !== null) continue;
    if (ticket.pr_url !== run.url || ticket.pushed_sha !== run.sha || ticket.state === "done") endRun(ctx, ticket, run, "superseded", "a newer push replaced the head it reviews");
    else if (timeoutMs !== null && now >= deadlineOf(run, timeoutMs)) endRun(ctx, ticket, run, "timeout", `it did not answer within ${Math.round(timeoutMs / 60_000)} minutes`);
    else if (stop !== null) endRun(ctx, ticket, run, "interrupted", stop);
  }
  await closeRuns(ctx, ticket, finalState(store, ticket.id, null).all);
}

/**
 * The tick's step for a ticket whose pull request is ready to merge but has no counted final review for its head: acts on
 * a failed verdict, counts a pass once its thread stopped and the checkout is unchanged, follows the run in flight, or
 * starts one. True when it just counted a pass, so the caller asks to merge in the same pass, with nothing in between.
 * `still` judges the ticket again from the store, as auto-merge's readiness does, so a pause, an `off` or a push while Loom
 * read the delta starts nothing.
 */
export async function followFinalReview(ctx: EngineCtx, project: ProjectRow, ticket: TicketRow, settings: AutoMergeSettings, read: FinalRead, still: () => TicketRow | null): Promise<boolean> {
  const { store } = ctx;
  const spec = specOf(store, project);
  const final = finalReviewOf(spec, settings)!;
  const sha = ticket.pushed_sha!;
  const state = finalState(store, ticket.id, sha);
  if (state.failed !== null && !state.failed.acted) {
    await actOnFailure(ctx, ticket, state.failed);
    return false;
  }
  if (state.failed !== null || state.held !== null) return false;
  if (state.passRun !== null) return verifyPass(ctx, project, ticket, state.passRun, state.accepted);
  if (state.open !== null) {
    await followRun(ctx, ticket, state.open);
    return false;
  }
  const last = state.unfinished.at(-1);
  if (state.unfinished.length >= FINAL_TRIES) {
    hold(ctx, project, ticket, sha, "tries", `Loom's final review of ${ticket.pr_url} did not finish ${FINAL_TRIES} times for ${sha.slice(0, 12)} (last: ${last?.ended?.message ?? last?.ended?.why ?? "no reason"}), so Loom holds the merge. It never merges without a passed final review.`);
    return false;
  }
  if (last !== undefined && ctx.now() < last.ended!.at + FINAL_RETRY_MS * state.unfinished.length) return false;
  await startRun(ctx, project, spec, ticket, final, read, still);
  return false;
}

/** Holds the final review of `sha`, which the caller has checked is still the ticket's head. */
function hold(ctx: EngineCtx, project: ProjectRow, ticket: TicketRow, sha: string, reason: "tries" | "checkout" | "partial" | "scratch", body: string, more: object = {}): void {
  ctx.store.event(ticket.project_id, ticket.id, FINAL_HELD, LOOM_ACTOR, { sha, reason });
  const next =
    reason === "partial"
      ? `\`bb loom auto-merge ${project.slug} accept --ticket ${ticket.key}\` lets it merge on this review, and \`retry\` runs a new one.`
      : `\`bb loom auto-merge ${project.slug} retry --ticket ${ticket.key}\` lets it try again.`;
  mergePostNow(ctx.store, ticket, `${body} ${next}`, { outcome: "final_review_held", url: ticket.pr_url, sha, reason, ...more });
}

/**
 * A pass counts only once its thread has really stopped and the checkout's fingerprint is what it was before the run. A
 * change, or a fingerprint Loom cannot take, holds the merge for the human, who may have edited the checkout themselves;
 * Loom never resets it. A pass of an incomplete brief then waits for the human's accept. After each await the run must
 * still be the current pass of the ticket's head: a run a push superseded meanwhile records nothing, so it can never hold
 * the head that replaced it.
 */
async function verifyPass(ctx: EngineCtx, project: ProjectRow, ticket: TicketRow, run: FinalRun, accepted: boolean): Promise<boolean> {
  const { store } = ctx;
  const current = (): TicketRow | null => {
    const now = store.ticket(ticket.id);
    if (now?.state !== "pr_open" || now.pushed_sha !== run.sha || now.pr_url !== run.url) return null;
    const state = finalState(store, now.id, run.sha);
    return state.passRun?.id === run.id && state.held === null ? now : null;
  };
  if (!run.verified) {
    if (run.thread !== null && !(await stopped(ctx, run.thread))) return false;
    if (current() === null) return false;
    const changed = await checkoutChanged(ctx, project, run);
    const now = current();
    if (now === null) return false;
    if (changed !== null) {
      hold(ctx, project, now, run.sha, "checkout", `Loom's final review passed ${run.sha.slice(0, 12)}, but ${changed}, so Loom does not merge. It changed nothing in the checkout: check it, since the reviewer may have, or you may have edited it meanwhile.`, { checkout: run.repo });
      await closeRuns(ctx, now, finalState(store, now.id, null).all);
      return false;
    }
    store.event(now.project_id, now.id, FINAL_VERIFIED, LOOM_ACTOR, { run: run.id, sha: run.sha });
    await closeRuns(ctx, now, finalState(store, now.id, null).all);
  }
  if (run.incomplete.length > 0 && !accepted) {
    const now = current();
    if (now === null) return false;
    hold(ctx, project, now, run.sha, "partial", `Loom's final review passed ${run.sha.slice(0, 12)}, but its brief was incomplete (${run.incomplete.join("; ")}), so it is not a full sanity check, and Loom does not merge on it by itself.`);
    return false;
  }
  return current() !== null;
}

/** Why the run's checkout is not as it was before the run started, in words; null when it is the same. */
async function checkoutChanged(ctx: EngineCtx, project: ProjectRow, run: FinalRun): Promise<string | null> {
  if (run.repo === null || run.print === null) return "Loom has no fingerprint of the repo's checkout from before the review";
  if (project.host_id === null) return "the project has no machine to read its checkout on";
  try {
    const now = await ctx.host.call(project.host_id, "checkoutPrint", { repo: run.repo });
    if (now.outcome !== "ok") return `Loom could not read the checkout ${run.repo} again: ${now.message}`;
    return now.print === run.print ? null : `the checkout ${run.repo} changed while it ran (its HEAD, index, status or changed files differ)`;
  } catch (error) {
    return `Loom could not read the checkout ${run.repo} again: ${errText(error)}`;
  }
}

/** A failed verdict: a fix round with the reviewer's reason when the worker can fix it, else a block. */
async function actOnFailure(ctx: EngineCtx, ticket: TicketRow, run: FinalRun): Promise<void> {
  const { reason, fixable } = run.verdict!;
  const url = ticket.pr_url!;
  if (fixable) {
    const item: FeedbackItem = {
      key: `final-review:${run.id}`,
      kind: "comment",
      author: "Loom's final review",
      bot: true,
      body: `Loom's final review before the merge found a problem in what changed since the reviewers approved this ticket:\n\n${reason}\n\nFix it on your branch and submit. Loom reviews the new head again before it merges.`,
      url,
      state: null,
      path: null,
      line: null,
    };
    if (await mergeFixRound(ctx, ticket, item)) ctx.store.event(ticket.project_id, ticket.id, FINAL_ACTED, LOOM_ACTOR, { run: run.id, how: "fix_round" });
    return;
  }
  const blocked = await blockOpenPr(ctx, ticket, `Loom's final review before the merge failed: ${clip(reason, 500)}`, { body: `Loom's final review of ${url} on ${run.sha.slice(0, 12)} failed, and the worker cannot fix what it found:\n\n${reason}`, data: { outcome: "final_review_blocked", url, sha: run.sha } });
  if (blocked) ctx.store.event(ticket.project_id, ticket.id, FINAL_ACTED, LOOM_ACTOR, { run: run.id, how: "block" });
}

/** A run in flight: bound to its thread after a restart, gone, failed, or idle without a verdict (a nudge, then an end). Its deadline is maintainRuns'. */
async function followRun(ctx: EngineCtx, ticket: TicketRow, run: FinalRun): Promise<void> {
  const { store } = ctx;
  const now = ctx.now();
  if (run.thread === null) {
    if (spawningOf(store).has(run.id)) return;
    const found = await ctx.bb.findSpawnedThread(run.token).catch(() => null);
    if (found !== null) {
      store.event(ticket.project_id, ticket.id, FINAL_BOUND, LOOM_ACTOR, { run: run.id, thread: found });
      return;
    }
    if (now - run.at >= SPAWN_GRACE_MS) endRun(ctx, ticket, run, "restart", "Loom restarted before the reviewer started");
    return;
  }
  const thread = await ctx.bb.getThread(run.thread).catch(() => undefined);
  if (thread === undefined) return;
  if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) return endRun(ctx, ticket, run, "gone", "its thread was archived or deleted");
  if (thread.status === "error") {
    const failure = await ctx.bb.latestSystemError(run.thread).catch(() => null);
    endRun(ctx, ticket, run, "error", failure?.message ?? "its thread failed");
    return closeRuns(ctx, ticket, finalState(store, ticket.id, null).all);
  }
  if (thread.status !== "idle" || now - run.at < NUDGE_GRACE_MS) return;
  if (run.nudgedAt === null) {
    store.event(ticket.project_id, ticket.id, FINAL_NUDGED, LOOM_ACTOR, { run: run.id });
    await ctx.bb.send(run.thread, `You ended your turn without a verdict. Call loom_final_review now: pass, or fail with a reason and whether the worker can fix it. Then end your turn.`).catch((error) => ctx.bb.log("warn", `Could not nudge ${run.thread}: ${errText(error)}`));
    return;
  }
  if (now - run.nudgedAt >= NUDGE_GRACE_MS) {
    endRun(ctx, ticket, run, "idle", "the reviewer ended its turn twice without a verdict");
    await closeRuns(ctx, ticket, finalState(store, ticket.id, null).all);
  }
}

// ---------------------------------------------------------------- the brief

interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface Delta {
  /** The commit Loom's reviewers approved; null when Loom has no record of it. */
  approved: string | null;
  same: boolean;
  /** Whether Loom established which changes since the approval came only from the base: every listing it needed answered in full. */
  certain: boolean;
  /** Files the pull request changes now, with their line counts. */
  prFiles: ChangedFile[];
  /** The pull request's own files, at the approval or now, that changed since the approval; all of them when not certain. */
  own: string[];
  /** Their patches from the approved commit to the head, the first ones in the budget; `truncated` when the patch was cut. */
  patches: Array<{ path: string; patch: string; truncated: boolean }>;
  /** Files that changed since the approval only because the base was merged in; null when not certain. */
  baseOnly: number | null;
  problem: string | null;
}

/** The commit Loom's reviewers approved: the head its last move from approved to merging carried. */
export function approvedHead(store: Store, ticketId: number): { sha: string | null; at: number | null } {
  let sha: string | null = null;
  let at: number | null = null;
  for (const event of store.ticketEvents(ticketId, ["ticket.state"])) {
    const data = parse(event);
    if (data.to === "approved") at = event.at;
    if (data.from === "approved" && data.to === "merging" && typeof data.head === "string") sha = data.head;
  }
  return { sha, at };
}

type Transient = { transient: true; message: string };
const isTransient = (value: unknown): value is Transient => typeof value === "object" && value !== null && (value as Transient).transient === true;

/**
 * What changed between the approved commit and the head, scoped to the pull request's own files. Own files are those the
 * pull request changed at the approval (against its merge base then) or changes now (against its merge base now), so a
 * conflict resolution that drops an approved change, which takes the file out of today's diff, stays in. A listing that
 * fails or is cut short makes Loom uncertain, and then every file that changed since the approval counts as its own.
 */
async function readDelta(ctx: EngineCtx, checkout: RepoCheckout, ticket: TicketRow, approved: string | null): Promise<Delta | Transient> {
  const { hostId, path: repo, settings } = checkout;
  const head = ticket.pushed_sha!;
  const base = `${settings.remote}/${ticket.pr_base ?? settings.base}`;
  const delta: Delta = { approved, same: false, certain: false, prFiles: [], own: [], patches: [], baseOnly: null, problem: null };
  const call = async <T>(fn: () => Promise<T>): Promise<T | Transient | { problem: string }> => {
    try {
      return await fn();
    } catch (error) {
      return hostCallTransient(error) !== null ? { transient: true, message: errText(error) } : { problem: errText(error) };
    }
  };
  type Listing = { files: ChangedFile[]; complete: boolean } | null;
  const list = async (from: string, to: string, mergeBase: boolean): Promise<Listing | Transient> => {
    const answer = await call(() => ctx.host.call(hostId, "changedFiles", { repo, base: from, head: to, mergeBase, maxFiles: LIST_FILES }));
    if (isTransient(answer)) return answer;
    if ("problem" in answer || answer.outcome !== "ok") return null;
    return { files: answer.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })), complete: !answer.truncated };
  };
  const now = await list(base, head, true);
  if (isTransient(now)) return now;
  delta.prFiles = now?.files ?? [];
  if (now === null) delta.problem = "Loom could not list the pull request's files";
  if (approved === null) return { ...delta, problem: "Loom has no record of the commit its reviewers approved, so judge the pull request's files and text" };
  if (approved === head) return { ...delta, same: true, certain: true };
  const tips = await Promise.all([approved, head].map((sha) => call(() => ctx.host.call(hostId, "refTip", { repo, ref: sha }))));
  const transient = tips.find(isTransient);
  if (transient !== undefined) return transient;
  const trees = tips.map((tip) => (typeof tip === "object" && tip !== null && "outcome" in tip && tip.outcome === "ok" ? tip.tree : null));
  if (trees[0] !== null && trees[0] === trees[1]) return { ...delta, same: true, certain: true };
  const then = await list(base, approved, true);
  if (isTransient(then)) return then;
  const since = await list(approved, head, false);
  if (isTransient(since)) return since;
  if (since === null) return { ...delta, problem: `Loom could not compare the approved commit ${approved.slice(0, 12)} with the head` };
  delta.certain = now !== null && now.complete && then !== null && then.complete && since.complete;
  const owned = new Set([...(now?.files ?? []), ...(then?.files ?? [])].map((file) => file.path));
  const touched = delta.certain ? since.files.filter((file) => owned.has(file.path)) : since.files;
  delta.own = touched.map((file) => file.path);
  delta.baseOnly = delta.certain ? since.files.length - touched.length : null;
  let budget = PATCH_BYTES;
  for (const file of touched.slice(0, PATCH_FILES)) {
    if (budget < 1000) break;
    const patch = await call(() => ctx.host.call(hostId, "filePatch", { repo, base: approved, head, path: file.path, maxBytes: Math.max(1000, Math.min(budget, 12_000)) }));
    if (isTransient(patch)) return patch;
    if (typeof patch !== "object" || patch === null || !("outcome" in patch) || patch.outcome !== "ok") break;
    budget -= patch.patch.length;
    delta.patches.push({ path: file.path, patch: patch.patch, truncated: patch.truncated });
  }
  return delta;
}

const fence = (text: string) => `\`\`\`\n${text.replace(/```/g, "ˋˋˋ")}\n\`\`\``;
const count = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/**
 * The final reviewer's brief, at most BRIEF_MAX characters, and what it left out. A brief that leaves out anything the
 * reviewer would need to judge the change since the approval is incomplete: it says so at its top, and its pass is not a
 * full sanity check (verifyPass holds it for the human).
 */
export function finalBrief(a: { ticket: TicketRow; approvedAt: number | null; delta: Delta; text: FinalRead["text"]; approvedText: { title: string; body: string | null } | null; items: NonNullable<FinalRead["items"]> }): { text: string; incomplete: string[] } {
  const { ticket, delta } = a;
  const incomplete: string[] = [];
  if (delta.problem !== null) incomplete.push(delta.problem);
  if (!delta.same && !delta.certain && delta.problem === null) incomplete.push("Loom could not establish which changes since the approval came only from the base, so every changed file counts as the pull request's own");
  const shown = new Set(delta.patches.map((file) => file.path));
  const unshown = delta.own.filter((path) => !shown.has(path));
  if (unshown.length > 0) incomplete.push(`${count(unshown.length, "changed file")} of the pull request's own ${unshown.length === 1 ? "is" : "are"} not shown in full`);
  const cut = delta.patches.filter((file) => file.truncated).length;
  if (cut > 0) incomplete.push(`${count(cut, "patch")} ${cut === 1 ? "is" : "are"} cut short`);

  const acceptance = (JSON.parse(ticket.acceptance_json) as string[]).map((line, index) => `${index + 1}. ${line}`);
  const nothing = delta.same && a.items.length === 0;
  const head = (notice: string[]) => [
    `You are Loom's final review of ${ticket.key} (${ticket.title}), right before Loom merges its pull request ${ticket.pr_url} at ${ticket.pushed_sha}.`,
    "",
    ...(notice.length === 0 ? [] : [`THIS BRIEF IS INCOMPLETE: ${notice.join("; ")}. Judge what it shows; Loom does not merge on a pass of an incomplete brief without a person.`, ""]),
    "Loom's reviewers already approved this change. Do not review it again. Judge only three things:",
    "1. Did anything that changed since that approval break an acceptance criterion below?",
    "2. Are the pull request's title and description still true of what it changes?",
    "3. Is anything alarming in what changed since the approval, such as a conflict resolved the wrong way, an approved change dropped, a secret, or unrelated changes?",
    "",
    "Everything you need is in this message. Do not run commands, open files or change anything: you start in an empty scratch directory, and Loom checks the repo's checkout is untouched before it merges.",
    nothing ? "Nothing in the code changed since the approval, and no one commented: check the text only, and answer in one short call." : "Keep it short: a few sentences of reasoning, then the call.",
    "",
    "Call loom_final_review once: verdict pass, or fail with a reason and fixable (true when the ticket's worker can fix it on the branch, false when it needs a person). Then end your turn.",
  ];
  const body = ["", "## Acceptance criteria", ...acceptance, "", "## What changed since the approval"];
  if (delta.same) body.push(`Nothing: the head has the exact tree Loom's reviewers approved${delta.approved === null ? "" : ` (${delta.approved.slice(0, 12)})`}.`);
  else if (delta.approved !== null && delta.problem === null) {
    const scope = delta.certain ? "in the pull request's own files (those it changed at the approval or changes now)" : "in every file that changed, since Loom could not tell which came from the base";
    body.push(`From the approved commit ${delta.approved.slice(0, 12)} to the head, ${scope}: ${count(delta.own.length, "file")}.`);
    if (delta.certain && delta.baseOnly! > 0) body.push(`${count(delta.baseOnly!, "other file")} changed only because the base was merged in: neither the approved change nor the pull request now touches ${delta.baseOnly === 1 ? "it" : "them"}.`);
    if (delta.own.length === 0 && delta.certain) body.push("None of the pull request's own files changed since the approval.");
    for (const file of delta.patches) body.push("", `### ${file.path}${file.truncated ? " (cut short)" : ""}`, fence(file.patch));
    if (unshown.length > 0) {
      body.push("", `Not shown in full (${count(unshown.length, "file")}):`, ...unshown.slice(0, NAMED_FILES).map((path) => `- ${path}`));
      if (unshown.length > NAMED_FILES) body.push(`- and ${count(unshown.length - NAMED_FILES, "more file")}`);
    }
  } else if (delta.problem !== null) body.push(`${delta.problem}.`);
  body.push("", "## The pull request's text");
  const title = a.text?.title ?? null;
  const description = a.text?.body ?? null;
  const unchanged = a.approvedText !== null && title === a.approvedText.title && (a.approvedText.body === null || (description ?? "").includes(a.approvedText.body));
  if (title === null && description === null) body.push("The forge did not give the title and description in this read.");
  else {
    if (unchanged) body.push("Unchanged since the reviewers approved it.");
    body.push(`Title: ${title ?? "(not given)"}`, "", "Description:", fence(clip(description ?? "(not given)", BODY_CHARS)));
  }
  body.push("", `## The files the pull request changes (${count(delta.prFiles.length, "file")})`);
  body.push(...(delta.prFiles.length === 0 ? ["(not read)"] : delta.prFiles.slice(0, PR_FILES_SHOWN).map((file) => `- ${file.path} (+${file.additions} -${file.deletions})`)));
  if (delta.prFiles.length > PR_FILES_SHOWN) body.push(`- and ${count(delta.prFiles.length - PR_FILES_SHOWN, "more file")}`);
  body.push("", "## People's comments and reviews since the approval");
  body.push(...(a.items.length === 0 ? ["None."] : a.items.map((item) => `- ${item.kind} by ${item.author}${item.state == null ? "" : ` (${item.state})`}: ${clip(item.body.trim().replace(/\s+/g, " "), 500)}`)));
  let text = [...head(incomplete), ...body].join("\n");
  if (text.length > BRIEF_MAX) {
    incomplete.push(`the brief was cut to ${BRIEF_MAX.toLocaleString("en-US")} characters`);
    const top = head(incomplete).join("\n");
    text = `${top}\n${clip(body.join("\n"), BRIEF_MAX - top.length - 80)}\n\n(The rest of this brief was cut.)`;
  }
  return { text, incomplete };
}

/** Comments and reviews by people, not the author's or Loom's own replies, since Loom's reviewers approved the ticket. */
function peopleSince(read: FinalRead, approvedAt: number | null): NonNullable<FinalRead["items"]> {
  return (read.items ?? [])
    .filter((item) => item.bot !== true && item.author !== (read.author ?? "") && !item.body.trimEnd().endsWith(REPLY_MARK) && item.body.trim() !== "")
    .filter((item) => approvedAt === null || item.createdAt == null || item.createdAt >= approvedAt)
    .slice(-ITEMS_MAX);
}

/**
 * Reads the delta and the checkout's fingerprint on the project's machine, makes the run's empty scratch directory, judges
 * the ticket again, records the run with its deadline and fingerprint, and spawns its thread in the scratch directory. The
 * run is recorded before the scratch directory is made and the thread spawned, so a restart finds its thread by its token
 * or ends it, never starts a second one for the head unseen, and leaves no directory without a run that removes it. Should
 * bb refuse the scratch directory as a workspace, the review does not run and the merge holds.
 */
async function startRun(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, final: FinalReviewSettings, read: FinalRead, still: () => TicketRow | null): Promise<void> {
  const { store } = ctx;
  const sha = ticket.pushed_sha!;
  const url = ticket.pr_url!;
  let checkout: RepoCheckout;
  try {
    checkout = await repoCheckout(ctx, project, spec, ticket.repo);
  } catch (error) {
    ctx.bb.log("warn", `${ticket.key}'s final review waits: ${errText(error)}`);
    return;
  }
  const { sha: approved, at: approvedAt } = approvedHead(store, ticket.id);
  const delta = await readDelta(ctx, checkout, ticket, approved);
  // A read that got no answer is tried at the next read of the pull request, and starts nothing.
  if (isTransient(delta)) return ctx.bb.log("warn", `${ticket.key}'s final review waits for the delta: ${delta.message}`);
  let print: string;
  try {
    const answer = await ctx.host.call(checkout.hostId, "checkoutPrint", { repo: checkout.path });
    if (answer.outcome !== "ok") return failedStart(ctx, ticket, sha, url, `Loom could not read the checkout ${checkout.path} to fingerprint it: ${answer.message}`);
    print = answer.print;
  } catch (error) {
    if (hostCallTransient(error) !== null) return ctx.bb.log("warn", `${ticket.key}'s final review waits for the checkout's fingerprint: ${errText(error)}`);
    return failedStart(ctx, ticket, sha, url, `Loom could not read the checkout ${checkout.path} to fingerprint it: ${errText(error)}`);
  }
  const now = still();
  if (now === null || now.pushed_sha !== sha || now.pr_url !== url) return;
  const state = finalState(store, ticket.id, sha);
  if (state.open !== null || state.passRun !== null || state.failed !== null || state.held !== null) return;
  const applied = appliedOf(now);
  const brief = finalBrief({ ticket: now, approvedAt, delta, text: read.text ?? null, approvedText: applied === null ? null : { title: applied.title, body: applied.body }, items: peopleSince(read, approvedAt) });
  const token = randomBytes(12).toString("hex");
  const scratchKey = `loom-${token}`;
  const deadline = ctx.now() + final.timeoutMs;
  // Recorded, with its scratch key, before the directory exists: a restart leaves a run that owns it, which upkeep removes.
  const run = recordStarted(ctx, now, { sha, url, token, approved, same: delta.same, deadline, repo: checkout.path, print, scratch: scratchKey, incomplete: brief.incomplete });
  spawningOf(store).add(run.id);
  try {
    const made = await ctx.host.call(checkout.hostId, "finalScratch", { key: scratchKey, action: "create" });
    if (made.refused !== undefined) {
      endRun(ctx, now, run, "refused", made.refused);
      const held = still();
      if (held !== null && held.pushed_sha === sha) {
        hold(ctx, project, held, sha, "scratch", `Loom has no scratch directory for its final reviewer of ${url} on the project's machine: ${made.refused}. It never runs the reviewer there or in the repo's checkout, so it holds the merge. Set XDG_CACHE_HOME to a directory outside bb's data directory for bb.`);
      }
      return;
    }
    const scratch = made.path;
    // Upkeep may have stopped the run while the directory was made.
    if (still() === null || finalState(store, ticket.id, sha).open?.id !== run.id) return;
    const spawn = (sectionId: string | null) =>
      ctx.bb.spawnThread({
        bbProjectId: checkout.bbProjectId,
        hostId: checkout.hostId,
        baseBranch: `${checkout.settings.remote}/${checkout.settings.base}`,
        workspace: { path: scratch },
        title: `${ticket.key} · final review`,
        prompt: `Loom's final review of ${ticket.key} before it merges. Follow the brief, call loom_final_review once, then end your turn.`,
        detail: brief.text,
        sectionId,
        metadata: { project: project.slug, role: "final-review", ticket: ticket.key, spawnToken: token },
        providerId: final.provider,
        model: final.model,
        reasoningLevel: final.reasoning,
        permissionMode: spec.agents.reviewer.permission_mode,
      });
    let spawned: { threadId: string };
    try {
      spawned = await spawn(project.section_id);
    } catch (error) {
      if (!(error instanceof SpawnRefusedError)) throw error;
      try {
        spawned = await spawn(null);
      } catch (again) {
        if (!(again instanceof SpawnRefusedError)) throw again;
        // Never in the checkout instead: the review waits for the human.
        endRun(ctx, now, run, "refused", errText(again));
        const held = still();
        if (held !== null && held.pushed_sha === sha) {
          hold(ctx, project, held, sha, "scratch", `bb would not start Loom's final reviewer of ${url} in its scratch directory (${errText(again)}), and Loom never runs it in the repo's checkout, so it holds the merge.`);
        }
        return;
      }
    }
    // Configure may have bound the thread through its token already.
    if (finalState(store, ticket.id, sha).all.find((each) => each.id === run.id)?.thread === null) store.event(ticket.project_id, ticket.id, FINAL_BOUND, LOOM_ACTOR, { run: run.id, thread: spawned.threadId });
    const what = delta.same ? "nothing in the code changed since the reviewers approved it" : `${count(delta.own.length, "of the pull request's own file")} changed since the approval`;
    mergePostNow(ctx.store, now, `Loom started its final review of ${url} on ${sha.slice(0, 12)}: ${what}${brief.incomplete.length === 0 ? "" : `; its brief is incomplete (${brief.incomplete.join("; ")})`}. It merges only once the review passes.`, { outcome: "final_review_started", url, sha, same: delta.same, incomplete: brief.incomplete });
  } catch (error) {
    if (finalState(store, ticket.id, sha).open?.id === run.id) endRun(ctx, now, run, "start", `bb could not start the reviewer: ${errText(error)}`);
  } finally {
    spawningOf(store).delete(run.id);
  }
  await closeRuns(ctx, now, finalState(store, now.id, null).all);
}

/** A run that could not even be recorded, because Loom could not fingerprint the checkout: counted as a failed start. */
function failedStart(ctx: EngineCtx, ticket: TicketRow, sha: string, url: string, message: string): void {
  const run = recordStarted(ctx, ticket, { sha, url, token: randomBytes(12).toString("hex"), deadline: ctx.now() });
  endRun(ctx, ticket, run, "start", message);
}

// ---------------------------------------------------------------- the reviewer's side

/** The run a final reviewer thread belongs to: by its thread, or bound once through the spawn token in its metadata. */
export function finalRunOf(store: Store, threadId: string, metadata: Readonly<Record<string, unknown>> = {}): { ticket: TicketRow; run: FinalRun } | null {
  const bound = store.eventByData(FINAL_BOUND, "thread", threadId);
  const token = typeof metadata.spawnToken === "string" ? metadata.spawnToken : null;
  const started = bound === null ? (token === null ? null : store.eventByData(FINAL_STARTED, "token", token)) : store.eventById(Number(parse(bound).run));
  if (started === null || started.ticket_id === null) return null;
  const ticket = store.ticket(started.ticket_id);
  const run = ticket === null ? undefined : finalState(store, ticket.id, null).all.find((each) => each.id === started.id);
  if (ticket === null || run === undefined) return null;
  if (run.thread === null) {
    store.event(ticket.project_id, ticket.id, FINAL_BOUND, LOOM_ACTOR, { run: run.id, thread: threadId });
    run.thread = threadId;
  }
  return run.thread === threadId ? { ticket, run } : null;
}

/**
 * loom_final_review: the verdict, for the run of this thread, while it is open, before its deadline and while the pull
 * request still has the head it reviews. A verdict past the deadline is refused and ends the run as a timeout, so it can
 * never count as a pass.
 */
export function finalVerdict(ctx: EngineCtx, threadId: string, a: { verdict: "pass" | "fail"; reason: string; fixable?: boolean }): string {
  const { store } = ctx;
  const found = finalRunOf(store, threadId);
  if (found === null) throw new Error("loom_final_review is for Loom's final reviewer threads.");
  const { run } = found;
  const ticket = store.ticket(found.ticket.id)!;
  const current = finalState(store, ticket.id, run.sha).all.find((each) => each.id === run.id)!;
  if (current.verdict !== null || current.ended !== null) throw new Error("This final review is over, so there is nothing to decide. End your turn.");
  const project = store.project(ticket.project_id);
  const settings = project === null ? null : finalReviewOf(specOf(store, project), autoMergeOf(repoSettings(specOf(store, project), ticket.repo).forge));
  const deadline = current.deadline ?? (settings === null ? null : current.at + settings.timeoutMs);
  if (deadline !== null && ctx.now() >= deadline) {
    endRun(ctx, ticket, current, "timeout", "its verdict came after its deadline");
    readSoon(ctx, ticket.id);
    throw new Error("This final review ran out of time, so Loom does not take its verdict. End your turn.");
  }
  if (ticket.state !== "pr_open" || ticket.pushed_sha !== run.sha || ticket.pr_url !== run.url) {
    store.event(ticket.project_id, ticket.id, FINAL_ENDED, LOOM_ACTOR, { run: run.id, sha: run.sha, why: "superseded" });
    readSoon(ctx, ticket.id);
    throw new Error("The pull request changed since this review started, so Loom reviews its new head instead. End your turn.");
  }
  const reason = a.reason.trim();
  if (a.verdict === "fail" && reason === "") throw new Error("A failed review needs a reason: what broke, and where.");
  const fixable = a.verdict === "fail" && a.fixable !== false;
  store.event(ticket.project_id, ticket.id, FINAL_VERDICT, LOOM_ACTOR, { run: run.id, sha: run.sha, pass: a.verdict === "pass", reason, fixable });
  mergePostNow(
    ctx.store,
    ticket,
    a.verdict === "pass"
      ? `Loom's final review passed ${run.sha.slice(0, 12)}${reason === "" ? "" : `: ${clip(reason, 1500)}`}. Loom counts it once the reviewer has stopped and the repo's checkout is unchanged.`
      : `Loom's final review failed ${run.sha.slice(0, 12)}${fixable ? ", and the worker can fix it" : ", and it needs a person"}: ${clip(reason, 1500)}`,
    { outcome: a.verdict === "pass" ? "final_review_passed" : "final_review_failed", url: run.url, sha: run.sha, fixable, reason: clip(reason, 2000) },
  );
  readSoon(ctx, ticket.id);
  return a.verdict === "pass" ? "Recorded: the final review passed. Loom merges once its other checks still hold. End your turn." : "Recorded: the final review failed. Loom sends it back or blocks the ticket. End your turn.";
}

/**
 * A final reviewer's thread went idle, failed or went away: the ticket's pull request is read now, which follows the run,
 * and its runs are kept up. False for a thread that is no final reviewer.
 */
export async function finalThreadEvent(ctx: EngineCtx, threadId: string): Promise<boolean> {
  const bound = ctx.store.eventByData(FINAL_BOUND, "thread", threadId);
  if (bound === null || bound.ticket_id === null) return false;
  readSoon(ctx, bound.ticket_id);
  return true;
}


/** `bb loom auto-merge <slug> retry --ticket KEY` also lets a held final review try again for the ticket's head. */
export function resetFinalReview(store: Store, ticket: TicketRow): boolean {
  const state = finalState(store, ticket.id, ticket.pushed_sha);
  if (state.passed !== null || (state.held === null && state.unfinished.length === 0)) return false;
  store.event(ticket.project_id, ticket.id, FINAL_RESET, HUMAN_ACTOR, { sha: ticket.pushed_sha });
  return true;
}

/** `bb loom auto-merge <slug> accept --ticket KEY`: the human lets Loom merge on a counted pass of an incomplete brief, for the head it reviewed. */
export function acceptFinalReview(store: Store, ticket: TicketRow): string {
  const state = finalState(store, ticket.id, ticket.pushed_sha);
  if (state.passRun === null || !state.passRun.verified) return `${ticket.key} has no counted pass of its final review for its head to accept.`;
  if (state.passRun.incomplete.length === 0 || state.accepted) return `${ticket.key}'s final review already lets it merge.`;
  store.event(ticket.project_id, ticket.id, FINAL_ACCEPTED, HUMAN_ACTOR, { sha: ticket.pushed_sha, run: state.passRun.id });
  return `Accepted ${ticket.key}'s final review of ${ticket.pushed_sha!.slice(0, 12)}: Loom merges it once its other checks still hold.`;
}
