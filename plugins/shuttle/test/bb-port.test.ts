// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createBbPort, spawnErrorOf } from "../src/bb-port";
import { SpawnUnavailableError, UsageUnavailableError } from "../src/ports";

describe("bb port", () => {
  it("asks Burn what a thread used, and says Burn is not there when bb has no such plugin", async () => {
    const calls: unknown[] = [];
    let answer: () => unknown = () => ({ report: null, family: { children: [{ threadId: "thr_critic1", cost: 0.2 }] } });
    const host = createFakePluginHost({
      pluginId: "shuttle",
      sdk: {
        plugins: {
          callRpc: async (args: { pluginId: string; method: string; input: unknown; outputSchema: { parse(value: unknown): unknown } }) => {
            calls.push({ pluginId: args.pluginId, method: args.method, input: args.input });
            return args.outputSchema.parse(answer());
          },
        },
      } as never,
    });
    const port = createBbPort(host.bb);
    expect(await port.threadUsage("thr_review1")).toEqual({ usage: null, descendants: ["thr_critic1"] });
    expect(calls).toEqual([{ pluginId: "burn", method: "usage", input: { threadId: "thr_review1" } }]);
    answer = () => {
      throw Object.assign(new Error('HTTP 404: unknown plugin "burn"'), { status: 404 });
    };
    await expect(port.threadUsage("thr_review1")).rejects.toEqual(new UsageUnavailableError('unknown plugin "burn"'));
    answer = () => {
      throw Object.assign(new Error("HTTP 500: Burn could not read the session log"), { status: 500 });
    };
    await expect(port.threadUsage("thr_review1")).rejects.not.toBeInstanceOf(UsageUnavailableError);
  });

  it("builds what the page reads just before telling it PRs changed, once for a burst of changes", async () => {
    vi.useFakeTimers();
    try {
      const host = createFakePluginHost({ pluginId: "shuttle" });
      const order: string[] = [];
      vi.spyOn(host.bb.rpc, "experimental_invalidate").mockImplementation((tags) => void order.push(`invalidate ${[...(tags ?? [])].join(",")}`));
      const port = createBbPort(host.bb);
      port.beforePublish!(() => order.push("warm"));
      port.publish();
      port.publish(["prs"]);
      await vi.advanceTimersByTimeAsync(200);
      port.publish(["config"]);
      await vi.advanceTimersByTimeAsync(200);
      expect(order).toEqual(["warm", "invalidate prs,servers,conversation,boards", "invalidate config"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a worktree review on the machine with the project's default checkout", async () => {
    const spawned: unknown[] = [];
    const host = createFakePluginHost({
      pluginId: "shuttle",
      sdk: {
        projects: { get: async () => ({ id: "proj_1", name: "app", sources: [{ hostId: "host_other", isDefault: false }, { hostId: "host_main", isDefault: true }] }) },
        threads: { spawn: async (args: unknown) => (spawned.push(args), { id: "thr_new" }) },
      } as never,
    });
    const port = createBbPort(host.bb);
    const spawn = (workspace: Parameters<typeof port.spawnThread>[0]["workspace"]) => port.spawnThread({ projectId: "proj_1", title: "Review", prompt: "p", workspace, metadata: {} });
    await spawn({ kind: "worktree" });
    await spawn({ kind: "project-default" });
    await spawn({ kind: "provider", providerId: "my-trees", inputs: { tree: "shuttle-7" } });
    await spawn({ kind: "path", path: "/Users/me/src/trees/shuttle-7" });
    expect(spawned[0]).toMatchObject({ environment: { type: "host", hostId: "host_main", workspace: { type: "managed-worktree" } } });
    expect(spawned[1]).toMatchObject({ environment: { type: "project-default" } });
    expect(spawned[2]).toMatchObject({ environment: { type: "provider", environmentProviderId: "my-trees", inputs: { tree: "shuttle-7" }, machine: { type: "existing", hostId: "host_main" } } });
    expect(spawned[3]).toMatchObject({ environment: { type: "host", hostId: "host_main", workspace: { type: "unmanaged", path: "/Users/me/src/trees/shuttle-7" } } });
  });

  it("asks bb for a new machine from the workspace's machine provider, without looking for the project's checkout", async () => {
    const spawned: unknown[] = [];
    const host = createFakePluginHost({
      pluginId: "shuttle",
      sdk: {
        projects: { get: async () => { throw new Error("a new machine needs no checkout"); } },
        threads: { spawn: async (args: unknown) => (spawned.push(args), { id: "thr_new" }) },
      } as never,
    });
    const port = createBbPort(host.bb);
    await port.spawnThread({ projectId: "proj_1", title: "Review", prompt: "p", metadata: {}, workspace: { kind: "provider", providerId: "sandbox-checkout", inputs: { base: "main" }, machine: { providerId: "sandbox", inputs: { cores: 4 } } } });
    expect(spawned[0]).toMatchObject({ environment: { type: "provider", environmentProviderId: "sandbox-checkout", inputs: { base: "main" }, machine: { type: "new", machineProviderId: "sandbox", inputs: { cores: 4 } } } });
    // bb refuses any inputs, {} included, for a machine provider that takes none, and reads null as {} for one that takes some.
    await port.spawnThread({ projectId: "proj_1", title: "Review", prompt: "p", metadata: {}, workspace: { kind: "provider", providerId: "sandbox-checkout", inputs: {}, machine: { providerId: "plain", inputs: {} } } });
    expect((spawned[1] as { environment: unknown }).environment).toEqual({ type: "provider", environmentProviderId: "sandbox-checkout", inputs: {}, machine: { type: "new", machineProviderId: "plain", inputs: null } });
  });

  it("turns bb's refusals for a machine or environment it cannot start now into a wait, and keeps every other error", async () => {
    // As bb's SDK builds them: BbHttpError's message is "HTTP <status>: " and bb's own message.
    const refusal = (status: number, code: string, body: Record<string, unknown> = {}) => Object.assign(new Error(`HTTP ${status}: ${code}: no room`), { status, code, body });
    expect(spawnErrorOf(refusal(409, "machine_provider_rejected"))).toBeInstanceOf(SpawnUnavailableError);
    expect(spawnErrorOf(refusal(409, "environment_provider_rejected", { details: { availabilityStatus: "unavailable" } }))).toBeInstanceOf(SpawnUnavailableError);
    expect(spawnErrorOf(refusal(503, "busy", { retryable: true }))).toBeInstanceOf(SpawnUnavailableError);
    const bad = refusal(400, "invalid_request");
    expect(spawnErrorOf(bad)).toBe(bad);
    const setup = refusal(409, "environment_provider_rejected", { details: { availabilityStatus: "setup-required" } });
    expect(spawnErrorOf(setup)).toBe(setup);

    const host = createFakePluginHost({
      pluginId: "shuttle",
      sdk: { threads: { spawn: async () => { throw refusal(409, "machine_provider_rejected"); } } } as never,
    });
    const port = createBbPort(host.bb);
    const spawning = port.spawnThread({ projectId: "proj_1", title: "Review", prompt: "p", metadata: {}, workspace: { kind: "provider", providerId: "sandbox-checkout", inputs: {}, machine: { providerId: "sandbox", inputs: {} } } });
    await expect(spawning).rejects.toBeInstanceOf(SpawnUnavailableError);
    await expect(spawning).rejects.toThrow(/^machine_provider_rejected: no room$/u);
  });

  it("says when a thread's machine was removed, which bb cannot bring back", async () => {
    const thread = (id: string, environment: unknown) => ({ id, title: id, archivedAt: 1, projectId: "proj_1", status: "idle", environment });
    const threads: Record<string, unknown> = {
      thr_gone: thread("thr_gone", { hostLifecycle: "removed" }),
      thr_leaving: thread("thr_leaving", { hostLifecycle: "removing" }),
      thr_stuck: thread("thr_stuck", { hostLifecycle: "cleanup-failed" }),
      thr_here: thread("thr_here", { hostLifecycle: "active" }),
      thr_bare: thread("thr_bare", null),
    };
    const gets: unknown[] = [];
    const host = createFakePluginHost({ pluginId: "shuttle", sdk: { threads: { get: async (args: { threadId: string }) => (gets.push(args), threads[args.threadId]) } } as never });
    const port = createBbPort(host.bb);
    const removed = async (id: string) => (await port.getThread(id))!.machineRemoved;
    expect([await removed("thr_gone"), await removed("thr_leaving"), await removed("thr_stuck"), await removed("thr_here"), await removed("thr_bare")]).toEqual([true, true, true, false, false]);
    expect(gets[0]).toEqual({ threadId: "thr_gone", include: "environment" });
  });

  it("says whether bb set up a thread's workspace, and nothing when bb doesn't say", async () => {
    const threads: Record<string, unknown> = {
      thr_set: { id: "thr_set", title: "Set", archivedAt: null, projectId: "proj_1", status: "idle", environmentId: "env_1" },
      thr_failed: { id: "thr_failed", title: "Failed", archivedAt: null, projectId: "proj_1", status: "error", environmentId: null },
      thr_old: { id: "thr_old", title: "Old", archivedAt: null, projectId: "proj_1", status: "idle" },
    };
    const host = createFakePluginHost({ pluginId: "shuttle", sdk: { threads: { get: async (args: { threadId: string }) => threads[args.threadId] } } as never });
    const port = createBbPort(host.bb);
    const workspace = async (id: string) => (await port.getThread(id))!.hasWorkspace;
    expect([await workspace("thr_set"), await workspace("thr_failed"), await workspace("thr_old")]).toEqual([true, false, undefined]);
  });

  it("lists bb's environment providers, with the machine provider a composition starts, and its machine providers", async () => {
    const asked: unknown[] = [];
    const host = createFakePluginHost({
      pluginId: "shuttle",
      sdk: {
        environments: {
          listProviders: async (args?: unknown) => (asked.push(args), [
            { id: "git-worktree", displayName: "Git worktree", description: null, inputs: { type: "object" }, acceptsEmptyInputs: true, machineProviderId: null, availability: null },
            { id: "sandbox-full", displayName: "Sandbox with checkout", description: "A sandbox and its checkout", inputs: null, acceptsEmptyInputs: true, machineProviderId: "sandbox", availability: null },
          ]),
        },
        hosts: { experimental_listProviders: async () => [{ id: "sandbox", displayName: "Sandbox", description: "A sandbox", inputs: { type: "object" }, acceptsEmptyInputs: true }] },
      } as never,
    });
    const port = createBbPort(host.bb);
    expect(await port.environmentProviders()).toEqual([
      { id: "git-worktree", displayName: "Git worktree", description: null, inputs: { type: "object" }, machineProviderId: null },
      { id: "sandbox-full", displayName: "Sandbox with checkout", description: "A sandbox and its checkout", inputs: null, machineProviderId: "sandbox" },
    ]);
    // Every provider bb has: availability depends on a project and a machine, which a server does not have.
    expect(asked).toEqual([undefined]);
    expect(await port.machineProviders()).toEqual([{ id: "sandbox", displayName: "Sandbox", description: "A sandbox", inputs: { type: "object" } }]);
  });

  it("lists only unarchived threads, since bb otherwise fills the limit with archived ones", async () => {
    const lists: unknown[] = [];
    const host = createFakePluginHost({
      pluginId: "shuttle",
      sdk: { threads: { list: async (args: unknown) => (lists.push(args), [{ id: "thr_live", title: null, titleFallback: "Live", archivedAt: null, projectId: "proj_1", status: "idle" }]) } } as never,
    });
    const port = createBbPort(host.bb);
    expect(await port.listThreads(5000)).toMatchObject([{ id: "thr_live", title: "Live", archived: false }]);
    expect(lists).toEqual([{ archived: false, limit: 500, offset: 0 }]);
  });

  it("reads every page of live threads, since bb orders them by project and a recent one can sit on a late page", async () => {
    const all = Array.from({ length: 1203 }, (_, i) => ({ id: `thr_${i}`, title: `T${i}`, archivedAt: null, projectId: `proj_${i % 7}`, status: "idle" }));
    const lists: Array<{ limit: number; offset: number }> = [];
    const host = createFakePluginHost({
      pluginId: "shuttle",
      sdk: { threads: { list: async (args: { limit: number; offset: number }) => (lists.push(args), all.slice(args.offset, args.offset + args.limit)) } } as never,
    });
    const port = createBbPort(host.bb);
    const threads = await port.listThreads(5000);
    expect(threads).toHaveLength(1203);
    expect(threads.at(-1)!.id).toBe("thr_1202");
    expect(lists.map((args) => [args.offset, args.limit])).toEqual([[0, 500], [500, 500], [1000, 500]]);
    lists.length = 0;
    expect(await port.listThreads(700)).toHaveLength(700);
    expect(lists.map((args) => [args.offset, args.limit])).toEqual([[0, 500], [500, 200]]);
  });

  it("reads linked threads by id, archived or not, and asks nothing for none", async () => {
    const lists: unknown[] = [];
    const host = createFakePluginHost({
      pluginId: "shuttle",
      sdk: { threads: { list: async (args: unknown) => (lists.push(args), [{ id: "thr_old", title: "Old", archivedAt: 1, projectId: null, status: "idle" }]) } } as never,
    });
    const port = createBbPort(host.bb);
    expect(await port.threadsById([])).toEqual([]);
    expect(await port.threadsById(["thr_old", "thr_gone"])).toMatchObject([{ id: "thr_old", archived: true }]);
    expect(lists).toEqual([{ threadIds: ["thr_old", "thr_gone"], limit: 2 }]);
  });
});
