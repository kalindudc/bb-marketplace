import type { BoardQuestSummary } from "../../shared/contract";
import type { Ask, BoardQuest, LeadLink } from "../../shared/schema";
import { isOpenQuest } from "../liveness";
import { holdsLeadSeat, leadAncestors } from "./leads";
import type { Keeper } from "./service";

type Chain = NonNullable<BoardQuestSummary["leadChain"]>;

export function leadChainView(k: Keeper, q: BoardQuest, children: LeadLink[], waypoints: BoardQuestSummary["waypoints"], asks: Ask[]): Chain | undefined {
  const [incoming] = k.store.leadLinksBy("childQuestId", q.id);
  if (!incoming && !children.length) return undefined;
  const current = new Map<string, LeadLink>();
  for (const link of children) {
    const previous = current.get(link.parentWaypointId);
    if (!previous || !holdsLeadSeat(previous)) current.set(link.parentWaypointId, link);
  }
  const byWaypoint = new Map(waypoints.map(waypoint => [waypoint.id, waypoint]));
  const seat = incoming && (() => {
    const parent = k.quest(incoming.parentQuestId);
    const plan = q.phase === "greenlight" ? k.store.get("leadPlans", `${q.id}:${q.planVersion}`) : null;
    const pathOpen = leadAncestors(k.store, q.id).every(link => {
      const ownerQuest = k.store.get("quests", link.parentQuestId);
      return link.state === "linked" && isOpenQuest(ownerQuest) && ownerQuest.phase !== "held" && ownerQuest.phase !== "closing";
    });
    const currentPlan = pathOpen && plan?.state === "pending" && plan.generation === incoming.generation && plan.parentVersion === parent.planVersion;
    const close = pathOpen && asks.some(ask => ask.effect?.type === "conclude" &&
      ask.effect.draft.lead?.generation === incoming.generation && ask.effect.draft.lead.parentVersion === parent.planVersion);
    const authority = isOpenQuest(q) ? k.authority.view(q.id).rows.filter(row => row.kind !== "greenlight" && row.kind !== "conclude") : [];
    if (currentPlan && plan.lane === "user") authority.push({ kind: `Plan v${plan.request.version}`, lane: "user" });
    if (asks.some(ask => ask.effect?.type === "close-early" || ask.effect?.type === "conclude" && !ask.effect.draft.lead))
      authority.push({ kind: "Quest closure", lane: "user" });
    return { parentQuestId: parent.id, parentTitle: parent.title, parentKeeperThreadId: parent.keeperThreadId, limits: incoming.envelope, authority,
      parentDecisions: [...(currentPlan && plan.lane === "keeper" ? [`Plan v${plan.request.version}`] : []), ...(close ? ["Conclude the settled child quest"] : [])] };
  })();
  return {
    ...(seat ? { seat } : {}),
    children: children.map(link => {
      const child = link.childQuestId ? k.store.get("quests", link.childQuestId) : null;
      const member = link.childKeeperThreadId ? k.member(link.childKeeperThreadId) : null;
      const waypoint = byWaypoint.get(link.parentWaypointId);
      const sideQuest = { linkId: link.id, leadName: member ? k.name(member) : "Side Keeper", state: link.state,
        ...(link.cleanupError ? { error: link.cleanupError } : {}),
        quest: child ? { id: child.id, title: child.title, phase: child.phase } : null };
      const isCurrent = current.get(link.parentWaypointId)?.id === link.id;
      if (isCurrent && waypoint) waypoint.sideQuest = sideQuest;
      return { ...sideQuest, current: isCurrent, waypointTitle: waypoint?.title ?? link.parentWaypointId };
    }),
  };
}
