import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { countDiffLines } from "./git";

export type EventsSdk = { threads: { events: Pick<PluginBbSdk["threads"]["events"], "list"> } };
type EventRow = Awaited<ReturnType<PluginBbSdk["threads"]["events"]["list"]>>[number];

// bb 0.46.1 rejects a limit above 100 with HTTP 400 "Thread event limit cannot exceed 100".
const PAGE_SIZE = 100;
const DIFF_LIMIT = 60_000;
const DEFAULT_MAX_THREADS = 300;
const DEFAULT_MAX_RECORDS = 5000;

export interface EditRecord {
  threadId: string;
  path: string;
  movePath: string | null;
  kind: "add" | "delete" | "update";
  added: number;
  removed: number;
  at: number;
}

export interface ThreadEdits { records: readonly EditRecord[]; primaryCwd: string | null }

export interface RecordedEdit { threadId: string; at: number; kind: EditRecord["kind"]; diff: string | null; truncated: boolean }

function completedChanges(row: EventRow) {
  if (row.type !== "item/completed" || row.data.item.type !== "fileChange") return [];
  const { item } = row.data;
  return item.status === "completed" && item.approvalStatus !== "denied" ? item.changes : [];
}

export function editsFromRows(threadId: string, rows: readonly EventRow[]): { records: EditRecord[]; primaryCwd: string | null; lastSeq: number | null } {
  const records: EditRecord[] = [];
  let primaryCwd: string | null = null;
  for (const row of rows) {
    if (primaryCwd === null && row.type === "item/completed" && row.data.item.type === "commandExecution") {
      primaryCwd = row.data.item.cwd;
    }
    for (const change of completedChanges(row)) {
      const { added, removed } = countDiffLines(change.diff);
      records.push({ threadId, path: change.path, movePath: change.movePath ?? null, kind: change.kind, added, removed, at: row.createdAt });
    }
  }
  return { records, primaryCwd, lastSeq: rows.at(-1)?.seq ?? null };
}

async function* pages(sdk: EventsSdk, threadId: string, afterSeq: number | null, signal?: AbortSignal): AsyncGenerator<readonly EventRow[]> {
  let cursor = afterSeq;
  for (;;) {
    const rows = await sdk.threads.events.list({
      threadId, types: ["item/completed"], limit: String(PAGE_SIZE), order: "asc", signal,
      ...(cursor === null ? {} : { afterSeq: String(cursor) }),
    });
    if (rows.length > 0) yield rows;
    if (rows.length < PAGE_SIZE) return;
    cursor = rows[rows.length - 1]!.seq;
  }
}

export interface EditIndex {
  /** `settled` means no event can still arrive for the thread (it is archived), so an indexed thread is not read again. */
  get(threadId: string, signal?: AbortSignal, options?: { settled?: boolean }): Promise<ThreadEdits>;
  forget(threadIds: readonly string[]): void;
}

interface Entry { lastSeq: number | null; edits: ThreadEdits }

export function createEditIndex(sdk: EventsSdk, options: { maxThreads?: number; maxRecords?: number } = {}): EditIndex {
  const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<ThreadEdits>>();

  async function read(threadId: string, signal?: AbortSignal): Promise<ThreadEdits> {
    const known = entries.get(threadId);
    let lastSeq = known?.lastSeq ?? null;
    let primaryCwd = known?.edits.primaryCwd ?? null;
    let added: EditRecord[] = [];
    for await (const rows of pages(sdk, threadId, lastSeq, signal)) {
      const parsed = editsFromRows(threadId, rows);
      added = added.concat(parsed.records);
      primaryCwd ??= parsed.primaryCwd;
      lastSeq = parsed.lastSeq;
    }
    const changed = known === undefined || added.length > 0 || primaryCwd !== known.edits.primaryCwd;
    const edits = changed ? { records: [...(known?.edits.records ?? []), ...added].slice(-maxRecords), primaryCwd } : known.edits;
    entries.delete(threadId);
    entries.set(threadId, { lastSeq, edits });
    while (entries.size > maxThreads) entries.delete(entries.keys().next().value!);
    return edits;
  }

  return {
    get(threadId, signal, options) {
      const known = options?.settled === true ? entries.get(threadId) : undefined;
      if (known !== undefined) return Promise.resolve(known.edits);
      let pending = inflight.get(threadId);
      if (pending === undefined) {
        pending = read(threadId, signal).finally(() => inflight.delete(threadId));
        inflight.set(threadId, pending);
      }
      return pending;
    },
    forget(threadIds) {
      for (const threadId of threadIds) entries.delete(threadId);
    },
  };
}

export async function findRecordedEdits(sdk: EventsSdk, threadIds: readonly string[], rawPaths: ReadonlySet<string>, limit: number): Promise<RecordedEdit[]> {
  const found: RecordedEdit[] = [];
  for (const threadId of threadIds) {
    for await (const rows of pages(sdk, threadId, null)) {
      for (const row of rows) {
        for (const change of completedChanges(row)) {
          if (!rawPaths.has(change.path) && !(change.movePath !== undefined && rawPaths.has(change.movePath))) continue;
          const diff = change.diff ?? null;
          found.push({
            threadId, at: row.createdAt, kind: change.kind,
            diff: diff === null ? null : diff.slice(0, DIFF_LIMIT), truncated: diff !== null && diff.length > DIFF_LIMIT,
          });
        }
      }
    }
  }
  return found.sort((a, b) => a.at - b.at).slice(0, limit);
}
