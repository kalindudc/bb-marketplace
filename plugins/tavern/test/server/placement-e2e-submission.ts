import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { execFileSync } from "node:child_process";
import { realGit } from "../host/emulated-git";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { hostContract, type HostMethod } from "../../src/host-contract";
import { createHostPort } from "../../src/host/client";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { pushedBase } from "../../src/host/pushed-base";
import { snapshotWorktree } from "../../src/host/snapshot";
import { createTransport } from "../../src/host/transport";
import { createArtifacts } from "../../src/host/artifacts";
import { AwayHolds } from "../../src/server/away/holds";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { PlacementStore } from "../../src/server/placement/store";
import { PlacementSubmissions } from "../../src/server/placement/submission";
import { PlacementTransport } from "../../src/server/placement/transport";
import { journalEntrySchema, memberSchema } from "../../src/shared/schema";
import { placementRecord } from "./placement-fixture";

export const submissionGit = (root: string, ...args: string[]) => execFileSync(realGit, ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export async function submissionFixture(format: "sha1" | "sha256" = "sha1") {
  const git = submissionGit, root = realpathSync(mkdtempSync(join(tmpdir(), "submission-")));
  const home = join(root, "home"), maker = join(root, "maker"), storage = join(root, "storage"); mkdirSync(home); mkdirSync(storage);
  git(home, "init", "-qb", "main", "--object-format=" + format); git(home, "config", "user.name", "Fixture"); git(home, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(home, "tracked"), "base\n"); writeFileSync(join(home, ".gitignore"), "ignored\n");
  git(home, "add", "-A"); git(home, "commit", "-qm", "base"); const base = git(home, "rev-parse", "HEAD");
  git(home, "clone", "-q", "--no-hardlinks", home, maker);
  writeFileSync(join(maker, "tracked"), "submitted\n"); writeFileSync(join(maker, "untracked"), "submitted new file\n"); writeFileSync(join(maker, "ignored"), "not declared\n");
  type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
  const endpoint = (side: "home" | "maker") => ({ hostId: side, environmentId: side + "-env", root: side === "home" ? home : maker });
  const environments = new Map<string, Environment>();
  for (const side of ["home", "maker"] as const) environments.set(side + "-env", {
    id: side + "-env", projectId: "project", hostId: side, path: endpoint(side).root, status: "ready", hostLifecycle: "active", lifecycle: { phase: "active", retireAt: null, teardown: null },
    isGitRepo: true, isWorktree: false, environmentProviderId: "checkout", environmentProviderInstanceKey: null, environmentProviderSelection: null,
    branchName: "main", baseBranch: null, defaultBranch: null, mergeBaseBranch: null, name: side, managed: false, workspaceProvisionType: "unmanaged", createdAt: 1, updatedAt: 1,
  });
  const registries = new Map<string, HostRegistry>();
  for (const side of ["home", "maker", "storage"]) { const data = join(root, side + "-native"); mkdirSync(data); registries.set(side, new HostRegistry(data)); }
  const state = { status: "idle" as "idle" | "active", updatedAt: 1, intercept: undefined as undefined | ((method: HostMethod) => void | Promise<void>) };
  const stop = vi.fn(async () => ({ ok: true as const }));
  const host = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, sdk: {
    threads: { stop, queuedMessages: { list: async () => [], delete: async () => ({ ok: true as const }) }, get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "project", environmentId: threadId === "maker" ? "maker-env" : "home-env", status: threadId === "maker" ? state.status : "idle", updatedAt: state.updatedAt }) },
    environments: { get: async ({ environmentId }) => structuredClone(environments.get(environmentId)!) },
  }, experimental_callHostRpc: async call => {
    const registry = registries.get(call.hostId!)!;
    let result: unknown;
    if (call.method === "registerEndpoint") result = registry.registerEndpoint(hostContract.registerEndpoint.input.parse(call.input));
    else if (call.method === "releaseEndpoint") result = registry.releaseEndpoint(hostContract.releaseEndpoint.input.parse(call.input));
    else if (["inspectArtifacts", "readArtifact", "artifactChunk", "finishArtifact"].includes(call.method)) {
      const artifacts = createArtifacts(registry), method = call.method as keyof typeof artifacts;
      result = await (artifacts[method] as (input: unknown, signal?: AbortSignal) => Promise<unknown>)(call.input, call.signal);
    }
    else if (call.method === "inspect") result = await inspectHost(registry, hostContract.inspect.input.parse(call.input), call.signal);
    else if (call.method === "registerTransfer") result = registry.registerTransfer(hostContract.registerTransfer.input.parse(call.input));
    else if (call.method === "pushedBase") result = await pushedBase(registry, hostContract.pushedBase.input.parse(call.input), call.signal);
    else if (call.method === "snapshotWorktree") result = await snapshotWorktree(registry, hostContract.snapshotWorktree.input.parse(call.input), call.signal);
    else {
      const transport = createTransport(registry), method = call.method as keyof typeof transport;
      if (!(method in transport)) throw new Error("Unexpected method " + call.method);
      result = await (transport[method] as (input: unknown, signal?: AbortSignal) => Promise<unknown>)(call.input, call.signal);
    }
    await state.intercept?.(call.method as HostMethod);
    return result;
  } });
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join("\n"));
  const keepers = new KeeperStore(db), placements = new PlacementStore(db), port = createHostPort(host.bb), rows = new AwayHolds(db);
  keepers.put("members", "maker", memberSchema.parse({ threadId: "maker", classId: "smith", characterId: null, displayName: "Vale", role: "member", keeperThreadId: "keeper", boardQuestId: "quest", waypointId: "waypoint", errand: false, title: "Implement", place: "table", state: "idle", doing: null, createdAt: 1, lastActiveAt: 1, lastReportAt: null, strikes: 0, verifiedWins: 0 }));
  const actor = { kind: "agent", threadId: "maker" };
  const entries = ["00", "01"].map((id, order) => journalEntrySchema.parse({ threadId: "maker", id, parentId: null, description: "Implement " + id, status: "done", owner: null, note: null, evidence: [{ kind: "file", ref: "tracked", detail: "", exitCode: null }], link: { boardQuestId: "quest", waypointId: "waypoint" }, order, createdAt: 1, updatedAt: 1, createdBy: actor, updatedBy: actor }));
  const journal = { prepare: vi.fn(async () => {}), get: () => ({ entries }) };
  const holds = {
    requestContentHold: vi.fn((threadId: string, identity: { operationId: string; idleOnly?: boolean }) => rows.requestContent({ threadId, keeperThreadId: "keeper", questId: "quest", heldAt: 1, cancelledBrief: null }, identity.operationId, identity.idleOnly)),
    inspectHeld: (token: Parameters<AwayHolds["findContent"]>[0]) => { const hold = rows.findContent(token); return { state: !hold ? "stale" as const : hold.stopPending ? "pending" as const : "confirmed" as const, error: null }; },
    confirmHeld: vi.fn(async (token: Parameters<AwayHolds["findContent"]>[0]) => { const row = rows.findContent(token)!; if (state.status === "idle") rows.compareAndSet(row, { stopPending: false }); return holds.inspectHeld(token); }),
    finishContentHold: vi.fn((token: Parameters<AwayHolds["findContent"]>[0]) => ({ state: rows.finishContent(token) ? "finished" as const : "stale" as const })),
  };
  const original = placements.captureSnapshot({ purpose: "initial", keeperThreadId: "keeper", projectId: "project", sourceThreadId: "keeper", makerThreadId: null, makerSubmissionId: null, journalTarget: null,
    objectFormat: format, base, sourceHead: base, tree: git(home, "rev-parse", "HEAD^{tree}"),
    fetch: { via: "upstream", remoteName: "origin", remoteUrl: home, trackingRef: "refs/remotes/origin/main", fetchRef: "refs/heads/main" }, source: endpoint("home"), home: endpoint("home") });
  const draft = placementRecord({ sourceSnapshotId: original.id, memberThreadId: "maker", ownsNewMachine: true, workspaceKind: "dedicated-machine", posture: { ...placementRecord().posture, aggregate: "remote-detection-only" } });
  placements.reserve(draft, { maxMakers: 2, maxCheckers: 2 });
  placements.update(draft.id, 1, value => ({ ...value, phase: "running", hostId: "maker", environmentId: "maker-env", root: maker }));
  const submissions = new PlacementSubmissions(host.bb, port, placements, holds, keepers, journal, new PlacementTransport(host.bb, port, placements));
  const close = async () => { await host.harness.lifecycle.dispose(); rmSync(root, { recursive: true, force: true }); };
  return { ...host, home, maker, storage, base, entries, state, submissions, placements, keepers, holds, stop, close, port, journal, registries };
}

export async function proveSubmissionStage() {
  const f = await submissionFixture();
  try {
    const before = readFileSync(join(f.maker, ".git/index"));
    const result = await f.submissions.capture("maker", "waypoint");
    expect(result.state).toBe("captured"); if (result.state !== "captured") throw new Error("Expected idle maker capture");
    const snapshot = result.snapshot;
    expect(snapshot.homeCommit).not.toBeNull(); expect(submissionGit(f.home, "rev-parse", snapshot.homeRef + "^{tree}")).toBe(snapshot.tree);
    expect(submissionGit(f.home, "show", snapshot.homeRef + ":tracked")).toBe("submitted");
    expect(submissionGit(f.home, "show", snapshot.homeRef + ":untracked")).toBe("submitted new file");
    expect(submissionGit(f.home, "ls-tree", "--name-only", snapshot.homeRef)).not.toContain("\nignored");
    expect(readFileSync(join(f.maker, ".git/index"))).toEqual(before); expect(submissionGit(f.maker, "rev-parse", "HEAD")).toBe(f.base);
    expect(result.reviewTarget.journalTargets).toHaveLength(2);
    expect(f.placements.byMember("maker")!.posture.aggregate).toBe("remote-detection-only");
    expect(f.stop).not.toHaveBeenCalled(); expect(f.holds.finishContentHold).toHaveBeenCalledOnce();
  } finally { await f.close(); }
}
