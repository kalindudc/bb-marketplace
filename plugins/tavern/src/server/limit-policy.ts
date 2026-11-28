import type { Keeper } from "./keeper/service";
import { authorize } from "./authority";
import { currentAskNames } from "./quest-names";

export class LimitPolicy {
  constructor(readonly k: Keeper) {}
  reviewAsk(threadId: string, questId: string, waiting: number, budget: number) {
    const question = `Your review queue is full (${waiting} of ${budget}). Allow one more review for this quest?`;
    return this.k.store.atomic(() => {
      const q = this.k.liveQuest(threadId, questId);
      const existing = this.k.store.openAsks(threadId, questId).find(ask => ask.effect?.type === "review-allowance");
      if (existing && q.reviewHoldAskId === existing.id && (existing.forwardedQuestion?.body ?? existing.question) === question) return existing;
      const ask = existing ? this.k.store.put("asks", existing.id, currentAskNames(this.k.store, {
        ...existing, question, ...(existing.forwardedQuestion ? { forwardedQuestion: { ...existing.forwardedQuestion, body: question } } : {}),
      })) : this.k.ask(threadId, {
        boardQuestId: questId, kind: "blocker", effect: { type: "review-allowance" }, question,
        why: "The review budget counts work waiting on you.",
        options: [
          { id: "allow", label: "Allow", detail: "Let the Keeper retry one Smith hire on this quest.", recommended: false },
          { id: "wait", label: "Wait", detail: "Keep Smith hiring on hold until the queue has room.", recommended: false },
        ],
        meanwhile: "Continue unblocked work. Do not retry the hire until you have an allowance or the queue has room.",
        holds: [],
      }, {}, true);
      if (q.reviewHoldAskId !== ask.id) this.k.store.put("quests", q.id, { ...q, reviewHoldAskId: ask.id });
      if (existing) this.k.changed(threadId, questId);
      return ask;
    });
  }
  clearReviewHold(questId: string, reason: string) {
    const q = this.k.quest(questId);
    if (!q.reviewHoldAskId) return null;
    const ask = this.k.store.get("asks", q.reviewHoldAskId);
    this.k.store.put("quests", q.id, { ...q, reviewHoldAskId: undefined });
    if (ask?.boardQuestId !== q.id || ask.effect?.type !== "review-allowance") return null;
    this.k.withdrawAsk(ask.id, "no-longer-needed", this.k.now(), { kind: "tavern" }, reason);
    return ask.id;
  }
  allowReview(questId: string, surface: string, askId?: string) {
    authorize("allowReview", { level: "user-explicit", receipt: surface });
    return this.k.store.atomic(() => {
      const q = this.k.quest(questId);
      this.k.liveQuest(q.keeperThreadId, questId);
      const grant = { id: this.k.store.id("review"), surface, at: this.k.now(), usedBy: null };
      this.k.store.put("quests", q.id, { ...q, reviewAllowance: [...q.reviewAllowance ?? [], grant] });
      this.k.store.event(this.k.now(), q.keeperThreadId, q.id, "review.allowed", "You allowed one more review.", { ...grant, ...(askId ? { askId } : {}) }, { kind: "user" });
      this.clearReviewHold(q.id, "You already allowed one more review.");
      if (!askId) this.k.changed(q.keeperThreadId, q.id);
      return { ok: true as const };
    });
  }
  reviewAvailable(questId: string | null) {
    return !!questId && !!this.k.quest(questId).reviewAllowance?.some(g => g.usedBy === null);
  }
  claimReview(questId: string, token: string) {
    const q = this.k.quest(questId), grant = q.reviewAllowance?.find(g => g.usedBy === null);
    if (!grant) throw new Error("There is no unused review allowance for this quest.");
    this.k.store.put("quests", q.id, { ...q, reviewAllowance: q.reviewAllowance!.map(g => g.id === grant.id ? { ...g, usedBy: token } : g) });
  }
  softDecision(threadId: string, questId: string | null, limit: "party" | "rangers") {
    const decision = this.k.store.query("decisions", "keeperThreadId", threadId, 500).find(d => d.boardQuestId === questId && d.exceeds === limit && d.reversible && !d.undone && !d.usedBy);
    return decision?.id ?? null;
  }
  claimSoft(id: string, token: string) {
    const d = this.k.store.get("decisions", id);
    if (!d || !d.reversible || d.undone || d.usedBy || !d.exceeds) throw new Error("This soft limit decision is no longer available.");
    if (d.answerReceipt) authorize("answerAsk", { level: "user-explicit", receipt: d.answerReceipt });
    else authorize(d.exceeds === "party" ? "exceedParty" : "exceedRangers", { level: "keeper", receipt: d.id });
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
