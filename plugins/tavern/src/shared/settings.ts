import { z } from "zod";
import { defineContract } from "./define-contract";
import { sendToolsSchema } from "./communication";
import { placementSettingsSchema, placementSettingsPatchSchema, placementPolicyReadSchema, settingsJsonValueSchema } from "./placement-settings";

import { AWAY_STOP_LIST, PRODUCTION_WAKE_HOURS, awayQuestSchema, awayStopListSchema } from "./away";
import { ALWAYS_ASK_KINDS } from "./quest-authority";

export const KNOB_FIELDS = {
  tavern: {
    reportedPoseSeconds: { default: 60, min: 10, max: 600, unit: "seconds", label: "Reported pose lasts" },
    verifiedPoseMinutes: { default: 10, min: 1, max: 60, unit: "minutes", label: "Verified pose lasts" },
  },
  away: {
    productionWakeHours: { ...PRODUCTION_WAKE_HOURS, unit: "hours", label: "Wake me for production or cluster write asks after" },
    defaultBackAtHour: { default: 8, min: 0, max: 23, unit: "local hour", label: "Default Back at hour" },
  },
  keepers: {
    restatementBytes: { default: 28000, min: 8000, max: 32000, unit: "bytes", label: "Keeper memory limit" },
    tickFactChars: { default: 14000, min: 4000, max: 32000, unit: "characters", label: "Tick facts limit" },
    failuresBeforeAsk: { default: 2, min: 1, max: 5, unit: "failures", label: "Failures before the Keeper asks me" },
    stopAskAfterSeconds: { default: 120, min: 30, max: 900, unit: "seconds", label: "Ask me about an unconfirmed stop after" },
    retryAfterSeconds: { default: 60, min: 10, max: 600, unit: "seconds", label: "Retry a refused tick after" },
    briefRetryAttempts: { default: 5, min: 1, max: 10, unit: "tries", label: "Brief delivery tries" },
    replacementsPerSlot: { default: 2, min: 0, max: 5, unit: "replacements", label: "Replacements per party slot" },
    rangerMax: { default: 3, min: 1, max: 20, unit: "Rangers", label: "Rangers at once when the class file is silent" },
    keepMaxHours: { default: 24, min: 1, max: 168, unit: "hours", label: "Longest keep for a resting member" },
    registryWaitSeconds: { default: 30, min: 5, max: 120, unit: "seconds", label: "Wait for class files" },
    clusterGrantMinutes: { default: 15, min: 1, max: 30, unit: "minutes", label: "Confirmed cluster command expires after" },
    successionRecoverySeconds: { default: 600, min: 30, max: 3600, unit: "seconds", label: "Wait for a fresh Keeper" },
    registryBlockerMinutes: { default: 5, min: 1, max: 60, unit: "minutes", label: "Ask me about a class-file problem after" },
  },
  journal: {
    remindEveryMinutes: { default: 15, min: 5, max: 240, unit: "minutes", label: "Remind at most every" },
    reportGraceMinutes: { default: 10, min: 1, max: 120, unit: "minutes", label: "Report may wait unchecked for" },
  },
  tuning: {
    minSamples: { default: 20, min: 5, max: 200, unit: "samples", label: "Tuner minimum samples" },
    windowDays: { default: 30, min: 7, max: 90, unit: "days", label: "Tuner reads the last" },
    cooldownDays: { default: 7, min: 1, max: 30, unit: "days", label: "Wait between automatic changes" },
  },
  knobs: {
    ledgerRefreshMinutes: { default: 10, min: 2, max: 60, unit: "minutes", label: "Full ledger refresh" },
  },
} as const;

type NumberBounds = { min: number; max: number; default: number };
function numberFields<T extends Record<string, NumberBounds>>(fields: T) {
  return Object.fromEntries(Object.entries(fields).map(([key, rule]) => [key, z.number().int().min(rule.min).max(rule.max)])) as { [K in keyof T]: z.ZodNumber };
}
function defaultNumbers<T extends Record<string, NumberBounds>>(fields: T) {
  const numbers = numberFields(fields);
  return Object.fromEntries(Object.keys(fields).map(key => [key, numbers[key]!.default(fields[key]!.default)])) as { [K in keyof T]: z.ZodDefault<z.ZodNumber> };
}
const alwaysAskSchema = z.array(z.enum(ALWAYS_ASK_KINDS)).max(ALWAYS_ASK_KINDS.length)
  .refine(items => new Set(items).size === items.length, "Include each kind only once");
export const TUNABLES = {
  tickSeconds: { label: "Keeper tick interval", default: 60, min: 30, max: 300, unit: "s" },
  typingHoldSeconds: { label: "Hold while you type", default: 45, min: 15, max: 180, unit: "s" },
  afterMessageHoldSeconds: { label: "Hold after your message", default: 60, min: 15, max: 180, unit: "s" },
  staleMinutes: { label: "Quiet member interval", default: 20, min: 10, max: 120, unit: "min" },
  reportBatchSeconds: { label: "Report batch interval", default: 60, min: 30, max: 300, unit: "s" },
} as const;
export type TunableKey = keyof typeof TUNABLES;
export const TUNABLE_KEYS = Object.keys(TUNABLES) as TunableKey[];
export const QUEST_TUNABLE_KEYS = ["staleMinutes", "reportBatchSeconds"] as const;
export const tunableKeySchema = z.enum(TUNABLE_KEYS);
export const tunablesSchema = z.object(Object.fromEntries(TUNABLE_KEYS.map(key => [key,
  z.number().int().min(TUNABLES[key].min).max(TUNABLES[key].max),
])) as { [K in TunableKey]: z.ZodNumber }).strict();
export const sparseTunablesSchema = tunablesSchema.partial();
export type Tunables = z.infer<typeof tunablesSchema>;
export type SparseTunables = Partial<Tunables>;

export const GUARDRAIL_SETTING_KEYS = [
  "scopes.*", "away.*", "keepers.alwaysAsk", "keepers.greenlight", "keepers.partyMax", "keepers.decisionTimerMax",
  "machines.*", "tavern.agentsMayChangeSettings", "tavern.paused", "attention.reviewBudget", "attention.notify", "attention.quietHours", "tuning.mode",
  "knobs.typingHoldSeconds", "knobs.afterMessageHoldSeconds", "knobs.rangerTimeboxMaxMinutes",
] as const;
export function isGuardrailSetting(key: string) {
  const normalized = key.replace(/^(?:tuning\.pinned|pinned|tuned)\./, "knobs.");
  return GUARDRAIL_SETTING_KEYS.some(rule => rule.endsWith(".*")
    ? normalized === rule.slice(0, -2) || normalized.startsWith(rule.slice(0, -1))
    : normalized === rule || normalized.startsWith(`${rule}.`));
}

export const voiceModeSchema = z.enum(["full", "light", "off"]);
export type VoiceMode = z.infer<typeof voiceModeSchema>;
export const voiceBeforeOffSchema = voiceModeSchema.exclude(["off"]);
export type VoiceBeforeOff = z.infer<typeof voiceBeforeOffSchema>;
export const DEFAULT_VOICE: VoiceBeforeOff = "full";
export const characterQuietUntilSchema = z.number().int().min(0).max(8_640_000_000_000_000);
export const CHARACTER_QUIET_HOUR_MS = 3_600_000;
const classId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const quietHoursSchema = z.object({
  start: clock, end: clock,
  timeZone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Use an IANA time zone"),
}).strict().refine(value => value.start !== value.end, "Start and end must differ");

const lanternStrengthSchema = z.enum(["low", "medium", "high"]);

const sections = {
  tavern: z.object({ paused: z.boolean(), defaultClass: z.union([z.literal("none"), classId]),
    widgetRow: z.boolean(), voice: voiceModeSchema, voiceBeforeOff: voiceBeforeOffSchema, levels: z.boolean(), characters: z.boolean().default(true), hearthFlicker: z.boolean(), agentsMayChangeSettings: z.boolean().default(true),
    ambientMotion: z.enum(["calm", "lively", "off"]).default("calm"), characterQuietUntil: characterQuietUntilSchema, repeatSeconds: z.number().int().min(3).max(60).default(20),
    lanternLight: z.boolean().default(true), lanternStrength: lanternStrengthSchema.default("medium"), lanternLightBb: z.boolean().default(true),
    // Wake-delivered ticks may hold briefly to gather more events; regular sweep ticks ignore it. Off by default.
    batchWakeEvents: z.boolean().default(false), ...numberFields(KNOB_FIELDS.tavern) }).strict(),
  away: z.object({ neverWhileClosed: awayStopListSchema, defaultEndState: awayQuestSchema.shape.endState,
    defaultAllowWatched: z.boolean(), defaultWakeBlockers: z.boolean(), defaultWakeProduction: z.boolean(), ...numberFields(KNOB_FIELDS.away) }).strict(),
  attention: z.object({ reviewBudget: z.number().int().min(1).max(30),
    notify: z.enum(["consequential", "all", "none"]), quietHours: quietHoursSchema.nullable() }).strict(),
  keepers: z.object({ restMinutes: z.number().int().min(1).max(10080).default(30), greenlight: z.enum(["explicit", "by-size"]),
    decisionTimerMax: z.number().int().min(1).max(10080), partyMax: z.number().int().min(1).max(1000),
    chainDepth: z.number().int().min(1).max(3), chainMembers: z.number().int().min(1).max(1000),
    staleStrikes: z.number().int().min(1).max(4), alwaysAsk: alwaysAskSchema, ...numberFields(KNOB_FIELDS.keepers) }).strict(),
  classes: z.record(classId, z.object({ provider: z.string().trim().min(1).max(100).optional(), model: z.string().trim().min(1).max(200).optional(),
    reasoning: z.string().trim().min(1).max(40).nullable().optional() }).strict()),
  scopes: z.object({ mode: z.enum(["enforce", "watch", "off"]), sendTools: sendToolsSchema }).strict(),
  journal: z.object({ journalReminders: z.boolean(), journalQuietMinutes: z.number().int().min(1).max(120), ...numberFields(KNOB_FIELDS.journal) }).strict(),
  data: z.object({ historyDays: z.number().int().min(0).max(3650).describe("Retains optional Insights samples only. Zero keeps them forever; orchestration records are never pruned."), autoArchiveDays: z.number().int().min(0).max(3650), backupKeep: z.number().int().min(0).max(365).describe("Saved backups to keep. Zero keeps every backup; this never prunes live Tavern records.") }).strict(),
  tuning: z.object({ mode: z.enum(["apply", "suggest", "off"]), ...numberFields(KNOB_FIELDS.tuning) }).strict(),
  knobs: tunablesSchema.extend({ rangerTimeboxMaxMinutes: z.number().int().min(3).max(30), ...numberFields(KNOB_FIELDS.knobs) }),
};
export const settingsSchema = z.object({
  tavern: sections.tavern.extend({ ...defaultNumbers(KNOB_FIELDS.tavern), characterQuietUntil: characterQuietUntilSchema.default(0), voiceBeforeOff: voiceBeforeOffSchema.default(DEFAULT_VOICE) }).prefault({ paused: false, defaultClass: "none", widgetRow: true, voice: DEFAULT_VOICE, levels: true, characters: true, hearthFlicker: true, agentsMayChangeSettings: true, ambientMotion: "calm", repeatSeconds: 20, batchWakeEvents: false }),
  away: sections.away.extend(defaultNumbers(KNOB_FIELDS.away)).prefault({ neverWhileClosed: [...AWAY_STOP_LIST],
    defaultEndState: "drafts-ready", defaultAllowWatched: false, defaultWakeBlockers: true, defaultWakeProduction: false }),
  attention: sections.attention.default({ reviewBudget: 3, notify: "consequential", quietHours: null }),
  keepers: sections.keepers.extend({ ...defaultNumbers(KNOB_FIELDS.keepers), alwaysAsk: alwaysAskSchema.default([...ALWAYS_ASK_KINDS]), chainDepth: sections.keepers.shape.chainDepth.default(1), chainMembers: sections.keepers.shape.chainMembers.default(12) })
    .prefault({ greenlight: "explicit", decisionTimerMax: 10080, partyMax: 5, staleStrikes: 2, restMinutes: 30 }),
  classes: sections.classes.default({}), scopes: sections.scopes.extend({ sendTools: sendToolsSchema.default([]) }).prefault({ mode: "enforce" }),
  machines: placementSettingsSchema.default({ maxMakers: 2, maxCheckers: 2, rules: [], forges: [] }),
  journal: sections.journal.extend(defaultNumbers(KNOB_FIELDS.journal)).prefault({ journalReminders: true, journalQuietMinutes: 10 }),
  data: sections.data.default({ historyDays: 0, autoArchiveDays: 0, backupKeep: 14 }),
  tuning: sections.tuning.extend(defaultNumbers(KNOB_FIELDS.tuning)).prefault({ mode: "off" }),
  knobs: sections.knobs.extend(defaultNumbers(KNOB_FIELDS.knobs)).prefault({ ...Object.fromEntries(TUNABLE_KEYS.map(key => [key, TUNABLES[key].default])), rangerTimeboxMaxMinutes: 12 } as Tunables & { rangerTimeboxMaxMinutes: number }),
}).strict();
export const DEFAULT_SETTINGS = settingsSchema.parse({});
export const settingsPatchSchema = z.object({
  tavern: sections.tavern.partial().extend({ agentsMayChangeSettings: z.boolean().optional(), characters: z.boolean().optional(), ambientMotion: z.enum(["calm", "lively", "off"]).optional(), repeatSeconds: z.number().int().min(3).max(60).optional(), batchWakeEvents: z.boolean().optional(),
    lanternLight: z.boolean().optional(), lanternStrength: lanternStrengthSchema.optional(), lanternLightBb: z.boolean().optional(),
  }).optional(), attention: sections.attention.partial().optional(),
  away: sections.away.partial().optional(),
  keepers: sections.keepers.partial().extend({ restMinutes: sections.keepers.shape.restMinutes.removeDefault().optional() }).optional(), classes: sections.classes.optional(),
  scopes: sections.scopes.partial().optional(), journal: sections.journal.partial().optional(),
  machines: placementSettingsPatchSchema.optional(),
  data: sections.data.partial().optional(), tuning: sections.tuning.partial().optional(), knobs: sections.knobs.partial().optional(),
}).strict();
export type TavernSettings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const ambientMotionPatch = (ambientMotion: TavernSettings["tavern"]["ambientMotion"]): SettingsPatch =>
  ({ tavern: { ambientMotion, hearthFlicker: ambientMotion !== "off" } });
export const voicePatch = (voice: VoiceMode, prior: VoiceMode): SettingsPatch =>
  ({ tavern: { voice, ...(voice === "off" && prior !== "off" ? { voiceBeforeOff: prior } : {}) } });
export const charactersPatch = (characters: boolean): SettingsPatch => ({ tavern: { characters } });
export const characterQuietPatch = (characterQuietUntil: number): SettingsPatch => ({ tavern: { characterQuietUntil } });
type EditableGroup = Exclude<keyof TavernSettings, "classes">;
type SettingPath = { [G in EditableGroup]: `${G}.${Extract<keyof TavernSettings[G], string>}` }[EditableGroup];
export type ResettableSetting = Exclude<SettingPath, "machines.rules" | "machines.forges">;
const resettable = Object.entries(DEFAULT_SETTINGS).flatMap(([group, values]) => group === "classes" ? [] : Object.keys(values).map(key => `${group}.${key}`))
  .filter(key => key !== "machines.rules" && key !== "machines.forges") as ResettableSetting[];
export const settingsEvidenceSchema = z.object({ section: z.string().max(100), chart: z.string().max(100),
  figure: z.number().finite().optional(), facts: z.record(z.string(), z.union([z.number().finite(), z.string().max(500), z.null()])).optional(),
}).strict();
export type SettingsEvidence = z.infer<typeof settingsEvidenceSchema>;
export const settingsProblemSchema = z.object({ line: z.number().int().nonnegative(), key: z.string(), message: z.string(), allowed: z.string().optional() });
export const settingsChangeSchema = z.object({ key: z.string(), from: settingsJsonValueSchema, to: settingsJsonValueSchema, kind: z.enum(["set", "unset", "pin", "unpin"]) });
export type SettingsChange = z.infer<typeof settingsChangeSchema>;
export function importSummary(changes: readonly SettingsChange[], applied = false) {
  const resets = changes.filter(change => change.kind === "unset").length, other = changes.length - resets;
  const who = resets === 0 ? "No settings" : resets === 1 ? "1 setting" : `${resets} settings`;
  const back = `${who} ${applied ? "returned" : resets === 1 ? "returns" : "return"} to defaults.`;
  const rest = other ? `${other} ${other === 1 ? "other" : "others"} ${applied ? "changed" : other === 1 ? "changes" : "change"}.`
    : resets ? "" : applied ? "Nothing else changed." : "Nothing else would change.";
  return [`${applied ? "Replaced" : "Replaces"} all settings.`, back, rest].filter(Boolean).join(" ");
}
export const settingDecisionSchema = z.object({ id: z.string(), at: z.number(), by: z.enum(["user", "tavern", "keeper"]),
  reason: z.string(), evidence: settingsEvidenceSchema.nullable(), questId: z.string().nullable(), threadId: z.string().nullable(),
  changes: z.array(settingsChangeSchema), undoable: z.boolean(), undoneAt: z.number().nullable(),
});
export type SettingDecision = z.infer<typeof settingDecisionSchema>;
export const tuningSuggestionSchema = z.object({ key: tunableKeySchema, value: z.number(), reason: z.string(),
  evidence: settingsEvidenceSchema, at: z.number(), revision: z.number().int() });
export type TuningSuggestion = z.infer<typeof tuningSuggestionSchema>;
export const tunedRowSchema = z.object({ key: tunableKeySchema, label: z.string(), value: z.number(), default: z.number(),
  min: z.number(), max: z.number(), unit: z.enum(["s", "min", "bytes", "chars", "count"]),
  source: z.enum(["default", "user", "tavern", "keeper"]), pinned: z.boolean(),
  lastChange: z.object({ id: z.string(), at: z.number(), from: z.number().nullable(), to: z.number().nullable(),
    by: z.enum(["user", "tavern", "keeper"]), reason: z.string(), evidence: settingsEvidenceSchema.nullable(), undoable: z.boolean() }).nullable(),
});
export const settingsSnapshotSchema = z.object({ revision: z.number().int(), effective: settingsSchema, user: settingsPatchSchema,
  placementPolicy: placementPolicyReadSchema.optional(), placementRawJson: z.string().nullable().optional(),
  pinned: sparseTunablesSchema, tuned: sparseTunablesSchema, rows: z.array(tunedRowSchema), history: z.array(settingDecisionSchema),
  suggestions: z.array(tuningSuggestionSchema),
});
export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;
export const settingsFileSchema = z.object({ path: z.string(), exists: z.boolean(), differs: z.boolean(), error: z.string().nullable(), changedKeys: z.array(z.string()), hash: z.string().nullable().optional() });
const settingAuthorSchema = settingDecisionSchema.pick({ at: true, by: true, threadId: true });
export const settingsViewSchema = settingsSnapshotSchema.extend({ file: settingsFileSchema,
  lastChangers: z.record(z.string(), settingAuthorSchema).optional(),
  liveOverrides: z.array(z.object({ questId: z.string(), questTitle: z.string(), keeperThreadId: z.string(), keeperName: z.string(),
    key: z.enum(QUEST_TUNABLE_KEYS), value: z.number(), applied: z.boolean() })).optional(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;
const pinsPatchSchema = z.object(Object.fromEntries(TUNABLE_KEYS.map(key => [key, tunablesSchema.shape[key].nullable().optional()])) as { [K in TunableKey]: z.ZodOptional<z.ZodNullable<z.ZodNumber>> }).strict();
export const settingsUpdateSchema = z.object({ revision: z.number().int().nonnegative(), patch: settingsPatchSchema,
  pins: pinsPatchSchema.optional(), reset: z.array(z.enum(resettable)).min(1).max(resettable.length).optional(),
  why: z.string().trim().min(1).max(2000), evidence: settingsEvidenceSchema.optional() }).strict()
  .refine(input => !input.reset || (Object.keys(input.patch).length === 0 && !input.pins), "Save a reset separately from other edits");
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export const settingsMutationSchema = z.object({ code: z.enum(["ok", "stale", "invalid"]), revision: z.number().int(),
  problems: z.array(settingsProblemSchema), settings: settingsViewSchema.nullable(), decisionId: z.string().optional() });
export const settingsPreviewSchema = z.object({ code: z.enum(["preview", "applied", "stale", "invalid"]), revision: z.number().int(),
  applied: z.boolean(), changes: z.array(settingsChangeSchema), problems: z.array(settingsProblemSchema) });
export const settingsContract = defineContract({
  settings: { input: z.null(), output: settingsViewSchema, tags: () => ["tavern:settings"] },
  settingsUpdate: { input: settingsUpdateSchema, output: settingsMutationSchema },
  settingsUndo: { input: z.object({ id: z.string(), revision: z.number().int(), why: z.string().trim().min(1).max(2000) }).strict(), output: settingsMutationSchema },
  settingsExport: { input: z.object({ withTuned: z.boolean().optional() }).strict(), output: z.object({ toml: z.string() }) },
  settingsImport: { input: z.object({ toml: z.string().max(131072), apply: z.boolean().default(false), revision: z.number().int().optional(), why: z.string().max(2000).optional() }).strict(), output: settingsPreviewSchema },
  settingsFile: { input: z.object({ action: z.enum(["status", "load", "save"]), apply: z.boolean().optional(), revision: z.number().int().optional(), withTuned: z.boolean().optional(), expectedHash: z.string().nullable().optional(), why: z.string().max(2000).optional() }).strict(),
    output: z.object({ file: settingsFileSchema, preview: settingsPreviewSchema.nullable() }) },
  settingsEndOverride: { input: z.object({ revision: z.number().int().nonnegative(), boardQuestId: z.string().min(1).max(120), key: z.enum(QUEST_TUNABLE_KEYS) }).strict(), output: settingsMutationSchema },
  settingsApplySuggestion: { input: z.object({ key: tunableKeySchema, revision: z.number().int() }).strict(), output: settingsMutationSchema },
});
