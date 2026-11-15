import Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { settingsSchema, settingsPatchSchema, settingsSnapshotSchema, TUNABLES } from "../../src/shared/settings";
import { SettingsStore, SettingsConflict } from "../../src/server/settings/store";
import { exportToml, previewToml } from "../../src/server/settings/toml";
import { MIGRATIONS } from "../../src/server/migrations";
import type { Database } from "../../src/server/ports";

const databases: Sqlite.Database[] = [];
function fixture() {
  const db = new Sqlite(":memory:");
  databases.push(db);
  db.exec(MIGRATIONS.join("\n"));
  let now = 1_800_000_000_000;
  const store = new SettingsStore(db as unknown as Database, () => now++);
  return { db, store };
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe("settings compatibility and validation", () => {
  it("keeps today's defaults, units, opt-in timers and unlimited history", () => {
    const settings = settingsSchema.parse({});
    expect(settings.knobs).toEqual({ tickSeconds: 60, typingHoldSeconds: 45, afterMessageHoldSeconds: 60,
      staleMinutes: 20, reportBatchSeconds: 60, rangerTimeboxMaxMinutes: 12 });
    expect(settings.keepers).toMatchObject({ staleStrikes: 2, restatementBytes: 28000, tickFactChars: 14000 });
    expect(settings.data).toEqual({ historyDays: 0, autoArchiveDays: 0, backupKeep: 14 });
    expect(settings.keepers.decisionTimerMax).toBe(10080);
    expect(settings.tuning.mode).toBe("off");
    expect(settings.tavern.paused).toBe(false);
  });
  it("ignores obsolete stored keys, defaults invalid leaves and preserves valid siblings with warnings", () => {
    const { db } = fixture(), warnings: string[] = [];
    const store = new SettingsStore(db as unknown as Database, Date.now, undefined, message => { warnings.push(message); });
    db.prepare("UPDATE tavern_settings SET data=? WHERE id=1").run(JSON.stringify({
      user: { removedSection: true, attention: { reviewBudget: 7, renamedSetting: true }, knobs: { tickSeconds: 90, typingHoldSeconds: "old-format", rangerTimeboxMaxMinutes: 24 }, classes: { smith: { model: "custom", removedThinking: true } }, tuning: { mode: "apply" } },
      pinned: { afterMessageHoldSeconds: 75, removedKnob: 90 }, tuned: { rangerTimeboxMaxMinutes: 30 }, overrides: { q1: { staleMinutes: 45, removedKnob: 70 } }, removedLayer: {},
    }));
    expect(store.read("q1")).toMatchObject({ attention: { reviewBudget: 7 }, knobs: { tickSeconds: 90, typingHoldSeconds: 45, afterMessageHoldSeconds: 75, staleMinutes: 45, rangerTimeboxMaxMinutes: 24 }, classes: { smith: { model: "custom" } } });
    expect(() => settingsSnapshotSchema.parse(store.snapshot("q1"))).not.toThrow();
    expect(warnings.some(message => message.includes("removedSection"))).toBe(true); expect(warnings.some(message => message.includes("typingHoldSeconds"))).toBe(true);
    const count = warnings.length; store.read(); store.snapshot(); expect(warnings).toHaveLength(count);
  });
  it("falls back safely for invalid stored JSON and skips obsolete saved suggestions", () => {
    const { db } = fixture(), warnings: string[] = [];
    const store = new SettingsStore(db as unknown as Database, Date.now, undefined, message => { warnings.push(message); });
    db.prepare("UPDATE tavern_settings SET data=? WHERE id=1").run("{invalid");
    db.prepare("INSERT INTO tavern_tuning_suggestions(key,data) VALUES(?,?)").run("removedKnob", JSON.stringify({ key: "removedKnob", value: 90 }));
    expect(store.read()).toEqual(settingsSchema.parse({})); expect(store.snapshot().suggestions).toEqual([]);
    expect(() => settingsSnapshotSchema.parse(store.snapshot())).not.toThrow(); expect(warnings.length).toBeGreaterThan(0);
  });
  it("rejects unknown keys and never fills absent patch fields", () => {
    expect(settingsPatchSchema.parse({ tavern: { paused: true } })).toEqual({ tavern: { paused: true } });
    expect(() => settingsPatchSchema.parse({ keepers: { alwaysAsk: false } })).toThrow();
    for (const [key, rule] of Object.entries(TUNABLES)) {
      expect(() => settingsPatchSchema.parse({ knobs: { [key]: rule.min - 1 } })).toThrow();
      expect(() => settingsPatchSchema.parse({ knobs: { [key]: rule.max + 1 } })).toThrow();
    }
  });
  it("keeps memory limits out of user patches, pins and machine tuning", () => {
    expect(() => settingsPatchSchema.parse({ keepers: { restatementBytes: 8000 } })).toThrow();
    expect(() => settingsPatchSchema.parse({ knobs: { tickFactChars: 6000 } })).toThrow();
    const { store } = fixture();
    expect(previewToml("[keepers]\nrestatement_bytes = 8000", store.snapshot()).problems[0]!.line).toBe(2);
  });
  it("replaces a class picker value and clears an override with an empty object", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { classes: { smith: { provider: "openai", model: "gpt", reasoning: "high" } } }, why: "Pick model" });
    store.update({ revision: 1, patch: { classes: { smith: { provider: "anthropic", model: "claude" } } }, why: "Default thinking" });
    expect(store.read().classes.smith).toEqual({ provider: "anthropic", model: "claude" });
    store.update({ revision: 2, patch: { classes: { smith: {} } }, why: "Inherit class file" });
    expect(store.read().classes).not.toHaveProperty("smith");
  });
  it("stores provider-default thinking explicitly without confusing it with inheritance", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { classes: { smith: { provider: "openai", model: "gpt", reasoning: null } } }, why: "Provider-default thinking" });
    expect(store.read().classes.smith).toEqual({ provider: "openai", model: "gpt", reasoning: null });
  });
  it("round-trips explicit provider-default thinking and cleared quiet hours in TOML", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { classes: { smith: { reasoning: null } }, attention: { quietHours: null } }, why: "Explicit defaults" });
    const toml = exportToml(store.snapshot());
    expect(toml).toContain('reasoning = "default"'); expect(toml).toContain('quiet_hours = "none"');
    const preview = previewToml(toml, store.snapshot());
    expect(preview.problems).toEqual([]); expect(preview.changes).toEqual([]);
    expect(preview.user.classes?.smith?.reasoning).toBeNull(); expect(preview.user.attention?.quietHours).toBeNull();
  });
  it("stores partial user settings, audits changes and applies them live", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { attention: { reviewBudget: 4 } }, why: "Fewer interruptions" });
    expect(store.read().attention.reviewBudget).toBe(4);
    expect(store.snapshot().user).toEqual({ attention: { reviewBudget: 4 } });
    expect(store.snapshot().history[0]).toMatchObject({ by: "user", reason: "Fewer interruptions" });
    expect(() => store.update({ revision: 0, patch: { tavern: { paused: true } }, why: "Stale" })).toThrow(SettingsConflict);
    expect(store.read().tavern.paused).toBe(false);
  });
  it("respects tuning mode and pins, and does not undo unrelated changes", () => {
    const { store } = fixture();
    expect(() => store.applyTuned({ tickSeconds: 90 }, "Measured", { section: "reliability", chart: "ticks" })).toThrow(/off/);
    store.update({ revision: 0, patch: { tuning: { mode: "apply" } }, pins: { staleMinutes: 30 }, why: "Enable with a pin" });
    const change = store.applyTuned({ tickSeconds: 90, staleMinutes: 40 }, "Measured", { section: "reliability", chart: "ticks" })!;
    expect(store.read().knobs).toMatchObject({ tickSeconds: 90, staleMinutes: 30 });
    store.update({ revision: store.snapshot().revision, patch: { tavern: { paused: true } }, why: "Pause" });
    store.undo(change.id, "Undo pacing");
    expect(store.read().knobs.tickSeconds).toBe(60);
    expect(store.read().tavern.paused).toBe(true);
    expect(() => store.undo(change.id, "Twice")).toThrow(/already/);
  });
  it("makes an explicitly accepted suggestion effective in suggest mode and reversible", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { tuning: { mode: "suggest" } }, why: "Suggest only" });
    const decision = store.applyTuned({ tickSeconds: 90 }, "Accepted the measured suggestion", { section: "reliability", chart: "ticks" }, "user")!;
    expect(store.read().knobs.tickSeconds).toBe(90);
    expect(store.snapshot().rows.find(row => row.key === "tickSeconds")).toMatchObject({ source: "tavern", lastChange: { by: "user" } });
    store.undo(decision.id, "Undo acceptance"); expect(store.read().knobs.tickSeconds).toBe(60);
  });
  it("does not undo over a newer change to the same path", () => {
    const { store } = fixture();
    const first = store.update({ revision: 0, patch: { attention: { reviewBudget: 4 } }, why: "First" })!;
    store.update({ revision: 1, patch: { attention: { reviewBudget: 5 } }, why: "Newer" });
    expect(() => store.undo(first.id, "Old undo")).toThrow(/changed/);
    expect(store.read().attention.reviewBudget).toBe(5);
  });
  it("refuses thread-wide pacing overrides that cannot apply to one quest", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { tuning: { mode: "apply" } }, why: "Enable" });
    for (const key of ["tickSeconds", "typingHoldSeconds", "afterMessageHoldSeconds"])
      expect(() => store.override("q1", "keeper", { [key]: 90 }, "One quest")).toThrow(/thread-wide/i);
    expect(store.snapshot().revision).toBe(1);
  });
  it("bounds and expires per-quest overrides without touching global values or pins", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { tuning: { mode: "apply" } }, pins: { reportBatchSeconds: 90 }, why: "Enable" });
    expect(() => store.override("q1", "keeper", { reportBatchSeconds: 120 }, "Long build")).toThrow(/pinned/);
    store.override("q1", "keeper", { staleMinutes: 40 }, "Long build");
    expect(store.read("q1").knobs.staleMinutes).toBe(40);
    expect(store.read("q2").knobs.staleMinutes).toBe(20);
    const expiry = store.expire("q1")!;
    expect(store.read("q1").knobs.staleMinutes).toBe(20);
    expect(expiry.undoable).toBe(false);
    expect(() => store.undo(expiry.id, "Restore expired override")).toThrow(/cannot be undone/);
  });
});

describe("TOML transfer", () => {
  it("round-trips only explicit settings and pins unless tuned values are requested", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { tavern: { voice: "light" }, tuning: { mode: "apply" } }, pins: { staleMinutes: 30 }, why: "Personal settings" });
    store.applyTuned({ tickSeconds: 90 }, "Measured", { section: "reliability", chart: "ticks" });
    const toml = exportToml(store.snapshot());
    expect(toml).toContain("stale_minutes");
    expect(toml).not.toContain("[tuned]");
    const preview = previewToml(toml, store.snapshot());
    expect(preview.problems).toEqual([]);
    expect(preview.user).toEqual(store.snapshot().user);
    expect(preview.pinned).toEqual({ staleMinutes: 30 });
    expect(previewToml(exportToml(store.snapshot(), true), store.snapshot()).tuned).toEqual({ tickSeconds: 90 });
  });
  it("reports lines, keys and allowed ranges, including nested pins", () => {
    const { store } = fixture();
    const result = previewToml('[tavern]\nunknown = true\n\n[tuning]\npinned = { stale_minutes = 500 }\n', store.snapshot());
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 2, key: "tavern.unknown" }),
      expect.objectContaining({ line: 5, key: "tuning.pinned.stale_minutes", allowed: "10 to 120" }),
    ]));
  });
  it("includes both bounds for user-controlled numeric settings", () => {
    const { store } = fixture();
    const result = previewToml("[keepers]\nparty_max = 1001\n[attention]\nreview_budget = 0", store.snapshot());
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 2, key: "keepers.party_max", allowed: "1 to 1000" }),
      expect.objectContaining({ line: 4, key: "attention.review_budget", allowed: "1 to 30" }),
    ]));
  });
  it("previews without applying, exposes unsets, and refuses syntax errors", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { tavern: { voice: "off" } }, why: "Set" });
    const preview = previewToml("", store.snapshot());
    expect(preview.changes).toContainEqual({ key: "tavern.voice", from: "off", to: null, kind: "unset" });
    expect(store.read().tavern.voice).toBe("off");
    expect(previewToml("[broken", store.snapshot()).problems[0]!.line).toBeGreaterThan(0);
  });
});
