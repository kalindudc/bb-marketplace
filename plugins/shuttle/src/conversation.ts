// A PR's conversation as Shuttle shows it, and the writes on it: comments, replies, resolving
// threads and merging. Each write goes to the server as the user, then the PR is read back.
import type { MergeInput } from "./adapters/adapter";
import type { WriteOperation } from "./config";
import type { ConversationItem, MergeOptions, Outcome, PrDetails } from "./contract";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { readBack } from "./drafts";
import { lookup, requirePr, shortKey } from "./prs";
import { itemRef } from "./watch";
import { AdapterError } from "./adapters/adapter";
import { hunkLines } from "./model";

const FRESH_MS = 30_000;

export class Conversations {
  private readonly cache = new Map<string, { at: number; items: ConversationItem[]; details: PrDetails | null }>();

  constructor(private readonly ctx: Ctx) {}

  forget(key: string): void {
    this.cache.delete(key);
  }

  async read(key: string): Promise<{ items: ConversationItem[]; details: PrDetails | null; error: string | null; fetchedAt: number }> {
    const pr = requirePr(this.ctx, key);
    const cached = this.cache.get(key);
    if (cached && this.ctx.now() - cached.at < FRESH_MS) return { items: this.annotate(pr, cached.items), details: cached.details, error: null, fetchedAt: cached.at };
    try {
      const activity = await this.ctx.adapter(pr.server).activity(pr.repo, pr.number, undefined, { detail: true });
      const me = this.ctx.store.server(pr.server)?.login?.toLowerCase() ?? null;
      const items: ConversationItem[] = activity.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        author: item.author ?? null,
        bot: item.bot === true,
        mine: me !== null && item.author?.toLowerCase() === me,
        state: item.state ?? null,
        body: item.body ?? "",
        path: item.path ?? null,
        line: item.line ?? null,
        url: item.url ?? null,
        at: item.at,
        thread: item.thread ?? null,
        resolved: item.resolved === true,
        delivery: null,
        outcome: null,
        hunk: hunkLines(item.hunk),
        review: item.review ?? null,
      }));
      items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      const at = this.ctx.now();
      this.cache.set(key, { at, items, details: activity.details });
      return { items: this.annotate(pr, items), details: activity.details, error: null, fetchedAt: at };
    } catch (error) {
      return { items: [], details: null, error: `Could not read the conversation from ${this.ctx.server(pr.server)?.name ?? pr.server}: ${errText(error)}`, fetchedAt: this.ctx.now() };
    }
  }

  /** What the last read brought, however old, without asking the server; null before any read. */
  peek(key: string): { items: ConversationItem[]; details: PrDetails | null } | null {
    const pr = this.ctx.store.prByKey(key);
    const cached = this.cache.get(key);
    return pr && cached ? { items: this.annotate(pr, cached.items), details: cached.details } : null;
  }

  /** Delivery and outcomes change without the server, so they are added on every read. */
  private annotate(pr: PrRow, items: ConversationItem[]): ConversationItem[] {
    if (pr.mine !== 1) return items;
    const sent = this.ctx.store.sentItems(pr.id);
    const pending = this.ctx.store.pendingIds(pr.id);
    const outcomes = this.ctx.store.outcomes(pr.id);
    return items.map((item) => {
      const outcome = outcomes.get(item.id);
      return {
        ...item,
        delivery: sent.has(item.id) ? "sent" : pending.has(item.id) ? "pending" : null,
        outcome: outcome ? { outcome: outcome.outcome, note: outcome.note, commit: outcome.commit_sha, at: outcome.at } : null,
      };
    });
  }
}

function serverName(ctx: Ctx, pr: PrRow): string {
  return ctx.server(pr.server)?.name ?? pr.server;
}

async function write<T>(ctx: Ctx, pr: PrRow, operation: WriteOperation, fn: () => Promise<T>): Promise<T> {
  if (!ctx.adapter(pr.server).operations().includes(operation)) throw new ShuttleError(`${serverName(ctx, pr)} has no ${operation} command, so Shuttle can't do that there`);
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AdapterError) throw new ShuttleError(`${serverName(ctx, pr)} refused: ${error.message}`);
    throw error;
  }
}

export async function comment(ctx: Ctx, key: string, body: string): Promise<PrRow> {
  const pr = requirePr(ctx, key);
  await write(ctx, pr, "comment", () => ctx.adapter(pr.server).comment(pr.repo, pr.number, body));
  ctx.store.addEvent("commented", `You commented on ${shortKey(ctx, pr)}.`, pr.id);
  await readBack(ctx, pr);
  ctx.port.publish();
  return ctx.store.prById(pr.id)!;
}

export async function reply(ctx: Ctx, key: string, thread: string, body: string): Promise<void> {
  const pr = requirePr(ctx, key);
  await write(ctx, pr, "reply", () => ctx.adapter(pr.server).reply(pr.repo, pr.number, thread, body));
  ctx.store.addEvent("replied", `You replied in a review thread on ${shortKey(ctx, pr)}.`, pr.id);
  ctx.port.publish();
}

export async function resolve(ctx: Ctx, key: string, thread: string, resolved: boolean): Promise<void> {
  const pr = requirePr(ctx, key);
  await write(ctx, pr, "resolve", () => ctx.adapter(pr.server).resolve(pr.repo, pr.number, thread, resolved));
  ctx.store.addEvent("resolved", `You ${resolved ? "resolved" : "reopened"} a review thread on ${shortKey(ctx, pr)}.`, pr.id);
  ctx.port.publish();
}

export async function mergeOptions(ctx: Ctx, key: string): Promise<MergeOptions> {
  const pr = requirePr(ctx, key);
  if (pr.mine !== 1) throw new ShuttleError(`${shortKey(ctx, pr)} is not one of your PRs`);
  try {
    return await ctx.adapter(pr.server).mergeOptions(pr.repo, pr.number);
  } catch (error) {
    throw new ShuttleError(`${serverName(ctx, pr)} could not say how ${shortKey(ctx, pr)} can merge: ${errText(error)}`);
  }
}

export async function merge(ctx: Ctx, key: string, input: MergeInput): Promise<{ pr: PrRow; merged: boolean }> {
  const pr = requirePr(ctx, key);
  if (pr.mine !== 1) throw new ShuttleError(`${shortKey(ctx, pr)} is not one of your PRs; Shuttle only merges your own`);
  if (pr.state !== "open") throw new ShuttleError(`${shortKey(ctx, pr)} is ${pr.state}, so it can't merge`);
  const { merged } = await write(ctx, pr, "merge", () => ctx.adapter(pr.server).merge(pr.repo, pr.number, input));
  if (merged) {
    ctx.store.patchPr(pr.id, { state: "merged", closed_at: ctx.now(), updated_at: ctx.now() });
    ctx.store.addEvent("merged", `You merged ${shortKey(ctx, pr)} (${input.method}${input.deleteBranch ? ", branch deleted" : ""}).`, pr.id);
  } else {
    ctx.store.patchPr(pr.id, { auto_merge: 1 });
    ctx.store.addEvent("auto_merge", `Auto-merge is on for ${shortKey(ctx, pr)}: it merges (${input.method}) when its checks pass.`, pr.id);
  }
  await readBack(ctx, pr);
  ctx.port.publish();
  return { pr: ctx.store.prById(pr.id)!, merged };
}

export async function cancelAutoMerge(ctx: Ctx, key: string): Promise<PrRow> {
  const pr = requirePr(ctx, key);
  const adapter = ctx.adapter(pr.server);
  if (!adapter.cancelAutoMerge) throw new ShuttleError(`${serverName(ctx, pr)} has no auto-merge`);
  await write(ctx, pr, "merge", () => adapter.cancelAutoMerge!(pr.repo, pr.number));
  ctx.store.patchPr(pr.id, { auto_merge: 0 });
  ctx.store.addEvent("auto_merge", `Auto-merge is off for ${shortKey(ctx, pr)}.`, pr.id);
  await readBack(ctx, pr);
  ctx.port.publish();
  return ctx.store.prById(pr.id)!;
}

const OUTCOME_WORDS: Record<Outcome, string> = { fixed: "fixed", replied: "replied to", declined: "declined", question: "asked about" };

/** Called by an agent's shuttle_feedback_done tool, with the refs from the messages Shuttle sent it. */
export async function recordOutcomes(
  ctx: Ctx,
  threadId: string,
  query: string,
  items: Array<{ ref: string; outcome: Outcome; note?: string; commit?: string }>,
): Promise<{ pr: PrRow; recorded: number; unknown: string[] }> {
  const pr = await lookup(ctx, query);
  const ids = new Set([...ctx.store.sentItems(pr.id).keys(), ...ctx.store.pendingIds(pr.id), ...ctx.store.seenIds(pr.id)]);
  const byRef = new Map([...ids].map((id) => [itemRef(id), id]));
  const unknown: string[] = [];
  const counts = new Map<Outcome, number>();
  for (const item of items) {
    const id = byRef.get(item.ref.trim().toLowerCase());
    if (!id) {
      unknown.push(item.ref);
      continue;
    }
    ctx.store.setOutcome({ pr_id: pr.id, item_id: id, outcome: item.outcome, note: item.note?.slice(0, 2000) ?? null, commit_sha: item.commit?.slice(0, 64) ?? null, thread_id: threadId });
    counts.set(item.outcome, (counts.get(item.outcome) ?? 0) + 1);
  }
  const recorded = [...counts.values()].reduce((a, b) => a + b, 0);
  if (recorded) {
    const what = [...counts].map(([outcome, n]) => `${OUTCOME_WORDS[outcome]} ${n}`).join(", ");
    ctx.store.addEvent("outcome", `\u201c${ctx.store.threadTitle(threadId) ?? threadId}\u201d reported on the feedback on ${shortKey(ctx, pr)}: ${what}.`, pr.id, threadId);
    ctx.port.publish();
  }
  return { pr, recorded, unknown };
}
