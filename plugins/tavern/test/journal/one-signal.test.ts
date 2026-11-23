// @vitest-environment node
import { seedQuest } from "../server/support";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import tavern from "../../server";
import { tags } from "../../src/shared/contract";
import { setup } from "../server/runtime-fixture";
import { fakePort, planInput } from "../server/support";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { withMemberFixtures } from "../server/member-fixture";

// Beena's live measure: each journal change made every open page fetch the room twice, from the journal's signal and then the Keeper's.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const c of cleanups.splice(0)) await c(); } finally { vi.unstubAllEnvs(); } });
async function server() {
  const root = mkdtempSync(join(tmpdir(), "tavern-one-signal-"));
  vi.stubEnv("HOME", root);
  const host = createFakePluginHost({ pluginId: "tavern", experimental_declaredIconNames: ["tavern"], dataDir: join(root, "data"), agentSkillIds: ["journal", "quest-management"], sdk: {
    threads: { getPluginMetadata: async () => ({}), updatePluginMetadata: async () => ({}), get: async () => makeThreadResponse() },
    plugins: { list: async () => ({ plugins: [] }) },
  } as never });
  cleanups.push(async () => { try { await host.harness.lifecycle.dispose(); } finally { rmSync(root, { recursive: true, force: true }); } });
  await tavern(host.bb);
  return host;
}
const withRoom = (all: readonly (readonly string[] | null)[]) => all.filter((t) => t === null || t.includes(tags.room()));

describe("a journal change", () => {
  it("sends exactly one signal that includes the room", async () => {
    const { bb, harness } = await server();
    const store = new KeeperStore(bb.storage.database());
    const keeper = withMemberFixtures(new Keeper(store, fakePort(), Date.now));
    keeper.bind("lead", "keeper", "wren", "project");
    keeper.bind("t", "smith", "lark", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "An errand", brief: { outcome: "Do the errand", mode: "make-it-work", outOfScope: "", doneWhen: "Done", context: [], questions: [], timeboxMinutes: null } });
    await harness.behavior.callAgentTool("journal", { action: "add", descriptions: ["warm up"] }, { threadId: "t" });
    const seen = harness.inspection.experimental_rpcInvalidations;
    const before = seen.length;
    await harness.behavior.callAgentTool("journal", { action: "add", descriptions: ["Measure the room"] }, { threadId: "t" });
    const after = seen.slice(before);
    expect(withRoom(after)).toHaveLength(1);
    expect(after.find((t) => t?.includes(tags.room()))).toEqual(expect.arrayContaining([tags.room(), tags.journal("t"), tags.thread("t")]));
  });
});

describe("the Keeper's part of a member's journal change", () => {
  it("still syncs the Keeper's board mirrors and names the Keeper, quest and party, but leaves signalling to the journal", async () => {
    const f = setup();
    cleanups.push(async () => { f.k.store.db.close(); });
    const q = await seedQuest(f.k,"lead", "README smoke", "README smoke");
    f.k.plan("lead", planInput(q.id));
    f.k.bind("m1", "smith", "lark", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Fix README", brief: { outcome: "Fix README", mode: "make-it-work", outOfScope: "Publishing", doneWhen: "Checks pass", context: [], questions: [], timeboxMinutes: null } } as never);
    const sync = vi.spyOn(f.k.journal, "syncBoardQuests");
    const signal = vi.spyOn(f.bb.rpc, "experimental_invalidate");
    signal.mockClear();
    const stale = f.k.changedTags("m1", q.id);
    expect(sync).toHaveBeenCalledWith("lead");
    expect(stale).toEqual(expect.arrayContaining([tags.room(), tags.rows(), tags.thread("m1"), tags.journal("m1"), tags.thread("lead"), tags.boardQuest(q.id)]));
    expect(signal).not.toHaveBeenCalled();
    // changed() is unchanged for every other caller: the same work, signalled once.
    f.k.changed("m1", q.id);
    expect(signal.mock.calls).toEqual([[stale]]);
  });
});
