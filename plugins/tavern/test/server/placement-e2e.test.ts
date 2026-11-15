// @vitest-environment node
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostContract } from "../../src/host-contract";
import { createHostPort } from "../../src/host/client";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { createTransport } from "../../src/host/transport";
import { SourceCapture } from "../../src/server/placement/capture";
import { DiscoveryStore } from "../../src/server/placement/discovery-store";
import { SourceDiscovery } from "../../src/server/placement/source-discovery";
import { MIGRATIONS } from "../../src/server/migrations";
import { KeeperStore, type HireIntent } from "../../src/server/keeper/store";
import { matchPlacementRule } from "../../src/server/placement/match";
import { normalizeProviderPlacement } from "../../src/server/placement/normalize";
import { PlacementProvisioner } from "../../src/server/placement/provision";
import { PlacementStore } from "../../src/server/placement/store";
import { SettingsStore } from "../../src/server/settings/store";
import { placementRuleSchema } from "../../src/shared/placement-settings";
import { worktreeProvider } from "./environment-fixture";
import { placementRecord, sourceSnapshot } from "./placement-fixture";

const hosts = new Set<ReturnType<typeof createFakePluginHost>>();
const roots: string[] = [];
afterEach(async () => {
  for (const host of hosts) await host.harness.lifecycle.dispose(); hosts.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function nativeSourceFixture() {
  const root = realpathSync(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "placement-source-"))); roots.push(root);
  const source = join(root, "source"), data = join(root, "native"); mkdirSync(source); mkdirSync(data);
  git(source, "init", "-qb", "main"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "work.txt"), "base\n"); git(source, "add", "-A"); git(source, "commit", "-qm", "base");
  const base = git(source, "rev-parse", "HEAD");
  git(source, "remote", "add", "origin", "https://token:password@example.invalid/team/repo.git?secret=query#fragment");
  git(source, "update-ref", "refs/remotes/origin/main", base); git(source, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(source, "branch", "--set-upstream-to=origin/main");
  writeFileSync(join(source, "work.txt"), "unpushed\n"); git(source, "commit", "-qam", "unpushed source");
  const head = git(source, "rev-parse", "HEAD"), tree = git(source, "rev-parse", "HEAD^{tree}");
  const registry = new HostRegistry(data), transport = createTransport(registry);
  type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
  const environment: Environment = { id: "source-env", projectId: "project", hostId: "source-host", path: source, status: "ready",
    hostLifecycle: "active", lifecycle: { phase: "active", retireAt: null, teardown: null }, isGitRepo: true, isWorktree: false,
    environmentProviderId: "checkout", environmentProviderInstanceKey: null, environmentProviderSelection: null,
    branchName: "main", baseBranch: null, defaultBranch: null, mergeBaseBranch: null, name: "Source", managed: false,
    workspaceProvisionType: "unmanaged", createdAt: 1, updatedAt: 1 };
  const host = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, sdk: {
    threads: { get: async () => makeThreadResponse({ id: "keeper", projectId: "project", environmentId: "source-env" }) },
    environments: { get: async () => environment },
  }, experimental_callHostRpc: async call => {
    expect(call.hostId).toBe("source-host");
    if (call.method === "registerEndpoint") return registry.registerEndpoint(hostContract.registerEndpoint.input.parse(call.input));
    if (call.method === "inspect") return inspectHost(registry, hostContract.inspect.input.parse(call.input), call.signal);
    if (call.method === "worktreeState") return transport.worktreeState(hostContract.worktreeState.input.parse(call.input), call.signal);
    throw new Error("Unexpected source mutation: " + call.method);
  } });
  hosts.add(host);
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join("\n"));
  const port = createHostPort(host.bb), placements = new PlacementStore(db, () => 123);
  const discovery = new SourceDiscovery(host.bb, port, new DiscoveryStore(db)), capture = new SourceCapture(discovery, port, placements);
  return { ...host, source, base, head, tree, placements, discovery, capture };
}

function fixture() {
  const trace: string[] = [];
  const spawn = vi.fn(async () => {
    trace.push("provision");
    const bound = provisioner.bindDispatchedMember("maker-hire", "maker");
    expect(bound.environmentId).toBeNull();
    trace.push("dispatch-bind");
    return makeThreadResponse({ id: "maker", projectId: "project", parentThreadId: "keeper", environmentId: null });
  });
  const host = createFakePluginHost({ pluginId: "tavern", sdk: {
    projects: { get: async () => ({ id: "project", name: "Project", kind: "standard", createdAt: 1, updatedAt: 1,
      gitRemoteUrl: "https://example.com/team/repository.git", sources: [{ id: "source", hostId: "home", projectId: "project",
        type: "local_path", path: "/checkout", isDefault: true, createdAt: 1, updatedAt: 1 }] }) },
    environments: { listProviders: async () => [worktreeProvider({ id: "isolated-checkout", availability: null, machineAvailability: {} })] },
    hosts: { experimental_listProviders: async () => [{ id: "on-demand-compute", displayName: "On-demand compute", description: "A test machine provider",
      icon: "Server", logoUrl: null, pluginId: "test-compute", inputs: null, acceptsEmptyInputs: true, supportsSuspend: true }] },
    threads: { spawn },
  } });
  hosts.add(host);
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join("\n"));
  const settings = new SettingsStore(db), placements = new PlacementStore(db), hires = new KeeperStore(db);
  const provisioner = new PlacementProvisioner(host.bb, placements, hires);
  const rule = placementRuleSchema.parse({ id: "isolated-members", label: "One machine per member", enabled: true,
    match: { projectIds: ["project"], classes: ["smith", "warden"] },
    target: { kind: "provider", environmentProviderId: "isolated-checkout", machine: { type: "new", machineProviderId: "on-demand-compute" }, workspace: "dedicated-machine" },
    consent: { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true },
  });
  settings.update({ revision: 0, patch: { machines: { rules: [rule] } }, why: "Enable isolated member placement" });
  return { ...host, trace, spawn, settings, placements, hires, provisioner, rule };
}

describe("remote placement activation gate — incomplete until every pending phase runs together", () => {
  it("matches a saved rule and provisions through the ordinary SDK selection without a pre-provisioning wait", async () => {
    const f = fixture(), policy = f.settings.placementPolicy();
    const match = matchPlacementRule(policy, { projectId: "project", classId: "smith", questId: "quest", repoRemotes: null,
      keeperPath: null, keeperHome: null, keeperEnvironmentProvider: null });
    if (match.state !== "matched" || policy.state !== "valid") throw new Error("Expected the enabled machine rule");
    f.trace.push("rule");
    const normalized = await normalizeProviderPlacement(f.bb, { rule: match.rule, projectId: "project", keeperHostId: "home", serverHostId: "home",
      substitutions: { "keeper.branch": "feature/unpushed", "member.branch": "tavern/maker", "source.commit": "a".repeat(40), "quest.id": "quest" } });
    expect(normalized).toMatchObject({ ownsNewMachine: true, remote: true, destinationValidationRequired: true });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(f.settings.read().machines).toMatchObject({ maxMakers: 2, maxCheckers: 2 });
    // Source capture itself is a pending phase below; this fixture is not host inspection or transport proof.
    f.placements.saveSnapshot(sourceSnapshot({ source: { hostId: "home", environmentId: "home-env", root: "/checkout" },
      home: { hostId: "home", environmentId: "home-env", root: "/checkout" } }));
    const hire: HireIntent = { classId: "smith", characterId: "juno", projectId: "project", createdAt: 1,
      initialInput: "Implement the requested change, then report declared evidence.", owner: {
        keeperThreadId: "keeper", boardQuestId: "quest", waypointId: "waypoint", errand: false, title: "Implement", displayName: "Juno",
        brief: { outcome: "The change", mode: "make-it-work", doneWhen: "Project checks pass", outOfScope: "No publication",
          context: [], questions: [], timeboxMinutes: null },
      } };
    const record = placementRecord({ id: "maker-placement", hireToken: "maker-hire", allocationKey: "maker-allocation",
      target: normalized.environment, ownsNewMachine: normalized.ownsNewMachine, workspaceKind: normalized.workspaceKind,
      sourceSnapshotId: "snapshot", matchEvidence: match.matchEvidence,
      rule: { id: match.rule.id, settingsRevision: policy.revision,
        definitionDigest: createHash("sha256").update(JSON.stringify(match.rule)).digest("hex"), acceptedConsent: match.rule.consent },
      posture: { ...placementRecord().posture, aggregate: "remote-detection-only", ruleConsentId: match.rule.id },
    });
    f.provisioner.reserve(record, { maxMakers: policy.settings.maxMakers, maxCheckers: policy.settings.maxCheckers }, hire); f.trace.push("reserve");
    expect(f.placements.counts("keeper")).toEqual({ makers: 1, checkers: 0 });
    const member = await f.provisioner.spawn(record.id, 1, { providerId: "test-agent", model: "test-model", permissionMode: "full" });
    expect(f.trace).toEqual(["rule", "reserve", "provision", "dispatch-bind"]);
    expect(member).toMatchObject({ phase: "bootstrapping", memberThreadId: "maker", environmentId: null,
      posture: { aggregate: "remote-detection-only" }, acknowledgedScopeRevision: null });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.harness.inspection.sdk.callsTo("environments.get")).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("threads.storageLocation")).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("hosts.experimental_create")).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
    expect(f.harness.experimental_hostRpcCalls).toEqual([]);
  });

  it("SOURCE — reads the native merge base and pins clean unpushed initial source without modifying the user checkout", async () => {
    const f = nativeSourceFixture(), discovered = await f.discovery.inspect("keeper", "project");
    if (discovered.state !== "known") throw new Error(discovered.message);
    const refs = git(f.source, "show-ref"), config = readFileSync(join(f.source, ".git/config")), index = readFileSync(join(f.source, ".git/index"));
    writeFileSync(join(f.source, "dirty.txt"), "must not commit\n");
    await expect(f.capture.initial(discovered)).rejects.toThrow(/dirty/i);
    expect(readFileSync(join(f.source, "dirty.txt"), "utf8")).toBe("must not commit\n");
    expect(f.placements.snapshot("initial")).toBeNull();
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
    rmSync(join(f.source, "dirty.txt"));
    const snapshot = await f.capture.initial(discovered);
    expect(snapshot).toMatchObject({ purpose: "initial", base: f.base, sourceHead: f.head, tree: f.tree,
      makerThreadId: null, makerSubmissionId: null, journalTarget: null, homeCommit: null,
      fetch: { via: "upstream", remoteName: "origin", remoteUrl: "https://example.invalid/team/repo.git",
        trackingRef: "refs/remotes/origin/main", fetchRef: "refs/heads/main" } });
    expect(f.base).not.toBe(f.head);
    expect(git(f.source, "show-ref")).toBe(refs);
    expect(readFileSync(join(f.source, ".git/config"))).toEqual(config);
    expect(readFileSync(join(f.source, ".git/index"))).toEqual(index);
    expect(readFileSync(join(f.source, "work.txt"), "utf8")).toBe("unpushed\n");
    expect(git(f.source, "status", "--porcelain")).toBe("");
    expect(f.harness.experimental_hostRpcCalls.every(call => ["registerEndpoint", "inspect", "worktreeState"].includes(call.method))).toBe(true);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });
  it.todo("DELIVER — prepare Tavern's marked artifact, retain unmarked files, deliver exact host-bound scope bytes and native env ACK without controller path fallback (Frank native envelope/handlers/entry pending)");
  it.todo("READY — call registered tavern_ready {} through authenticated tool context, resolve the actual provisioned endpoint/model inventory, serialize duplicates, carry initial content, and publish the exact generation/tree without claiming guard arming (controller pending)");
  it.todo("SMITH — run work only after content readiness, then capture the exact submission tree and declared artifacts while quiescent; keep grants and remote detection-only labels (controller source/preservation integration pending)");
  it.todo("CARRY — bring the Smith's unpushed source home, then carry that pinned same-format tree through bounded host transport with cancellation and foreign-change fences (controller transport pending)");
  it.todo("WARDEN — independently match the Warden's own rule, provision a distinct new machine, and bind checks to its carried root rather than the live maker path (controller ready/review integration pending)");
  it.todo("CHECK — run the trusted project check on the Warden's host and accept only the clean pinned tree plus current journal fingerprint, submission, waypoint and assignment (controller review gate pending)");
  it.todo("PRESERVE — save source and declared workspace/thread-storage artifacts before controlled release; failed preservation retains the live owner and blocks stop (controller preservation integration pending)");
  it.todo("STOP — only after preservation, record the terminal stop and release; external loss reports unpreserved/lost/unknown rather than successful retention (controller lifecycle integration pending)");
  it.todo("COMPLETE CHAIN — execute rule → provision → deliver → authenticated ready → Smith work → home/carry → separate Warden/check → preserve → stop through the real controller and official SDK/host harnesses before activating remoteForThread");
});
