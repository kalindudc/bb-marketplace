import { z } from "zod";
import { defineContract } from "./define-contract";
import { settingDecisionSchema, tunableKeySchema } from "./settings";

const scalar = z.number().finite().nullable();
export const insightUnitSchema = z.enum(["count", "s", "bytes", "chars", "tokens", "usd", "ratio", "level"]);
export type InsightUnit = z.infer<typeof insightUnitSchema>;
const fraction = (value: number | null) => value === null || value >= 0 && value <= 1;
export const insightSeriesSchema = z.union([
  z.object({ id: z.string(), label: z.string(), unit: insightUnitSchema, points: z.array(z.object({ x: z.string(), y: scalar, label: z.string().optional() })) }),
  z.object({ id: z.string(), label: z.string(), unit: insightUnitSchema, value: scalar }),
]).refine(series => series.unit !== "ratio" || ("value" in series ? fraction(series.value) : series.points.every(point => fraction(point.y))), "Ratios must be between zero and one");
export const insightSectionSchema = z.object({ caption: z.string(), series: z.array(insightSeriesSchema) });
export type InsightSection = z.infer<typeof insightSectionSchema>;
export const insightIdeaSchema = z.object({ id: z.string(), title: z.string(), detail: z.string(), severity: z.enum(["act", "info"]),
  action: z.union([
    z.object({ kind: z.literal("apply-tuned"), key: tunableKeySchema, value: z.number() }),
    z.object({ kind: z.literal("open-setting"), key: z.string() }),
    z.object({ kind: z.literal("open-quest"), questId: z.string() }),
    z.object({ kind: z.literal("open-section"), section: z.string() }),
  ]), evidence: z.object({ section: z.string(), chart: z.string() }).optional(),
});
const count = z.number().int().nonnegative();
export const wardenQualitySchema = z.object({
  from: z.number(), to: z.number(), rejectedWaypointsWaived: count,
  rows: z.array(z.object({
    classId: z.literal("warden"), providerId: z.string().nullable(), model: z.string().nullable(),
    verified: count, reopened: count, rejected: count,
  }).refine(row => row.reopened <= row.verified, "Reopened verifications cannot exceed recorded verifications")),
});
export type WardenQuality = z.infer<typeof wardenQualitySchema>;
export const insightsSchema = z.object({
  range: z.enum(["7d", "30d", "90d"]), from: z.number(), to: z.number(), collectingSince: z.number(),
  headline: z.array(z.object({ id: z.string(), label: z.string(), value: scalar, unit: insightUnitSchema, previous: scalar.optional() })
    .refine(row => row.unit !== "ratio" || fraction(row.value) && (row.previous === undefined || fraction(row.previous)), "Ratios must be between zero and one")),
  ideas: z.array(insightIdeaSchema), reliability: insightSectionSchema, phases: insightSectionSchema,
  attention: insightSectionSchema, party: insightSectionSchema, guardrails: insightSectionSchema, wardenQuality: wardenQualitySchema,
  tuningHistory: z.array(settingDecisionSchema),
  cost: insightSectionSchema.extend({
    estimated: z.boolean(), threadsKnown: z.number(), threadsTotal: z.number(),
    quests: z.array(z.object({ questId: z.string(), title: z.string(), cost: scalar, tokens: scalar, seconds: scalar, complete: z.boolean() })),
  }).nullable(),
});
export type InsightsView = z.infer<typeof insightsSchema>;
export const insightsContract = defineContract({
  insights: { input: z.object({ range: z.enum(["7d", "30d", "90d"]).default("30d") }).strict(), output: insightsSchema },
  wardenQuality: { input: z.null(), output: wardenQualitySchema },
});
