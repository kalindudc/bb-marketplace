import { z } from "zod";
import type { Member } from "./schema";

export const ENGAGEMENTS = ["briefing", "active", "resting", "releasing", "released", "stopping", "stopped", "archiving", "archived"] as const;
export const DISPOSITIONS = ["finished", "released", "stopped", "retired unfinished"] as const;
export type Engagement = (typeof ENGAGEMENTS)[number];
export type Disposition = (typeof DISPOSITIONS)[number];
export const engagementSchema = z.enum(ENGAGEMENTS);
export const dispositionSchema = z.enum(DISPOSITIONS);

export function wasReleased(member: Pick<Member, "engagement" | "disposition"> | null | undefined): boolean {
  return member?.engagement === "released" || member?.disposition === "released";
}

export function hasEndedEngagement(member: Pick<Member, "engagement">): boolean {
  return member.engagement === "resting" || member.engagement === "released" || member.engagement === "stopped" || member.engagement === "archiving" || member.engagement === "archived";
}

export function memberActivityWord(member: Pick<Member, "engagement" | "disposition" | "state">, ended = false): string {
  if (member.engagement === "archived") return member.disposition === "released" || member.disposition === "stopped" ? `${member.disposition}; archived` : "archived";
  if (member.engagement === "resting" && ended) return "finished";
  if (member.engagement === "active" || member.engagement === undefined) return member.state;
  if (member.engagement === "briefing" && member.state === "failed") return "failed";
  return member.engagement;
}
