import { threadStatusSchema, type CompactionSummary, type DecisionSummary, type ThreadStatusDto } from "../../src/contract";
import { DEFAULT_POLICY, type PointId } from "../../src/policy";

export const THREAD = "thr_fcqqujv3d8";
export const WINDOW = 400_000;
export const THRESHOLDS = { softPercent: 55, hardPercent: 80, floorTokens: 150_000 };
// Idle stays off, as in the default policy: its own 25% minimum would open the points gate there.
const POINTS_ON = { phase: true, agent: true, volume: true, turns: true, idle: false, thrash: true };

const iso = (ms: number) => new Date(ms).toISOString();

export function compaction(now: number, minutesAgo: number, point: string, tokensBefore: number | null, tokensAfter: number | null, ms: number | null,
  extra: Partial<CompactionSummary> = {}): CompactionSummary {
  const at = now - minutesAgo * 60_000;
  return {
    id: `cmp-${point}-${minutesAgo}`, at: iso(at), point, reason: point === "window" ? "window.hard" : point === "phase" ? "tests.green" : null,
    tokensBefore, tokensAfter, ms, outcome: "ok", error: null, model: "claude-sonnet-5.5", hasSummary: true,
    boundaryAt: null, boundaryMessageId: null, ...extra,
  };
}

export function decision(now: number, secondsAgo: number, kind: DecisionSummary["decision"], point: string | null, reason: string | null, percent: number | null): DecisionSummary {
  return { at: iso(now - secondsAgo * 1000), decision: kind, point, reason, percent };
}

function totalsOf(rows: readonly CompactionSummary[]): ThreadStatusDto["totals"] {
  const ok = rows.filter((row) => row.outcome === "ok" && row.tokensBefore !== null && row.tokensAfter !== null);
  if (ok.length === 0) return { count: 0, tokensFreed: 0, averageMs: null };
  return {
    count: ok.length,
    tokensFreed: ok.reduce((sum, row) => sum + row.tokensBefore! - row.tokensAfter!, 0),
    averageMs: Math.round(ok.reduce((sum, row) => sum + (row.ms ?? 0), 0) / ok.length),
  };
}

/** What the service serves as `pointsFromPercent` (its `gatePercent`) for these switches under the default policy. */
function pointsFrom(points: ThreadStatusDto["points"], { softPercent, hardPercent }: ThreadStatusDto["thresholds"]): number {
  return DEFAULT_POLICY.points.reduce((gate, point) => points[point.id as PointId] ? Math.min(gate, point.minPercent ?? softPercent) : gate, hardPercent);
}

/**
 * A complete status, validated by the contract's own schema so a fixture can never drift from it.
 * `pointsFromPercent` always follows the fixture's points; pass `policy` for a policy file that sets
 * its own point minimums.
 */
export function status(overrides: Partial<ThreadStatusDto> = {}, policy: { pointsFromPercent?: number } = {}): ThreadStatusDto {
  const history = overrides.history ?? [];
  const points = overrides.points ?? POINTS_ON;
  const draft: ThreadStatusDto = {
    threadId: THREAD, percent: 22, tokens: 88_000, window: WINDOW, running: false, providerEnabled: true, mode: "auto", thresholds: THRESHOLDS,
    compacting: null, held: null, blockers: [], points: { ...POINTS_ON }, overrides: { mode: false, points: [] },
    summaryModel: null, nextPoint: null, estimateMs: null, turnsSince: 12,
    lastCompaction: history.find((row) => row.outcome === "ok") ?? null, history, totals: totalsOf(history),
    boundaries: {}, decisions: [], ...overrides,
    pointsFromPercent: policy.pointsFromPercent ?? pointsFrom(points, overrides.thresholds ?? THRESHOLDS),
  };
  return threadStatusSchema.parse(draft);
}

/** The states the approved mock designed, on today's clock. */
export function states(now = Date.now()) {
  const heldHistory = [compaction(now, 106, "idle", 241_200, 63_100, 98_000), compaction(now, 198, "phase", 236_800, 58_400, 91_000)];
  const compHistory = [compaction(now, 82, "idle", 233_600, 61_900, 97_000), compaction(now, 176, "agent", 228_000, 55_300, 82_000)];
  const blockHistory = [compaction(now, 6, "phase", 316_000, 88_200, 106_000), compaction(now, 82, "idle", 233_600, 61_900, 97_000)];
  const rich = [
    compaction(now, 86, "phase", 247_900, 60_200, 96_000),
    compaction(now, 128, "window", 322_400, 74_800, 135_000),
    compaction(now, 199, "agent", 228_000, 55_300, 82_000, { hasSummary: false }),
    compaction(now, 260, "volume", null, null, null, { outcome: "failed", error: "provider refused: context too large", reason: "toolResultBytes>=1500000", hasSummary: false, model: null }),
    compaction(now, 346, "idle", 241_200, 63_100, 98_000),
    compaction(now, 394, "phase", 236_800, 58_400, 91_000),
  ];
  return {
    healthy: status({ percent: 22, tokens: 88_000, turnsSince: 12, blockers: [{ veto: "belowFloor", remainingSeconds: null, remainingTurns: null }] }),
    held: status({
      percent: 82, tokens: 328_000, nextPoint: "window", turnsSince: 31, estimateMs: 147_000,
      compacting: { since: iso(now - 25_000), point: "window" },
      held: { since: iso(now - 25_000), reason: "Press is compacting this thread before the next turn", count: 1 },
      history: heldHistory,
      decisions: [decision(now, 30, "compact", "window", "window.hard", 82), decision(now, 480, "veto", "volume", "midTurn", 76)],
    }),
    compacting: status({
      percent: 78, tokens: 312_000, nextPoint: "phase", turnsSince: 22,
      compacting: { since: iso(now - 40_000), point: "phase" }, history: compHistory,
      decisions: [decision(now, 45, "compact", "phase", "tests.green", 78), decision(now, 3_000, "veto", "thrash", "minTurnsBetween", 57)],
    }),
    blocked: status({
      percent: 83, tokens: 332_000, nextPoint: "window", turnsSince: 1,
      blockers: [{ veto: "cooldownSeconds", remainingSeconds: 240, remainingTurns: null }, { veto: "minTurnsBetween", remainingSeconds: null, remainingTurns: 1 }],
      history: blockHistory,
      decisions: [decision(now, 120, "veto", "window", "cooldownSeconds", 83), decision(now, 360, "compact", "phase", "tests.green", 79)],
    }),
    backstopRunning: status({
      percent: 84, tokens: 336_000, running: true, nextPoint: "window", turnsSince: 9,
      blockers: [{ veto: "midTurn", remainingSeconds: null, remainingTurns: null }, { veto: "minTurnsBetween", remainingSeconds: null, remainingTurns: 1 }],
      history: compHistory, decisions: [decision(now, 20, "veto", "window", "midTurn", 84)],
    }),
    vetoed: status({
      percent: 61, tokens: 244_000, nextPoint: "phase", turnsSince: 1,
      blockers: [{ veto: "minTurnsBetween", remainingSeconds: null, remainingTurns: 1 }],
      history: blockHistory, decisions: [decision(now, 40, "veto", "phase", "minTurnsBetween", 61)],
    }),
    history: status({
      percent: 41, tokens: 164_000, turnsSince: 9, summaryModel: "claude-sonnet-5.5", points: { ...POINTS_ON, thrash: false },
      overrides: { mode: true, points: ["thrash"] }, mode: "advisor", history: rich,
      decisions: [decision(now, 5_160, "compact", "phase", "tests.green", 62), decision(now, 5_580, "veto", "agent", "midTurn", 60), decision(now, 7_680, "compact", "window", "window.hard", 81)],
    }),
    noUsage: status({ percent: null, tokens: null, window: null, turnsSince: 0 }),
  };
}
