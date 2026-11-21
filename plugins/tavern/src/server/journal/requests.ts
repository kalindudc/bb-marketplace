import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { JournalStore } from "./store";
import { closed } from "./engine";
import { JOURNAL_NOTE_PREFIX } from "../../shared/text";

export const STEER_PROVIDERS = new Set(["pi", "claude-code", "codex"]);
type EventRow = { seq: number; createdAt: number; type?: string; data: unknown };
type EmptyHint = { completed: Set<string>; userSteerSeq: number };
type Watched = { previousRequestAt: number | null; lastSeq: number; running: Set<string>; hint: EmptyHint | null; checking: boolean; again: boolean };
const EMPTY_HINT_AFTER = 15;
const workItems = new Set(["commandExecution", "fileChange", "fileRead", "imageView", "toolCall", "webSearch"]);
const requestSchema = z.object({ initiator: z.string(), originPluginId: z.string().nullish(), senderThreadId: z.string().nullish(), retryOfRequestId: z.string().nullish(), input: z.array(z.unknown()) });
/** Any message that reached the agent: the user, another agent, bb's system notes, a wake-up. Not retries, not agent-only plugin context. */
export function isInboundRequest(row: EventRow): boolean {
  const r = requestSchema.partial({ initiator: true }).safeParse(row.data);
  return r.success && r.data.retryOfRequestId == null && r.data.input.some(p => {
    const text = textPart.safeParse(p); return text.success && text.data.visibility !== "agent-only";
  });
}
export const isJournalTool = (name: string) => /(?:^|\.|__)journal$/.test(name);
const isLegacyQuestTool = (name: string) => /(?:^|\.|__)quest$/.test(name);
function callsJournal(tool: string, args: unknown): boolean {
  if (isJournalTool(tool)) return true;
  if (!/(?:^|\.|__)codemode$/.test(tool)) return false;
  const code = typeof args === "string" ? args : codemodeArgs.safeParse(args).data?.code;
  return typeof code === "string" && /\btools\s*(?:\.\s*journal|\[\s*["']journal["']\s*\])\s*\(/.test(code);
}
const codemodeArgs = z.object({ code: z.string() });
const textPart = z.object({ type: z.literal("text"), text: z.string(), visibility: z.string().optional() });
const itemSchema = z.object({ item: z.object({ type: z.string(), id: z.string().nullish(), tool: z.string().nullish(), arguments: z.unknown().optional() }) });
const steerRequestSchema = z.object({ requestId: z.string(), target: z.object({ kind: z.enum(["steer", "auto"]), expectedTurnId: z.string() }) });
const acceptedInputSchema = z.object({ clientRequestId: z.string() });
export function isUserRequest(row: EventRow): boolean {
  const r = requestSchema.safeParse(row.data);
  return r.success && r.data.initiator === "user" && r.data.originPluginId == null && r.data.senderThreadId == null && r.data.retryOfRequestId == null && r.data.input.some(p => {
    const text = textPart.safeParse(p); return text.success && text.data.visibility !== "agent-only";
  });
}
function latestHumanSteer(rows: EventRow[]): number {
  const requests = new Set<string>();
  for (const row of rows) {
    if (row.type !== "client/turn/requested" || !isUserRequest(row)) continue;
    const steer = steerRequestSchema.safeParse(row.data);
    if (steer.success) requests.add(steer.data.requestId);
  }
  for (const row of rows) {
    if (row.type !== "turn/input/accepted") continue;
    const accepted = acceptedInputSchema.safeParse(row.data);
    if (accepted.success && requests.has(accepted.data.clientRequestId)) return row.seq;
  }
  return 0;
}
export function dispatchCheck(context: MessageDispatchHookContext, pluginId = "tavern"): string | null {
  try {
    const note = (b: { type: string; visibility?: string; text?: string }) => b.type === "text" && b.visibility === "agent-only" && (b.text?.startsWith(JOURNAL_NOTE_PREFIX) || b.text?.startsWith("[Quests]"));
    const owned = context.queuedMessages?.length ? context.queuedMessages.every(row => row.originPluginId === pluginId && row.content.length > 0 && row.content.every(note)) : context.originPluginId === pluginId;
    if (context.attempt === "start-turn" && owned && context.input.blocks.length > 0 && context.input.blocks.every(note)) {
      return "A journal note only joins a running turn.";
    }
  } catch {
    // Like pi-quests, malformed input must never make this global dispatch checkpoint throw.
  }
  return null;
}
class TurnEnded extends Error {}
export function watchRequests(bb: BbPluginApi, store: JournalStore): void {
  const watched = new Map<string, Watched>();
  const generations = new Map<string, number>();
  const activityReads = new Set<string>();
  let nextGeneration = 0;
  let disposed = false;
  const boundary = (threadId: string) => {
    const generation = ++nextGeneration;
    generations.set(threadId, generation); watched.delete(threadId); return generation;
  };
  const warn = (threadId: string, error: unknown) => bb.log.warn(`Journal note for ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
  // Why a reminder did not go out, so a quiet journal can be explained from the logs. Only threads with open entries log.
  const skipped = (threadId: string, reason: string) => { if (store.hasOpenEntries(threadId)) bb.log.info(`Journal reminder skipped for ${threadId}: ${reason}.`); };
  async function scan(threadId: string, entry: Watched): Promise<"drop" | "send" | "wait"> {
    for (let page = 0; page < 10; page++) {
      const rows: EventRow[] = await bb.sdk.threads.events.list({ threadId, types: ["item/started", "item/completed"], afterSeq: String(entry.lastSeq), order: "asc", limit: "100" });
      for (const row of rows) {
        entry.lastSeq = Math.max(entry.lastSeq, row.seq);
        const parsed = itemSchema.safeParse(row.data);
        if (!parsed.success || !workItems.has(parsed.data.item.type)) continue;
        const { id, tool, arguments: args } = parsed.data.item;
        if (tool && (callsJournal(tool, args) || (!entry.hint && row.type === "item/started" && isLegacyQuestTool(tool)))) return "drop";
        if (!id) continue;
        if (row.type === "item/started") entry.running.add(id);
        else {
          entry.running.delete(id);
          if (entry.hint && entry.hint.completed.size < EMPTY_HINT_AFTER) entry.hint.completed.add(id);
        }
      }
      if (rows.length < 100) return entry.running.size && (!entry.hint || entry.hint.completed.size >= EMPTY_HINT_AFTER) ? "send" : "wait";
    }
    // Do not mistake an old start for a still-running tool when its completion is on the next page.
    return "wait";
  }
  async function check(threadId: string): Promise<void> {
    const entry = watched.get(threadId);
    if (!entry || disposed) return;
    if (entry.checking) { entry.again = true; return; }
    entry.checking = true;
    try {
      do {
        if (store.isKeeper(threadId)) { watched.delete(threadId); skipped(threadId, "a Keeper thread gets no journal steers"); return; }
        entry.again = false;
        const decision = await scan(threadId, entry);
        if (disposed || watched.get(threadId) !== entry) return;
        if (decision === "wait") continue;
        watched.delete(threadId);
        if (decision === "drop") { skipped(threadId, "the agent called the journal first in this turn"); return; }
        const generation = generations.get(threadId);
        const send = async (text: string) => {
          const thread = await bb.sdk.threads.get({ threadId });
          if (disposed || store.isKeeper(threadId) || generations.get(threadId) !== generation || thread.status !== "active") throw new TurnEnded();
          await bb.sdk.threads.send({ threadId, mode: "steer", input: [{ type: "text", text, mentions: [], visibility: "agent-only" }] });
        };
        if (entry.hint) await store.deliverEmptyHint(threadId, entry.lastSeq, entry.hint.userSteerSeq, send);
        else await store.deliverNote(threadId, entry.previousRequestAt, send, reason => skipped(threadId, reason));
        return;
      } while (entry.again);
    } catch (error) { if (error instanceof TurnEnded) skipped(threadId, "the turn ended before the note could join it"); else warn(threadId, error); }
    finally { entry.checking = false; }
  }
  bb.events.on("thread.active", async ({ thread }) => {
    const generation = boundary(thread.id);
    if (!STEER_PROVIDERS.has(thread.providerId)) { skipped(thread.id, `provider ${thread.providerId} can't be steered into a running turn`); return; }
    try {
      if (store.isKeeper(thread.id)) { skipped(thread.id, "a Keeper thread gets no journal steers"); return; }
      await store.ready(thread.id, false);
      if (store.isKeeper(thread.id)) { skipped(thread.id, "a Keeper thread gets no journal steers"); return; }
      const journal = store.get(thread.id);
      if (journal.toolOwnedElsewhere) { skipped(thread.id, "another plugin keeps this thread's checklist"); return; }
      const reminders = store.reminders();
      const regular = (reminders && journal.entries.some(e => !closed(e))) || store.pending(thread.id).length > 0;
      const empty = reminders && !regular && journal.entries.length === 0;
      if (!regular && !empty) { skipped(thread.id, "reminders are off in Tavern's settings, and no user edits are waiting"); return; }
      const lastHintSeq = empty ? store.emptyHintSeq(thread.id) : null;
      const rows: EventRow[] = await bb.sdk.threads.events.list({
        threadId: thread.id, order: "desc",
        ...(lastHintSeq === null ? { types: ["client/turn/requested"], limit: "20" } : { types: ["client/turn/requested", "turn/input/accepted"], limit: "40" }),
      });
      const [latest, ...earlier] = rows.filter(row => row.type === "client/turn/requested");
      if (disposed || generations.get(thread.id) !== generation) { skipped(thread.id, "the turn ended before the check finished"); return; }
      if (!latest || !isInboundRequest(latest)) { skipped(thread.id, "this turn was started by a retry or by agent-only plugin context, not a message"); return; }
      const userSteerSeq = lastHintSeq === null ? 0 : latestHumanSteer(rows);
      if (lastHintSeq !== null && userSteerSeq <= lastHintSeq) return;
      watched.set(thread.id, { previousRequestAt: earlier.find(isInboundRequest)?.createdAt ?? null, lastSeq: latest.seq, running: new Set(),
        hint: empty ? { completed: new Set(), userSteerSeq } : null, checking: false, again: false });
      await check(thread.id);
    } catch (error) { warn(thread.id, error); }
  });
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    await check(thread.id);
    if (disposed || activityReads.has(thread.id)) return;
    activityReads.add(thread.id);
    try {
      if (!store.tracksWork(thread.id)) return;
      const rows: EventRow[] = await bb.sdk.threads.events.list({ threadId: thread.id, types: ["item/started", "item/completed"], order: "desc", limit: "20" });
      if (disposed) return;
      for (const row of rows) {
        const item = itemSchema.safeParse(row.data);
        if (item.success && workItems.has(item.data.item.type)) store.touchWork(thread.id, row.createdAt);
      }
    } catch (error) { warn(thread.id, error); }
    finally { activityReads.delete(thread.id); }
  });
  const ended = ({ thread }: { thread: { id: string } }) => {
    if (watched.has(thread.id)) skipped(thread.id, "the turn ended before a tool call was running to join");
    boundary(thread.id);
  };
  bb.events.on("thread.idle", ended);
  bb.events.on("thread.failed", ended);
  const forget = ({ thread }: { thread: { id: string } }) => {
    watched.delete(thread.id); generations.delete(thread.id);
  };
  bb.events.on("thread.archived", forget);
  bb.events.on("thread.deleted", ({ thread }) => {
    forget({ thread });
    try { store.deleteThread(thread.id); } catch (error) { bb.log.warn(`Deleting the journal of ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`); }
  });
  bb.onDispose(() => { disposed = true; watched.clear(); generations.clear(); activityReads.clear(); });
}
