import { describe, expect, it, vi } from "vitest";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import {
  buildOverview, collectTree, pathsToResolve, planRepos, type CollectDeps, type Environment, type HostCall, type HostInfo, type ProjectInfo,
  type ResolvedRoots,
} from "../src/collect";
import { overviewSchema, type OverviewTarget, type ThreadSummary } from "../src/contract";
import type { EditRecord, ThreadEdits } from "../src/edits";
import { createRepoCache } from "../src/repo-cache";
import { destroyedEnvironment, environment, threadSummary } from "./fixtures";

const record = (overrides: Partial<EditRecord> = {}): EditRecord => ({
  threadId: "thr_1", path: "src/a.ts", movePath: null, kind: "update", added: 1, removed: 0, at: 1000, ...overrides,
});
const edits = (records: EditRecord[], primaryCwd: string | null = null): ThreadEdits => ({ records, primaryCwd });
const roots = (hostId: string, entries: Record<string, { root: string | null; relative: string | null }>): ResolvedRoots =>
  new Map([[hostId, new Map(Object.entries(entries))]]);
const own = (root: string) => ({ root, relative: "" });
const projects: ProjectInfo[] = [
  { id: "proj_1", name: "Project", sources: [{ hostId: "host_1", path: "/code/proj", isDefault: true }] },
  { id: "proj_cortex", name: "Cortex", sources: [{ hostId: "host_1", path: "/code/cortex", isDefault: true }] },
];
const hosts: HostInfo[] = [{ id: "host_1", name: "Laptop" }];

function plan(input: {
  threads: ThreadSummary[]; environments: Environment[]; edits?: Record<string, ThreadEdits>;
  roots?: ResolvedRoots; projects?: ProjectInfo[];
}) {
  return planRepos({
    threads: input.threads,
    environments: new Map(input.environments.map((env) => [env.id, env])),
    edits: new Map(Object.entries(input.edits ?? {})),
    roots: input.roots ?? new Map(),
    projects: input.projects ?? projects,
    hosts,
  });
}

describe("planRepos", () => {
  const live = environment({ id: "env_1", path: "/work/one" });
  const liveRoots = roots("host_1", { "/work/one": own("/work/one") });

  it("makes one workspace repo of two threads that share an environment", () => {
    const { plans } = plan({
      threads: [threadSummary({ id: "a" }), threadSummary({ id: "b", parentThreadId: "a", depth: 1 })],
      environments: [live], roots: liveRoots,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      key: "host_1:/work/one", label: "Project", root: "/work/one", hostId: "host_1", threadIds: ["a", "b"],
      ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" },
    });
  });

  it("keeps an archived thread's workspace while bb is still about to remove it (retiring), as a live worktree", () => {
    const retiring = environment({ id: "env_1", path: "/work/one", lifecycle: { phase: "retiring", retireAt: 1_800_000_000_000, teardown: null } });
    const { plans } = plan({ threads: [threadSummary({ archived: true })], environments: [retiring], roots: liveRoots });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ key: "host_1:/work/one", root: "/work/one", ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" } });
  });

  it("falls back to the default branch for the base and to the path for the root", () => {
    const { plans } = plan({
      threads: [threadSummary()], environments: [environment({ mergeBaseBranch: null, defaultBranch: "main" })],
    });
    expect(plans[0]).toMatchObject({ root: "/work/one", ref: { base: "main" } });
    const none = plan({ threads: [threadSummary()], environments: [environment({ mergeBaseBranch: null, defaultBranch: null })] });
    expect(none.plans[0]?.ref).toMatchObject({ base: null });
  });

  it("attaches edits made by absolute or relative path inside a live workspace", () => {
    const { plans, otherFiles } = plan({
      threads: [threadSummary({ id: "a" })], environments: [live],
      edits: { a: edits([record({ path: "/work/one/src/a.ts" }), record({ path: "src/b.ts" }), record({ path: "src/a.ts", added: 5 })]) },
      roots: roots("host_1", {
        "/work/one": own("/work/one"),
        "/work/one/src/a.ts": { root: "/work/one", relative: "src/a.ts" },
        "/work/one/src/b.ts": { root: "/work/one", relative: "src/b.ts" },
      }),
    });
    expect(plans).toHaveLength(1);
    const touched = plans[0]!.touched;
    expect([...touched.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(touched.get("src/a.ts")?.records).toHaveLength(2);
    expect([...touched.get("src/a.ts")!.rawPaths]).toEqual(["/work/one/src/a.ts", "src/a.ts"]);
    expect([...touched.get("src/b.ts")!.threadIds]).toEqual(["a"]);
    expect(otherFiles.size).toBe(0);
  });

  it("makes a checkout named after its project from an edit in another repository", () => {
    const { plans } = plan({
      threads: [threadSummary({ id: "a" })], environments: [live],
      edits: { a: edits([record({ path: "/code/cortex/skills/x.md" })]) },
      roots: roots("host_1", {
        "/work/one": own("/work/one"), "/code/cortex": own("/code/cortex"),
        "/code/proj": own("/code/proj"),
        "/code/cortex/skills/x.md": { root: "/code/cortex", relative: "skills/x.md" },
      }),
    });
    expect(plans.map((entry) => entry.ref.kind)).toEqual(["workspace", "checkout"]);
    expect(plans[1]).toMatchObject({
      key: "host_1:/code/cortex", label: "Cortex", root: "/code/cortex", hostId: "host_1", threadIds: ["a"],
      ref: { kind: "checkout", hostId: "host_1", root: "/code/cortex", base: null },
    });
    expect([...plans[1]!.touched.keys()]).toEqual(["skills/x.md"]);
  });

  it("names a checkout after its folder when no project owns it", () => {
    const { plans } = plan({
      threads: [threadSummary({ id: "a" })], environments: [live], projects: [],
      edits: { a: edits([record({ path: "/code/shell/a.sh" })]) },
      roots: roots("host_1", { "/work/one": own("/work/one"), "/code/shell/a.sh": { root: "/code/shell", relative: "a.sh" } }),
    });
    expect(plans[1]).toMatchObject({ label: "shell", ref: { kind: "checkout" } });
  });

  it("joins an edit made in another thread's workspace to that workspace", () => {
    const other = environment({ id: "env_2", path: "/work/two" });
    const { plans } = plan({
      threads: [threadSummary({ id: "a" }), threadSummary({ id: "b", environmentId: "env_2" })],
      environments: [live, other],
      edits: { a: edits([record({ path: "/work/two/src/z.ts" })]) },
      roots: roots("host_1", {
        "/work/one": own("/work/one"), "/work/two": own("/work/two"),
        "/work/two/src/z.ts": { root: "/work/two", relative: "src/z.ts" },
      }),
    });
    expect(plans.map((entry) => entry.key)).toEqual(["host_1:/work/one", "host_1:/work/two"]);
    expect(plans[1]?.threadIds).toEqual(["b", "a"]);
    expect([...plans[1]!.touched.keys()]).toEqual(["src/z.ts"]);
  });

  it("makes a branch repo of a destroyed environment that has a branch and a project source", () => {
    const gone = destroyedEnvironment({ id: "env_9", branchName: "feature/old", projectId: "proj_1" });
    const { plans } = plan({
      threads: [threadSummary({ id: "child", environmentId: "env_9", archived: true })], environments: [gone],
      edits: {
        child: edits([record({ threadId: "child", path: "src/a.ts" }), record({ threadId: "child", path: "/gone/wt/src/b.ts" })], "/gone/wt"),
      },
      roots: roots("host_1", { "/code/proj": own("/code/proj") }),
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      key: "host_1:/code/proj@feature/old", label: "Project", root: "/code/proj", hostId: "host_1", threadIds: ["child"],
      ref: { kind: "branch", hostId: "host_1", root: "/code/proj", base: "origin/main", head: "feature/old" },
    });
    expect([...plans[0]!.touched.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("makes a recorded repo of a destroyed environment without a branch or a source", () => {
    const noBranch = destroyedEnvironment({ id: "env_8", branchName: null });
    const noSource = destroyedEnvironment({ id: "env_7", branchName: "feature/x", projectId: "proj_unknown" });
    const { plans } = plan({
      threads: [threadSummary({ id: "a", environmentId: "env_8" }), threadSummary({ id: "b", environmentId: "env_7" })],
      environments: [noBranch, noSource],
      edits: { a: edits([record({ path: "notes.md" })]), b: edits([record({ path: "x.ts" })]) },
    });
    expect(plans.map((entry) => [entry.key, entry.ref.kind])).toEqual([["recorded:env_8", "recorded"], ["recorded:env_7", "recorded"]]);
    expect([...plans[0]!.touched.keys()]).toEqual(["notes.md"]);
  });

  it("sends files outside any repository, and edits with no environment, to otherFiles", () => {
    const { plans, otherFiles } = plan({
      threads: [threadSummary({ id: "a" }), threadSummary({ id: "b", environmentId: null })],
      environments: [live],
      edits: {
        a: edits([record({ path: "/Users/me/.bb/thread-storage/thr_1/notes.md" }), record({ path: "/tmp/scratch.txt" })]),
        b: edits([record({ threadId: "b", path: "/anywhere/x.txt" })]),
      },
      roots: roots("host_1", {
        "/work/one": own("/work/one"),
        "/Users/me/.bb/thread-storage/thr_1/notes.md": { root: null, relative: null },
      }),
    });
    expect(plans).toHaveLength(1);
    expect([...otherFiles.keys()]).toEqual([
      "/Users/me/.bb/thread-storage/thr_1/notes.md", "/tmp/scratch.txt", "/anywhere/x.txt",
    ]);
    expect([...otherFiles.get("/anywhere/x.txt")!.threadIds]).toEqual(["b"]);
  });

  it("files a moved file under its new path and remembers both raw paths", () => {
    const { plans } = plan({
      threads: [threadSummary({ id: "a" })], environments: [live],
      edits: { a: edits([record({ path: "src/old.ts", movePath: "src/new.ts", kind: "update" })]) },
      roots: roots("host_1", { "/work/one": own("/work/one"), "/work/one/src/new.ts": { root: "/work/one", relative: "src/new.ts" } }),
    });
    const entry = plans[0]!.touched.get("src/new.ts");
    expect([...entry!.rawPaths]).toEqual(["src/old.ts", "src/new.ts"]);
  });

  it("orders workspaces first, then checkouts by label, then branch and recorded repositories", () => {
    const gone = destroyedEnvironment({ id: "env_9", branchName: "feature/old", projectId: "proj_1" });
    const noBranch = destroyedEnvironment({ id: "env_8", branchName: null });
    const { plans } = plan({
      threads: [
        threadSummary({ id: "r", environmentId: "env_8" }), threadSummary({ id: "b", environmentId: "env_9" }),
        threadSummary({ id: "a" }),
      ],
      environments: [live, gone, noBranch],
      edits: { a: edits([record({ path: "/code/zeta/z" }), record({ path: "/code/alpha/a" })]) },
      roots: roots("host_1", {
        "/work/one": own("/work/one"), "/code/proj": own("/code/proj"),
        "/code/zeta/z": { root: "/code/zeta", relative: "z" }, "/code/alpha/a": { root: "/code/alpha", relative: "a" },
      }),
    });
    expect(plans.map((entry) => `${entry.ref.kind}:${entry.label}`)).toEqual([
      "workspace:Project", "checkout:alpha", "checkout:zeta", "recorded:Project", "branch:Project",
    ]);
  });
});

describe("pathsToResolve", () => {
  it("lists live environment paths, resolvable edit paths and project sources per host", () => {
    const wanted = pathsToResolve({
      threads: [threadSummary({ id: "a" }), threadSummary({ id: "b", environmentId: "env_9" })],
      environments: new Map([
        ["env_1", environment({ id: "env_1", path: "/work/one" })],
        ["env_9", destroyedEnvironment({ id: "env_9", branchName: "feature/old", projectId: "proj_1" })],
      ]),
      edits: new Map([
        ["a", edits([record({ path: "src/a.ts" }), record({ path: "/code/cortex/x.md" }), record({ path: "/code/cortex/x.md" })])],
        ["b", edits([record({ path: "src/rel.ts" }), record({ path: "/gone/wt/abs.ts" }), record({ path: "/other/place.ts" })], "/gone/wt")],
      ]),
      projects,
    });
    expect([...wanted.keys()]).toEqual(["host_1"]);
    expect(wanted.get("host_1")).toEqual([
      "/work/one", "/work/one/src/a.ts", "/code/cortex/x.md", "/code/proj", "/other/place.ts", "/code/cortex",
    ]);
  });

  it("leaves out paths that are too long to send", () => {
    const wanted = pathsToResolve({
      threads: [threadSummary()], environments: new Map([["env_1", environment()]]),
      edits: new Map([["thr_1", edits([record({ path: `/${"x".repeat(5000)}` })])]]), projects: [],
    });
    expect(wanted.get("host_1")).toEqual(["/work/one"]);
  });
});

describe("planRepos projects", () => {
  const live = environment({ id: "env_1", path: "/work/one", projectId: "proj_1" });
  const edited = (path: string, projectsList: ProjectInfo[] = projects) => plan({
    threads: [threadSummary({ id: "a" })], environments: [live], projects: projectsList,
    edits: { a: edits([record({ path })]) },
    roots: roots("host_1", { "/work/one": own("/work/one"), "/code/cortex": own("/code/cortex"), [path]: { root: "/code/cortex", relative: "x.md" } }),
  }).plans;

  it("names each repository's project: the environment's for a workspace, the owning project's for a checkout", () => {
    const [workspace, checkout] = edited("/code/cortex/x.md");
    expect(workspace?.projectId).toBe("proj_1");
    expect(checkout).toMatchObject({ ref: { kind: "checkout" }, projectId: "proj_cortex" });
  });

  it("gives a checkout that no project owns no project", () => {
    expect(edited("/code/cortex/x.md", [])[1]?.projectId).toBeNull();
  });

  it("keeps the project of a removed workspace, kept as a branch or as recorded edits", () => {
    const gone = destroyedEnvironment({ id: "env_9", projectId: "proj_1", branchName: "old", path: null });
    const { plans } = plan({ threads: [threadSummary({ id: "a", environmentId: "env_9" })], environments: [gone], roots: roots("host_1", { "/code/proj": own("/code/proj") }) });
    expect(plans[0]).toMatchObject({ ref: { kind: "branch" }, projectId: "proj_1" });
    const none = destroyedEnvironment({ id: "env_8", projectId: "proj_8", branchName: null, path: null });
    expect(plan({ threads: [threadSummary({ id: "b", environmentId: "env_8" })], environments: [none] }).plans[0]).toMatchObject({ ref: { kind: "recorded" }, projectId: "proj_8" });
  });
});

function threads(count: number) {
  return Array.from({ length: count }, (_, index) => makeThreadResponse({ id: `thr_c${index}`, parentThreadId: "thr_1", environmentId: null }));
}

const statusOf = (uncommitted: string[], committed: string[] = []) => ({
  outcome: "available",
  workspace: {
    branch: { currentBranch: "feature/work", defaultBranch: "main" },
    checkout: { kind: "branch", branchName: "feature/work", headSha: "abc" },
    mergeBase: {
      aheadCount: committed.length, behindCount: 0, baseRef: "origin/main", mergeBaseBranch: "origin/main", commits: [], deletions: 0, fileCount: committed.length,
      files: committed.map((path) => ({ path, status: "M", insertions: 1, deletions: 0 })), hasCommittedUnmergedChanges: committed.length > 0,
      insertions: 0, lineStatsComplete: true,
    },
    workingTree: {
      files: uncommitted.map((path) => ({ path, status: "M", insertions: 1, deletions: 0 })), fileCount: uncommitted.length, insertions: 0, deletions: 0,
      hasUncommittedChanges: uncommitted.length > 0, lineStatsComplete: true, state: "clean",
    },
  },
});

interface Setup {
  threads?: ReturnType<typeof makeThreadResponse>[];
  descendants?: string[];
  environments?: Environment[];
  projects?: ProjectInfo[];
  hosts?: Array<{ id: string; name: string }>;
  edits?: Record<string, ThreadEdits>;
  host?: HostCall;
  diffFiles?: (args: { environmentId: string }) => unknown;
  status?: (args: { environmentId: string }) => unknown;
}

function setup(options: Setup) {
  const all = options.threads ?? [makeThreadResponse({ id: "thr_1", environmentId: "env_1" })];
  const byId = new Map(all.map((thread) => [thread.id, thread]));
  const envs = new Map((options.environments ?? [environment()]).map((env) => [env.id, env]));
  const sdk = {
    threads: {
      get: vi.fn(async ({ threadId }: { threadId: string }) => {
        const found = byId.get(threadId);
        if (found === undefined) throw new Error(`no thread ${threadId}`);
        return found;
      }),
      list: vi.fn(async ({ archived, limit, offset }: { archived?: boolean; limit?: number; offset?: number }) =>
        (archived === true ? [] : all).slice(offset ?? 0, (offset ?? 0) + (limit ?? 100))),
      experimental_listDescendants: vi.fn(async () => ({
        threads: [{ threadId: "thr_1", descendantIds: options.descendants ?? all.filter((thread) => thread.id !== "thr_1").map((thread) => thread.id) }],
      })),
    },
    environments: {
      status: vi.fn(async (args: { environmentId: string }) => options.status?.(args) ?? statusOf([])),
      get: vi.fn(async ({ environmentId }: { environmentId: string }) => {
        const found = envs.get(environmentId);
        if (found === undefined) throw new Error(`no environment ${environmentId}`);
        return found;
      }),
      diffFiles: vi.fn(async (args: { environmentId: string }) => (
        options.diffFiles?.(args) ?? { outcome: "available", files: [], initialPatches: [], mergeBaseRef: null, shortstat: "", truncated: false }
      )),
    },
    projects: { list: vi.fn(async () => options.projects ?? projects) },
    hosts: { list: vi.fn(async () => options.hosts ?? hosts) },
  };
  const edits = {
    get: vi.fn(async (threadId: string) => options.edits?.[threadId] ?? { records: [], primaryCwd: null }),
    forget: vi.fn(),
  };
  const knownRoots = [
    ...[...envs.values()].flatMap((env) => (env.path === null ? [] : [env.path])),
    ...(options.projects ?? projects).flatMap((project) => project.sources.map((source) => source.path)),
  ];
  const host = vi.fn(options.host ?? (async (method: string, input: { paths?: string[] }) => {
    if (method !== "resolveRoots") throw new Error(`unexpected ${method}`);
    return {
      results: (input.paths ?? []).map((path) => {
        const root = knownRoots.find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
        return root === undefined ? { path, root: null, relative: null } : { path, root, relative: path.slice(root.length + 1) };
      }),
    };
  })) as unknown as HostCall & ReturnType<typeof vi.fn>;
  const allOptions = { windowHours: 24, maxThreads: 200 };
  return { deps: { sdk: sdk as unknown as PluginBbSdk, host, edits, allOptions } as CollectDeps, sdk, edits, host };
}

describe("collectTree", () => {
  it("lists the thread and every descendant, archived and hidden ones included, with titles and depths", async () => {
    const { deps, sdk } = setup({
      threads: [
        makeThreadResponse({ id: "thr_1", title: "Parent", environmentId: "env_1" }),
        makeThreadResponse({ id: "thr_a", title: null, titleFallback: "Fallback", parentThreadId: "thr_1", environmentId: null }),
        makeThreadResponse({ id: "thr_b", title: null, titleFallback: null, parentThreadId: "thr_a", archivedAt: 5, environmentId: "env_1" }),
      ],
      descendants: ["thr_a", "thr_b"],
    });
    const tree = await collectTree(deps, "thr_1");
    expect(sdk.threads.experimental_listDescendants).toHaveBeenCalledWith({
      threadIds: ["thr_1"], includeArchived: true, includeHidden: true, signal: undefined,
    });
    expect(tree.threads).toEqual([
      { id: "thr_1", title: "Parent", parentThreadId: null, archived: false, depth: 0, environmentId: "env_1", status: "idle", rootThreadId: "thr_1" },
      { id: "thr_a", title: "Fallback", parentThreadId: "thr_1", archived: false, depth: 1, environmentId: null, status: "idle", rootThreadId: "thr_1" },
      { id: "thr_b", title: "thr_b", parentThreadId: "thr_a", archived: true, depth: 2, environmentId: "env_1", status: "idle", rootThreadId: "thr_1" },
    ]);
    expect(tree.truncated).toBe(false);
    expect([...tree.environments.keys()]).toEqual(["env_1"]);
    expect(sdk.environments.get).toHaveBeenCalledTimes(1);
  });

  it("skips a descendant that cannot be read and an environment that cannot be read", async () => {
    const { deps } = setup({
      threads: [makeThreadResponse({ id: "thr_1", environmentId: "env_missing" })],
      descendants: ["thr_gone"],
      environments: [],
    });
    const tree = await collectTree(deps, "thr_1");
    expect(tree.threads.map((thread) => thread.id)).toEqual(["thr_1"]);
    expect(tree.environments.size).toBe(0);
  });

  it("caps the tree at 200 threads", async () => {
    const many = [makeThreadResponse({ id: "thr_1", environmentId: null }), ...threads(250)];
    const { deps } = setup({ threads: many });
    const tree = await collectTree(deps, "thr_1");
    expect(tree.threads).toHaveLength(200);
    expect(tree.truncated).toBe(true);
  });

  it("reads descendants at most 8 at a time", async () => {
    let running = 0;
    let peak = 0;
    const many = [makeThreadResponse({ id: "thr_1", environmentId: null }), ...threads(40)];
    const { deps, sdk } = setup({ threads: many });
    const original = sdk.threads.get.getMockImplementation()!;
    sdk.threads.get.mockImplementation(async (args) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return original(args);
    });
    await collectTree(deps, "thr_1");
    expect(peak).toBeLessThanOrEqual(9);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("buildOverview worktrees", () => {
  const twoWorktrees = () => setup({
    threads: [
      makeThreadResponse({ id: "thr_1", title: "Parent", environmentId: "env_1" }),
      makeThreadResponse({ id: "thr_2", title: "Child", parentThreadId: "thr_1", environmentId: "env_2", status: "active" }),
    ],
    environments: [
      environment({ id: "env_1", path: "/work/one", branchName: "main-work" }),
      environment({ id: "env_2", path: "/work/two", branchName: "child-work" }),
    ],
    status: ({ environmentId }) => (environmentId === "env_1" ? statusOf(["README.md", "a.ts"]) : statusOf(["b.ts"], ["README.md"])),
  });

  it("carries each thread's status", async () => {
    const { deps } = twoWorktrees();
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview.threads.map((thread) => [thread.id, thread.status])).toEqual([["thr_1", "idle"], ["thr_2", "active"]]);
  });

  it("lists a worktree for each workspace, with its status counts and machine name", async () => {
    const { deps, sdk } = twoWorktrees();
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overviewSchema.safeParse(overview).success).toBe(true);
    expect(overview.worktrees.map((entry) => [entry.key, entry.kind, entry.branch, entry.hostName, entry.threadIds])).toEqual([
      ["host_1:/work/one", "workspace", "feature/work", "Laptop", ["thr_1"]],
      ["host_1:/work/two", "workspace", "feature/work", "Laptop", ["thr_2"]],
    ]);
    expect(overview.worktrees[1]).toMatchObject({ aheadCount: 1, behindCount: 0, projectId: "proj_1" });
    expect(overview.worktrees[1]?.uncommitted.map((file) => file.path)).toEqual(["b.ts"]);
    expect(sdk.environments.status).toHaveBeenCalledTimes(2);
    expect(sdk.environments.status).toHaveBeenCalledWith({ environmentId: "env_1", mergeBaseBranch: "origin/main", signal: undefined });
  });

  it("flags a file two worktrees of one project both changed", async () => {
    const { deps } = twoWorktrees();
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview.sharedFiles).toEqual([{ projectId: "proj_1", path: "README.md", worktreeKeys: ["host_1:/work/one", "host_1:/work/two"] }]);
  });

  it("keeps the repositories when a worktree's status cannot be read", async () => {
    const { deps } = setup({
      status: () => { throw new Error("status failed"); },
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview.repos).toHaveLength(1);
    expect(overview.worktrees).toMatchObject([{ state: "unavailable", message: "status failed" }]);
    expect(overview.sharedFiles).toEqual([]);
  });
});

describe("buildOverview", () => {
  it("builds a valid overview of a workspace with its live changes and a clean row for an edited file", async () => {
    const { deps } = setup({
      environments: [environment({ id: "env_1", path: "/work/one" })],
      edits: { thr_1: edits([record({ path: "/work/one/src/a.ts" }), record({ path: "/work/one/src/done.ts", kind: "add" })]) },
      diffFiles: () => ({
        outcome: "available", mergeBaseRef: null, shortstat: "", truncated: false, initialPatches: [],
        files: [
          { path: "src/a.ts", previousPath: null, changeKind: "modified", additions: 3, deletions: 1, binary: false, origin: "tracked", loadMode: "auto" },
          { path: "src/other.ts", previousPath: null, changeKind: "added", additions: 4, deletions: 0, binary: false, origin: "untracked", loadMode: "auto" },
        ],
      }),
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overviewSchema.safeParse(overview).success).toBe(true);
    expect(overview.repos).toHaveLength(1);
    const repo = overview.repos[0]!;
    expect(repo).toMatchObject({
      label: "Project", state: "ready", branch: "feature/work", hostName: "Laptop", threadIds: ["thr_1"],
      totals: { files: 2, additions: 7, deletions: 1 },
    });
    expect(repo.files.map((file) => [file.path, file.status, file.edits?.count ?? null])).toEqual([
      ["src/a.ts", "modified", 1], ["src/done.ts", "clean", 1], ["src/other.ts", "untracked", null],
    ]);
    expect(overview.environmentIds).toEqual(["env_1"]);
    expect(overview.warnings).toEqual([]);
  });

  it("asks for the branch diff against the base when the scope is branch", async () => {
    const { deps, sdk } = setup({});
    await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "branch" });
    expect(sdk.environments.diffFiles).toHaveBeenCalledWith({
      environmentId: "env_1", target: "all", mergeBaseBranch: "origin/main", signal: undefined,
    });
  });

  it("folds a checkout's other changes and keeps the files the agents touched", async () => {
    const host = vi.fn(async (method: string, input: { paths?: string[] }) => {
      if (method === "resolveRoots") {
        return {
          results: (input.paths ?? []).map((path) => path === "/code/cortex/a.md"
            ? { path, root: "/code/cortex", relative: "a.md" }
            : { path, root: path, relative: "" }),
        };
      }
      return {
        outcome: "available", branch: "main", base: null, aheadCount: null, truncated: false,
        files: [
          { path: "a.md", previousPath: null, status: "modified", additions: 2, deletions: 0, binary: false },
          { path: "mine.md", previousPath: null, status: "modified", additions: 9, deletions: 9, binary: false },
        ],
      };
    }) as unknown as HostCall;
    const { deps } = setup({
      environments: [environment({ id: "env_1", path: "/work/one" })],
      edits: { thr_1: edits([record({ path: "/code/cortex/a.md" }), record({ path: "/code/cortex/gone.md" })]) },
      host,
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    const checkout = overview.repos.find((entry) => entry.ref.kind === "checkout")!;
    expect(checkout).toMatchObject({ label: "Cortex", branch: "main", totals: { files: 1, additions: 2 } });
    expect(checkout.files.map((file) => [file.path, file.status])).toEqual([["a.md", "modified"]]);
    expect(checkout.otherFiles.map((file) => file.path)).toEqual(["mine.md"]);
    expect(overview.repos.map((entry) => entry.ref.kind)).toEqual(["workspace", "checkout"]);
  });

  it("leaves a repo on an offline host unavailable and the rest ready, with a warning", async () => {
    const offline = environment({ id: "env_2", hostId: "host_2", path: "/remote/work" });
    const { deps } = setup({
      threads: [
        makeThreadResponse({ id: "thr_1", environmentId: "env_1" }),
        makeThreadResponse({ id: "thr_2", parentThreadId: "thr_1", environmentId: "env_2" }),
      ],
      environments: [environment({ id: "env_1" }), offline],
      hosts: [{ id: "host_1", name: "Laptop" }, { id: "host_2", name: "Dev box" }],
      host: (async (method: string, input: { paths?: string[] }, options: { hostId: string }) => {
        if (options.hostId === "host_2") throw new Error("host is offline");
        return { results: (input.paths ?? []).map((path) => ({ path, root: path, relative: "" })) };
      }) as unknown as HostCall,
      diffFiles: ({ environmentId }) => {
        if (environmentId === "env_2") throw new Error("Dev box is not connected");
        return { outcome: "available", files: [], initialPatches: [], mergeBaseRef: null, shortstat: "", truncated: false };
      },
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview.repos.map((entry) => [entry.hostName, entry.state])).toEqual([["Laptop", "ready"], ["Dev box", "unavailable"]]);
    expect(overview.repos[1]?.message).toBe("Dev box is not connected");
    expect(overview.warnings).toEqual(["Could not reach Dev box: host is offline"]);
    expect(overviewSchema.safeParse(overview).success).toBe(true);
  });

  it("marks a workspace unavailable when bb cannot diff it", async () => {
    const { deps } = setup({
      diffFiles: () => ({ outcome: "unavailable", failure: { code: "path_not_found", message: "The folder is gone", workspacePath: "/work/one" } }),
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview.repos[0]).toMatchObject({ state: "unavailable", message: "The folder is gone", files: [] });
  });

  it("turns a branch whose ref is gone into a recorded repo built from the edits", async () => {
    const gone = destroyedEnvironment({ id: "env_9", branchName: "feature/old", projectId: "proj_1" });
    const host = vi.fn(async (method: string, input: { paths?: string[] }) => {
      if (method === "resolveRoots") return { results: (input.paths ?? []).map((path) => ({ path, root: path, relative: "" })) };
      return { outcome: "unavailable", reason: "missing-ref", message: "The branch feature/old no longer exists" };
    }) as unknown as HostCall;
    const { deps } = setup({
      threads: [
        makeThreadResponse({ id: "thr_1", environmentId: null }),
        makeThreadResponse({ id: "thr_2", parentThreadId: "thr_1", environmentId: "env_9", archivedAt: 9 }),
      ],
      environments: [gone],
      edits: { thr_2: edits([record({ threadId: "thr_2", path: "src/lost.ts", kind: "add", added: 4 })]) },
      host,
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview.repos).toHaveLength(1);
    expect(overview.repos[0]).toMatchObject({
      ref: { kind: "recorded" }, state: "ready", branch: "feature/old", label: "Project", threadIds: ["thr_2"],
      totals: { files: 1, additions: 4, deletions: 0 },
    });
    expect(overview.repos[0]?.files[0]).toMatchObject({ path: "src/lost.ts", status: "added", edits: { count: 1 } });
  });

  it("lists files outside any repository as other files, capped at 200", async () => {
    const records = Array.from({ length: 230 }, (_, index) => record({ path: `/tmp/file-${String(index).padStart(3, "0")}.txt` }));
    const host = (async (method: string, input: { paths?: string[] }) => ({
      results: (input.paths ?? []).map((path) => (path.startsWith("/tmp/") ? { path, root: null, relative: null } : { path, root: path, relative: "" })),
    })) as unknown as HostCall;
    const { deps } = setup({ edits: { thr_1: edits(records) }, host });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview.otherFiles).toHaveLength(200);
    expect(overview.otherFiles[0]).toMatchObject({ path: "/tmp/file-000.txt", status: "modified", edits: { count: 1 } });
  });

  it("caps a repo at 500 files and says it was cut", async () => {
    const files = Array.from({ length: 520 }, (_, index) => ({
      path: `f${String(index).padStart(3, "0")}.ts`, previousPath: null, changeKind: "modified", additions: 1, deletions: 0,
      binary: false, origin: "tracked", loadMode: "auto",
    }));
    const { deps } = setup({
      diffFiles: () => ({ outcome: "available", files, initialPatches: [], mergeBaseRef: null, shortstat: "", truncated: false }),
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview.repos[0]?.files).toHaveLength(500);
    expect(overview.repos[0]?.truncated).toBe(true);
  });

  it("sets truncatedThreads for 201 descendants", async () => {
    const { deps } = setup({ threads: [makeThreadResponse({ id: "thr_1", environmentId: null }), ...threads(201)] });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview.truncatedThreads).toBe(true);
    expect(overview.threads).toHaveLength(200);
  });

  it("forgets the tree's cached edits on refresh and not otherwise", async () => {
    const { deps, edits: index } = setup({ threads: [makeThreadResponse({ id: "thr_1", environmentId: null }), ...threads(2)] });
    await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(index.forget).not.toHaveBeenCalled();
    await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", refresh: true });
    expect(index.forget).toHaveBeenCalledWith(["thr_1", "thr_c0", "thr_c1"]);
  });

  it("calls resolveRoots once per host, with every path that host must resolve", async () => {
    const { deps, host } = setup({
      environments: [environment({ id: "env_1", path: "/work/one" })],
      edits: { thr_1: edits([record({ path: "/work/one/src/a.ts" }), record({ path: "/work/one/src/b.ts" })]) },
    });
    await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    const calls = (host as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([method]) => method === "resolveRoots");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1].paths).toEqual(expect.arrayContaining(["/work/one", "/work/one/src/a.ts", "/work/one/src/b.ts"]));
    expect(calls[0]?.[2]).toMatchObject({ hostId: "host_1" });
  });

  it("warns when edits cannot be read but keeps going", async () => {
    const { deps, edits: index } = setup({});
    index.get.mockRejectedValueOnce(new Error("events failed"));
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview.warnings).toEqual(["Could not read the edits of thr_1: events failed"]);
    expect(overview.repos).toHaveLength(1);
  });
});

describe("buildOverview for every thread", () => {
  const ALL: OverviewTarget = { kind: "all" };
  const fiveHoursAgo = Date.now() - 5 * 3_600_000;
  const twoProjects = () => setup({
    threads: [
      makeThreadResponse({ id: "thr_1", title: "First", environmentId: "env_1", updatedAt: fiveHoursAgo }),
      makeThreadResponse({ id: "thr_2", title: "Second", environmentId: "env_2", updatedAt: fiveHoursAgo }),
      makeThreadResponse({ id: "thr_3", title: "Child of second", parentThreadId: "thr_2", environmentId: "env_3", updatedAt: fiveHoursAgo }),
    ],
    environments: [
      environment({ id: "env_1", path: "/work/one", projectId: "proj_1" }),
      environment({ id: "env_2", path: "/work/two", projectId: "proj_cortex", branchName: "two" }),
      environment({ id: "env_3", path: "/work/three", projectId: "proj_cortex", branchName: "three" }),
    ],
  });

  it("builds one overview across unrelated threads, with the window in it and no single thread", async () => {
    const { deps } = twoProjects();
    const overview = await buildOverview(deps, { target: ALL, scope: "uncommitted" });
    expect(overviewSchema.safeParse(overview).success).toBe(true);
    expect(overview).toMatchObject({ threadId: "", target: ALL, windowHours: 24, truncatedThreads: false });
    expect(overview.threads.map((thread) => [thread.id, thread.depth, thread.rootThreadId])).toEqual([
      ["thr_1", 0, "thr_1"], ["thr_2", 0, "thr_2"], ["thr_3", 1, "thr_2"],
    ]);
    expect(overview.worktrees.map((entry) => [entry.root, entry.projectId])).toEqual([
      ["/work/one", "proj_1"], ["/work/two", "proj_cortex"], ["/work/three", "proj_cortex"],
    ]);
  });

  it("marks a tree overview with a null window", async () => {
    const { deps } = twoProjects();
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" });
    expect(overview).toMatchObject({ threadId: "thr_1", target: { kind: "tree", threadId: "thr_1" }, windowHours: null });
  });

  it("needs the window and thread limit to read every thread", async () => {
    const { deps } = twoProjects();
    await expect(buildOverview({ ...deps, allOptions: undefined }, { target: ALL, scope: "uncommitted" })).rejects.toThrow("time window");
  });

  it("reports that more threads matched than the limit allows", async () => {
    const { deps } = twoProjects();
    const overview = await buildOverview({ ...deps, allOptions: { windowHours: 24, maxThreads: 2 } }, { target: ALL, scope: "uncommitted" });
    expect(overview.threads).toHaveLength(2);
    expect(overview.truncatedThreads).toBe(true);
  });

  it("does not forget edits on refresh, because the index only ever reads what is new", async () => {
    const { deps, edits: index } = twoProjects();
    await buildOverview(deps, { target: ALL, scope: "uncommitted", refresh: true });
    expect(index.forget).not.toHaveBeenCalled();
  });

  describe("with the repository cache", () => {
    const ask = (deps: CollectDeps, target: OverviewTarget = ALL, refresh?: boolean) =>
      buildOverview(deps, { target, scope: "uncommitted", ...(refresh === undefined ? {} : { refresh }) });

    it("reads each repository and worktree once, and again after its thread changed", async () => {
      const { deps, sdk } = twoProjects();
      const cache = createRepoCache();
      await ask({ ...deps, cache });
      expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(3);
      expect(sdk.environments.status).toHaveBeenCalledTimes(3);
      await ask({ ...deps, cache });
      expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(3);
      expect(sdk.environments.status).toHaveBeenCalledTimes(3);
      cache.invalidateThreads(["thr_2"]);
      await ask({ ...deps, cache });
      expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(4);
      expect(sdk.environments.status).toHaveBeenCalledTimes(4);
    });

    it("reads an environment again after bb reports it changed", async () => {
      const { deps, sdk } = twoProjects();
      const cache = createRepoCache();
      await ask({ ...deps, cache });
      cache.invalidateEnvironment("env_3");
      await ask({ ...deps, cache });
      expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(4);
    });

    it("clears the cache on a refresh, so everything is read again", async () => {
      const { deps, sdk } = twoProjects();
      const cache = createRepoCache();
      await ask({ ...deps, cache });
      await ask({ ...deps, cache }, ALL, true);
      expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(6);
      expect(sdk.environments.status).toHaveBeenCalledTimes(6);
    });

    it("keeps live edits out of the cache: a recorded repository follows the latest edits", async () => {
      const { deps, edits: index } = twoProjects();
      const cache = createRepoCache();
      const first = await ask({ ...deps, cache });
      expect(first.otherFiles).toEqual([]);
      index.get.mockImplementation(async (threadId: string) => (
        threadId === "thr_1" ? edits([record({ path: "/tmp/outside.txt" })]) : { records: [], primaryCwd: null }
      ));
      const second = await ask({ ...deps, cache });
      expect(second.otherFiles.map((file) => file.path)).toEqual(["/tmp/outside.txt"]);
    });

    it("is not used for a single thread's tree", async () => {
      const { deps, sdk } = twoProjects();
      const cache = createRepoCache();
      const tree: OverviewTarget = { kind: "tree", threadId: "thr_1" };
      await ask({ ...deps, cache }, tree);
      await ask({ ...deps, cache }, tree);
      expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(6);
      expect(cache.size()).toBe(0);
    });
  });
});
