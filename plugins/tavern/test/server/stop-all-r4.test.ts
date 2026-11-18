// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { StopAll } from "../../src/server/stop-all";
import { TavernRuntime } from "../../src/server/runtime";
import { stopAllHandlers } from "../../src/server/stop-all-rpc";
import { putQuestFixture, seedQuest } from "./support";

const client = { experimental_caller: { kind: "client" } } as const;
afterEach(() => vi.useRealTimers());
describe("R4 brake regressions", () => {
  it.each(["throws", "idle"])("sends stop before any %s status read and never infers already idle", async mode => {
    const calls: string[] = [];
    const f = setup({ threads: {
      stop: async () => { calls.push("stop"); return { ok: true }; },
      get: async () => { calls.push("get"); if (mode === "throws") throw new Error("read unavailable"); return makeThreadResponse({ id: "lead", status: "idle" }); },
    } });
    const result = await f.runtime.stopAll.stop({ kind: "user" });
    expect(calls[0]).toBe("stop");
    expect(calls.filter(call => call === "stop")).toHaveLength(1);
    expect(result.receipt?.alreadyIdle).toBe(0);
    expect(result.receipt?.entries[0]?.status).toBe(mode === "throws" ? "still-stopping" : "stopped");
  });
  it("uses one five-second thread deadline, then confirms through observation without a timer or another stop", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 3000)); return { ok: true }; });
    const f = setup({ threads: { stop, get: async () => new Promise(() => {}) } });
    const pending = f.runtime.stopAll.stop({ kind: "user" });
    f.advance(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.receipt).toMatchObject({ failed: 0, stillStopping: 1 });
    expect(result.receipt?.entries[0]?.error).toContain("no confirmation within 5 s");
    expect(vi.getTimerCount()).toBe(0);
    f.advance(1000);
    f.runtime.updateThread(makeThreadResponse({ id: "lead", status: "idle" }));
    expect(f.runtime.stopAll.snapshot().receipt).toMatchObject({ stopped: 1, stillStopping: 0, elapsedMs: 6000 });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(f.k.store.events().filter(e => e.type === "tavern.stop-receipt")).toHaveLength(2);
  });
  it("does not start a confirmation read after its whole-thread deadline expires", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const get = vi.fn(async () => makeThreadResponse({ id: "lead", status: "idle" }));
    const f = setup({ threads: { get, stop: () => new Promise(resolve => { finish = () => resolve({ ok: true }); }) } });
    const pending = f.runtime.stopAll.stop({ kind: "user" });
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();
    expect(f.runtime.stopAll.snapshot().receipt?.stillStopping).toBe(1);
  });
  it("can pull again while stopped and records another receipt without a resumed transition", async () => {
    const stop = vi.fn(async () => ({ ok: true }));
    const f = setup({ threads: { stop, get: async () => makeThreadResponse({ id: "lead", status: "idle" }) } });
    const original = await f.runtime.stopAll.stop({ kind: "agent", threadId: "lead" });
    f.advance(10);
    const repeated = await f.runtime.stopAll.stop({ kind: "user" });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(repeated).toMatchObject({ since: original.since, by: original.by, byLabel: original.byLabel });
    expect(repeated.receipt?.id).not.toBe(original.receipt?.id);
    expect(repeated.receipt?.startedAt).toBe(original.since! + 10);
    expect(f.runtime.stopAll.reason()).toContain("Keeper");
    expect(f.k.store.events().filter(e => e.type === "tavern.stopped")).toHaveLength(1);
    expect(f.k.store.events().filter(e => e.type === "tavern.stop-receipt")).toHaveLength(2);
    expect(f.runtime.stopAll.snapshot().state).toBe("stopped");
  });
  it.each([
    { ...client, surface: "cli" }, { ...client, threadId: "lead" },
    { ...client, origin: "agent" }, { experimental_caller: { kind: "client", surface: "cli" } },
    { ...client, agentId: "agent" }, { ...client, origin: { senderThreadId: "member" } },
  ])("refuses Resume with an agent or CLI marker: %j", async context => {
    const f = setup();
    await f.runtime.stopAll.stop({ kind: "user" });
    expect(() => stopAllHandlers(f.runtime).resumeAll({}, context as never)).toThrow(/agent|CLI/);
    expect(f.runtime.stopAll.snapshot().state).toBe("stopped");
  });
  it("records the unattested Resume surface and plugin identity without attributing it to a person", async () => {
    const f = setup(), handlers = stopAllHandlers(f.runtime);
    await handlers.stopAll({}, { experimental_caller: { kind: "plugin", pluginId: "other" } } as never);
    expect(f.runtime.stopAll.reason()).toContain("plugin other");
    const resumed = handlers.resumeAll({}, client as never);
    expect(resumed).toHaveProperty("resumeReceipt.surface", "client RPC (unattested)");
    expect(resumed).toHaveProperty("resumeReceipt.notice", "Tavern can't prove a person pressed Resume");
    expect(f.k.store.events().find(e => e.type === "tavern.resumed")).toMatchObject({ actor: { kind: "tavern" }, data: { surface: "client RPC (unattested)" } });
  });
  it("closes incomplete receipt collection and holds pending releases, archives and quest stops across restart", async () => {
    const f = setup(), q = await seedQuest(f.k, "lead", "Hold", "Draft");
    f.k.bind("member", "ranger", "lark", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Scout", brief: { outcome: "Scout", doneWhen: "Findings", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
    f.k.store.patch("member", { releasePending: "Pending release", archivePending: true });
    putQuestFixture(f.k.store, q.id, { ...q, phase: "stopping" });
    f.k.store.put("stopAll", "tavern", { state: "stopped", since: f.time(), by: { kind: "user" }, receipt: { startedAt: f.time(), completedAt: null, elapsedMs: 0, stopped: 0, keepersStopped: 0, membersStopped: 0, stillStopping: 1, failed: 0, alreadyIdle: 0, entries: [{ threadId: "member", role: "member", status: "still-stopping", error: null, confirmedAt: null }] } });
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    const pinWorktree = vi.fn(async () => {}), refreshPresets = vi.fn(async () => {});
    restarted.scopes = { pinWorktree, refreshPresets, pending: () => null, clearScope: vi.fn() } as never;
    const repair = vi.spyOn(restarted as unknown as { repairPartyArchives(): void }, "repairPartyArchives");
    const prepareRegistry = vi.spyOn(restarted, "prepareRegistry");
    const recoverTick = vi.spyOn((restarted as unknown as { loop: { recover(id: string): Promise<void> } }).loop, "recover");
    const recheck = vi.spyOn(restarted, "recheckDispatch").mockResolvedValue(undefined);
    await restarted.reconcile();
    await restarted.sweep();
    expect(new StopAll(restarted).snapshot().receipt?.completedAt).not.toBeNull();
    expect(new StopAll(restarted).snapshot().receipt).toMatchObject({ stopped: 1, stillStopping: 0 });
    expect(f.k.store.runtime("member")).toMatchObject({ releasePending: "Pending release", archivePending: true });
    expect(f.k.store.get("quests", q.id)?.phase).toBe("stopping");
    expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    expect(pinWorktree).toHaveBeenCalledWith("member");
    expect(pinWorktree).toHaveBeenCalledWith("lead");
    expect(refreshPresets).toHaveBeenCalledTimes(1);
    expect(prepareRegistry).toHaveBeenCalledWith("project");
    expect(recoverTick).toHaveBeenCalledWith("lead");
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(repair).not.toHaveBeenCalled();
    const stops = vi.spyOn(restarted, "retryStops");
    const cleanup = vi.spyOn(restarted as unknown as { finishMemberCleanup(id: string): Promise<void> }, "finishMemberCleanup");
    restarted.stopAll.resume();
    const deferred = restarted.resumeDeferredStartup();
    expect(restarted.resumeDeferredStartup()).toBe(deferred);
    await deferred;
    expect(repair).toHaveBeenCalledTimes(1);
    expect(stops).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(f.k.store.events().filter(e => e.type === "tavern.startup-reconciled")).toHaveLength(1);
    restarted.stopAll.resume();
    await restarted.resumeDeferredStartup();
    expect(repair).toHaveBeenCalledTimes(1);
    expect(f.k.store.events().filter(e => e.type === "tavern.startup-reconciled")).toHaveLength(1);
    expect(pinWorktree).toHaveBeenCalledTimes(2);
    expect(stops).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("holds explicit releases and archive completion while stopped", async () => {
    const f = setup();
    f.k.bind("member", "ranger", "lark", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Scout", brief: { outcome: "Scout", doneWhen: "Findings", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
    await f.runtime.stopAll.stop({ kind: "user" });
    await expect(f.runtime.release("lead", "member", "Done")).rejects.toThrow(/Tavern is stopped/);
    await f.runtime.archiveMember("member");
    expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    expect(f.k.store.runtime("member").released).toBeFalsy();
  });
  it("tells each Keeper which member turns were interrupted on Resume", async () => {
    const f = setup();
    f.k.bind("member", "ranger", "lark", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Scout", brief: { outcome: "Scout", doneWhen: "Findings", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
    await f.runtime.stopAll.stop({ kind: "user" });
    f.runtime.stopAll.resume();
    expect(f.k.store.events("lead").find(e => e.type === "tavern.members-interrupted")?.data.memberThreadIds).toEqual(["member"]);
  });
});
