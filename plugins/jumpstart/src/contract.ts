import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_THREADS = 200;

const threadId = z.string().min(1).max(100);

export const failureSchema = z.object({
  reason: z.string().nullable(),
  failedAt: z.number().nullable(),
  network: z.boolean(),
  restart: z.boolean(),
});

export const kickResultSchema = z.discriminatedUnion("outcome", [
  z.object({ threadId, outcome: z.literal("sent"), restarted: z.literal(true).optional() }),
  z.object({ threadId, outcome: z.literal("queued"), waitingOn: z.string(), restarted: z.literal(true).optional() }),
  z.object({ threadId, outcome: z.literal("failed"), message: z.string() }),
]);
export type KickResult = z.infer<typeof kickResultSchema>;

export const failureTag = (id: string): string => `jumpstart:failure:${id}`;

export const rpcContract = defineRpcContract({
  failures: {
    input: z.object({ keys: z.array(threadId).max(MAX_THREADS) }),
    output: z.record(z.string(), failureSchema),
    keyTags: (key: string) => [failureTag(key)],
  },
  kick: {
    input: z.object({ threadIds: z.array(threadId).min(1).max(MAX_THREADS) }),
    output: z.object({ results: z.array(kickResultSchema) }),
  },
});
