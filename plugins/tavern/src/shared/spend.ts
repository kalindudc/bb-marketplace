import { z } from "zod";

export const budgetCentsSchema = z.number().int().positive().max(100_000_000);
export const spendBudgetSchema = z.object({ cents: budgetCentsSchema, reached: z.object({ at: z.number().int(), usdNanos: z.number().nonnegative() }).nullable() });
export const spendProposalSchema = z.object({ planVersion: z.number().int().positive(), cents: budgetCentsSchema });
export const spendViewSchema = z.object({
  budgetCents: budgetCentsSchema.nullable(), reachedAt: z.number().int().nullable(), usdNanos: z.number().nonnegative().nullable(),
  proposal: spendProposalSchema.optional(),
  missing: z.number().int().nonnegative(), sources: z.array(z.object({ name: z.string(), readAt: z.number().int() })),
});
export type SpendView = z.infer<typeof spendViewSchema>;

export const spendReceiptSchema = z.object({
  source: z.string().min(1).max(40), session: z.string().min(1).max(100), entry: z.string().min(1).max(100),
  at: z.number().int().nonnegative(), usdNanos: z.number().int().nonnegative().safe().nullable(),
}).strict();
export type SpendReceipt = z.infer<typeof spendReceiptSchema>;
export const NANOS_PER_DOLLAR = 1_000_000_000;
export const NANOS_PER_CENT = 10_000_000;
const dollar = new Intl.NumberFormat(undefined, { currency: "USD", style: "currency" });
export const usd = (amount: number) => dollar.format(amount);
export const spendCoverage = "The budget covers only spend Tavern can measure: guarded local sessions with cost receipts and sessions Burn can report. Other usage, including uncovered remote sessions, is unknown. Work already admitted can take spend past the cap.";
