import type { Keeper } from "./keeper/service";
import type { Member, JournalEntry } from "../shared/schema";
import { isOpenQuest } from "./liveness";
import { PlacementStore } from "./placement/store";

export interface RestingEngagement {
  state: "resting";
  since: number;
  lastWork: string;
  rejectedWaypoints: string[];
  underReview: boolean;
}
export function reuseRule(classId: string, engagement: RestingEngagement, quest: string): string | null {
  if (classId === "ranger") return `a follow-up on ${quest}`;
  if (classId === "smith") return engagement.underReview ? null : `a bounded follow-up on the work it just made on ${quest}`;
  if (classId === "wanderer") return "the same bounded work, not a new domain";
  if (classId === "warden" && engagement.rejectedWaypoints.length)
    return `re-checking ${engagement.rejectedWaypoints.join(", ")} after the maker's fix`;
  return null;
}
export function restingContext(k: Keeper) {
  const members = k.store.all("members");
  const reviewing = new Set(members.filter(m => m.classId === "warden" && !["done", "stopped", "failed"].includes(m.state) && !k.store.runtime(m.threadId).released).map(m => m.checkerMakerThreadId));
  const entries = new Map<string, JournalEntry[]>();
  return { reviewing, placements: new PlacementStore(k.store.db), entries: (questId: string) => {
    if (!entries.has(questId)) entries.set(questId, k.journal.linkedEntries(questId));
    return entries.get(questId)!;
  } };
}
export function restingEngagement(k: Keeper, member: Member, context = restingContext(k)): RestingEngagement | null {
  const rt = k.store.runtime(member.threadId);
  if (member.role !== "member" || member.state !== "done" || rt.released || rt.releasePending || rt.archivedAt != null || rt.deletedAt != null || rt.pendingBrief) return null;
  if (member.boardQuestId && !isOpenQuest(k.store.get("quests", member.boardQuestId))) return null;
  const report = k.store.query("reports", "memberThreadId", member.threadId, 1)[0];
  const entries = member.boardQuestId ? context.entries(member.boardQuestId) : [];
  return {
    state: "resting", since: rt.restSince ?? k.now(),
    lastWork: (report?.headline ?? report?.outcome ?? member.doing ?? member.title ?? "No report").slice(0, 300),
    rejectedWaypoints: [...new Set(entries.filter(e => e.status === "rejected" && e.review?.actor.kind === "agent" && e.review.actor.threadId === member.threadId).map(e => e.link!.waypointId))],
    underReview: context.reviewing.has(member.threadId),
  };
}
export function restingMember(k: Keeper, member: Member, context = restingContext(k)) {
  const engagement = restingEngagement(k, member, context);
  if (!engagement) return null;
  const entries = member.boardQuestId ? context.entries(member.boardQuestId) : [];
  const own = entries.filter(e => member.classId === "warden" ? e.review?.actor.kind === "agent" && e.review.actor.threadId === member.threadId : e.threadId === member.threadId);
  const settled = !engagement.underReview && own.every(e => e.status === "verified") && (member.classId === "warden" ? own.length > 0 && k.checkerWaypoints(member.threadId).every(id => own.some(e => e.link?.waypointId === id)) : !member.waypointId || own.length > 0);
  const state = k.store.runtime(member.threadId);
  const kept = state.kept && state.kept.until > k.now() && member.boardQuestId && !k.store.get("decisions", state.kept.decisionId)?.undone ? state.kept : null;
  const quest = member.boardQuestId ? k.quest(member.boardQuestId).short : "its errand";
  const placement = context.placements.byMember(member.threadId);
  return { threadId: member.threadId, name: k.name(member), classId: member.classId, boardQuestId: member.boardQuestId, quest, ...engagement,
    settled, kept, restedMinutes: Math.max(0, Math.floor((k.now() - engagement.since) / 60_000)),
    machineHeld: !!placement && placement.phase !== "released", mayRebriefFor: reuseRule(member.classId, engagement, quest) };
}
export function restingParty(k: Keeper, keeperId: string) {
  const context = restingContext(k);
  return k.store.query("members", "keeperThreadId", keeperId, 500).flatMap(member => {
    const row = restingMember(k, member, context);
    return row ? [row] : [];
  });
}
export function freeHands(k: Keeper, keeperId: string) {
  return restingParty(k, keeperId).filter(member => member.mayRebriefFor !== null);
}
export function restingCandidates(k: Keeper, keeperId: string, request: { classId: string; boardQuestId?: string | null; waypointId?: string | null }) {
  return freeHands(k, keeperId).filter(m => m.classId === request.classId && m.boardQuestId === (request.boardQuestId ?? null) && (m.classId !== "warden" || !!request.waypointId && m.rejectedWaypoints.includes(request.waypointId)));
}
