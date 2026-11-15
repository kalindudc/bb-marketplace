import { z } from "zod";
import { defineContract } from "./define-contract";
import { awayCloseSchema, awaySnapshotSchema, awayWindowSchema } from "./away";
import { askSchema, eventSchema } from "./schema";

const id = z.string().min(1).max(100);
const count = z.number().int().nonnegative();
export const awayControlSchema = awaySnapshotSchema.safeExtend({
  watchedCount: count, heldCount: count,
  watchedByQuest: z.array(z.object({ questId: id.nullable(), watchedCount: count })).optional(),
  eligibleByQuest: z.array(z.object({ questId: id.nullable(), members: count, watchedCount: count })).optional(),
  // Solos are counted for display, never as party interruption targets.
  soloCount: count.optional(),
  pendingStops: z.array(z.object({ threadId: id, error: z.string().nullable() })),
  resumeRequired: z.array(z.object({ threadId: id, keeperThreadId: id, questId: id.nullable() })),
});
export type AwayControl = z.infer<typeof awayControlSchema>;
export const awayDigestInputSchema = z.object({ windowId: id.optional(), cursor: count.default(0), askCursor: id.nullable().default(null), limit: z.number().int().min(1).max(100).default(30) }).strict();
export const awayDigestSchema = z.object({
  window: awayWindowSchema.nullable(),
  totalEvents: count, nextCursor: count.nullable(), events: z.array(eventSchema),
  totalAsks: count, nextAskCursor: id.nullable(),
  asks: z.array(z.object({ ask: askSchema, waitingAtEnd: z.boolean() })),
  quests: z.array(z.object({ questId: id, title: z.string(), short: z.string(), missing: z.boolean(), events: count, reports: count, decisions: count, asks: count,
    returnedWhileAway: z.boolean().optional(),
    deferredCleanup: z.array(z.object({ threadId: id, action: z.literal("archive-member-thread"), pending: z.boolean(), error: z.string().nullable() })).optional(),
  })),
});
export type AwayDigest = z.infer<typeof awayDigestSchema>;
export const awayContract = defineContract({
  away: { input: z.object({}).strict(), output: awayControlSchema, tags: () => ["tavern:room"] },
  awayClose: { input: awayCloseSchema, output: z.object({ code: z.enum(["closed", "pending", "stale"]), state: awayControlSchema }) },
  awayReturn: { input: z.object({ windowId: id }).strict(), output: z.object({ code: z.enum(["returned", "unchanged", "stale"]), state: awayControlSchema }) },
  awayDigest: { input: awayDigestInputSchema, output: awayDigestSchema, tags: () => ["tavern:room"] },
});
