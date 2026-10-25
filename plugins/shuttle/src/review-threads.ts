// The review threads Shuttle starts: archived once their review is done, and brought back for the PR's next review.
import type { MyReview } from "./contract";
import { errText, NotFoundError, ShuttleError, type Ctx } from "./ctx";
import type { PrRow, ReviewRow } from "./db/store";
import type { SendOptions } from "./ports";
import { shortKey } from "./prs";

const BUSY = new Set(["active", "starting", "pending"]);
/** Archives under way, by store, so a sync and a thread event never archive one thread twice. */
const inFlight = new WeakMap<object, Set<string>>();

/** Why the run's review is over, or null while the user may still want its thread. */
export function doneBecause(ctx: Ctx, pr: PrRow, run: ReviewRow): string | null {
  if (run.state === "running") return null;
  if (pr.state === "merged") return "the PR merged";
  if (pr.state === "closed") return "the PR closed";
  const drafts = ctx.store.draftsOfThread(pr.id, run.thread_id, run.created_at);
  if (drafts.some((draft) => draft.state === "draft")) return null;
  const latest = ctx.store.lastReview(pr.id);
  if (latest !== null && latest.thread_id !== run.thread_id) return "a newer review of the PR runs in another thread";
  const last = drafts[0];
  if (last?.state === "posted") return "you posted its review";
  if (last?.state === "discarded") return "you discarded its draft";
  const since = run.finished_at ?? run.created_at;
  const local = ctx.store.latestMyReview(pr.id);
  const server = pr.my_review ? (JSON.parse(pr.my_review) as MyReview) : null;
  if ((local !== null && local.at >= since) || (server?.at != null && server.at >= since)) return "you reviewed the PR";
  return null;
}

/**
 * Archives each review thread Shuttle started whose review is done, with its child threads (bb archives
 * them together). A thread that works, waits on the user, became the PR's agent, or that the user brought
 * back after Shuttle archived it stays as it is.
 */
export async function archiveDoneReviewThreads(ctx: Ctx, filter: { prId?: number; threadId?: string } = {}): Promise<number> {
  if (!ctx.settings().archiveReviewThreads) return 0;
  const busy = inFlight.get(ctx.store) ?? new Set<string>();
  inFlight.set(ctx.store, busy);
  let archived = 0;
  for (const run of ctx.store.unarchivedReviewRuns(filter)) {
    const pr = ctx.store.prById(run.pr_id);
    const thread = ctx.store.thread(run.thread_id);
    if (!pr || !thread || busy.has(run.thread_id)) continue;
    if (ctx.store.linkRole(pr.id, run.thread_id) !== "review") continue;
    if (thread.waiting === 1 || (thread.status !== null && BUSY.has(thread.status))) continue;
    const why = doneBecause(ctx, pr, run);
    if (why === null) continue;
    busy.add(run.thread_id);
    try {
      const ids = await ctx.port.archive(run.thread_id);
      ctx.store.setReviewArchived(run.id, ctx.now());
      ctx.store.setThreadArchived(run.thread_id, true);
      const children = ids.filter((id) => id !== run.thread_id).length;
      const along = children ? ` and its ${children} child thread${children === 1 ? "" : "s"}` : "";
      ctx.store.addEvent("archived", `Archived the review thread \u201c${thread.title}\u201d${along}: ${why}.`, pr.id, run.thread_id);
      archived += 1;
    } catch (error) {
      // The next sync tries again.
      ctx.port.log("warn", `archive the review thread of ${pr.key}: ${errText(error)}`);
    } finally {
      busy.delete(run.thread_id);
    }
  }
  if (archived) ctx.port.publish();
  return archived;
}

/**
 * Sends a review prompt to a thread, bringing it back from the archive first, and its workspace too when
 * bb removed it. Its child threads stay archived. A thread brought back and then refused goes back.
 */
export async function sendToReviewThread(ctx: Ctx, threadId: string, prompt: string, options: SendOptions & { providerId?: string }): Promise<{ revived: boolean }> {
  const info = await ctx.port.getThread(threadId);
  if (!info) {
    ctx.store.forgetThread(threadId);
    throw new NotFoundError(`the thread ${threadId} is gone`);
  }
  if (options.providerId && info.providerId && info.providerId !== options.providerId) {
    throw new ShuttleError(`it runs on ${info.providerId}, and this review asks for ${options.providerId}`);
  }
  const send: SendOptions = { ...(options.model ? { model: options.model } : {}), ...(options.reasoningLevel ? { reasoningLevel: options.reasoningLevel } : {}) };
  const revived = info.archived;
  if (revived) await ctx.port.unarchive(threadId);
  try {
    const now = revived ? await ctx.port.getThread(threadId) : info;
    if (now?.canRestoreEnvironment) await ctx.port.restoreEnvironment(threadId);
    await ctx.port.send(threadId, prompt, send);
  } catch (error) {
    if (revived) await ctx.port.archive(threadId).catch(() => []);
    throw error;
  }
  if (revived) ctx.store.setThreadArchived(threadId, false);
  return { revived };
}

/** Undo of a discard: the draft is back, so the thread Shuttle archived for it comes back too. */
export async function unarchiveForDraft(ctx: Ctx, pr: PrRow, threadId: string): Promise<void> {
  const run = [...ctx.store.reviewsOf(pr.id)].reverse().find((review) => review.thread_id === threadId);
  if (!run || run.archived_at === null) return;
  try {
    await ctx.port.unarchive(threadId);
    ctx.store.setReviewArchived(run.id, null);
    ctx.store.setThreadArchived(threadId, false);
    ctx.store.addEvent("revived", `Brought back the review thread \u201c${ctx.store.threadTitle(threadId) ?? threadId}\u201d of ${shortKey(ctx, pr)}: its draft is back.`, pr.id, threadId);
    ctx.port.publish();
  } catch (error) {
    ctx.port.log("warn", `bring back the review thread of ${pr.key}: ${errText(error)}`);
  }
}
