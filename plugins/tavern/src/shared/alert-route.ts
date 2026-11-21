import { z } from "zod";
import { defineContract } from "./define-contract";

const holdReason = z.enum(["mode-none", "quiet-hours", "closed-window", "plugin-missing", "plugin-disabled"]);
export const pushOutcome = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("sent") }),
  z.object({ outcome: z.literal("held"), reason: holdReason }),
  z.object({ outcome: z.literal("failed"), error: z.string() }),
]);
const response = z.enum(["arrived", "not-arrived"]);
const eventId = z.number().int().positive();
const alertRouteView = z.object({
  proven: z.boolean(),
  lastTest: z.intersection(pushOutcome, z.object({ id: eventId, at: z.number(), response: response.nullable() })).nullable(),
  lastFailure: z.object({ at: z.number(), error: z.string() }).nullable(),
});
export type PushOutcome = z.infer<typeof pushOutcome>;
export type HoldReason = z.infer<typeof holdReason>;
export type AlertRouteView = z.infer<typeof alertRouteView>;
export const testResponse = z.object({ id: eventId, response });
export const alertRouteTag = "tavern:alert-route";
export const alertRouteContract = defineContract({
  alertRoute: { input: z.null(), output: alertRouteView, tags: () => [alertRouteTag] },
  alertTestSend: { input: z.object({}).strict(), output: alertRouteView },
  alertTestConfirm: { input: z.object({ id: eventId, arrived: z.boolean() }).strict(), output: alertRouteView },
});
