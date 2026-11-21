import type { WardenQuality } from "../../shared/insights";
import type { Database } from "../ports";

const VERDICTS = `
  WITH verdicts AS MATERIALIZED (
    SELECT receipt.id, receipt.data ->> '$.verdict' AS verdict, receipt.data ->> '$.at' AS at,
      receipt.data ->> '$.maker.threadId' AS maker, receipt.data ->> '$.checker.threadId' AS checker,
      receipt.data ->> '$.entryId' AS entry_id, receipt.data ->> '$.questId' AS quest_id,
      receipt.data ->> '$.waypointId' AS waypoint_id, receipt.data ->> '$.reason' AS reason,
      receipt.data -> '$.checkerEvidence' AS evidence,
      runtime.data -> '$.classExecutionChoice' AS execution
    FROM tavern_records AS receipt
    LEFT JOIN tavern_runtime AS runtime ON runtime.thread_id = receipt.data ->> '$.checker.threadId'
    WHERE receipt.kind = 'serviceVerdicts' AND (receipt.data ->> '$.at') BETWEEN @from AND @to
      AND (receipt.data ->> '$.withdrawn') IS NOT 1
  ), reopen_pairs AS MATERIALIZED (
    SELECT history.thread_id AS maker, before.value AS original, after.value ->> '$.updatedAt' AS at
    FROM (SELECT DISTINCT maker FROM verdicts WHERE verdict = 'verified' AND maker IS NOT NULL) AS makers
    JOIN questlog_history AS history ON history.thread_id = makers.maker
      AND history.action IN ('reopen', 'toggle') AND history.state = 'undo'
    JOIN json_each(history.before_data) AS before ON (before.value ->> '$.status') = 'verified'
    JOIN json_each(history.after_data) AS after ON (after.value ->> '$.id') = (before.value ->> '$.id')
      AND (after.value ->> '$.status') = 'todo' AND (after.value ->> '$.updatedAt') BETWEEN @from AND @to
  ), reopened AS (
    SELECT DISTINCT v.id
    FROM verdicts AS v
    JOIN reopen_pairs AS r ON r.maker = v.maker AND r.at >= v.at
      AND (r.original ->> '$.id') = v.entry_id AND (r.original ->> '$.link.boardQuestId') = v.quest_id
      AND (r.original ->> '$.link.waypointId') = v.waypoint_id AND (r.original ->> '$.review.at') = v.at
      AND (r.original ->> '$.review.actor.kind') = 'agent' AND (r.original ->> '$.review.actor.threadId') = v.checker
      AND (r.original ->> '$.review.reason') IS v.reason AND (r.original -> '$.review.evidence') = v.evidence
    WHERE v.verdict = 'verified'
  ), models AS (
    SELECT v.verdict, reopened.id IS NOT NULL AS reopened,
      CASE WHEN json_type(v.execution, '$.recordedAt') = 'integer' AND (v.execution ->> '$.recordedAt') <= v.at
        AND length(v.execution ->> '$.providerId') > 0 AND length(v.execution ->> '$.model') > 0
        THEN v.execution END AS recorded
    FROM verdicts AS v LEFT JOIN reopened ON reopened.id = v.id
  )
  SELECT 'warden' AS classId, recorded ->> '$.providerId' AS providerId, recorded ->> '$.model' AS model,
    sum(verdict = 'verified') AS verified, sum(reopened) AS reopened, sum(verdict = 'rejected') AS rejected
  FROM models GROUP BY providerId, model ORDER BY model IS NULL, model, providerId`;

export function readWardenQuality(db: Database, from: number, to: number): WardenQuality {
  const rows = db.prepare(VERDICTS).all({ from, to }) as WardenQuality["rows"];
  const { count } = db.prepare(`SELECT count(*) AS count
    FROM tavern_events AS event JOIN json_each(event.data, '$.waivers') AS waiver
    WHERE event.at BETWEEN ? AND ? AND event.type = 'quest.wrapped' AND (event.actor ->> '$.kind') = 'user'
      AND (event.data ->> '$.cause') = 'close-early' AND (waiver.value ->> '$.state') = 'rejected'`)
    .get(from, to) as { count: number };
  return { from, to, rows, rejectedWaypointsWaived: count };
}
