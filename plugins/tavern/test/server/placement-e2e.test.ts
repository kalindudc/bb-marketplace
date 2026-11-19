// @vitest-environment node
import { deliverGate, readyGate } from "./placement-e2e-ready";
import { createFakePluginHost, makeThreadResponse, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fileURLToPath } from "node:url";
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
import { snapshotWorktree } from "../../src/host/snapshot";
import { proveSubmissionStage } from "./placement-e2e-submission";
import { proveCarryStage, proveWardenStage, proveCheckStage, proveCompleteChain } from "./placement-e2e-review";
import { provePreserveStage, proveStopStage } from "./placement-e2e-preserve";
import { placementRecord } from "./placement-fixture";
import { SourceCapture } from "../../src/server/placement/capture";
import { PlacementTransport } from "../../src/server/placement/transport";
import { DiscoveryStore } from "../../src/server/placement/discovery-store";
import { SourceDiscovery } from "../../src/server/placement/source-discovery";
import { MIGRATIONS } from "../../src/server/migrations";
import { KeeperStore } from "../../src/server/keeper/store";
import { Keeper } from "../../src/server/keeper/service";
import { TavernRuntime } from "../../src/server/runtime";
import { Registry } from "../../src/server/registry";
import { InsightsReader } from "../../src/server/insights";
import { providerSdk } from "./provider-fixture";
import { fakePort, planInput, seedQuest } from "./support";
import { PlacementStore } from "../../src/server/placement/store";
import { SettingsStore } from "../../src/server/settings/store";
import { placementRuleSchema } from "../../src/shared/placement-settings";
import { worktreeProvider } from "./environment-fixture";

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
    if (call.method === "snapshotWorktree") return snapshotWorktree(registry, hostContract.snapshotWorktree.input.parse(call.input), call.signal);
    if (call.method === "registerTransfer") return registry.registerTransfer(hostContract.registerTransfer.input.parse(call.input));
    if (call.method in transport) return (transport[call.method as keyof typeof transport] as (input: unknown, signal?: AbortSignal) => Promise<unknown>)(call.input, call.signal);
    throw new Error("Unexpected source mutation: " + call.method);
  } });
  hosts.add(host);
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join("\n"));
  const port = createHostPort(host.bb), placements = new PlacementStore(db, () => 123);
  const discovery = new SourceDiscovery(host.bb, port, new DiscoveryStore(db)), capture = new SourceCapture(discovery, port, placements);
  return { ...host, source, base, head, tree, placements, discovery, capture };
}

async function fixture() {
  const f = nativeSourceFixture(), trace: string[] = [];
  const db = f.bb.storage.database(), k = new Keeper(new KeeperStore(db), fakePort(), () => 1_000_000);
  const runtime = new TavernRuntime(f.bb, k, new Registry(fileURLToPath(new URL("../../", import.meta.url)), "/nonexistent"));
  const settings = new SettingsStore(db);
  runtime.enableSettings(settings, new InsightsReader(db, settings));
  k.bind("keeper", "keeper", "wren", "project");
  f.harness.sdk.stub("system.config", async () => ({ primaryHostId: "source-host" }));
  f.harness.sdk.stub("projects.get", async () => ({ id: "project", name: "Project", kind: "standard", createdAt: 1, updatedAt: 1,
    gitRemoteUrl: "https://example.invalid/team/repo.git", sources: [{ id: "source", hostId: "source-host", projectId: "project",
      type: "local_path", path: f.source, isDefault: true, createdAt: 1, updatedAt: 1 }] }));
  f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project", providerId: "pi",
    parentThreadId: threadId === "keeper" ? null : "keeper", environmentId: threadId === "keeper" ? "source-env" : null }));
  f.harness.sdk.stub("threads.defaultExecutionOptions", async () => null);
  f.harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  f.harness.sdk.stub("providers.list", providerSdk().list);
  f.harness.sdk.stub("providers.models", providerSdk().models);
  f.harness.sdk.stub("environments.listProviders", async () => [worktreeProvider({ id: "isolated-checkout", displayName: "Isolated checkout", availability: null,
    inputs: { type: "object", properties: { base: { type: "string" }, branch: { type: "string" } }, required: ["base", "branch"] }, acceptsEmptyInputs: false })]);
  f.harness.sdk.stub("hosts.get", async ({ hostId }: { hostId: string }) => ({ id: hostId, name: "Source host" }));
  f.harness.sdk.stub("hosts.experimental_listProviders", async () => [{ id: "on-demand-compute", displayName: "On-demand compute", description: "A test machine provider",
    icon: "Server", logoUrl: null, pluginId: "test-compute", inputs: null, acceptsEmptyInputs: true, supportsSuspend: true }]);
  const rule = placementRuleSchema.parse({ id: "isolated-members", label: "One machine per member", enabled: true,
    match: { projectIds: ["project"], classes: ["smith", "warden"] },
    target: { kind: "provider", environmentProviderId: "isolated-checkout", inputs: { base: "{source.base}", branch: "{member.branch}" },
      machine: { type: "new", machineProviderId: "on-demand-compute" }, workspace: "dedicated-machine" },
    consent: { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true } });
  settings.update({ revision: 0, patch: { machines: { rules: [rule] } }, why: "Enable isolated member placement" });
  const quest = await seedQuest(k, "keeper", "Implement", "IMP");
  k.plan("keeper", { ...planInput(quest.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
  const ask = k.asks("keeper").find(ask => ask.kind === "greenlight" && ask.state === "open")!;
  k.answerAsk(ask.id, "approve", null, "page", "user");
  runtime.enableScopes({ dataDir: join(f.source, "../scopes"), installGuard: false });
  const spawn = vi.fn(async (args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) => {
    trace.push("provision");
    const member = makeThreadResponse({ id: "maker", projectId: "project", parentThreadId: "keeper", environmentId: null, providerId: args.providerId, status: "pending" });
    const context = makeMessageDispatchHookContext({
      thread: member, project: { id: "project" }, originPluginId: "tavern", attempt: "start-turn", initiator: "agent",
      experimental_submission: { pluginId: "tavern", data: { hireToken: (args.pluginMetadata as { hireToken: string }).hireToken } },
      requestedExecution: { providerId: args.providerId, model: args.model ?? null, permissionMode: args.permissionMode ?? null },
    });
    expect(context.thread.parentThreadId).toBe("keeper");
    expect(k.store.get("hires", (args.pluginMetadata as { hireToken: string }).hireToken)?.owner.keeperThreadId).toBe("keeper");
    const dispatch = await runtime.dispatch(context);
    expect(dispatch, JSON.stringify(f.harness.logEntries)).toEqual({ action: "proceed" });
    expect(runtime.placements().store.byMember("maker")).toMatchObject({ environmentId: null });
    trace.push("dispatch-bind");
    return member;
  });
  f.harness.sdk.stub("threads.spawn", spawn);
  return { ...f, trace, k, runtime, settings, quest, rule, spawn, placements: runtime.placements().store };
}

describe("remote placement activation gate — incomplete until every pending phase runs together", () => {
  it("matches a saved rule and provisions through the real controller and ordinary hire path", async () => {
    const f = await fixture();
    const member = await f.runtime.hire("keeper", "project", {
      classId: "smith", boardQuestId: f.quest.id, waypointId: "w1", title: "Implement",
      brief: { outcome: "The change", mode: "make-it-work", doneWhen: "Project checks pass", outOfScope: "No publication",
        context: [], questions: [], timeboxMinutes: null },
    });
    const record = f.placements.byMember(member.threadId)!;
    const snapshot = f.placements.snapshot(record.sourceSnapshotId!)!;
    expect(snapshot).toMatchObject({ purpose: "initial", base: f.base, sourceHead: f.head, tree: f.tree });
    expect(f.placements.counts("keeper")).toEqual({ makers: 1, checkers: 0 });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0][0].environment).toEqual({
      type: "provider", environmentProviderId: "isolated-checkout", inputs: { base: f.base, branch: expect.stringMatching(/^tavern\//) },
      machine: { type: "new", machineProviderId: "on-demand-compute", inputs: null },
    });
    expect(f.trace).toEqual(["provision", "dispatch-bind"]);
    expect(record).toMatchObject({ phase: "bootstrapping", memberThreadId: "maker", environmentId: null,
      posture: { aggregate: "remote-detection-only" }, acknowledgedScopeRevision: null });
    expect(member.placementSummary).toMatch(/One machine per member.*isolated-members.*projectIds=project.*bootstrapping.*Detection only \(remote\)/);
    expect(member.guardPosture?.label).toBe("Detection only (remote)");
    expect(f.harness.inspection.sdk.callsTo("hosts.experimental_create")).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
    expect(f.k.store.all("asks").filter(ask => ask.kind === "scope")).toEqual([]);
  }, 60_000);

  it("SOURCE — reads the native merge base and pins clean unpushed initial source without modifying the user checkout", async () => {
    const f = nativeSourceFixture(), discovered = await f.discovery.inspect("keeper", "project");
    if (discovered.state !== "known") throw new Error(discovered.message);
    const refs = git(f.source, "show-ref"), config = readFileSync(join(f.source, ".git/config")), index = readFileSync(join(f.source, ".git/index"));
    writeFileSync(join(f.source, "dirty.txt"), "must not commit\n");
    const dirty = await f.capture.initial(discovered);
    expect(dirty).toMatchObject({ includesUncommitted: true, userHead: f.head, untrackedPaths: 1,
      uncommittedOrigin: { hostId: "source-host", environmentId: "source-env", root: f.source } });
    expect(git(f.source, "show", dirty.sourceHead + ":dirty.txt")).toBe("must not commit");
    expect(git(f.source, "rev-parse", dirty.sourceHead + "^{tree}")).toBe(dirty.tree);
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
    expect(f.harness.experimental_hostRpcCalls.every(call => ["registerEndpoint", "inspect", "snapshotWorktree"].includes(call.method))).toBe(true);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    writeFileSync(join(f.source, "staged-after-capture.txt"), "same content\n");
    const unstaged = await f.capture.initial(discovered);
    git(f.source, "add", "staged-after-capture.txt");
    const stagedIndex = readFileSync(join(f.source, ".git/index"));
    expect(await f.capture.initial(discovered)).toEqual(unstaged);
    expect(readFileSync(join(f.source, ".git/index"))).toEqual(stagedIndex);
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
    f.placements.reserve(placementRecord({ id: "initial-transport", hireToken: "initial-transport", sourceSnapshotId: dirty.id }), { maxMakers: 2, maxCheckers: 2 });
    const pinned = await new PlacementTransport(f.bb, createHostPort(f.bb), f.placements).bringHome("initial-transport", 1, dirty.id);
    expect(git(f.source, "rev-parse", pinned.homeRef + "^{tree}")).toBe(dirty.tree);
    expect(readFileSync(join(f.source, ".git/index"))).toEqual(stagedIndex);
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
  }, 60_000);
  it("DELIVER — prepares the marked artifact, retains unmarked files, and acknowledges exact host-bound scope bytes without controller paths", deliverGate, 60_000);
  it("READY — calls registered tavern_ready through authenticated context, carries initial content, and publishes the exact generation and tree without claiming arming", readyGate, 60_000);
  it("SMITH — snapshot a quiescent maker’s modified tracked and untracked source, pin its exact tree at home, and retain remote detection-only labels", proveSubmissionStage, 60_000);
  it("CARRY — bring the Smith's unpushed source home and carry the pinned same-format tree to its Warden", proveCarryStage, 60_000);
  it("WARDEN — independently match its own rule, provision a distinct machine, and bind checks to its carried root", proveWardenStage, 60_000);
  it("CHECK — run the trusted check on the Warden host and accept only the clean pinned tree and current review targets", proveCheckStage, 60_000);
  it("PRESERVE — save source and declared workspace/thread-storage artifacts before controlled release", provePreserveStage, 60_000);
  it("STOP — preserve before terminal stop and release; external loss is not successful retention", proveStopStage, 60_000);
  it("COMPLETE CHAIN — execute rule → provision → deliver → authenticated ready → Smith work → home/carry → separate Warden/check → preserve → stop through the real controller and official SDK/host harnesses", proveCompleteChain, 60_000);
});
