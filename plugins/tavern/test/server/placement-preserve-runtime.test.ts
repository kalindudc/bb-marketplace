// @vitest-environment node
import { patchThreadFixture, runtimeFixture } from "./member-fixture";
import { putQuestFixture } from "./support";
import { expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { placementRecord } from "./placement-fixture";
import { registerTools } from "../../src/server/tools";

async function fixture(placed = true) {
  const archived = new Set<string>();
  const stop = vi.fn(async () => ({ ok: true })), archive = vi.fn(async ({ threadId }: { threadId: string }) => { archived.add(threadId); return { ok: true }; });
  const f = setup({ threads: { stop, archive, queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) }, get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", archivedAt: archived.has(threadId) ? 1 : null }) } });
  const quest = await seedQuest(f.k, "lead", "Draft", "Tested draft");
  f.k.bind("child", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: quest.id, waypointId: null, errand: false, title: "Draft", brief: { outcome: "Draft", doneWhen: "Tests pass", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
  f.runtime.spawnBriefDelivered("child");
  if (placed) f.runtime.placements().store.reserve(placementRecord({ memberThreadId: "child", keeperThreadId: "lead", questId: quest.id }), { maxMakers: 2, maxCheckers: 2 });
  vi.spyOn(f.runtime.placements(), "host", "get").mockReturnValue({ call: vi.fn(), onWorkerExit: () => () => {} });
  const save = vi.spyOn(f.runtime.placements().preserve, "beforeRelease").mockResolvedValue({ state: "blocked", message: "save refused" });
  const confirmMachine = () => {
    const placements = f.runtime.placements().store, record = placements.byMember("child")!;
    const cancelled = placements.cancel(record.id, record.generation);
    placements.update(cancelled.id, cancelled.generation, row => ({ ...row, phase: "releasing",
      preservation: { ...row.preservation, source: "not-needed", liveOwnerThreadId: null, stopConfirmed: true } }), "released");
    placements.finishRelease(cancelled.id, cancelled.generation, true);
    archived.add("child");
    return { state: "released" as const };
  };
  return { ...f, quest, save, stop, archive, archived, confirmMachine };
}
it("stops before preservation on release and does not publish a release on save failure", async () => {
  const f = await fixture();
  expect(await f.runtime.release("lead", "child", "Release")).toBe(false);
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.save).toHaveBeenCalledWith("child", "Release");
  expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(f.save.mock.invocationCallOrder[0]!);
  expect(runtimeFixture(f.k.store, "child").released).toBeFalsy(); expect(f.archive).not.toHaveBeenCalled();
});
it("preserves local work after stopping an unplaced release and before archiving", async () => {
  const f = await fixture(false);
  const preserve = vi.spyOn(f.runtime, "preserveWorkOrRefuse").mockResolvedValue(null);
  expect(await f.runtime.release("lead", "child", "Release")).toBe(true);
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.save).not.toHaveBeenCalled(); expect(f.archive).toHaveBeenCalledOnce();
  expect(preserve).toHaveBeenCalledExactlyOnceWith("child");
  expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(preserve.mock.invocationCallOrder[0]!);
  expect(preserve.mock.invocationCallOrder[0]).toBeLessThan(f.archive.mock.invocationCallOrder[0]!);
});
it("keeps a quest stopping and its thread alive until preservation succeeds", async () => {
  const f = await fixture();
  await f.runtime.stop(f.quest.id, "Quest stop");
  expect(f.k.quest(f.quest.id).phase).toBe("stopping"); expect(f.save).toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
  f.save.mockImplementation(async () => f.confirmMachine());
  await f.runtime.stop(f.quest.id, "Retry");
  expect(f.k.quest(f.quest.id).phase).toBe("stopped");
});
it("blocks archiveMembers on preservation failure and skips duplicate native archive after preservation", async () => {
  const f = await fixture();
  patchThreadFixture(f.k.store, "child", { archivePending: true });
  expect(await f.runtime["archiveMembers"]([f.k.member("child")!])).toEqual(["child"]);
  expect(f.archive).not.toHaveBeenCalled(); expect(runtimeFixture(f.k.store, "child").archiveError).toContain("save refused");
  f.save.mockImplementation(async () => f.confirmMachine());
  expect(await f.runtime["archiveMembers"]([f.k.member("child")!])).toEqual([]);
  expect(f.archive).not.toHaveBeenCalled();
});
it("allows an idle preservation hold after a quest stops without allowing ordinary content holds", async () => {
  const f = await fixture();
  putQuestFixture(f.k.store, f.quest.id, { ...f.k.quest(f.quest.id), phase: "stopped", endedAt: 1 });
  expect(() => f.runtime.away.requestContentHold("child", { operationId: "submission", idleOnly: true })).toThrow(/active party/);
  const token = f.runtime.away.requestContentHold("child", { operationId: "preserve", idleOnly: true, preservation: true });
  expect(await f.runtime.away.confirmHeld(token)).toMatchObject({ state: "confirmed" });
  expect(f.stop).not.toHaveBeenCalled(); f.runtime.away.finishContentHold(token);
  patchThreadFixture(f.k.store, "child", { archivedAt: 1 });
  expect(() => f.runtime.away.requestContentHold("child", { operationId: "preserve-archived", idleOnly: true, preservation: true })).toThrow();
});
it("completes a quest stop after external archive and frees the lost member's slot", async () => {
  const f = await fixture(); f.save.mockRestore();
  f.archived.add("child");
  f.runtime.updateThread(makeThreadResponse({ id: "child", archivedAt: 1 }));
  expect(await f.runtime.stop(f.quest.id, "Stop after external archive")).toMatchObject({ phase: "stopped" });
  expect(f.runtime.placements().store.byMember("child")).toMatchObject({ phase: "released", preservation: { source: "lost" } });
  expect(f.runtime.placements().store.counts("lead").makers).toBe(0);
  expect(f.k.store.events("lead").some(event => /its work was not saved/.test(event.text))).toBe(true);
});
it("finishes a Keeper release of a lost member with an honest loss reply", async () => {
  const f = await fixture(); f.save.mockRestore(); registerTools(f.bb, f.runtime);
  f.runtime.placements().preserve.observeLoss("child", "The member host disappeared.");
  const reply = await f.harness.behavior.invokeAgentTool("tavern_release", { memberThreadId: "child", reason: "Finish loss cleanup" }, { threadId: "lead" });
  expect(String(reply)).toContain("its work was not saved: The member host disappeared.");
  expect(f.runtime.placements().store.byMember("child")!.phase).toBe("released");
  expect(runtimeFixture(f.k.store, "child").released).toBeTruthy();
});
it("reports saved source and unknown artifacts on loss in the Keeper reply and placement surface", async () => {
  const f = await fixture(); f.save.mockRestore(); registerTools(f.bb, f.runtime);
  const store = f.runtime.placements().store;
  store.update("placement", 1, record => ({ ...record, preservation: { ...record.preservation, source: "saved", artifacts: "pending" } }));
  f.runtime.placements().preserve.observeLoss("child", "The member host disappeared.");
  const reply = await f.harness.behavior.invokeAgentTool("tavern_release", { memberThreadId: "child", reason: "Finish loss cleanup" }, { threadId: "lead" });
  expect(String(reply)).toContain("its source was saved; declared artifacts are unknown");
  expect(String(reply)).not.toContain("work was not saved");
  expect(String(reply).match(/declared artifacts are unknown/gi)).toHaveLength(1);
  expect(store.byMember("child")).toMatchObject({ phase: "released", preservation: { source: "saved", artifacts: "unknown" } });
  expect(f.runtime.placements().controller.view(store.byMember("child")!)).toMatchObject({ preservation: "saved", preservationReason: expect.stringContaining("Declared artifacts are unknown") });
  expect(runtimeFixture(f.k.store, "child").released).toBeTruthy();
});
it("releases a lost host without waiting for a remote stop that cannot succeed", async () => {
  const f = await fixture(); f.save.mockRestore();
  f.stop.mockRejectedValue(new Error("The member host is gone"));
  f.runtime.placements().preserve.observeLoss("child", "The member host disappeared.");
  expect(await f.runtime.release("lead", "child", "Finish loss cleanup")).toBe(true);
  expect(f.stop).not.toHaveBeenCalled(); expect(f.archive).toHaveBeenCalledOnce();
});
it("completes quest stop after lost-owner cleanup even when the old turn could not be stopped", async () => {
  const f = await fixture(); f.save.mockRestore();
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: threadId === "child" ? "active" : "idle", archivedAt: f.archived.has(threadId) ? 1 : null }));
  f.stop.mockRejectedValue(new Error("The member host is gone"));
  f.runtime.placements().preserve.observeLoss("child", "The member host disappeared.");
  expect(await f.runtime.stop(f.quest.id, "Finish loss cleanup")).toMatchObject({ phase: "stopped", unconfirmed: 0 });
  expect(f.runtime.placements().store.byMember("child")!.preservation.source).toBe("lost");
});
it("confirms an idle-only preservation hold for an error thread without stopping it", async () => {
  const f = await fixture();
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "error" }));
  const token = f.runtime.away.requestContentHold("child", { operationId: "errored-preserve", idleOnly: true, preservation: true });
  expect(await f.runtime.away.confirmHeld(token)).toMatchObject({ state: "confirmed" });
  expect(f.stop).not.toHaveBeenCalled();
  f.runtime.away.finishContentHold(token);
});
it("does not release a placed member while a background agent is still running", async () => {
  const f = await fixture(); f.save.mockRestore();
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project", status: "error", activeBackgroundAgentCount: threadId === "child" ? 1 : 0 }));
  expect(await f.runtime.stop(f.quest.id, "Stop background work")).toMatchObject({ phase: "stopping" });
  expect(f.runtime.placements().store.byMember("child")!.blocked?.code).toBe("preserve-member-busy");
  expect(f.archive).not.toHaveBeenCalled();
});
it.each(["lost", "unknown", "unpreserved"] as const)("does not erase source=%s when a lost hire is cancelled", async source => {
  const f = await fixture();
  const store = f.runtime.placements().store;
  store.update("placement", 1, record => ({ ...record, preservation: { ...record.preservation, source, reason: "The member owner was lost" } }));
  expect(store.cancel("placement", 1).preservation.source).toBe(source);
});
it("records external thread loss through runtime observation", async () => {
  const f = await fixture();
  f.runtime.updateThread(makeThreadResponse({ id: "child", archivedAt: 1 }));
  expect(f.runtime.placements().store.byMember("child")!.preservation).toMatchObject({ source: "lost", artifacts: "not-declared", liveOwnerThreadId: null });
});

it.each(["not-declared","saved","unpreserved"] as const)("retains artifacts=%s after owner loss",async artifacts=>{
  const f=await fixture(),store=f.runtime.placements().store;
  store.update("placement",1,record=>({...record,preservation:{...record.preservation,source:"saved",artifacts,artifactManifestId:artifacts==="unpreserved"?"manifest":null}}));
  f.runtime.placements().preserve.observeLoss("child","The member host disappeared.");
  expect(store.byMember("child")!.preservation).toMatchObject({source:"saved",artifacts,reason:"The member host disappeared."});
});
