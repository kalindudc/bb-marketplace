import { z } from "zod";
import { actorSchema } from "./schema";

export const QUEUED_STOP_NOTICE = "A message queued together with Tavern\'s own work waits until you resume.";
export const RESUME_ATTESTATION_NOTICE = "Tavern can\'t prove a person pressed Resume";

export const stopReceiptSchema = z.object({
  id: z.string().optional(), surface: z.string().optional(), pluginId: z.string().optional(),
  startedAt: z.number(), completedAt: z.number().nullable(), elapsedMs: z.number(),
  stopped: z.number(), keepersStopped: z.number(), membersStopped: z.number(),
  stillStopping: z.number(), failed: z.number(), alreadyIdle: z.number(),
  entries: z.array(z.object({
    threadId: z.string(), role: z.enum(["keeper", "member"]),
    status: z.enum(["stopped", "still-stopping", "failed", "already-idle"]),
    error: z.string().nullable(), confirmedAt: z.number().nullable(),
  })),
});
export type StopReceipt = z.infer<typeof stopReceiptSchema>;
export const stopAllStateSchema = z.object({
  state: z.enum(["running", "stopped"]), since: z.number().nullable(),
  by: actorSchema.nullable(), byLabel: z.string().optional(), receipt: stopReceiptSchema.nullable(),
  resumeReceipt: z.object({ at: z.number(), surface: z.string(), notice: z.string(), personProven: z.literal(false) }).optional(),
});
export type StopAllState = z.infer<typeof stopAllStateSchema>;
export function stopBy(state: StopAllState): string {
  return state.byLabel ?? (state.by?.kind === "user" ? "you" : state.by?.kind === "agent" ? `agent ${state.by.threadId}` : "an unverified caller");
}
export const stopAllContract = {
  stopAllStatus: { input: z.object({}).strict(), output: stopAllStateSchema, tags: () => ["tavern:stop-all"] },
  stopAll: { input: z.object({}).strict(), output: stopAllStateSchema },
  resumeAll: { input: z.object({}).strict(), output: stopAllStateSchema },
};
