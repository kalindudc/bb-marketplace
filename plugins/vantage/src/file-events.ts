import { classifyEventTypes, ITEM_COMPLETED } from "./event-types";
import type { EventsSdk } from "./edits";

// Items that only talk, think or read. A command, a file change, a tool call or a delegation may write, and so may an item type
// that does not exist yet, so anything not listed here counts as a change.
const HARMLESS_ITEMS = new Set([
  "userMessage", "agentMessage", "reasoning", "plan", "planSteps", "webSearch", "webFetch", "imageView", "fileRead", "search",
  "contextCompaction",
]);
const PAGE_SIZE = 100;
const READ_TIMEOUT_MS = 5000;
const MAX_CURSORS = 500;

export interface FileEventGate {
  /** Decides whether the event may have changed the thread's files and, if so, invalidates. Items are read only for a thread something is cached for. */
  handle(threadId: string, changes: readonly string[], eventTypes: readonly string[] | undefined): void;
  /** Settles when every thread among `threadIds` with an undecided event has been decided; null when none has. */
  pending(threadIds: readonly string[]): Promise<void> | null;
}

interface Reads {
  running: Promise<void>;
  // Events that came in while `running` was reading are covered by this read, which starts when it ends.
  queued: Promise<void> | null;
}

interface Finding { changed: boolean; cursor: number }

export function createFileEventGate(
  sdk: EventsSdk,
  options: { invalidate(threadId: string): void; hasThread(threadId: string): boolean; timeoutMs?: number; maxCursors?: number },
): FileEventGate {
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const maxCursors = options.maxCursors ?? MAX_CURSORS;
  // The last completed item seen for each thread, least recently read first; items after it have not been looked at. A thread
  // that lost its cursor is read from scratch, which counts as a change.
  const cursors = new Map<string, number>();
  const reads = new Map<string, Reads>();
  // A read may commit its cursor or invalidate only while its token is the thread's current one. A timeout, a failure or a history
  // reset takes the token away, so a response that arrives later cannot move the cursor.
  const tokens = new Map<string, number>();
  const aborts = new Map<string, AbortController>();
  let issued = 0;

  function remember(threadId: string, cursor: number): void {
    cursors.delete(threadId);
    cursors.set(threadId, cursor);
    while (cursors.size > maxCursors) cursors.delete(cursors.keys().next().value!);
  }

  function forget(threadId: string): void {
    cursors.delete(threadId);
    tokens.delete(threadId);
    aborts.get(threadId)?.abort();
  }

  async function findItems(threadId: string, signal: AbortSignal): Promise<Finding> {
    const after = cursors.get(threadId);
    if (after === undefined) {
      const latest = await sdk.threads.events.list({ threadId, types: [ITEM_COMPLETED], order: "desc", limit: "1", signal });
      return { changed: true, cursor: latest[0]?.seq ?? 0 };
    }
    const rows = await sdk.threads.events.list({
      threadId, types: [ITEM_COMPLETED], order: "asc", limit: String(PAGE_SIZE), afterSeq: String(after), signal,
    });
    return {
      changed: rows.length >= PAGE_SIZE || rows.some((row) => row.type !== ITEM_COMPLETED || !HARMLESS_ITEMS.has(row.data.item.type)),
      cursor: rows.at(-1)?.seq ?? after,
    };
  }

  // A read that fails or hangs cannot vouch for the thread, so it counts as a change.
  async function read(threadId: string): Promise<void> {
    const token = ++issued;
    const controller = new AbortController();
    tokens.set(threadId, token);
    aborts.set(threadId, controller);
    const current = () => tokens.get(threadId) === token;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeoutMs); });
      const found = await Promise.race([findItems(threadId, controller.signal), timeout]);
      if (!current()) return;
      remember(threadId, found.cursor);
      if (found.changed) options.invalidate(threadId);
    } catch {
      if (!current()) return;
      forget(threadId);
      options.invalidate(threadId);
    } finally {
      clearTimeout(timer);
      if (tokens.get(threadId) === token) tokens.delete(threadId);
      if (aborts.get(threadId) === controller) aborts.delete(threadId);
    }
  }

  function watch(threadId: string, entry: Reads): void {
    void entry.running.then(() => {
      if (entry.queued === null) {
        reads.delete(threadId);
        return;
      }
      entry.running = entry.queued;
      entry.queued = null;
      watch(threadId, entry);
    });
  }

  function schedule(threadId: string): void {
    const known = reads.get(threadId);
    if (known === undefined) {
      const entry: Reads = { running: read(threadId), queued: null };
      reads.set(threadId, entry);
      watch(threadId, entry);
    } else {
      known.queued ??= known.running.then(() => read(threadId));
    }
  }

  return {
    handle(threadId, changes, eventTypes) {
      if (changes.includes("history-rewritten") || changes.includes("history-compacted")) {
        forget(threadId);
        return options.invalidate(threadId);
      }
      const verdict = classifyEventTypes(eventTypes);
      if (verdict === "unchanged") return;
      if (verdict === "changed") return options.invalidate(threadId);
      if (options.hasThread(threadId)) schedule(threadId);
    },
    pending(threadIds) {
      const waiting: Promise<void>[] = [];
      for (const id of threadIds) {
        const entry = reads.get(id);
        if (entry !== undefined) waiting.push(entry.queued ?? entry.running);
      }
      return waiting.length === 0 ? null : Promise.all(waiting).then(() => undefined);
    },
  };
}
