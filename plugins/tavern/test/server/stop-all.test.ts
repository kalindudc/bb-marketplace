// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makeThreadResponse } from "./host";
import { seedQuest } from "./support";
import { StopAll } from "../../src/server/stop-all";
import { stopAllHandlers } from "../../src/server/stop-all-rpc";
import { PlacementProvisioner } from "../../src/server/placement/provision";
import { PlacementStore } from "../../src/server/placement/store";
import { registerCli } from "../../src/server/cli";

function fixture() {
  const active = new Set(["lead", "lead2", "placed", "fails", "slow"]);
  const f = setup({ threads: {
    get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: threadId === "placed" ? "remote-machine" : "env", status: active.has(threadId) ? "active" : "idle" }),
    stop: async ({ threadId }: { threadId: string }) => {
      f.advance(10);
      if (threadId === "fails") throw new Error("machine unreachable");
      if (threadId !== "slow") active.delete(threadId);
      return {};
    },
    send: async () => ({ delivery: "sent" }),
    events: { list: async () => [] },
  } });
  f.k.bind("lead2", "keeper", "wren", "project");
  for (const id of ["placed", "idle", "fails", "slow"]) f.k.bind(id, "ranger", "lark", "project", {
    keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: id,
    brief: { outcome: "Scout", doneWhen: "Findings", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null },
  });
  return f;
}

describe("Stop all brake", () => {
  it("stores the transition before stopping and retains the drill receipt without touching quests or allocations", async () => {
    const f = fixture();
    await seedQuest(f.k, "lead", "Keep intact", "Draft");
    const quests = f.k.store.all("quests"), members = f.k.store.all("members");
    expect(f.runtime.stopAll.snapshot().state).toBe("running");
    const flight = f.runtime.stopAll.stop({ kind: "agent", threadId: "placed" });
    expect(f.runtime.stopAll.snapshot().state).toBe("stopped");
    const state = await flight;
    expect(state.receipt).toMatchObject({ stopped: 4, keepersStopped: 2, membersStopped: 2, stillStopping: 1, failed: 1, alreadyIdle: 0, elapsedMs: 60 });
    expect(state.receipt?.entries.find(e => e.threadId === "fails")?.error).toContain("machine unreachable");
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(6);
    expect(f.k.store.all("quests")).toEqual(quests);
    expect(f.k.store.all("members")).toEqual(members);
    expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    expect(new StopAll(f.runtime).snapshot()).toEqual(state);
    expect(f.k.store.events().find(e => e.type === "tavern.stopped")?.data.receipt).toMatchObject({ stillStopping: 6 });
    expect(f.k.store.events().find(e => e.type === "tavern.stop-receipt")?.data.receipt).toEqual(state.receipt);
    await f.runtime.stopAll.stop({ kind: "user" });
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(12);
  });
  it("holds ticks, briefs, hires and automated dispatch but lets typed user messages pass", async () => {
    const f = fixture();
    await f.runtime.stopAll.stop({ kind: "user" });
    const reason = `Tavern is stopped by you since ${new Date(f.time() - 60).toISOString()}; resume on the common room. A message queued together with Tavern\'s own work waits until you resume.`;
    await expect(f.runtime.sendRebrief("idle", "New work")).rejects.toThrow(reason);
    await expect(f.runtime.hire("lead", "project", {} as never)).rejects.toThrow(reason);
    await f.runtime.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    const automated = await f.runtime.dispatch(dispatch049({ pluginId: "tavern", text: "[Tavern brief] work" }));
    expect(automated).toMatchObject({ action: "wait", reason });
    const mixed = await f.runtime.dispatch(dispatch049({ rows: [queued049("tick", "[Tavern tick] work", f.time(), { pluginId: "tavern" }), queued049("user", "Talk to me", f.time())] }));
    expect(mixed.action).not.toBe("proceed");
    expect(await f.runtime.dispatch(dispatch049({ text: "Talk to me" }))).toMatchObject({ action: "proceed" });
    expect(f.runtime.stopAll.snapshot().state).toBe("stopped");
  });
  it.each(["lead", "placed"])("allows a %s caller to stop but only a client can resume", async threadId => {
    const f = fixture(), handlers = stopAllHandlers(f.runtime);
    await handlers.stopAll({}, { experimental_caller: { kind: "plugin", pluginId: "other" } } as never);
    expect(f.runtime.stopAll.snapshot().state).toBe("stopped");
    expect(() => handlers.resumeAll({}, undefined)).toThrow(/client/);
    expect(() => handlers.resumeAll({}, { experimental_caller: { kind: "plugin", pluginId: "tavern" } } as never)).toThrow(/client/);
    await handlers.resumeAll({}, { experimental_caller: { kind: "client" } } as never);
    expect(f.runtime.stopAll.snapshot().state).toBe("running");
    expect(f.k.store.events().filter(e => e.type === "tavern.resumed")).toHaveLength(1);
    await f.runtime.stopAll.stop({ kind: "agent", threadId });
    expect(f.runtime.stopAll.snapshot().by).toEqual({ kind: "agent", threadId });
  });
  it("refuses direct provision spawns before allocating or changing a placement", async () => {
    const f = fixture();
    await f.runtime.stopAll.stop({ kind: "user" });
    const provision = new PlacementProvisioner(f.bb, new PlacementStore(f.k.store.db), f.k.store);
    await expect(provision.spawn("not-allocated", 1, { providerId: "pi", permissionMode: "full" })).rejects.toThrow(/Tavern is stopped/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("can resume an interrupted receipt after a process restart", async () => {
    const f = fixture();
    f.k.store.put("stopAll", "tavern", { state: "stopped", since: f.time(), by: { kind: "user" }, receipt: null });
    expect(new StopAll(f.runtime).resume().state).toBe("running");
  });
  it("does not treat a starting Keeper as already idle", async () => {
    const f = setup({ threads: {
      get: async () => makeThreadResponse({ id: "lead", status: "starting" }),
      stop: async () => ({}),
    } });
    const result = await f.runtime.stopAll.stop({ kind: "user" });
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
    expect(result.receipt).toMatchObject({ stillStopping: 1, alreadyIdle: 0 });
  });
  it("does not turn the global stop into a per-Keeper manual stop when bb reports its interruption later", async () => {
    const f = fixture();
    await f.runtime.stopAll.stop({ kind: "user" });
    const since = f.runtime.stopAll.snapshot().since!;
    const manualBefore = f.k.store.runtime("lead").manualStopAt;
    f.runtime.stopAll.resume();
    vi.spyOn(f.bb.sdk.threads.events, "list").mockResolvedValue([{
      seq: 1, type: "system/thread/interrupted", createdAt: since + 5, data: { reason: "manual-stop" },
    }] as never);
    await f.runtime.observe(makeThreadResponse({ id: "lead" }));
    expect(f.k.store.runtime("lead").manualStopAt).toBe(manualBefore);
    expect(f.runtime.stopAll.ownsInterruption("lead", since - 1)).toBe(false);
    expect(f.runtime.stopAll.ownsInterruption("lead", f.time() + 1)).toBe(false);
  });
  it("offers CLI stop and status to members, but no CLI resume", async () => {
    const f = fixture();
    registerCli(f.bb, f.runtime);
    const cli = f.harness.inspection.registrations.cli[0]!;
    expect((await cli.run(["stop-all"], { threadId: "placed" })).exitCode).toBe(0);
    expect(JSON.parse((await cli.run(["stop-all", "status"], {})).stdout!)).toMatchObject({ state: "stopped", receipt: { failed: 1 } });
    expect((await cli.run(["stop-all", "resume"], {})).exitCode).not.toBe(0);
    expect(f.runtime.stopAll.snapshot().state).toBe("stopped");
  });
});
