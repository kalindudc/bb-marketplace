import { describe, expect, it, vi } from "vitest";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { buildOverview, buildShell, type CollectDeps, type Environment, type HostCall, type ProjectInfo } from "../src/collect";
import { overviewSchema } from "../src/contract";
import { createRootCache } from "../src/root-cache";
import { destroyedEnvironment, environment } from "./fixtures";

const projects: ProjectInfo[] = [
  { id: "proj_1", name: "Project", sources: [{ hostId: "host_1", path: "/code/proj", isDefault: true }] },
];

interface Setup {
  threads?: ReturnType<typeof makeThreadResponse>[];
  environments?: Environment[];
  archived?: ReturnType<typeof makeThreadResponse>[];
}

function setup(options: Setup = {}) {
  const all = options.threads ?? [makeThreadResponse({ id: "thr_1", title: "Parent", environmentId: "env_1" })];
  const byId = new Map(all.map((thread) => [thread.id, thread]));
  const envs = new Map((options.environments ?? [environment()]).map((env) => [env.id, env]));
  const status = vi.fn(async () => { throw new Error("the shell must not read a status"); });
  const diffFiles = vi.fn(async () => { throw new Error("the shell must not diff"); });
  const sdk = {
    threads: {
      get: vi.fn(async ({ threadId }: { threadId: string }) => byId.get(threadId)!),
      list: vi.fn(async ({ archived }: { archived?: boolean }) => (archived === true ? (options.archived ?? []) : all.filter((thread) => thread.archivedAt === null))),
      experimental_listDescendants: vi.fn(async () => ({
        threads: [{ threadId: "thr_1", descendantIds: all.filter((thread) => thread.id !== "thr_1").map((thread) => thread.id) }],
      })),
    },
    environments: { status, diffFiles, get: vi.fn(async ({ environmentId }: { environmentId: string }) => envs.get(environmentId)!) },
    projects: { list: vi.fn(async () => projects) },
    hosts: { list: vi.fn(async () => [{ id: "host_1", name: "Laptop" }]) },
  };
  const edits = { get: vi.fn(async () => { throw new Error("the shell must not scan events"); }), peek: vi.fn(() => undefined), forget: vi.fn() };
  const host = vi.fn(async () => { throw new Error("the shell must not call the host"); });
  const deps = { sdk: sdk as unknown as PluginBbSdk, host: host as unknown as HostCall, edits, allOptions: { windowHours: 24, maxThreads: 200 } } as CollectDeps;
  return { deps, sdk, edits, host, status, diffFiles };
}

const TREE = { kind: "tree", threadId: "thr_1" } as const;
const shell = (deps: CollectDeps, includeArchived = true) => buildShell(deps, { target: TREE, includeArchived });

describe("buildShell", () => {
  it("makes no git, status, diff, event or host call", async () => {
    const { deps, host, status, diffFiles, edits } = setup();
    await shell(deps);
    expect(host).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(diffFiles).not.toHaveBeenCalled();
    expect(edits.get).not.toHaveBeenCalled();
  });

  it("returns a valid partial overview with nothing that needs git", async () => {
    const { deps } = setup();
    const overview = await shell(deps);
    expect(overviewSchema.safeParse(overview).success).toBe(true);
    expect(overview).toMatchObject({
      partial: true, sharedFiles: [], otherFiles: [], warnings: [], archivedHidden: 0, target: TREE, threadId: "thr_1", windowHours: null,
    });
    expect(overview.threads.map((thread) => thread.id)).toEqual(["thr_1"]);
  });

  it("lists each workspace as a loading worktree and a loading repository, with the facts bb already knows", async () => {
    const { deps } = setup();
    const overview = await shell(deps);
    expect(overview.worktrees).toEqual([{
      key: "host_1:/work/one", ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" }, label: "Project", projectId: "proj_1",
      hostId: "host_1", hostName: "Laptop", root: "/work/one", branch: "feature/work", base: "origin/main", kind: "workspace", threadIds: ["thr_1"],
      state: "loading", message: null, aheadCount: null, behindCount: null, uncommitted: [], committed: [], commits: [],
    }]);
    expect(overview.repos).toEqual([{
      key: "host_1:/work/one", ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" }, label: "Project", projectId: "proj_1",
      root: "/work/one", hostId: "host_1", hostName: "Laptop", branch: "feature/work", base: null, aheadCount: null, threadIds: ["thr_1"],
      state: "loading", message: null, files: [], otherFiles: [], truncated: false, totals: { files: 0, additions: 0, deletions: 0 },
    }]);
  });

  it("shows a destroyed environment's kept branch as a loading worktree", async () => {
    const gone = destroyedEnvironment({ id: "env_9", branchName: "feature/old", projectId: "proj_1" });
    const { deps } = setup({
      threads: [makeThreadResponse({ id: "thr_1", environmentId: "env_1" }), makeThreadResponse({ id: "thr_9", parentThreadId: "thr_1", archivedAt: 5, environmentId: "env_9" })],
      environments: [environment(), gone],
    });
    const overview = await shell(deps);
    expect(overview.worktrees.map((entry) => [entry.key, entry.kind, entry.state, entry.branch])).toEqual([
      ["host_1:/work/one", "workspace", "loading", "feature/work"],
      ["host_1:/code/proj@feature/old", "branch", "loading", "feature/old"],
    ]);
    expect(overview.repos.map((entry) => [entry.key, entry.state, entry.branch])).toEqual([
      ["host_1:/work/one", "loading", "feature/work"], ["host_1:/code/proj@feature/old", "loading", "feature/old"],
    ]);
  });

  it("makes a loading repository of a destroyed environment with no branch", async () => {
    const gone = destroyedEnvironment({ id: "env_9", branchName: null });
    const { deps } = setup({
      threads: [makeThreadResponse({ id: "thr_1", environmentId: "env_9" })], environments: [gone],
    });
    const overview = await shell(deps);
    expect(overview.worktrees).toEqual([]);
    expect(overview.repos).toMatchObject([{ key: "recorded:env_9", state: "loading", ref: { kind: "recorded" } }]);
  });

  it("uses the root the root cache knows, so the keys match the full build", async () => {
    const nested = environment({ id: "env_1", path: "/work/repo/pkg" });
    const roots = createRootCache();
    const { deps, host } = setup({ environments: [nested] });
    const cold = await shell({ ...deps, roots });
    expect(cold.worktrees[0]?.key).toBe("host_1:/work/repo/pkg");

    const resolving = vi.fn(async (method: string, input: { paths?: string[] }) => {
      if (method !== "resolveRoots") throw new Error(`unexpected ${method}`);
      return { results: (input.paths ?? []).map((path) => (
        path.startsWith("/work/repo") ? { path, root: "/work/repo", relative: path.slice("/work/repo/".length) } : { path, root: null, relative: null }
      )) };
    });
    const status = { outcome: "unavailable", failure: { code: "path_not_found", message: "x", workspacePath: "/x" } };
    const full = await buildOverview(
      { ...deps, roots, host: resolving as unknown as HostCall, sdk: { ...deps.sdk, environments: { ...deps.sdk.environments, status: async () => status, diffFiles: async () => status } } as unknown as PluginBbSdk, edits: { get: async () => ({ records: [], primaryCwd: null, workDirs: [] }), peek: () => undefined, forget: vi.fn() } },
      { target: TREE, scope: "uncommitted", includeArchived: true },
    );
    expect(full.worktrees[0]?.key).toBe("host_1:/work/repo");
    const warm = await shell({ ...deps, roots });
    expect(warm.worktrees.map((entry) => entry.key)).toEqual(full.worktrees.map((entry) => entry.key));
    expect(warm.repos.map((entry) => entry.key)).toEqual(full.repos.map((entry) => entry.key));
    expect(host).not.toHaveBeenCalled();
  });

  it("adds the row of a checkout a thread works in when earlier reads know its edits and roots, still without a call", async () => {
    const { deps, edits, host } = setup();
    const roots = createRootCache();
    roots.store("host_1", "/work/one", { root: "/work/one", relative: "" });
    roots.store("host_1", "/trees/study/src/lib.rs", { root: "/trees/study/src", relative: "lib.rs" });
    roots.store("host_1", "~/trees/study/src", { root: "/trees/study/src", relative: "" });
    roots.store("host_1", "/code/other/x.md", { root: "/code/other", relative: "x.md" });
    const record = (path: string) => ({ threadId: "thr_1", path, movePath: null, kind: "update" as const, added: 1, removed: 0, at: 1 });
    edits.peek.mockImplementation((() => ({
      records: [record("/trees/study/src/lib.rs"), record("/code/other/x.md")], primaryCwd: "/work/one", workDirs: ["~/trees/study/src"],
    })) as never);
    const overview = await shell({ ...deps, roots });
    expect(host).not.toHaveBeenCalled();
    expect(edits.get).not.toHaveBeenCalled();
    expect(overview.worktrees.map((entry) => [entry.kind, entry.root, entry.state])).toEqual([
      ["workspace", "/work/one", "loading"], ["checkout", "/trees/study/src", "loading"],
    ]);
    expect(overview.repos.map((entry) => entry.root)).toEqual(["/work/one", "/trees/study/src"]);
  });

  it("leaves out archived threads unless asked, and counts them", async () => {
    const threads = [
      makeThreadResponse({ id: "thr_1", environmentId: "env_1" }),
      makeThreadResponse({ id: "thr_done", parentThreadId: "thr_1", archivedAt: 5, environmentId: "env_2" }),
    ];
    const environments = [environment(), environment({ id: "env_2", path: "/work/two" })];
    const hidden = await shell(setup({ threads, environments }).deps, false);
    expect(hidden.threads.map((thread) => thread.id)).toEqual(["thr_1"]);
    expect(hidden.archivedHidden).toBe(1);
    expect(hidden.worktrees.map((entry) => entry.key)).toEqual(["host_1:/work/one"]);
    const shown = await shell(setup({ threads, environments }).deps, true);
    expect(shown.threads.map((thread) => thread.id)).toEqual(["thr_1", "thr_done"]);
    expect(shown.archivedHidden).toBe(0);
    expect(shown.worktrees).toHaveLength(2);
  });

  it("lists the rows of archived threads after the active ones, in the outline and in the full result", async () => {
    const now = Date.now();
    const threads = [
      makeThreadResponse({ id: "thr_live", environmentId: "env_1", updatedAt: now - 5 * 3_600_000 }),
      makeThreadResponse({ id: "thr_done", environmentId: "env_2", updatedAt: now - 60_000, archivedAt: now - 60_000 }),
    ];
    const environments = [environment(), environment({ id: "env_2", path: "/work/two" })];
    const { deps, sdk } = setup({ threads, environments, archived: [threads[1]!] });
    const outline = await buildShell(deps, { target: { kind: "all" }, includeArchived: true });
    expect(outline.worktrees.map((entry) => entry.key)).toEqual(["host_1:/work/one", "host_1:/work/two"]);
    expect(outline.repos.map((entry) => entry.key)).toEqual(["host_1:/work/one", "host_1:/work/two"]);
    sdk.environments.status.mockImplementation((async () => ({
      outcome: "available",
      workspace: {
        branch: { currentBranch: "feature/work", defaultBranch: "main" },
        checkout: { kind: "branch", branchName: "feature/work", headSha: null },
        mergeBase: null,
        workingTree: { deletions: 0, fileCount: 0, files: [], hasUncommittedChanges: false, insertions: 0, lineStatsComplete: true, state: "clean" },
      },
    })) as never);
    deps.edits = { get: vi.fn(async () => ({ records: [], primaryCwd: null, workDirs: [] })), peek: vi.fn(() => undefined), forget: vi.fn() } as unknown as CollectDeps["edits"];
    deps.host = (async () => ({ results: [] })) as unknown as HostCall;
    const full = await buildOverview(deps, { target: { kind: "all" }, scope: "uncommitted", includeArchived: true });
    expect(full.worktrees.map((entry) => entry.key)).toEqual(["host_1:/work/one", "host_1:/work/two"]);
    expect(full.repos.map((entry) => entry.key)).toEqual(["host_1:/work/one", "host_1:/work/two"]);
  });

  it("builds the shell of every thread, with the window", async () => {
    const { deps } = setup({ threads: [makeThreadResponse({ id: "thr_1", environmentId: "env_1", updatedAt: Date.now() - 3_600_000 })] });
    const overview = await buildShell(deps, { target: { kind: "all" }, includeArchived: false });
    expect(overview).toMatchObject({ partial: true, threadId: "", target: { kind: "all" }, windowHours: 24 });
    expect(overview.worktrees).toHaveLength(1);
  });
});
