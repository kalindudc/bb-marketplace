// The review queue: a review is checked and queued at once, then posted in the background, in order and one at a
// time on each server, so a slow server never keeps the user waiting.
import type { PostFinding, PostView } from "./contract";
import { NotFoundError, ShuttleError, type Ctx } from "./ctx";
import type { PostRow, PrRow } from "./db/store";
import { checkHead, checkReview, reviewAdapter, type SubmitInput } from "./drafts";
import { requirePr, shortKey } from "./prs";

/** Finished posts stay in the posts list this long, so a page that missed the change can still tell how it went. */
export const RECENT_POSTS_MS = 10 * 60_000;

const VERDICT_TEXT = { comment: "comment", approve: "approval", changes: "request for changes" } as const;

export function postView(ctx: Ctx, row: PostRow, pr: PrRow | null = ctx.store.prById(row.pr_id)): PostView {
  return {
    id: row.id,
    key: pr?.key ?? "",
    display: pr ? shortKey(ctx, pr) : "a PR",
    serverName: ctx.server(row.server)?.name ?? row.server,
    verdict: row.verdict,
    comments: (JSON.parse(row.findings) as unknown[]).length,
    draftId: row.draft_id,
    state: row.state,
    error: row.error,
    placed: row.placed,
    inBody: row.in_body,
    at: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function inputOf(row: PostRow): SubmitInput {
  return {
    verdict: row.verdict,
    body: row.body,
    findings: JSON.parse(row.findings) as PostFinding[],
    ...(row.draft_id === null ? {} : { draftId: row.draft_id }),
    ...(row.stale_ok === 1 ? { staleOk: true } : {}),
  };
}

/** One review of a PR at a time: a second would post the same review twice, or race the first. */
function refuseSecond(ctx: Ctx, pr: PrRow): void {
  const active = ctx.store.activePostOfPr(pr.id);
  if (active !== null) throw new ShuttleError(`A review of ${shortKey(ctx, pr)} is already ${active.state === "posting" ? "posting" : "queued to post"}; wait for it, or cancel it first`);
}

/** Refuses now what the post would be refused for with what Shuttle knows; the head is checked again when it posts. */
export function queueReview(ctx: Ctx, key: string, input: SubmitInput): PostRow {
  const pr = requirePr(ctx, key);
  const draft = checkReview(ctx, pr, input);
  refuseSecond(ctx, pr);
  checkHead(ctx, pr, draft, input);
  reviewAdapter(ctx, pr);
  const row = ctx.store.tx(() => {
    // A new review of the PR is the answer to one that failed to post.
    ctx.store.clearFailedPosts(pr.id);
    // A snooze must not hide how the post goes.
    ctx.store.setSnooze(pr.id, null, null);
    return ctx.store.addPost({
      pr_id: pr.id, server: pr.server, draft_id: draft?.id ?? null, verdict: input.verdict, body: input.body, findings: JSON.stringify(input.findings), stale_ok: input.staleOk ? 1 : 0,
    });
  });
  ctx.port.publish();
  return row;
}

function requirePost(ctx: Ctx, id: number): PostRow {
  const row = ctx.store.postById(id);
  if (row === null) throw new NotFoundError(`no queued review ${id}`);
  return row;
}

function prOf(ctx: Ctx, row: PostRow): PrRow {
  const pr = ctx.store.prById(row.pr_id);
  if (pr === null) throw new NotFoundError("Shuttle no longer has that review's PR");
  return pr;
}

export function cancelPost(ctx: Ctx, id: number): PrRow {
  const row = requirePost(ctx, id);
  if (row.state === "posting") throw new ShuttleError("It has started posting, so it can't be cancelled");
  if (row.state !== "queued") throw new ShuttleError(`That review is ${row.state === "cancelled" ? "already cancelled" : `already ${row.state}`}`);
  const pr = prOf(ctx, row);
  ctx.store.tx(() => {
    ctx.store.finishPost(row.id, { state: "cancelled" });
    if (row.draft_id !== null) ctx.store.retireReplacedDraft(row.draft_id);
  });
  ctx.store.addEvent("post_cancelled", `Cancelled your ${VERDICT_TEXT[row.verdict]} on ${shortKey(ctx, pr)} before it posted.`, pr.id);
  ctx.port.publish();
  return pr;
}

export function retryPost(ctx: Ctx, id: number): PostRow {
  const row = requirePost(ctx, id);
  if (row.state !== "failed") throw new ShuttleError("Only a review that failed to post can be tried again");
  const pr = prOf(ctx, row);
  checkReview(ctx, pr, inputOf(row));
  refuseSecond(ctx, pr);
  ctx.store.tx(() => {
    ctx.store.clearFailedPosts(pr.id);
    ctx.store.requeuePost(row.id);
  });
  ctx.port.publish();
  return ctx.store.postById(row.id)!;
}

export function clearPost(ctx: Ctx, id: number): PrRow {
  const row = requirePost(ctx, id);
  if (row.state !== "failed") throw new ShuttleError("Only a review that failed to post can be dismissed");
  const pr = prOf(ctx, row);
  ctx.store.tx(() => {
    ctx.store.clearPost(row.id);
    if (row.draft_id !== null) ctx.store.retireReplacedDraft(row.draft_id);
  });
  ctx.port.publish();
  return pr;
}

/** A post a stopped Shuttle left half done may or may not be on its server, so it fails for the user to check, never posts twice. */
export function failInterruptedPosts(ctx: Ctx): number {
  const rows = ctx.store.interruptedPosts();
  for (const row of rows) {
    const server = ctx.server(row.server)?.name ?? row.server;
    ctx.store.finishPost(row.id, { state: "failed", error: `Shuttle stopped while posting it, so ${server} may or may not have it. Check the PR before you try again.` });
  }
  if (rows.length > 0) ctx.port.publish();
  return rows.length;
}

/** What waits or posts, then what finished in the last 10 minutes. */
export function recentPosts(ctx: Ctx): PostView[] {
  return [...ctx.store.activePosts(), ...ctx.store.postsFinishedSince(ctx.now() - RECENT_POSTS_MS)].map((row) => postView(ctx, row));
}
