// Finding PRs and linking them to threads. A thread can own several PRs, and a PR can be linked
// to several threads.
import type { WatchMode } from "./config";
import type { LinkRole } from "./contract";
import { NotFoundError, ShuttleError, type Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { displayKey, linkFor, parseKey, resolveQuery, type PrRef } from "./keys";

/** A stored PR, or fetched from its server and stored when Shuttle has not seen it yet. */
export async function lookup(ctx: Ctx, query: string, refresh = false): Promise<PrRow> {
  const ref = resolveQuery(query, ctx.config().servers);
  const known = ctx.store.prByRef(ref);
  if (known && !refresh) return known;
  return fetchPr(ctx, ref);
}

export async function fetchPr(ctx: Ctx, ref: PrRef): Promise<PrRow> {
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
  return pr;
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

