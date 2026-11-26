// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";
import { rpcHandlers } from "../../src/server/rpc";
import { setup } from "../server/runtime-fixture";
import { planInput, seedLegacyQuest, seedQuest } from "../server/support";

const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture(empty = false) {
  const f = setup();
  const db = f.k.store.db;
  dbs.push(db);
  if (empty) db.exec("DELETE FROM tavern_records; DELETE FROM tavern_runtime; DELETE FROM tavern_events;");
  return { ...f, backup: new BackupRecords(db, new SettingsStore(db, f.time), f.time), rpc: rpcHandlers(f.runtime) };
}

it("seeds old phase receipts on restore when the snapshot has no quest-change markers", async () => {
  const source = fixture(), destination = fixture(true);
  const quest = await seedQuest(source.k, "lead", "A watch", "Watch");
  source.k.plan("lead", planInput(quest.id));
  const changeId = (await source.rpc.boardQuest({ id: quest.id })).visitChangeId!;
  const snapshot = source.backup.capture();

  destination.backup.restore(snapshot);
  expect(destination.k.store.get("attentionSeen", changeId)).toMatchObject({ seenAt: expect.any(Number) });
  expect((await destination.rpc.room({})).sinceVisit?.changedQuests).toBe(0);
  destination.k.store.event(destination.time(), "lead", quest.id, "quest.phase", "A later phase change", { phase: { from: "greenlight", to: "build" }, cause: "auto-approve", receipt: { kind: "decision", id: "later" } }, { kind: "agent", threadId: "lead" });
  expect((await destination.rpc.room({})).sinceVisit?.changedQuests).toBe(1);
});

it("rejects a summary whose payload and row IDs disagree, and restores summaries, exact markers and event IDs", async () => {
  const source = fixture(), destination = fixture(true);
  const quest = await seedQuest(source.k, "lead", "A watch", "Watch");
  source.k.plan("lead", planInput(quest.id));
  const text = "How much of the watch did we check?";
  source.k.receiveUser("lead", text);
  const route = source.k.route("lead", { kind: "question", boardQuestId: quest.id, summary: "Asked about coverage" });
  const record = source.k.postSummary("lead", { boardQuestId: quest.id, title: "Coverage", body: "The evidence is attached.", links: [], answers: [route.id] });
  const changeId = (await source.rpc.boardQuest({ id: quest.id })).visitChangeId!;
  await source.rpc.markVisitSeen({ summaryIds: [record.id], changeIds: [changeId] });
  const other = seedLegacyQuest(source.k, "lead", "Another watch", "Other");
  source.k.plan("lead", planInput(other.id));
  const unreadId = (await source.rpc.boardQuest({ id: other.id })).visitChangeId!;
  const snapshot = source.backup.capture();
  const bad = structuredClone(snapshot);
  bad.tables.tavern_records!.rows.find(row => row.id === record.id)!.id = "wrong-summary-key";
  expect(() => destination.backup.restore(bad)).toThrow(/summary.*identity/i);
  expect(destination.k.store.all("summaries")).toEqual([]);

  destination.backup.restore(snapshot);
  expect(destination.k.store.get("summaries", record.id)).toEqual(record);
  expect(await destination.rpc.searchAnswers({ query: text })).toMatchObject({ answers: [{ id: record.id, answerMessages: [{ id: route.id, text }] }] });
  for (const id of [record.id, changeId]) expect(destination.k.store.get("attentionSeen", id)).toEqual(source.k.store.get("attentionSeen", id));
  expect(destination.k.store.latestQuestEvent(quest.id, "summary.posted")).toEqual(source.k.store.latestQuestEvent(quest.id, "summary.posted"));
  expect(destination.k.store.get("attentionSeen", unreadId)).toBeNull();
  expect(await destination.rpc.room({})).toMatchObject({ sinceVisit: { summaries: 0, changedQuests: 1, quests: [{ change: { id: unreadId } }] } });
});
