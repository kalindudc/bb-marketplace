// When a review run ends. A turn that ends is not the review's end: a review thread often waits on child threads, such as
// critics, between turns. It ends when its thread hands back a draft or says it is over, when the thread fails, or when
// nothing has happened in the thread or its child threads for hours.
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { PrRow, ReviewRow } from "./db/store";
import { REVIEW_QUIET_MS } from "./next";
import { lookup, shortKey } from "./prs";
import { startReview, type ReviewOptions } from "./reviews";

const BUSY = new Set(["active", "starting", "pending"]);
/** While bb cannot answer, each review it cannot check is logged at most this often, not at every tick. */
const WARN_EVERY_MS = 3_600_000;
const warned = new WeakMap<object, Map<number, number>>();
/** How deep under a review thread Shuttle looks for threads at work: its children, and theirs. */
const DEPTH = 2;
const HOUR = 3_600_000;

const title = (ctx: Ctx, threadId: string) => ctx.store.threadTitle(threadId) ?? threadId;
const prName = (ctx: Ctx, run: ReviewRow) => {
  const pr = ctx.store.prById(run.pr_id);
  return pr ? shortKey(ctx, pr) : "a PR";
};

/** The thread's latest run for the PR. */
function runOf(ctx: Ctx, pr: PrRow, threadId: string): ReviewRow | null {
  return [...ctx.store.reviewsOf(pr.id)].reverse().find((run) => run.thread_id === threadId) ?? null;
}

/** Called by a review thread's shuttle_review_done tool: the review is over without a draft, or it could not finish. */
export async function endReview(ctx: Ctx, threadId: string, query: string, input: { note: string; failed: boolean }): Promise<PrRow> {
  const pr = await lookup(ctx, query);
  const run = runOf(ctx, pr, threadId);
  if (run === null) throw new ShuttleError(`No review of ${shortKey(ctx, pr)} runs in this thread`);
  if (run.state !== "running") {
    const how = run.ended_by === "draft" ? "it handed back a draft" : run.state === "failed" ? "it failed" : "it finished";
    throw new ShuttleError(`The review of ${shortKey(ctx, pr)} in this thread is already over: ${how}`);
  }
  const note = input.note.trim();
  ctx.store.finishReview(run.id, input.failed ? "failed" : "done", "thread", note);
  ctx.store.addEvent(
    input.failed ? "review_failed" : "review_done",
    input.failed ? `\u201c${title(ctx, threadId)}\u201d could not finish its review of ${shortKey(ctx, pr)}: ${note}` : `\u201c${title(ctx, threadId)}\u201d finished its review of ${shortKey(ctx, pr)} without a draft: ${note}`,
    pr.id,
    threadId,
  );
  ctx.port.publish();
  return pr;
}

/** How many times a review whose thread could not set up its workspace starts again, each time in a new thread. */
export const SETUP_RETRIES = 2;

/** What bb's thread.failed says about the thread. */
export interface ThreadFailure {
  /** bb's latest error message for it, such as "Provisioning thread failed". */
  error: string | null;
  /** Null when the thread has no workspace; left out when unknown. */
  environmentId?: string | null;
}

/** bb could not set up the thread's workspace (a machine or environment provider failed), so its agent never ran. */
export function isSetupFailure(failure: ThreadFailure): boolean {
  return failure.environmentId === null || /\bprovisioning\b/iu.test(failure.error ?? "");
}

/**
 * The thread failed, so its running reviews end. A review whose thread could not set up its workspace never started:
 * it starts again in a new thread, up to SETUP_RETRIES times, since a provider's failure is often one bad machine.
 */
export async function failReviewsOfThread(ctx: Ctx, threadId: string, failure: ThreadFailure): Promise<number> {
  const setup = isSetupFailure(failure);
  const running = ctx.store.runningReviewsOfThread(threadId);
  // Every run ends before anything is awaited, so a second event for the thread finds none to start again.
  for (const run of running) ctx.store.finishReview(run.id, "failed", setup ? "setup" : "failed");
  for (const run of running) {
    if (setup) await startAgain(ctx, run);
    else ctx.store.addEvent("review_failed", `The review thread \u201c${title(ctx, threadId)}\u201d failed.`, run.pr_id, threadId);
  }
  if (running.length) ctx.port.publish();
  return running.length;
}

async function startAgain(ctx: Ctx, run: ReviewRow): Promise<void> {
  const pr = ctx.store.prById(run.pr_id);
  const failed = `\u201c${title(ctx, run.thread_id)}\u201d could not set up its workspace`;
  const name = pr ? shortKey(ctx, pr) : "a PR";
  // Only the PR's latest review starts again: one started since is the one that counts, and a closed PR needs none.
  if (!pr || (pr.state !== "open" && pr.state !== "draft") || ctx.store.lastReview(pr.id)?.id !== run.id) {
    ctx.store.addEvent("review_failed", `The review thread ${failed}.`, run.pr_id, run.thread_id);
    return;
  }
  // An auto review starts again only while auto reviews would start at all (sync.ts runAutoReviews).
  const stopped = run.trigger !== "auto" ? null : ctx.settings().pauseAutomations ? "automations are paused" : !ctx.config().autoReview.enabled ? "auto review is off" : null;
  if (stopped !== null) {
    ctx.store.addEvent("review_failed", `${failed}. Shuttle did not start the auto review of ${name} again: ${stopped}.`, pr.id, run.thread_id);
    return;
  }
  if (run.attempt > SETUP_RETRIES) {
    ctx.store.addEvent(
      "review_failed",
      `Shuttle stopped starting the review of ${name} again: ${run.attempt} threads in a row could not set up their workspaces. Start it again once the machine or environment provider works.`,
      pr.id,
      run.thread_id,
    );
    return;
  }
  const options = run.input ? (JSON.parse(run.input) as ReviewOptions) : {};
  try {
    await startReview(ctx, { ...options, key: pr.key, newThread: true }, run.trigger, run.attempt + 1);
  } catch (error) {
    ctx.store.addEvent("review_failed", `${failed}, and the review of ${name} could not start again in a new thread: ${errText(error)}`, pr.id, run.thread_id);
    return;
  }
  ctx.store.addEvent("review_retry", `The review of ${name} starts again in a new thread (try ${run.attempt + 1} of ${SETUP_RETRIES + 1}): ${failed}.`, pr.id, run.thread_id);
}

/** A thread at work, or waiting on the user's answer, under `threadId`. */
async function busyBelow(ctx: Ctx, threadId: string, depth: number): Promise<boolean> {
  for (const child of await ctx.port.childThreads(threadId)) {
    if (child.waiting || BUSY.has(child.status)) return true;
    if (depth > 1 && (await busyBelow(ctx, child.id, depth - 1))) return true;
  }
  return false;
}

/**
 * Ends the running reviews nothing has happened in for REVIEW_QUIET_MS: not in the thread, not in a child thread of it,
 * and with no question to the user waiting. bb is asked first, since an event Shuttle missed would make a review look
 * quiet; a review found at work counts as active from now.
 */
export async function endQuietReviews(ctx: Ctx): Promise<number> {
  let ended = 0;
  const before = ctx.now() - REVIEW_QUIET_MS;
  for (const run of ctx.store.quietReviews(before)) {
    let busy: boolean;
    try {
      // bb's list says whether a thread waits on the user; a single read does not.
      const [thread] = await ctx.port.threadsById([run.thread_id]);
      busy = thread !== undefined && !thread.archived && (thread.waiting || BUSY.has(thread.status) || (await busyBelow(ctx, run.thread_id, DEPTH)));
    } catch (error) {
      // Unsure, so it stays running; the next tick asks again.
      const last = warned.get(ctx.store) ?? new Map<number, number>();
      warned.set(ctx.store, last);
      if (ctx.now() - (last.get(run.id) ?? -Infinity) >= WARN_EVERY_MS) {
        last.set(run.id, ctx.now());
        ctx.port.log("warn", `check the review thread ${run.thread_id}: ${errText(error)}`);
      }
      continue;
    }
    if (busy) {
      ctx.store.touchReviews(run.thread_id);
      continue;
    }
    // A draft, the thread's own word or new activity may have come while bb was asked.
    if (!ctx.store.endQuietReview(run.id, before)) continue;
    const hours = REVIEW_QUIET_MS / HOUR;
    ctx.store.addEvent("review_failed", `The review of ${prName(ctx, run)} went quiet: nothing happened in \u201c${title(ctx, run.thread_id)}\u201d or its child threads for ${hours} hour${hours === 1 ? "" : "s"}, and it handed back no draft.`, run.pr_id, run.thread_id);
    ended += 1;
  }
  if (ended > 0) ctx.port.publish();
  return ended;
}

/** Ended by something that may not have been the review's end: the thread failing, going quiet, or a turn ending before an upgrade. */
function mayResume(ctx: Ctx, run: ReviewRow): boolean {
  if (run.state === "running") return false;
  if (run.ended_by === "failed" || run.ended_by === "setup" || run.ended_by === "quiet") return true;
  // Before Shuttle waited for child threads, a turn's end ended the review; one that ended so lately may be waiting on its critics.
  return run.ended_by === null && run.state === "done" && run.finished_at !== null && ctx.now() - run.finished_at < REVIEW_QUIET_MS;
}

/** A thread whose review failed or went quiet and that works again is reviewing again, unless a draft came back since. */
export function resumeReviews(ctx: Ctx, threadId: string): number {
  let resumed = 0;
  for (const run of ctx.store.latestRunsOfThread(threadId)) {
    if (!mayResume(ctx, run)) continue;
    if (ctx.store.hasDraftSince(run.pr_id, run.created_at)) continue;
    ctx.store.restartReview(run.id);
    ctx.store.addEvent("review", `\u201c${title(ctx, threadId)}\u201d is at work again, so its review of ${prName(ctx, run)} is running again.`, run.pr_id, threadId);
    resumed += 1;
  }
  return resumed;
}
