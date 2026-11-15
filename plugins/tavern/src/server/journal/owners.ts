import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { JournalStore } from "./store";

type EventRow = { seq: number; createdAt: number; type?: string; data: unknown };
const LINE = 160;

/** The first line of an agent's message as plain text: what it said, without Markdown marks. */
export function firstLine(text: string): string | null {
  const line = text.split("\n").map(l => l.replace(/^#+\s*/, "").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim()).find(Boolean);
  if (!line) return null;
  return line.length > LINE ? `${line.slice(0, LINE - 1)}…` : line;
}

/**
 * Delegated entries follow their owner threads. Going idle is not a settle: delegates idle after every turn, acknowledgements
 * and questions included. So the entry keeps its status and gets a mark that says what is true, with the first line of the output.
 */
export function watchOwners(bb: BbPluginApi, store: JournalStore): void {
  const warn = (threadId: string, error: unknown) => bb.log.warn(`Journal owner check for ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
  async function lastSaid(threadId: string): Promise<string | null> {
    const rows: EventRow[] = await bb.sdk.threads.events.list({ threadId, types: ["item/completed"], order: "desc", limit: "50" });
    for (const row of rows) {
      const item = (row.data as { item?: { type?: string; text?: unknown } } | null)?.item;
      if (item?.type === "agentMessage" && typeof item.text === "string") return firstLine(item.text);
    }
    return null;
  }
  bb.events.on("thread.idle", async ({ thread }) => {
    try {
      if (!store.isOwner(thread.id)) return;
      await store.learnOwner(thread.id);
      await store.markOwner(thread.id, "idle", await lastSaid(thread.id));
    } catch (error) { warn(thread.id, error); }
  });
  for (const kind of ["archived", "deleted"] as const) bb.events.on(`thread.${kind}`, async ({ thread }) => {
    try { if (store.isOwner(thread.id)) await store.markOwner(thread.id, kind, null); } catch (error) { warn(thread.id, error); }
  });
}
