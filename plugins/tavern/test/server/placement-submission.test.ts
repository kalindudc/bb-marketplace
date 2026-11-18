// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PlacementDeliveries } from "../../src/server/placement/delivery";
import { scopeForClass } from "../../src/scope/presets";
import { makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { PlacementReady, type PlacementReadyDeps } from "../../src/server/placement/ready";
import * as submission from "../../src/server/placement/submission";
import { sourceSnapshot } from "./placement-fixture";
import { PlacementTransport } from "../../src/server/placement/transport";
import { AwayHolds } from "../../src/server/away/holds";
import { submissionFixture, submissionGit, proveSubmissionStage } from "./placement-e2e-submission";
import { seedQuest } from "./support";
import { setup } from "./runtime-fixture";

const fixtures: Awaited<ReturnType<typeof submissionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
it("pins a quiescent maker's exact dirty tree at home without changing remote labels", proveSubmissionStage, 60_000);
it.each(["sha1", "sha256"] as const)("binds all done entries, reuses unchanged identity and mints a new identity for changed %s work", async format => {
  const f = await submissionFixture(format); fixtures.push(f);
  const first = await f.submissions.capture("maker", "waypoint");
  expect(first.state).toBe("captured"); if (first.state !== "captured") throw new Error("Expected capture");
  expect(first.reviewTarget).toMatchObject({ boardQuestId: "quest", waypointId: "waypoint", makerThreadId: "maker", entryIds: ["00", "01"], snapshotId: first.snapshot.id, expectedTree: first.snapshot.tree, makerSubmissionId: first.snapshot.makerSubmissionId, reviewKey: expect.any(String) });
  expect(first.snapshot.journalTargets).toEqual(first.reviewTarget.journalTargets);
  expect(first.snapshot.journalTarget).toEqual(first.snapshot.journalTargets![0]);
  expect(first.snapshot.journalTargets!.every(target => /^[a-f0-9]{64}$/.test(target.entryFingerprint))).toBe(true);
  expect(first.snapshot).not.toHaveProperty("reviewKey");
  expect(await f.submissions.capture("maker", "waypoint")).toEqual(first);
  writeFileSync(join(f.maker, "tracked"), "Changed maker work\n");
  const second = await f.submissions.capture("maker", "waypoint");
  if (second.state !== "captured") throw new Error("Expected capture");
  expect(second.snapshot.tree).not.toBe(first.snapshot.tree); expect(second.snapshot.id).not.toBe(first.snapshot.id);
  expect(second.reviewTarget.reviewKey).not.toBe(first.reviewTarget.reviewKey);
  expect(f.keepers.runtime("maker").submissionTarget).toEqual(second.reviewTarget);
  expect(submissionGit(f.home, "rev-parse", second.snapshot.homeRef + "^{tree}")).toBe(second.snapshot.tree);
  expect(f.holds.requestContentHold).toHaveBeenCalledWith("maker", expect.objectContaining({ idleOnly: true }));
}, 60_000);
it("retains the original carried source when a maker calls tavern_ready after submission", async () => {
  const f = await submissionFixture(); fixtures.push(f);
  const original = f.placements.captureSnapshot(sourceSnapshot({ id: "initial", fetch: { via: "upstream", remoteName: "origin", remoteUrl: f.home, trackingRef: "refs/remotes/origin/main", fetchRef: "refs/heads/main" }, source: { hostId: "home", environmentId: "home-env", root: f.home }, home: { hostId: "home", environmentId: "home-env", root: f.home } }));
  f.bb.storage.database().prepare("UPDATE tavern_placements SET data=json_set(data,'$.rule.acceptedConsent.remoteDetectionOnly',json('true')) WHERE id=?").run("placement");
  f.placements.update("placement", 1, value => ({ ...value, sourceSnapshotId: original.id, carries: [{ id: "carried", generation: 1, snapshotId: original.id, homeEndpointId: "home", memberEndpointId: "maker", homeSdk: original.home, memberSdk: { hostId: "maker", environmentId: "maker-env", root: f.maker }, branch: "main", holdToken: "held", replacesTree: null, phase: "verified", manifest: { json: "{}", digest: "a".repeat(64) }, head: f.base }] }));
  const bb = { onDispose: f.bb.onDispose, sdk: { threads: f.bb.sdk.threads, environments: f.bb.sdk.environments, hosts: { get: async ({ hostId }: { hostId: string }) => makeHostResponse({ id: hostId, status: "connected" }) } } };
  const template = { ...scopeForClass("smith"), threadId: "maker", issuedAt: 1 };
  const templateDigest = createHash("sha256").update(JSON.stringify(template)).digest("hex");
  const deliveries = new PlacementDeliveries(f.bb.storage.database(), f.placements);
  const delivery = deliveries.prepare("placement", 1, { endpointId: "carry-member", templateDigest,
    scopeFileJson: JSON.stringify({ ...template, bindingTemplate: template, workspaceBinding: { kind: "dedicated-machine", hostId: "maker", environmentId: "maker-env", root: f.maker, placementId: "placement", generation: 1, snapshotId: original.id, expectedTree: original.tree } }) });
  deliveries.acknowledge("placement", 1, delivery.binding, { revision: 1, scopeDigest: delivery.binding.scopeDigest, scopeFile: f.maker + "/scope.json", variables: {} });
  f.registries.get("maker")!.registerEndpoint({ placementId: "placement", generation: 1, endpointId: "carry-member", endpoint: { hostId: "maker", environmentId: "maker-env", root: f.maker }, ownerThreadId: "maker", access: "member-write", workspaceKind: "dedicated-machine", objectFormat: "sha1", allowedRefs: ["refs/heads/main"] });
  const deps = { bb, host: f.port, placements: f.placements, deliveries, scopeForThread: () => ({ template, templateDigest }) } as unknown as PlacementReadyDeps;
  const ready = new PlacementReady(deps), before = await ready.forThread("maker");
  expect(before).toContain("Ready.");
  const result = await f.submissions.capture("maker", "waypoint");
  if (result.state !== "captured") throw new Error("Expected capture");
  expect(f.placements.get("placement")).toMatchObject({ sourceSnapshotId: original.id, submissionSnapshotId: result.snapshot.id });
  expect(await ready.forThread("maker")).toBe(before);
  expect(f.placements.get("placement")!.phase).toBe("running");
}, 60_000);
it.each(["busy", "entry", "import"])("keeps submission and source references unchanged after a held %s failure", async fault => {
  const f = await submissionFixture(); fixtures.push(f);
  const previous = await f.submissions.capture("maker", "waypoint");
  if (previous.state !== "captured") throw new Error("Expected first capture");
  const before = f.placements.get("placement")!;
  writeFileSync(join(f.maker, "tracked"), "A changed tree requiring a new import\n");
  f.state.intercept = method => { if (method === "importCommit") {
    if (fault === "busy") f.state.status = "active";
    else if (fault === "entry") f.entries[0]!.description = "Changed";
    else throw new Error("Import failed");
  } };
  if (fault === "busy") expect(await f.submissions.capture("maker", "waypoint")).toMatchObject({ state: "maker-busy" });
  else await expect(f.submissions.capture("maker", "waypoint")).rejects.toThrow(fault === "entry" ? /journal|entry/ : /Import failed/);
  expect(f.placements.get("placement")).toMatchObject({ sourceSnapshotId: before.sourceSnapshotId, submissionSnapshotId: before.submissionSnapshotId });
  expect(f.keepers.runtime("maker").submissionTarget).toEqual(previous.reviewTarget);
}, 60_000);
it("uses the exported journal fingerprint for every pinned entry", async () => {
  const f = await submissionFixture(); fixtures.push(f);
  const result = await f.submissions.capture("maker", "waypoint");
  if (result.state !== "captured") throw new Error("Expected capture");
  expect(submission).toHaveProperty("journalEntryFingerprint");
  const fingerprint = (submission as unknown as { journalEntryFingerprint(entry: unknown): string }).journalEntryFingerprint;
  expect(result.snapshot.journalTargets!.map(target => target.entryFingerprint)).toEqual(f.entries.map(fingerprint));
});
it("retains submission-only owners and refuses released owner references", async () => {
  const f = await submissionFixture(); fixtures.push(f);
  const result = await f.submissions.capture("maker", "waypoint");
  if (result.state !== "captured") throw new Error("Expected capture");
  const owners = f.placements.snapshotOwners;
  expect(owners.references(result.snapshot.ownerId!)).toEqual(["placement"]);
  expect(() => owners.beginRelease(result.snapshot.ownerId!, 1)).toThrow(/references/);
  f.placements.update("placement", 1, value => ({ ...value, submissionSnapshotId: null }));
  owners.beginRelease(result.snapshot.ownerId!, 1);
  expect(() => f.placements.update("placement", 1, value => ({ ...value, submissionSnapshotId: result.snapshot.id }))).toThrow(/no longer retained/);
});
it("refuses an expired capture capability and another maker submission", async () => {
  const f = await submissionFixture(); fixtures.push(f);
  const result = await f.submissions.capture("maker", "waypoint");
  if (result.state !== "captured") throw new Error("Expected capture");
  f.placements.update("placement", 1, value => ({ ...value, submissionSnapshotId: null }));
  const transport = new PlacementTransport(f.bb, f.port, f.placements), owners = f.placements.snapshotOwners;
  expect(owners.hasSubmissionReadReference("placement", 1, result.snapshot.id)).toBe(false);
  await expect(transport.bringHome("placement", 1, result.snapshot.id)).rejects.toThrow(/read reference/);
  await owners.withSubmissionReadReference("placement", 0, result.snapshot.id, () => {}, async () => {
    await expect(transport.bringHome("placement", 1, result.snapshot.id)).rejects.toThrow(/read reference/);
  });
  const foreign = f.placements.captureSnapshot({ ...result.snapshot, sourceThreadId: "other-maker", makerThreadId: "other-maker", journalTarget: { ...result.snapshot.journalTarget!, makerThreadId: "other-maker" }, journalTargets: undefined });
  await owners.withSubmissionReadReference("placement", 1, foreign.id, () => {}, async () => {
    await expect(transport.bringHome("placement", 1, foreign.id)).rejects.toThrow(/read reference/);
  });
  expect(owners.hasSubmissionReadReference("placement", 1, foreign.id)).toBe(false);
});
it("accepts a content-ready placement before a running phase has been observed", async () => {
  const f = await submissionFixture(); fixtures.push(f);
  f.placements.update("placement", 1, value => ({ ...value, phase: "ready" }));
  expect(await f.submissions.capture("maker", "waypoint")).toMatchObject({ state: "captured" });
}, 60_000);
it("returns maker-busy without requesting a hold or interrupting a working maker", async () => {
  const f = await submissionFixture(); fixtures.push(f); f.state.status = "active";
  expect(await f.submissions.capture("maker", "waypoint")).toEqual({ state: "maker-busy", message: "Waiting for Vale to finish its turn before its work can be checked." });
  expect(f.holds.requestContentHold).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
  expect(f.harness.experimental_hostRpcCalls).toEqual([]);
});
it.each(["active", "activity"])("discards a capture if maker %s changes during snapshotting", async fault => {
  const f = await submissionFixture(); fixtures.push(f);
  f.state.intercept = method => { if (method === "snapshotWorktree") { if (fault === "active") f.state.status = "active"; else f.state.updatedAt++; } };
  expect(await f.submissions.capture("maker", "waypoint")).toMatchObject({ state: "maker-busy" });
  expect(f.keepers.runtime("maker").submissionTarget).toBeUndefined();
  expect(f.harness.experimental_hostRpcCalls.map(call => call.method)).not.toContain("importCommit");
  expect(f.holds.finishContentHold).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled();
});
it.each(["snapshotWorktree", "importCommit"])("cannot publish through a stale placement generation after %s", async stage => {
  const f = await submissionFixture(); fixtures.push(f);
  f.state.intercept = method => { if (method === stage) f.placements.cancel("placement", 1); };
  await expect(f.submissions.capture("maker", "waypoint")).rejects.toThrow(/stale|generation|desired state/i);
  expect(f.keepers.runtime("maker").submissionTarget).toBeUndefined(); expect(f.stop).not.toHaveBeenCalled();
});
it("does not publish a review binding when a done journal entry changes during transport", async () => {
  const f = await submissionFixture(); fixtures.push(f);
  f.state.intercept = method => { if (method === "importCommit") f.entries[0]!.description = "New requirement"; };
  await expect(f.submissions.capture("maker", "waypoint")).rejects.toThrow(/journal|entry|submission/i);
  expect(f.keepers.runtime("maker").submissionTarget).toBeUndefined();
}, 60_000);

it("idle-only hold confirmation and sweep never interrupt a working maker, and acknowledge idle without stop", async () => {
  let status: "active" | "idle" = "active";
  const stop = vi.fn(async () => ({ ok: true as const }));
  const f = setup({ threads: { stop, get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status }), queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) }, events: { list: async () => [] } } });
  const q = await seedQuest(f.k, "lead", "Draft", "Tested draft");
  f.k.bind("child", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Draft", brief: { outcome: "Draft", doneWhen: "Tests pass", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
  f.runtime.spawnBriefDelivered("child");
  const token = f.runtime.away.requestContentHold("child", { operationId: "submission", idleOnly: true });
  expect(await f.runtime.away.confirmHeld(token)).toMatchObject({ state: "pending" });
  await f.runtime.away.sweep(); expect(stop).not.toHaveBeenCalled();
  expect(f.runtime.away.blocked("child")).toBe(true);
  f.runtime.away.finishContentHold(token);
  expect(f.runtime.away.blocked("child")).toBe(false);
  await f.runtime.away.sweep(); expect(stop).not.toHaveBeenCalled();
  const next = f.runtime.away.requestContentHold("child", { operationId: "next-submission", idleOnly: true });
  status = "idle";
  expect(await f.runtime.away.confirmHeld(next)).toMatchObject({ state: "confirmed" });
  f.runtime.away.finishContentHold(next);
  expect(f.runtime.away.blocked("child")).toBe(false);
  expect(stop).not.toHaveBeenCalled();
});
it.each([false, true])("restores a previous resume requirement of %s after the last overlapping idle-only hold", resumeRequired => {
  const f = setup(), holds = new AwayHolds(f.k.store.db);
  const owner = { threadId: "child", keeperThreadId: "keeper", questId: "quest", heldAt: 1, cancelledBrief: null };
  if (resumeRequired) {
    const original = holds.requestContent(owner, "stopped-work");
    holds.finishContent(original);
  }
  const first = holds.requestContent(owner, "submission-1", true), second = holds.requestContent(owner, "submission-2", true);
  holds.finishContent(first); expect(holds.get("child")!.resumeRequired).toBe(true);
  holds.finishContent(second); expect(holds.get("child")).toMatchObject({ resumeRequired, stopPending: false });
});
it("keeps the fresh-brief requirement when an away reason joins an idle-only hold", () => {
  const f = setup(), holds = new AwayHolds(f.k.store.db);
  const owner = { threadId: "child", keeperThreadId: "keeper", questId: "quest", heldAt: 1, cancelledBrief: null };
  const content = holds.requestContent(owner, "submission", true);
  holds.requestAway(owner, "closing-time"); holds.finishAway("closing-time", new Set(["child"]));
  holds.finishContent(content); expect(holds.get("child")!.resumeRequired).toBe(true);
});
