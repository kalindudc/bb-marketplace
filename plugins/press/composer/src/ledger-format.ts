import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { ComposerRow, Ledger, LedgerIo, PublishedComposer } from "./types.ts";

const pathSegment = /^[\w-]+$/;

function threadDir(threadId: string): string {
  if (!pathSegment.test(threadId)) throw new Error("Invalid Press thread ID");
  return `.bb/press/threads/${threadId}`;
}

export function ledgerPath(root: string, threadId: string): string {
  return resolve(root, threadDir(threadId), "ledger.json");
}

export function composerConfigPath(root: string, threadId: string): string {
  return resolve(root, threadDir(threadId), "composer.json");
}

export function summaryRelativePath(threadId: string, id: string): string {
  if (!pathSegment.test(id)) throw new Error("Invalid Press summary ID");
  return `${threadDir(threadId)}/summaries/${id}.md`;
}

export function summaryFilePath(root: string, threadId: string, row: { summaryPath?: string | null }): string | null {
  if (!pathSegment.test(threadId) || typeof row.summaryPath !== "string") return null;
  const prefix = `${threadDir(threadId)}/summaries/`;
  const path = row.summaryPath.replaceAll("\\", "/");
  if (!path.startsWith(prefix) || !/^[\w-]+\.md$/.test(path.slice(prefix.length))) return null;
  return resolve(root, path);
}

export function emptyLedger(threadId: string | null = null, now = new Date().toISOString()): Ledger {
  return {
    schemaVersion: 1,
    threadId,
    updatedAt: now,
    compactions: 0,
    constraints: [],
    state: {
      goal: null, branch: null, head: null, filesRead: [], filesWritten: [], commands: [],
      failingTests: [], testFailures: [], openQuestions: [], nextSteps: [],
    },
    resume: null,
    history: [],
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function readJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

const asString = (value: unknown) => typeof value === "string" ? value : null;
const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const asArray = <T>(value: unknown): T[] => Array.isArray(value) ? value : [];

export function composerRows(ledger: Ledger): ComposerRow[] {
  return ledger.history.flatMap((row) => {
    if (!row || row.outcome !== "ok" || typeof row.id !== "string" || !pathSegment.test(row.id) ||
      typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at)) ||
      typeof row.point !== "string" || asNumber(row.tokensBefore) === null) return [];
    return [{
      id: row.id, at: row.at, finishedAt: asNumber(row.finishedAt), point: row.point,
      tokensBefore: row.tokensBefore, tokensAfter: asNumber(row.tokensAfter), model: asString(row.model),
      ms: asNumber(row.ms), summaryPath: asString(row.summaryPath), outcome: "ok",
    }];
  });
}

export function parseLedger(text: string | null): Ledger | null {
  const raw = readJson(text);
  if (!raw) return null;
  const base = emptyLedger(asString(raw.threadId), asString(raw.updatedAt) ?? new Date(0).toISOString());
  const state = record(raw.state);
  const resume = record(raw.resume);
  const ledger: Ledger = {
    ...base,
    compactions: asNumber(raw.compactions) ?? 0,
    constraints: asArray<Ledger["constraints"][number]>(raw.constraints).filter((row) => typeof row?.text === "string"),
    state: {
      goal: asString(state?.goal), branch: asString(state?.branch), head: asString(state?.head),
      filesRead: asArray<Ledger["state"]["filesRead"][number]>(state?.filesRead).filter((row) => typeof row?.path === "string"),
      filesWritten: asArray<Ledger["state"]["filesWritten"][number]>(state?.filesWritten).filter((row) => typeof row?.path === "string"),
      commands: asArray<Ledger["state"]["commands"][number]>(state?.commands).filter((row) => typeof row?.cmd === "string"),
      failingTests: asArray<string>(state?.failingTests).filter((name) => typeof name === "string"),
      testFailures: asArray<Ledger["state"]["testFailures"][number]>(state?.testFailures).filter((row) =>
        typeof row?.name === "string" && (typeof row.command === "string" || row.command === null)),
      openQuestions: asArray<string>(state?.openQuestions).filter((question) => typeof question === "string"),
      nextSteps: asArray<string>(state?.nextSteps).filter((step) => typeof step === "string"),
    },
    resume: resume && typeof resume.state === "string" && typeof resume.next === "string" && typeof resume.verify === "string"
      ? { state: resume.state, next: resume.next, verify: resume.verify } : null,
    history: asArray(raw.history),
  };
  ledger.history = composerRows(ledger);
  return ledger;
}

export async function readLedger(io: LedgerIo, path: string): Promise<Ledger | null> {
  return parseLedger(await io.read(path));
}

export async function writeAtomic(io: LedgerIo, path: string, content: string): Promise<void> {
  await io.mkdir(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  await io.write(temp, content);
  await io.rename(temp, path);
}

export async function writeComposerConfig(io: LedgerIo, path: string, config: PublishedComposer): Promise<void> {
  await writeAtomic(io, path, `${JSON.stringify(config, null, 2)}\n`);
}
