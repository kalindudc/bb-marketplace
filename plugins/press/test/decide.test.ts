import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Policy } from "../src/policy";
import { blockers, decide, FAILED_BACKOFF_MS, firstVeto, MIN_RETRY_AFTER_FAILURE_MS, nextCandidate, signalMatches, type DecideInput, type Snapshot } from "../src/decide";

const WINDOW = 1_000_000;

// The decision logic is tested against a fixed policy with every point on, not the shipped defaults.
const BASE: Policy = {
  ...DEFAULT_POLICY,
  window: { softPercent: 35, hardPercent: 55, floorTokens: 60_000 },
  points: DEFAULT_POLICY.points.map((point) => ({ ...point, enabled: true })),
  vetoes: { ...DEFAULT_POLICY.vetoes, minTurnsBetween: 5 },
};

function policy(patch: Partial<Policy> = {}): Policy {
  return { ...BASE, ...patch };
}

function snapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    percent: 40,
    tokens: 400_000,
    window: WINDOW,
    midTurn: false,
    idleSeconds: 0,
    turnsSinceCompaction: 10,
    toolResultBytes: 0,
    sameFileReadMax: 0,
    sameCommandFailedMax: 0,
    subagentReportBytes: 0,
    ...patch,
  };
}

function input(patch: Partial<DecideInput> = {}, snap: Partial<Snapshot> = {}): DecideInput {
  return {
    policy: policy(),
    snapshot: snapshot(snap),
    now: 1_000_000,
    lastCompaction: null,
    recentSignals: [],
    ...patch,
  };
}

const at = (secondsAgo: number) => 1_000_000 - secondsAgo * 1000;

describe("decide", () => {
  it("is a pure function of its input", () => {
    const before = input();
    decide(before);
    expect(before).toEqual(input());
  });

  it("estimates compaction time and cost from tokens", () => {
    const decision = decide(input({}, { tokens: 808_380, percent: 77, window: WINDOW }));
    expect(decision.estMs).toBe(363_771); // calibrated: ~6 minutes for 808K tokens on this machine
    expect(decision.estCostUsd).toBeCloseTo(0.485, 2);
  });

  it("estimates with the thread's own rate when the caller has one", () => {
    expect(decide(input({ msPerToken: 2 }, { tokens: 400_000 })).estMs).toBe(800_000);
  });

  it("skips without usage", () => {
    const decision = decide(input({}, { percent: null, tokens: null, window: null }));
    expect(decision.decision).toBe("skip");
    expect(decision.point).toBeNull();
  });
});

describe("the hard window respects mid-turn and cooldown vetoes", () => {
  it("vetoes the hard window mid-turn, even when also in cooldown", () => {
    const decision = decide(
      input(
        { lastCompaction: { at: at(1), failed: true }, recentSignals: [] },
        { percent: 60, tokens: 600_000, midTurn: true, turnsSinceCompaction: 0 },
      ),
    );
    expect(decision).toMatchObject({ decision: "veto", point: "window", reason: "midTurn" });
  });

  it.each([false, true])("vetoes the hard window during cooldown (last attempt failed: %s)", (failed) => {
    const decision = decide(input({ lastCompaction: { at: at(599.999), failed } }, { percent: 55, tokens: 550_000 }));
    expect(decision).toMatchObject({ decision: "veto", point: "window", reason: "cooldownSeconds" });
  });

  it("waits at least a minute after a failed attempt even with no cooldown, so a refusing provider is not asked in a loop", () => {
    expect(MIN_RETRY_AFTER_FAILURE_MS).toBe(60_000);
    const p = policy({ vetoes: { ...BASE.vetoes, cooldownSeconds: 0 } });
    const hard = { percent: 60, tokens: 600_000, turnsSinceCompaction: 0 };
    expect(decide(input({ policy: p, lastCompaction: { at: at(59), failed: true } }, hard))).toMatchObject({ decision: "veto", reason: "cooldownSeconds" });
    expect(blockers(input({ policy: p, lastCompaction: { at: at(59), failed: true } }, hard))[0]).toMatchObject({ veto: "cooldownSeconds", remainingSeconds: 1 });
    expect(decide(input({ policy: p, lastCompaction: { at: at(60), failed: true } }, hard))).toMatchObject({ decision: "compact", point: "window" });
    expect(decide(input({ policy: p, lastCompaction: { at: at(1), failed: false } }, hard))).toMatchObject({ decision: "compact", point: "window" });
  });

  it("compacts at the hard window when cooldown ends, ignoring the other three vetoes", () => {
    const p = policy({ window: { ...BASE.window, floorTokens: 650_000 } });
    const decision = decide(input(
      { policy: p, lastCompaction: { at: at(600), failed: true } },
      { percent: 55, tokens: 550_000, turnsSinceCompaction: 0 },
    ));
    expect(decision).toMatchObject({ decision: "compact", point: "window", reason: "window.hard" });
  });
});

describe("regular point vetoes", () => {
  it("vetoes a phase point mid-turn", () => {
    const decision = decide(input({ recentSignals: ["plan.approved"] }, { midTurn: true }));
    expect(decision).toMatchObject({ decision: "veto", point: "phase", reason: "midTurn" });
  });

  it("vetoes inside the cooldown", () => {
    const decision = decide(input({ lastCompaction: { at: at(60), failed: false }, recentSignals: ["tests.green"] }));
    expect(decision).toMatchObject({ decision: "veto", point: "phase", reason: "cooldownSeconds" });
  });

  it("compacts after the cooldown has passed", () => {
    const decision = decide(input({ lastCompaction: { at: at(700), failed: false }, recentSignals: ["tests.green"] }));
    expect(decision.decision).toBe("compact");
  });

  it("vetoes below the minimum turns between compactions", () => {
    const decision = decide(input({ recentSignals: ["pr.opened"] }, { turnsSinceCompaction: 2 }));
    expect(decision).toMatchObject({ decision: "veto", reason: "minTurnsBetween" });
  });

  it("vetoes a regular point until 30 minutes after a failed attempt", () => {
    expect(FAILED_BACKOFF_MS).toBe(30 * 60 * 1000);
    const recentSignals = ["tests.green"];
    const during = decide(input({ lastCompaction: { at: at(1799.999), failed: true }, recentSignals }));
    const after = decide(input({ lastCompaction: { at: at(1800), failed: true }, recentSignals }));
    expect(during).toMatchObject({ decision: "veto", reason: "previousCompactionFailed" });
    expect(after).toMatchObject({ decision: "compact", reason: "tests.green" });
  });

  it("vetoes below the token floor once a point fires", () => {
    const p = policy({ points: [{ id: "early", enabled: true, when: "agentHint", minPercent: 0 }] });
    const decision = decide(input({ policy: p, recentSignals: ["agentHint"] }, { percent: 4, tokens: 40_000 }));
    expect(decision).toMatchObject({ decision: "veto", point: "early", reason: "belowFloor" });
  });

  it("skips when no point fires, even inside the cooldown", () => {
    const decision = decide(input({ lastCompaction: { at: at(1), failed: false } }));
    expect(decision).toMatchObject({ decision: "skip", point: null });
  });
});

describe("each point fires", () => {
  it("phase: on a named boundary signal", () => {
    expect(decide(input({ recentSignals: ["plan.approved"] })).point).toBe("phase");
  });

  it("agent: on the agent hint", () => {
    expect(decide(input({ recentSignals: ["agentHint"] })).point).toBe("agent");
  });

  it("agent point respects its own disabled flag", () => {
    const p = policy();
    p.points = p.points.map((point) => (point.id === "agent" ? { ...point, enabled: false } : point));
    expect(decide(input({ policy: p, recentSignals: ["agentHint"] })).point).toBeNull();
  });

  it("volume: on tool result bytes over the threshold", () => {
    expect(decide(input({}, { toolResultBytes: 1_500_000 })).point).toBe("volume");
  });

  it("turns: on turns since compaction over the cap", () => {
    expect(decide(input({}, { turnsSinceCompaction: 60 })).point).toBe("turns");
  });

  it("idle: on idle seconds past the threshold and its own minPercent", () => {
    expect(decide(input({}, { idleSeconds: 300, percent: 30, tokens: 300_000 })).point).toBe("idle");
  });

  it("idle fires at 25% (its minPercent) even though the soft window is 35%", () => {
    expect(decide(input({}, { idleSeconds: 400, percent: 25, tokens: 250_000 })).point).toBe("idle");
  });

  it("idle does not fire below its minPercent", () => {
    expect(decide(input({}, { idleSeconds: 400, percent: 24, tokens: 240_000 })).point).toBeNull();
  });

  it("thrash: on sameFileRead>=3", () => {
    expect(decide(input({}, { sameFileReadMax: 3 })).point).toBe("thrash");
  });

  it("thrash: on sameCommandFailed>=2", () => {
    expect(decide(input({}, { sameCommandFailedMax: 2 })).point).toBe("thrash");
  });

  it("thrash: on subagentReportBytes>40000", () => {
    expect(decide(input({}, { subagentReportBytes: 40_001 })).point).toBe("thrash");
  });
});

describe("points are gated by the soft window and ordered by policy", () => {
  it("does not fire a point below the soft window", () => {
    const decision = decide(input({ recentSignals: ["tests.green"] }, { percent: 20, tokens: 200_000 }));
    expect(decision.decision).toBe("skip");
  });

  it("prefers the first point in policy order when several fire", () => {
    const decision = decide(
      input({ recentSignals: ["agentHint", "tests.green"] }, { toolResultBytes: 2_000_000, sameFileReadMax: 5 }),
    );
    expect(decision.point).toBe("phase");
  });

  it("respects a reordered policy", () => {
    const p = policy();
    p.points = [...p.points].reverse();
    const decision = decide(input({ policy: p, recentSignals: ["agentHint"] }, { sameFileReadMax: 5 }));
    expect(decision.point).toBe("thrash");
  });
});

describe("signal expressions", () => {
  it("matches >=, >, < and ==", () => {
    const snap = snapshot({ sameFileReadMax: 3, sameCommandFailedMax: 2, subagentReportBytes: 40_000 });
    expect(signalMatches("sameFileRead>=3", snap)).toBe(true);
    expect(signalMatches("sameFileRead>3", snap)).toBe(false);
    expect(signalMatches("sameFileRead>2", snap)).toBe(true);
    expect(signalMatches("sameCommandFailed<3", snap)).toBe(true);
    expect(signalMatches("subagentReportBytes==40000", snap)).toBe(true);
  });

  it("rejects unknown names and malformed expressions", () => {
    expect(signalMatches("nope>=1", snapshot())).toBe(false);
    expect(signalMatches("sameFileRead", snapshot())).toBe(false);
  });
});

describe("firstVeto order and nextCandidate", () => {
  it("reports vetoes in contract order", () => {
    const i = input(
      { lastCompaction: { at: at(1), failed: true } },
      { midTurn: true, turnsSinceCompaction: 0, percent: 4, tokens: 40_000 },
    );
    expect(firstVeto(i)).toBe("midTurn");
    expect(firstVeto({ ...i, snapshot: { ...i.snapshot, midTurn: false } })).toBe("cooldownSeconds");
    expect(
      firstVeto({ ...i, snapshot: { ...i.snapshot, midTurn: false }, lastCompaction: { at: at(9_000), failed: false } }),
    ).toBe("minTurnsBetween");
    expect(firstVeto({ ...i, snapshot: { ...i.snapshot, midTurn: false, turnsSinceCompaction: 10 }, lastCompaction: { at: at(9_000), failed: false } })).toBe("belowFloor");
    expect(firstVeto(input({}, { turnsSinceCompaction: 10 }))).toBeNull();
  });

  it("reports every blocker and the amount of time or turns remaining in veto order", () => {
    const i = input(
      { lastCompaction: { at: at(59.5), failed: true } },
      { midTurn: true, turnsSinceCompaction: 2, percent: 4, tokens: 40_000 },
    );
    expect(blockers(i)).toEqual([
      { veto: "midTurn", remainingSeconds: null, remainingTurns: null },
      { veto: "cooldownSeconds", remainingSeconds: 541, remainingTurns: null },
      { veto: "minTurnsBetween", remainingSeconds: null, remainingTurns: 3 },
      { veto: "previousCompactionFailed", remainingSeconds: 1741, remainingTurns: null },
      { veto: "belowFloor", remainingSeconds: null, remainingTurns: null },
    ]);
    expect(blockers({
      ...i,
      policy: policy({ vetoes: { midTurn: false, cooldownSeconds: 0, minTurnsBetween: 0, previousCompactionFailed: false, belowFloor: false } }),
    })).toEqual([{ veto: "cooldownSeconds", remainingSeconds: 1, remainingTurns: null }]);
    expect(blockers({
      ...i,
      lastCompaction: { at: at(60), failed: true },
      policy: policy({ vetoes: { midTurn: false, cooldownSeconds: 0, minTurnsBetween: 0, previousCompactionFailed: false, belowFloor: false } }),
    })).toEqual([]);
    expect(blockers(input({ lastCompaction: { at: at(1800), failed: true } }, { tokens: BASE.window.floorTokens, turnsSinceCompaction: 5 }))).toEqual([]);
  });

  it("nextCandidate names the next firing point ignoring vetoes", () => {
    expect(nextCandidate(input({ recentSignals: ["tests.green"] }, { midTurn: true }))).toEqual({ point: "phase", reason: "tests.green" });
    expect(nextCandidate(input({}, { percent: 70, tokens: 700_000 }))).toEqual({ point: "window", reason: "window.hard" });
    expect(nextCandidate(input())).toBeNull();
  });

  it.each([{ tokens: null }, { window: null }, { window: 0 }])("the candidate and decision both require usable usage: %j", (patch) => {
    const i = input({ recentSignals: ["tests.green"] }, patch);
    expect(decide(i).decision).toBe("skip");
    expect(nextCandidate(i)).toBeNull();
  });
});