import { defineContract } from "./define-contract";
import { z } from "zod";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const STUDY_RETENTION_HELP = "Keep study measurements this many days. Zero keeps them indefinitely. This does not prune the ledger or scope history.";
export const STUDY_FOLLOWUP_HELP = "Count the next call from the same thread after a Tavern tool refusal within this many seconds. Zero disables follow-up tracking.";

export const planCauseSchema = z.enum(["steer", "user-answer", "owner-change", "slot-rule", "greenlight-rule", "failed-check", "work-changed"]);
export type PlanCause = z.infer<typeof planCauseSchema>;

const cardSignal = z.object({
  threadId: z.string().min(1), messageId: z.string().min(1), cardId: z.string().min(1),
  cardType: z.enum(["questmap", "ledger", "party", "tale", "ask", "reports", "errand", "summary"]),
  questId: z.string().min(1).nullable(),
  action: z.enum(["first-seen", "expanded", "acted"]),
}).strict();
export type CardSignal = z.infer<typeof cardSignal>;
export const studyContract = defineContract({
  recordCardSignals: { input: z.array(cardSignal), output: z.null() },
});
