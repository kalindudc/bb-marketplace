import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { modeSchema, pointIdSchema } from "./policy";

const threadInput = z.object({ threadId: z.string().min(1) }).strict();
const pointsSchema = z.record(pointIdSchema, z.boolean());
export type EffectivePoints = z.infer<typeof pointsSchema>;

/** One compaction of the thread, from Press's own store: the only history the UI reads. */
export const compactionSummarySchema = z
  .object({
    id: z.string(),
    /** When it was requested, or when a compaction Press did not request started. */
    at: z.string(),
    point: z.string(),
    /** The signal or threshold that fired the point, for example `tests.green` or `window.hard`. */
    reason: z.string().nullable(),
    tokensBefore: z.number().nullable(),
    tokensAfter: z.number().nullable(),
    ms: z.number().nullable(),
    outcome: z.enum(["ok", "failed", "cancelled", "pending"]),
    error: z.string().nullable(),
    model: z.string().nullable(),
    /** Set when the composer wrote a summary for this compaction. */
    hasSummary: z.boolean(),
    boundaryAt: z.number().nullable(),
    boundaryMessageId: z.string().nullable(),
  })
  .loose();

export const decisionSummarySchema = z
  .object({
    at: z.string(),
    point: z.string().nullable(),
    decision: z.enum(["compact", "veto"]),
    reason: z.string().nullable(),
    percent: z.number().nullable(),
  })
  .loose();

/** A veto that would block a regular compaction point right now. */
export const blockerSchema = z
  .object({
    veto: z.enum(["midTurn", "cooldownSeconds", "minTurnsBetween", "previousCompactionFailed", "belowFloor"]),
    remainingSeconds: z.number().nullable(),
    remainingTurns: z.number().nullable(),
  })
  .loose();

export const threadStatusSchema = z
  .object({
    threadId: z.string(),
    percent: z.number().nullable(),
    tokens: z.number().nullable(),
    window: z.number().nullable(),
    /** The thread is running a turn (or starting or stopping one), so Press cannot compact it now. */
    running: z.boolean(),
    /** False when Press policy switches off the thread's provider: Press never compacts it automatically. */
    providerEnabled: z.boolean(),
    mode: modeSchema,
    thresholds: z.object({ softPercent: z.number(), hardPercent: z.number(), floorTokens: z.number() }),
    /** The lowest window percent at which any enabled point may fire: each point's own minimum, or softPercent. */
    pointsFromPercent: z.number(),
    /** A compaction Press requested that has not landed yet. */
    compacting: z.object({ since: z.string(), point: z.string().nullable() }).nullable(),
    /** Press is holding the thread's next turn until its compaction lands. */
    held: z.object({ since: z.string(), reason: z.string(), count: z.number().int().nonnegative() }).nullable(),
    blockers: z.array(blockerSchema),
    points: pointsSchema,
    /** Which controls this thread overrides; everything else follows the plugin settings. */
    overrides: z.object({ mode: z.boolean(), points: z.array(pointIdSchema) }),
    summaryModel: z.string().nullable(),
    nextPoint: z.string().nullable(),
    /** Press's estimate of how long compacting the current context takes. */
    estimateMs: z.number().nullable(),
    turnsSince: z.number().int().nonnegative(),
    /** The newest compaction that landed. */
    lastCompaction: compactionSummarySchema.nullable(),
    history: z.array(compactionSummarySchema),
    totals: z.object({ count: z.number().int().nonnegative(), tokensFreed: z.number(), averageMs: z.number().nullable() }),
    /** Boundary message keys (`message:<id>` and the creation time) to an index into `history`. */
    boundaries: z.record(z.string(), z.number().int().nonnegative()),
    decisions: z.array(decisionSummarySchema),
  })
  .loose();

export type CompactionSummary = z.infer<typeof compactionSummarySchema>;
export type DecisionSummary = z.infer<typeof decisionSummarySchema>;
export type Blocker = z.infer<typeof blockerSchema>;
export type ThreadStatusDto = z.infer<typeof threadStatusSchema>;

export const rpcContract = defineRpcContract({
  status: {
    input: threadInput,
    output: threadStatusSchema,
    tags: ({ threadId }) => [`status:${threadId}`],
  },
  summary: {
    input: threadInput.extend({ compactionId: z.string().min(1) }),
    output: z.object({ markdown: z.string().nullable() }),
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
  /** Drop this thread's mode and point overrides so it follows the plugin settings again. */
  resetThread: {
    input: threadInput,
    output: z.object({ ok: z.literal(true) }),
  },
});
