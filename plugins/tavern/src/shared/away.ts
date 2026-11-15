import { z } from "zod";

export const AWAY_STOP_LIST = ["merge", "deploy", "production", "sends-as-you", "delete"] as const;
const id = z.string().min(1).max(100);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const awayWakeRulesSchema = z.object({
  blockers: z.boolean().default(true),
  productionAsksAfterTwoHours: z.boolean().default(false),
}).strict();
export const awayQuestSchema = z.object({ questId: id, endState: z.enum(["drafts-ready", "pause"]) }).strict();
const quests = z.array(awayQuestSchema).max(5000).refine(values => new Set(values.map(value => value.questId)).size === values.length, "Include each quest only once");
export const awayCloseSchema = z.object({
  revision: cursor,
  until: timestamp,
  note: z.string().max(500).nullable().default(null),
  quests,
  allowWatched: z.boolean().default(false),
  wakeRules: awayWakeRulesSchema.default({ blockers: true, productionAsksAfterTwoHours: false }),
}).strict();
export type AwayCloseInput = z.input<typeof awayCloseSchema>;
export const awayReturnCauseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("explicit-return"), threadId: id.nullable(), refId: id.nullable() }).strict(),
  z.object({ kind: z.literal("user-message"), threadId: id, refId: id.nullable() }).strict(),
  z.object({ kind: z.literal("ask-answer"), threadId: id, refId: id }).strict(),
]);
export type AwayReturnCause = z.infer<typeof awayReturnCauseSchema>;
export const awayWindowSchema = z.object({
  id,
  version: cursor.min(1),
  closedAt: timestamp,
  until: timestamp,
  note: z.string().max(500).nullable(),
  quests,
  allowWatched: z.boolean(),
  wakeRules: awayWakeRulesSchema,
  stopList: z.array(z.enum(AWAY_STOP_LIST)).length(AWAY_STOP_LIST.length).refine(values => values.every((value, index) => value === AWAY_STOP_LIST[index]), "The Closing time stop list is fixed"),
  eventFloor: cursor,
  eventCeiling: cursor.nullable(),
  returnedAt: timestamp.nullable(),
  returnCause: awayReturnCauseSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.until <= value.closedAt) ctx.addIssue({ code: "custom", path: ["until"], message: "Back at must be after closing" });
  const returned = value.returnedAt !== null;
  if (returned !== (value.returnCause !== null) || returned !== (value.eventCeiling !== null))
    ctx.addIssue({ code: "custom", path: ["returnedAt"], message: "A return needs its time, cause and event boundary together" });
  if (value.eventCeiling !== null && value.eventCeiling < value.eventFloor)
    ctx.addIssue({ code: "custom", path: ["eventCeiling"], message: "The digest cannot end before it started" });
});
export type AwayWindow = z.infer<typeof awayWindowSchema>;
export const awayCompletedWindowSchema = awayWindowSchema.refine(value => value.returnedAt !== null, "Completed away windows need a recorded return");
export const awayStateSchema = z.object({ revision: cursor, window: awayWindowSchema.nullable() }).strict().superRefine((value, ctx) => {
  if (value.window === null ? value.revision !== 0 : value.window.version !== value.revision)
    ctx.addIssue({ code: "custom", path: ["revision"], message: "The current away window must match its state revision" });
});
export type AwayState = z.infer<typeof awayStateSchema>;
export const awayStatusSchema = z.object({ closed: z.boolean(), until: timestamp.nullable(), dueBack: z.boolean(), windowId: id.nullable(), followUp: z.boolean().optional() }).strict();
export type AwayStatus = z.infer<typeof awayStatusSchema>;
export const awaySnapshotSchema = awayStateSchema.safeExtend({ status: awayStatusSchema });
export type AwaySnapshot = z.infer<typeof awaySnapshotSchema>;
