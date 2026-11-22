import type { Policy, Point } from "./policy";

/**
 * The decision core: a pure function from (policy, snapshot, now, last compaction, signals) to a decision.
 * No I/O, no clock, no store — everything else in Press feeds it and records what it says.
 *
 * Precedence, from the contract: the hard window first (it outranks every veto, it is the backstop),
 * then the vetoes, then the points in policy order. A veto is only reported when a point fired,
 * because a row is written per evaluation "that reaches a trigger or a veto".
 */

/** Cost model for a compaction estimate. Calibrated on this machine: 808K tokens took ~6 minutes. */
export const EST_MS_PER_TOKEN = 0.45;
export const EST_USD_PER_MILLION_TOKENS = 0.6;

export interface Snapshot {
  /** Used tokens as a percent of the model context window, or null without usage. */
  percent: number | null;
  tokens: number | null;
  window: number | null;
  /** True while the thread is running a turn. */
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
  lastCompaction: LastCompaction | null;
  /** Named signals seen recently: `plan.approved`, `tests.green`, `pr.opened`, `agentHint`, ... */
  recentSignals: readonly string[];
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

const VETO_ORDER = ["midTurn", "cooldownSeconds", "minTurnsBetween", "previousCompactionFailed", "belowFloor"] as const;
export type VetoName = (typeof VETO_ORDER)[number];

export function estimateCompaction(tokens: number | null): { estMs: number; estCostUsd: number } {
  if (tokens === null || tokens <= 0) return { estMs: 0, estCostUsd: 0 };
  return {
    estMs: Math.round(tokens * EST_MS_PER_TOKEN),
    estCostUsd: Number(((tokens / 1_000_000) * EST_USD_PER_MILLION_TOKENS).toFixed(4)),
  };
}

/** Does a named signal expression (`sameFileRead>=3`) hold on this snapshot? */
export function signalMatches(expr: string, snapshot: Snapshot): boolean {
  const match = /^([a-zA-Z]+)(>=|<=|>|<|==)(\d+(?:\.\d+)?)$/.exec(expr.replace(/\s+/g, ""));
  if (match === null) return false;
  const [, name, op, raw] = match;
  const value = Number(raw);
  const actual =
    name === "sameFileRead"
      ? snapshot.sameFileReadMax
      : name === "sameCommandFailed"
        ? snapshot.sameCommandFailedMax
        : name === "subagentReportBytes"
          ? snapshot.subagentReportBytes
          : name === "toolResultBytes"
            ? snapshot.toolResultBytes
            : null;
  if (actual === null) return false;
  if (op === ">=") return actual >= value;
  if (op === "<=") return actual <= value;
  if (op === ">") return actual > value;
  if (op === "<") return actual < value;
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

/** The first veto that blocks compaction right now, in contract order. */
export function firstVeto(input: DecideInput): VetoName | null {
  const { policy, snapshot, now, lastCompaction } = input;
  const vetoes = policy.vetoes;
  if (vetoes.midTurn && snapshot.midTurn) return "midTurn";
  if (vetoes.cooldownSeconds > 0 && lastCompaction !== null && now - lastCompaction.at < vetoes.cooldownSeconds * 1000) {
    return "cooldownSeconds";
  }
  if (vetoes.minTurnsBetween > 0 && snapshot.turnsSinceCompaction < vetoes.minTurnsBetween) return "minTurnsBetween";
  if (vetoes.previousCompactionFailed && lastCompaction !== null && lastCompaction.failed) return "previousCompactionFailed";
  if (vetoes.belowFloor && snapshot.tokens !== null && snapshot.tokens < policy.window.floorTokens) return "belowFloor";
  return null;
}

export function decide(input: DecideInput): Decision {
  const { policy, snapshot } = input;
  const { percent, tokens, window } = snapshot;
  const base = { percent, tokens, window, ...estimateCompaction(tokens) };

  // A thread without usage numbers cannot be judged; nothing fires.
  if (percent === null || tokens === null || window === null || window <= 0) {
    return { decision: "skip", point: null, reason: null, ...base };
  }

  // 1. The hard window: the backstop. It outranks every veto.
  if (percent >= policy.window.hardPercent) {
    return { decision: "compact", point: "window", reason: "window.hard", ...base };
  }

  // 2. The candidate: the first enabled point in policy order that fires and is past its percent minimum.
  const candidate = policy.points.find((point) => {
    if (!point.enabled) return false;
    const minPercent = point.minPercent ?? policy.window.softPercent;
    if (percent < minPercent) return false;
    return pointFires(point, snapshot, input.recentSignals) !== null;
  });
  if (candidate === undefined) {
    return { decision: "skip", point: null, reason: null, ...base };
  }

  // 3. The vetoes, in contract order, against the candidate.
  const veto = firstVeto(input);
  if (veto !== null) {
    return { decision: "veto", point: candidate.id, reason: veto, ...base };
  }

  return { decision: "compact", point: candidate.id, reason: pointFires(candidate, snapshot, input.recentSignals), ...base };
}

/** For `bb press status`: what the next firing point would be, ignoring vetoes. */
export function nextCandidate(input: DecideInput): { point: string; reason: string | null } | null {
  const { policy, snapshot } = input;
  if (snapshot.percent === null) return null;
  if (snapshot.percent >= policy.window.hardPercent) return { point: "window", reason: "window.hard" };
  for (const point of policy.points) {
    if (!point.enabled) continue;
    const minPercent = point.minPercent ?? policy.window.softPercent;
    if ((snapshot.percent ?? 0) < minPercent) continue;
    const reason = pointFires(point, snapshot, input.recentSignals);
    if (reason !== null) return { point: point.id, reason };
  }
  return null;
}