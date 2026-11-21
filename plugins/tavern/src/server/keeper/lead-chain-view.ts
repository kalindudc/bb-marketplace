import type { BoardQuestSummary } from "../../shared/contract";
import type { Ask, BoardQuest, LeadLink } from "../../shared/schema";
import { isOpenQuest } from "../liveness";
import { holdsLeadSeat, leadAncestors, leadDescendants } from "./leads";
import type { Keeper } from "./service";

type Chain = NonNullable<BoardQuestSummary["leadChain"]>;

export function leadChainView(k: Keeper, q: BoardQuest, children: LeadLink[], waypoints: BoardQuestSummary["waypoints"], asks: Ask[]): Chain | undefined {
  const [incoming] = k.store.leadLinksBy("childQuestId", q.id);
  if (!incoming && !children.length) return undefined;
  const links = children.filter(link => holdsLeadSeat(link) || link.childQuestId);
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
    return { parentQuestId: parent.id, parentTitle: parent.title, limits: incoming.envelope, authority,
      parentDecisions: [...(currentPlan && plan.lane === "keeper" ? [`Plan v${plan.request.version}`] : []), ...(close ? ["Conclude the settled child quest"] : [])] };
  })();
  return {
    ...(seat ? { seat } : {}),
    children: links.map(link => {
      const child = link.childQuestId ? k.store.get("quests", link.childQuestId) : null;
      const member = link.childKeeperThreadId ? k.member(link.childKeeperThreadId) : null;
      const waypoint = waypoints.find(item => item.id === link.parentWaypointId);
      return { linkId: link.id, leadName: member ? k.name(member) : "Lead", state: link.state, ...(link.cleanupError ? { error: link.cleanupError } : {}),
        waypointTitle: waypoint?.title ?? link.parentWaypointId, checkState: waypoint?.state ?? null,
        quest: child ? { id: child.id, title: child.title, phase: child.phase, party: k.store.chainSeats(child.id).members } : null };
    }),
    asks: leadDescendants(k.store, q.id).flatMap(link => k.store.openAsks(link.childKeeperThreadId ?? undefined, link.childQuestId!, true)
      .map(ask => ({ id: ask.id, title: ask.question, questId: link.childQuestId! }))),
  };
}
