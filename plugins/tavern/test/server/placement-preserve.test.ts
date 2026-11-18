// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keeper } from "../../src/server/keeper/service";
import { TavernRuntime } from "../../src/server/runtime";
import { Registry } from "../../src/server/registry";
import { fakePort, seedQuest } from "./support";
import { preservationFixture, provePreserveStage, proveStopStage } from "./placement-e2e-preserve";
import { PlacementPreservation } from "../../src/server/placement/preserve";
import { hostContract, type HostInput, type HostMethod, type HostOutput } from "../../src/host-contract";

const fixtures: Awaited<ReturnType<typeof preservationFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
it("saves exact source and declared files before archive and native endpoint release", provePreserveStage, 60_000);
it("blocks terminal stop on failed preservation and records external loss honestly", proveStopStage, 60_000);
it.each(["snapshotWorktree", "artifactChunk"] as const)("retains the live owner on %s failure and Retry completes preservation", async method => {
  const f = await preservationFixture(); fixtures.push(f);
  f.state.intercept = stage => { if (stage === method) throw new Error("fixture save refused"); };
  expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "blocked", message: expect.stringContaining("fixture save refused") });
  expect(f.archive).not.toHaveBeenCalled();
  expect(f.placements.byMember("maker")).toMatchObject({ phase: "blocked", blocked: { stage: "preserve", retryable: true }, preservation: { liveOwnerThreadId: "maker" } });
  f.state.intercept = undefined;
  expect(await f.preserve.beforeRelease("maker", "Retry")).toMatchObject({ state: "released" });
  expect(f.archive).toHaveBeenCalledOnce();
}, 60_000);
it.each([true, false])("retains the snapshot host's refusal and retryable=%s without archiving", async retryable => {
  const f = await preservationFixture(); fixtures.push(f);
  const refusal = { outcome: "unavailable", code: "source-changed", message: "The source changed while it was captured; retry when idle.", retryable };
  const call = f.port.call.bind(f.port);
  f.port.call = async <M extends HostMethod>(hostId: string, method: M, input: HostInput<M>, options?: { signal?: AbortSignal }): Promise<HostOutput<M>> => {
    if (method === "snapshotWorktree") return hostContract[method].output.parse(refusal) as HostOutput<M>;
    return call(hostId, method, input, options);
  };
  expect(await f.preserve.beforeRelease("maker", "Release")).toEqual({ state: "blocked", message: refusal.message });
  expect(f.placements.byMember("maker")).toMatchObject({ phase: "blocked", blocked: { stage: "preserve", code: refusal.code, message: refusal.message, retryable }, preservation: { source: "pending", liveOwnerThreadId: "maker" } });
  expect(f.archive).not.toHaveBeenCalled();
});
it("preserves an errored member whose turn has ended", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project", environmentId: threadId === "maker" ? "maker-env" : "home-env", status: threadId === "maker" ? "error" : "idle", updatedAt: f.state.updatedAt, archivedAt: threadId === "maker" && f.releaseState.archived ? 100 : null }));
  expect(await f.preserve.beforeRelease("maker", "Release failed turn")).toMatchObject({ state: "released" });
  expect(f.placements.byMember("maker")!.preservation.source).toBe("saved");
  expect(f.archive).toHaveBeenCalledOnce();
});
it("copies thread-storage artifacts when no member environment ever attached", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  f.placements.update("placement", 1, value => ({ ...value, hostId: null, environmentId: null, root: null }));
  for (const entry of f.entries) entry.evidence = entry.evidence.filter(item => item.ref.startsWith(f.storage + "/"));
  f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project", environmentId: threadId === "maker" ? null : "home-env", status: threadId === "maker" ? "error" : "idle", archivedAt: threadId === "maker" && f.releaseState.archived ? 100 : null }));
  expect(await f.preserve.beforeRelease("maker", "Quest stop")).toMatchObject({ state: "released" });
  const record = f.placements.byMember("maker")!;
  expect(record.preservation).toMatchObject({ source: "not-needed", artifacts: "saved", reason: "never provisioned" });
  expect(f.preserve.manifest(record.preservation.artifactManifestId!)!.saved).toHaveLength(1);
  expect(f.harness.experimental_hostRpcCalls.some(call => call.hostId === "maker")).toBe(false);
});
it("finishes a quest stop when its failed member never received an environment", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  f.placements.update("placement", 1, value => ({ ...value, hostId: null, environmentId: null, root: null }));
  for (const entry of f.entries) entry.evidence = entry.evidence.filter(item => item.ref.startsWith(f.storage + "/"));
  f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project", environmentId: threadId === "maker" ? null : "home-env", status: threadId === "maker" ? "error" : "idle", archivedAt: threadId === "maker" && f.releaseState.archived ? 100 : null }));
  const port = { ...fakePort(), prepare: f.journal.prepare, get: (threadId: string) => ({ ...fakePort().get(threadId), entries: f.entries }) };
  const keeper = new Keeper(f.keepers, port, () => 1_000_000);
  keeper.bind("keeper", "keeper", "wren", "project");
  const quest = await seedQuest(keeper, "keeper", "Failed machine", "Save declared evidence");
  keeper.store.put("quests", "quest", { ...quest, id: "quest" }); keeper.store.remove("quests", quest.id);
  const runtime = new TavernRuntime(f.bb, keeper, new Registry(fileURLToPath(new URL("../../", import.meta.url)), "/nonexistent"));
  expect(await runtime.stop("quest", "Stop failed machine")).toEqual({ phase: "stopped", unconfirmed: 0 });
  expect(f.placements.byMember("maker")).toMatchObject({ phase: "released", preservation: { source: "not-needed", artifacts: "saved", reason: "never provisioned" } });
  expect(f.archive).toHaveBeenCalledOnce();
});
it("blocks transient artifact inspection failures instead of treating them as missing files", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  f.state.intercept = method => { if (method === "inspectArtifacts") throw new Error("artifact host disconnected"); };
  expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "blocked", message: expect.stringContaining("artifact host disconnected") });
  expect(f.archive).not.toHaveBeenCalled();
  expect(f.placements.byMember("maker")!.blocked?.retryable).toBe(true);
});
it.each([false, true])("reconciles a lost owner terminally with native archive already done=%s", async archived => {
  const f = await preservationFixture(); fixtures.push(f);
  f.state.intercept = method => { if (method === "artifactChunk") throw new Error("copy interrupted"); };
  expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "blocked" });
  f.state.intercept = method => { if (method === "releaseEndpoint") throw new Error("home cleanup disconnected"); };
  f.releaseState.archived = archived;
  f.preserve.observeLoss("maker", "The member host disappeared.");
  expect(await f.preserve.beforeRelease("maker", "Finish loss cleanup")).toMatchObject({ state: "lost", message: expect.stringContaining("host disappeared") });
  const record = f.placements.byMember("maker")!;
  expect(record).toMatchObject({ phase: "released", preservation: { source: "saved", artifacts: "unknown", liveOwnerThreadId: null, reason: expect.stringContaining("home cleanup disconnected") } });
  expect(f.placements.counts("keeper").makers).toBe(0);
  expect(f.archive).toHaveBeenCalledTimes(archived ? 0 : 1);
});
it("keeps a source already saved at home when its owner is lost during artifact copying", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  f.state.intercept = method => { if (method === "artifactChunk") throw new Error("copy interrupted"); };
  expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "blocked" });
  const snapshotId = f.placements.byMember("maker")!.preservation.snapshotId;
  expect(f.placements.snapshot(snapshotId!)!.homeCommit).toBeTruthy();
  f.preserve.observeLoss("maker", "The member host disappeared.");
  expect(f.placements.byMember("maker")!.preservation).toMatchObject({ source: "saved", artifacts: "unknown", snapshotId });
  f.state.intercept = undefined;
  expect(await f.preserve.beforeRelease("maker", "Finish loss cleanup")).toMatchObject({ state: "lost" });
  expect(f.placements.byMember("maker")).toMatchObject({ phase: "released", preservation: { source: "saved", artifacts: "unknown", snapshotId } });
  expect(f.placements.counts("keeper").makers).toBe(0);
  const event = f.keepers.events("keeper").find(event => event.type === "member.work-lost")!;
  expect(event.text).toContain("its source was saved; declared artifacts are unknown");
  expect(event.text).not.toContain("work was not saved");
  expect(event.text.match(/declared artifacts are unknown/gi)).toHaveLength(1);
  expect(await f.preserve.beforeRelease("maker", "Retry")).toMatchObject({ state: "lost" });
  expect(f.archive).toHaveBeenCalledOnce();
});
it("waits visibly without interrupting a working member", async () => {
  const f = await preservationFixture(); fixtures.push(f); f.state.status = "active";
  expect(await f.preserve.beforeRelease("maker", "Release")).toEqual({ state: "waiting", message: "Waiting for Vale to finish its turn so its work can be saved." });
  expect(f.archive).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
  expect(f.holds.requestContentHold).not.toHaveBeenCalled();
});
it("lists outside and missing evidence as not preserved and releases the member", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  f.entries[0]!.evidence.push({ kind: "file", ref: "/outside/report.txt", detail: "", exitCode: null }, { kind: "file", ref: "missing.txt", detail: "", exitCode: null });
  expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "released" });
  const manifest = f.preserve.manifest(f.placements.byMember("maker")!.preservation.artifactManifestId!);
  expect(manifest!.notPreserved.join("\n")).toMatch(/outside.*allowed|outside.*root/i);
  expect(manifest!.notPreserved.join("\n")).toContain("missing");
  expect(f.archive).toHaveBeenCalledOnce();
  expect(f.placements.byMember("maker")!.preservation.reason).toContain("missing");
});
it("does not retransfer an unchanged pinned submission", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  const submitted = await f.submissions.capture("maker", "waypoint"); if (submitted.state !== "captured") throw new Error("Expected submission");
  const imports = () => f.harness.experimental_hostRpcCalls.filter(call => call.method === "importCommit").length;
  const before = imports();
  expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "released" });
  expect(imports()).toBe(before);
});
it("does not publish preservation after a stale generation", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  f.state.intercept = method => { if (method === "snapshotWorktree") f.placements.cancel("placement", 1); };
  expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "blocked" });
  expect(f.archive).not.toHaveBeenCalled(); expect(f.placements.byMember("maker")!.preservation.source).not.toBe("saved");
});
it("saves a cancelled placement under its current fenced generation", async () => {
  const f = await preservationFixture(); fixtures.push(f); f.placements.cancel("placement", 1);
  expect(await f.preserve.beforeRelease("maker", "Cancelled hire")).toMatchObject({ state: "released" });
  expect(f.placements.byMember("maker")!.phase).toBe("released");
}, 60_000);
it("reconciles cleanup failure without reading a destroyed source again", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  f.state.intercept = method => { if (method === "releaseEndpoint") throw new Error("cleanup refused"); };
  expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "blocked", message: expect.stringContaining("cleanup refused") });
  const snapshots = f.harness.experimental_hostRpcCalls.filter(call => call.method === "snapshotWorktree").length;
  f.state.intercept = undefined;
  expect(await f.preserve.beforeRelease("maker", "Retry cleanup")).toMatchObject({ state: "released" });
  expect(f.harness.experimental_hostRpcCalls.filter(call => call.method === "snapshotWorktree")).toHaveLength(snapshots);
});
it("invalidates a saved tree if a fresh turn starts before archive and recaptures on Retry", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  let resume = true;
  f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
    const live = f.placements.byMember("maker")!;
    if (resume && threadId === "maker" && live.phase === "releasing") { f.state.status = "active"; writeFileSync(join(f.maker, "tracked"), "new turn\n"); }
    return makeThreadResponse({ id: threadId, projectId: "project", environmentId: threadId === "maker" ? "maker-env" : "home-env", status: threadId === "maker" ? f.state.status : "idle", updatedAt: f.state.updatedAt, archivedAt: threadId === "maker" && f.releaseState.archived ? 100 : null });
  });
  expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "waiting" });
  expect(f.archive).not.toHaveBeenCalled();
  expect(f.placements.byMember("maker")).toMatchObject({ preservation: { source: "pending", liveOwnerThreadId: "maker" } });
  resume = false; f.state.status = "idle";
  expect(await f.preserve.beforeRelease("maker", "Retry")).toMatchObject({ state: "released" });
  const snapshot = f.placements.snapshot(f.placements.byMember("maker")!.preservation.snapshotId!)!;
  expect(snapshot.tree).not.toBeNull();
  const { submissionGit } = await import("./placement-e2e-submission");
  expect(submissionGit(f.home, "show", snapshot.homeRef + ":tracked")).toBe("new turn");
}, 60_000);
it.each(["running", "released"] as const)("releases a never-provisioned member from desired state %s", async desiredState => {
  const f = await preservationFixture(); fixtures.push(f);
  f.placements.update("placement", 1, value => ({ ...value, hostId: null, environmentId: null, root: null }));
  if (desiredState === "released") f.placements.cancel("placement", 1);
  for (const entry of f.entries) entry.evidence = [];
  f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project", environmentId: threadId === "maker" ? null : "home-env", status: "idle", archivedAt: threadId === "maker" && f.releaseState.archived ? 100 : null }));
  expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "released" });
  expect(f.placements.byMember("maker")!.preservation).toMatchObject({ source: "not-needed", artifacts: "not-declared", reason: "never provisioned", liveOwnerThreadId: null });
  expect(f.archive).toHaveBeenCalledOnce();
  expect(f.harness.experimental_hostRpcCalls.some(call => call.hostId === "maker")).toBe(false);
});
it("observes generic environment loss even before the lazy preservation service is used", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  PlacementPreservation.observe(f.bb, () => ({ store: f.placements, preserve: f.preserve }));
  await f.harness.behavior.emitThreadEvent("experimental_environment.removed", { removal: { environmentId: "maker-env", hostId: "maker", path: f.maker, providerOwnedPath: true, removedAt: 1 } });
  expect(f.placements.byMember("maker")!.preservation).toMatchObject({ source: "lost", artifacts: "not-declared", liveOwnerThreadId: null });
});
it("keeps an unconfirmed Tavern stop visible and never snapshots it", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  f.keepers.put("members", "maker", { ...f.keepers.get("members", "maker")!, stopPending: true });
  expect(await f.preserve.beforeRelease("maker", "Quest stop")).toMatchObject({ state: "waiting", message: expect.stringContaining("Stop unconfirmed") });
  expect(f.harness.experimental_hostRpcCalls).toEqual([]); expect(f.archive).not.toHaveBeenCalled();
});
it("leaves unplaced members untouched", async () => {
  const f = await preservationFixture(); fixtures.push(f);
  expect(await f.preserve.beforeRelease("unplaced", "Release")).toEqual({ state: "unplaced" });
  expect(f.archive).not.toHaveBeenCalled(); expect(f.holds.requestContentHold).not.toHaveBeenCalled();
});
