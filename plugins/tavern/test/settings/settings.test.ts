import Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { settingsSchema, settingsPatchSchema, settingsSnapshotSchema, TUNABLES, isGuardrailSetting } from "../../src/shared/settings";
import { SettingsStore, SettingsConflict } from "../../src/server/settings/store";
import { exportToml, previewToml } from "../../src/server/settings/toml";
import { MIGRATIONS } from "../../src/server/migrations";
import type { Database } from "../../src/server/ports";

const databases: Sqlite.Database[] = [];
function fixture() {
  const db = new Sqlite(":memory:");
  databases.push(db);
  db.exec(MIGRATIONS.join(";\n"));
  let now = 1_800_000_000_000;
  const store = new SettingsStore(db as unknown as Database, () => now++);
  return { db, store };
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

it("accepts an absolute Git program or the default, not a command line or a relative path", () => {
  expect(settingsSchema.parse({}).tavern).toMatchObject({ gitProgram: "" });
  expect(isGuardrailSetting("tavern.gitProgram")).toBe(true);
  expect(settingsPatchSchema.safeParse({ tavern: { gitProgram: "/fixture/Git Tools/bin/git" } }).success).toBe(true);
  expect(settingsPatchSchema.safeParse({ tavern: { gitProgram: "" } }).success).toBe(true);
  for (const gitProgram of ["git", "~/bin/git", "bin/git", "/fixture/bin/git\n--help"])
    expect(settingsPatchSchema.safeParse({ tavern: { gitProgram } }).success).toBe(false);
});

describe("settings compatibility and validation", () => {
  it("defaults contextual speech off, accepts sparse edits, and bounds attempts", () => {
    const { store } = fixture();
    expect(store.read().tavern).toMatchObject({ contextualSpeech: false, piProgram: "", speechModel: "openai/gpt-5-nano", speechReasoning: "low", speechThreadLimit: 12, speechInstallLimit: 100 });
    const patch = { tavern: { contextualSpeech: true, speechThreadLimit: 6, speechInstallLimit: 80, speechModel: "vendor/model", speechReasoning: "low" as const } };
    expect(settingsPatchSchema.parse(patch)).toEqual(patch);
    expect(settingsPatchSchema.parse({ tavern: { contextualSpeech: true } })).toEqual({ tavern: { contextualSpeech: true } });
    expect(isGuardrailSetting("tavern.contextualSpeech")).toBe(false);
    expect(isGuardrailSetting("tavern.piProgram")).toBe(true);
    expect(settingsPatchSchema.safeParse({ tavern: { piProgram: "./pi" } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ tavern: { speechReasoning: "--tools=bash" } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ tavern: { speechModel: "--model=other" } }).success).toBe(false);
    for (const key of ["speechThreadLimit", "speechInstallLimit"])
      for (const value of [-1, 1.5, 10_000]) expect(settingsPatchSchema.safeParse({ tavern: { [key]: value } }).success).toBe(false);
    store.update({ revision: 0, patch, why: "Choose a speech model" });
    expect(store.read().tavern).toMatchObject(patch.tavern);
    expect(previewToml(exportToml(store.snapshot()), store.snapshot()).problems).toEqual([]);
  });

  it("keeps today's defaults, units, opt-in timers and unlimited history", () => {
    const settings = settingsSchema.parse({});
    expect(settings.knobs).toEqual({ tickSeconds: 60, typingHoldSeconds: 45, afterMessageHoldSeconds: 60,
      staleMinutes: 20, reportBatchSeconds: 60, rangerTimeboxMaxMinutes: 12, ledgerRefreshMinutes: 10 });
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
  it("bounds memory limits and accepts them in patches and TOML, not in quest tuning", () => {
    const { store } = fixture();
    expect(settingsPatchSchema.parse({ keepers: { restatementBytes: 8000, tickFactChars: 4000 } })).toEqual({ keepers: { restatementBytes: 8000, tickFactChars: 4000 } });
    for (const [key, values] of [["restatementBytes", [7999, 32001]], ["tickFactChars", [3999, 32001]]] as const)
      for (const value of values) expect(() => settingsPatchSchema.parse({ keepers: { [key]: value } })).toThrow();
    expect(() => settingsPatchSchema.parse({ knobs: { tickFactChars: 6000 } })).toThrow();
    expect(previewToml("[keepers]\nrestatement_bytes = 8000", store.snapshot()).problems).toEqual([]);
  });
  it("defaults the lantern to medium, lights bb, and round-trips each control without filling sparse patches", () => {
    const { store } = fixture();
    expect(store.read().tavern).toMatchObject({ lanternLight: true, lanternStrength: "medium", lanternLightBb: true });
    const tavern = { lanternLight: false, lanternStrength: "high", lanternLightBb: false } as const;
    for (const [key, value] of Object.entries(tavern)) {
      const patch = { tavern: { [key]: value } };
      expect(settingsPatchSchema.parse(patch)).toEqual(patch);
    }
    store.update({ revision: 0, patch: { tavern }, why: "Keep lantern light within Tavern" });
    const toml = exportToml(store.snapshot());
    expect(toml).toContain("lantern_light = false");
    expect(toml).toContain('lantern_strength = "high"');
    expect(toml).toContain("lantern_light_bb = false");
    const target = fixture().store;
    const preview = previewToml(toml, target.snapshot());
    expect(preview.problems).toEqual([]);
    expect(preview.user).toEqual({ tavern });
    target.replace(preview.user, preview.pinned, preview.tuned, 0, "Restore lantern preferences");
    expect(target.read().tavern).toMatchObject(tavern);
  });
  it("round-trips non-default knobs and choices across all Settings sections", () => {
    const { store } = fixture();
    const patch = settingsPatchSchema.parse({
      tavern: { paused: true, agentsMayChangeSettings: false, defaultClass: "smith", widgetRow: false, voice: "light", levels: false, characters: false, ambientMotion: "off", hearthFlicker: false, repeatSeconds: 43, batchWakeEvents: true, reportedPoseSeconds: 87, verifiedPoseMinutes: 23 },
      attention: { reviewBudget: 7, notify: "all", quietHours: { start: "22:00", end: "06:00", timeZone: "UTC" } },
      away: { neverWhileClosed: ["merge", "production", "delete"], productionWakeHours: 3, defaultBackAtHour: 7, defaultEndState: "pause", defaultAllowWatched: true, defaultWakeBlockers: false, defaultWakeProduction: true },
      keepers: { restMinutes: 42, greenlight: "by-size", decisionTimerMax: 90, partyMax: 14, staleStrikes: 4, restatementBytes: 9300, tickFactChars: 8400, alwaysAsk: [], failuresBeforeAsk: 4, stopAskAfterSeconds: 190, retryAfterSeconds: 82, briefRetryAttempts: 7, replacementsPerSlot: 1, rangerMax: 6, keepMaxHours: 36, registryWaitSeconds: 48, registryBlockerMinutes: 9 },
      classes: { smith: { provider: "agent", model: "model", reasoning: "high" } }, scopes: { mode: "watch" },
      journal: { journalReminders: false, journalQuietMinutes: 24, remindEveryMinutes: 42, reportGraceMinutes: 18 },
      data: { historyDays: 90, autoArchiveDays: 14, backupKeep: 42 },
      tuning: { mode: "apply", minSamples: 42, windowDays: 17, cooldownDays: 3 },
      knobs: { tickSeconds: 95, typingHoldSeconds: 60, afterMessageHoldSeconds: 72, staleMinutes: 24, reportBatchSeconds: 95, rangerTimeboxMaxMinutes: 17, ledgerRefreshMinutes: 8 },
      machines: { maxMakers: 8, maxCheckers: 4 },
    });
    store.update({ patch, revision: 0, why: "Exercise every control" });
    const target = fixture().store;
    const preview = previewToml(exportToml(store.snapshot()), target.snapshot());
    expect(preview.problems).toEqual([]);
    expect(preview.user).toEqual(patch);
    target.replace(preview.user, preview.pinned, preview.tuned, 0, "Restore settings");
    expect(target.read()).toEqual(store.read());
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
  it("records a default reset on the same save path and can undo it", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { tavern: { repeatSeconds: 43 } }, why: "Lengthen interval" });
    const reset=store.update({ revision: 1, patch: {}, reset: ["tavern.repeatSeconds"], why: "Reset to default" })!;
    expect(store.read().tavern.repeatSeconds).toBe(20);
    expect(reset.changes).toEqual([{key:"tavern.repeatSeconds",from:43,to:null,kind:"unset"}]);
    expect(exportToml(store.snapshot())).not.toContain("repeat_seconds");
    store.undo(reset.id,"Undo reset",2);
    expect(store.read().tavern.repeatSeconds).toBe(43);
  });
  it("clears tuned and pinned overrides or a legacy motion flag during reset", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { tavern: { ambientMotion: "off" }, tuning: { mode: "suggest" } }, why: "Edit motion" });
    store.applyTuned({ tickSeconds: 90, staleMinutes: 25 }, "Tune", { section: "ticks", chart: "history" });
    store.update({ revision: 2, patch: {}, pins: { staleMinutes: 30 }, why: "Pin" });
    store.update({ revision: 3, patch: {}, reset: ["tavern.ambientMotion", "knobs.tickSeconds", "knobs.staleMinutes"], why: "Reset" });
    expect(store.read().tavern).toMatchObject({ambientMotion:"calm",hearthFlicker:true});
    expect(store.read().knobs).toMatchObject({tickSeconds:60,staleMinutes:20});
    expect(store.snapshot().pinned).toEqual({});
    expect(store.snapshot().tuned).toEqual({});
    expect(exportToml(store.snapshot(), true)).not.toMatch(/ambient_motion|hearth_flicker|tick_seconds|stale_minutes/);
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
