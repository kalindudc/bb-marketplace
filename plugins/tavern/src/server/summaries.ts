import { summaryEntrySchema, summaryViewSchema, summarySchema, type SummaryDraft, type SummaryView } from "../shared/schema";
import type { KeeperStore } from "./keeper/store";
import { SUMMARY_POSTED } from "./news";

export const CORRECTION_ID_SQL = `(SELECT correction.id FROM tavern_records correction INDEXED BY tavern_summary_correction
  WHERE correction.kind='summaries' AND json_extract(correction.data,'$.boardQuestId')=json_extract(r.data,'$.boardQuestId')
  AND json_extract(correction.data,'$.supersedes')=r.id ORDER BY correction.rowid DESC LIMIT 1)`;
export const UNSEEN_SUMMARY_SQL = `NOT EXISTS (SELECT 1 FROM tavern_records seen WHERE seen.kind='attentionSeen' AND seen.id=r.id) AND ${CORRECTION_ID_SQL} IS NULL`;

export function appendSummary(store: KeeperStore, keeperThreadId: string, draft: SummaryDraft, createdAt: number) {
  return store.atomic(() => {
    const { boardQuestId, request, supersedes } = draft;
    if (request) {
      const linked = request.kind === "ask" ? store.get("asks", request.id) : store.get("notes", request.id);
      if (linked?.boardQuestId !== boardQuestId || linked.keeperThreadId !== keeperThreadId ||
        (request.kind === "hand-back" && linked.kind !== "waiting-on-user")) {
        throw new Error(`Link a ${request.kind} on this quest.`);
      }
    }
    if (supersedes) {
      const prior = summaryView(store, supersedes);
      if (!prior || prior.boardQuestId !== boardQuestId) throw new Error("Correct an earlier summary on this quest.");
      if (prior.correctedBy !== null) throw new Error("That summary was already corrected. Supersede the latest correction instead.");
    }
    const summary = summarySchema.parse({ ...draft, id: store.id("summary"), keeperThreadId, createdAt });
    store.put("summaries", summary.id, summary);
    store.event(createdAt, keeperThreadId, boardQuestId, SUMMARY_POSTED, summary.title,
      { summaryId: summary.id, ...(supersedes ? { supersedes } : {}) }, { kind: "agent", threadId: keeperThreadId });
    return summary;
  });
}

const SUMMARY_QUEST = "r.kind='summaries' AND json_extract(r.data,'$.boardQuestId')=?";
const PREVIOUS_TITLE = `(SELECT json_extract(previous.data,'$.title') FROM tavern_records previous
  WHERE previous.kind='summaries' AND previous.id=json_extract(r.data,'$.supersedes'))`;
const META = `seen.id AS seenId, ${CORRECTION_ID_SQL} AS correctedBy, ${PREVIOUS_TITLE} AS previousTitle`;
const WITH_SEEN = "FROM tavern_records r LEFT JOIN tavern_records seen ON seen.kind='attentionSeen' AND seen.id=r.id";
const HEADER = `json_object('id',r.id,'title',json_extract(r.data,'$.title'),'keeperThreadId',json_extract(r.data,'$.keeperThreadId'),
  'boardQuestId',json_extract(r.data,'$.boardQuestId'),'createdAt',json_extract(r.data,'$.createdAt'),'supersedes',json_extract(r.data,'$.supersedes'))`;

type Row = { data: string; seenId: string | null; correctedBy: string | null; previousTitle: string | null; ordinal: number };
function payload(row: Row) {
  const data = JSON.parse(row.data);
  if (data.supersedes === null) delete data.supersedes;
  return { ...data, seen: row.seenId !== null, correctedBy: row.correctedBy, ...(row.previousTitle !== null ? { previousTitle: row.previousTitle } : {}) };
}
export function summaryView(store: KeeperStore, id: string): SummaryView | null {
  const row = store.db.prepare(`SELECT r.data, ${META} ${WITH_SEEN} WHERE r.kind='summaries' AND r.id=?`).get(id) as Row | undefined;
  return row ? summaryViewSchema.parse(payload(row)) : null;
}

const HISTORY_PAGE = 12;
export function summariesForQuest(store: KeeperStore, id: string, beforeId?: string) {
  const before = beforeId === undefined ? undefined : store.db.prepare(`SELECT r.rowid AS ordinal FROM tavern_records r WHERE ${SUMMARY_QUEST} AND r.id=?`).get(id, beforeId) as { ordinal: number } | undefined;
  if (beforeId !== undefined && !before) return { summaries: [], summariesNextCursor: null };
  const page = store.db.prepare(`SELECT r.id,r.rowid AS ordinal FROM tavern_records r WHERE ${SUMMARY_QUEST} AND ${CORRECTION_ID_SQL} IS NULL
    ${before ? "AND r.rowid<?" : ""} ORDER BY r.rowid DESC LIMIT ?`).all(...(before ? [id, before.ordinal] : [id]), HISTORY_PAGE + 1) as { id: string; ordinal: number }[];
  const window = page.slice(0, HISTORY_PAGE), anchor = window.at(-1);
  if (!anchor) return { summaries: [], summariesNextCursor: null };
  const selectData = before ? HEADER : `CASE WHEN r.rowid>=? OR seen.id IS NULL THEN r.data ELSE ${HEADER} END`;
  const rows = store.db.prepare(`SELECT ${selectData} AS data,${META},r.rowid AS ordinal ${WITH_SEEN}
    WHERE ${SUMMARY_QUEST} AND ${CORRECTION_ID_SQL} IS NULL AND ${before ? "r.rowid>=? AND r.rowid<?" : "(r.rowid>=? OR seen.id IS NULL)"}
    ORDER BY r.rowid DESC`).all(...(before ? [id, anchor.ordinal, before.ordinal] : [window[Math.min(2, window.length - 1)]!.ordinal, id, anchor.ordinal])) as Row[];
  return {
    summaries: rows.map(row => ({ ...summaryEntrySchema.parse(payload(row)), order: row.ordinal })),
    summariesNextCursor: page.length > HISTORY_PAGE ? anchor.id : null,
  };
}
export function summaryCounts(store: KeeperStore, id: string) {
  return store.db.prepare(`SELECT count(*) FILTER (WHERE ${CORRECTION_ID_SQL} IS NULL) AS current,
    count(*) FILTER (WHERE ${CORRECTION_ID_SQL} IS NOT NULL) AS corrected FROM tavern_records r WHERE ${SUMMARY_QUEST}`).get(id) as { current: number; corrected: number };
}

export function summariesToday(store: KeeperStore, threadId: string, now: number) {
  const day = new Date(now), start = day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + 1);
  const rows = store.db.prepare(`SELECT board_quest_id AS id,count(*) AS count FROM tavern_events
    WHERE keeper_thread_id=? AND type=? AND at>=? AND at<? GROUP BY board_quest_id HAVING count(*)>=4`)
    .all(threadId, SUMMARY_POSTED, start, day.getTime()) as { id: string; count: number }[];
  return new Map(rows.map(row => [row.id, row.count]));
}

export function markVisitSummariesSeen(store: KeeperStore, ids: string[], seenAt: number) {
  return ids.flatMap(id => {
    const summary = store.get("summaries", id);
    if (!summary || store.get("attentionSeen", id)) return [];
    store.put("attentionSeen", id, { token: store.id("seen"), seenAt });
    return [summary];
  });
}

export function markSummariesSeen(store: KeeperStore, boardQuestId: string, ids: string[], seenAt: number) {
  return store.atomic(() => {
    return store.writeRecords(`INSERT OR IGNORE INTO tavern_records(kind,id,data)
      SELECT 'attentionSeen',id,? FROM tavern_records
      WHERE kind='summaries' AND json_extract(data,'$.boardQuestId')=? AND id IN (SELECT value FROM json_each(?))`,
      JSON.stringify({ token: store.id("seen"), seenAt }), boardQuestId, JSON.stringify(ids)).changes > 0;
  });
}
