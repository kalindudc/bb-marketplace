import type { Member } from "./schema";

export function memberPlace(member: Pick<Member, "state" | "engagement">): "road" | "rest" | "table" {
  if (member.engagement === "resting" || member.engagement === "released" || member.engagement === "stopped" || member.engagement === "archiving" || member.engagement === "archived") return "rest";
  return member.state === "working" ? "road" : "table";
}
