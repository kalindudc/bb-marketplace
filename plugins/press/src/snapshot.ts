import type { Snapshot } from "./decide";

/**
 * Everything Press learns from bb, reduced to the numbers and signals `decide` consumes.
 * The derivation is pure and works on plain timeline rows; only `PressService` touches `bb.sdk`.
 */

export interface ThreadUsage {
  estimated: boolean;
  modelContextWindow: number;
  usedTokens: number;
}

export interface ThreadStatusView {
  status: "active" | "error" | "idle" | "pending" | "starting" | "stopping";
  updatedAt: number;
}

export interface SignalDerivation {
  toolResultBytes: number;
  sameFileReadMax: number;
  sameCommandFailedMax: number;
  subagentReportBytes: number;
  phaseSignals: string[];
  /** When the last context compaction of this thread landed, from its timeline rows. */
  lastCompactionEventAt: number | null;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The original byte length of one command's output, however the row truncated it. */
function commandBytes(data: Record<string, unknown>): number {
  const truncation = asObject(data.truncation);
  for (const key of ["aggregatedOutput", "result", "resultText"]) {
    const length = asNumber(asObject(truncation[key]).originalLength);
    if (length !== null) return length;
  }
  return 0;
}

function* timelineEntries(rows: readonly unknown[]): Generator<Record<string, unknown>> {
  for (const row of rows) {
    const record = asObject(row);
    yield record;
    if (record.kind === "turn" && Array.isArray(record.children)) yield* timelineEntries(record.children);
  }
}

function finishedCompaction(row: Record<string, unknown>): number | null {
  if (row.type === "contextCompaction") return asNumber(row.createdAt) ?? asNumber(row.startedAt);
  return row.kind === "system" && row.operationKind === "compaction" && row.status === "completed"
    ? asNumber(row.completedAt) ?? asNumber(row.createdAt)
    : null;
}

export function* completedCompactions(rows: readonly unknown[]): Generator<{ sequence: number; startedAt: number; finishedAt: number }> {
  for (const row of timelineEntries(rows)) {
    const finishedAt = finishedCompaction(row);
    const sequence = asNumber(row.sourceSeqEnd);
    if (finishedAt === null || sequence === null) continue;
    yield { sequence, startedAt: Math.min(asNumber(row.startedAt) ?? finishedAt, finishedAt), finishedAt };
  }
}

export function pickBoundary(rows: readonly unknown[], finishedAt: number): { createdAt: number; id: string | null } | null {
  let after = finishedAt;
  let before = Number.POSITIVE_INFINITY;
  const messages: Array<{ createdAt: number; id: string | null }> = [];
  for (const row of timelineEntries(rows)) {
    const end = finishedCompaction(row);
    const start = asNumber(row.startedAt) ?? asNumber(row.createdAt);
    if (end !== null && start !== null && start <= finishedAt) after = Math.max(after, end);
    if (start !== null && start > finishedAt && (end !== null || row.operationKind === "compaction")) {
      before = Math.min(before, start);
    }
    // BB labels hidden system prompts as user rows; they never get an in-chat marker slot.
    if (row.kind !== "conversation" || (row.role !== "user" && row.role !== "assistant") || row.initiator === "system") continue;
    const createdAt = asNumber(row.createdAt);
    if (createdAt !== null) messages.push({ createdAt, id: typeof row.id === "string" ? row.id : null });
  }
  let first: (typeof messages)[number] | null = null;
  for (const message of messages) {
    if (message.createdAt > after && message.createdAt < before && (first === null || message.createdAt < first.createdAt)) first = message;
  }
  return first;
}

const TEST_COMMAND = /(^|\s|[/=])(npx\s+)?(vitest|pytest|jest|npm\s+test|go\s+test|cargo\s+test)(\s|$)/;
const PR_COMMAND = /(^|\s)(gh|hub)\s+pr\s+create\b/;

/**
 * Walk plain `threads.timeline` rows and derive every counter and signal `decide` consumes:
 * tool-result volume, thrash signatures (same file re-read, same command re-failing, subagent
 * report bytes), phase boundary signals, and the last landed compaction.
 */
export function scanTimeline(rows: readonly unknown[]): SignalDerivation {
  let toolResultBytes = 0;
  let subagentReportBytes = 0;
  let lastCompactionEventAt: number | null = null;
  const phaseSignals: string[] = [];
  const failedByCommand = new Map<string, number>();
  const readsByPath = new Map<string, number>();

  for (const record of timelineEntries(rows)) {
    const type = asString(record.type);
    const landed = finishedCompaction(record);
    if (landed !== null) lastCompactionEventAt = Math.max(lastCompactionEventAt ?? 0, landed);

    if (type === "commandExecution") {
      toolResultBytes += commandBytes(record);
      const command = asString(record.command);
      if (command === "") continue;
      const status = asString(record.status);
      const exitCode = asNumber(record.exitCode);
      const failed = status === "failed" || status === "error" || (exitCode !== null && exitCode !== 0);
      if (failed) {
        failedByCommand.set(command, (failedByCommand.get(command) ?? 0) + 1);
      } else {
        if (TEST_COMMAND.test(command)) phaseSignals.push("tests.green");
        if (PR_COMMAND.test(command)) phaseSignals.push("pr.opened");
      }
    } else if (type === "planSteps") {
      // A finished plan is a task boundary: the cheapest moment to compact.
      if (asString(record.status) === "completed") phaseSignals.push("plan.approved");
    } else if (type === "fileRead") {
      const path = asString(record.path) || asString(asObject(record.arguments).path);
      if (path !== "") readsByPath.set(path, (readsByPath.get(path) ?? 0) + 1);
    } else if (type === "toolCall") {
      const tool = asString(record.tool).toLowerCase();
      const args = asObject(record.arguments);
      if (/^(read|read_file|view|cat)$/.test(tool)) {
        const path = asString(args.path) || asString(args.file);
        if (path !== "") readsByPath.set(path, (readsByPath.get(path) ?? 0) + 1);
      } else if (/report/.test(tool)) {
        const truncation = asObject(record.truncation);
        const block = asObject(truncation.resultText ?? truncation.result ?? truncation.aggregatedOutput);
        const length = asNumber(block.originalLength);
        if (length !== null) subagentReportBytes += length;
      }
    }
  }

  return {
    toolResultBytes,
    sameFileReadMax: Math.max(0, ...readsByPath.values()),
    sameCommandFailedMax: Math.max(0, ...failedByCommand.values()),
    subagentReportBytes,
    phaseSignals,
    lastCompactionEventAt,
  };
}

/** Combine usage, status, the turn counter and the timeline scan into the snapshot `decide` consumes. */
export function deriveSnapshot(input: {
  usage: ThreadUsage | null;
  thread: ThreadStatusView;
  now: number;
  turnsSinceCompaction: number;
  rows: readonly unknown[];
}): Snapshot & SignalDerivation {
  const signals = scanTimeline(input.rows);
  const usage = input.usage;
  const window = usage?.modelContextWindow ?? null;
  const tokens = usage?.usedTokens ?? null;
  const percent = window !== null && window > 0 && tokens !== null ? (tokens / window) * 100 : null;
  const idleSeconds =
    input.thread.status === "idle" ? Math.max(0, Math.round((input.now - input.thread.updatedAt) / 1000)) : 0;
  return {
    percent,
    tokens,
    window,
    midTurn: input.thread.status === "active",
    idleSeconds,
    turnsSinceCompaction: input.turnsSinceCompaction,
    ...signals,
  };
}