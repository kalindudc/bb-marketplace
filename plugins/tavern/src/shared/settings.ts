import { z } from "zod";
import { defineContract } from "./define-contract";
import { placementSettingsSchema, placementSettingsPatchSchema, placementPolicyReadSchema, settingsJsonValueSchema } from "./placement-settings";

export const MEMORY_LIMITS = { restatementBytes: 28000, tickFactChars: 14000 } as const;
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
  "scopes.*", "keepers.greenlight", "keepers.partyMax", "keepers.decisionTimerMax",
  "machines.*", "tavern.agentsMayChangeSettings", "tavern.paused", "attention.reviewBudget", "attention.notify", "attention.quietHours", "tuning.mode",
  "knobs.typingHoldSeconds", "knobs.afterMessageHoldSeconds", "knobs.rangerTimeboxMaxMinutes",
] as const;
export function isGuardrailSetting(key: string) {
  const normalized = key.replace(/^(?:tuning\.pinned|pinned|tuned)\./, "knobs.");
  return GUARDRAIL_SETTING_KEYS.some(rule => rule.endsWith(".*")
    ? normalized === rule.slice(0, -2) || normalized.startsWith(rule.slice(0, -1))
    : normalized === rule || normalized.startsWith(`${rule}.`));
}

export const ALWAYS_ASK = ["production", "merge", "delete", "sends-as-you", "credentials", "scope-widening"] as const;
export const voiceModeSchema = z.enum(["full", "light", "off"]);
export type VoiceMode = z.infer<typeof voiceModeSchema>;
const classId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const quietHoursSchema = z.object({
  start: clock, end: clock,
  timeZone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Use an IANA time zone"),
}).strict().refine(value => value.start !== value.end, "Start and end must differ");

const sections = {
  tavern: z.object({ paused: z.boolean(), defaultClass: z.union([z.literal("none"), classId]),
    widgetRow: z.boolean(), voice: voiceModeSchema, levels: z.boolean(), characters: z.boolean().default(true), hearthFlicker: z.boolean(), agentsMayChangeSettings: z.boolean().default(true),
    ambientMotion: z.enum(["calm", "lively", "off"]).default("calm"), repeatSeconds: z.number().int().min(3).max(60).default(20) }).strict(),
  attention: z.object({ reviewBudget: z.number().int().min(1).max(30),
    notify: z.enum(["consequential", "all", "none"]), quietHours: quietHoursSchema.nullable() }).strict(),
  keepers: z.object({ greenlight: z.enum(["explicit", "by-size"]),
    decisionTimerMax: z.number().int().min(1).max(10080), partyMax: z.number().int().min(1).max(1000),
    staleStrikes: z.number().int().min(1).max(4), restatementBytes: z.literal(MEMORY_LIMITS.restatementBytes),
    tickFactChars: z.literal(MEMORY_LIMITS.tickFactChars) }).strict(),
  classes: z.record(classId, z.object({ provider: z.string().trim().min(1).max(100).optional(), model: z.string().trim().min(1).max(200).optional(),
    reasoning: z.string().trim().min(1).max(40).nullable().optional() }).strict()),
  scopes: z.object({ mode: z.enum(["enforce", "watch", "off"]) }).strict(),
  journal: z.object({ journalReminders: z.boolean(), journalQuietMinutes: z.number().int().min(1).max(120) }).strict(),
  data: z.object({ historyDays: z.number().int().min(0).max(3650).describe("Retains optional Insights samples only. Zero keeps them forever; orchestration records are never pruned."), autoArchiveDays: z.number().int().min(0).max(3650), backupKeep: z.number().int().min(0).max(365).describe("Saved backups to keep. Zero keeps every backup; this never prunes live Tavern records.") }).strict(),
  tuning: z.object({ mode: z.enum(["apply", "suggest", "off"]) }).strict(),
  knobs: tunablesSchema.extend({ rangerTimeboxMaxMinutes: z.number().int().min(3).max(30) }),
};
export const settingsSchema = z.object({
  tavern: sections.tavern.default({ paused: false, defaultClass: "none", widgetRow: true, voice: "full", levels: true, characters: true, hearthFlicker: true, agentsMayChangeSettings: true, ambientMotion: "calm", repeatSeconds: 20 }),
  attention: sections.attention.default({ reviewBudget: 3, notify: "consequential", quietHours: null }),
  keepers: sections.keepers.default({ greenlight: "explicit", decisionTimerMax: 10080, partyMax: 5,
    staleStrikes: 2, ...MEMORY_LIMITS }),
  classes: sections.classes.default({}), scopes: sections.scopes.default({ mode: "enforce" }),
  machines: placementSettingsSchema.default({ maxMakers: 2, maxCheckers: 2, rules: [] }),
  journal: sections.journal.default({ journalReminders: true, journalQuietMinutes: 10 }),
  data: sections.data.default({ historyDays: 0, autoArchiveDays: 0, backupKeep: 14 }), tuning: sections.tuning.default({ mode: "off" }),
  knobs: sections.knobs.default({ ...Object.fromEntries(TUNABLE_KEYS.map(key => [key, TUNABLES[key].default])), rangerTimeboxMaxMinutes: 12 } as z.infer<typeof sections.knobs>),
}).strict();
export const DEFAULT_SETTINGS = settingsSchema.parse({});
export const settingsPatchSchema = z.object({
  tavern: sections.tavern.partial().extend({ agentsMayChangeSettings: z.boolean().optional(), characters: z.boolean().optional(), ambientMotion: z.enum(["calm", "lively", "off"]).optional(), repeatSeconds: z.number().int().min(3).max(60).optional() }).optional(), attention: sections.attention.partial().optional(),
  keepers: sections.keepers.omit({ restatementBytes: true, tickFactChars: true }).partial().optional(), classes: sections.classes.optional(),
  scopes: sections.scopes.partial().optional(), journal: sections.journal.partial().optional(),
  machines: placementSettingsPatchSchema.optional(),
  data: sections.data.partial().optional(), tuning: sections.tuning.partial().optional(), knobs: sections.knobs.partial().optional(),
}).strict();
export type TavernSettings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
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
export const settingsViewSchema = settingsSnapshotSchema.extend({ file: settingsFileSchema, alwaysAsk: z.array(z.enum(ALWAYS_ASK)),
  readOnlyLimits: z.array(z.object({ key: z.enum(["restatementBytes", "tickFactChars"]), label: z.string(), value: z.number(), unit: z.enum(["bytes", "chars"]), reason: z.string() })).optional(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;
const pinsPatchSchema = z.object(Object.fromEntries(TUNABLE_KEYS.map(key => [key, tunablesSchema.shape[key].nullable().optional()])) as { [K in TunableKey]: z.ZodOptional<z.ZodNullable<z.ZodNumber>> }).strict();
export const settingsUpdateSchema = z.object({ revision: z.number().int().nonnegative(), patch: settingsPatchSchema,
  pins: pinsPatchSchema.optional(), why: z.string().trim().min(1).max(2000), evidence: settingsEvidenceSchema.optional() }).strict();
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
  settingsApplySuggestion: { input: z.object({ key: tunableKeySchema, revision: z.number().int() }).strict(), output: settingsMutationSchema },
});
