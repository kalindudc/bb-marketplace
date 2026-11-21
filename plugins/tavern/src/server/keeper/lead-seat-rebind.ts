import { transitionMember } from "../member-engagement";
import { currentLead, holdsLeadSeat } from "./leads";
import type { Keeper } from "./service";

import type { RebindStep } from "./succession-store";

export function rebindLeadSeat(k: Keeper): RebindStep {
  return ({ chargeId, expectedGeneration, predecessor, successor, at }) => {
    const { store } = k;
    if (!store.db.inTransaction) throw new Error("A lead seat can move only inside the Keeper cutover.");
    const old = k.member(predecessor);
    if (!old) throw new Error("The preceding Keeper is missing.");
    const seat = currentLead(store, old);
    const outgoing = store.query("leadLinks", "parentKeeperThreadId", predecessor, 500).filter(holdsLeadSeat);
    if (outgoing.some(link => !link.childKeeperThreadId)) throw new Error("Resolve the reserved lead hire before refreshing this Keeper.");
    if (old.leadLinkId && (!seat || seat.state !== "linked" || old.engagement !== "active" || k.member(successor)))
      throw new Error("Only the active lead seat can move during cutover.");
    if (seat) {
      const actor = { kind: "tavern" } as const;
      const receipt = { kind: "lead-succession", id: seat.id, evidence: { chargeId, expectedGeneration, predecessor, successor } };
      transitionMember(store, { ...old, threadId: successor, state: "idle", createdAt: at, lastActiveAt: at }, "active", "lead-seat-bound", actor, receipt, at);
      transitionMember(store, old, "released", "lead-seat-moved", actor, receipt, at);
      const result = seat.result?.makerThreadId === predecessor ? { ...seat.result, makerThreadId: successor } : seat.result;
      store.put("leadLinks", seat.id, { ...seat, childKeeperThreadId: successor, generation: seat.generation + 1, ...(result ? { result } : {}) });
    }
    for (const link of outgoing) {
      store.put("leadLinks", link.id, { ...link, parentKeeperThreadId: successor, generation: link.generation + 1 });
      store.event(at, successor, link.parentQuestId, "lead.hiring-keeper-rebound", "The lead’s hiring Keeper has a successor.",
        { leadLinkId: link.id, chargeId, expectedGeneration, predecessor, successor });
    }
  };
}
