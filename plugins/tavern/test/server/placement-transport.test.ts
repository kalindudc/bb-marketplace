// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { placementRecordSchema, sourceTransferReceiptSchema } from "../../src/shared/placement";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";
import { CHUNK_BYTES, hostContract, type HostMethod } from "../../src/host-contract";
import { createHostPort } from "../../src/host/client";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { createTransport } from "../../src/host/transport";
import { MIGRATIONS } from "../../src/server/migrations";
import { PlacementStore } from "../../src/server/placement/store";
import { PlacementTransport } from "../../src/server/placement/transport";
import { placementRecord, sourceSnapshot } from "./placement-fixture";
import { gitFixtureTemplate } from "../git-fixture-template";

const roots: string[] = [], hosts = new Set<ReturnType<typeof createFakePluginHost>>();
afterEach(async () => {
  for (const host of hosts) await host.harness.lifecycle.dispose(); hosts.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
const seedRepos = gitFixtureTemplate((root, format: "sha1" | "sha256", binarySize: number) => {
  const home = join(root, "home"), source = join(root, "source"); mkdirSync(home);
  git(home, "init", "-q", "-b", "main", "--object-format=" + format); git(home, "config", "user.name", "Fixture"); git(home, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(home, "tracked"), "base\n"); writeFileSync(join(home, "gone"), "remove me\n"); git(home, "add", "-A"); git(home, "commit", "-qm", "base");
  const base = git(home, "rev-parse", "HEAD");
  git(home, "clone", "-q", "--no-hardlinks", home, source); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "tracked"), "unpushed\n"); unlinkSync(join(source, "gone"));
  writeFileSync(join(source, "binary"), Buffer.alloc(binarySize, 0xa7)); symlinkSync("tracked", join(source, "link"));
  writeFileSync(join(source, "empty"), ""); writeFileSync(join(source, "executable"), "#!/bin/sh\n", { mode: 0o755 });
  git(source, "add", "-A"); git(source, "commit", "-qm", "snapshot");
  const head = git(source, "rev-parse", "HEAD"), tree = git(source, "rev-parse", "HEAD^{tree}");
  return { base, head, tree };
});
async function fixture(format: "sha1" | "sha256" = "sha1", binarySize = 32) {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "placement-transport-")); roots.push(root);
  const home = join(root, "home"), source = join(root, "source");
  const { base, head, tree } = seedRepos(root, format, binarySize);
  git(source, "remote", "set-url", "origin", home);
  const endpoint = (side: "source" | "home") => ({ hostId: side + "-host", environmentId: side + "-env", root: side === "source" ? source : home });
  const environments = new Map<string, Environment>();
  for (const side of ["source", "home"] as const) environments.set(side + "-env", {
    id: side + "-env", projectId: "project", hostId: side + "-host", path: endpoint(side).root, status: "ready", hostLifecycle: "active",
    lifecycle: { phase: "active", retireAt: null, teardown: null }, isGitRepo: true, isWorktree: false,
    environmentProviderId: "checkout", environmentProviderInstanceKey: null, environmentProviderSelection: null,
    branchName: "main", baseBranch: null, defaultBranch: null, mergeBaseBranch: null, name: side, managed: false,
    workspaceProvisionType: "unmanaged", createdAt: 1, updatedAt: 1,
  });
  const registries = new Map<string, HostRegistry>();
  for (const side of ["source", "home"]) { const data = join(root, side + "-data"); mkdirSync(data); registries.set(side + "-host", new HostRegistry(data)); }
  let intercept: ((method: HostMethod, input: unknown, result: unknown) => unknown | Promise<unknown>) | undefined;
  const host = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, sdk: {
    threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "project", environmentId: threadId === "keeper" ? "home-env" : "source-env" }) },
    environments: { get: async ({ environmentId }) => environments.get(environmentId)! },
  }, experimental_callHostRpc: async call => {
    const registry = registries.get(call.hostId!)!;
    let result: unknown;
    if (call.method === "registerEndpoint") result = registry.registerEndpoint(hostContract.registerEndpoint.input.parse(call.input));
    else if (call.method === "registerTransfer") result = registry.registerTransfer(hostContract.registerTransfer.input.parse(call.input));
    else if (call.method === "inspect") result = await inspectHost(registry, hostContract.inspect.input.parse(call.input), call.signal);
    else {
      const transport = createTransport(registry), method = call.method as keyof typeof transport;
      if (!(method in transport)) throw new Error("Unexpected method " + call.method);
      const invoke = transport[method] as (input: unknown, signal?: AbortSignal) => Promise<unknown>;
      result = await invoke(call.input, call.signal);
    }
    return intercept ? intercept(call.method as HostMethod, call.input, result) : result;
  } }); hosts.add(host);
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join(";\n"));
  const placements = new PlacementStore(db), port = createHostPort(host.bb);
  placements.reserve(placementRecord({ memberThreadId: "maker", sourceSnapshotId: "snapshot", hostId: "source-host", environmentId: "source-env", root: source }), { maxMakers: 2, maxCheckers: 2 });
  const snapshot = sourceSnapshot({ purpose: "wip", sourceThreadId: "maker", makerThreadId: "maker", objectFormat: format, base, sourceHead: head, tree,
    source: endpoint("source"), home: endpoint("home"), fetch: { via: "upstream", remoteName: "origin", remoteUrl: home, trackingRef: "refs/remotes/origin/main", fetchRef: "refs/heads/main" } });
  placements.saveSnapshot(snapshot);
  const make = () => new PlacementTransport(host.bb, port, placements);
  return { ...host, db, placements, port, environments, registries, make, home, source, base, head, tree, snapshot,
    intercept: (fn: typeof intercept) => { intercept = fn; } };
}

it.each(["sha1", "sha256"] as const)("brings exact %s source home through the official fake host, preserving the user index/worktree and durable retries", async format => {
  const f = await fixture(format, CHUNK_BYTES + 19);
  writeFileSync(join(f.home, "tracked"), "user staged work\n"); git(f.home, "add", "tracked");
  const index = readFileSync(join(f.home, ".git/index")), refs = git(f.source, "show-ref");
  const result = await f.make().bringHome("placement", 1, "snapshot");
  expect(result.homeCommit).not.toBeNull(); expect(git(f.home, "rev-parse", result.homeRef + "^{tree}")).toBe(f.tree);
  expect(readFileSync(join(f.home, ".git/index"))).toEqual(index); expect(readFileSync(join(f.home, "tracked"), "utf8")).toBe("user staged work\n");
  expect(git(f.source, "show-ref")).toBe(refs); expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
  expect(git(f.home, "ls-tree", result.homeRef, "empty", "executable", "link")).toContain("100755");
  expect(git(f.home, "cat-file", "-s", result.homeRef + ":empty")).toBe("0");
  expect(git(f.home, "ls-tree", result.homeRef, "link")).toContain("120000");
  expect(f.placements.get("placement")!.transfers).toMatchObject([{ phase: "verified", snapshotId: "snapshot", homeCommit: result.homeCommit }]);
  expect(await f.make().bringHome("placement", 1, "snapshot")).toEqual(result);
  expect(f.placements.get("placement")!.phase).toBe("reserved");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  const imports = f.harness.experimental_hostRpcCalls.filter(call => call.method === "importCommit");
  expect(imports.length).toBeGreaterThan(0); expect(imports[0]!.input).toMatchObject({ baseBranch: "refs/heads/main", remote: f.home });
}, 60_000);

it("pins an actual initial source on the Keeper host without a fabricated maker submission", async () => {
  const f = await fixture();
  f.placements.saveSnapshot(sourceSnapshot({ id: "initial", base: f.base, sourceHead: f.base, tree: git(f.home, "rev-parse", "HEAD^{tree}"),
    source: f.snapshot.home, home: f.snapshot.home, fetch: f.snapshot.fetch }));
  f.placements.update("placement", 1, record => ({ ...record, sourceSnapshotId: "initial" }));
  const result = await f.make().bringHome("placement", 1, "initial");
  expect(result).toMatchObject({ purpose: "initial", makerThreadId: null, makerSubmissionId: null, journalTarget: null });
  expect(result.homeCommit).not.toBeNull(); expect(git(f.home, "rev-parse", "HEAD")).toBe(f.base);
  expect(git(f.home, "status", "--porcelain")).toBe("");
}, 60_000);

it("coalesces duplicate in-process requests without multiplying transfers", async () => {
  const f = await fixture(), transport = f.make();
  const one = transport.bringHome("placement", 1, "snapshot"), two = transport.bringHome("placement", 1, "snapshot");
  expect(one).toBe(two); await Promise.all([one, two]);
  expect(f.placements.get("placement")!.transfers).toHaveLength(1);
  expect(f.harness.experimental_hostRpcCalls.filter(call => call.method === "importCommit")).toHaveLength(1);
}, 60_000);

it("keeps receipts strict, optional for old records, private to backups, and persistent after reload", async () => {
  const f = await fixture(); expect(f.placements.get("placement")).not.toHaveProperty("transfers");
  await f.make().bringHome("placement", 1, "snapshot");
  const record = new PlacementStore(f.db).get("placement")!, receipt = record.transfers![0]!;
  expect(sourceTransferReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(sourceTransferReceiptSchema.safeParse({ ...receipt, madeUpAuthority: true }).success).toBe(false);
  expect(sourceTransferReceiptSchema.safeParse({ ...receipt, phase: "verified", homeCommit: null }).success).toBe(false);
  expect(sourceTransferReceiptSchema.safeParse({ ...receipt, manifest: null }).success).toBe(false);
  expect(placementRecordSchema.safeParse({ ...record, transfers: [receipt, receipt] }).success).toBe(false);
  for (const io of ["input", "output"] as const) expect(() => z.toJSONSchema(placementRecordSchema, { io })).not.toThrow();
  const backups = new BackupRecords(f.db, new SettingsStore(f.db)), captured = backups.capture();
  expect(captured.tables).not.toHaveProperty("tavern_placements"); expect(captured.tables).not.toHaveProperty("tavern_source_snapshots");
  const forged = structuredClone(captured);
  forged.tables.tavern_placements = { columns: ["id", "data", "scope_delivery_json"], rows: [{ id: record.id, data: JSON.stringify(record), scope_delivery_json: null }] };
  const target = createFakePluginHost({ pluginId: "tavern" }); hosts.add(target);
  const db = target.bb.storage.database(); db.exec(MIGRATIONS.join(";\n"));
  expect(() => new BackupRecords(db, new SettingsStore(db)).restore(forged)).toThrow(/not a Tavern records table/);
  expect(() => backups.restore(captured)).toThrow(/empty/);
}, 60_000);

it("persists the immutable manifest before upload and reconciles a lost import reply after restart", async () => {
  const f = await fixture(); let lost = false;
  f.intercept((method, _input, result) => {
    if (method === "importChunk") expect(f.placements.get("placement")!.transfers![0]!.manifest).not.toBeNull();
    if (method === "importCommit" && !lost) { lost = true; throw new Error("lost reply"); } return result;
  });
  await expect(f.make().bringHome("placement", 1, "snapshot")).rejects.toThrow("lost reply");
  expect(f.placements.snapshot("snapshot")!.homeCommit).toBeNull();
  const receipt = f.placements.get("placement")!.transfers![0]!;
  expect(receipt.phase).toBe("applying");
  f.intercept(undefined);
  await f.make().bringHome("placement", 1, "snapshot");
  expect(f.placements.get("placement")!.transfers![0]!.id).toBe(receipt.id);
  expect(f.placements.get("placement")!.transfers![0]!.phase).toBe("verified");
}, 60_000);

it("replays completed multi-chunk uploads after a lost chunk reply without mistaking total size for range size", async () => {
  const f = await fixture("sha1", CHUNK_BYTES + 19); let interrupted = false;
  f.intercept((method, input, result) => {
    if (method === "importChunk" && (input as { offset: number }).offset === CHUNK_BYTES && !interrupted) { interrupted = true; throw new Error("lost final chunk reply"); }
    return result;
  });
  await expect(f.make().bringHome("placement", 1, "snapshot")).rejects.toThrow("lost final chunk reply");
  expect(f.placements.snapshot("snapshot")!.homeCommit).toBeNull();
  f.intercept(undefined);
  const result = await f.make().bringHome("placement", 1, "snapshot");
  expect(git(f.home, "rev-parse", result.homeRef + "^{tree}")).toBe(f.tree);
}, 60_000);

it.each(["exportChanges", "readBlob", "importChunk", "importCommit"] as const)("fences cancellation after %s without publishing a pin or ready state", async target => {
  const f = await fixture(); let cancelled = false;
  f.intercept((method, _input, result) => { if (method === target && !cancelled) { cancelled = true; f.placements.cancel("placement", 1); } return result; });
  await expect(f.make().bringHome("placement", 1, "snapshot")).rejects.toThrow(/generation|state|stale/i);
  expect(f.placements.snapshot("snapshot")!.homeCommit).toBeNull();
  expect(f.placements.get("placement")!.desiredState).toBe("released");
}, 60_000);

it("rejects changed SDK endpoints after an await before sending another native call", async () => {
  const f = await fixture();
  f.intercept((method, _input, result) => { if (method === "exportChanges") f.environments.get("source-env")!.hostId = "replacement-host"; return result; });
  await expect(f.make().bringHome("placement", 1, "snapshot")).rejects.toThrow(/identity|endpoint|changed/i);
  expect(f.harness.experimental_hostRpcCalls.some(call => call.method === "importChunk")).toBe(false);
  expect(f.placements.snapshot("snapshot")!.homeCommit).toBeNull();
}, 60_000);

it("refuses legacy provenance and foreign snapshot ownership before native requests", async () => {
  const f = await fixture();
  f.placements.saveSnapshot(sourceSnapshot({ id: "foreign", keeperThreadId: "another" }));
  await expect(f.make().bringHome("placement", 1, "foreign")).rejects.toThrow(/ownership|keeper|snapshot/i);
  f.placements.saveSnapshot(sourceSnapshot({ id: "legacy" }));
  f.placements.update("placement", 1, record => ({ ...record, sourceSnapshotId: "legacy" }));
  await expect(f.make().bringHome("placement", 1, "legacy")).rejects.toThrow(/provenance/i);
  expect(f.harness.experimental_hostRpcCalls).toEqual([]);
});

it.each(["blob", "count", "manifest", "format"] as const)("refuses corrupt %s proof without pinning", async corruption => {
  const f = await fixture();
  f.intercept((method, _input, result) => {
    if (corruption === "blob" && method === "readBlob") { const value = result as { data: string }; const bytes = Buffer.from(value.data, "base64"); if (bytes.length) bytes[0] ^= 1; return { data: bytes.toString("base64") }; }
    if (corruption === "count" && method === "importChunk") return { size: 99 };
    if (corruption === "manifest" && method === "exportChanges") return { ...result as object, tree: "f".repeat(40) };
    if (corruption === "format" && method === "inspect") return { ...result as object, objectFormat: "sha256", sourceBase: { outcome: "unavailable", code: "fixture", message: "No base in this fixture", retryable: false } };
    return result;
  });
  await expect(f.make().bringHome("placement", 1, "snapshot")).rejects.toThrow(/hash|byte count|snapshot|format/i);
  expect(f.placements.snapshot("snapshot")!.homeCommit).toBeNull();
}, 60_000);

it("does not pin a fabricated successful import receipt that cannot be re-exported natively", async () => {
  const f = await fixture();
  f.intercept((method, _input, result) => method === "importCommit" ? { outcome: "ok", sha: "f".repeat(40) } : result);
  await expect(f.make().bringHome("placement", 1, "snapshot")).rejects.toThrow();
  expect(f.placements.snapshot("snapshot")!.homeCommit).toBeNull();
}, 60_000);

it("revalidates verified private refs instead of trusting a completed controller receipt", async () => {
  const f = await fixture(); await f.make().bringHome("placement", 1, "snapshot");
  git(f.home, "update-ref", f.snapshot.homeRef, f.base);
  await expect(f.make().bringHome("placement", 1, "snapshot")).rejects.toThrow(/ref-changed/);
}, 60_000);

it("fences a worker exit before accepting its in-flight reply", async () => {
  const f = await fixture(), transport = f.make();
  f.intercept(async (method, _input, result) => { if (method === "exportChanges") await f.harness.behavior.experimental_emitHostWorkerExit("source-host"); return result; });
  await expect(transport.bringHome("placement", 1, "snapshot")).rejects.toThrow(/worker exited/i);
  expect(f.placements.snapshot("snapshot")!.homeCommit).toBeNull();
}, 60_000);

it("fences a changed placement source assignment around an await", async () => {
  const f = await fixture();
  f.intercept((method, _input, result) => { if (method === "exportChanges") f.placements.update("placement", 1, record => ({ ...record, sourceSnapshotId: "new-source" })); return result; });
  await expect(f.make().bringHome("placement", 1, "snapshot")).rejects.toThrow(/assignment|changed|source/i);
  expect(f.placements.snapshot("snapshot")!.homeCommit).toBeNull();
}, 60_000);

it("refuses a changed native manifest on retry rather than changing transfer grants", async () => {
  const f = await fixture();
  f.intercept((method, _input, result) => { if (method === "importChunk") throw new Error("interrupted upload"); return result; });
  await expect(f.make().bringHome("placement", 1, "snapshot")).rejects.toThrow("interrupted upload");
  f.intercept((method, _input, result) => method === "exportChanges" ? { ...result as object, message: "changed metadata" } : result);
  await expect(f.make().bringHome("placement", 1, "snapshot")).rejects.toThrow(/manifest/i);
}, 60_000);
