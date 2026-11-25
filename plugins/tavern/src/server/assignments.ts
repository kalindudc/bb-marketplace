import { hasEndedEngagement, wasReleased } from "../shared/member-engagement";
import type { CharacterDef, ClassDef, Member, Plan } from "../shared/schema";
import { keeperSubject } from "../shared/waypoint";

export function validatePartyCharacters(plan: Pick<Plan, "party">, registry: { classes: ClassDef[]; characters: CharacterDef[] }) {
  for (const slot of plan.party) {
    if (!slot.characterId) continue;
    const role = registry.classes.find(role => role.id === slot.classId);
    const character = registry.characters.find(character => character.id === slot.characterId);
    if (!role || !character?.classes.includes(slot.classId) || !role.characters.includes(slot.characterId))
      throw new Error(`Plan character ${slot.characterId} is unknown, unchecked or incompatible with ${slot.classId}. Choose a character in that class’s pool.`);
  }
}

export function makerForWaypoint(plan: Pick<Plan, "waypoints">, members: Member[], id: string, keeperThreadId?: string): string | null {
  const waypoint = plan.waypoints.find(waypoint => waypoint.id === id);
  if (waypoint && keeperThreadId && keeperSubject(waypoint, keeperThreadId)) return keeperThreadId;
  const makers = members.filter(member => member.role === "member" && member.classId !== "warden");
  return makers.find(member => member.threadId === waypoint?.owner)?.threadId ?? makers.find(member => member.waypointId === id)?.threadId ?? null;
}

export function checkerAssignments(plan: Pick<Plan, "party">, members: Member[]) {
  const remaining = members
    .filter((member) => member.classId === "warden" && !wasReleased(member))
    .sort((a, b) => {
      const inactive = (member: Member) =>
        Number(member.state === "failed" || hasEndedEngagement(member));
      return inactive(a) - inactive(b) || a.createdAt - b.createdAt;
    });
  const assignments: { memberThreadId: string; slot: number; waypointIds: string[] }[] = [];
  for (const [slot, party] of plan.party.entries()) {
    if (party.classId !== "warden") continue;
    const member = party.characterId
      ? remaining.find((member) => member.characterId === party.characterId)
      : remaining.find(
          (member) =>
            member.checkerWaypointId && party.waypointIds.includes(member.checkerWaypointId),
        );
    if (!member) continue;
    assignments.push({ memberThreadId: member.threadId, slot, waypointIds: party.waypointIds });
    remaining.splice(remaining.indexOf(member), 1);
  }
  return assignments;
}
