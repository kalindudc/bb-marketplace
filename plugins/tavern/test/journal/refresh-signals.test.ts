// @vitest-environment node
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import tavern from "../../server";
import { rpcContract, tags } from "../../src/shared/contract";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { fakePort, planInput, putQuestFixture, seedQuest } from "../server/support";
import { MIGRATIONS } from "../../src/server/migrations";
import { withMemberFixtures } from "../server/member-fixture";

it("emits the tags read by unmanaged, member, and linked journal views", async () => {
  const host = createFakePluginHost({ pluginId: "tavern", experimental_declaredIconNames: ["tavern"], agentSkillIds: ["journal", "quest-management"], sdk: {
    threads: { getPluginMetadata: async () => ({}), updatePluginMetadata: async () => ({}), get: async () => makeThreadResponse() },
    plugins: { list: async () => ({ plugins: [] }) },
  } as never });
  try {
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, MIGRATIONS);
    const store = new KeeperStore(db);
    const keeper = withMemberFixtures(new Keeper(store, fakePort(), Date.now));
    keeper.bind("lead", "keeper", "wren", "project");
    const quest = await seedQuest(keeper, "lead", "Build it", "Build it");
    keeper.plan("lead", planInput(quest.id));
    keeper.bind("maker", "smith", "lark", "project", {
      keeperThreadId: "lead", boardQuestId: quest.id, waypointId: "w1", errand: false, title: "Build",
      brief: { outcome: "Build", mode: "make-it-work", outOfScope: "", doneWhen: "Checks pass", context: [], questions: [], timeboxMinutes: null },
    });
    const archived = await seedQuest(keeper, "lead", "Archived", "Archived");
    keeper.plan("lead", planInput(archived.id));
    putQuestFixture(store, archived.id, { ...keeper.quest(archived.id), phase: "done", endedAt: Date.now(), archivedAt: Date.now() });
    const deleted = await seedQuest(keeper, "lead", "Deleted", "Deleted");
    keeper.plan("lead", planInput(deleted.id));
    putQuestFixture(store, deleted.id, { ...keeper.quest(deleted.id), phase: "done", endedAt: Date.now(), archivedAt: Date.now(), deletedAt: Date.now() });
    await tavern(host.bb);
    const warm = async (threadId: string) => {
      const result = await host.harness.behavior.callAgentTool("journal", { action: "add", descriptions: ["Original"] }, { threadId });
      expect(result).not.toMatchObject({ isError: true });
    };
    for (const id of ["unmanaged", "maker", "linked", "archived-linked", "deleted-linked"]) await warm(id);
    for (const [threadId, questId] of [["linked", quest.id], ["archived-linked", archived.id], ["deleted-linked", deleted.id]]) {
      const row = db.prepare("SELECT data FROM questlog_entries WHERE thread_id=?").get(threadId) as { data: string };
      db.prepare("UPDATE questlog_entries SET board_quest_id=?,data=? WHERE thread_id=?").run(
        questId, JSON.stringify({ ...JSON.parse(row.data), link: { boardQuestId: questId, waypointId: "w1" } }), threadId,
      );
    }

    const signals = host.harness.inspection.experimental_rpcInvalidations;
    const changes = [];
    for (const threadId of ["unmanaged", "maker", "linked"]) {
      const start = signals.length;
      const result = await host.harness.behavior.callAgentTool("journal", { action: "start", id: "00" }, { threadId });
      expect(result).not.toMatchObject({ isError: true });
      changes.push(signals.slice(start));
    }
    const start = signals.length;
    await host.harness.behavior.callRpc("journalEdit", { threadId: "unmanaged", edit: { op: "add", descriptions: ["User edit"] } });
    const user = signals.slice(start);
    console.log("U1 journal signals", JSON.stringify({ changes, user }));
    expect(changes[0]).toEqual([[tags.journal("unmanaged"), tags.thread("unmanaged")]]);
    expect(changes[1]).toHaveLength(1);
    expect(changes[1]?.[0]).toEqual(expect.arrayContaining([tags.room(), tags.thread("lead"), tags.boardQuest(quest.id)]));
    expect(changes[2]).toHaveLength(1);
    expect(changes[2]?.[0]).toEqual(expect.arrayContaining([tags.room(), tags.thread("lead"), tags.boardQuest(quest.id)]));
    for (const signal of changes.flat()) {
      expect(signal).not.toContain(tags.rows());
      expect(signal).not.toContain(tags.attentionCount());
    }
    expect(user).toEqual([...(changes[0] ?? []), [tags.room()]]);
    expect(store.events().find(event => event.type === "authority.acted" && event.data.act === "journalEdit")).toBeDefined();
    const archivedStart = signals.length;
    const edited = await host.harness.behavior.callAgentTool("journal", { action: "note", id: "00", note: "A final detail" }, { threadId: "archived-linked" });
    expect(edited).not.toMatchObject({ isError: true });
    expect(signals.slice(archivedStart)).toEqual([expect.arrayContaining([tags.archivedQuests(), tags.boardQuest(archived.id)])]);
    expect(signals.slice(archivedStart).flat()).not.toContain(tags.room());
    const deletedStart = signals.length;
    const deletedEdit = await host.harness.behavior.callAgentTool("journal", { action: "note", id: "00", note: "A detail from deleted work" }, { threadId: "deleted-linked" });
    expect(deletedEdit).not.toMatchObject({ isError: true });
    const deletedSignals = signals.slice(deletedStart);
    const deletedListTags = rpcContract.deletedBoardQuests.tags!({ cursor: null, limit: 20 }, { boardQuests: [], nextCursor: null, total: 0 });
    console.log("U1 deleted list invalidations", deletedSignals.filter(signal => signal?.some(tag => deletedListTags.includes(tag))).length);
    expect(deletedSignals.filter(signal => signal?.some(tag => deletedListTags.includes(tag)))).toHaveLength(1);
    expect(deletedSignals.flat()).not.toContain(tags.deletedQuestCount());
    expect(deletedSignals.flat()).not.toContain(tags.room());
  } finally { await host.harness.lifecycle.dispose(); }
});
