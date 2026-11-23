import { describe, expect, it } from "vitest";
import { thresholdMarks } from "../../src/ui/gauge";
import { agoText, bytesText, clockText, reasonText } from "../../src/ui/model";
import { announcement } from "../../src/ui/next-step";
import { overridesText } from "../../src/ui/points";
import {
  decisionPath, decisionRows, deriveState, detectLanding, dropChart, historyOutcome, needsClock, nextStep, totalsText, type Landing,
} from "../../src/ui/runway";
import { compaction, decision, states, status } from "./fixtures";

const NOW = Date.parse("2026-11-24T15:06:00.000Z");
const S = states(NOW);
const step = (d = S.healthy, landing: Landing | null = null, elapsed = 0) => nextStep(d, deriveState(d, landing), landing, NOW, elapsed);
const path = (d = S.healthy, elapsed = 0) => decisionPath(d, deriveState(d, null), elapsed);

describe("state word", () => {
  it("names each state the panel draws, in Press's order of precedence", () => {
    expect(deriveState(S.noUsage, null)).toMatchObject({ key: "unknown", word: "No usage yet" });
    expect(deriveState(S.held, null)).toMatchObject({ key: "held", word: "Holding", tone: "attn" });
    expect(deriveState(S.compacting, null)).toMatchObject({ key: "compacting", word: "Compacting" });
    expect(deriveState(S.blocked, null)).toMatchObject({ key: "backstop", word: "Backstop due", tone: "bad" });
    expect(deriveState(S.vetoed, null)).toMatchObject({ key: "blocked", word: "Blocked" });
    expect(deriveState(status({ percent: 60, tokens: 240_000 }), null)).toMatchObject({ key: "range", word: "In compact range" });
    expect(deriveState(S.healthy, null)).toMatchObject({ key: "safe", word: "Safe" });
  });

  it("shows a landing or a failure only until Press is busy again", () => {
    const row = S.history.history[0]!;
    expect(deriveState(S.healthy, { outcome: "ok", row, fromPercent: 82, wasHeld: true })).toMatchObject({ key: "landed", word: "Safe", glyph: "check" });
    expect(deriveState(status({ percent: 85, tokens: 340_000 }), { outcome: "ok", row, fromPercent: 90, wasHeld: false })).toMatchObject({ key: "landed", word: "Backstop due", glyph: "alert" });
    expect(deriveState(S.healthy, { outcome: "failed", row, fromPercent: 82, wasHeld: false })).toMatchObject({ key: "failed", tone: "bad" });
    expect(deriveState(S.held, { outcome: "ok", row, fromPercent: 82, wasHeld: true }).key).toBe("held");
  });
});

describe("next step", () => {
  it("holds with an elapsed bar against Press's estimate, and counts several held messages", () => {
    const held = step(S.held);
    expect(held).toMatchObject({ title: "Holding your next message", since: S.held.held!.since, expectedMs: 147_000, expectedWord: "about" });
    expect(held.sub).toBe("Compacting first, sends when it lands · about 2:27");
    expect(step(status({ ...S.held, held: { ...S.held.held!, count: 2 } })).title).toBe("Holding 2 messages");
  });

  it("falls back to the thread's average, then to 'first compaction'", () => {
    expect(step(S.compacting)).toMatchObject({ title: "Compacting · phase", expectedWord: "usually", expectedMs: 89_500 });
    const first = step(status({ percent: 70, tokens: 280_000, compacting: { since: new Date(NOW).toISOString(), point: null } }));
    expect(first.title).toBe("Compacting");
    expect(first.sub).toMatch(/· first compaction$/);
  });

  it("closes a landing with what it freed and says when a held message went out", () => {
    const row = compaction(NOW, 0, "window", 328_000, 76_000, 101_000);
    const landed = step(status({ percent: 19, tokens: 76_000, history: [row] }), { outcome: "ok", row, fromPercent: 82, wasHeld: true });
    expect(landed.title).toBe(`Compacted · freed ${(252_000).toLocaleString()} in 1:41`);
    expect(landed.sub).toBe("82% to 19% · held message released");
    const failedRow = { ...row, outcome: "failed" as const, error: "provider refused", tokensAfter: null, ms: null };
    expect(step(S.healthy, { outcome: "failed", row: failedRow, fromPercent: 82, wasHeld: false })).toMatchObject({ title: "Compaction failed", sub: "provider refused" });
  });

  it("past force at, says what happens when the turn ends, by mode", () => {
    expect(step(S.backstopRunning)).toMatchObject({ title: "Compacts when this turn ends", tone: "bad" });
    expect(step(status({ ...S.backstopRunning, mode: "advisor" })).title).toBe("Proposes compacting when this turn ends");
    expect(step(status({ ...S.backstopRunning, mode: "observe" })).sub).toBe("Observe records only, nothing compacts");
  });

  it("past force at and idle, counts down a cooldown, which force at waits out", () => {
    const cooling = step(S.blocked, null, 40);
    expect(cooling).toMatchObject({ title: "Compacts in 3:20", countdown: 200 });
    expect(cooling.sub).toBe("Force at waits out the cooldown");
    const idle = status({ ...S.blocked, blockers: [{ veto: "minTurnsBetween", remainingSeconds: null, remainingTurns: 1 }] });
    expect(step(idle).title).toBe("Compacts before the next turn");
    expect(step(status({ ...idle, mode: "advisor" })).title).toBe("Proposes compacting now");
    expect(step(status({ ...idle, mode: "observe" })).title).toBe("Would compact now");
  });

  it("names a veto, the next point, or how far the thread is from compact at", () => {
    expect(step(S.vetoed)).toMatchObject({ title: "Phase vetoed by min turns", sub: "1 turn left · force at 80% still applies" });
    const range = status({ percent: 60, tokens: 240_000, nextPoint: "phase", mode: "observe" });
    expect(step(range)).toMatchObject({ title: "Next point: phase", sub: `${(80_000).toLocaleString()} tokens to force at · observe records only` });
    const off = status({ ...range, points: { phase: false, agent: false, volume: false, turns: false, idle: false, thrash: false } });
    expect(step(off).title).toBe("All points off · force at only");
    expect(step(S.healthy)).toMatchObject({ title: `${(132_000).toLocaleString()} tokens until compact at`, sub: "Never compacted · 12 turns" });
    expect(step(S.history).sub).toBe("Last compaction 1 h 26 min ago · 9 turns · advisor proposes, you compact");
    expect(step(S.noUsage).title).toBe("Waiting for the first usage report");
  });

  it("dates the last compaction from the newest one that landed, never a failed attempt (F37)", () => {
    const failed = compaction(NOW, 2, "volume", 250_000, null, null, { outcome: "failed", error: "refused", hasSummary: false });
    const landed = compaction(NOW, 86, "phase", 247_900, 60_200, 96_000);
    const d = status({ percent: 30, tokens: 120_000, turnsSince: 4, history: [failed, landed] });
    expect(d.lastCompaction?.id).toBe(landed.id);
    expect(step(d).sub).toBe("Last compaction 1 h 26 min ago · 4 turns");
    expect(historyOutcome(d.history[0]!)).toBe("failed");
  });

  it("announces state changes without a number that changes while a turn runs", () => {
    expect(announcement(step(S.healthy), deriveState(S.healthy, null))).toBe("Safe.");
    expect(announcement(step(S.held), deriveState(S.held, null))).toBe("Holding. Holding your next message.");
    expect(announcement(step(S.blocked, null, 40), deriveState(S.blocked, null))).toBe("Backstop due. Compacts after the wait.");
  });
});

describe("decision path", () => {
  it("past force at, strikes the vetoes it overrides and keeps the cooldown that holds it", () => {
    const [force, vetoes, points] = path(S.blocked, 40);
    expect(force).toMatchObject({ state: "bad", lines: [{ text: "reached · 83%" }, { text: "waits for the cooldown" }] });
    expect(vetoes!.lines).toEqual([
      { text: "cooldown · 3:20 left", strong: true },
      { text: "min turns · 1 turn left", struck: true },
      { text: "overridden by force at", strong: true },
    ]);
    expect(points!.lines).toEqual([{ text: "skipped, force at first" }]);
  });

  it("never claims force at overrides a running turn", () => {
    const [force, vetoes] = path(S.backstopRunning);
    expect(force!.lines[1]).toEqual({ text: "fires when this turn ends" });
    expect(vetoes!.lines[0]).toEqual({ text: "mid-turn · until this turn ends", strong: true });
    expect(vetoes!.lines[1]).toEqual({ text: "min turns · 1 turn left", struck: true });
  });

  it("below force at, lists vetoes plainly and says how far force at is", () => {
    const [force, vetoes, points] = path(S.vetoed);
    expect(force!.lines).toEqual([{ text: `not reached · ${(76_000).toLocaleString()} tokens away` }]);
    expect(vetoes!.lines).toEqual([{ text: "min turns · 1 turn left" }]);
    expect(points!.lines).toEqual([{ text: "next: phase" }]);
    expect(path(S.healthy)[1]!.lines).toEqual([{ text: `below floor · ${(62_000).toLocaleString()} short` }]);
    expect(path(S.healthy)[2]!.lines).toEqual([{ text: "closed until 55%" }]);
  });

  it("while compacting, shows what fired and that the vetoes passed", () => {
    const [force, vetoes, points] = path(S.held);
    expect(force).toMatchObject({ state: "live", lines: [{ text: "reached · 82%" }, { text: "compacting now" }] });
    expect(vetoes!.lines).toEqual([{ text: "passed" }]);
    expect(points!.lines).toEqual([{ text: "skipped, force at first" }]);
    const vetoedFirst = path(status({ ...S.backstopRunning, decisions: [S.held.decisions[1]!] }));
    expect(vetoedFirst[2]!.lines[0]!.text).toMatch(/^tool volume fired \d\d:\d\d · vetoed$/);
    const phase = path(S.compacting);
    expect(phase[2]).toMatchObject({ state: "live" });
    expect(phase[2]!.lines[0]!.text).toMatch(/^phase fired \d\d:\d\d$/);
    const manual = path(status({ ...S.compacting, compacting: { since: new Date(NOW).toISOString(), point: "manual" } }));
    expect(manual[1]!.lines).toEqual([{ text: "skipped, you asked" }]);
    expect(manual[2]!.lines[0]!.text).toMatch(/^skipped, you compacted at /);
    expect(path(S.noUsage)[0]!.lines).toEqual([{ text: "usage not reported" }]);
  });

  it("writes decisions as words, not signal expressions", () => {
    const rows = decisionRows(status({ decisions: [
      { at: new Date(NOW).toISOString(), decision: "compact", point: "volume", reason: "toolResultBytes>=1500000", percent: 75.4 },
      { at: new Date(NOW).toISOString(), decision: "veto", point: "thrash", reason: "cooldownSeconds", percent: 61 },
      { at: new Date(NOW).toISOString(), decision: "compact", point: "window", reason: "window.hard", percent: 81 },
    ] }));
    expect(rows.map((row) => [row.what, row.detail, row.percent])).toEqual([
      ["Compact", "tool volume · 1.5 MB result", "75%"], ["Veto", "thrash · cooldown", "61%"], ["Compact", "force at 80%", "81%"],
    ]);
    expect(rows[1]!.full).toBe("Thrash point fired at 61%, vetoed by cooldown");
  });
});

describe("landing", () => {
  const row = compaction(NOW, 0, "window", 328_000, 76_000, 101_000);

  it("spots a compaction that settled between two reads", () => {
    const after = status({ percent: 19, tokens: 76_000, history: [row, ...S.held.history] });
    expect(detectLanding(S.held, after)).toEqual({ outcome: "ok", row: after.history[0], fromPercent: 82, wasHeld: true });
    const pending = status({ ...S.compacting, history: [{ ...row, outcome: "pending", tokensAfter: null }, ...S.compacting.history] });
    const settled = status({ percent: 19, tokens: 76_000, history: [row, ...S.compacting.history] });
    expect(detectLanding(pending, settled)).toMatchObject({ outcome: "ok", wasHeld: false, fromPercent: 78 });
    expect(detectLanding(S.held, status({ history: [{ ...row, outcome: "failed", error: "refused" }] }))).toMatchObject({ outcome: "failed" });
  });

  it("ignores the first read, another thread, an unchanged history and a running compaction", () => {
    const after = status({ percent: 19, tokens: 76_000, history: [row] });
    expect(detectLanding(undefined, after)).toBeNull();
    expect(detectLanding(status({ ...S.held, threadId: "thr_other" }), after)).toBeNull();
    expect(detectLanding(after, status({ ...after, percent: 20 }))).toBeNull();
    expect(detectLanding(S.healthy, S.held)).toBeNull();
  });
});

describe("history", () => {
  it("charts one drop per landed compaction against a time axis that ends now", () => {
    const chart = dropChart(S.history, NOW)!;
    expect(chart.drops).toHaveLength(5);
    expect(chart.drops[0]!.x).toBe(0);
    expect(chart.drops[0]!.before).toBeCloseTo(59.2, 6);
    expect(chart.drops[0]!.after).toBeCloseTo(14.6, 6);
    expect(chart.drops.at(-1)!.x).toBeCloseTo((394 - 86) / 394 * 100, 5);
    expect(chart.now).toEqual({ x: 100, percent: 41 });
    expect(chart.label).toMatch(/^5 compactions from \d\d:\d\d to \d\d:\d\d, each a drop from tokens before to tokens after; now 41%$/);
    expect(dropChart(S.noUsage, NOW)).toBeNull();
    expect(dropChart(S.healthy, NOW)).toBeNull();
  });

  it("totals and row outcomes read as facts", () => {
    expect(totalsText(S.history)).toBe("5 compactions · 964k freed · 1:40 average");
    expect(totalsText(S.healthy)).toBe("0 compactions · 0k freed");
    expect(S.history.history.map(historyOutcome)).toEqual(["247k to 60k", "322k to 74k", "228k to 55k", "failed", "241k to 63k", "236k to 58k"]);
    expect(historyOutcome({ ...S.history.history[0]!, outcome: "pending" })).toBe("running");
  });

  it("ticks a clock only while something on screen counts", () => {
    expect(needsClock(S.healthy)).toBe(false);
    expect(needsClock(S.held)).toBe(true);
    expect(needsClock(S.blocked)).toBe(true);
    expect(needsClock(S.vetoed)).toBe(false);
  });
});

describe("gauge marks", () => {
  const place = (softPercent: number, hardPercent: number, floorTokens = 150_000, window = 400_000) =>
    Object.fromEntries(thresholdMarks({ window, thresholds: { softPercent, hardPercent, floorTokens } }).map((mark) => [mark.id, [mark.label, mark.alignEnd]]));

  it("labels floor, compact at and force at to the right of their ticks when there is room", () => {
    expect(thresholdMarks(S.healthy).map((mark) => [mark.id, mark.value, mark.label, mark.alignEnd])).toEqual([
      ["floor", "150k", true, false], ["soft", "55%", true, false], ["hard", "80%", true, false],
    ]);
    expect(thresholdMarks({ window: 100_000, thresholds: S.healthy.thresholds }).map((mark) => mark.id)).toEqual(["soft", "hard"]);
  });

  it("hangs a label left of its tick near the end or beside a neighbour, and hides only what fits neither way", () => {
    expect(place(55, 90)).toEqual({ floor: [true, false], soft: [true, false], hard: [true, true] });
    expect(place(75, 80)).toEqual({ floor: [true, false], soft: [true, true], hard: [true, false] });
    expect(place(80, 90)).toEqual({ floor: [true, false], soft: [false, false], hard: [true, true] });
    expect(place(55, 80, 150_000, 200_000).floor).toEqual([false, false]);
  });
});

describe("words", () => {
  it("turns Press's reasons and sizes into plain words", () => {
    expect(reasonText("idleSeconds>=300")).toBe("idle 5 min");
    expect(reasonText("turnsSinceCompaction>=60")).toBe("60 turns");
    expect(reasonText("sameFileRead>=3")).toBe("same file read 3 times");
    expect(reasonText("sameCommandFailed>=1")).toBe("same command failed 1 time");
    expect(reasonText("subagentReportBytes>40000")).toBe("subagent report over 40 KB");
    expect(reasonText("tests.green")).toBe("tests green");
    expect(reasonText("something.new")).toBe("something.new");
    expect(reasonText(null)).toBeNull();
    expect(bytesText(512)).toBe("512 B");
    expect(clockText(3_725)).toBe("1:02:05");
    expect(clockText(-4)).toBe("0:00");
    expect(agoText(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe("3 d ago");
    expect(overridesText({ mode: true, points: ["thrash", "idle"] })).toBe("Mode and 2 points set for this thread");
    expect(overridesText({ mode: false, points: [] })).toBeNull();
  });
});

describe("review round 2", () => {
  const midTurn = { veto: "midTurn" as const, remainingSeconds: null, remainingTurns: null };
  const belowFloor = { veto: "belowFloor" as const, remainingSeconds: null, remainingTurns: null };

  // A compaction failed at 84% six minutes ago; the person sent the next message and that turn runs.
  const failedAt84 = compaction(NOW, 6, "window", 336_000, null, null, { outcome: "failed", error: "provider refused", hasSummary: false });
  const runningInCooldown = status({
    percent: 84, tokens: 336_000, running: true, nextPoint: "window", turnsSince: 9, history: [failedAt84],
    blockers: [midTurn, { veto: "cooldownSeconds", remainingSeconds: 240, remainingTurns: null },
      { veto: "previousCompactionFailed", remainingSeconds: 1_440, remainingTurns: null }],
    decisions: [decision(NOW, 360, "compact", "window", "window.hard", 84)],
  });

  it("past force at during a turn, waits for the cooldown too while one is left (R10)", () => {
    const waiting = step(runningInCooldown, null, 40);
    expect(waiting).toMatchObject({ title: "Compacts after this turn and the cooldown", sub: "Cooldown 3:20 left", tone: "bad" });
    expect(step(status({ ...runningInCooldown, mode: "advisor" }), null, 40)).toMatchObject({
      title: "Proposes compacting after this turn and the cooldown", sub: "Cooldown 3:20 left · advisor proposes, you compact" });
    expect(step(status({ ...runningInCooldown, mode: "observe" }), null, 40).title).toBe("Would compact after this turn and the cooldown");
    const [force, vetoes] = path(runningInCooldown, 40);
    expect(force!.lines).toEqual([{ text: "reached · 84%" }, { text: "waits for the turn and the cooldown" }]);
    expect(vetoes!.lines).toEqual([
      { text: "mid-turn · until this turn ends", strong: true },
      { text: "cooldown · 3:20 left", strong: true },
      { text: "last compaction failed · 23:20 left", struck: true },
      { text: "overridden by force at", strong: true },
    ]);
    expect(announcement(waiting, deriveState(runningInCooldown, null))).toBe("Backstop due. Compacts after this turn and the cooldown.");
  });

  it("once the cooldown has run out during the turn, says the turn's end is all that is left (R10)", () => {
    expect(step(runningInCooldown, null, 240).title).toBe("Compacts when this turn ends");
    expect(path(runningInCooldown, 240)[0]!.lines[1]).toEqual({ text: "fires when this turn ends" });
    // Idle with the cooldown just spent: nothing is left to wait for, so no "Compacts in 0:00".
    expect(step(S.blocked, null, 240).title).toBe("Compacts before the next turn");
  });

  const IDLE_ON = { phase: true, agent: true, volume: true, turns: false, idle: true, thrash: false };

  it("opens the points at the lowest minimum of the enabled points, not at compact at (R17)", () => {
    // The idle point (minPercent 25) is on; at 30% of a 1M window the thread has not sat idle long enough yet.
    const idleOn = status({ percent: 30, tokens: 300_000, window: 1_000_000, points: IDLE_ON, turnsSince: 6 });
    expect(idleOn.pointsFromPercent).toBe(25);
    expect(deriveState(idleOn, null)).toMatchObject({ key: "range", word: "In compact range" });
    expect(step(idleOn).title).toBe("Compacts when a point fires");
    expect(path(idleOn)[2]!.lines).toEqual([{ text: "none fired yet" }]);
    // Below that minimum the gate is closed until it, and the safe step counts the tokens to it.
    const below = status({ ...idleOn, percent: 20, tokens: 200_000 });
    expect(deriveState(below, null)).toMatchObject({ key: "safe" });
    expect(path(below)[2]!.lines).toEqual([{ text: "closed until 25%" }]);
    expect(step(below).title).toBe(`${(50_000).toLocaleString()} tokens until points open`);
    // Once idle fires it is named, and the floor's veto reads as blocked on a 400k window.
    expect(step(status({ ...idleOn, nextPoint: "idle" })).title).toBe("Next point: idle");
    const floored = status({ percent: 30, tokens: 120_000, points: IDLE_ON, nextPoint: "idle", blockers: [belowFloor],
      decisions: [decision(NOW, 30, "veto", "idle", "belowFloor", 30)] });
    expect(deriveState(floored, null)).toMatchObject({ key: "blocked" });
    expect(step(floored).title).toBe("Idle vetoed by below floor");
  });

  it("keeps the points closed past compact at when every enabled point sets a higher minimum (R17)", () => {
    // A policy file gives the only enabled point, phase, a minimum of 70%.
    const phaseOnly = { phase: true, agent: false, volume: false, turns: false, idle: false, thrash: false };
    const d = status({ percent: 60, tokens: 240_000, points: phaseOnly }, { pointsFromPercent: 70 });
    expect(deriveState(d, null)).toMatchObject({ key: "safe" });
    expect(path(d)[2]!.lines).toEqual([{ text: "closed until 70%" }]);
    expect(step(d).title).toBe(`${(40_000).toLocaleString()} tokens until points open`);
  });

  it("with every point off, still reads force at as all that is left from compact at (R17)", () => {
    const allOff = { phase: false, agent: false, volume: false, turns: false, idle: false, thrash: false };
    const d = status({ percent: 60, tokens: 240_000, points: allOff });
    expect(d.pointsFromPercent).toBe(80);
    expect(deriveState(d, null)).toMatchObject({ key: "range" });
    expect(step(d).title).toBe("All points off · force at only");
    expect(path(d)[2]!.lines).toEqual([{ text: "all off for this thread" }]);
  });

  it("names the veto in force now, not an old decision's (R25)", () => {
    // 200k window: the 150k floor sits at 75%. A phase point was vetoed mid-turn hours ago at 58%.
    const stale = status({ percent: 62, tokens: 124_000, window: 200_000, turnsSince: 14, blockers: [belowFloor],
      decisions: [decision(NOW, 4 * 3_600, "veto", "phase", "midTurn", 58)] });
    expect(deriveState(stale, null)).toMatchObject({ key: "blocked", word: "Blocked" });
    expect(step(stale)).toMatchObject({ title: "Points vetoed by below floor", sub: `${(26_000).toLocaleString()} short · force at 80% still applies` });
    // A veto that names a current blocker but predates the newest compaction is from the last stretch.
    const old = status({ ...S.vetoed, decisions: [decision(NOW, 7 * 60, "veto", "thrash", "minTurnsBetween", 58)] });
    expect(step(old).title).toBe("Points vetoed by min turns");
    // The newest decision is cited when it names a current blocker and came after the last compaction.
    expect(step(S.vetoed)).toMatchObject({ title: "Phase vetoed by min turns", sub: "1 turn left · force at 80% still applies" });
  });

  it("during a turn, only the vetoes that outlast the turn could block, so the panel shows the range (R25)", () => {
    const running = status({ percent: 62, tokens: 248_000, running: true, nextPoint: null, blockers: [midTurn],
      decisions: [decision(NOW, 20, "veto", "phase", "midTurn", 62)] });
    expect(deriveState(running, null)).toMatchObject({ key: "range" });
  });

  it("says Press is off for a provider its policy switches off (R1)", () => {
    const off = status({ ...S.blocked, providerEnabled: false });
    expect(deriveState(off, null)).toMatchObject({ key: "off", word: "Off", tone: "none" });
    expect(step(off)).toMatchObject({ title: "Press is off for this provider", sub: "Set in Press policy · Press never compacts or holds this thread" });
    const [force, vetoes, points] = path(off);
    expect(force).toMatchObject({ state: "idle", lines: [{ text: "reached · 83%" }, { text: "off for this provider" }] });
    expect(vetoes!.lines).toEqual([{ text: "cooldown · 4:00 left" }, { text: "min turns · 1 turn left" }]);
    expect(points!.lines).toEqual([{ text: "off for this provider" }]);
    // A compaction already under way still shows as one.
    expect(deriveState(status({ ...S.compacting, providerEnabled: false }), null).key).toBe("compacting");
  });

  it("reads a thread whose last turn failed like an idle one: Press compacts before its next turn (R2)", () => {
    // The service serves a thread in `error` as not running, with no mid-turn blocker.
    const errored = status({ percent: 85, tokens: 340_000, running: false, nextPoint: "window", blockers: [] });
    expect(step(errored).title).toBe("Compacts before the next turn");
    expect(path(errored)[0]!.lines[1]).toEqual({ text: "fires before the next turn" });
  });
});
