import { z } from "zod";
import { DELEGATABLE_KINDS } from "./quest-authority";

export const undoKindSchema = z.enum(DELEGATABLE_KINDS);
export type UndoKind = z.infer<typeof undoKindSchema>;
export const undoLaneSchema = z.object({ kind: undoKindSchema, undone: z.number().int().min(2).max(10), recent: z.number().int().min(2).max(10) });
export type UndoLane = z.infer<typeof undoLaneSchema>;
export const undoKindWords: Record<UndoKind, string> = {
  production: "production decisions", merge: "merge decisions", credential: "credential decisions", "sends-as-you": "decisions to send as you", destructive: "destructive decisions",
};
export const keeperUndoLaneWords = (lane: UndoLane) => `The user undid ${lane.undone} of your last ${lane.recent} ${undoKindWords[lane.kind]}; ask the user until they reset this kind in the Ledger.`;
export const undoLaneWords = (lane: UndoLane) => `You undid ${lane.undone} of my last ${lane.recent} ${undoKindWords[lane.kind]}; I’ll ask you about those now.`;
