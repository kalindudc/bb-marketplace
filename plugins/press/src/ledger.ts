import { createHash } from "node:crypto";

/**
 * The per-workspace ledger at `<workspace>/.bb/press/ledger.json`, the one file the governor (a bb plugin) and
 * the composer (a pi extension) share. The shape matches the contract and the composer's `types.ts` exactly.
 * The governor only ever appends compaction history and bumps counters here; it never writes constraints.
 */
export const LEDGER_CAP_BYTES = 24_000;

export interface LedgerFile {
  path: string;
  hash?: string;
  at: string;
}

export interface LedgerCommand {
  cmd: string;
  exit: number | null;
  at: string;
  note?: string;
}

export interface LedgerConstraint {
  id: string;
  text: string;
  source: string;
  at: string;
}

export interface LedgerHistoryRow {
  id: string;
  at: string;
  point: string;
  tokensBefore: number;
  tokensAfter: number | null;
  model: string | null;
  ms: number | null;
  keptTurns: number | null;
  summaryHash: string;
  summaryPath?: string | null;
  boundaryAt?: number | null;
  boundaryMessageId?: string | null;
  finishedAt?: number;
  threadId?: string;
  requestId?: string;
}

export interface Ledger {
  schemaVersion: number;
  threadId: string | null;
  updatedAt: string;
  compactions: number;
  constraints: LedgerConstraint[];
  state: {
    goal: string | null;
    branch: string | null;
    head: string | null;
    filesRead: LedgerFile[];
    filesWritten: LedgerFile[];
    commands: LedgerCommand[];
    failingTests: string[];
    openQuestions: string[];
    nextSteps: string[];
  };
  resume: { state: string; next: string; verify: string } | null;
  /** The composer config the governor publishes so the pi half can read the UI settings. */
  composer?: PublishedComposer;
  history: LedgerHistoryRow[];
  [key: string]: unknown;
}

/**
 * The composer config the governor publishes into `ledger.composer`: the model and summary budget
 * resolved for the thread, with the ledger and resume contract pinned on. The composer (a pi
 * extension) cannot read bb's database or settings, so this is the one channel that reaches it.
 */
export interface PublishedComposer {
  /** `provider/modelId`, or null for the thread's own model. */
  model: string | null;
  maxSummaryTokens: number;
  ledger: true;
  resumeContract: true;
}

/** File operations the ledger needs, so tests run on a real temp dir and the server on `bb.sdk.files`. */
export interface LedgerIo {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** Move a file that already exists. */
  move(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export function ledgerPath(workspace: string): string {
  return `${workspace.replace(/[/\\]+$/, "")}/.bb/press/ledger.json`;
}

export function emptyLedger(threadId: string | null, now: string): Ledger {
  return {
    schemaVersion: 1,
    threadId,
    updatedAt: now,
    compactions: 0,
    constraints: [],
    state: {
      goal: null,
      branch: null,
      head: null,
      filesRead: [],
      filesWritten: [],
      commands: [],
      failingTests: [],
      openQuestions: [],
      nextSteps: [],
    },
    resume: null,
    history: [],
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Tolerant read: a missing or corrupt ledger is null, never a throw. Unknown fields are preserved. */
export function parseLedger(text: string | null): Ledger | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const state = (raw.state ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    schemaVersion: 1,
    threadId: typeof raw.threadId === "string" ? raw.threadId : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
    compactions: typeof raw.compactions === "number" ? raw.compactions : 0,
    constraints: asArray<LedgerConstraint>(raw.constraints),
    state: {
      goal: (state.goal as string | null) ?? null,
      branch: (state.branch as string | null) ?? null,
      head: (state.head as string | null) ?? null,
      filesRead: asArray<LedgerFile>(state.filesRead),
      filesWritten: asArray<LedgerFile>(state.filesWritten),
      commands: asArray<LedgerCommand>(state.commands),
      failingTests: asArray<string>(state.failingTests),
      openQuestions: asArray<string>(state.openQuestions),
      nextSteps: asArray<string>(state.nextSteps),
    },
    resume: (raw.resume ?? null) as Ledger["resume"],
    history: asArray<LedgerHistoryRow>(raw.history),
  };
}

export function serializeLedger(ledger: Ledger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

export function ledgerBytes(ledger: Ledger): number {
  return Buffer.byteLength(serializeLedger(ledger), "utf8");
}

/**
 * Size cap: over 24 KB, drop the oldest `filesRead` rows, then `commands`, then `filesWritten`, then `history`
 * rows. Constraints and `resume` are never dropped. If nothing droppable remains, return as-is.
 */
export function capLedger(ledger: Ledger, maxBytes: number = LEDGER_CAP_BYTES): Ledger {
  const next: Ledger = { ...ledger, state: { ...ledger.state }, history: [...ledger.history] };
  next.state.filesRead = [...next.state.filesRead];
  next.state.filesWritten = [...next.state.filesWritten];
  next.state.commands = [...next.state.commands];
  const order: Array<() => boolean> = [
    () => next.state.filesRead.splice(0, 1).length > 0,
    () => next.state.commands.splice(0, 1).length > 0,
    () => next.state.filesWritten.splice(0, 1).length > 0,
    () => next.history.splice(0, 1).length > 0,
  ];
  while (ledgerBytes(next) > maxBytes) {
    if (!order.some((drop) => drop())) break;
  }
  return next;
}

/** A compaction the governor asked for that landed, failed or was cancelled, to append to the ledger. */
export type CompactionOutcome = LedgerHistoryRow;

export function threadHistory(ledger: Ledger | null, threadId: string): LedgerHistoryRow[] {
  if (ledger === null) return [];
  return ledger.history.filter((row) => row && (row.threadId ?? ledger.threadId) === threadId && Number.isFinite(Date.parse(row.at)));
}

export function lookupSummaryPath(ledger: Ledger | null, threadId: string, at: string): string | null {
  const relative = threadHistory(ledger, threadId).find((row) => row.at === at)?.summaryPath;
  if (typeof relative !== "string") return null;
  const path = relative.replaceAll("\\", "/");
  return /^\.bb\/press\/summaries\/[\w-]+\.md$/.test(path) ? path : null;
}

/** Merge the resolved composer config into the ledger, preserving every other field. */
export function mergeComposer(existing: Ledger | null, composer: PublishedComposer, now: string): Ledger {
  const base = existing ?? emptyLedger(null, now);
  return { ...base, composer, updatedAt: now };
}

/** Whether the ledger already carries exactly this composer config, so a rewrite can be skipped. */
export function sameComposer(published: unknown, composer: PublishedComposer): boolean {
  if (typeof published !== "object" || published === null) return false;
  const record = published as Record<string, unknown>;
  return (
    record.model === composer.model &&
    record.maxSummaryTokens === composer.maxSummaryTokens &&
    record.ledger === true &&
    record.resumeContract === true
  );
}

/** Merge one compaction outcome into the ledger: bump the counter and append a history row, newest last. */
export function mergeCompaction(existing: Ledger | null, outcome: CompactionOutcome, now: string): Ledger {
  const base = existing ?? emptyLedger(null, now);
  const seen = new Set(base.history.map((row) => row.id));
  const isNew = !seen.has(outcome.id);
  return {
    ...base,
    updatedAt: now,
    compactions: base.compactions + (isNew ? 1 : 0),
    history: [...base.history, ...(isNew ? [outcome] : [])].slice(-50),
  };
}

/** Atomic write: temp file, previous file becomes `.bak`, temp renamed into place. Never throws. */
export async function writeLedgerAtomic(io: LedgerIo, path: string, ledger: Ledger): Promise<void> {
  const dir = path.replace(/\/[^/]+$/, "");
  await io.mkdir(dir);
  // The host file API refuses to move onto an existing path ("Destination already exists"), so the
  // previous copy is kept as .bak and the ledger is written in place. A torn write is recoverable
  // from .bak, which is the only failure this trades against.
  const previous = await io.read(path);
  if (previous !== null) await io.write(`${path}.bak`, previous);
  await io.write(path, serializeLedger(ledger));
}

/** Read and parse through the io, tolerating a missing or corrupt file. */
export async function readLedger(io: LedgerIo, path: string): Promise<Ledger | null> {
  return parseLedger(await io.read(path));
}

export function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}