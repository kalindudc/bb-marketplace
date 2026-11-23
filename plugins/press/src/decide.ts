import type { Blocker } from "./contract";
import { parseSignalExpression, type Point, type Policy } from "./policy";

export const FAILED_BACKOFF_MS = 30 * 60 * 1000;
/** The shortest wait after a failed attempt, even with no cooldown, so the hard window cannot retry in a loop. */
export const MIN_RETRY_AFTER_FAILURE_MS = 60_000;

/** Cost model for a compaction estimate. Calibrated on this machine: 808K tokens took ~6 minutes. */
export const EST_MS_PER_TOKEN = 0.45;
export const EST_USD_PER_MILLION_TOKENS = 0.6;

export interface Snapshot {
  /** Used tokens as a percent of the model context window, or null without usage. */
  percent: number | null;
  tokens: number | null;
  window: number | null;
  /** True whenever the thread is not idle. */
  midTurn: boolean;
  idleSeconds: number;
  /** Turns completed since the last compaction that landed. */
  turnsSinceCompaction: number;
  toolResultBytes: number;
  sameFileReadMax: number;
  sameCommandFailedMax: number;
  subagentReportBytes: number;
}

export interface LastCompaction {
  at: number;
  failed: boolean;
}

export interface DecideInput {
  policy: Policy;
  snapshot: Snapshot;
  now: number;
  /** The latest attempt, whether it landed or failed. */
  lastCompaction: LastCompaction | null;
  /** Named signals seen recently: `plan.approved`, `tests.green`, `pr.opened`, `agentHint`, ... */
  recentSignals: readonly string[];
  /** The thread's measured compaction rate; the fixed estimate when absent. */
  msPerToken?: number;
}

export type DecisionKind = "compact" | "veto" | "skip";

export interface Decision {
  decision: DecisionKind;
  /** The point that fired (`window` for the hard backstop), or null for a skip. */
  point: string | null;
  /** For a compact: the signal or threshold that fired. For a veto: the veto that blocked. */
  reason: string | null;
  percent: number | null;
  tokens: number | null;
  window: number | null;
  estMs: number;
  estCostUsd: number;
}

export type VetoName = Blocker["veto"];

export function estimateCompaction(tokens: number | null, msPerToken = EST_MS_PER_TOKEN): { estMs: number; estCostUsd: number } {
  if (tokens === null || tokens <= 0) return { estMs: 0, estCostUsd: 0 };
  return {
    estMs: Math.round(tokens * msPerToken),
    estCostUsd: Number(((tokens / 1_000_000) * EST_USD_PER_MILLION_TOKENS).toFixed(4)),
  };
}

/** Does a named signal expression (`sameFileRead>=3`) hold on this snapshot? */
export function signalMatches(expr: string, snapshot: Snapshot): boolean {
  const parsed = parseSignalExpression(expr);
  if (parsed === null) return false;
  const { metric, operator, value } = parsed;
  const actual = snapshot[metric];
  if (operator === ">=") return actual >= value;
  if (operator === "<=") return actual <= value;
  if (operator === ">") return actual > value;
  if (operator === "<") return actual < value;
  return actual === value;
}

/** The reason a point fires on this snapshot, or null when it does not. */
export function pointFires(point: Point, snapshot: Snapshot, recentSignals: readonly string[]): string | null {
  switch (point.when) {
    case "boundary": {
      const hit = (point.signals ?? []).find((signal) => recentSignals.includes(signal));
      return hit ?? null;
    }
    case "agentHint":
      return recentSignals.includes("agentHint") ? "agentHint" : null;
    case "toolResultBytes":
      return point.value !== undefined && snapshot.toolResultBytes >= point.value ? `toolResultBytes>=${point.value}` : null;
    case "turnsSinceCompaction":
      return point.value !== undefined && snapshot.turnsSinceCompaction >= point.value ? `turnsSinceCompaction>=${point.value}` : null;
    case "idleSeconds":
      return point.value !== undefined && snapshot.idleSeconds >= point.value ? `idleSeconds>=${point.value}` : null;
    case "signal": {
      const hit = (point.signals ?? []).find((expr) => signalMatches(expr, snapshot));
      return hit ?? null;
    }
  }
}

/** The vetoes that still hold back the hard window: Press never compacts a running thread, and waits out the cooldown after an attempt. */
export const HARD_WINDOW_VETOES: ReadonlySet<VetoName> = new Set(["midTurn", "cooldownSeconds"]);

export function blockers(input: DecideInput): Blocker[] {
  const { policy, snapshot, now, lastCompaction } = input;
  const { vetoes } = policy;
  const result: Blocker[] = [];
  const elapsedMs = lastCompaction === null ? Infinity : now - lastCompaction.at;
  const cooldownMs = Math.max(vetoes.cooldownSeconds * 1000, lastCompaction?.failed ? MIN_RETRY_AFTER_FAILURE_MS : 0);
  const remainingTurns = vetoes.minTurnsBetween - snapshot.turnsSinceCompaction;
  if (vetoes.midTurn && snapshot.midTurn) {
    result.push({ veto: "midTurn", remainingSeconds: null, remainingTurns: null });
  }
  if (cooldownMs > 0 && elapsedMs < cooldownMs) {
    result.push({ veto: "cooldownSeconds", remainingSeconds: Math.ceil((cooldownMs - elapsedMs) / 1000), remainingTurns: null });
  }
  if (remainingTurns > 0) {
    result.push({ veto: "minTurnsBetween", remainingSeconds: null, remainingTurns: Math.ceil(remainingTurns) });
  }
  if (vetoes.previousCompactionFailed && lastCompaction?.failed && elapsedMs < FAILED_BACKOFF_MS) {
    result.push({ veto: "previousCompactionFailed", remainingSeconds: Math.ceil((FAILED_BACKOFF_MS - elapsedMs) / 1000), remainingTurns: null });
  }
  if (vetoes.belowFloor && snapshot.tokens !== null && snapshot.tokens < policy.window.floorTokens) {
    result.push({ veto: "belowFloor", remainingSeconds: null, remainingTurns: null });
  }
  return result;
}

export function firstVeto(input: DecideInput): VetoName | null {
  return blockers(input)[0]?.veto ?? null;
}

function findCandidate(input: DecideInput): { point: string; reason: string; hardWindow: boolean } | null {
  const { policy, snapshot } = input;
  const { percent, tokens, window } = snapshot;
  if (percent === null || tokens === null || window === null || window <= 0) return null;
  if (percent >= policy.window.hardPercent) return { point: "window", reason: "window.hard", hardWindow: true };
  for (const point of policy.points) {
    if (!point.enabled || percent < (point.minPercent ?? policy.window.softPercent)) continue;
    const reason = pointFires(point, snapshot, input.recentSignals);
    if (reason !== null) return { point: point.id, reason, hardWindow: false };
  }
  return null;
}

export function decide(input: DecideInput): Decision {
  const { percent, tokens, window } = input.snapshot;
  const base = { percent, tokens, window, ...estimateCompaction(tokens, input.msPerToken) };
  const candidate = findCandidate(input);
  if (candidate === null) return { decision: "skip", point: null, reason: null, ...base };

  const { point, reason, hardWindow } = candidate;
  const veto = blockers(input).find((blocker) => !hardWindow || HARD_WINDOW_VETOES.has(blocker.veto))?.veto;
  if (veto !== undefined) {
    return { decision: "veto", point, reason: veto, ...base };
  }
  return { decision: "compact", point, reason, ...base };
}

export function nextCandidate(input: DecideInput): { point: string; reason: string | null } | null {
  const candidate = findCandidate(input);
  return candidate === null ? null : { point: candidate.point, reason: candidate.reason };
}