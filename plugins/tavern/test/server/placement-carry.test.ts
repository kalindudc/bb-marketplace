// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { carryReceiptSchema, placementRecordSchema } from "../../src/shared/placement";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";
import { CHUNK_BYTES, hostContract, type HostMethod } from "../../src/host-contract";
import { createHostPort } from "../../src/host/client";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { createTransport } from "../../src/host/transport";
import { MIGRATIONS } from "../../src/server/migrations";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { Registry } from "../../src/server/registry";
import { TavernRuntime } from "../../src/server/runtime";
import { PlacementCarry } from "../../src/server/placement/carry";
import { PlacementStore } from "../../src/server/placement/store";
import { PlacementTransport } from "../../src/server/placement/transport";
import { placementRecord, sourceSnapshot } from "./placement-fixture";
import { fakePort } from "./support";

const roots: string[] = [], hosts = new Set<ReturnType<typeof createFakePluginHost>>();
afterEach(async () => {
  for (const host of hosts) await host.harness.lifecycle.dispose(); hosts.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
async function fixture(format: "sha1" | "sha256" = "sha1", size = 32) {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "placement-carry-")); roots.push(root);
  const home = join(root, "home"), member = join(root, "member"); mkdirSync(home);
  git(home, "init", "-q", "-b", "main", "--object-format=" + format); git(home, "config", "user.name", "Fixture"); git(home, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(home, "tracked"), "base\n"); writeFileSync(join(home, "gone"), "delete\n"); git(home, "add", "-A"); git(home, "commit", "-qm", "base");
  const base = git(home, "rev-parse", "HEAD"); git(home, "clone", "-q", "--no-hardlinks", home, member); git(member, "checkout", "-qb", "tavern/member");
  writeFileSync(join(home, "tracked"), "unpushed\n"); unlinkSync(join(home, "gone")); writeFileSync(join(home, "binary"), Buffer.alloc(size, 0xa7));
  writeFileSync(join(home, "empty"), ""); writeFileSync(join(home, "executable"), "#!/bin/sh\n", { mode: 0o755 }); symlinkSync("tracked", join(home, "link"));
  git(home, "add", "-A"); git(home, "commit", "-qm", "snapshot");
  const head = git(home, "rev-parse", "HEAD"), tree = git(home, "rev-parse", "HEAD^{tree}");
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
  let status: "idle" | "active" = "idle", stopError: Error | null = null;
  let intercept: ((method: HostMethod, input: unknown, result: unknown) => unknown | Promise<unknown>) | undefined;
  const host = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, sdk: {
    threads: {
      get: async ({ threadId }) => makeThreadResponse({ id: threadId, status, projectId: "project", environmentId: threadId === "keeper" ? "home-env" : "member-env" }),
      stop: async () => { if (stopError) throw stopError; return { ok: true }; },
      queuedMessages: { list: async () => [] }, events: { list: async () => [] },
    }, environments: { get: async ({ environmentId }) => environments.get(environmentId)! },
  }, experimental_callHostRpc: async call => {
    const registry = registries.get(call.hostId!)!;
    let result: unknown;
    if (call.method === "registerEndpoint") result = registry.registerEndpoint(hostContract.registerEndpoint.input.parse(call.input));
    else if (call.method === "registerTransfer") result = registry.registerTransfer(hostContract.registerTransfer.input.parse(call.input));
    else if (call.method === "inspect") result = await inspectHost(registry, hostContract.inspect.input.parse(call.input), call.signal);
    else {
      const transport = createTransport(registry), invoke = transport[call.method as keyof typeof transport] as (input: unknown, signal?: AbortSignal) => Promise<unknown>;
      if (!invoke) throw new Error("Unexpected native method " + call.method);
      result = await invoke(call.input, call.signal);
    }
    return intercept ? intercept(call.method as HostMethod, call.input, result) : result;
  } }); hosts.add(host);
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join("\n"));
  const placements = new PlacementStore(db), port = createHostPort(host.bb);
  const k = new Keeper(new KeeperStore(db), fakePort(), Date.now, () => {});
  k.bind("keeper", "keeper", "wren", "project");
  k.bind("member", "smith", "vale", "project", { keeperThreadId: "keeper", boardQuestId: null, waypointId: null, errand: true, title: "Work",
    brief: { outcome: "Work", doneWhen: "Checks", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
  const runtime = new TavernRuntime(host.bb, k, new Registry(fileURLToPath(new URL("../../", import.meta.url)), "/nonexistent"));
  placements.reserve(placementRecord({ memberThreadId: "member", sourceSnapshotId: "snapshot", ownsNewMachine: true, workspaceKind: "dedicated-machine",
    hostId: "member-host", environmentId: "member-env", root: member, questId: null }), { maxMakers: 2, maxCheckers: 2 });
  placements.update("placement", 1, value => ({ ...value, phase: "bootstrapping" }));
  const endpoint = { hostId: "home-host", environmentId: "home-env", root: home };
  placements.saveSnapshot(sourceSnapshot({ source: endpoint, home: endpoint, objectFormat: format, base, sourceHead: head, tree,
    fetch: { via: "upstream", remoteName: "origin", remoteUrl: home, trackingRef: "refs/remotes/origin/main", fetchRef: "refs/heads/main" } }));
  await new PlacementTransport(host.bb, port, placements).bringHome("placement", 1, "snapshot");
  const make = () => new PlacementCarry(host.bb, port, placements, runtime.away);
  return { ...host, db, placements, port, runtime, make, home, member, base, head, tree, environments,
    status: (value: typeof status) => { status = value; }, stopError: (value: Error | null) => { stopError = value; },
    intercept: (fn: typeof intercept) => { intercept = fn; } };
}

it.each(["sha1", "sha256"] as const)("carries exact %s pinned content only under a durable confirmed hold, without publishing readiness", async format => {
  const f = await fixture(format, CHUNK_BYTES + 19), carry = f.make();
  const first = carry.carryOut("placement", 1, "snapshot"), duplicate = carry.carryOut("placement", 1, "snapshot"); expect(duplicate).toBe(first);
  const result = await first;
  expect(result).toMatchObject({ snapshotId: "snapshot", tree: f.tree, objectFormat: format });
  expect(git(f.member, "rev-parse", "HEAD^{tree}")).toBe(f.tree); expect(git(f.member, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(f.member, "binary"))).toEqual(Buffer.alloc(CHUNK_BYTES + 19, 0xa7));
  expect(git(f.member, "ls-tree", "HEAD", "executable", "link")).toContain("100755"); expect(git(f.member, "ls-tree", "HEAD", "link")).toContain("120000");
  expect(f.placements.get("placement")).toMatchObject({ phase: "bootstrapping", acknowledgedScopeRevision: null, carries: [{ phase: "verified", snapshotId: "snapshot" }] });
  expect(f.runtime.away.blocked("member")).toBe(true);
  const calls = f.harness.experimental_hostRpcCalls, start = calls.findIndex(call => call.method === "carryStart");
  expect(start).toBeGreaterThan(-1); expect(calls[start]!.input).toMatchObject({ baseBranch: "refs/heads/main", remote: f.home });
  expect(calls[start]!.input).not.toHaveProperty("replaces");
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toContainEqual([{ threadId: "member" }]);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  const registrations = calls.filter(call => call.method === "registerEndpoint").length;
  await f.make().carryOut("placement", 1, "snapshot");
  expect(calls.filter(call => call.method === "registerEndpoint").length - registrations).toBeLessThanOrEqual(2);
}, 60_000);

it("persists private operation+token before interruption and refuses pending stops", async () => {
  const f = await fixture(); f.stopError(new Error("Stop unavailable"));
  await expect(f.make().carryOut("placement", 1, "snapshot")).rejects.toThrow(/Stop unavailable|pending/i);
  expect(f.placements.get("placement")!.carries).toMatchObject([{ phase: "holding", holdToken: expect.any(String) }]);
  expect(f.harness.experimental_hostRpcCalls.filter(call => call.method === "carryStart")).toEqual([]);
  f.stopError(null); await f.make().carryOut("placement", 1, "snapshot");
}, 60_000);

it.each(["idle-only", "stale-token", "cancellation", "assignment", "endpoint", "worker-exit", "caller-abort", "late-cancellation"])("fences %s before carry publication and leaves the hold in place", async kind => {
  const f = await fixture(), controller = new AbortController();
  if (kind === "idle-only") f.status("active");
  let once = false;
  f.intercept(async (method, _input, result) => {
    if (method !== (kind === "late-cancellation" ? "carryFinish" : "exportChanges") || once) return result; once = true;
    const record = f.placements.get("placement")!;
    if (kind === "stale-token") f.runtime.away.finishContentHold(record.carries![0]!.holdToken as never);
    if (kind === "cancellation" || kind === "late-cancellation") f.placements.cancel("placement", 1);
    if (kind === "assignment") f.placements.update("placement", 1, value => ({ ...value, sourceSnapshotId: null }));
    if (kind === "endpoint") f.environments.set("member-env", { ...f.environments.get("member-env")!, path: "/replaced" });
    if (kind === "worker-exit") await f.harness.behavior.experimental_emitHostWorkerExit("member-host");
    if (kind === "caller-abort") controller.abort(new Error("Caller cancelled"));
    return result;
  });
  await expect(f.make().carryOut("placement", 1, "snapshot", controller.signal)).rejects.toThrow();
  expect(f.placements.get("placement")!.carries?.some(receipt => receipt.phase === "verified")).not.toBe(true);
  expect(git(f.member, "rev-parse", "HEAD^{tree}")).toBe(kind === "late-cancellation" ? f.tree : git(f.home, "rev-parse", f.base + "^{tree}"));
}, 60_000);

it("preserves unknown committed and dirty member work instead of inventing a replacement tree", async () => {
  const f = await fixture(); writeFileSync(join(f.member, "tracked"), "human\n");
  await expect(f.make().carryOut("placement", 1, "snapshot")).rejects.toThrow(/dirty|uncommitted|left it/i);
  expect(readFileSync(join(f.member, "tracked"), "utf8")).toBe("human\n");
  git(f.member, "-c", "user.name=Human", "-c", "user.email=human@example.invalid", "commit", "-qam", "human");
  const head = git(f.member, "rev-parse", "HEAD");
  await expect(f.make().carryOut("placement", 1, "snapshot")).rejects.toThrow(/trusted previous tree|Preserve/i);
  expect(git(f.member, "rev-parse", "HEAD")).toBe(head);
}, 60_000);

it.each(["invalid-base64", "wrong-length", "wrong-hash", "foreign-edit"])("refuses %s without a verified receipt or destructive abort", async kind => {
  const f = await fixture(); let once = false;
  f.intercept((method, _input, result) => {
    if (once) return result;
    if (kind === "foreign-edit" && method === "carryWrite") { once = true; writeFileSync(join(f.member, "binary"), "human"); }
    if (kind !== "foreign-edit" && method === "readBlob") {
      once = true;
      const data = (result as { data: string }).data;
      if (kind === "invalid-base64") return { data: data + "=" };
      if (kind === "wrong-length") return { data: "" };
      return { data: Buffer.alloc(Buffer.from(data, "base64").length, 0xb8).toString("base64") };
    }
    return result;
  });
  await expect(f.make().carryOut("placement", 1, "snapshot")).rejects.toThrow();
  expect(f.placements.get("placement")!.carries!.some(item => item.phase === "verified")).toBe(false);
  expect(f.runtime.away.blocked("member")).toBe(true);
  expect(f.harness.experimental_hostRpcCalls.filter(call => call.method === "carryAbort")).toEqual([]);
  if (kind === "foreign-edit") expect(readFileSync(join(f.member, "binary"), "utf8")).toBe("human");
}, 60_000);

it("keeps strict optional carry receipts inside excluded private placement storage", async () => {
  const f = await fixture(); expect(f.placements.get("placement")).not.toHaveProperty("carries");
  await f.make().carryOut("placement", 1, "snapshot");
  const record = new PlacementStore(f.db).get("placement")!, receipt = record.carries![0]!;
  expect(carryReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(carryReceiptSchema.safeParse({ ...receipt, arbitraryAuthority: true }).success).toBe(false);
  expect(carryReceiptSchema.safeParse({ ...receipt, manifest: null }).success).toBe(false);
  expect(carryReceiptSchema.safeParse({ ...receipt, head: null }).success).toBe(false);
  expect(placementRecordSchema.safeParse({ ...record, carries: [receipt, receipt] }).success).toBe(false);
  for (const io of ["input", "output"] as const) expect(() => z.toJSONSchema(placementRecordSchema, { io })).not.toThrow();
  const capture = new BackupRecords(f.db, new SettingsStore(f.db)).capture();
  expect(capture.tables).not.toHaveProperty("tavern_placements"); expect(capture.tables).not.toHaveProperty("tavern_source_snapshots");
}, 60_000);

it("reconciles a lost finish reply under the same immutable receipt without another work replay", async () => {
  const f = await fixture(); let lost = false;
  f.intercept((method, _input, result) => { if (method === "carryFinish" && !lost) { lost = true; throw new Error("Lost reply"); } return result; });
  await expect(f.make().carryOut("placement", 1, "snapshot")).rejects.toThrow("Lost reply");
  expect(git(f.member, "rev-parse", "HEAD^{tree}")).toBe(f.tree);
  const result = await f.make().carryOut("placement", 1, "snapshot");
  expect(result.tree).toBe(f.tree); expect(f.placements.get("placement")!.carries).toHaveLength(1);
}, 60_000);
