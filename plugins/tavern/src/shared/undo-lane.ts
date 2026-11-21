import { z } from "zod";
import { DELEGATABLE_KINDS } from "./quest-authority";

export const KEEPER_CALL_KINDS = ["accepted", "skipped", "open", "party", "rangers", "lead-plan"] as const;
export type KeeperCallKind = typeof KEEPER_CALL_KINDS[number];
export const undoKindSchema = z.enum(["sends-as-you", ...DELEGATABLE_KINDS, ...KEEPER_CALL_KINDS]);
export type UndoKind = z.infer<typeof undoKindSchema>;
export const undoLaneSchema = z.object({ kind: undoKindSchema, undone: z.number().int().min(2).max(10), recent: z.number().int().min(2).max(10) });
export type UndoLane = z.infer<typeof undoLaneSchema>;
export const undoKindWords: Record<UndoKind, string> = {
  production: "production decisions", merge: "merge decisions", credential: "credential decisions", "sends-as-you": "decisions to send as you", "drafts-as-you": "decisions to draft as you", destructive: "destructive decisions",
  accepted: "waypoint acceptances", skipped: "waypoint skips", open: "waypoint reopenings", party: "party exceptions", rangers: "Ranger exceptions", "lead-plan": "lead-plan decisions",
};
export const keeperUndoLaneWords = (lane: UndoLane) => `The user undid ${lane.undone} of your last ${lane.recent} ${undoKindWords[lane.kind]}; ask the user until they reset this kind in the Ledger.`;
export const undoLaneWords = (lane: UndoLane) => `You undid ${lane.undone} of my last ${lane.recent} ${undoKindWords[lane.kind]}; I’ll ask you about those now.`;
