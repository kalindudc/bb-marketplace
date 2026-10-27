// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createBbPort } from "../src/bb-port";

describe("bb port", () => {
  it("creates a worktree review on the machine with the project's default checkout", async () => {
    const spawned: unknown[] = [];
    const host = createFakePluginHost({
      pluginId: "shuttle",
      sdk: {
        projects: { get: async () => ({ id: "proj_1", name: "world", sources: [{ hostId: "host_other", isDefault: false }, { hostId: "host_main", isDefault: true }] }) },
        threads: { spawn: async (args: unknown) => (spawned.push(args), { id: "thr_new" }) },
      } as never,
    });
    const port = createBbPort(host.bb);
    const spawn = (workspace: Parameters<typeof port.spawnThread>[0]["workspace"]) => port.spawnThread({ projectId: "proj_1", title: "Review", prompt: "p", workspace, metadata: {} });
    await spawn({ kind: "worktree" });
    await spawn({ kind: "project-default" });
    await spawn({ kind: "provider", providerId: "world-tree", inputs: { tree: "shuttle-7" } });
    await spawn({ kind: "path", path: "/Users/me/world/trees/shuttle-7/src" });
    expect(spawned[0]).toMatchObject({ environment: { type: "host", hostId: "host_main", workspace: { type: "managed-worktree" } } });
    expect(spawned[1]).toMatchObject({ environment: { type: "project-default" } });
    expect(spawned[2]).toMatchObject({ environment: { type: "provider", environmentProviderId: "world-tree", inputs: { tree: "shuttle-7" }, machine: { type: "existing", hostId: "host_main" } } });
    expect(spawned[3]).toMatchObject({ environment: { type: "host", hostId: "host_main", workspace: { type: "unmanaged", path: "/Users/me/world/trees/shuttle-7/src" } } });
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
