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
  ctx.store.saveThread(thread.id, thread.title, thread.archived);
}

export async function linkPr(ctx: Ctx, pr: PrRow, threadId: string, role: LinkRole, options: { watch?: boolean } = {}): Promise<void> {
  await rememberThread(ctx, threadId);
  const before = ctx.store.linkRole(pr.id, threadId);
  ctx.store.link(pr.id, threadId, role);
  const watch = ctx.config().watch;
  const wantWatch = options.watch ?? (role === "owner" && pr.mine === 1 && watch.enabled && watch.autoWatch);
  if (wantWatch && ctx.store.watch(pr.id) === null) setWatch(ctx, pr, watch.mode);
  if (before !== role) ctx.store.addEvent("linked", `Linked ${shortKey(ctx, pr)} to \u201c${ctx.store.threadTitle(threadId)}\u201d as ${role === "owner" ? "its owner" : `a ${role} thread`}.`, pr.id, threadId);
  ctx.port.publish();
}

export function unlinkPr(ctx: Ctx, pr: PrRow, threadId: string): void {
  if (!ctx.store.unlink(pr.id, threadId)) throw new ShuttleError(`${shortKey(ctx, pr)} is not linked to that thread`);
  ctx.store.addEvent("unlinked", `Unlinked ${shortKey(ctx, pr)} from \u201c${ctx.store.threadTitle(threadId) ?? threadId}\u201d.`, pr.id, threadId);
  ctx.port.publish();
}

/** Watched activity goes only to owner threads, so watching needs one. */
export function hasOwner(ctx: Ctx, pr: PrRow): boolean {
  return ctx.store.linksOf(pr.id).some((l) => l.role === "owner" && !l.archived);
}

export function setWatch(ctx: Ctx, pr: PrRow, mode: WatchMode | null): void {
  if (mode !== null && !hasOwner(ctx, pr)) throw new ShuttleError(`${shortKey(ctx, pr)} has no owner thread to send reviews to; link it to a thread as owner first`);
  const before = ctx.store.watch(pr.id)?.mode ?? null;
  ctx.store.setWatch(pr.id, mode);
  if (before === mode) return;
  const text = mode === null ? `Stopped watching ${shortKey(ctx, pr)}.` : `Watching ${shortKey(ctx, pr)}: new reviews go to its owner threads${mode === "act" ? ", which are asked to act on them" : ""}.`;
  ctx.store.addEvent("watch", text, pr.id);
  ctx.port.publish();
}

