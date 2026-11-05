// Finding PRs and linking them to threads. A thread can own several PRs, and a PR can be linked
// to several threads.
import type { WatchMode } from "./config";
import type { LinkRole, MyReview } from "./contract";
import { NotFoundError, ShuttleError, type Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { displayKey, linkFor, parseKey, resolveQuery, type PrRef } from "./keys";
import type { PrSummary } from "./model";

/** A stored PR, or fetched from its server and stored when Shuttle has not seen it yet. */
export async function lookup(ctx: Ctx, query: string, refresh = false): Promise<PrRow> {
  const ref = resolveQuery(query, ctx.config().servers);
  const known = ctx.store.prByRef(ref);
  if (known && !refresh) return known;
  return fetchPr(ctx, ref);
}

export async function fetchPr(ctx: Ctx, ref: PrRef): Promise<PrRow> {
  return (await fetchPrSummary(ctx, ref)).pr;
}

/** fetchPr, with the server's own answer: stored rows keep fields an answer leaves out, such as an older head's size. */
export async function fetchPrSummary(ctx: Ctx, ref: PrRef): Promise<{ pr: PrRow; summary: PrSummary }> {
  const server = ctx.server(ref.server);
  if (!server) throw new ShuttleError(`no server called ${ref.server}`);
  const summary = await ctx.adapter(ref.server).view(ref.repo, ref.number);
  // A server that answers for another PR must not have its answer stored, or acted on, under this key.
  if (summary.repo.toLowerCase() !== ref.repo.toLowerCase() || summary.number !== ref.number) {
    throw new ShuttleError(`${server.name} answered for ${summary.repo}${server.sep}${summary.number} when asked for ${ref.repo}${server.sep}${ref.number}`);
  }
  const mine = summary.author !== "" && summary.author === ctx.store.server(ref.server)?.login;
  const pr = ctx.store.upsertPr(ref.server, { ...summary, repo: ref.repo }, summary.url ?? linkFor(server, ref.repo, ref.number), mine);
  ctx.port.publish();
  return { pr, summary };
}

export function requirePr(ctx: Ctx, key: string): PrRow {
  const ref = parseKey(key);
  const pr = ref ? ctx.store.prByRef(ref) : null;
  if (!pr) throw new NotFoundError(`Shuttle does not know ${key}; look it up first`);
  return pr;
}

export function shortKey(ctx: Ctx, pr: PrRow): string {
  return displayKey({ server: pr.server, repo: pr.repo, number: pr.number }, ctx.server(pr.server)?.sep ?? "#");
}

/**
 * Shuttle's record of a review it posted is dated when the post came back, within a command's timeout of when the server
 * took it and dated it; the server's date can run a few seconds ahead, as it drops the milliseconds and clocks differ.
 */
const POST_LAG_MS = 2 * 60_000;
const CLOCK_SKEW_MS = 5_000;

/**
 * Your latest review of the PR: the server's, or the one Shuttle posted when the server does not list it yet. Only a
 * server dismisses a review, so its dismissed review wins over Shuttle's record when that record is of the post that
 * made it, rather than of a newer review the server has not listed yet.
 */
export function myReviewOf(ctx: Ctx, pr: PrRow): MyReview | null {
  const server = pr.my_review ? (JSON.parse(pr.my_review) as MyReview) : null;
  const local = ctx.store.latestMyReview(pr.id);
  if (!local) return server;
  const fromShuttle: MyReview = { verdict: local.verdict as MyReview["verdict"], at: local.at, head: local.head };
  if (!server) return fromShuttle;
  if ((server.at ?? 0) >= local.at) return server;
  if (server.verdict !== "dismissed") return fromShuttle;
  // A server that does not date reviews: a dismissed review at the head Shuttle's last post reviewed is that post.
  if (server.at === null) return server.head !== null && server.head === local.head ? server : fromShuttle;
  const post = ctx.store.firstMyReviewBetween(pr.id, server.at - CLOCK_SKEW_MS, server.at + POST_LAG_MS);
  return post?.id === local.id ? server : fromShuttle;
}

export async function rememberThread(ctx: Ctx, threadId: string): Promise<void> {
  const thread = await ctx.port.getThread(threadId);
  if (!thread) throw new NotFoundError(`thread ${threadId} was not found`);
  ctx.store.saveThread(thread.id, thread.title, thread.archived, { status: thread.status, waiting: thread.waiting });
}

/**
 * Links a thread. An owner is the PR's agent, and a PR has one: the owner before stays linked for
 * reference. Linking an owner to your own PR watches it in your default mode when autoWatch is on.
 */
export async function linkPr(ctx: Ctx, pr: PrRow, threadId: string, role: LinkRole, options: { watch?: boolean; auto?: boolean } = {}): Promise<void> {
  await rememberThread(ctx, threadId);
  const before = ctx.store.linkRole(pr.id, threadId);
  const replaced = ctx.store.tx(() => {
    const others = role === "owner" ? ctx.store.demoteOwners(pr.id, threadId) : [];
    ctx.store.link(pr.id, threadId, role, options.auto === true);
    return others;
  });
  if (role === "owner") ctx.store.setSuggestion(pr.id, null, null);
  const watch = ctx.config().watch;
  const wantWatch = options.watch ?? (role === "owner" && pr.mine === 1 && watch.enabled && watch.autoWatch);
  if (wantWatch && ctx.store.watch(pr.id) === null) setWatch(ctx, pr, watch.mode);
  const title = `\u201c${ctx.store.threadTitle(threadId)}\u201d`;
  if (before !== role) {
    const was = replaced.map((id) => `\u201c${ctx.store.threadTitle(id) ?? id}\u201d`).join(", ");
    const text = role === "owner" ? `${title} is now the agent of ${shortKey(ctx, pr)}${was ? `; ${was} stays linked for reference` : ""}.` : `Linked ${shortKey(ctx, pr)} to ${title} as a ${role} thread.`;
    ctx.store.addEvent("linked", text, pr.id, threadId);
  }
  ctx.port.publish();
}

export function unlinkPr(ctx: Ctx, pr: PrRow, threadId: string): void {
  if (!ctx.store.unlink(pr.id, threadId)) throw new ShuttleError(`${shortKey(ctx, pr)} is not linked to that thread`);
  ctx.store.addEvent("unlinked", `Unlinked ${shortKey(ctx, pr)} from \u201c${ctx.store.threadTitle(threadId) ?? threadId}\u201d.`, pr.id, threadId);
  ctx.port.publish();
}

/** Watched activity goes only to the agent (the owner thread), so watching needs one. */
export function hasOwner(ctx: Ctx, pr: PrRow): boolean {
  return ctx.store.linksOf(pr.id).some((l) => l.role === "owner" && !l.archived);
}

/** `backlog` sends what is on the PR now on the next check, instead of treating it as already seen. */
export function setWatch(ctx: Ctx, pr: PrRow, mode: WatchMode | null, options: { backlog?: boolean } = {}): void {
  if (mode !== null && !hasOwner(ctx, pr)) throw new ShuttleError(`${shortKey(ctx, pr)} has no agent to send reviews to; make a thread its agent first`);
  const before = ctx.store.watch(pr.id)?.mode ?? null;
  ctx.store.setWatch(pr.id, mode, options.backlog === true);
  if (before === mode) return;
  const agent = ctx.store.ownerLink(pr.id);
  const who = agent ? `\u201c${ctx.store.threadTitle(agent.thread_id) ?? agent.thread_id}\u201d` : "its agent";
  const text = mode === null ? `${who} no longer gets feedback on ${shortKey(ctx, pr)}.` : mode === "act" ? `${who} gets new feedback on ${shortKey(ctx, pr)} and is asked to fix it.` : `${who} gets new feedback on ${shortKey(ctx, pr)}, and is not asked to act.`;
  ctx.store.addEvent("watch", text, pr.id, agent?.thread_id ?? null);
  ctx.port.publish();
}

