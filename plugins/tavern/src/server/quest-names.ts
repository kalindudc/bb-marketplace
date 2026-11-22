import type { Ask, BoardQuest, LeadPlanReview } from "../shared/schema";
import type { KeeperStore } from "./keeper/store";

export function currentLeadPlanNames(store: KeeperStore, request: LeadPlanReview): LeadPlanReview {
  const title = (id: string, captured: string) => {
    const quest = store.get("quests", id);
    return quest?.deletedAt != null ? "a deleted quest" : quest?.title ?? captured;
  };
  return { ...request, parentTitle: title(request.parentQuestId, request.parentTitle), changes: request.changes.map(change => {
    const link = store.get("leadLinks", change.linkId);
    return link ? { ...change, questTitle: title(link.parentQuestId, change.questTitle) } : change;
  }) };
}

type ForwardedQuestion = NonNullable<Ask["forwardedQuestion"]>;
const forwardedMarker = " asks, for ";

export function forwardedAskQuestion({ byline, body }: ForwardedQuestion, short: string) {
  return `${byline}${short}: ${body}`.slice(0, 400);
}

function legacyForwarding(ask: Ask, parent: Pick<BoardQuest, "id" | "short">): ForwardedQuestion | undefined {
  const marker = ask.question.indexOf(forwardedMarker);
  if (marker < 1) return undefined;
  const start = marker + forwardedMarker.length;
  const boundary = `${parent.short}: `;
  for (let name = ask.question.indexOf(boundary, start); name !== -1; name = ask.question.indexOf(boundary, name + 1)) {
    if (name !== start && !ask.question.slice(start, name).endsWith("’s ")) continue;
    const body = ask.question.slice(name + boundary.length);
    if (body.length) return { parentQuestId: parent.id, byline: ask.question.slice(0, name), body };
  }
}

// Capture the old prefix before the parent name changes; the question body is never rewritten.
export function captureLegacyForwarding(store: KeeperStore, parent: Pick<BoardQuest, "id" | "short">) {
  for (const link of store.leadLinksBy("parentQuestId", parent.id)) {
    if (!link.childQuestId) continue;
    for (const ask of store.openAsks(undefined, link.childQuestId)) {
      if (ask.forwardedQuestion) continue;
      const forwardedQuestion = legacyForwarding(ask, parent);
      if (forwardedQuestion) store.put("asks", ask.id, { ...ask, forwardedQuestion });
    }
  }
}

function questQuestion(effect: Ask["effect"]) {
  switch (effect?.type) {
    case "lead-plan": return (title: string) => `Approve ${title.slice(0, 75)}, plan v${effect.request.version}?`;
    case "release-hold": return (title: string) => `Release the checker handoff for “${title}”?`;
    case "greenlight": return (title: string) => `${effect.requiresExplicit ? "Approve the updated checks for" : "Form the party for"} ${title}, plan v${effect.planVersion}?`;
    case "conclude": return (title: string) => `Can “${title}” conclude?`;
    case "close-early": return (title: string) => `Can “${title}” close early?`;
  }
}

export function currentAskNames(store: KeeperStore, ask: Ask): Ask {
  if (ask.state !== "open" || !ask.boardQuestId) return ask;
  let forwarded = ask.forwardedQuestion;
  if (!forwarded && ask.question.includes(forwardedMarker)) {
    const [link] = store.leadLinksBy("childQuestId", ask.boardQuestId);
    const parent = link && store.get("quests", link.parentQuestId);
    if (parent) forwarded = legacyForwarding(ask, parent);
  }
  const parent = forwarded && store.get("quests", forwarded.parentQuestId);
  let body = forwarded?.body ?? ask.question;
  const namedEffect = ask.effect ?? (ask.kind === "greenlight" || ask.kind === "conclude" || ask.releaseHoldId ? store.get("asks", ask.id)?.effect : undefined);
  const named = questQuestion(namedEffect);
  if (named) {
    const quest = store.get("quests", ask.boardQuestId);
    if (quest) body = named(quest.title);
  }
  const question = forwarded && parent ? forwardedAskQuestion({ ...forwarded, body }, parent.deletedAt != null ? "a deleted quest" : parent.short)
    : forwarded ? ask.question : body;
  const effect = ask.effect?.type === "lead-plan" ? { ...ask.effect, request: currentLeadPlanNames(store, ask.effect.request) } : ask.effect;
  return question === ask.question && effect === ask.effect ? ask : { ...ask, question, ...(effect ? { effect } : {}) };
}
