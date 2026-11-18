// @vitest-environment node
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { hostContract, type HostOutput } from "../../src/host-contract";
import { createHostPort } from "../../src/host/client";
import { MIGRATIONS } from "../../src/server/migrations";
import { SourceCapture, requireSnapshotFetch } from "../../src/server/placement/capture";
import { DiscoveryStore } from "../../src/server/placement/discovery-store";
import { SourceDiscovery } from "../../src/server/placement/source-discovery";
import { PlacementStore } from "../../src/server/placement/store";
import { sourceSnapshotSchema } from "../../src/shared/placement";
import { sourceSnapshot } from "./placement-fixture";

type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
const hosts = new Set<ReturnType<typeof createFakePluginHost>>();
afterEach(async () => { for (const host of hosts) await host.harness.lifecycle.dispose(); hosts.clear(); });
const base = "a".repeat(40), head = "b".repeat(40), tree = "c".repeat(40);
const fetch = { via: "upstream" as const, remoteName: "upstream", remoteUrl: "ssh://git@example.com/team/repo.git",
  trackingRef: "refs/remotes/upstream/trunk", fetchRef: "refs/heads/trunk" };
function fixture() {
  const environment: Environment = { id: "source-env", projectId: "project", hostId: "source-host", path: "/source/checkout", status: "ready",
    hostLifecycle: "active", lifecycle: { phase: "active", retireAt: null, teardown: null }, isGitRepo: true, isWorktree: false,
    environmentProviderId: "checkout", environmentProviderInstanceKey: null, environmentProviderSelection: null,
    branchName: "feature", baseBranch: null, defaultBranch: null, mergeBaseBranch: null, name: "Source", managed: false,
    workspaceProvisionType: "unmanaged", createdAt: 1, updatedAt: 1 };
  const state: { environment: Environment; inspection: HostOutput<"inspect">; worktree: HostOutput<"worktreeState">; refusal?: { outcome: "unavailable"; code: string; message: string; retryable: boolean }; beforeState: () => void | Promise<void> } = {
    environment,
    inspection: { platform: "linux", home: "/source/home", tmp: ["/source/tmp"], piAgentDir: null, root: "/canonical/source",
      branch: "feature", head, tree, objectFormat: "sha1", linkedWorktree: false,
      sourceBase: { outcome: "ok", base, ...fetch }, features: { porcelain: true, exportChanges: true, objectImport: true } },
    worktree: { branch: "feature", head, tree, dirty: false, changed: ["work.ts"], unfinishedMerge: false }, beforeState: () => {},
  };
  const host = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, sdk: {
    threads: { get: async () => makeThreadResponse({ id: "keeper", projectId: "project", environmentId: "source-env" }) },
    environments: { get: async () => structuredClone(state.environment) },
  }, experimental_callHostRpc: async call => {
    if (call.method === "registerEndpoint") return { registered: true, generation: hostContract.registerEndpoint.input.parse(call.input).generation };
    if (call.method === "inspect") return structuredClone(state.inspection);
    if (call.method === "snapshotWorktree") {
      await state.beforeState();
      if (state.refusal) return state.refusal;
      if (state.worktree.unfinishedMerge) return { outcome: "unavailable", code: "unfinished-merge", message: "Resolve the unfinished merge", retryable: false };
      const dirty = state.worktree.dirty;
      return { head: state.worktree.head, headTree: state.worktree.tree, commit: dirty ? "d".repeat(40) : state.worktree.head,
        tree: dirty ? "e".repeat(40) : state.worktree.tree, includesUncommitted: dirty, modifiedPaths: dirty ? 1 : 0, untrackedPaths: dirty ? 1 : 0 };
    }
    throw new Error("Unexpected source mutation: " + call.method);
  } });
  hosts.add(host);
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join("\n"));
  const port = createHostPort(host.bb), discoveries = new DiscoveryStore(db), placements = new PlacementStore(db, () => 123);
  const discovery = new SourceDiscovery(host.bb, port, discoveries);
  const capture = new SourceCapture(discovery, port, placements);
  const known = async () => { const value = await discovery.inspect("keeper", "project"); if (value.state !== "known") throw new Error(value.message); return value; };
  const snapshots = () => db.prepare("SELECT count(*) AS n FROM tavern_source_snapshots").get();
  return { ...host, db, state, discoveries, placements, discovery, capture, known, snapshots };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("read-only initial source capture", () => {
  it("pins the actual source base, exact unpushed head/tree and safe native fetch provenance without inventing a submission", async () => {
    const f = fixture(), known = await f.known();
    const snapshot = await f.capture.initial(known);
    expect(snapshot).toMatchObject({ purpose: "initial", keeperThreadId: "keeper", projectId: "project",
      sourceThreadId: "keeper", makerThreadId: null, makerSubmissionId: null, journalTarget: null,
      base, sourceHead: head, tree, objectFormat: "sha1", fetch,
      source: { hostId: "source-host", environmentId: "source-env", root: "/canonical/source" },
      home: { hostId: "source-host", environmentId: "source-env", root: "/canonical/source" }, homeCommit: null, createdAt: 123 });
    expect(snapshot.homeRef).toMatch(/^refs\/tavern\/snapshots\//);
    expect(new PlacementStore(f.db).snapshot(snapshot.id)).toEqual(snapshot);
    const calls = f.harness.experimental_hostRpcCalls;
    expect(calls.map(call => [call.hostId, call.method])).toEqual([
      ["source-host", "registerEndpoint"], ["source-host", "inspect"], ["source-host", "snapshotWorktree"],
    ]);
    expect(calls[2].input).toMatchObject({ placementId: known.authorityId, generation: known.generation, endpointId: known.endpointId, base });
    expect(f.harness.inspection.sdk.calls.every(call => ["threads.get", "environments.get"].includes(call.path))).toBe(true);
    expect(f.db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 0 });
  });

  it("captures dirty user content with its real HEAD and origin without ever committing the checkout", async () => {
    const f = fixture(); f.state.worktree.dirty = true;
    expect(await f.capture.initial(await f.known())).toMatchObject({ includesUncommitted: true, userHead: head,
      sourceHead: "d".repeat(40), tree: "e".repeat(40), modifiedPaths: 1, untrackedPaths: 1,
      uncommittedOrigin: { hostId: "source-host", environmentId: "source-env", root: "/canonical/source" } });
    expect(f.harness.experimental_hostRpcCalls.map(call => call.method)).not.toContain("commitAll");
  });

  it("blocks unfinished merges with the exact snapshot reason", async () => {
    const f = fixture(); f.state.worktree.unfinishedMerge = true;
    await expect(f.capture.initial(await f.known())).rejects.toMatchObject({ code: "unfinished-merge", message: "Resolve the unfinished merge" });
    expect(f.snapshots()).toEqual({ n: 0 });
    expect(f.harness.experimental_hostRpcCalls.map(call => call.method)).not.toContain("commitAll");
  });

  it("keeps a retryable unavailable snapshot reason across the host contract", async () => {
    const f = fixture(); f.state.refusal = { outcome: "unavailable", code: "source-changed", message: "Source changed; retry", retryable: true };
    await expect(f.capture.initial(await f.known())).rejects.toMatchObject({ code: "source-changed", message: "Source changed; retry", retryable: true });
    expect(f.snapshots()).toEqual({ n: 0 });
  });

  it("blocks a zone-rooted source independently of source-base availability", async () => {
    const f = fixture(); f.state.inspection.features.exportChanges = false;
    await expect(f.capture.initial(await f.known())).rejects.toThrow(/repository root|source-root-required/i);
    expect(f.snapshots()).toEqual({ n: 0 });
    expect(f.harness.experimental_hostRpcCalls.map(call => call.method)).not.toContain("worktreeState");
  });

  it.each(["absent", "unavailable"])("blocks %s old-worker/source-base facts rather than using HEAD or a guessed branch", async fault => {
    const f = fixture();
    if (fault === "absent") delete f.state.inspection.sourceBase;
    else f.state.inspection.sourceBase = { outcome: "unavailable", code: "source-base-no-remote", message: "Choose a fetchable source", retryable: false };
    await expect(f.capture.initial(await f.known())).rejects.toThrow(/base|fetchable/i);
    expect(f.snapshots()).toEqual({ n: 0 });
  });

  it.each(["head", "tree"] as const)("rejects an inspected %s that changed before the clean-state observation", async key => {
    const f = fixture(); f.state.worktree[key] = "d".repeat(40);
    await expect(f.capture.initial(await f.known())).rejects.toThrow(/changed/i);
    expect(f.snapshots()).toEqual({ n: 0 });
  });

  it("refuses copied/mutated source proofs before host capture calls", async () => {
    const f = fixture(), known = await f.known();
    await expect(f.capture.initial({ ...known })).rejects.toThrow(/proof|issued/i);
    known.inspection.head = "d".repeat(40);
    await expect(f.capture.initial(known)).rejects.toThrow(/proof|changed/i);
    expect(f.harness.experimental_hostRpcCalls.map(call => call.method)).not.toContain("worktreeState");
  });

  it.each(["environment", "worker"])("fences a %s change while awaiting native state", async fault => {
    const f = fixture(), known = await f.known();
    f.state.beforeState = () => {
      if (fault === "environment") f.state.environment.path = "/changed";
      else f.discoveries.invalidateHost("source-host");
    };
    await expect(f.capture.initial(known)).rejects.toThrow(/changed|invalidated|stale/i);
    expect(f.snapshots()).toEqual({ n: 0 });
  });

  it("never saves a late reply after cancellation", async () => {
    const f = fixture(), known = await f.known(), waiting = deferred(), started = deferred(), controller = new AbortController();
    f.state.beforeState = () => { started.resolve(); return waiting.promise; };
    const pending = f.capture.initial(known, controller.signal);
    await started.promise; controller.abort(); waiting.resolve();
    await expect(pending).rejects.toThrow();
    expect(f.snapshots()).toEqual({ n: 0 });
  });

  it("retries exact capture idempotently and never rewrites pinned provenance", async () => {
    const f = fixture(), known = await f.known(), first = await f.capture.initial(known);
    const later = new SourceCapture(f.discovery, createHostPort(f.bb), new PlacementStore(f.db, () => 999));
    expect(await later.initial(known)).toEqual(first);
    f.state.inspection.sourceBase = { outcome: "ok", base, ...fetch, remoteUrl: "ssh://git@foreign.example/repo" };
    const next = await f.known();
    const changed = await f.capture.initial(next);
    expect(changed.id).not.toBe(first.id);
    expect(changed.ownerId).not.toBe(first.ownerId);
    expect(f.placements.snapshot(first.id)).toEqual(first);
  });
});

describe("snapshot fetch provenance", () => {
  it("preserves optional strict provenance while keeping old snapshots readable but not transportable", () => {
    const legacy = sourceSnapshot();
    expect(sourceSnapshotSchema.parse(legacy)).toEqual(legacy);
    expect(() => requireSnapshotFetch(legacy)).toThrow(/provenance|fetch/i);
    const current = sourceSnapshotSchema.parse({ ...legacy, fetch });
    expect(current.fetch).toEqual(fetch);
    expect(requireSnapshotFetch(current)).toEqual(fetch);
    expect(sourceSnapshotSchema.safeParse({ ...legacy, fetch: { ...fetch, unknown: true } }).success).toBe(false);
  });

  it("captures SHA-256 object identities without comparing them with SHA-1 values", async () => {
    const f = fixture(), base = "1".repeat(64), head = "2".repeat(64), tree = "3".repeat(64);
    f.state.inspection = { ...f.state.inspection, objectFormat: "sha256", head, tree, sourceBase: { outcome: "ok", base, ...fetch } };
    f.state.worktree = { ...f.state.worktree, head, tree };
    expect(await f.capture.initial(await f.known())).toMatchObject({ objectFormat: "sha256", base, sourceHead: head, tree });
  });

  it.each(["trackingRef", "fetchRef"])("rejects unsafe %s provenance", key => {
    for (const value of ["main", "refs/heads/../main", "refs/heads/a\nsecret", "refs/heads/a.lock", "refs/heads/a:b"]) {
      expect(sourceSnapshotSchema.safeParse({ ...sourceSnapshot(), fetch: { ...fetch, [key]: value } }).success).toBe(false);
    }
  });

  it("retains safe URL transport spelling, including SSH username and local host-owned paths", () => {
    for (const remoteUrl of ["git@example.com:team/repo.git", "ssh://git@example.com/team/repo.git", "https://example.com/team/repo.git", "/remote/owned/repo", "../repo"]) {
      expect(sourceSnapshotSchema.parse({ ...sourceSnapshot(), fetch: { ...fetch, remoteUrl } }).fetch?.remoteUrl).toBe(remoteUrl);
    }
  });

  it("validates the real HEAD against the snapshot object format", () => {
    expect(sourceSnapshotSchema.safeParse({ ...sourceSnapshot(), userHead: "f".repeat(64) }).success).toBe(false);
  });

  it("rejects credentials or query/fragment accidentally returned as fetch provenance", () => {
    for (const remoteUrl of ["https://token@example.com/repo", "https://u:p@example.com/repo", "ssh://git:password@example.com/repo", "https://example.com/repo?q=secret", "https://example.com/repo?", "ssh://git@example.com/repo#", "git@example.com:repo#secret"]) {
      expect(sourceSnapshotSchema.safeParse({ ...sourceSnapshot(), fetch: { ...fetch, remoteUrl } }).success).toBe(false);
    }
  });
});
