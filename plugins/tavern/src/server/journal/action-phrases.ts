// Appended after the frozen journal migrations; also run after restoring an older backup.
export const JOURNAL_ACTION_PHRASES = `
  WITH legacy AS (
    SELECT id, CASE
      WHEN action = 'board-phase' AND json_extract(actor, '$.kind') = 'tavern'
        AND text GLOB 'Board quest phases refreshed:*' THEN 'Board quest phases refreshed:'
      WHEN action = 'link' AND json_extract(actor, '$.kind') IN ('agent', 'user', 'tavern')
        AND text GLOB 'Tavern assigned *' THEN 'Tavern '
      WHEN json_extract(actor, '$.kind') = 'user' THEN 'You '
      WHEN json_extract(actor, '$.kind') = 'agent' AND json_extract(actor, '$.threadId') GLOB 'thr_?*'
        THEN 'Agent ' || json_extract(actor, '$.threadId') || ' '
    END AS prefix
    FROM questlog_changes WHERE json_valid(actor)
  )
  UPDATE questlog_changes AS change SET text =
    (CASE legacy.prefix WHEN 'Board quest phases refreshed:' THEN 'refreshed board quest phases:' ELSE '' END) ||
    substr(change.text, length(legacy.prefix) + 1)
  FROM legacy WHERE change.id = legacy.id AND substr(change.text, 1, length(legacy.prefix)) = legacy.prefix;
`;
