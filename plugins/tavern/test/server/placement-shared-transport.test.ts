// @vitest-environment node
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CHUNK_BYTES, hostContract, type HostMethod } from "../../src/host-contract";
import { createHostPort } from "../../src/host/client";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { createTransport } from "../../src/host/transport";
import { MIGRATIONS } from "../../src/server/migrations";
import { SnapshotStore } from "../../src/server/placement/snapshot-store";
import { PlacementStore } from "../../src/server/placement/store";
import { PlacementTransport } from "../../src/server/placement/transport";
import { placementRecord, sourceSnapshot } from "./placement-fixture";

const hosts = new Set<ReturnType<typeof createFakePluginHost>>(), roots: string[] = [];
afterEach(async () => {
  for (const host of hosts) await host.harness.lifecycle.dispose(); hosts.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
async function fixture(format: "sha1" | "sha256" = "sha1", extended = false) {
  const root = realpathSync(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "shared-import-"))); roots.push(root);
  const home = join(root, "home"), source = join(root, "source"); mkdirSync(home);
  git(home, "init", "-qb", "main", "--object-format=" + format); git(home, "config", "user.name", "Fixture"); git(home, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(home, "tracked"), "base\n");
  if (extended) writeFileSync(join(home, "gone"), "delete me\n");
  git(home, "add", "-A"); git(home, "commit", "-qm", "base");
  const base = git(home, "rev-parse", "HEAD"); git(home, "clone", "-q", "--no-hardlinks", home, source);
  git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "tracked"), "unpublished\n");
  if (extended) {
    unlinkSync(join(source, "gone"));
    writeFileSync(join(source, "binary"), Buffer.alloc(CHUNK_BYTES + 19, 0xa7)); writeFileSync(join(source, "empty"), "");
    writeFileSync(join(source, "executable"), "#!/bin/sh\n", { mode: 0o755 }); symlinkSync("tracked", join(source, "link"));
  }
  git(source, "add", "-A"); git(source, "commit", "-qm", "source");
  const head = git(source, "rev-parse", "HEAD"), tree = git(source, "rev-parse", "HEAD^{tree}");
  const endpoint = (side: "source" | "home") => ({ hostId: side, environmentId: side + "-env", root: side === "source" ? source : home });
  const environments = new Map<string, Environment>();
  for (const side of ["source", "home"] as const) environments.set(side + "-env", {
    id: side + "-env", projectId: "project", hostId: side, path: endpoint(side).root, status: "ready", hostLifecycle: "active",
    lifecycle: { phase: "active", retireAt: null, teardown: null }, isGitRepo: true, isWorktree: false,
    environmentProviderId: "checkout", environmentProviderInstanceKey: null, environmentProviderSelection: null,
    branchName: "main", baseBranch: null, defaultBranch: null, mergeBaseBranch: null, name: side, managed: false,
    workspaceProvisionType: "unmanaged", createdAt: 1, updatedAt: 1,
  });
  const registries = new Map<string, HostRegistry>();
  for (const side of ["source", "home"]) { const data = join(root, side + "-native"); mkdirSync(data); registries.set(side, new HostRegistry(data)); }
  let sourceAvailable = true;
  let intercept: ((method: HostMethod, input: unknown, result: unknown) => unknown | Promise<unknown>) | undefined;
  const host = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, sdk: {
    threads: { get: async ({ threadId }) => {
      if (!sourceAvailable && threadId.startsWith("maker")) throw new Error("Maker machine has been released");
      return makeThreadResponse({ id: threadId, projectId: "project", environmentId: threadId.startsWith("maker") ? "source-env" : "home-env" });
    } },
    environments: { get: async ({ environmentId }) => structuredClone(environments.get(environmentId)!) },
  }, experimental_callHostRpc: async call => {
    const registry = registries.get(call.hostId!)!;
    let result: unknown;
    if (call.method === "registerEndpoint") result = registry.registerEndpoint(hostContract.registerEndpoint.input.parse(call.input));
    else if (call.method === "registerTransfer") result = registry.registerTransfer(hostContract.registerTransfer.input.parse(call.input));
    else if (call.method === "inspect") result = await inspectHost(registry, hostContract.inspect.input.parse(call.input), call.signal);
    else {
      const transport = createTransport(registry), method = call.method as keyof typeof transport;
      if (!(method in transport)) throw new Error("Unexpected method " + call.method);
      result = await (transport[method] as (input: unknown, signal?: AbortSignal) => Promise<unknown>)(call.input, call.signal);
    }
    return intercept ? intercept(call.method as HostMethod, call.input, result) : result;
  } }); hosts.add(host);
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join(";\n"));
  const placements = new PlacementStore(db), owners = new SnapshotStore(db), port = createHostPort(host.bb);
  const { id: _id, homeRef: _ref, homeCommit: _commit, createdAt: _at, ...input } = sourceSnapshot({ purpose: "wip", sourceThreadId: "maker", makerThreadId: "maker",
    objectFormat: format, base, sourceHead: head, tree, source: endpoint("source"), home: endpoint("home"),
    fetch: { via: "upstream", remoteName: "origin", remoteUrl: home, trackingRef: "refs/remotes/origin/main", fetchRef: "refs/heads/main" } });
  const snapshot = placements.captureSnapshot(input);
  const second = placements.captureSnapshot({ ...input, keeperThreadId: "other-keeper", makerThreadId: "maker-two", sourceThreadId: "maker-two" });
  for (const [id, descriptor, member] of [["first", snapshot, "maker"], ["second", second, "maker-two"]] as const)
    placements.reserve(placementRecord({ id, hireToken: id, keeperThreadId: descriptor.keeperThreadId, memberThreadId: member, sourceSnapshotId: descriptor.id }), { maxMakers: 2, maxCheckers: 2 });
  return { ...host, db, placements, owners, home, source, head, tree, base, snapshot, second, environments,
    make: () => new PlacementTransport(host.bb, port, placements),
    intercept: (fn: typeof intercept) => { intercept = fn; }, releaseSource: () => { sourceAvailable = false; } };
}

it.each(["sha1", "sha256"] as const)("imports shared %s content under one owner, not under either placement", async format => {
  const f = await fixture(format), transport = f.make();
  writeFileSync(join(f.home, "tracked"), "user staged work\n"); git(f.home, "add", "tracked");
  const index = readFileSync(join(f.home, ".git/index"));
  const first = await transport.bringHome("first", 1, f.snapshot.id);
  const second = await transport.bringHome("second", 1, f.second.id);
  expect(first.id).not.toBe(second.id); expect(first.ownerId).toBe(second.ownerId); expect(first.homeCommit).toBe(second.homeCommit);
  expect(f.placements.get("first")).not.toHaveProperty("transfers"); expect(f.placements.get("second")).not.toHaveProperty("transfers");
  const registrations = f.harness.experimental_hostRpcCalls.filter(call => call.method === "registerEndpoint").map(call => call.input as { placementId: string; endpointId: string; generation: number });
  expect(new Set(registrations.map(value => value.placementId))).toEqual(new Set(["snapshot-" + first.ownerId]));
  expect(new Set(registrations.map(value => value.endpointId)).size).toBe(3);
  const imports = f.harness.experimental_hostRpcCalls.filter(call => call.method === "importCommit").map(call => call.input as { transferId: string });
  expect(new Set(imports.map(value => value.transferId)).size).toBe(1);
  expect(f.owners.get(first.ownerId!)!.homeTransfer!.receipt).toMatchObject({ snapshotId: first.ownerId, phase: "verified", homeCommit: first.homeCommit });
  expect(git(f.home, "rev-parse", first.homeRef + "^{tree}")).toBe(f.tree);
  expect(git(f.home, "for-each-ref", "--format=%(refname)", "refs/tavern/snapshots/")).toBe(first.homeRef);
  expect(readFileSync(join(f.home, ".git/index"))).toEqual(index); expect(readFileSync(join(f.home, "tracked"), "utf8")).toBe("user staged work\n");
}, 60_000);

it("imports bounded multi-chunk binary, empty, executable, symlink and deleted content through the shared owner", async () => {
  const f = await fixture("sha256", true), result = await f.make().bringHome("first", 1, f.snapshot.id);
  expect(git(f.home, "cat-file", "-s", result.homeRef + ":binary")).toBe(String(CHUNK_BYTES + 19));
  expect(git(f.home, "cat-file", "-s", result.homeRef + ":empty")).toBe("0");
  expect(git(f.home, "ls-tree", result.homeRef, "executable")).toContain("100755");
  expect(git(f.home, "ls-tree", result.homeRef, "link")).toContain("120000");
  expect(git(f.home, "ls-tree", result.homeRef, "gone")).toBe("");
  expect(git(f.home, "rev-parse", result.homeRef + "^{tree}")).toBe(f.tree);
}, 60_000);

it("serializes simultaneous descriptor requests without duplicate import work and returns each descriptor", async () => {
  const f = await fixture(), transport = f.make();
  const [one, two] = await Promise.all([transport.bringHome("first", 1, f.snapshot.id), transport.bringHome("second", 1, f.second.id)]);
  expect(one.id).toBe(f.snapshot.id); expect(two.id).toBe(f.second.id); expect(one.homeCommit).toBe(two.homeCommit);
  expect(f.harness.experimental_hostRpcCalls.filter(call => call.method === "readBlob")).toHaveLength(1);
}, 60_000);

it("persists the sole manifest before upload and reconciles a lost import reply through another descriptor", async () => {
  const f = await fixture(); let lost = false;
  f.intercept((method, _input, result) => {
    if (method === "importChunk") expect(f.owners.get(f.snapshot.ownerId!)!.homeTransfer!.receipt.manifest).not.toBeNull();
    if (method === "importCommit" && !lost) { lost = true; throw new Error("lost shared import reply"); }
    return result;
  });
  await expect(f.make().bringHome("first", 1, f.snapshot.id)).rejects.toThrow("lost shared import reply");
  const receipt = f.owners.get(f.snapshot.ownerId!)!.homeTransfer!.receipt;
  expect(receipt.phase).toBe("applying"); expect(f.placements.snapshot(f.snapshot.id)!.homeCommit).toBeNull();
  f.intercept(undefined);
  const result = await f.make().bringHome("second", 1, f.second.id);
  expect(f.owners.get(f.snapshot.ownerId!)!.homeTransfer!.receipt.id).toBe(receipt.id);
  expect(result.homeCommit).not.toBeNull(); expect(f.placements.snapshot(f.snapshot.id)!.homeCommit).toBe(result.homeCommit);
}, 60_000);

it("reuses a verified home import after the original maker is unavailable, without source SDK or native reads", async () => {
  const f = await fixture(); await f.make().bringHome("first", 1, f.snapshot.id);
  f.releaseSource(); const before = f.harness.experimental_hostRpcCalls.length;
  const result = await f.make().bringHome("second", 1, f.second.id);
  expect(result.homeCommit).not.toBeNull();
  expect(f.harness.experimental_hostRpcCalls.slice(before).every(call => call.hostId === "home")).toBe(true);
}, 60_000);

it.each(["exportChanges", "readBlob", "importChunk", "importCommit"] as const)("fences a late %s reply from a cancelled requester, then permits another live reference to recover", async target => {
  const f = await fixture(); let cancelled = false;
  f.intercept((method, _input, result) => { if (method === target && !cancelled) { cancelled = true; f.placements.cancel("first", 1); } return result; });
  await expect(f.make().bringHome("first", 1, f.snapshot.id)).rejects.toThrow(/generation|state|stale/i);
  expect(f.placements.snapshot(f.snapshot.id)!.homeCommit).toBeNull();
  expect(() => f.owners.beginRelease(f.snapshot.ownerId!, 1)).toThrow(/reference/i);
  f.intercept(undefined);
  expect((await f.make().bringHome("second", 1, f.second.id)).homeCommit).not.toBeNull();
}, 60_000);

it("refuses a tampered home ref during verified reuse instead of silently importing a replacement", async () => {
  const f = await fixture(); await f.make().bringHome("first", 1, f.snapshot.id);
  git(f.home, "update-ref", f.snapshot.homeRef, f.base);
  await expect(f.make().bringHome("second", 1, f.second.id)).rejects.toThrow(/ref-changed/);
  expect(git(f.home, "rev-parse", f.snapshot.homeRef)).toBe(f.base);
}, 60_000);

it("fences a changed home lifecycle during a verified import reconciliation", async () => {
  const f = await fixture(); await f.make().bringHome("first", 1, f.snapshot.id);
  f.intercept((method, _input, result) => { if (method === "importCommit") f.environments.get("home-env")!.lifecycle.phase = "retiring"; return result; });
  await expect(f.make().bringHome("second", 1, f.second.id)).rejects.toThrow(/lifecycle|active|retir/i);
  expect(f.placements.get("second")!.phase).toBe("reserved");
}, 60_000);

it("recovers an applying import after a lost result even when the original source is gone", async () => {
  const f = await fixture();
  f.intercept((method, _input, result) => { if (method === "importCommit") throw new Error("result lost"); return result; });
  await expect(f.make().bringHome("first", 1, f.snapshot.id)).rejects.toThrow("result lost");
  f.releaseSource(); f.intercept(undefined);
  const before = f.harness.experimental_hostRpcCalls.length;
  const result = await f.make().bringHome("second", 1, f.second.id);
  expect(result.homeCommit).not.toBeNull();
  expect(f.harness.experimental_hostRpcCalls.slice(before).every(call => call.hostId === "home")).toBe(true);
}, 60_000);

it("coalesces owner work across transport instances sharing the controller API", async () => {
  const f = await fixture();
  const [one, two] = await Promise.all([f.make().bringHome("first", 1, f.snapshot.id), f.make().bringHome("second", 1, f.second.id)]);
  expect(one.id).toBe(f.snapshot.id); expect(two.id).toBe(f.second.id);
  expect(f.harness.experimental_hostRpcCalls.filter(call => call.method === "readBlob")).toHaveLength(1);
}, 60_000);

it("fences a superseded private operation without clearing the replacement token", async () => {
  const f = await fixture();
  f.intercept((method, _input, result) => { if (method === "readBlob") f.owners.claimOperation(f.snapshot.ownerId!, 1, "replacement-operation"); return result; });
  await expect(f.make().bringHome("first", 1, f.snapshot.id)).rejects.toThrow(/operation/i);
  expect(f.owners.get(f.snapshot.ownerId!)!.operationToken).toBe("replacement-operation");
  expect(f.placements.snapshot(f.snapshot.id)!.homeCommit).toBeNull();
  f.intercept(undefined);
  expect((await f.make().bringHome("second", 1, f.second.id)).homeCommit).not.toBeNull();
  expect(f.owners.get(f.snapshot.ownerId!)!.operationToken).toBeNull();
}, 60_000);

it("refuses a changed owner lifecycle before accepting an in-flight native result", async () => {
  const f = await fixture();
  f.intercept((method, _input, result) => {
    if (method === "importCommit") f.db.prepare("UPDATE tavern_snapshot_owners SET data=json_set(data,'$.phase','releasing') WHERE id=?").run(f.snapshot.ownerId);
    return result;
  });
  await expect(f.make().bringHome("first", 1, f.snapshot.id)).rejects.toThrow(/lifecycle/i);
  expect(f.placements.snapshot(f.snapshot.id)!.homeCommit).toBeNull();
}, 60_000);

it.each(["blob", "count", "manifest"] as const)("rejects corrupt shared %s proof without pinning the owner", async corruption => {
  const f = await fixture();
  f.intercept((method, _input, result) => {
    if (corruption === "blob" && method === "readBlob") return { data: Buffer.from("wrong bytes").toString("base64") };
    if (corruption === "count" && method === "importChunk") return { size: 999 };
    if (corruption === "manifest" && method === "exportChanges") return { ...result as object, tree: "f".repeat(40) };
    return result;
  });
  await expect(f.make().bringHome("first", 1, f.snapshot.id)).rejects.toThrow(/blob|chunk|count|snapshot/i);
  expect(f.owners.get(f.snapshot.ownerId!)!.homeCommit).toBeNull();
}, 60_000);

it("fences a host worker exit before acknowledging its shared import result", async () => {
  const f = await fixture(), transport = f.make();
  f.intercept(async (method, _input, result) => { if (method === "importCommit") await f.harness.behavior.experimental_emitHostWorkerExit("home"); return result; });
  await expect(transport.bringHome("first", 1, f.snapshot.id)).rejects.toThrow(/worker exited/i);
  expect(f.owners.get(f.snapshot.ownerId!)!.homeCommit).toBeNull();
}, 60_000);
