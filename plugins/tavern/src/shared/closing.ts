import { z } from "zod";
import { taleResultsSchema } from "./tale-results";
import { pullRequestSchema } from "./pull-request";

export const questOutcomeSchema = z.enum(["concluded", "closed-early", "stopped"]);
const phase = z.enum(["scout", "greenlight", "build"]);
export const unsettledWaypointSchema = z.object({
  waypointId: z.string(), title: z.string(), state: z.enum(["planned", "todo", "doing", "blocked", "rejected", "reported"]), reason: z.string().min(1),
});
export const waypointWaiverSchema = unsettledWaypointSchema.extend({ askId: z.string(), planVersion: z.number().int().nonnegative() });
export type WaypointWaiver = z.infer<typeof waypointWaiverSchema>;
export const closeSteerSchema = z.object({ routeId: z.string(), at: z.number().int().nonnegative(), text: z.string() });
export const closePullRequestSchema = pullRequestSchema.pick({ id: true, url: true, owner: true, forge: true, head: true, base: true }).extend({
  state: z.enum(["draft", "ready"]), headCommit: z.string(), headVerified: z.boolean(), ownerName: z.string(), closeUnavailable: z.string().optional(), stateNote: z.string().optional(),
});
export type ClosePullRequest = z.infer<typeof closePullRequestSchema>;
export const pullRequestChoicesSchema = z.array(z.object({ id: z.string().min(1).max(120), action: z.enum(["keep", "you", "close"]) }).strict());
export type PullRequestChoices = z.infer<typeof pullRequestChoicesSchema>;
export const concludeDraftSchema = z.object({
  outcome: z.string(), left: z.string(), next: z.array(z.string()).optional(), results: taleResultsSchema.optional(),
  skipped: z.array(z.object({ waypointId: z.string(), reason: z.string() })).optional(),
  planVersion: z.number().int().nonnegative().optional(), returnTo: phase.optional(), fromSteer: closeSteerSchema.optional(),
  pullRequests: z.array(closePullRequestSchema).optional(),
  lead: z.object({ linkId: z.string().min(1), generation: z.number().int().positive(), parentVersion: z.number().int().positive() }).optional(),
});
export const closeEarlyDraftSchema = concludeDraftSchema.extend({ unsettled: z.array(unsettledWaypointSchema), noPlan: z.literal(true).optional(), reason: z.string().min(1).optional() })
  .refine(draft => draft.noPlan ? draft.unsettled.length === 0 : draft.unsettled.length > 0, "Close early needs open waypoints or an unplanned quest");
export const isCloseEffect = <T extends { type: string }>(effect: T | null | undefined): effect is Extract<T, { type: "conclude" | "close-early" }> =>
  effect?.type === "conclude" || effect?.type === "close-early";
export const waiverWords = (state: z.infer<typeof unsettledWaypointSchema>["state"]) =>
  state === "reported" ? "made, not verified" : state === "rejected" ? "rejected, not fixed" : "not done";
export const waiverLine = (w: Pick<WaypointWaiver, "waypointId" | "state">) => `${w.waypointId} recorded as ${waiverWords(w.state)}`;
