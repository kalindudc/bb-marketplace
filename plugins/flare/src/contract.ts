import { z } from "zod";
import { defineContract } from "./define-contract";
import { KINDS } from "./kinds";

export const FEED_LIMIT = 300;

const threadId = z.string().min(1).max(100);

export const flareSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  kind: z.enum(KINDS),
  title: z.string(),
  body: z.string(),
  urgent: z.boolean(),
  source: z.enum(["tool", "cli"]),
  createdAt: z.number(),
  runId: z.string().nullable(),
  /** Set when the flare came from a thread below the one being read. */
  fromChild: z.object({ threadId: z.string(), title: z.string().nullable() }).nullable(),
  pushed: z.boolean(),
  forwarded: z.boolean(),
});
export type FlareDto = z.infer<typeof flareSchema>;

export const runSchema = z.object({
  id: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  outcome: z.enum(["running", "done", "failed", "unknown"]),
  error: z.string().nullable(),
  prompt: z.string().nullable(),
});
export type RunDto = z.infer<typeof runSchema>;

export const bannerSchema = z.object({
  flare: flareSchema.nullable(),
  /** Flares in the current or last turn, the shown one included. */
  count: z.number().int(),
  childCount: z.number().int(),
  run: runSchema.nullable(),
});
export type BannerDto = z.infer<typeof bannerSchema>;

export const feedSchema = z.object({
  flares: z.array(flareSchema),
  runs: z.array(runSchema),
  truncated: z.boolean(),
});
export type FeedDto = z.infer<typeof feedSchema>;

export const threadTag = (id: string): string => `flare:thread:${id}`;

export const rpcContract = defineContract({
  banner: {
    input: z.object({ threadId }).strict(),
    output: bannerSchema,
    tags: ({ threadId }: { threadId: string }) => [threadTag(threadId)],
  },
  feed: {
    input: z.object({ threadId, children: z.boolean() }).strict(),
    output: feedSchema,
    tags: ({ threadId }: { threadId: string }) => [threadTag(threadId)],
  },
  dismiss: {
    input: z.object({ threadId, through: z.number().int().nonnegative() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
});
