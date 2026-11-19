// @vitest-environment node
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { hostContract, type EndpointRegistration, type HostInput, type HostMethod, type HostOutput } from "../../src/host-contract";
import type { HostPort } from "../../src/host/client";
import { MIGRATIONS } from "../../src/server/migrations";
import { DiscoveryStore } from "../../src/server/placement/discovery-store";
import { SourceDiscovery } from "../../src/server/placement/source-discovery";
import { createFakePluginHost, makeThreadResponse } from "./host";

type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
const inspection: HostOutput<"inspect"> = {
  platform: "linux", home: "/guest/home", tmp: ["/guest/tmp"], piAgentDir: null,
  root: "/canonical/checkout", branch: "actual-branch", head: "1".repeat(40), tree: "2".repeat(40), objectFormat: "sha1",
  linkedWorktree: false, features: { porcelain: true, exportChanges: true, objectImport: true },
};
class ReadHost implements HostPort {
  calls: Array<{ hostId: string; method: HostMethod; input: HostInput<HostMethod>; signal?: AbortSignal }> = [];
  registrations = new Map<string, EndpointRegistration>();
  listeners = new Set<(event: { hostId: string }) => void>();
  beforeInspect: () => void | Promise<void> = () => {};
  result = inspection;
  async call<M extends HostMethod>(hostId: string, method: M, input: HostInput<M>, options?: { signal?: AbortSignal }): Promise<HostOutput<M>> {
    this.calls.push({ hostId, method, input: structuredClone(input), signal: options?.signal });
    let result: unknown;
    if (method === "registerEndpoint") {
      const registration = hostContract.registerEndpoint.input.parse(input);
      this.registrations.set(registration.placementId + ":" + registration.generation, registration);
      result = { registered: true, generation: registration.generation };
    } else if (method === "inspect") {
      const authority = hostContract.inspect.input.parse(input);
      expect(this.registrations.has(authority.placementId + ":" + authority.generation)).toBe(true);
      await this.beforeInspect();
      result = this.result;
    } else throw new Error("Unexpected mutating host operation: " + method);
    return hostContract[method].output.parse(result) as HostOutput<M>;
  }
  onWorkerExit(listener: (event: { hostId: string }) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  exit(hostId: string) { for (const listener of this.listeners) listener({ hostId }); }
}
function setup() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const env: Environment = {
    id: "env", projectId: "project", hostId: "guest", path: "/guest/checkout", status: "ready", hostLifecycle: "active",
    lifecycle: { phase: "active", retireAt: null, teardown: null }, isGitRepo: true, isWorktree: false,
    environmentProviderId: "vendor-workspace", environmentProviderInstanceKey: null, environmentProviderSelection: null,
    branchName: "stale-sdk-branch", baseBranch: null, defaultBranch: null, mergeBaseBranch: null,
    name: "Misleading desktop name", managed: false, workspaceProvisionType: "unmanaged", createdAt: 1, updatedAt: 1,
  };
  const state = { thread: makeThreadResponse({ id: "keeper", projectId: "project", environmentId: "env" }), env };
  const f = createFakePluginHost({ pluginId: "tavern", sdk: {
    threads: { get: async () => structuredClone(state.thread) },
    environments: { get: async () => structuredClone(state.env) },
  } });
  const store = new DiscoveryStore(db, () => 100), host = new ReadHost();
  const source = new SourceDiscovery(f.bb, host, store);
  cleanup.push(() => { source.dispose(); db.close(); });
  return { ...f, db, state, store, host, source };
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("controller-owned source discovery", () => {
  it("uses only actual SDK identity and explicit read-only host authority, with no local path probes or placement slots", async () => {
    const f = setup();
    const result = await f.source.inspect("keeper", "project");
    expect(result).toMatchObject({
      state: "known", keeperThreadId: "keeper", projectId: "project", environmentProviderId: "vendor-workspace",
      endpoint: { hostId: "guest", environmentId: "env", root: "/canonical/checkout" }, inspection,
    });
    expect(f.host.calls.map(call => [call.hostId, call.method])).toEqual([["guest", "registerEndpoint"], ["guest", "inspect"]]);
    const registration = f.host.calls[0].input;
    expect(registration).toMatchObject({
      placementId: f.store.get("keeper")!.authorityId, generation: 1,
      endpoint: { hostId: "guest", environmentId: "env", root: "/guest/checkout" }, ownerThreadId: null,
      access: "source-read", git: "full", workspaceKind: null, objectFormat: null, allowedRefs: [],
    });
    expect(f.db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT count(*) AS n FROM tavern_source_snapshots").get()).toEqual({ n: 0 });
    expect(f.host.calls.every(call => call.signal instanceof AbortSignal)).toBe(true);
  });

  it.each(["thread-project", "environment-project", "environment-id", "not-ready", "removed-host", "retiring", "no-path", "no-environment"] as const)("does not claim a source when SDK identity is %s", async fault => {
    const f = setup();
    if (fault === "thread-project") f.state.thread.projectId = "other";
    if (fault === "environment-project") f.state.env.projectId = "other";
    if (fault === "environment-id") f.state.env.id = "other";
    if (fault === "not-ready") f.state.env.status = "provisioning";
    if (fault === "removed-host") f.state.env.hostLifecycle = "removed";
    if (fault === "retiring") f.state.env.lifecycle.phase = "retiring";
    if (fault === "no-path") f.state.env.path = null;
    if (fault === "no-environment") f.state.thread.environmentId = null;
    expect(await f.source.inspect("keeper", "project")).toMatchObject({ state: "unavailable", code: "source-unavailable" });
    expect(f.host.calls).toEqual([]);
    expect(f.store.get("keeper")).toBeNull();
  });

  it("reports non-Git inspection as unavailable instead of claiming the SDK path is canonical", async () => {
    const f = setup();
    f.host.beforeInspect = () => { throw new Error("Not a Git repository"); };
    expect(await f.source.inspect("keeper", "project")).toMatchObject({ state: "unavailable", message: expect.stringContaining("Not a Git repository") });
    expect(f.store.get("keeper")).toMatchObject({ state: "invalidated", canonicalRoot: null });
  });

  it("reuses a pinned binding across controller reloads and refuses a changed canonical root", async () => {
    const f = setup();
    const first = await f.source.inspect("keeper", "project");
    expect(first.state).toBe("known");
    const next = new SourceDiscovery(f.bb, f.host, f.store);
    cleanup.push(() => next.dispose());
    expect(await next.inspect("keeper", "project")).toMatchObject({ state: "known", generation: 1 });
    f.host.result = { ...inspection, root: "/unexpected/root" };
    expect(await next.inspect("keeper", "project")).toMatchObject({ state: "unavailable", code: "source-changed" });
    expect(f.store.get("keeper")).toMatchObject({ state: "invalidated", canonicalRoot: "/canonical/checkout" });
  });

  it("fences an SDK environment change during inspection before publishing the source", async () => {
    const f = setup();
    f.host.beforeInspect = () => { f.state.thread.environmentId = "new-env"; };
    expect(await f.source.inspect("keeper", "project")).toMatchObject({ state: "unavailable", code: "source-changed" });
    expect(f.store.get("keeper")).toMatchObject({ state: "invalidated", canonicalRoot: null });
  });

  it("does not let an old failed call invalidate a newer SDK binding", async () => {
    const f = setup(), first = deferred(), started = deferred();
    let count = 0;
    f.host.beforeInspect = () => { if (count++ === 0) { started.resolve(); return first.promise; } };
    const old = f.source.inspect("keeper", "project");
    await started.promise;
    f.state.thread.environmentId = "new-env"; f.state.env.id = "new-env";
    const current = await f.source.inspect("keeper", "project");
    expect(current).toMatchObject({ state: "known", generation: 2 });
    first.reject(new Error("Old host disappeared"));
    expect(await old).toMatchObject({ state: "unavailable" });
    expect(f.store.get("keeper")).toMatchObject({ state: "current", generation: 2, endpoint: { environmentId: "new-env" } });
  });

  it("invalidates a worker's cached facts and refuses its prior proof", async () => {
    const f = setup(), known = await f.source.inspect("keeper", "project");
    if (known.state !== "known") throw new Error(known.message);
    f.host.exit("other-host");
    await f.source.revalidate(known);
    f.host.exit("guest");
    await expect(f.source.revalidate(known)).rejects.toThrow(/invalidated|stale/i);
    expect(await f.source.inspect("keeper", "project")).toMatchObject({ state: "known", generation: 3 });
  });

  it("never accepts a copied or mutated source proof, and rechecks actual SDK identity", async () => {
    const f = setup(), known = await f.source.inspect("keeper", "project");
    if (known.state !== "known") throw new Error(known.message);
    await expect(f.source.revalidate({ ...known })).rejects.toThrow(/issued|proof/i);
    known.endpoint.root = "/forged/root";
    await expect(f.source.revalidate(known)).rejects.toThrow(/changed|proof/i);
    const fresh = await f.source.inspect("keeper", "project");
    if (fresh.state !== "known") throw new Error(fresh.message);
    f.state.env.environmentProviderId = "changed-provider";
    await expect(f.source.revalidate(fresh)).rejects.toThrow(/source.*changed/i);
  });

  it("cancels/disposes without publishing late facts even if a host ignores cancellation", async () => {
    const f = setup(), waiting = deferred(), started = deferred();
    f.host.beforeInspect = () => { started.resolve(); return waiting.promise; };
    const pending = f.source.inspect("keeper", "project");
    await started.promise;
    f.source.dispose(); waiting.resolve();
    expect(await pending).toMatchObject({ state: "unavailable", code: "cancelled" });
    expect(f.host.listeners.size).toBe(0);
    expect(f.store.get("keeper")).toMatchObject({ state: "invalidated", canonicalRoot: null });
  });
});
