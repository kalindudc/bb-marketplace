import { posix } from "node:path";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { countDiffLines } from "./git";

export type EventsSdk = { threads: { events: Pick<PluginBbSdk["threads"]["events"], "list"> } };
type EventRow = Awaited<ReturnType<PluginBbSdk["threads"]["events"]["list"]>>[number];
type EventTypes = NonNullable<Parameters<PluginBbSdk["threads"]["events"]["list"]>[0]["types"]>;

// bb 0.46.1 rejects a limit above 100 with HTTP 400 "Thread event limit cannot exceed 100".
const PAGE_SIZE = 100;
const CATCH_UP_PAGE_LIMIT = 4;
const ARCHIVE_RETRY_MS = 5000;
const DIFF_LIMIT = 60_000;
const DEFAULT_MAX_THREADS = 300;
const DEFAULT_MAX_RECORDS = 5000;
export const MAX_WORK_DIRS = 32;
export const MAX_COMMIT_RUNS = 200;
const EDIT_TYPES: EventTypes = ["item/started", "item/completed"];
const COMPLETED_TYPES: EventTypes = ["item/completed"];
// `cd <dir>`, `pushd <dir>` or `git -C <dir>` anywhere in a command line, the folder a bare word or one quoted string.
const WORK_DIR = /(?:^|[\s;&|(){}'"`])(?:(?:cd|pushd)\s+(?:--\s+)?|git\s+-C\s+)("[^"]*"|'[^']*'|[^\s;&|()<>'"`]+)/g;
// `git commit`, with any of git's own options before the subcommand, such as `-C <dir>` or `-c name=value`.
const GIT_COMMIT =
  /(?:^|[\s;&|(){}'"`/])git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|[^\s;&|()<>'"`]+)|--?[A-Za-z][\w-]*(?:=[^\s;&|()<>]+)?))*\s+commit(?=$|[\s;&|()'"`])/;

export interface EditRecord {
  threadId: string;
  path: string;
  movePath: string | null;
  kind: "add" | "delete" | "update";
  added: number;
  removed: number;
  at: number;
}

/** When a `git commit` command started and, once it has, finished. */
export interface CommitRun {
  id: string;
  startedAt: number;
  endedAt: number | null;
}

/**
 * `workDirs`: absolute or `~/` folders the thread's commands changed into, least recently used first.
 * `commitRuns`: its `git commit` commands, oldest first. `lastEventAt`: while one of them has not finished, the time of the
 * last event read, which is as long as a stopped thread's command can have run; null otherwise.
 */
export interface ThreadEdits {
  records: readonly EditRecord[];
  primaryCwd: string | null;
  workDirs: readonly string[];
  commitRuns: readonly CommitRun[];
  lastEventAt: number | null;
  eventsIncomplete?: true;
  archiveIncomplete?: true;
}
type RunState = Pick<ThreadEdits, "commitRuns" | "lastEventAt">;
const NO_RUNS: RunState = { commitRuns: [], lastEventAt: null };

export interface RecordedEdit {
  threadId: string;
  at: number;
  kind: EditRecord["kind"];
  diff: string | null;
  truncated: boolean;
}

function completedChanges(row: EventRow) {
  if (row.type !== "item/completed" || row.data.item.type !== "fileChange") return [];
  const { item } = row.data;
  return item.status === "completed" && item.approvalStatus !== "denied" ? item.changes : [];
}

export function isCommitCommand(command: string): boolean {
  return GIT_COMMIT.test(command);
}

function commandOf(row: EventRow): { id: string; command: string } | null {
  if (row.type !== "item/started" && row.type !== "item/completed") return null;
  const { item } = row.data;
  return item.type === "commandExecution" ? { id: item.id, command: item.command } : null;
}

// A command with no start event (a provider that sends none) is taken to start at the event before it.
function trackRuns(rows: readonly EventRow[], known: RunState): RunState {
  let runs: CommitRun[] | null = null;
  let lastEventAt = known.lastEventAt;
  for (const row of rows) {
    const command = commandOf(row);
    if (command !== null && isCommitCommand(command.command)) {
      runs ??= [...known.commitRuns];
      let open = runs.length - 1;
      while (open >= 0 && !(runs[open]!.id === command.id && runs[open]!.endedAt === null)) open--;
      if (row.type === "item/started") runs.push({ id: command.id, startedAt: row.createdAt, endedAt: null });
      else if (open !== -1) runs[open] = { ...runs[open]!, endedAt: row.createdAt };
      else runs.push({ id: command.id, startedAt: lastEventAt ?? row.createdAt, endedAt: row.createdAt });
    }
    lastEventAt = row.createdAt;
  }
  return { commitRuns: runs === null ? known.commitRuns : runs.slice(-MAX_COMMIT_RUNS), lastEventAt };
}

// Only folders a later step can resolve on the thread's machine: absolute or under `~`, with no variable or glob.
export function workDirsOf(command: string): string[] {
  const dirs: string[] = [];
  for (const match of command.matchAll(WORK_DIR)) {
    const token = match[1]!;
    const path = token.startsWith('"') || token.startsWith("'") ? token.slice(1, -1) : token;
    if (!(path.startsWith("/") || path.startsWith("~/")) || /[$`*?\\]/.test(path)) continue;
    const dir = posix.normalize(path).replace(/\/+$/, "");
    if (dir !== "" && dir !== "~") dirs.push(dir);
  }
  return dirs;
}

function mergeWorkDirs(known: readonly string[], added: readonly string[]): readonly string[] {
  if (added.length === 0) return known;
  const order = new Set(known);
  for (const dir of added) {
    order.delete(dir);
    order.add(dir);
  }
  const merged = [...order].slice(-MAX_WORK_DIRS);
  return merged.length === known.length && merged.every((dir, index) => dir === known[index]) ? known : merged;
}

export function editsFromRows(
  threadId: string,
  rows: readonly EventRow[],
  known: RunState = NO_RUNS,
): {
  records: EditRecord[];
  primaryCwd: string | null;
  workDirs: readonly string[];
  commitRuns: readonly CommitRun[];
  lastEventAt: number | null;
  lastSeq: number | null;
} {
  const records: EditRecord[] = [];
  let primaryCwd: string | null = null;
  const commandDirs: string[] = [];
  for (const row of rows) {
    if (row.type === "item/completed" && row.data.item.type === "commandExecution") {
      primaryCwd ??= row.data.item.cwd;
      commandDirs.push(...workDirsOf(row.data.item.command));
    }
    for (const change of completedChanges(row)) {
      const { added, removed } = countDiffLines(change.diff);
      records.push({
        threadId,
        path: change.path,
        movePath: change.movePath ?? null,
        kind: change.kind,
        added,
        removed,
        at: row.createdAt,
      });
    }
  }
  return {
    records,
    primaryCwd,
    workDirs: mergeWorkDirs([], commandDirs),
    ...trackRuns(rows, known),
    lastSeq: rows.at(-1)?.seq ?? null,
  };
}

async function* pages(
  sdk: EventsSdk,
  threadId: string,
  afterSeq: number | null,
  types: EventTypes,
  signal?: AbortSignal,
  onPageRead?: () => void,
): AsyncGenerator<readonly EventRow[]> {
  let cursor = afterSeq;
  for (;;) {
    onPageRead?.();
    const rows = await sdk.threads.events.list({
      threadId,
      types,
      limit: String(PAGE_SIZE),
      order: "asc",
      signal,
      ...(cursor === null ? {} : { afterSeq: String(cursor) }),
    });
    if (rows.length > 0) yield rows;
    if (rows.length < PAGE_SIZE) return;
    cursor = rows[rows.length - 1]!.seq;
  }
}

interface ReadOptions {
  settled?: boolean;
  refresh?: boolean;
  bounded?: boolean;
  recheck?: boolean;
  onPageRead?: () => void;
}

export interface EditIndex {
  /** Only a completed read started for an archived thread can skip later archived reads. */
  get(threadId: string, signal?: AbortSignal, options?: ReadOptions): Promise<ThreadEdits>;
  /** What an earlier read found, without asking bb: the instant outline may not wait for events. */
  peek(threadId: string): ThreadEdits | undefined;
  lastReadAt(threadId: string): number | undefined;
  forget(threadIds: readonly string[]): void;
}

// `lastEventAt` is kept here for every read, so a new event that changes nothing returns the same edits.
interface ReadEntry {
  lastSeq: number | null;
  lastEventAt: number | null;
  lastReadAt: number;
  edits: ThreadEdits;
}

interface Entry extends ReadEntry {
  archive?: "finalized" | { retryAt: number };
  rechecking?: ReadEntry;
}

function markIncomplete(edits: ThreadEdits, settled: boolean): ThreadEdits {
  if (edits.eventsIncomplete === true && settled === (edits.archiveIncomplete === true)) return edits;
  const next: ThreadEdits = { ...edits, eventsIncomplete: true };
  if (settled) next.archiveIncomplete = true;
  else delete next.archiveIncomplete;
  return next;
}

interface ReadQueue {
  tail?: { settled: boolean; recheck: boolean; promise: Promise<ThreadEdits> };
}

export function createEditIndex(sdk: EventsSdk, options: { maxThreads?: number; maxRecords?: number } = {}): EditIndex {
  const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, ReadQueue>();

  async function read(
    threadId: string,
    known: ReadEntry | undefined,
    {
      settled,
      bounded,
      keepIncomplete = false,
      onPageRead,
    }: {
      settled: boolean;
      bounded: boolean;
      keepIncomplete?: boolean;
      onPageRead?: () => void;
    },
    check: () => void,
    signal?: AbortSignal,
  ): Promise<ReadEntry> {
    let lastSeq = known?.lastSeq ?? null;
    let primaryCwd = known?.edits.primaryCwd ?? null;
    let workDirs = known?.edits.workDirs ?? [];
    let runs: RunState = { commitRuns: known?.edits.commitRuns ?? [], lastEventAt: known?.lastEventAt ?? null };
    let added: EditRecord[] = [];
    let fullPages = 0;
    let incomplete = keepIncomplete;
    for await (const rows of pages(sdk, threadId, lastSeq, EDIT_TYPES, signal, onPageRead)) {
      check();
      const parsed = editsFromRows(threadId, rows, runs);
      added = added.concat(parsed.records);
      primaryCwd ??= parsed.primaryCwd;
      workDirs = mergeWorkDirs(workDirs, parsed.workDirs);
      runs = { commitRuns: parsed.commitRuns, lastEventAt: parsed.lastEventAt };
      lastSeq = parsed.lastSeq;
      if ((bounded || settled) && rows.length === PAGE_SIZE && ++fullPages === CATCH_UP_PAGE_LIMIT) {
        incomplete = true;
        break;
      }
    }
    check();
    const archiveIncomplete = settled && incomplete;
    const { commitRuns } = runs;
    const lastEventAt = commitRuns.some((run) => run.endedAt === null) ? runs.lastEventAt : null;
    const changed =
      known === undefined ||
      added.length > 0 ||
      primaryCwd !== known.edits.primaryCwd ||
      workDirs !== known.edits.workDirs ||
      commitRuns !== known.edits.commitRuns ||
      lastEventAt !== known.edits.lastEventAt ||
      incomplete !== (known.edits.eventsIncomplete === true) ||
      archiveIncomplete !== (known.edits.archiveIncomplete === true);
    const edits = changed
      ? {
          records:
            added.length === 0
              ? (known?.edits.records ?? added)
              : [...(known?.edits.records ?? []), ...added].slice(-maxRecords),
          primaryCwd,
          workDirs,
          commitRuns,
          lastEventAt,
          ...(incomplete ? { eventsIncomplete: true as const } : {}),
          ...(archiveIncomplete ? { archiveIncomplete: true as const } : {}),
        }
      : known.edits;
    return {
      lastSeq,
      lastEventAt: runs.lastEventAt,
      lastReadAt: Date.now(),
      edits,
    };
  }

  async function run(
    threadId: string,
    queue: ReadQueue,
    options: ReadOptions,
    signal?: AbortSignal,
  ): Promise<ThreadEdits> {
    const { settled = false, bounded = false, recheck = false, onPageRead } = options;
    const check = () => {
      signal?.throwIfAborted();
      if (inflight.get(threadId) !== queue) throw new Error("Edit index was reset");
    };
    check();
    const known = entries.get(threadId);
    if (!settled && known !== undefined) known.archive = undefined;

    let next: Entry;
    try {
      const rechecking = recheck || known?.rechecking !== undefined;
      const prior = rechecking ? known?.rechecking : known;
      const scanned = await read(
        threadId,
        prior,
        { settled, bounded: rechecking || bounded, onPageRead },
        check,
        signal,
      );
      const incomplete = scanned.edits.eventsIncomplete === true;
      const rebuilding = rechecking && incomplete;
      // Until the rebuild finishes, advance the published history from its own cursor.
      const current =
        rebuilding && known !== undefined
          ? await read(threadId, known, { settled, bounded: true, keepIncomplete: true, onPageRead }, check, signal)
          : scanned;
      const archive = !settled ? undefined : incomplete ? { retryAt: Date.now() + ARCHIVE_RETRY_MS } : "finalized";
      next = { ...current, ...(rebuilding ? { rechecking: scanned } : {}), archive };
    } catch (error) {
      check();
      if (!settled || known === undefined) throw error;
      next = {
        ...known,
        archive: known.archive === "finalized" ? undefined : known.archive,
        edits: markIncomplete(known.edits, true),
      };
    }
    check();
    entries.delete(threadId);
    entries.set(threadId, next);
    while (entries.size > maxThreads) entries.delete(entries.keys().next().value!);
    return next.edits;
  }

  return {
    get(threadId, signal, options = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      const { settled = false, recheck = false } = options;
      let queue = inflight.get(threadId);
      if (queue === undefined) {
        // A cache hit is not pending work: Refresh must be able to start a bounded read immediately.
        const known = entries.get(threadId);
        const archive = known?.archive;
        if (
          settled &&
          options.refresh !== true &&
          known !== undefined &&
          (archive === "finalized" || (archive !== undefined && Date.now() < archive.retryAt))
        ) {
          return Promise.resolve(known.edits);
        }
        queue = {};
        inflight.set(threadId, queue);
      }
      const current = queue;
      const previous = queue.tail;
      if (previous?.settled === settled && (!recheck || previous.recheck)) return previous.promise;
      // A read started while active cannot certify the archive, even if its page was short.
      const start = () => run(threadId, current, options, signal);
      const promise = (previous === undefined ? start() : previous.promise.then(start, start)).finally(() => {
        if (inflight.get(threadId) === current && current.tail?.promise === promise) inflight.delete(threadId);
      });
      queue.tail = { settled, recheck, promise };
      return promise;
    },
    peek: (threadId) => entries.get(threadId)?.edits,
    lastReadAt: (threadId) => entries.get(threadId)?.lastReadAt,
    forget(threadIds) {
      for (const threadId of threadIds) {
        entries.delete(threadId);
        inflight.delete(threadId);
      }
    },
  };
}

export async function findRecordedEdits(
  sdk: EventsSdk,
  threadIds: readonly string[],
  rawPaths: ReadonlySet<string>,
  limit: number,
): Promise<RecordedEdit[]> {
  const perThread = await Promise.all(
    threadIds.map(async (threadId) => {
      const edits: RecordedEdit[] = [];
      for await (const rows of pages(sdk, threadId, null, COMPLETED_TYPES)) {
        for (const row of rows) {
          for (const change of completedChanges(row)) {
            if (!rawPaths.has(change.path) && !(change.movePath !== undefined && rawPaths.has(change.movePath)))
              continue;
            const diff = change.diff ?? null;
            edits.push({
              threadId,
              at: row.createdAt,
              kind: change.kind,
              diff: diff === null ? null : diff.slice(0, DIFF_LIMIT),
              truncated: diff !== null && diff.length > DIFF_LIMIT,
            });
          }
        }
      }
      return edits;
    }),
  );
  const found = perThread.flat();
  return found.sort((a, b) => a.at - b.at).slice(0, limit);
}
