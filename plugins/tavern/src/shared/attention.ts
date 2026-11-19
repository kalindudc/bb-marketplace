import type { KeeperNote } from "./schema";
import { z } from "zod";
export const attentionItemSchema = z.object({
  detail: z.object({ text: z.string(), why: z.string().optional(), sourceMessageId: z.string().nullable(), validUntil: z.number().nullable() }).optional(),
  id: z.string(), kind: z.enum(["ask", "hold", "rule", "hand-back", "summary", "decided", "held"]),
  questId: z.string().nullable(), keeperThreadId: z.string().nullable(),
  title: z.string(), action: z.string(), since: z.number(), seen: z.boolean(),
});
export const attentionSchema = z.object({
  decided: z.number().int().nonnegative().optional(), oldest: z.number().nullable().optional(),
  items: z.array(attentionItemSchema), needYou: z.number().int().nonnegative(),
  new: z.number().int().nonnegative(), heldByYou: z.number().int().nonnegative(),
});
export type Attention = z.infer<typeof attentionSchema>;
export type AttentionItem = z.infer<typeof attentionItemSchema>;
const empty: Attention = { items: [], needYou: 0, new: 0, heldByYou: 0 };
export const attentionView = (list?: Attention) => list ?? empty;
export const attentionNotes = (list: Attention): KeeperNote[] => list.items.filter(item => item.kind === "hand-back" && item.detail).map(item => ({ id: item.id, kind: "waiting-on-user", keeperThreadId: item.keeperThreadId!, boardQuestId: item.questId, text: item.detail!.text, action: item.title, why: item.detail!.why, validUntil: item.detail!.validUntil, sourceMessageId: item.detail!.sourceMessageId, routeId: null, state: "open", createdAt: item.since, updatedAt: item.since, doneAt: null, dueNotifiedAt: null, condition: null, dueAt: null }));
export const attentionTitle = (list: Attention, group: "need" | "new") => list.items
  .filter(item => group === "new" ? item.kind === "summary" || item.kind === "decided" : !["summary", "decided", "held"].includes(item.kind))
  .slice(0, 5).map(item => `${item.kind}: ${item.title}`).join(" · ");
