import { PHASES, type KeeperNote } from "./schema";
import { z } from "zod";
const countsSchema = z.object({
  ask: z.number().int().nonnegative(), hold: z.number().int().nonnegative(),
  "hand-back": z.number().int().nonnegative(), rule: z.number().int().nonnegative(),
  stopped: z.number().int().nonnegative(),
});
export type AttentionCounts = z.infer<typeof countsSchema>;
export const fromStoppedKeeper = (item: AttentionItem) => item.who?.state === "archived";
export const attentionItemSchema = z.object({
  detail: z.object({ text: z.string(), why: z.string().optional(), sourceMessageId: z.string().nullable(), validUntil: z.number().nullable() }).optional(),
  who: z.object({ state: z.enum(["running", "idle", "quiet", "archived"]), startedAt: z.number().nullable(), questTitle: z.string().nullable() }).optional(),
  scope: z.object({ kind: z.enum(["global", "project", "keeper", "quest"]), label: z.string().nullable() }).optional(),
  need: z.string().optional(),
  id: z.string(), kind: z.enum(["ask", "hold", "rule", "hand-back", "summary", "decided", "held", "quest-changed"]),
  phaseChange: z.object({ from: z.enum(PHASES), to: z.enum(PHASES) }).optional(),
  questId: z.string().nullable(), keeperThreadId: z.string().nullable(),
  title: z.string(), action: z.string(), since: z.number(), seen: z.boolean(),
});
export const attentionSchema = z.object({
  summaries: z.number().int().nonnegative().optional(),
  changedQuests: z.number().int().nonnegative().optional(),
  counts: countsSchema.optional(),
  decided: z.number().int().nonnegative().optional(), oldest: z.number().nullable().optional(),
  items: z.array(attentionItemSchema), needYou: z.number().int().nonnegative(),
  new: z.number().int().nonnegative(), heldByYou: z.number().int().nonnegative(),
});
export const sinceVisitSchema = z.object({
  quests: z.array(z.object({ id: z.string(), title: z.string(), summaries: z.array(attentionItemSchema), change: attentionItemSchema.nullable() })),
  summaries: z.number().int().nonnegative(),
  decided: z.number().int().nonnegative(), changedQuests: z.number().int().nonnegative(),
});
export type SinceVisit = z.infer<typeof sinceVisitSchema>;
export type Attention = z.infer<typeof attentionSchema>;
export type AttentionItem = z.infer<typeof attentionItemSchema>;
const empty: Attention = { items: [], needYou: 0, new: 0, heldByYou: 0 };
export const attentionView = (list?: Attention) => list ?? empty;
export const attentionNotes = (list: Attention): KeeperNote[] => list.items.filter(item => item.kind === "hand-back" && item.detail).map(item => ({ id: item.id, kind: "waiting-on-user", keeperThreadId: item.keeperThreadId!, boardQuestId: item.questId, text: item.detail!.text, action: item.title, why: item.detail!.why, validUntil: item.detail!.validUntil, sourceMessageId: item.detail!.sourceMessageId, routeId: null, state: "open", createdAt: item.since, updatedAt: item.since, doneAt: null, dueNotifiedAt: null, condition: null, dueAt: null }));
export const attentionTitle = (list: Attention, group: "need" | "new") => {
  const items = list.items.filter(item => group === "new" ? item.kind === "summary" || item.kind === "decided" : ["ask", "hold", "rule", "hand-back"].includes(item.kind));
  const selected = group === "new" ? [...new Set([items.find(item => item.kind === "summary"), items.find(item => item.kind === "decided"), ...items])].filter(item => item !== undefined) : items;
  return selected.slice(0, 5).map(item => `${item.kind}: ${item.title}`).join(" · ");
};
