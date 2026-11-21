import type { BoardQuest, Member } from "../shared/schema";
import type { KeeperStore } from "./keeper/store";
import { wasReleased, type Engagement } from "../shared/member-engagement";
import { currentLead } from "./keeper/leads";

type Store = Pick<KeeperStore, "get" | "runtime">;
export type MemberPurpose = "work" | "brief" | "occupy";

const purposes: Record<MemberPurpose, readonly Engagement[]> = {
  work: ["active"],
  brief: ["briefing", "active", "resting"],
  occupy: ["briefing", "active", "releasing", "stopping"],
};
export function isOpenQuest(quest: BoardQuest | null | undefined): quest is BoardQuest {
  return !!quest && quest.archivedAt == null && quest.endedAt == null &&
    !["done", "stopped", "stopping"].includes(quest.phase);
}
export function isLiveMember(store: Store, member: Member | null, purpose: MemberPurpose = "work"): member is Member {
  if (!member || member.role === "keeper") return false;
  return member.engagement !== undefined && purposes[purpose].includes(member.engagement) &&
    (member.boardQuestId === null || isOpenQuest(store.get("quests", member.boardQuestId)));
}
export function isKeeperIdentity(store: Pick<Store, "get">, member: Member | null): boolean {
  if (!member) return false;
  if (member.role === "keeper") return true;
  const link = currentLead(store, member);
  return link?.state === "linked" || link?.state === "retirement-requested";
}
export function isLiveKeeper(store: Store, member: Member | null, purpose: "present" | "automatic" = "automatic"): member is Member {
  if (!member || !isKeeperIdentity(store, member)) return false;
  if (member.leadLinkId && (member.engagement === "archived" || purpose === "automatic" &&
      !isLiveMember(store, member, "work") && currentLead(store, member)?.state !== "retirement-requested")) return false;
  const state = store.runtime(member.threadId);
  return state.archivedAt == null && state.deletedAt == null && (purpose === "present" || state.manualStopAt == null);
}

export function hasLiveName(store: Store, member: Member): boolean {
  if (member.role === "keeper") return isLiveKeeper(store, member, "present");
  if (member.engagement === "archiving") return !wasReleased(member) && (member.boardQuestId === null || isOpenQuest(store.get("quests", member.boardQuestId)));
  return isLiveMember(store, member, "brief") || isLiveMember(store, member, "occupy");
}
export function liveMemberSql(purpose: MemberPurpose = "work"): string {
  return `json_extract(m.data,'$.role') IN ('member','solo')
    AND coalesce(json_extract(m.data,'$.engagement') IN (${purposes[purpose].map(state => `'${state}'`).join(",")}),0)
    AND (json_extract(m.data,'$.boardQuestId') IS NULL OR EXISTS (
      SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(m.data,'$.boardQuestId')
      AND json_extract(q.data,'$.phase') NOT IN ('done','stopped','stopping')
      AND json_extract(q.data,'$.endedAt') IS NULL AND q.archived_at IS NULL))`;
}
