import { PHASES, type Phase } from "../shared/schema";
import type { AttentionItem } from "../shared/attention";
import type { KeeperStore } from "./keeper/store";

const phaseValues = PHASES.map(phase => `'${phase}'`).join(",");
const from = "json_extract(e.data,'$.phase.from')";
const to = "json_extract(e.data,'$.phase.to')";
const actualTransition = `json_type(e.data,'$.phase')='object' AND ${from} IN (${phaseValues}) AND ${to} IN (${phaseValues}) AND ${from} != ${to}`;
const visibleQuest = "q.kind='quests' AND q.archived_at IS NULL AND json_extract(q.data,'$.deletedAt') IS NULL";
const notByUserActor = "json_extract(e.actor,'$.kind') IS NOT 'user'";
const receipt = "json_extract(e.data,'$.receipt.kind')";
const cause = "json_extract(e.data,'$.cause')";
const completesUserStop = `${cause} IS 'stopped' AND ${receipt} IS 'members-stopped' AND (
  SELECT json_extract(request.data,'$.cause') IS 'stop' AND json_extract(request.data,'$.receipt.kind') IS 'user-act'
  FROM tavern_events request WHERE request.board_quest_id=e.board_quest_id AND request.id<e.id
  AND json_type(request.data,'$.phase')='object' ORDER BY request.id DESC LIMIT 1
) IS TRUE`;
const notByUser = `${notByUserActor} AND ${receipt} IS NOT 'user-act' AND ${receipt} IS NOT 'user-message'
  AND ${cause} IS NOT 'hold' AND ${cause} IS NOT 'resume' AND NOT (${completesUserStop})`;
const seenId = "'quest-change:' || e.id";
const latest = `tavern_records q JOIN tavern_events e ON e.id = (
  SELECT e.id FROM tavern_events e WHERE e.board_quest_id=q.id AND ${actualTransition} ORDER BY e.id DESC LIMIT 1
)`;

export const SEED_QUEST_CHANGE_SEEN = `INSERT OR IGNORE INTO tavern_records(kind,id,data)
  SELECT 'attentionSeen',${seenId},json_object('token',lower(hex(randomblob(16))),'seenAt',unixepoch()*1000)
  FROM ${latest} WHERE q.kind='quests' AND ${notByUserActor}`;

export function unseenQuestChanges(store: KeeperStore, questId?: string): Omit<AttentionItem, "seen">[] {
  const rows = store.db.prepare(`SELECT ${seenId} AS id, q.id AS questId, e.keeper_thread_id AS keeperThreadId,
    json_extract(q.data,'$.title') AS title, e.at AS since, ${from} AS oldPhase, ${to} AS newPhase
    FROM ${latest} WHERE ${visibleQuest} AND ${notByUser}${questId === undefined ? "" : " AND q.id=?"}
    AND NOT EXISTS (SELECT 1 FROM tavern_records seen WHERE seen.kind='attentionSeen' AND seen.id=(${seenId}))
    ORDER BY e.id`).all(...(questId === undefined ? [] : [questId])) as { id: string; questId: string; keeperThreadId: string; title: string; since: number; oldPhase: Phase; newPhase: Phase }[];
  return rows.map(({ oldPhase, newPhase, ...row }) => ({ ...row, kind: "quest-changed", action: "Open", phaseChange: { from: oldPhase, to: newPhase } }));
}

export function markQuestChangesSeen(store: KeeperStore, ids: string[], at: number) {
  if (!ids.length) return false;
  return store.writeRecords(`INSERT OR IGNORE INTO tavern_records(kind,id,data)
    SELECT 'attentionSeen',${seenId},? FROM tavern_events e JOIN tavern_records q ON q.id=e.board_quest_id
    WHERE e.id IN (SELECT value FROM json_each(?)) AND ${visibleQuest} AND ${notByUser} AND ${actualTransition}`,
    JSON.stringify({ token: store.id("seen"), seenAt: at }), JSON.stringify(ids.map(id => Number(id.slice("quest-change:".length))))).changes > 0;
}
