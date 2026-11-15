import Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/server/settings/store";
import { evaluateRules, runTuner, TUNING_RULES, type TuningSignals } from "../../src/server/settings/tuner";
import { TUNABLES, TUNABLE_KEYS, settingsSchema } from "../../src/shared/settings";
import { LIMITS } from "../../src/server/limits";
import { MIGRATIONS } from "../../src/server/migrations";
import type { Database } from "../../src/server/ports";

const databases: Sqlite.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const many = (value: number) => Array.from({ length: 20 }, () => value);
const signals = (): TuningSignals => ({ ticks: 100, held: 60, deferred: 40, typingHolds: 30, afterMessageHolds: 30,
  keeperTurnSeconds: many(90), reportIntervals: many(45 * 60).map(seconds => ({ classId: "smith", seconds })),
  staleStrikes: 20, lateReportsAfterStrike: 5, releases: 5, reportsPerMinute: many(10),
  restatementBytes: many(22000), restatementClipped: 10, tickFactChars: many(18000), factsClipped: 10,
  rangerMinutes: many(18), rangerOverruns: 5 });
function fixture(mode: "apply" | "suggest" | "off") {
  const db = new Sqlite(":memory:"); databases.push(db); db.exec(MIGRATIONS.join("\n"));
  let now = 1_800_000_000_000;
  const store = new SettingsStore(db as unknown as Database, () => now);
  if (mode !== "off") store.update({ revision: 0, patch: { tuning: { mode } }, why: "Enable" });
  return { store, advance: (ms: number) => { now += ms; } };
}

describe("deterministic tuning", () => {
  it("hand edits become the unpinned baseline and Undo restores a prior tuned override", () => {
    const { store } = fixture("apply");
    store.applyTuned({ tickSeconds: 120 }, "Earlier tuning", { section: "reliability", chart: "ticks" });
    const edit = store.update({ revision: store.snapshot().revision, patch: { knobs: { tickSeconds: 80 } }, why: "My value" })!;
    expect(store.read().knobs.tickSeconds).toBe(80);
    expect(store.snapshot().pinned.tickSeconds).toBeUndefined();
    expect(store.snapshot().tuned.tickSeconds).toBeUndefined();
    expect(edit.by).toBe("user");
    store.undo(edit.id, "Undo manual edit");
    expect(store.read().knobs.tickSeconds).toBe(120);
    expect(store.snapshot().tuned.tickSeconds).toBe(120);
  });
  it("editing an already pinned knob changes its value without unlocking it", () => {
    const { store } = fixture("apply");
    store.update({ revision: store.snapshot().revision, patch: {}, pins: { tickSeconds: 75 }, why: "Pin" });
    store.update({ revision: store.snapshot().revision, patch: { knobs: { tickSeconds: 95 } }, why: "Edit pin" });
    expect(store.read().knobs.tickSeconds).toBe(95);
    expect(store.snapshot().pinned.tickSeconds).toBe(95);
    runTuner(store, "after-pin-edit", signals());
    expect(store.read().knobs.tickSeconds).toBe(95);
  });
  it("the next eligible tuner run adapts from a hand edit rather than the previous tuned value", () => {
    const { store, advance } = fixture("apply");
    store.applyTuned({ tickSeconds: 120 }, "Earlier tuning", { section: "reliability", chart: "ticks" });
    store.update({ revision: store.snapshot().revision, patch: { knobs: { tickSeconds: 80 } }, why: "My value" });
    advance(LIMITS.tuningCooldownMs);
    const evidence = signals(); evidence.keeperTurnSeconds = [];
    const proposals = runTuner(store, "after-edit", evidence);
    expect(proposals.find(p => p.key === "tickSeconds")?.value).toBe(100);
    expect(store.read().knobs.tickSeconds).toBe(100);
  });
  it.each(TUNABLE_KEYS)("has a bounded, evidence-backed rule for %s", key => {
    const settings = settingsSchema.parse({});
    const proposal = evaluateRules(settings.knobs, signals()).find(row => row.key === key)!;
    expect(proposal).toBeDefined();
    expect(proposal.value).toBeGreaterThan(settings.knobs[key]);
    expect(proposal.value).toBeLessThanOrEqual(TUNABLES[key].max);
    expect(proposal.reason.length).toBeGreaterThan(10);
    expect(proposal.evidence.facts).toBeDefined();
  });
  it("keeps the Ranger ceiling as a user-only budget outside every tuner and override", () => {
    const { store } = fixture("apply");
    expect(TUNABLE_KEYS).not.toContain("rangerTimeboxMaxMinutes"); expect(TUNING_RULES).not.toHaveProperty("rangerTimeboxMaxMinutes");
    expect(() => store.applyTuned({ rangerTimeboxMaxMinutes: 30 } as never, "Not pacing", { section: "party", chart: "ranger-time" })).toThrow();
    expect(() => store.override("q1", "keeper", { rangerTimeboxMaxMinutes: 30 } as never, "Not pacing")).toThrow();
    store.update({ revision: store.snapshot().revision, patch: { knobs: { rangerTimeboxMaxMinutes: 24 } }, why: "User budget" });
    runTuner(store, "daily:budget", signals());
    expect(store.read().knobs.rangerTimeboxMaxMinutes).toBe(24); expect(store.snapshot().rows.some(row => String(row.key) === "rangerTimeboxMaxMinutes")).toBe(false);
  });
  it("never tunes from insufficient data or reduces a reliability allowance", () => {
    const input = signals();
    input.ticks = 1; input.keeperTurnSeconds = []; input.reportIntervals = []; input.staleStrikes = 1;
    input.reportsPerMinute = []; input.restatementBytes = []; input.tickFactChars = []; input.rangerMinutes = [];
    expect(evaluateRules(settingsSchema.parse({}).knobs, input)).toEqual([]);
    const maximum = Object.fromEntries(TUNABLE_KEYS.map(key => [key, TUNABLES[key].max])) as ReturnType<typeof settingsSchema.parse>["knobs"];
    expect(evaluateRules(maximum, signals())).toEqual([]);
  });
  it("off means no machine changes; suggest only proposes; apply records reversible decisions", () => {
    const off = fixture("off").store;
    expect(runTuner(off, "daily:2027-01-15", signals())).toEqual([]);
    expect(off.snapshot().tuned).toEqual({});
    const suggest = fixture("suggest").store;
    expect(runTuner(suggest, "daily:2027-01-15", signals())).toHaveLength(TUNABLE_KEYS.length);
    expect(suggest.snapshot().suggestions).toHaveLength(TUNABLE_KEYS.length);
    expect(suggest.snapshot().tuned).toEqual({});
    const apply = fixture("apply").store;
    expect(runTuner(apply, "returned:q1", signals())).toHaveLength(TUNABLE_KEYS.length);
    expect(apply.snapshot().history.filter(row => row.by === "tavern")).toHaveLength(TUNABLE_KEYS.length);
    expect(apply.snapshot().history[0]!.undoable).toBe(true);
    expect(runTuner(apply, "returned:q1", signals())).toEqual([]);
  });
  it("pins win and Undo cannot provoke an immediate reapplication", () => {
    const { store, advance } = fixture("apply");
    store.update({ revision: store.snapshot().revision, patch: {}, pins: { tickSeconds: 60 }, why: "Pin" });
    runTuner(store, "returned:q1", signals());
    expect(store.read().knobs.tickSeconds).toBe(60);
    const decision = store.snapshot().history.find(row => row.by === "tavern" && row.changes.some(change => change.key === "tuned.staleMinutes"))!;
    store.undo(decision.id, "Not helpful");
    advance(60_000);
    expect(runTuner(store, "returned:q2", signals()).some(row => row.key === "staleMinutes")).toBe(false);
    expect(store.read().knobs.staleMinutes).toBe(20);
  });
});
