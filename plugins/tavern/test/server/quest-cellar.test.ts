// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { makeThreadResponse } from "./host";
import { registerTools } from "../../src/server/tools";
import { readStatus, statusInput } from "../../src/server/status";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";

async function fixture() {
  const threads = new Map(["lead", "child"].map(id => [id, makeThreadResponse({ id, status: "idle" })]));
  const archive = vi.fn(async ({ threadId }: { threadId: string }) => { threads.set(threadId, { ...threads.get(threadId)!, archivedAt: 1000000 }); return { ok: true }; });
  const unarchive = vi.fn(async ({ threadId }: { threadId: string }) => { threads.set(threadId, { ...threads.get(threadId)!, archivedAt: null }); return { ok: true }; });
  const f = setup({ threads: { get: async ({ threadId }: { threadId: string }) => threads.get(threadId)!, archive, unarchive, queuedMessages: { list: async () => [] } } });
  const q = await seedQuest(f.k, "lead", "Private work", "Private work");
  f.k.store.put("quests", q.id, { ...q, phase: "done", endedAt: f.time() });
  f.k.bind("child", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Private work", displayName: "Vale", brief: { outcome: "Draft", mode: "make-it-work", doneWhen: "Tests pass", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
  return { ...f, q, threads, archive, unarchive };
}

describe("quest cellar threads", () => {
  it("keeps a Keeper with a live side quest and names the reason", async () => {
    const f = await fixture();
    const child = f.k.member("child")!;
    f.k.store.put("members", "errand", { ...child, threadId: "errand", boardQuestId: null, errand: true, state: "working" });
    f.threads.set("errand", makeThreadResponse({ id: "errand", status: "active" }));
    f.k.store.put("members", "lead", { ...f.k.member("lead")!, displayName: "Moss" });
    const result = await f.runtime.archiveBoardQuests([f.q.id], true);
    expect(result.notes).toEqual(["Moss stays: it has a side quest out"]);
    expect(f.archive).toHaveBeenCalledExactlyOnceWith({ threadId: "child" });
  });
  it.each(["done", "failed", "released"] as const)("does not keep a Keeper open for a %s side quest", async status => {
    const f = await fixture();
    f.k.store.put("members", "errand", { ...f.k.member("child")!, threadId: "errand", boardQuestId: null, errand: true, state: status === "released" ? "working" : status });
    if (status === "released") f.k.store.patch("errand", { released: { reason: "Finished", decisionId: "release" } });
    const result = await f.runtime.archiveBoardQuests([f.q.id], true);
    expect(result.notes).toEqual([]);
    expect(f.archive.mock.calls.map(([args]) => args.threadId).sort()).toEqual(["child", "lead"]);
  });
  it("rechecks side quests before deferred Keeper cleanup", async () => {
    const f = await fixture();
    vi.spyOn(f.runtime.away, "cleanupHeld").mockReturnValue(true);
    await f.runtime.archiveBoardQuests([f.q.id], true);
    f.k.store.put("members", "errand", { ...f.k.member("child")!, threadId: "errand", boardQuestId: null, errand: true, state: "working" });
    f.threads.set("errand", makeThreadResponse({ id: "errand", status: "active" }));
    vi.mocked(f.runtime.away.cleanupHeld).mockReturnValue(false);
    await f.runtime.sweep();
    expect(f.archive).toHaveBeenCalledExactlyOnceWith({ threadId: "child" });
  });
  it.each(["done", "deleted"])("describes an unarchived member of a %s quest as back in the roster", async phase => {
    const f = await fixture();
    await f.runtime.archiveBoardQuests([f.q.id], true);
    if (phase === "deleted") f.k.deleteQuest(f.q.id);
    const result = await f.runtime.unarchiveMember("lead", "child");
    expect(result.message).toContain("back in the Keeper's roster");
    expect(result.message).not.toContain("available");
    const again = await f.runtime.unarchiveMember("lead", "child");
    expect(again.message).toContain("Already open");
    expect(again.message).not.toContain("Unarchived");
    expect(f.unarchive.mock.calls.filter(([args]) => args.threadId === "child")).toHaveLength(1);
  });
  it("reports an already-open live member without an SDK unarchive", async () => {
    const f = await fixture();
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "build", endedAt: null });
    const result = await f.runtime.unarchiveMember("lead", "child");
    expect(result.message).toContain("Already open");
    expect(f.unarchive).not.toHaveBeenCalled();
  });

  it("exposes a Keeper-only named unarchive tool and reports archived members including released and deleted-quest wording", async () => {
    const f = await fixture(); registerTools(f.bb, f.runtime);
    await f.runtime.archiveBoardQuests([f.q.id], true);
    f.k.store.patch("child", { released: { reason: "Finished", decisionId: "release" } });
    f.k.deleteQuest(f.q.id);
    const status = readStatus(f.runtime, "lead", statusInput.parse({}));
    expect(status).toMatchObject({ archivedMembers: [{ name: "Vale", classId: "smith", quest: "a deleted quest", released: true }] });
    const result = await f.harness.behavior.invokeAgentTool("tavern_unarchive", { memberThreadId: "Vale" }, { threadId: "lead" });
    expect(JSON.parse(result as string)).toMatchObject({ released: true });
    expect(f.unarchive).toHaveBeenCalledWith({ threadId: "child" });
    await expect(f.harness.behavior.invokeAgentTool("tavern_unarchive", { memberThreadId: "lead" }, { threadId: "child" })).rejects.toThrow("Only a Tavern keeper may call this tool");
  });

  it("bulk cellar archives the Keeper once after all its quests leave the board", async () => {
    const f = await fixture();
    const second = await seedQuest(f.k, "lead", "Other goal", "Other goal");
    f.k.store.put("quests", second.id, { ...second, phase: "stopped" });
    const result = await f.runtime.archiveBoardQuests([f.q.id, second.id], true);
    expect(result).toMatchObject({ changed: 2, notes: [], pendingArchives: [] });
    expect(f.archive.mock.calls.filter(([input]) => input.threadId === "lead")).toHaveLength(1);
  });
  it("retries a failed archive and records its host-owned lifecycle event", async () => {
    const f = await fixture();
    f.archive.mockRejectedValueOnce(new Error("offline"));
    const result = await f.runtime.archiveBoardQuests([f.q.id], true);
    expect(result.pendingArchives).toContain("child");
    expect(f.k.store.runtime("child").archivePending).toBe(true);
    await f.runtime.sweep();
    expect(f.k.store.runtime("child").archivePending).toBe(false);
    await f.runtime.threadLifecycle("thread.archived", { thread: f.threads.get("child")! });
    expect(f.k.store.events("lead").filter(e => e.type === "thread.archived" && e.data.memberThreadId === "child")).toHaveLength(1);
  });
  it("Bring up cancels a delayed Keeper archive without reviving any member", async () => {
    const f = await fixture();
    vi.spyOn(f.runtime.away, "cleanupHeld").mockReturnValue(true);
    await f.runtime.archiveBoardQuests([f.q.id], true);
    await f.runtime.archiveBoardQuests([f.q.id], false);
    vi.mocked(f.runtime.away.cleanupHeld).mockReturnValue(false);
    await f.runtime.sweep();
    expect(f.archive.mock.calls.map(([input]) => input.threadId)).toEqual(["child"]);
    expect(f.unarchive).not.toHaveBeenCalled();
  });
  it("timed auto-archive changes only quest state", async () => {
    const f = await fixture();
    const settings = new SettingsStore(f.k.store.db, f.time);
    f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
    settings.update({ revision: 0, patch: { data: { autoArchiveDays: 1 } }, why: "Archive old quests" });
    f.advance(2 * 86400000);
    await f.runtime.settingsMaintenance();
    expect(f.k.quest(f.q.id).archivedAt).not.toBeNull();
    expect(f.archive).not.toHaveBeenCalled();
  });
  it("archives the party and idle Keeper, then Bring up unarchives only the Keeper", async () => {
    const f = await fixture();
    await f.runtime.archiveBoardQuests([f.q.id], true);
    expect(f.archive.mock.calls.map(([input]) => input.threadId).sort()).toEqual(["child", "lead"]);
    await f.runtime.archiveBoardQuests([f.q.id], false);
    expect(f.unarchive).toHaveBeenCalledExactlyOnceWith({ threadId: "lead" });
    expect(f.threads.get("child")!.archivedAt).not.toBeNull();
  });
  it("keeps a Keeper with another uncellared quest and explains why", async () => {
    const f = await fixture();
    await seedQuest(f.k, "lead", "Other goal", "Other goal");
    const result = await f.runtime.archiveBoardQuests([f.q.id], true);
    expect(f.archive).toHaveBeenCalledExactlyOnceWith({ threadId: "child" });
    expect(result.notes).toEqual([expect.stringContaining("stays: it has another quest on the board")]);
  });
  it("does not unarchive a Keeper whose archive was not requested by Tavern", async () => {
    const f = await fixture();
    f.threads.set("lead", { ...f.threads.get("lead")!, archivedAt: 123 });
    await f.runtime.archiveBoardQuests([f.q.id], true);
    await f.runtime.archiveBoardQuests([f.q.id], false);
    expect(f.unarchive).not.toHaveBeenCalled();
  });
  it("defers cleanup under Closing time and rechecks Keeper eligibility on retry", async () => {
    const f = await fixture();
    vi.spyOn(f.runtime.away, "cleanupHeld").mockReturnValue(true);
    const result = await f.runtime.archiveBoardQuests([f.q.id], true);
    expect(result.pendingArchives.sort()).toEqual(["child", "lead"]);
    expect(f.archive).not.toHaveBeenCalled();
    await seedQuest(f.k, "lead", "Another goal", "Another goal");
    vi.mocked(f.runtime.away.cleanupHeld).mockReturnValue(false);
    await f.runtime.sweep();
    expect(f.archive).toHaveBeenCalledExactlyOnceWith({ threadId: "child" });
  });
  it("delete uses the same thread cleanup", async () => {
    const f = await fixture();
    await f.runtime.deleteBoardQuest(f.q.id);
    expect(f.k.quest(f.q.id).deletedAt).toBe(f.time());
    expect(f.archive.mock.calls.map(([input]) => input.threadId).sort()).toEqual(["child", "lead"]);
  });
  it("unarchives its own named released member without rehiring it", async () => {
    const f = await fixture();
    await f.runtime.archiveBoardQuests([f.q.id], true);
    f.k.store.patch("child", { released: { reason: "Finished", decisionId: "release" } });
    const result = await f.runtime.unarchiveMember("lead", "Vale");
    expect(result.released).toBe(true);
    expect(f.unarchive).toHaveBeenCalledWith({ threadId: "child" });
    expect(f.k.store.runtime("child").released).toMatchObject({ reason: "Finished" });
  });
  it("refuses another Keeper's member and deleted threads", async () => {
    const f = await fixture();
    f.k.bind("other", "keeper", null, "project");
    await expect(f.runtime.unarchiveMember("other", "child")).rejects.toThrow(/own party/);
    f.threads.set("child", { ...f.threads.get("child")!, deletedAt: 123 });
    await expect(f.runtime.unarchiveMember("lead", "child")).rejects.toThrow(/deleted/i);
    expect(f.unarchive).not.toHaveBeenCalled();
  });
});
