import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { modeSchema, pointIdSchema } from "./policy";

const threadInput = z.object({ threadId: z.string().min(1) }).strict();
const pointsSchema = z.record(pointIdSchema, z.boolean());
export type EffectivePoints = z.infer<typeof pointsSchema>;

export const compactionSummarySchema = z
  .object({
    id: z.string(),
    at: z.string(),
    point: z.string(),
    tokensBefore: z.number().nullable(),
    tokensAfter: z.number().nullable(),
    ms: z.number().nullable(),
    outcome: z.string().nullable(),
    model: z.string().nullable(),
    summaryPath: z.string().nullable(),
    boundaryAt: z.number().nullable(),
    boundaryMessageId: z.string().nullable(),
  })
  .loose();

export const decisionSummarySchema = z
  .object({
    at: z.string(),
    point: z.string().nullable(),
    decision: z.string(),
    reason: z.string().nullable(),
    percent: z.number().nullable(),
  })
  .loose();

export const threadStatusSchema = z
  .object({
    threadId: z.string(),
    percent: z.number().nullable(),
    tokens: z.number().nullable(),
    window: z.number().nullable(),
    mode: modeSchema,
    points: pointsSchema,
    summaryModel: z.string().nullable(),
    nextPoint: z.string().nullable(),
    lastCompaction: compactionSummarySchema.nullable(),
    history: z.array(compactionSummarySchema),
    boundaries: z.record(z.string(), z.number().int().nonnegative()),
    decisions: z.array(decisionSummarySchema),
  })
  .loose();

export type CompactionSummary = z.infer<typeof compactionSummarySchema>;
export type DecisionSummary = z.infer<typeof decisionSummarySchema>;
export type ThreadStatusDto = z.infer<typeof threadStatusSchema>;

export const rpcContract = defineRpcContract({
  status: {
    input: threadInput,
    output: threadStatusSchema,
    tags: ({ threadId }) => [`status:${threadId}`],
  },
  summary: {
    input: threadInput.extend({ at: z.iso.datetime({ offset: true }) }),
    output: z.object({ markdown: z.string().nullable(), path: z.string().nullable() }),
  },
  compactNow: {
    input: threadInput,
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  setThreadMode: {
    input: threadInput.extend({ mode: modeSchema }),
    output: z.object({ mode: modeSchema }),
  },
  setThreadPoint: {
    input: threadInput.extend({ point: pointIdSchema, enabled: z.boolean() }),
    output: z.object({ points: pointsSchema }),
  },
});