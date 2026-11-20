import type { Keeper } from "./keeper/service";
import { authorize } from "./authority";

export class LimitPolicy {
  constructor(readonly k: Keeper) {}
  allowReview(questId: string, surface: string) {
    authorize("allowReview", { level: "user-explicit", receipt: surface });
    return this.k.store.atomic(() => {
      const q = this.k.quest(questId);
      this.k.liveQuest(q.keeperThreadId, questId);
      const grant = { id: this.k.store.id("review"), surface, at: this.k.now(), usedBy: null };
      this.k.store.put("quests", q.id, { ...q, reviewAllowance: [...q.reviewAllowance ?? [], grant] });
      this.k.store.event(this.k.now(), q.keeperThreadId, q.id, "review.allowed", "You allowed one more review.", grant, { kind: "user" });
      this.k.changed(q.keeperThreadId, q.id);
      return { ok: true as const };
    });
  }
  reviewAvailable(questId: string | null) {
    return !!questId && !!this.k.quest(questId).reviewAllowance?.some(g => g.usedBy === null);
  }
  claimReview(questId: string, token: string) {
    const q = this.k.quest(questId), grant = q.reviewAllowance?.find(g => g.usedBy === null);
    if (!grant) throw new Error("The review budget is full; only you may allow one more review on the quest page.");
    this.k.store.put("quests", q.id, { ...q, reviewAllowance: q.reviewAllowance!.map(g => g.id === grant.id ? { ...g, usedBy: token } : g) });
  }
  softDecision(threadId: string, questId: string | null, limit: "party" | "rangers") {
    const decision = this.k.store.query("decisions", "keeperThreadId", threadId, 500).find(d => d.boardQuestId === questId && d.exceeds === limit && d.reversible && !d.undone && !d.usedBy);
    return decision?.id ?? null;
  }
  claimSoft(id: string, token: string) {
    const d = this.k.store.get("decisions", id);
    if (!d || !d.reversible || d.undone || d.usedBy || !d.exceeds) throw new Error("This soft limit decision is no longer available.");
    authorize(d.exceeds === "party" ? "exceedParty" : "exceedRangers", { level: "keeper", receipt: d.id });
    this.k.store.put("decisions", id, { ...d, usedBy: token });
  }
  release(token: string, questId: string | null, decisions: string[]) {
    if (questId) {
      const q = this.k.quest(questId);
      if (q.reviewAllowance?.some(g => g.usedBy === token)) this.k.store.put("quests", q.id, { ...q, reviewAllowance: q.reviewAllowance.map(g => g.usedBy === token ? { ...g, usedBy: null } : g) });
    }
    for (const id of decisions) {
      const d = this.k.store.get("decisions", id);
      if (d?.usedBy === token) this.k.store.put("decisions", id, { ...d, usedBy: null });
    }
  }
}
