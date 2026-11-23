import { hasEndedEngagement, wasReleased } from "../shared/member-engagement";
import type { CharacterDef, ClassDef, Member, Plan } from "../shared/schema";

export function validatePartyCharacters(plan: Pick<Plan, "party">, registry: { classes: ClassDef[]; characters: CharacterDef[] }) {
  for (const slot of plan.party) {
    if (!slot.characterId) continue;
    const role = registry.classes.find(role => role.id === slot.classId);
    const character = registry.characters.find(character => character.id === slot.characterId);
    if (!role || !character?.classes.includes(slot.classId) || !role.characters.includes(slot.characterId))
      throw new Error(`Plan character ${slot.characterId} is unknown, unchecked or incompatible with ${slot.classId}. Choose a character in that class’s pool.`);
  }
}

export function makerForWaypoint(plan: Pick<Plan, "waypoints">, members: Member[], id: string): string | null {
  const waypoint = plan.waypoints.find(waypoint => waypoint.id === id);
  const makers = members.filter(member => member.role === "member" && member.classId !== "warden");
  return makers.find(member => member.threadId === waypoint?.owner)?.threadId ?? makers.find(member => member.waypointId === id)?.threadId ?? null;
}

export function validateCheckerMakers(plan: Pick<Plan, "party" | "waypoints">, members: Member[] = []) {
  const assignments = checkerAssignments(plan, members);
  for (const [index, slot] of plan.party.entries()) {
    if (slot.classId !== "warden") continue;
    const pairs = slot.waypointIds.flatMap(id => {
      const maker = makerForWaypoint(plan, members, id);
      return maker ? [{ id, maker }] : [];
    });
    const details = () => pairs.map(({ id, maker }) => `${id} (maker ${maker})`).join(", ");
    if (new Set(pairs.map(pair => pair.maker)).size > 1)
      throw new Error(`Warden slot ${index + 1} mixes makers: ${details()}. Revise the plan to use one Warden slot per maker.`);
    const checker = members.find(member => member.threadId === assignments.find(a => a.slot === index)?.memberThreadId);
    const pinned = checker?.checkerMakerThreadId;
    if (pinned && pairs.some(pair => pair.maker !== pinned))
      throw new Error(`Warden ${checker.threadId} is pinned to maker ${pinned}, but slot ${index + 1} has ${details()}. Revise the plan to use one Warden slot per maker.`);
  }
}

export function checkerAssignments(plan: Pick<Plan, "party" | "waypoints">, members: Member[]) {
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
    const pinnedMaker = member.checkerMakerThreadId;
    const waypointIds = pinnedMaker
      ? party.waypointIds.filter(id => makerForWaypoint(plan, members, id) === pinnedMaker)
      : party.waypointIds;
    assignments.push({ memberThreadId: member.threadId, slot, waypointIds });
    remaining.splice(remaining.indexOf(member), 1);
  }
  return assignments;
}
