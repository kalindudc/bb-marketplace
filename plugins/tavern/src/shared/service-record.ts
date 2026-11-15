import { z } from "zod";
import { evidenceSchema } from "./schema";

const count = z.number().int().nonnegative();
const at = count;
const identity = z.string().min(1).max(120);
const role = z.enum(["maker", "warden", "keeper"]);
const phase = z.enum(["done", "stopped"]);
const subjectSchema = z.object({
  key: identity, threadId: identity.nullable(), characterId: identity.nullable(), family: z.string().nullable(),
}).strict();
export const serviceVerdictSchema = z.object({
  version: z.literal(1), id: identity, questId: identity, waypointId: identity, entryId: identity, entryKey: identity,
  sequence: count, at, verdict: z.enum(["verified", "rejected"]),
  maker: subjectSchema, checker: subjectSchema,
  independence: z.enum(["independent", "same-family", "not-established"]),
  makerEvidence: z.array(evidenceSchema), checkerEvidence: z.array(evidenceSchema),
  reason: z.string().nullable(),
  fixesRejectionId: identity.nullable(), withdrawn: z.boolean().optional(),
  superseded: z.object({ at, reason: z.string() }).strict().optional(),
}).strict();
export type ServiceVerdict = z.infer<typeof serviceVerdictSchema>;

export const levelSnapshotSchema = z.object({
  before: count.positive().nullable(), after: count.positive().nullable(), historyComplete: z.boolean().optional(),
}).strict().refine(level => level.before === null || level.after !== null && level.after >= level.before, "A terminal level cannot decrease");
export const taleLevelSchema = z.object({ characterId: identity, role, before: count.positive().nullable(), after: count.positive().nullable(), historyComplete: z.boolean().optional() }).strict();
export const taleKeepSchema = z.object({ questId: identity, characterId: identity, kept: z.literal(true) }).strict();
export type TaleKeep = z.infer<typeof taleKeepSchema>;
export const taleKeepKey = (questId: string, characterId: string) => JSON.stringify([questId, characterId]);

const creditSchema = z.object({
  characterId: identity, role, verifiedWaypoints: count, checks: count,
  independentChecks: count, sameFamilyChecks: count, caught: count, threadIds: z.array(identity),
  level: levelSnapshotSchema.nullable().optional(),
}).strict();
export const serviceQuestRecordSchema = z.object({
  version: z.literal(1), questId: identity, title: z.string(), short: z.string(), phase, endedAt: at.nullable(),
  keeperThreadId: identity.nullable(), backfilledAt: at.nullable(), completeSince: at.nullable(),
  credits: z.array(creditSchema),
  waypoints: z.object({ verified: count, total: count, skipped: count.optional() }).strict().optional(),
}).strict();
export type ServiceQuestRecord = z.infer<typeof serviceQuestRecordSchema>;
export const serviceRecordStateSchema = z.object({ version: z.literal(1), recordingSince: at, backfilledAt: at.nullable() }).strict();
export type ServiceRecordState = z.infer<typeof serviceRecordStateSchema>;

const historySchema = z.object({
  questId: identity, title: z.string(), short: z.string(), phase, endedAt: at.nullable(),
  keeperThreadId: identity.nullable(), role, verifiedWaypoints: count,
  checks: count.optional(), caught: count.optional(), threadIds: z.array(identity),
  independentChecks: count.optional(), sameFamilyChecks: count.optional(),
  told: z.boolean().optional(), kept: z.boolean().optional(), available: z.boolean().optional(),
  waypoints: z.object({ verified: count, total: count, skipped: count.optional() }).nullable().optional(),
});
export const characterServiceRecordSchema = z.object({
  characterId: identity, firstEarnedAt: at.nullable(), lastEarnedAt: at.nullable(),
  /** Earlier counts are surviving proof, not a claim to complete historical coverage. */
  completeSince: at.nullable(), backfilledAt: at.nullable(),
  maker: z.object({ verifiedWaypoints: count, quests: count, firstEarnedAt: at.nullable().optional(), completeSince: at.nullable().optional() }).optional(),
  warden: z.object({ checks: count, independentChecks: count, sameFamilyChecks: count, caughtDefects: count, caughtSince: at.nullable(), firstEarnedAt: at.nullable().optional(), completeSince: at.nullable().optional() }).optional(),
  keeper: z.object({ returnedQuests: count, verifiedReturns: count, stoppedQuests: count, verifiedWaypoints: count, firstEarnedAt: at.nullable().optional(), completeSince: at.nullable().optional() }).optional(),
  recordsTotal: count, records: z.array(historySchema),
});
export type CharacterServiceRecord = z.infer<typeof characterServiceRecordSchema>;
