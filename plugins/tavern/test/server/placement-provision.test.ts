// @vitest-environment node
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { KeeperStore, type HireIntent } from "../../src/server/keeper/store";
import { PlacementProvisioner } from "../../src/server/placement/provision";
import { PlacementStore } from "../../src/server/placement/store";
import { placementRecord, sourceSnapshot } from "./placement-fixture";

const hosts = new Set<ReturnType<typeof createFakePluginHost>>();
afterEach(async () => { for (const host of hosts) await host.harness.lifecycle.dispose(); hosts.clear(); });
const caps = { maxMakers: 2, maxCheckers: 2 };
const execution = { providerId: "test-agent", model: "test-model", permissionMode: "full" as const };
const intent = (): HireIntent => ({ classId: "smith", characterId: "juno", projectId: "project", createdAt: 1,
  initialInput: "Build the requested change.", owner: { keeperThreadId: "keeper", boardQuestId: "quest", waypointId: "waypoint",
    errand: false, title: "Build", displayName: "Juno", brief: { outcome: "A change", mode: "make-it-work", doneWhen: "Tests pass",
      outOfScope: "No deployment", context: [], questions: [], timeboxMinutes: null } } });
function fixture() {
  const spawn = vi.fn(async () => makeThreadResponse({ id: "child", projectId: "project", parentThreadId: "keeper" }));
  const host = createFakePluginHost({ pluginId: "tavern", sdk: { threads: { spawn } } }); hosts.add(host);
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join("\n"));
  const placements = new PlacementStore(db, () => 2), hires = new KeeperStore(db);
  placements.saveSnapshot(sourceSnapshot());
  const record = placementRecord({ target: { type: "provider", environmentProviderId: "vendor-checkout", inputs: null,
    machine: { type: "new", machineProviderId: "vendor-machine", inputs: null } }, ownsNewMachine: true,
    sourceSnapshotId: "snapshot", workspaceKind: "dedicated-machine", rule: {
      id: "separate", settingsRevision: 1, definitionDigest: "b".repeat(64),
      acceptedConsent: { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true },
    } });
  const provisioner = new PlacementProvisioner(host.bb, placements, hires);
  const reserve = () => provisioner.reserve(record, caps, intent());
  return { ...host, spawn, db, placements, hires, provisioner, record, reserve };
}

describe("dormant private placement provisioning", () => {
  it("reserves placement and hire atomically, without any SDK call or machine allocation", () => {
    const f = fixture();
    expect(f.reserve()).toMatchObject({ id: "placement", phase: "reserved", generation: 1 });
    expect(f.hires.get("hires", "hire")).toEqual(intent());
    expect(f.placements.counts("keeper")).toEqual({ makers: 1, checkers: 0 });
    expect(f.harness.inspection.sdk.calls).toEqual([]);
  });

  it("rolls back a private placement if its hire intent cannot be reserved", () => {
    const f = fixture(); f.hires.put("hires", "hire", { ...intent(), classId: "warden" });
    expect(() => f.reserve()).toThrow(/hire token|intent/i);
    expect(f.placements.get("placement")).toBeNull();
    expect(f.placements.counts("keeper")).toEqual({ makers: 0, checkers: 0 });
  });

  it("does not consume staffing capacity or overwrite an intent when the machine slot is full", () => {
    const f = fixture();
    f.placements.reserve(placementRecord({ id: "first", hireToken: "first" }), caps);
    f.placements.reserve(placementRecord({ id: "second", hireToken: "second" }), caps);
    expect(() => f.reserve()).toThrow(/capacity/);
    expect(f.hires.get("hires", "hire")).toBeNull();
    expect(f.placements.get("placement")).toBeNull();
  });

  it.each(["keeper", "project", "class", "quest"])("rejects placement/intent %s mismatch before any resource call", kind => {
    const f = fixture(), hire = intent();
    if (kind === "keeper") hire.owner.keeperThreadId = "other";
    if (kind === "project") hire.projectId = "other";
    if (kind === "class") hire.classId = "warden";
    if (kind === "quest") hire.owner.boardQuestId = "other";
    expect(() => f.provisioner.reserve(f.record, caps, hire)).toThrow(/intent|placement/i);
    expect(f.harness.inspection.sdk.calls).toEqual([]);
  });

  it("requires real initial source provenance rather than inventing a maker submission", () => {
    const f = fixture(); f.record.sourceSnapshotId = "missing";
    expect(() => f.reserve()).toThrow(/snapshot|source/i);
    expect(f.placements.get("placement")).toBeNull();
  });

  it("refuses a snapshot from a different Keeper or project", () => {
    const f = fixture();
    f.placements.saveSnapshot(sourceSnapshot({ id: "foreign", keeperThreadId: "other" })); f.record.sourceSnapshotId = "foreign";
    expect(() => f.reserve()).toThrow(/snapshot|source/i);
  });

  it("persists provisioning before core's initial dispatch, then binds the child without waiting for an environment", async () => {
    const f = fixture(); f.reserve();
    f.spawn.mockImplementationOnce(async () => {
      expect(f.placements.get("placement")).toMatchObject({ phase: "provisioning", memberThreadId: null });
      const bound = f.provisioner.bindDispatchedMember("hire", "child");
      expect(bound).toMatchObject({ phase: "bootstrapping", memberThreadId: "child", environmentId: null });
      return makeThreadResponse({ id: "child", projectId: "project", parentThreadId: "keeper", environmentId: null });
    });
    expect(await f.provisioner.spawn("placement", 1, execution)).toMatchObject({ memberThreadId: "child", phase: "bootstrapping" });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.harness.inspection.sdk.callsTo("environments.get")).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("threads.storageLocation")).toEqual([]);
    expect(f.hires.get("hires", "hire")?.memberThreadId).toBe("child");
  });

  it("uses the reserved SDK selection and first-turn ready instruction, without claiming destination model verification", async () => {
    const f = fixture(); f.reserve(); await f.provisioner.spawn("placement", 1, execution);
    const call = f.harness.inspection.sdk.callsTo("threads.spawn")[0]!;
    expect(call[0]).toMatchObject({ projectId: "project", parentThreadId: "keeper", parentNotifications: "off",
      environment: f.record.target, pluginSubmission: { pluginId: "tavern", data: { hireToken: "hire" } },
      pluginMetadata: { hireToken: "hire" }, ...execution, origin: "plugin", originPluginId: "tavern",
      input: [{ type: "text", text: expect.stringMatching(/^Call tavern_ready \{\} before substantive work\./), visibility: "agent-only" }],
    });
    expect(f.placements.get("placement")?.phase).not.toBe("ready");
  });

  it("coalesces concurrent duplicate spawn calls rather than allocating twice", async () => {
    const f = fixture(); f.reserve();
    let finish!: (value: ReturnType<typeof makeThreadResponse>) => void;
    f.spawn.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.provisioner.spawn("placement", 1, execution);
    const second = f.provisioner.spawn("placement", 1, execution);
    finish(makeThreadResponse({ id: "child", projectId: "project", parentThreadId: "keeper" }));
    expect(await first).toEqual(await second); expect(f.spawn).toHaveBeenCalledOnce();
  });

  it("does not spawn again after a successful bind, even through a fresh controller instance", async () => {
    const f = fixture(); f.reserve(); await f.provisioner.spawn("placement", 1, execution);
    const restarted = new PlacementProvisioner(f.bb, f.placements, f.hires);
    expect(await restarted.spawn("placement", 1, execution)).toMatchObject({ memberThreadId: "child" });
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it("retains an ambiguous allocation outcome across restart and never blindly retries core spawn", async () => {
    const f = fixture(); f.reserve(); f.spawn.mockRejectedValueOnce(new Error("Connection closed after request"));
    await expect(f.provisioner.spawn("placement", 1, execution)).rejects.toThrow("Connection closed after request");
    expect(f.placements.get("placement")).toMatchObject({ phase: "blocked", blocked: { stage: "provision", code: "spawn-outcome-unknown", retryable: false } });
    const restarted = new PlacementProvisioner(f.bb, f.placements, f.hires);
    await expect(restarted.spawn("placement", 1, execution)).rejects.toThrow(/reconcile|unknown/i);
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.placements.counts("keeper").makers).toBe(1);
  });

  it("treats a persisted in-flight phase after restart as ambiguous, not permission to allocate again", async () => {
    const f = fixture(); f.reserve(); f.placements.update("placement", 1, record => ({ ...record, phase: "provisioning" }));
    await expect(f.provisioner.spawn("placement", 1, execution)).rejects.toThrow(/reconcile|unknown/i);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("keeps the core refusal message visible and retains its reservation for resource reconciliation", async () => {
    const f = fixture(); f.reserve(); f.spawn.mockRejectedValueOnce(Object.assign(new Error("Vendor pool has no capacity"), { status: 409 }));
    await expect(f.provisioner.spawn("placement", 1, execution)).rejects.toThrow("Vendor pool has no capacity");
    expect(f.placements.get("placement")).toMatchObject({ phase: "blocked", blocked: { code: "spawn-refused", message: expect.stringContaining("Vendor pool has no capacity") } });
    expect(f.hires.get("hires", "hire")).not.toBeNull();
  });

  it("recovers a dispatch-bound child even when the spawn response was lost", async () => {
    const f = fixture(); f.reserve();
    f.spawn.mockImplementationOnce(async () => { f.provisioner.bindDispatchedMember("hire", "child"); throw new Error("Reply lost"); });
    expect(await f.provisioner.spawn("placement", 1, execution)).toMatchObject({ phase: "bootstrapping", memberThreadId: "child" });
  });

  it("does not downgrade an authenticated child that finished readiness before the spawn response arrived", async () => {
    const f = fixture(); f.reserve();
    f.spawn.mockImplementationOnce(async () => {
      f.provisioner.bindDispatchedMember("hire", "child");
      f.placements.update("placement", 1, record => ({ ...record, phase: "ready" }));
      return makeThreadResponse({ id: "child", projectId: "project", parentThreadId: "keeper" });
    });
    expect(await f.provisioner.spawn("placement", 1, execution)).toMatchObject({ phase: "ready", memberThreadId: "child" });
    expect(f.placements.get("placement")?.phase).toBe("ready");
  });

  it("keeps independent new-machine selections for a maker and its separately placed checker", async () => {
    const f = fixture(); f.reserve(); await f.provisioner.spawn("placement", 1, execution);
    const journal = { boardQuestId: "quest", waypointId: "waypoint", makerThreadId: "child", journalEntryId: "00",
      entryFingerprint: "c".repeat(64), reviewAssignmentId: "review" };
    const snapshot = sourceSnapshot({ id: "submission", purpose: "submission", sourceThreadId: "child", makerThreadId: "child",
      makerSubmissionId: "submitted", journalTarget: journal });
    f.placements.saveSnapshot(snapshot); f.placements.pinSnapshot(snapshot.id, snapshot.sourceHead, snapshot.tree, snapshot.objectFormat);
    const checker = { ...f.record, id: "checker", hireToken: "checker-hire", allocationKey: "checker-allocation", classId: "warden", slot: "checker" as const,
      sourceSnapshotId: snapshot.id, reviewTarget: { makerThreadId: "child", makerSubmissionId: "submitted", snapshotId: snapshot.id,
        expectedTree: snapshot.tree, journal }, target: { type: "provider", environmentProviderId: "checker-checkout", inputs: null,
        machine: { type: "new", machineProviderId: "checker-compute", inputs: null } } };
    f.provisioner.reserve(checker, caps, { ...intent(), classId: "warden" });
    f.spawn.mockResolvedValueOnce(makeThreadResponse({ id: "warden", projectId: "project", parentThreadId: "keeper" }));
    expect(await f.provisioner.spawn("checker", 1, execution)).toMatchObject({ memberThreadId: "warden", slot: "checker" });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn").map(call => (call[0] as { environment: unknown }).environment))
      .toEqual([f.record.target, checker.target]);
    expect(f.placements.counts("keeper")).toEqual({ makers: 1, checkers: 1 });
  });

  it("keeps a late child as a live preservation owner after cancellation without resurrecting ready", async () => {
    const f = fixture(); f.reserve();
    f.spawn.mockImplementationOnce(async () => {
      f.placements.cancel("placement", 1);
      return makeThreadResponse({ id: "late-child", projectId: "project", parentThreadId: "keeper" });
    });
    await expect(f.provisioner.spawn("placement", 1, execution)).rejects.toThrow(/stale|cancel/i);
    expect(f.placements.get("placement")).toMatchObject({ generation: 2, desiredState: "released", phase: "preserving",
      memberThreadId: "late-child", preservation: { liveOwnerThreadId: "late-child", source: "pending", stopConfirmed: false } });
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
  });

  it("does not start an already cancelled or stale generation", async () => {
    const f = fixture(); f.reserve(); f.placements.cancel("placement", 1);
    await expect(f.provisioner.spawn("placement", 1, execution)).rejects.toThrow(/stale/i);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("refuses two private placements claiming the same member", () => {
    const f = fixture(); f.reserve();
    f.placements.update("placement", 1, record => ({ ...record, phase: "provisioning" }));
    f.provisioner.bindDispatchedMember("hire", "child");
    f.provisioner.reserve({ ...f.record, id: "second", hireToken: "second", allocationKey: "second" }, caps, intent());
    f.placements.update("second", 1, record => ({ ...record, phase: "provisioning" }));
    expect(() => f.provisioner.bindDispatchedMember("second", "child")).toThrow(/member|assignment/i);
    expect(f.placements.byMember("child")?.id).toBe("placement");
  });

  it("refuses duplicate member identity already present in private storage rather than selecting the first row", () => {
    const f = fixture(); f.reserve();
    f.placements.update("placement", 1, record => ({ ...record, memberThreadId: "child" }));
    const forged = { ...f.record, id: "duplicate", hireToken: "duplicate", memberThreadId: "child" };
    f.db.prepare("INSERT INTO tavern_placements(id,data) VALUES(?,?)").run(forged.id, JSON.stringify(forged));
    expect(() => f.placements.byMember("child")).toThrow(/multiple.*assignment/i);
  });

  it("fails closed for an unknown hire token or replacement child on an existing assignment", () => {
    const f = fixture(); f.reserve();
    f.placements.update("placement", 1, record => ({ ...record, phase: "provisioning" }));
    f.provisioner.bindDispatchedMember("hire", "child");
    expect(() => f.provisioner.bindDispatchedMember("missing", "child")).toThrow(/placement|hire/i);
    expect(() => f.provisioner.bindDispatchedMember("hire", "replacement")).toThrow(/member|binding/i);
  });
});
