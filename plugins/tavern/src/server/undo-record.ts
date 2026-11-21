import type { Ask } from "../shared/schema";
import { undoKindSchema, keeperUndoLaneWords, type UndoKind, type UndoLane } from "../shared/undo-lane";
import type { KeeperStore } from "./keeper/store";

export function readUndoLanes(store: KeeperStore, threadId: string): UndoLane[] {
  return store.db.prepare(`WITH calls AS (
    SELECT d.id, d.rowid AS ordering, json_extract(a.data,'$.kind') AS kind, json_extract(d.data,'$.undone') AS was_undone
    FROM tavern_records d INDEXED BY tavern_undo_ask_decisions
    JOIN tavern_records a ON a.kind='asks' AND a.id=json_extract(d.data,'$.askId')
    WHERE d.kind='decisions' AND json_extract(d.data,'$.keeperThreadId')=?
      AND json_extract(d.data,'$.source')='keeper' AND json_extract(d.data,'$.reversible')=1 AND json_extract(d.data,'$.askId') IS NOT NULL
    UNION ALL
    SELECT id, rowid, coalesce(json_extract(data,'$.waypointCall.as'),json_extract(data,'$.exceeds')), json_extract(data,'$.undone')
    FROM tavern_records INDEXED BY tavern_undo_keeper_calls
    WHERE kind='decisions' AND json_extract(data,'$.keeperThreadId')=?
      AND json_extract(data,'$.source')='keeper' AND json_extract(data,'$.reversible')=1 AND json_extract(data,'$.askId') IS NULL
      AND (json_extract(data,'$.waypointCall.as') IS NOT NULL OR json_extract(data,'$.exceeds') IS NOT NULL)
  ), recent AS (
    SELECT *, row_number() OVER (PARTITION BY kind ORDER BY ordering DESC) AS position
    FROM calls WHERE kind IN (${undoKindSchema.options.map(() => "?").join(",")})
  ), resets AS (
    SELECT json_extract(data,'$.kind') AS kind, max(id) AS id FROM tavern_events
    WHERE keeper_thread_id=? AND type='lane.reset' AND json_extract(actor,'$.kind')='user' GROUP BY kind
  )
  SELECT c.kind, count(*) AS recent, sum(c.was_undone=1 AND (r.id IS NULL OR EXISTS (
    SELECT 1 FROM tavern_events u WHERE u.keeper_thread_id=? AND u.type='decision.undone' AND u.id>r.id
      AND json_extract(u.actor,'$.kind')='user' AND json_extract(u.data,'$.decisionId')=c.id
  ))) AS undone
  FROM recent c LEFT JOIN resets r ON r.kind=c.kind WHERE c.position<=10 GROUP BY c.kind HAVING undone>=2 ORDER BY c.kind`)
    .all(threadId, threadId, ...undoKindSchema.options, threadId, threadId) as UndoLane[];
}

export function assertUndoLane(store: KeeperStore, threadId: string, kind: Ask["kind"] | UndoKind) {
  if (!undoKindSchema.safeParse(kind).success) return;
  const shift = readUndoLanes(store, threadId).find(row => row.kind === kind);
  if (shift) throw new Error(keeperUndoLaneWords(shift));
}

export function undoAskProjection(store: KeeperStore) {
  const shifts = new Map<string, UndoLane[]>();
  return (ask: Ask): Ask => {
    if (ask.kind === "sends-as-you" && ask.state === "open") return { ...ask, lane: "user", options: ask.options.filter(option => option.id !== "delegate") };
    if (ask.state !== "open" || ask.lane !== "keeper" && !ask.options.some(o => o.id === "delegate")) return ask;
    let rows = shifts.get(ask.keeperThreadId);
    if (!rows) { rows = readUndoLanes(store, ask.keeperThreadId); shifts.set(ask.keeperThreadId, rows); }
    return rows.some(row => row.kind === ask.kind) ? { ...ask, lane: "user", options: ask.options.filter(o => o.id !== "delegate") } : ask;
  };
}
