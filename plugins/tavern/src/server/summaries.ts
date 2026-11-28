import { answerMessageSchema, summaryEntrySchema, summaryViewSchema, summarySchema, type SummaryDraft, type SummaryView } from "../shared/schema";
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
    const answers = [...new Set(draft.answers)];
    for (const id of answers) {
      const route = store.get("routes", id);
      const receiptId = route?.sourceMessageId;
      const receipt = receiptId ? store.messageReceipt(keeperThreadId, receiptId) : undefined;
      const cancelled = receiptId && store.db.prepare(`SELECT 1 FROM tavern_events
        WHERE type='route.cancelled' AND keeper_thread_id=? AND json_extract(data,'$.receiptId')=?`).get(keeperThreadId, receiptId);
      if (!route || route.keeperThreadId !== keeperThreadId || route.classSelectionOnly || (receiptId && receipt?.accepted !== 2) || cancelled ||
        !(route.boardQuestId === boardQuestId || route.boardQuestIds?.includes(boardQuestId) || route.kind === "question" && route.boardQuestId === null)) {
        throw new Error("Link an accepted route from this Keeper for this quest.");
      }
      if (draft.childQuestId && route.kind !== "steer") throw new Error("Link an accepted parent steer for a side quest answer.");
      if (route.kind === "steer" && store.db.prepare(`SELECT 1 FROM tavern_records r, json_each(r.data,'$.answers') answer
        WHERE r.kind='summaries' AND json_extract(r.data,'$.boardQuestId')=? AND answer.value=?
        AND (? OR json_extract(r.data,'$.childQuestId') IS NOT NULL)
        AND r.id<>? AND ${CORRECTION_ID_SQL} IS NULL LIMIT 1`).get(boardQuestId, id, Number(!!draft.childQuestId), supersedes ?? ""))
        throw new Error("This steer already has an answer. Correct the existing answer instead.");
    }
    const summary = summarySchema.parse({ ...draft, answers, id: store.id("summary"), keeperThreadId, createdAt });
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
  'boardQuestId',json_extract(r.data,'$.boardQuestId'),'createdAt',json_extract(r.data,'$.createdAt'),'supersedes',json_extract(r.data,'$.supersedes'),
  'childQuestId',json_extract(r.data,'$.childQuestId'))`;

type Row = { data: string; seenId: string | null; correctedBy: string | null; previousTitle: string | null; ordinal: number };
function payload(row: Row) {
  const data = JSON.parse(row.data);
  if (data.supersedes === null) delete data.supersedes;
  if (data.childQuestId === null) delete data.childQuestId;
  return { ...data, seen: row.seenId !== null, correctedBy: row.correctedBy, ...(row.previousTitle !== null ? { previousTitle: row.previousTitle } : {}) };
}
export function summaryView(store: KeeperStore, id: string): SummaryView | null {
  const row = store.db.prepare(`SELECT r.data, ${META} ${WITH_SEEN} WHERE r.kind='summaries' AND r.id=?`).get(id) as Row | undefined;
  if (!row) return null;
  const summary = summaryViewSchema.parse(payload(row));
  return { ...summary, ...answerContext(store, summary), questTitle: store.get("quests", summary.boardQuestId)?.title };
}

const ROUTE_RECEIPT = `LEFT JOIN tavern_messages m ON m.id=json_extract(a.data,'$.sourceMessageId') AND m.thread_id=json_extract(a.data,'$.keeperThreadId')`;
const QUOTE = `coalesce(nullif(m.text,''), json_extract(a.data,'$.userText'), json_extract(a.data,'$.messageKey'))`;
const ROUTE_QUOTE = `a.id, ${QUOTE} AS text, json_extract(a.data,'$.kind') AS kind, json_extract(a.data,'$.messageAt') AS at`;
function answerContext(store: KeeperStore, summary: Pick<SummaryView, "answers" | "keeperThreadId">) {
  if (!summary.answers?.length) return {};
  const rows = store.db.prepare(`SELECT ${ROUTE_QUOTE} FROM json_each(?) link
    JOIN tavern_records a ON a.kind='routes' AND a.id=link.value ${ROUTE_RECEIPT}
    WHERE json_extract(a.data,'$.keeperThreadId')=? ORDER BY link.key`).all(JSON.stringify(summary.answers), summary.keeperThreadId);
  return { answerMessages: answerMessageSchema.array().parse(rows) };
}

export function searchAnswers(store: KeeperStore, query: string, pageSize: number, boardQuestId?: string, before?: number) {
  const rows = store.db.prepare(`SELECT r.data,${META},r.rowid AS ordinal,json_extract(q.data,'$.title') AS questTitle ${WITH_SEEN}
    JOIN tavern_records q ON q.kind='quests' AND q.id=json_extract(r.data,'$.boardQuestId')
    WHERE r.kind='summaries' AND json_extract(q.data,'$.deletedAt') IS NULL
    ${boardQuestId !== undefined ? "AND q.id=@boardQuestId" : ""} AND (@before IS NULL OR r.rowid<@before)
    AND (@query='' OR instr(lower(json_extract(r.data,'$.title')), lower(@query))>0 OR instr(lower(json_extract(r.data,'$.body')), lower(@query))>0
      OR instr(lower(json_extract(q.data,'$.title')), lower(@query))>0 OR instr(lower(json_extract(q.data,'$.short')), lower(@query))>0
      OR instr(CASE WHEN json_type(r.data,'$.request')='object' THEN 'needs you' WHEN json_type(r.data,'$.results')='object' THEN 'result' ELSE 'answer' END, lower(@query))>0
      OR EXISTS (SELECT 1 FROM json_each(r.data,'$.answers') link JOIN tavern_records a ON a.kind='routes' AND a.id=link.value ${ROUTE_RECEIPT}
        WHERE json_extract(a.data,'$.keeperThreadId')=json_extract(r.data,'$.keeperThreadId') AND instr(lower(${QUOTE}), lower(@query))>0))
    ORDER BY r.rowid DESC LIMIT @limit`).all({ query: query.trim(), boardQuestId, before: before ?? null, limit: pageSize + 1 }) as (Row & { questTitle: string })[];
  const page = rows.slice(0, pageSize);
  return {
    answers: page.map(row => {
      const summary = summaryViewSchema.parse(payload(row));
      return { ...summary, ...answerContext(store, summary), questTitle: row.questTitle };
    }),
    nextCursor: rows.length > pageSize ? page.at(-1)!.ordinal : null,
  };
}

export function startAnswerTracking(store: KeeperStore, at: number) {
  store.db.prepare("INSERT OR IGNORE INTO tavern_answer_tracking(id, started_at) VALUES(1, ?)").run(at);
  return (store.db.prepare("SELECT started_at FROM tavern_answer_tracking WHERE id=1").get() as { started_at: number }).started_at;
}

export function unansweredMessages(store: KeeperStore, quest: { id: string; keeperThreadId: string }, startedAt: number, pageSize: number, before?: number) {
  const rows = store.db.prepare(`WITH covered AS (
    SELECT link.value AS id FROM tavern_records r, json_each(r.data,'$.answers') link
    WHERE r.kind='summaries' AND json_extract(r.data,'$.boardQuestId')=@quest AND json_extract(r.data,'$.keeperThreadId')=@keeper AND ${CORRECTION_ID_SQL} IS NULL
  ) SELECT ${ROUTE_QUOTE}, a.rowid AS ordinal FROM tavern_records a ${ROUTE_RECEIPT}
    WHERE a.kind='routes' AND json_extract(a.data,'$.keeperThreadId')=@keeper
      AND json_extract(a.data,'$.kind') IN ('steer','question')
      AND json_extract(a.data,'$.createdAt')>=@startedAt
      AND coalesce(json_extract(a.data,'$.classSelectionOnly'),0)=0 AND (m.accepted IS NULL OR m.accepted=2)
      AND (@before IS NULL OR a.rowid<@before)
      AND (json_extract(a.data,'$.boardQuestId')=@quest OR @quest IN (SELECT value FROM json_each(a.data,'$.boardQuestIds')))
      AND NOT EXISTS (SELECT 1 FROM tavern_events e WHERE e.type='route.cancelled' AND e.keeper_thread_id=m.thread_id AND json_extract(e.data,'$.receiptId')=m.id)
      AND a.id NOT IN (SELECT id FROM covered WHERE id IS NOT NULL)
    ORDER BY a.rowid DESC LIMIT @limit`).all({ quest: quest.id, keeper: quest.keeperThreadId, startedAt, before: before ?? null, limit: pageSize + 1 }) as { ordinal: number }[];
  const page = rows.slice(0, pageSize);
  return { messages: answerMessageSchema.array().parse(page), nextCursor: rows.length > pageSize ? page.at(-1)!.ordinal : null };
}

export function summariesForQuest(store: KeeperStore, id: string, pageSize: number, beforeId?: string) {
  const before = beforeId === undefined ? undefined : store.db.prepare(`SELECT r.rowid AS ordinal FROM tavern_records r WHERE ${SUMMARY_QUEST} AND r.id=?`).get(id, beforeId) as { ordinal: number } | undefined;
  if (beforeId !== undefined && !before) return { summaries: [], summariesNextCursor: null };
  const page = store.db.prepare(`SELECT r.id,r.rowid AS ordinal FROM tavern_records r WHERE ${SUMMARY_QUEST} AND ${CORRECTION_ID_SQL} IS NULL
    ${before ? "AND r.rowid<?" : ""} ORDER BY r.rowid DESC LIMIT ?`).all(...(before ? [id, before.ordinal] : [id]), pageSize + 1) as { id: string; ordinal: number }[];
  const window = page.slice(0, pageSize), anchor = window.at(-1);
  if (!anchor) return { summaries: [], summariesNextCursor: null };
  const selectData = before ? HEADER : `CASE WHEN r.rowid>=? OR seen.id IS NULL THEN r.data ELSE ${HEADER} END`;
  const rows = store.db.prepare(`SELECT ${selectData} AS data,${META},r.rowid AS ordinal ${WITH_SEEN}
    WHERE ${SUMMARY_QUEST} AND ${CORRECTION_ID_SQL} IS NULL AND ${before ? "r.rowid>=? AND r.rowid<?" : "(r.rowid>=? OR seen.id IS NULL)"}
    ORDER BY r.rowid DESC`).all(...(before ? [id, anchor.ordinal, before.ordinal] : [window[Math.min(2, window.length - 1)]!.ordinal, id, anchor.ordinal])) as Row[];
  return {
    summaries: rows.map(row => {
      const entry = summaryEntrySchema.parse(payload(row));
      return { ...entry, ...(entry.body !== undefined ? answerContext(store, entry) : {}), order: row.ordinal };
    }),
    summariesNextCursor: page.length > pageSize ? anchor.id : null,
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
