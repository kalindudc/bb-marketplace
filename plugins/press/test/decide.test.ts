import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Policy } from "../src/policy";
import { decide, firstVeto, nextCandidate, signalMatches, type DecideInput, type Snapshot } from "../src/decide";

const WINDOW = 1_000_000;

function policy(patch: Partial<Policy> = {}): Policy {
  return { ...DEFAULT_POLICY, ...patch };
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

  it("skips without usage", () => {
    const decision = decide(input({}, { percent: null, tokens: null, window: null }));
    expect(decision.decision).toBe("skip");
    expect(decision.point).toBeNull();
  });
});

describe("hard window first, then vetoes, then points in order", () => {
  it("compacts on the hard window even mid-turn, in cooldown, below the floor", () => {
    const decision = decide(
      input(
        { lastCompaction: { at: at(1), failed: true }, recentSignals: [] },
        { percent: 60, tokens: 600_000, midTurn: true, turnsSinceCompaction: 0 },
      ),
    );
    expect(decision).toMatchObject({ decision: "compact", point: "window", reason: "window.hard" });
  });

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

  it("vetoes when the previous compaction failed", () => {
    const decision = decide(input({ lastCompaction: { at: at(9_000), failed: true }, recentSignals: ["tests.green"] }));
    expect(decision).toMatchObject({ decision: "veto", reason: "previousCompactionFailed" });
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
    expect(decide(input({ recentSignals: ["journal.entry.done"] })).point).toBe("phase");
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

  it("nextCandidate names the next firing point ignoring vetoes", () => {
    expect(nextCandidate(input({ recentSignals: ["tests.green"] }))).toEqual({ point: "phase", reason: "tests.green" });
    expect(nextCandidate(input({}, { percent: 70, tokens: 700_000 }))).toEqual({ point: "window", reason: "window.hard" });
    expect(nextCandidate(input())).toBeNull();
  });
});