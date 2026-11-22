import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ledger, LedgerCommand, LedgerConstraint, LedgerFile, LedgerHistoryRow } from "./types.ts";

export const LEDGER_MAX_BYTES = 24_000;

export function ledgerPath(cwd: string): string {
  return join(cwd, ".bb", "press", "ledger.json");
}

export function summariesDir(cwd: string): string {
  return join(cwd, ".bb", "press", "summaries");
}

/** Keep the full summary beside the ledger so a UI can show what replaced the transcript. */
export function writeSummary(cwd: string, id: string, summary: string): string {
  const relative = join(".bb", "press", "summaries", `${id}.md`);
  const absolute = join(cwd, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, summary, "utf8");
  return relative;
}

export function readSummary(cwd: string, relative: string): string | null {
  try {
    return readFileSync(join(cwd, relative), "utf8");
  } catch {
    return null;
  }
}

export function emptyLedger(threadId: string | null = null, now: string = new Date().toISOString()): Ledger {
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

/** Tolerant read: a corrupt or partial file must never break compaction. */
export function readLedger(path: string): Ledger | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Ledger>;
    if (!parsed || typeof parsed !== "object") return null;
    const base = emptyLedger(parsed.threadId ?? null);
    const state = (parsed.state ?? {}) as Partial<Ledger["state"]>;
    return {
      ...base,
      ...parsed,
      schemaVersion: 1,
      constraints: asArray<LedgerConstraint>(parsed.constraints),
      history: asArray<LedgerHistoryRow>(parsed.history),
      state: {
        goal: state.goal ?? null,
        branch: state.branch ?? null,
        head: state.head ?? null,
        filesRead: asArray<LedgerFile>(state.filesRead),
        filesWritten: asArray<LedgerFile>(state.filesWritten),
        commands: asArray<LedgerCommand>(state.commands),
        failingTests: asArray<string>(state.failingTests),
        openQuestions: asArray<string>(state.openQuestions),
        nextSteps: asArray<string>(state.nextSteps),
      },
    };
  } catch {
    return null;
  }
}

function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

/** Drop oldest low-value rows until the JSON fits. Constraints and resume are never dropped. */
export function capLedger(ledger: Ledger, maxBytes: number = LEDGER_MAX_BYTES): Ledger {
  const next: Ledger = { ...ledger, state: { ...ledger.state } };
  const size = () => Buffer.byteLength(JSON.stringify(next), "utf8");
  const shrinkOrder: Array<() => void> = [
    () => {
      next.state.filesRead = next.state.filesRead.slice(0, Math.max(0, next.state.filesRead.length - 1));
    },
    () => {
      next.state.commands = next.state.commands.slice(Math.min(1, next.state.commands.length));
    },
    () => {
      next.state.filesWritten = next.state.filesWritten.slice(0, Math.max(0, next.state.filesWritten.length - 1));
    },
    () => {
      next.history = next.history.slice(Math.min(1, next.history.length));
    },
    () => {
      next.state.filesRead = [];
      next.state.filesWritten = [];
    },
    () => {
      next.state.commands = next.state.commands.slice(-5);
    },
    () => {
      next.history = next.history.slice(-5);
    },
  ];
  let guard = 0;
  while (size() > maxBytes && guard < 10_000) {
    const before = size();
    const step = shrinkOrder[guard % shrinkOrder.length]!;
    step();
    if (size() === before) {
      // Nothing left that this step can drop; move on and eventually give up.
      const drained = next.state.filesRead.length === 0 && next.state.filesWritten.length === 0 &&
        next.state.commands.length <= 5 && next.history.length <= 5;
      if (drained) break;
    }
    guard += 1;
  }
  return next;
}

export function writeLedger(path: string, ledger: Ledger): void {
  const capped = capLedger(ledger);
  capped.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(capped, null, 2)}\n`, "utf8");
  chmodSync(tmp, 0o644);
  if (existsSync(path)) renameSync(path, `${path}.bak`);
  renameSync(tmp, path);
}

export function constraintsFromText(
  text: string,
  source: string,
  at: string = new Date().toISOString(),
): LedgerConstraint[] {
  const out: LedgerConstraint[] = [];
  const sentences = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) => line.trim().replace(/^[-*+]\s+/, ""))
    .filter((line) => line.length >= 8 && line.length <= 400);
  for (const sentence of sentences) {
    if (!CONSTRAINT_HINT.test(sentence)) continue;
    out.push({ id: `c${hash(sentence).slice(0, 8)}`, text: sentence, source, at });
  }
  return out;
}

const CONSTRAINT_HINT =
  /\b(never|always|must|mustn't|don'?t|do not|not|only|make sure|remember|unless|prefer|avoid|instead|no need|without|keep|stick to|from now on|going forward)\b/i;

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Union constraints by text, files by path, commands by cmd+exit, keeping the newest last. */
export function mergeLedger(existing: Ledger | null, incoming: Ledger): Ledger {
  if (!existing) return incoming;
  const filesRead = dedupeBy([...existing.state.filesRead, ...incoming.state.filesRead], (row) => row.path).slice(-200);
  const filesWritten = dedupeBy(
    [...existing.state.filesWritten, ...incoming.state.filesWritten],
    (row) => row.path,
  ).slice(-200);
  const commands = dedupeBy([...existing.state.commands, ...incoming.state.commands], (row) => `${row.cmd}\u0000${row.exit}`).slice(
    -120,
  );
  const constraints = dedupeBy([...existing.constraints, ...incoming.constraints], (row) => row.text).slice(-200);
  const failingTests = dedupeBy([...incoming.state.failingTests, ...existing.state.failingTests], (t) => t).slice(0, 40);
  const openQuestions = dedupeBy([...existing.state.openQuestions, ...incoming.state.openQuestions], (t) => t).slice(-40);
  const nextSteps = incoming.state.nextSteps.length ? incoming.state.nextSteps : existing.state.nextSteps;
  return {
    ...existing,
    ...incoming,
    schemaVersion: 1,
    compactions: Math.max(existing.compactions, incoming.compactions),
    constraints,
    history: [...existing.history, ...incoming.history].slice(-50),
    resume: incoming.resume ?? existing.resume,
    state: {
      goal: incoming.state.goal ?? existing.state.goal,
      branch: incoming.state.branch ?? existing.state.branch,
      head: incoming.state.head ?? existing.state.head,
      filesRead,
      filesWritten,
      commands,
      failingTests,
      openQuestions,
      nextSteps,
    },
  };
}
