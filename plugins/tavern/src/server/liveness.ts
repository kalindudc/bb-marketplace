import type { BoardQuest, Member } from "../shared/schema";
import type { KeeperStore } from "./keeper/store";

type Store = Pick<KeeperStore, "get" | "runtime">;
export type MemberPurpose = "work" | "brief" | "occupy";

// Work drives active-work actions and their counts; brief permits rebriefing finished
// members; occupy retains pending brief and release reservations until confirmed.
export function isOpenQuest(quest: BoardQuest | null | undefined): quest is BoardQuest {
  return !!quest && quest.archivedAt == null && quest.endedAt == null &&
    !["done", "stopped", "stopping"].includes(quest.phase);
}
export function isLiveMember(store: Store, member: Member | null, purpose: MemberPurpose = "work"): member is Member {
  if (!member || member.role === "keeper") return false;
  const state = store.runtime(member.threadId);
  const releasing = purpose === "occupy" && !!state.releasePending;
  if (member.state === "stopped" && !releasing) return false;
  if (state.released || state.releasePending && !releasing || state.archivePending || state.archivedAt != null || state.deletedAt != null) return false;
  if (member.boardQuestId !== null && !isOpenQuest(store.get("quests", member.boardQuestId))) return false;
  if (purpose === "brief") return true;
  return releasing || !["done", "failed"].includes(member.state) || purpose === "occupy" && state.pendingBrief != null;
}
export function isLiveKeeper(store: Store, member: Member | null, purpose: "present" | "automatic" = "automatic"): member is Member {
  if (member?.role !== "keeper") return false;
  const state = store.runtime(member.threadId);
  return state.archivedAt == null && state.deletedAt == null && (purpose === "present" || state.manualStopAt == null);
}

// Aliases m (members) and t (their LEFT JOINed runtime) match the store selections.
export function liveMemberSql(purpose: MemberPurpose = "work"): string {
  const state = purpose === "brief" ? "1"
    : purpose === "occupy" ? "(json_extract(m.data,'$.state') NOT IN ('done','failed') OR json_extract(t.data,'$.pendingBrief') IS NOT NULL OR json_extract(t.data,'$.releasePending') IS NOT NULL)"
    : "json_extract(m.data,'$.state') NOT IN ('done','failed')";
  return `json_extract(m.data,'$.role') IN ('member','solo')
    AND (json_extract(m.data,'$.state')<>'stopped' ${purpose === "occupy" ? "OR json_extract(t.data,'$.releasePending') IS NOT NULL" : ""}) AND (${state})
    AND json_extract(t.data,'$.released') IS NULL
    ${purpose === "occupy" ? "" : "AND json_extract(t.data,'$.releasePending') IS NULL"}
    AND coalesce(json_extract(t.data,'$.archivePending'),0)=0
    AND json_extract(t.data,'$.archivedAt') IS NULL AND json_extract(t.data,'$.deletedAt') IS NULL
    AND (json_extract(m.data,'$.boardQuestId') IS NULL OR EXISTS (
      SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(m.data,'$.boardQuestId')
      AND json_extract(q.data,'$.phase') NOT IN ('done','stopped','stopping')
      AND json_extract(q.data,'$.endedAt') IS NULL AND q.archived_at IS NULL))`;
}
