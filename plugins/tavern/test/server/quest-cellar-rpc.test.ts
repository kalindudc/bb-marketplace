// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { registerRpc } from "../../src/server/rpc";
import { readStatus, statusInput } from "../../src/server/status";

async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Private work", "Private work");
  f.k.store.put("quests", q.id, { ...q, phase: "done", endedAt: f.time() });
  registerRpc(f.bb, f.runtime);
  const call = (method: string, input: unknown, plugin = false) => f.harness.invokeRpc(method, input, { experimental_caller: plugin ? { kind: "plugin", pluginId: "other-plugin" } : { kind: "client" } });
  return { ...f, q, call };
}
describe("quest cellar RPC", () => {
  it.each(["archiveBoardQuests", "deleteBoardQuest", "restoreDeletedQuest"])("refuses non-client %s callers", async method => {
    const f = await fixture();
    await expect(f.call(method, method === "archiveBoardQuests" ? { ids: [f.q.id], archived: true } : { id: f.q.id }, true)).rejects.toThrow(/client/i);
    expect(f.k.quest(f.q.id).archivedAt).toBeNull();
    expect(f.k.quest(f.q.id).deletedAt).toBeUndefined();
  });
  it("cellars through runtime and returns pending cleanup and Keeper receipt notes", async () => {
    const f = await fixture();
    await seedQuest(f.k, "lead", "Another goal", "Another goal");
    const result = await f.call("archiveBoardQuests", { ids: [f.q.id], archived: true });
    expect(result).toMatchObject({ ok: true, changed: 1, notes: [expect.stringContaining("stays: it has another quest on the board")], pendingArchives: [] });
  });
  it("omits routes for a deleted quest without removing unrelated routes", async () => {
    const f = await fixture();
    const route = { id: "deleted-route", keeperThreadId: "lead", messageKey: "message", messageAt: f.time(), kind: "aside" as const, boardQuestId: f.q.id, boardQuestIds: [], summary: "Private route text", corrected: false, createdAt: f.time() };
    f.k.store.put("routes", route.id, route);
    f.k.store.put("routes", "ordinary-route", { ...route, id: "ordinary-route", boardQuestId: null, summary: "Ordinary route text" });
    f.k.deleteQuest(f.q.id);
    const result = await f.call("routes", { threadId: "lead" });
    expect(result).toMatchObject({ routes: [{ id: "ordinary-route" }], boardQuests: [] });
    expect(JSON.stringify(result)).not.toContain("Private route text");
    expect(f.k.store.get("routes", route.id)).toEqual(route);
  });
  it("hides deletion from ordinary reads, keeps its audit, and restores it to the cellar", async () => {
    const f = await fixture();
    await f.call("deleteBoardQuest", { id: f.q.id });
    await expect(f.call("boardQuest", { id: f.q.id })).rejects.toThrow(/deleted/i);
    expect(JSON.stringify(await f.call("room", {}))).not.toContain(f.q.title);
    expect(JSON.stringify(await f.call("mapHistory", {}))).not.toContain(f.q.title);
    expect(JSON.stringify(await f.call("routes", { threadId: "lead" }))).not.toContain(f.q.title);
    expect(await f.call("archivedBoardQuests", {})).toMatchObject({ total: 0, boardQuests: [] });
    expect(await f.call("deletedBoardQuests", {})).toMatchObject({ total: 1, boardQuests: [{ id: f.q.id }] });
    expect(JSON.stringify(readStatus(f.runtime, "lead", statusInput.parse({})))).not.toContain(f.q.title);
    expect(f.k.store.events("lead").some(e => e.type === "quest.deleted")).toBe(true);
    await f.call("restoreDeletedQuest", { id: f.q.id });
    expect(await f.call("archivedBoardQuests", {})).toMatchObject({ total: 1 });
    expect(await f.call("deletedBoardQuests", {})).toMatchObject({ total: 0 });
  });
});
