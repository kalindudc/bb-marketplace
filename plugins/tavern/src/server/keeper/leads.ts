import { isDeepStrictEqual } from "node:util";
import type { Actor, BoardQuest, LeadLink, Member, Plan } from "../../shared/schema";
import { waypointCheck } from "../../shared/waypoint";
import { isOpenQuest } from "../liveness";
import { approvedPartyReceipt } from "./quest-lifecycle";
import type { Keeper } from "./service";
import type { HireIntent, KeeperStore } from "./store";

export const holdsLeadSeat = (link: LeadLink) => ["reserved", "linked", "retirement-requested", "retiring"].includes(link.state);

export function currentLead(store: Pick<KeeperStore, "get">, member: Member): LeadLink | null {
  const link = member.leadLinkId ? store.get("leadLinks", member.leadLinkId) : null;
  return link?.childKeeperThreadId === member.threadId ? link : null;
}

export function leadAncestors(store: KeeperStore, questId: string): LeadLink[] {
  const path: LeadLink[] = [], seen = new Set([questId]);
  for (let id = questId; ;) {
    const [link] = store.leadLinksBy("childQuestId", id);
    if (!link) return path;
    if (seen.has(link.parentQuestId)) throw new Error("A Keeper chain cannot contain a cycle.");
    seen.add(link.parentQuestId);
    path.push(link);
    id = link.parentQuestId;
  }
}

export function leadDescendants(store: KeeperStore, questId: string): LeadLink[] {
  const seen = new Set([questId]), links: LeadLink[] = [];
  const visit = (id: string) => {
    for (const link of store.leadLinksBy("parentQuestId", id)) {
      if (!link.childQuestId || seen.has(link.childQuestId) || !holdsLeadSeat(link)) continue;
      seen.add(link.childQuestId);
      links.push(link);
      visit(link.childQuestId);
    }
  };
  visit(questId);
  return links;
}

export function recordLeadOutcome(k: Keeper, child: BoardQuest, outcome: string, askId: string, actor: Actor) {
  const [link] = k.store.leadLinksBy("childQuestId", child.id);
  if (!link || link.state !== "linked" || link.result || link.childKeeperThreadId !== child.keeperThreadId) return;
  const parent = k.quest(link.parentQuestId);
  if (!isOpenQuest(parent) || parent.keeperThreadId !== link.parentKeeperThreadId) return;
  const member = k.member(child.keeperThreadId);
  if (!member || currentLead(k.store, member)?.id !== link.id) throw new Error("The child outcome needs its current lead seat.");
  const waypoint = k.store.get("plans", `${parent.id}:${parent.planVersion}`)?.waypoints.find(w => w.id === link.parentWaypointId);
  if (!waypoint) throw new Error("The parent plan no longer has this lead waypoint.");
  const makerThreadId = member.threadId;
  const entryId = k.journal.linkWaypoint(makerThreadId, { boardQuestId: parent.id, waypointId: waypoint.id }, waypoint.title, makerThreadId, { kind: "tavern" });
  const eventId = k.store.event(k.now(), parent.keeperThreadId, parent.id, "lead.outcome", outcome,
    { askId, leadLinkId: link.id, childQuestId: child.id, waypointId: waypoint.id }, actor);
  if (k.journal.get(makerThreadId).entries.some(entry => entry.id === entryId && entry.status === "verified"))
    k.journal.edit(makerThreadId, { op: "status", entryIds: [entryId], status: "todo" }, { kind: "tavern" });
  k.journal.edit(makerThreadId, { op: "status", entryIds: [entryId], status: "done",
    evidence: [{ kind: "note", ref: `Child quest ${child.id}, outcome ${eventId}`, detail: outcome.slice(0, 1000), exitCode: null }] }, { kind: "tavern" });
  k.store.put("leadLinks", link.id, { ...link, result: { eventId, makerThreadId, entryId } });
  k.changed(parent.keeperThreadId, parent.id);
}

export function assertLeadPathOpen(store: KeeperStore, link: LeadLink) {
  for (const seat of [link, ...leadAncestors(store, link.parentQuestId)]) {
    const quest = store.get("quests", seat.parentQuestId);
    if (seat.state !== "linked" || !isOpenQuest(quest) || quest.phase === "held" || quest.phase === "closing")
      throw new Error("This lead's parent quest is held, closing, ended or no longer linked.");
    if (quest.keeperThreadId !== seat.parentKeeperThreadId) throw new Error("This lead's parent Keeper has changed. Refresh the lead link before continuing.");
    const keeper = store.get("members", quest.keeperThreadId);
    const host = store.runtime(quest.keeperThreadId);
    if (!keeper || keeper.engagement === "archived" || host.archivedAt != null || host.deletedAt != null)
      throw new Error("This lead's parent Keeper is no longer present.");
  }
}

export function subtreeSeats(store: KeeperStore, rootId: string, plan?: Plan) {
  const seen = new Set<string>();
  const count = (questId: string): { members: number; rangers: number } => {
    if (seen.has(questId)) throw new Error("A Keeper chain cannot contain a cycle.");
    seen.add(questId);
    let { members, rangers } = store.chainSeats(questId);
    if (plan?.boardQuestId === questId) {
      members = Math.max(members, plan.party.length);
      rangers = Math.max(rangers, plan.party.filter(slot => slot.classId === "ranger").length);
    }
    for (const link of store.leadLinksBy("parentQuestId", questId)) {
      if (!holdsLeadSeat(link) || !link.childQuestId) continue;
      const child = count(link.childQuestId);
      members += child.members;
      rangers += child.rangers;
    }
    return { members, rangers };
  };
  return count(rootId);
}

function assertDepth(k: Keeper, questId: string, depth: number) {
  if (depth > k.settings(questId).keepers.chainDepth) throw new Error("This lead exceeds the chain depth in Settings.");
}

export function assertChainPlan(k: Keeper, quest: BoardQuest, plan: Plan) {
  const path = leadAncestors(k.store, quest.id);
  if (path[0]) assertLeadPathOpen(k.store, path[0]);
  const leads = plan.party.filter(slot => slot.classId === "keeper" || slot.leadEnvelope !== undefined);
  const waypoints = new Set<string>();
  for (const slot of leads) {
    const waypoint = plan.waypoints.find(w => w.id === slot.waypointIds[0]);
    if (!slot.leadEnvelope || slot.waypointIds.length !== 1 || !waypoint || waypoint.actor !== "agent" || waypoints.has(waypoint.id))
      throw new Error("Every lead needs its own agent waypoint and member, Ranger and depth limits in the plan.");
    waypoints.add(waypoint.id);
    assertDepth(k, quest.id, Math.max(path.length + 1, slot.leadEnvelope.depth));
    if (slot.leadEnvelope.depth < path.length + 1) throw new Error("This lead's envelope depth cannot exclude its own layer.");
  }
  const rootId = path.at(-1)?.parentQuestId ?? quest.id;
  if ((path.length || leads.length || k.store.leadLinksBy("parentQuestId", rootId).some(holdsLeadSeat)) &&
      subtreeSeats(k.store, rootId, plan).members > k.settings(rootId).keepers.chainMembers)
    throw new Error("This plan exceeds the chain member limit in Settings.");
}

export function assertChainHire(k: Keeper, questId: string, classId: string, lead: boolean) {
  const path = leadAncestors(k.store, questId);
  if (path[0]) assertLeadPathOpen(k.store, path[0]);
  if (lead) {
    assertDepth(k, questId, path.length + 1);
    if (path.some(link => path.length + 1 > link.envelope.depth)) throw new Error("This hire exceeds an approved lead chain depth.");
  }
  const rootId = path.at(-1)?.parentQuestId ?? questId;
  if ((lead || path.length || k.store.leadLinksBy("parentQuestId", rootId).some(holdsLeadSeat)) &&
      subtreeSeats(k.store, rootId).members >= k.settings(rootId).keepers.chainMembers)
    throw new Error("This hire exceeds the chain member limit in Settings.");
  for (const link of path) {
    const { members, rangers } = subtreeSeats(k.store, link.childQuestId!);
    if (members >= link.envelope.members || classId === "ranger" && rangers >= link.envelope.rangers)
      throw new Error("This hire exceeds an approved lead member or Ranger limit.");
  }
}

export function leadAuthorization(k: Keeper, quest: BoardQuest, classId: string, waypointId: string): Pick<LeadLink, "parentPlan" | "envelope"> {
  if (!isOpenQuest(quest) || quest.phase === "held" || quest.phase === "closing") throw new Error("The lead's parent quest is held, closing or ended.");
  const approved = k.store.get("plans", `${quest.id}:${quest.greenlitVersion}`);
  const receipt = approvedPartyReceipt(k.store, quest);
  if (!approved || !receipt || receipt.kind !== "ask-answer" && receipt.kind !== "decision") throw new Error("A lead needs a recorded greenlight on its parent plan.");
  const slot = approved.party.find(s => s.classId === classId && s.waypointIds.includes(waypointId));
  const waypoint = approved.waypoints.find(w => w.id === waypointId);
  const current = k.store.get("plans", `${quest.id}:${quest.planVersion}`);
  const currentSlot = current?.party.find(s => s.classId === classId && s.waypointIds.includes(waypointId));
  const currentWaypoint = current?.waypoints.find(w => w.id === waypointId);
  if (!slot?.leadEnvelope || !waypoint || !isDeepStrictEqual(slot, currentSlot) || !isDeepStrictEqual(waypoint, currentWaypoint))
    throw new Error("The lead needs its own unchanged waypoint and envelope in the greenlit parent plan.");
  return { parentPlan: { version: approved.version, receipt: { kind: receipt.kind, id: receipt.id }, check: waypointCheck(waypoint), acts: waypoint.acts }, envelope: slot.leadEnvelope };
}

export function reserveLead(k: Keeper, quest: BoardQuest, input: { classId: string; waypointId: string; token: string }, authorization: ReturnType<typeof leadAuthorization>) {
  if (k.store.leadLinksBy("parentQuestId", quest.id).some(link => link.parentWaypointId === input.waypointId && holdsLeadSeat(link)))
    throw new Error("This waypoint already has a live or reserved lead.");
  if (!isDeepStrictEqual(leadAuthorization(k, quest, input.classId, input.waypointId), authorization))
    throw new Error("The approved lead envelope changed before this hire was reserved; retry.");
  const link: LeadLink = { id: k.store.id("lead"), hireToken: input.token, parentKeeperThreadId: quest.keeperThreadId, parentQuestId: quest.id,
    parentWaypointId: input.waypointId, childKeeperThreadId: null, childQuestId: null, generation: 1, ...authorization, state: "reserved" };
  saveLead(k, link, "lead.reserved", { kind: "agent", threadId: quest.keeperThreadId });
  return link.id;
}

export function bindLead(k: Keeper, token: string, linkId: string, member: Member) {
  const link = k.store.get("leadLinks", linkId);
  if (!link || link.hireToken !== token || link.parentKeeperThreadId !== member.keeperThreadId || link.parentQuestId !== member.boardQuestId || link.parentWaypointId !== member.waypointId || (link.state !== "reserved" && link.state !== "linked") || (link.childKeeperThreadId !== null && link.childKeeperThreadId !== member.threadId))
    throw new Error("This child does not match the recorded lead reservation.");
  if (link.state === "reserved") saveLead(k, { ...link, childKeeperThreadId: member.threadId, state: "linked" }, "lead.bound", { kind: "tavern" });
}

export function cancelLead(k: Keeper, token: string, hire: HireIntent) {
  if (!hire.leadLinkId) return;
  const link = k.store.get("leadLinks", hire.leadLinkId);
  if (link?.hireToken === token && !link.childQuestId && holdsLeadSeat(link))
    saveLead(k, { ...link, state: "cancelled" }, "lead.cancelled", { kind: "tavern" });
}

export function saveLead(k: Keeper, link: LeadLink, type: "lead.reserved" | "lead.bound" | "lead.opened" | "lead.cancelled", actor: Actor) {
  k.store.put("leadLinks", link.id, link);
  k.store.event(k.now(), link.parentKeeperThreadId, link.parentQuestId, type, `Lead for ${link.parentWaypointId}: ${type.slice(5)}.`, { leadLinkId: link.id, waypointId: link.parentWaypointId, memberThreadId: link.childKeeperThreadId, childQuestId: link.childQuestId, receipt: { kind: "hire", id: link.hireToken } }, actor);
}
