import Database from "better-sqlite3";
import { MIGRATIONS } from "../../src/server/migrations";
import { KeeperStore } from "../../src/server/keeper/store";
import { attention } from "../../src/server/attention";

export function withAttention<T>(input: T): T {
  const data = structuredClone(input) as any;
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const store = new KeeperStore(db);
  const quests = data.keepers ? data.keepers.flatMap((k: any) => k.boardQuests) : data.boardQuests ?? data.keeperView?.boardQuests ?? [];
  for (const q of quests) db.prepare("INSERT OR REPLACE INTO tavern_records(kind,id,data,archived_at) VALUES('quests',?,?,?)").run(q.id, JSON.stringify(q), q.archivedAt ?? null);
  for (const [kind, records] of [["asks", data.asks ?? data.keeperView?.openAsks ?? []], ["notes", data.notes ?? []], ["rules", data.rules ?? []], ["decisions", data.decidedForYou ?? data.keeperView?.decidedForYou ?? []]] as const)
    for (const record of records) store.put(kind, record.id, record);
  data.attention = attention(store);
  if (data.keepers) for (const keeper of data.keepers) keeper.attention = attention(store, { keeperThreadId: keeper.member.threadId });
  for (const q of quests) q.attention = attention(store, { boardQuestId: q.id });
  if (data.keeperView) data.keeperView.attention ??= data.attention;
  db.close();
  return data;
}
