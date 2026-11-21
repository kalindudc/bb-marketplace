import { moveTime } from "./time";
import { z } from "zod";
export const DELEGATABLE_KINDS = ["production", "merge", "credential", "sends-as-you", "destructive"] as const;
export const CONSEQUENTIAL_ASK_KINDS = ["cluster-write", ...DELEGATABLE_KINDS] as const;
export const delegationKindSchema = z.enum(DELEGATABLE_KINDS);
export type DelegationKind = z.infer<typeof delegationKindSchema>;
const grant = { id: z.string(), surface: z.string(), at: z.number(), endedAt: z.number().nullable(), revokedAt: z.number().nullable() };
export const delegationSchema = z.object({ ...grant, kind: delegationKindSchema });
export const preapprovalInputSchema = z.object({
  greenlight: z.object({ maxMembers: z.number().int().min(0).max(8), classes: z.array(z.string().min(1)).min(1).max(30) }).strict().nullable(),
  placement: z.boolean(), conclude: z.boolean(), endsAt: z.number().int().nonnegative().nullable(),
}).strict();
export const preapprovalSchema = preapprovalInputSchema.extend({ ...grant, retriesUsed: z.number().int().min(0).max(1) });
export type Preapproval = z.infer<typeof preapprovalSchema>;
export type PreapprovalInput = z.infer<typeof preapprovalInputSchema>;
export const actTargetSchema = z.object({ commit: z.string().min(1).max(64).optional(), command: z.string().min(1).max(8000).optional() }).strict();
export type ActTarget = z.infer<typeof actTargetSchema>;
export function preapprovalWords(receipt: { at: number; surface: string }) {
  return `pre-approved by you at ${moveTime(receipt.at, Date.now())} (${receipt.surface.replace("client (unattested)", "client, unattested")})`;
}
export const questAuthorityViewSchema = z.object({
  keeperName: z.string(), rows: z.array(z.object({ kind: z.string(), lane: z.enum(["user", "keeper", "tavern"]) })),
  delegations: z.array(delegationSchema), preapprovals: z.array(preapprovalSchema),
  review: z.object({ used: z.number(), total: z.number() }), spendBudget: z.number().nullable(), spendProposal: z.number().int().positive().optional(),
});
