import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Snapshot } from "./decide";

type Threads = BbPluginApi["sdk"]["threads"];
type TimelineRow = Exclude<Awaited<ReturnType<Threads["timeline"]>>, { delta: unknown }>["rows"][number];
type CompactionRow = Extract<TimelineRow, { kind: "system"; systemKind: "operation" }> & { operationKind: "compaction" };
type OutputRow = Extract<TimelineRow, { kind: "work"; workKind: "command" | "tool" | "delegation" }>;

export const PHASE_SIGNALS = {
  planApproved: "plan.approved",
  testsGreen: "tests.green",
  prOpened: "pr.opened",
} as const;

export interface ThreadUsage {
  estimated: boolean;
  modelContextWindow: number;
  usedTokens: number;
}

export type ThreadStatusView = Pick<Awaited<ReturnType<Threads["get"]>>, "status" | "updatedAt">;

/** A thread is running a turn, or starting or stopping one. `error` is not: its last turn ended. */
export function threadRunning(status: ThreadStatusView["status"]): boolean {
  return status === "active" || status === "starting" || status === "stopping" || status === "pending";
}

/** A phase boundary the timeline shows, and when the work that produced it finished. */
export interface PhaseSignal {
  signal: string;
  at: number;
}

export interface SignalDerivation {
  toolResultBytes: number;
  sameFileReadMax: number;
  sameCommandFailedMax: number;
  subagentReportBytes: number;
  phaseSignals: PhaseSignal[];
  /** When the last context compaction of this thread landed, from its timeline rows. */
  lastCompactionEventAt: number | null;
}

function* timelineEntries(rows: readonly unknown[]): Generator<TimelineRow> {
  for (const value of rows) {
    if (typeof value !== "object" || value === null || !("kind" in value)) continue;
    // BB decodes the row payloads. Check the envelope before using them here.
    const row = value as TimelineRow;
    if (!Number.isFinite(row.startedAt) || !Number.isFinite(row.createdAt)) continue;
    yield row;
    // A delegation's childRows belong to a different thread and context window.
    if (row.kind === "turn" && Array.isArray(row.children)) yield* timelineEntries(row.children);
  }
}

function isCompaction(row: TimelineRow): row is CompactionRow {
  return row.kind === "system" && row.systemKind === "operation" && row.operationKind === "compaction";
}

function finishedCompaction(row: TimelineRow): number | null {
  return isCompaction(row) && row.status === "completed" ? row.completedAt ?? row.createdAt : null;
}

export function* completedCompactions(rows: readonly unknown[]): Generator<{ sequence: number; startedAt: number; finishedAt: number }> {
  for (const row of timelineEntries(rows)) {
    const finishedAt = finishedCompaction(row);
    if (finishedAt === null || !Number.isFinite(row.sourceSeqEnd)) continue;
    yield { sequence: row.sourceSeqEnd, startedAt: Math.min(row.startedAt, finishedAt), finishedAt };
  }
}

/** The failed compaction operations in the timeline: when each started and when it failed. */
export function* failedCompactions(rows: readonly unknown[]): Generator<{ startedAt: number; failedAt: number }> {
  for (const row of timelineEntries(rows)) {
    if (!isCompaction(row) || row.status !== "error") continue;
    yield { startedAt: row.startedAt, failedAt: row.completedAt ?? row.createdAt };
  }
}

export function pickBoundary(rows: readonly unknown[], finishedAt: number): { createdAt: number; id: string | null } | null {
  let after = finishedAt;
  let before = Infinity;
  const messages: Array<{ createdAt: number; id: string | null }> = [];
  for (const row of timelineEntries(rows)) {
    if (isCompaction(row)) {
      const end = finishedCompaction(row);
      if (end !== null && row.startedAt <= finishedAt) after = Math.max(after, end);
      if (row.startedAt > finishedAt) before = Math.min(before, row.startedAt);
    }
    // BB labels hidden system prompts as user rows; they never get an in-chat marker slot.
    if (row.kind !== "conversation" || (row.role === "user" ? row.initiator === "system" : row.role !== "assistant")) continue;
    messages.push({ createdAt: row.createdAt, id: typeof row.id === "string" ? row.id : null });
  }
  let first: (typeof messages)[number] | null = null;
  for (const message of messages) {
    if (message.createdAt > after && message.createdAt < before && (first === null || message.createdAt < first.createdAt)) first = message;
  }
  return first;
}

const TEST_RUNNER = String.raw`(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|(?:npx\s+)?vitest\s+run|pytest|go\s+test|cargo\s+test|jest)`;
// The runner must be the command itself (first in the line or after `&&`, `||`, `;` or `|`), not an argument.
const TEST_COMMAND = new RegExp(String.raw`(?:^|&&|\|\||[;|])\s*(?:\w+=\S*\s+)*${TEST_RUNNER}(?=$|\s|[;&|])`);
const PR_COMMAND = /(^|\s)(gh|hub)\s+pr\s+create\b/;
const READ_TOOL = /^(read|read_file|view|cat)$/i;
const REPORT_TOOL = /report/i;

function outputBytes(row: OutputRow): number {
  // A preview only exposes the original character count, not its UTF-8 byte count.
  const totalChars = row.workKind === "delegation" ? undefined : row.outputPreview?.totalChars;
  if (typeof totalChars === "number" && Number.isFinite(totalChars)) return totalChars;
  return typeof row.output === "string" ? Buffer.byteLength(row.output) : 0;
}

function increment(counts: Map<string, number>, key: string): number {
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  return count;
}

export function scanTimeline(rows: readonly unknown[], since: number | null): SignalDerivation {
  let toolResultBytes = 0;
  let subagentReportBytes = 0;
  let sameFileReadMax = 0;
  let sameCommandFailedMax = 0;
  let lastCompactionEventAt: number | null = null;
  const phaseSignals: PhaseSignal[] = [];
  const failedByCommand = new Map<string, number>();
  const readsByPath = new Map<string, number>();

  const entries = [...timelineEntries(rows)];
  // A boundary is a moment, not a standing state: phase signals count only in the newest turn that did work.
  let newestTurn: { id: string; startedAt: number } | null = null;
  for (const row of entries) {
    const landed = finishedCompaction(row);
    if (landed !== null) lastCompactionEventAt = Math.max(lastCompactionEventAt ?? landed, landed);
    if (row.kind === "work" && typeof row.turnId === "string" && (newestTurn === null || row.startedAt > newestTurn.startedAt)) {
      newestTurn = { id: row.turnId, startedAt: row.startedAt };
    }
  }
  const newestTurnId = newestTurn?.id ?? null;
  // A compaction the store never recorded (older than its backfill window) still ends the span.
  const cutoff = Math.max(since ?? -Infinity, lastCompactionEventAt ?? -Infinity);

  for (const row of entries) {
    if (row.kind !== "work" || row.startedAt <= cutoff) continue;
    const phase = newestTurnId !== null && row.turnId === newestTurnId;

    switch (row.workKind) {
      case "command": {
        toolResultBytes += outputBytes(row);
        if (typeof row.command !== "string" || row.command === "") break;
        if (row.status === "error" || (typeof row.exitCode === "number" && row.exitCode !== 0)) {
          sameCommandFailedMax = Math.max(sameCommandFailedMax, increment(failedByCommand, row.command));
        } else if (row.status === "completed") {
          const at = row.completedAt ?? row.createdAt;
          if (phase && TEST_COMMAND.test(row.command)) phaseSignals.push({ signal: PHASE_SIGNALS.testsGreen, at });
          if (phase && PR_COMMAND.test(row.command)) phaseSignals.push({ signal: PHASE_SIGNALS.prOpened, at });
        }
        break;
      }
      case "plan-steps":
        // Every todo-list update is a completed plan-steps row; only a finished plan is a boundary.
        if (phase && row.status === "completed" && row.steps.length > 0 && row.steps.every((step) => step.status === "completed")) {
          phaseSignals.push({ signal: PHASE_SIGNALS.planApproved, at: row.completedAt ?? row.createdAt });
        }
        break;
      case "file-read":
        if (row.path !== "") sameFileReadMax = Math.max(sameFileReadMax, increment(readsByPath, row.path));
        break;
      case "tool": {
        const bytes = outputBytes(row);
        toolResultBytes += bytes;
        if (READ_TOOL.test(row.toolName)) {
          const path = row.toolArgs?.path;
          const file = typeof path === "string" && path !== "" ? path : row.toolArgs?.file;
          if (typeof file === "string" && file !== "") sameFileReadMax = Math.max(sameFileReadMax, increment(readsByPath, file));
        } else if (REPORT_TOOL.test(row.toolName)) {
          subagentReportBytes += bytes;
        }
        break;
      }
      case "delegation": {
        const bytes = outputBytes(row);
        toolResultBytes += bytes;
        subagentReportBytes += bytes;
        break;
      }
    }
  }

  return { toolResultBytes, sameFileReadMax, sameCommandFailedMax, subagentReportBytes, phaseSignals, lastCompactionEventAt };
}

export function deriveSnapshot(input: {
  usage: ThreadUsage | null;
  thread: ThreadStatusView;
  now: number;
  turnsSinceCompaction: number;
  rows: readonly unknown[];
  since: number | null;
}): Snapshot & SignalDerivation {
  const window = input.usage?.modelContextWindow ?? null;
  const tokens = input.usage?.usedTokens ?? null;
  const percent = window !== null && window > 0 && tokens !== null ? (tokens / window) * 100 : null;
  const midTurn = threadRunning(input.thread.status);
  const idleSeconds = midTurn ? 0 : Math.max(0, Math.round((input.now - input.thread.updatedAt) / 1000));
  return {
    percent,
    tokens,
    window,
    midTurn,
    idleSeconds,
    turnsSinceCompaction: input.turnsSinceCompaction,
    ...scanTimeline(input.rows, input.since),
  };
}
