import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { emptyLedger, summaryFilePath, summaryRelativePath, writeAtomic } from "./ledger-format.ts";
import type { Ledger, LedgerConstraint, LedgerIo } from "./types.ts";

export { emptyLedger, readLedger } from "./ledger-format.ts";

export const LEDGER_MAX_BYTES = 24_000;
export const HISTORY_LIMIT = 50;

export const nodeLedgerIo: LedgerIo = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async write(path, content) {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  },
  async rename(from, to) {
    try {
      await rename(from, to);
    } catch (error) {
      await rm(from, { force: true }).catch(() => {});
      throw error;
    }
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
};

export async function writeSummary(root: string, threadId: string, id: string, summary: string): Promise<string> {
  const summaryPath = summaryRelativePath(threadId, id);
  await writeAtomic(nodeLedgerIo, resolve(root, summaryPath), summary);
  return summaryPath;
}

export async function pruneSummaries(root: string, threadId: string, previous: Ledger["history"], retained: Ledger["history"]): Promise<void> {
  const keep = new Set(retained.map((row) => row.summaryPath));
  await Promise.all(previous.map(async (row) => {
    if (keep.has(row.summaryPath) || row.summaryPath !== summaryRelativePath(threadId, row.id)) return;
    const path = summaryFilePath(root, threadId, row);
    if (path) await rm(path, { force: true });
  }));
}

const serialize = (ledger: Ledger): string => `${JSON.stringify(ledger, null, 2)}\n`;

export function capLedger(ledger: Ledger, maxBytes = LEDGER_MAX_BYTES): Ledger {
  const next: Ledger = {
    ...ledger,
    state: {
      ...ledger.state,
      filesRead: [...ledger.state.filesRead], commands: [...ledger.state.commands],
      filesWritten: [...ledger.state.filesWritten], openQuestions: [...ledger.state.openQuestions],
      nextSteps: [...ledger.state.nextSteps], testFailures: [...ledger.state.testFailures],
      failingTests: [...ledger.state.failingTests],
    },
    constraints: capConstraints(ledger.constraints),
    history: ledger.history.slice(-HISTORY_LIMIT),
    resume: ledger.resume && {
      state: ledger.resume.state.slice(0, 600), next: ledger.resume.next.slice(0, 600), verify: ledger.resume.verify.slice(0, 600),
    },
  };
  const fits = () => Buffer.byteLength(serialize(next)) <= maxBytes;
  while (next.history.length > 10 && !fits()) next.history.shift();
  for (const key of ["filesRead", "commands", "filesWritten", "openQuestions", "nextSteps", "testFailures", "failingTests"] as const) {
    const rows = next.state[key];
    while (rows.length && !fits()) rows.shift();
  }
  while (next.history.length > 1 && !fits()) next.history.shift();
  while (next.constraints.length && !fits()) next.constraints.shift();
  if (!fits()) throw new RangeError("Press ledger exceeds its byte limit");
  return next;
}

export async function writeLedger(io: LedgerIo, path: string, ledger: Ledger): Promise<Ledger> {
  const capped = capLedger(ledger);
  await writeAtomic(io, path, serialize(capped));
  return capped;
}

const IMPERATIVE = /^(?:please\s+)?(?:always|never|don['’]t|do not|make sure|remember to|prefer|avoid|use|keep|stick to)\b/i;
const REQUIREMENT = /\bmust(?:n['’]t)?\b/i;

export function constraintsFromText(text: string, source: string, at = new Date().toISOString()): LedgerConstraint[] {
  const out: LedgerConstraint[] = [];
  for (const line of text.split(/\n+|(?<=[.!?])\s+/)) {
    const sentence = line.trim().replace(/^[-*+]\s+/, "");
    if (sentence.endsWith("?") || sentence.length < 8 || sentence.length > 400) continue;
    if (!IMPERATIVE.test(sentence) && !REQUIREMENT.test(sentence)) continue;
    out.push({ id: `c${createHash("sha256").update(sentence).digest("hex").slice(0, 8)}`, text: sentence, source, at });
  }
  return out;
}

function capConstraints(rows: LedgerConstraint[]): LedgerConstraint[] {
  const out: LedgerConstraint[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (let i = rows.length - 1; i >= 0 && out.length < 40; i--) {
    const row = rows[i]!;
    if (seen.has(row.text)) continue;
    bytes += Buffer.byteLength(row.text) + 1;
    if (bytes > 6_000) break;
    seen.add(row.text);
    out.push(row);
  }
  return out.reverse();
}

function recentUnique<T>(rows: T[], key: (row: T) => string, limit: number): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    byKey.delete(id);
    byKey.set(id, row);
  }
  return Array.from(byKey.values()).slice(-limit);
}

export function mergeLedger(existing: Ledger | null, incoming: Ledger): Ledger {
  const base = existing ?? emptyLedger(incoming.threadId);
  return {
    ...base,
    threadId: incoming.threadId,
    updatedAt: incoming.updatedAt,
    constraints: capConstraints([...base.constraints, ...incoming.constraints]),
    state: {
      ...incoming.state,
      goal: base.state.goal ?? incoming.state.goal,
      branch: incoming.state.branch ?? base.state.branch,
      head: incoming.state.head ?? base.state.head,
      filesRead: recentUnique([...base.state.filesRead, ...incoming.state.filesRead], (row) => row.path, 200),
      filesWritten: recentUnique([...base.state.filesWritten, ...incoming.state.filesWritten], (row) => row.path, 200),
      commands: recentUnique([...base.state.commands, ...incoming.state.commands], (row) => `${row.cmd}\u0000${row.exit}`, 120),
      openQuestions: recentUnique([...base.state.openQuestions, ...incoming.state.openQuestions], (question) => question, 40),
      nextSteps: incoming.state.nextSteps.length ? incoming.state.nextSteps : base.state.nextSteps,
    },
  };
}
