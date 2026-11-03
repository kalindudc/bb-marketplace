// The merge queue: a merge of one of your PRs is checked and queued at once, then carried out in the background, in
// order and one at a time on each server, so a slow server never keeps the user waiting.
import type { MergeInput } from "./adapters/adapter";
import type { MergeView } from "./contract";
import { checkMerge } from "./conversation";
import { NotFoundError, ShuttleError, type Ctx } from "./ctx";
import type { MergeRow, PrRow } from "./db/store";
import { requirePr, shortKey } from "./prs";

/** Finished merges stay in the merges list this long, so a page that missed the change can still tell how it went. */
export const RECENT_MERGES_MS = 10 * 60_000;
/** How long a PR a server took but left open, as a repository's own merge queue does, shows as sent rather than ready to merge. */
export const SENT_MERGE_MS = 24 * 3_600_000;

export function mergeView(ctx: Ctx, row: MergeRow, pr: PrRow | null = ctx.store.prById(row.pr_id)): MergeView {
  return {
    id: row.id,
    key: pr?.key ?? "",
    display: pr ? shortKey(ctx, pr) : "a PR",
    serverName: ctx.server(row.server)?.name ?? row.server,
    method: row.method,
    auto: row.auto === 1,
    deleteBranch: row.delete_branch === 1,
    head: row.head,
    state: row.state,
    outcome: row.outcome,
    error: row.error,
    at: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function mergeInputOf(row: MergeRow): MergeInput {
  return { method: row.method, head: row.head, auto: row.auto === 1, deleteBranch: row.delete_branch === 1, ...(row.subject === null ? {} : { subject: row.subject }) };
}

/** "merge" or "auto-merge", for the words around it. */
const what = (row: Pick<MergeRow, "auto">) => (row.auto === 1 ? "auto-merge" : "merge");

/** One merge of a PR at a time: a second would race the first, or merge what the first already did. */
function refuseSecond(ctx: Ctx, pr: PrRow): void {
  const active = ctx.store.activeMergeOfPr(pr.id);
  if (active !== null) throw new ShuttleError(`A ${what(active)} of ${shortKey(ctx, pr)} is already ${active.state === "merging" ? "under way" : "queued"}; wait for it, or cancel it first`);
}

/** Refuses now what the merge would be refused for with what Shuttle knows; the PR is read again just before it merges. */
export function queueMerge(ctx: Ctx, key: string, input: MergeInput): MergeRow {
  const pr = requirePr(ctx, key);
  checkMerge(ctx, pr, input);
  refuseSecond(ctx, pr);
  const row = ctx.store.tx(() => {
    // A new merge of the PR is the answer to one that failed.
    ctx.store.clearFailedMerges(pr.id);
    // A snooze must not hide how the merge goes.
    ctx.store.setSnooze(pr.id, null, null);
    return ctx.store.addMerge({
      pr_id: pr.id, server: pr.server, method: input.method, head: input.head, auto: input.auto ? 1 : 0, delete_branch: input.deleteBranch ? 1 : 0, subject: input.subject ?? null,
    });
  });
  ctx.port.publish();
  return row;
}

function requireMerge(ctx: Ctx, id: number): MergeRow {
  const row = ctx.store.mergeById(id);
  if (row === null) throw new NotFoundError(`no queued merge ${id}`);
  return row;
}

function prOf(ctx: Ctx, row: MergeRow): PrRow {
  const pr = ctx.store.prById(row.pr_id);
  if (pr === null) throw new NotFoundError("Shuttle no longer has that merge's PR");
  return pr;
}

export function cancelMerge(ctx: Ctx, id: number): PrRow {
  const row = requireMerge(ctx, id);
  if (row.state === "merging") throw new ShuttleError(`The ${what(row)} has started, so it can't be cancelled`);
  if (row.state !== "queued") throw new ShuttleError(`That ${what(row)} is ${row.state === "cancelled" ? "already cancelled" : row.state === "done" ? "already done" : "already failed"}`);
  const pr = prOf(ctx, row);
  ctx.store.finishMerge(row.id, { state: "cancelled" });
  ctx.store.addEvent("merge_cancelled", `Cancelled the ${what(row)} of ${shortKey(ctx, pr)} before it started.`, pr.id);
  ctx.port.publish();
  return pr;
}

/** The same merge again, at the same head: a PR with commits since is refused, to be looked at and merged again. */
export function retryMerge(ctx: Ctx, id: number): MergeRow {
  const row = requireMerge(ctx, id);
  if (row.state !== "failed") throw new ShuttleError("Only a merge that failed can be tried again");
  const pr = prOf(ctx, row);
  checkMerge(ctx, pr, mergeInputOf(row));
  refuseSecond(ctx, pr);
  ctx.store.tx(() => {
    ctx.store.clearFailedMerges(pr.id);
    ctx.store.requeueMerge(row.id);
  });
  ctx.port.publish();
  return ctx.store.mergeById(row.id)!;
}

export function clearMerge(ctx: Ctx, id: number): PrRow {
  const row = requireMerge(ctx, id);
  if (row.state !== "failed") throw new ShuttleError("Only a merge that failed can be dismissed");
  const pr = prOf(ctx, row);
  ctx.store.clearMerge(row.id);
  ctx.port.publish();
  return pr;
}

/** A merge a stopped Shuttle left under way may or may not have gone through, so it fails for the user to check; the next sync shows which. */
export function failInterruptedMerges(ctx: Ctx): number {
  const rows = ctx.store.interruptedMerges();
  for (const row of rows) {
    const server = ctx.server(row.server)?.name ?? row.server;
    const done = row.auto === 1 ? "turned on auto-merge" : "merged it";
    ctx.store.finishMerge(row.id, { state: "failed", error: `Shuttle stopped while it was under way, so ${server} may or may not have ${done}. Check the PR before you try again.` });
  }
  if (rows.length > 0) ctx.port.publish();
  return rows.length;
}

/** What waits or merges, then what finished in the last 10 minutes. */
export function recentMerges(ctx: Ctx): MergeView[] {
  return [...ctx.store.activeMerges(), ...ctx.store.mergesFinishedSince(ctx.now() - RECENT_MERGES_MS)].map((row) => mergeView(ctx, row));
}
