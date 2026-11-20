// @vitest-environment node
import { patchThreadFixture, putMemberFixture } from "./member-fixture";
import { putQuestFixture } from "./support";
import { afterEach, expect, it, vi } from "vitest";
import { rpcContract, type MapHistory } from "../../src/shared/contract";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { fixtureMember, fixtureBoard } from "../../src/ui/thread/fixtures";
const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
it("caps history at the 50 most recently archived Keepers", async () => {
  const f = setup(); databases.push(f.k.store.db); registerRpc(f.bb, f.runtime);
  for (let i = 0; i < 55; i++) {
    const threadId = `archived-${i}`;
    f.k.store.put("members", threadId, { ...fixtureMember, threadId });
    patchThreadFixture(f.k.store, threadId, { archivedAt: 1000 + i });
  }
  const result = await f.harness.invokeRpc("mapHistory", {}) as MapHistory;
  expect(result.keepers).toHaveLength(50);
  expect(result.keepers.some(k => k.threadId === "archived-4")).toBe(false);
  expect(result.keepers.some(k => k.threadId === "archived-5")).toBe(true);
  expect(result.keepers.some(k => k.threadId === "archived-54")).toBe(true);
});
it("uses a dedicated tag and invalidates it on quest and Keeper archive transitions, not active work", async () => {
  const f = setup(); databases.push(f.k.store.db); registerRpc(f.bb, f.runtime);
  expect(rpcContract.mapHistory.tags?.({}, {} as never)).toEqual(["tavern:map-history"]);
  const invalidated: string[] = [];
  const signal = vi.spyOn(f.bb.rpc, "experimental_invalidate").mockImplementation(values => { invalidated.push(...values); });
  f.k.changed("lead");
  expect(invalidated).not.toContain("tavern:map-history");
  putQuestFixture(f.k.store, "ended", { ...fixtureBoard, id: "ended", keeperThreadId: "lead", phase: "done" });
  f.k.archiveQuests(["ended"], true, { kind: "user" });
  expect(invalidated).toContain("tavern:map-history");
  invalidated.length = 0;
  const thread = await f.bb.sdk.threads.get({ threadId: "lead" });
  f.runtime.updateThread({ ...thread, archivedAt: f.time() });
  expect(invalidated).toContain("tavern:map-history");
  invalidated.length = 0;
  f.runtime.updateThread({ ...thread, archivedAt: null });
  expect(invalidated).toContain("tavern:map-history");
  signal.mockRestore();
});
it("returns five newest quests per archived Keeper, exact totals and parties including cellar work in one statement", async () => {
  const f = setup(); databases.push(f.k.store.db); registerRpc(f.bb, f.runtime);
  for (const threadId of ["old-a", "old-b", "live", "empty"]) {
    f.k.store.put("members", threadId, { ...fixtureMember, threadId });
    patchThreadFixture(f.k.store, threadId, { archivedAt: threadId === "live" ? null : 500 });
    const count = threadId === "empty" ? 0 : threadId === "old-b" ? 2 : 8;
    for (let i = 0; i < count; i++) {
      const id = `${threadId}-${i}`;
      putQuestFixture(f.k.store, id, { ...fixtureBoard, id, keeperThreadId: threadId, phase: "done", endedAt: 1000 + i, archivedAt: i % 2 ? 800 : null });
      putMemberFixture(f.k.store, `member-${id}`, { ...fixtureMember, threadId: `member-${id}`, role: "member", keeperThreadId: threadId, boardQuestId: id });
    }
  }
  const prepare = vi.spyOn(f.k.store.db, "prepare");
  const result = await f.harness.invokeRpc("mapHistory", {}) as { keepers: { threadId: string; total: number; quests: { id: string; archivedAt?: number | null; members: { threadId: string }[] }[] }[] };
  expect(prepare).toHaveBeenCalledTimes(1);
  const a = result.keepers.find(k => k.threadId === "old-a")!;
  expect(a.total).toBe(8);
  expect(a.quests.map(q => q.id)).toEqual([7, 6, 5, 4, 3].map(i => `old-a-${i}`));
  expect(a.quests.some(q => q.archivedAt != null)).toBe(true);
  expect(a.quests.every(q => q.members[0]?.threadId === `member-${q.id}`)).toBe(true);
  expect(result.keepers.find(k => k.threadId === "old-b")?.quests).toHaveLength(2);
  expect(result.keepers.find(k => k.threadId === "empty")).toMatchObject({ total: 0, quests: [] });
  expect(result.keepers.some(k => k.threadId === "live")).toBe(false);
});
