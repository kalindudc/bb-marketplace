import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { execFileSync } from "node:child_process";
import { realGit } from "../host/emulated-git";
import { gitFixtureTemplate } from "../git-fixture-template";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { hostContract, type HostMethod } from "../../src/host-contract";
import { createHostPort } from "../../src/host/client";
import { NativeGuard } from "../../src/host/guard";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { NativeScopes } from "../../src/host/scopes";
import { createTransport } from "../../src/host/transport";
import { scopeForClass } from "../../src/scope/presets";
import { ScopeStore } from "../../src/scope/store";
import { hostTemplate, type HostTemplate } from "../../src/scope/host-env";
import { MIGRATIONS } from "../../src/server/migrations";
import { PlacementCarry } from "../../src/server/placement/carry";
import { PlacementDeliveries } from "../../src/server/placement/delivery";
import { PlacementReady } from "../../src/server/placement/ready";
import { PlacementStore } from "../../src/server/placement/store";
import { PlacementTransport } from "../../src/server/placement/transport";
import { placementRecord } from "./placement-fixture";
import { registerReady } from "../../src/server/tools/ready";

const fixtures: Array<{ root: string; host: ReturnType<typeof createFakePluginHost> }> = [];
afterEach(async () => {
  for (const { root, host } of fixtures.splice(0)) {
    await host.harness.lifecycle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
export const readyGit = (root: string, ...args: string[]) => execFileSync(realGit, ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
const seedRepos = gitFixtureTemplate(root => {
  const home = join(root, "home"), member = join(root, "member"); mkdirSync(home);
  readyGit(home, "init", "-q", "-b", "main"); readyGit(home, "config", "user.name", "Fixture"); readyGit(home, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(home, "tracked"), "base\n"); readyGit(home, "add", "-A"); readyGit(home, "commit", "-qm", "base");
  const base = readyGit(home, "rev-parse", "HEAD"); readyGit(home, "clone", "-q", "--no-hardlinks", home, member); readyGit(member, "checkout", "-qb", "tavern/member");
  writeFileSync(join(home, "tracked"), "snapshot\n"); readyGit(home, "commit", "-qam", "snapshot");
  return { base, head: readyGit(home, "rev-parse", "HEAD"), tree: readyGit(home, "rev-parse", "HEAD^{tree}") };
});
export async function readyFixture(checker = false, includesUncommitted = false) {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "placement-ready-"));
  const home = join(root, "home"), member = join(root, "member"), storage = join(root, "storage"), agentDir = join(root, "pi");
  const { base, head, tree } = seedRepos(root);
  readyGit(member, "remote", "set-url", "origin", home);
  mkdirSync(storage); mkdirSync(agentDir);
  const environments = new Map<string, Environment>();
  for (const [side, path, branch] of [["home", home, "main"], ["member", member, "tavern/member"]]) environments.set(side + "-env", {
    id: side + "-env", projectId: "project", hostId: side + "-host", path, status: "ready", hostLifecycle: "active",
    lifecycle: { phase: "active", retireAt: null, teardown: null }, isGitRepo: true, isWorktree: false,
    environmentProviderId: "checkout", environmentProviderInstanceKey: null, environmentProviderSelection: null,
    branchName: branch, baseBranch: null, defaultBranch: null, mergeBaseBranch: null, name: side, managed: false,
    workspaceProvisionType: "unmanaged", createdAt: 1, updatedAt: 1,
  });
  const registries = new Map<string, HostRegistry>();
  for (const side of ["home", "member"]) { const data = join(root, side + "-data"); mkdirSync(data); registries.set(side + "-host", new HostRegistry(data)); }
  const paths = { home: join(root, "native-home"), tmp: [join(root, "native-tmp")], piAgentDir: agentDir };
  mkdirSync(paths.home); mkdirSync(paths.tmp[0]);
  const nativeScopes = new NativeScopes(registries.get("member-host")!, { paths });
  const artifact = join(root, "host.mjs"); writeFileSync(artifact, "export function tavernGuard() {}\n");
  const guard = new NativeGuard(registries.get("member-host")!, { artifactPath: artifact, agentDir });
  let connected = true;
  let providerId = "pi";
  let rows: unknown[] = [];
  let intercept: ((method: HostMethod, input: unknown, result: unknown) => unknown | Promise<unknown>) | undefined;
  const host = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, sdk: {
    threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, providerId, status: "active", projectId: "project", environmentId: threadId === "keeper" ? "home-env" : "member-env" }),
      storageLocation: async () => ({ hostId: "member-host", storageRootPath: storage }), events: { list: async () => rows as never } },
    environments: { get: async ({ environmentId }) => environments.get(environmentId)! },
    hosts: { get: async ({ hostId }) => makeHostResponse({ id: hostId, status: connected ? "connected" : "disconnected" }) },
  }, experimental_callHostRpc: async call => {
    const registry = registries.get(call.hostId!)!, method = call.method as HostMethod;
    const input = hostContract[method].input.parse(call.input);
    let result: unknown;
    if (method === "registerEndpoint") result = registry.registerEndpoint(input as never);
    else if (method === "registerEndpoints") result = registry.registerEndpoints(input as never);
    else if (method === "registerTransfer") result = registry.registerTransfer(input as never);
    else if (method === "inspect") result = await inspectHost(registry, input as never, call.signal);
    else if (method === "prepareGuard") result = await guard.prepareGuard(input as never, call.signal);
    else if (method === "bindScope") result = await nativeScopes.bindScope(input as never, call.signal);
    else if (method === "prepareCall") result = await nativeScopes.prepareCall(input as never, call.signal);
    else if (method === "sessionStatus") result = await nativeScopes.sessionStatus(input as never, call.signal);
    else if (method === "communicationHolds") result = nativeScopes.communicationHolds(input as never);
    else {
      const transport = createTransport(registry), invoke = transport[method as keyof typeof transport] as (input: unknown, signal?: AbortSignal) => Promise<unknown>;
      if (!invoke) throw new Error("Unexpected native method " + method);
      result = await invoke(input, call.signal);
    }
    return intercept ? intercept(method, call.input, result) : result;
  } }); fixtures.push({ root, host });
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join(";\n"));
  const placements = new PlacementStore(db), deliveries = new PlacementDeliveries(db, placements), port = createHostPort(host.bb);
  const journal = { boardQuestId: "quest", waypointId: "waypoint", makerThreadId: "maker", journalEntryId: "entry", entryFingerprint: "a".repeat(64), reviewAssignmentId: "review" };
  const snapshot = placements.captureSnapshot({ purpose: checker ? "submission" : "initial", keeperThreadId: "keeper", projectId: "project",
    sourceThreadId: "keeper", makerThreadId: checker ? "keeper" : null, makerSubmissionId: checker ? "submission" : null,
    journalTarget: checker ? { ...journal, makerThreadId: "keeper" } : null, objectFormat: "sha1", base, sourceHead: head, tree,
    fetch: { via: "upstream", remoteName: "origin", remoteUrl: home, trackingRef: "refs/remotes/origin/main", fetchRef: "refs/heads/main" },
    source: { hostId: "home-host", environmentId: "home-env", root: home }, home: { hostId: "home-host", environmentId: "home-env", root: home },
    ...(includesUncommitted ? { includesUncommitted: true, uncommittedOrigin: { hostId: "home-host", environmentId: "home-env", root: home } } : {}) });
  placements.reserve(placementRecord({ memberThreadId: "member", sourceSnapshotId: snapshot.id, ownsNewMachine: true, workspaceKind: "dedicated-machine",
    classId: checker ? "warden" : "smith", slot: checker ? "checker" : "maker", hostId: null, environmentId: null, root: null,
    rule: { ...placementRecord().rule!, acceptedConsent: { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true } },
    reviewTarget: checker ? { makerThreadId: "keeper", makerSubmissionId: "submission", snapshotId: snapshot.id, expectedTree: tree, journal: { ...journal, makerThreadId: "keeper" } } : null }),
    { maxMakers: 2, maxCheckers: 2 });
  placements.update("placement", 1, value => ({ ...value, phase: "bootstrapping" }));
  const scopes = new ScopeStore(join(root, "controller"));
  scopes.markHostBinding("member", { kind: "host", placementId: "placement", generation: 1 });
  const template = { ...scopeForClass(checker ? "warden" : "smith"), threadId: "member", issuedAt: 1,
    ...(checker ? { checks: { commands: ["node --test"] } } : {}) };
  scopes.write("member", template, template);
  const holds = { requestContentHold: () => { throw new Error("Self-turn must not stop its owner"); }, confirmHeld: () => { throw new Error("Self-turn must not confirm an idle hold"); },
    inspectHeld: () => { throw new Error("Self-turn must not consume a background hold"); }, finishContentHold: () => { throw new Error("Self-turn must not finish a background hold"); } };
  const carry = new PlacementCarry(host.bb, port, placements, holds as never);
  const transport = new PlacementTransport(host.bb, port, placements);
  const make = (scopeForThread: (threadId: string) => HostTemplate = threadId => hostTemplate(scopes.records.get(threadId))) => new PlacementReady({ bb: host.bb, host: port, placements, deliveries, carry, transport, scopeForThread });
  return { ...host, root, home, member, storage, agentDir, tree, head, base, db, port, placements, deliveries, scopes, carry, transport, nativeScopes, template, snapshot, make,
    provider: (value: string) => { providerId = value; }, events: (value: unknown[]) => { rows = value; }, connected: (value: boolean) => { connected = value; }, environments, intercept: (fn: typeof intercept) => { intercept = fn; } };
}

export async function deliverGate() {
  const f = await readyFixture();
  const unmarked = join(f.agentDir, "extensions/tavern-guard/index.ts"); mkdirSync(join(f.agentDir, "extensions/tavern-guard"), { recursive: true }); writeFileSync(unmarked, "user extension\n");
  const result = await f.make().forThread("member");
  expect(result).toContain("Detection only (remote)");
  expect(readFileSync(unmarked, "utf8")).toBe("user extension\n");
  const delivery = f.deliveries.get("placement")!;
  expect(delivery.acknowledged!.scopeFile).toContain("member-data");
  expect(JSON.parse(delivery.scopeFileJson).bindingTemplate).toEqual(f.template);
  expect(f.placements.get("placement")!.posture.warnings.join("\n")).toMatch(/unmarked|not marked/i);
}
export async function readyGate() {
  const f = await readyFixture(), ready = f.make();
  registerReady(f.bb, {
    placements: () => ({ ready }), study: { tool: (_name: string, _thread: string, _input: unknown, call: (refused: (id: string) => void) => unknown) => call(() => {}) },
    beginMemberTavernCall: () => {},
  } as never);
  const result = await f.harness.behavior.callAgentTool("tavern_ready", {}, { threadId: "member", projectId: "project" });
  expect(result).toContain(f.member); expect(result).toContain(f.tree); expect(result).toContain("not a guard-armed receipt");
  expect(f.placements.get("placement")).toMatchObject({ phase: "ready", hostId: "member-host", environmentId: "member-env", root: f.member });
  expect(readyGit(f.member, "rev-parse", "HEAD^{tree}")).toBe(f.tree);
  expect(f.harness.experimental_hostRpcCalls.filter(call => call.method === "registerEndpoints")).toHaveLength(1);
}
