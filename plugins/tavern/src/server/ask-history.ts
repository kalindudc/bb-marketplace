import type { KeeperStore } from "./keeper/store";
import type { Ask } from "../shared/schema";
export function askHistory(store: KeeperStore, threadId: string, cursor: string | null = null) {
  const before = cursor === null ? null : Number(cursor);
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new Error("Invalid ask history cursor");
  const rows = store.db.prepare(`SELECT r.data,r.rowid AS ordinal FROM tavern_records r WHERE r.kind='asks' AND json_extract(r.data,'$.keeperThreadId')=? AND json_extract(r.data,'$.state')<>'open'
    AND NOT EXISTS (SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(r.data,'$.boardQuestId') AND (q.archived_at IS NOT NULL OR json_extract(q.data,'$.deletedAt') IS NOT NULL))
    ${before === null ? "" : "AND r.rowid<?"} ORDER BY r.rowid DESC LIMIT 51`).all(threadId, ...(before === null ? [] : [before])) as { data: string; ordinal: number }[];
  return { asks: rows.slice(0, 50).map(row => JSON.parse(row.data) as Ask), nextCursor: rows.length > 50 ? String(rows[49]!.ordinal) : null };
}
