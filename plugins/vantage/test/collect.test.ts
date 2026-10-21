import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import {
  buildOverview, collectTree, pathsToResolve, planRepos, type CollectDeps, type Environment, type HostCall, type HostInfo, type ProjectInfo,
  type ResolvedRoots,
} from "../src/collect";
import { overviewSchema, type OverviewTarget, type ThreadSummary } from "../src/contract";
import type { EditRecord, ThreadEdits } from "../src/edits";
import { createRepoCache } from "../src/repo-cache";
import { BB_DEADLINE_MS } from "../src/sources";
import { createRootCache } from "../src/root-cache";
import { destroyedEnvironment, environment, threadSummary } from "./fixtures";

const record = (overrides: Partial<EditRecord> = {}): EditRecord => ({
  threadId: "thr_1", path: "src/a.ts", movePath: null, kind: "update", added: 1, removed: 0, at: 1000, ...overrides,
});
const edits = (records: EditRecord[], primaryCwd: string | null = null, workDirs: string[] = []): ThreadEdits => ({
  records, primaryCwd, workDirs, commitRuns: [], lastEventAt: null,
});
const roots = (hostId: string, entries: Record<string, { root: string | null; relative: string | null }>): ResolvedRoots =>
  new Map([[hostId, new Map(Object.entries(entries))]]);
const own = (root: string) => ({ root, relative: "" });
const projects: ProjectInfo[] = [
  { id: "proj_1", name: "Project", sources: [{ hostId: "host_1", path: "/code/proj", isDefault: true }] },
  { id: "proj_commons", name: "Commons", sources: [{ hostId: "host_1", path: "/code/commons", isDefault: true }] },
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
      edits: { a: edits([record({ path: "/code/commons/skills/x.md" })]) },
      roots: roots("host_1", {
        "/work/one": own("/work/one"), "/code/commons": own("/code/commons"),
        "/code/proj": own("/code/proj"),
        "/code/commons/skills/x.md": { root: "/code/commons", relative: "skills/x.md" },
      }),
    });
    expect(plans.map((entry) => entry.ref.kind)).toEqual(["workspace", "checkout"]);
    expect(plans[1]).toMatchObject({
      key: "host_1:/code/commons", label: "Commons", root: "/code/commons", hostId: "host_1", threadIds: ["a"],
      ref: { kind: "checkout", hostId: "host_1", root: "/code/commons", base: null },
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

describe("planRepos removed environments and folders below the repository root", () => {
  const BRANCH = "agent/side-work";
  const removed = (source: string | null, cwd: string | null, extra: Record<string, { root: string | null; relative: string | null }> = {}) => plan({
    threads: [threadSummary({ id: "a", archived: true, environmentId: "env_r" })],
    environments: [destroyedEnvironment({ id: "env_r", branchName: BRANCH, projectId: "proj_mono" })],
    projects: [{ id: "proj_mono", name: "Mono", sources: source === null ? [] : [{ hostId: "host_1", path: source, isDefault: true }] }],
    edits: { a: edits([record({ path: "/repos/mono/services/api/a.rb" }), record({ path: "lib/b.rb" })], cwd) },
    roots: roots("host_1", {
      "/mono": { root: null, relative: null }, "/repos/mono": own("/repos/mono"),
      "/repos/mono/services/api": { root: "/repos/mono", relative: "services/api" }, ...extra,
    }),
  }).plans;

  it("reads an archived thread's branch where it ran when the project folder is not a repository", () => {
    const [kept] = removed("/mono", "/repos/mono");
    expect(kept).toMatchObject({ key: `host_1:/repos/mono@${BRANCH}`, root: "/repos/mono", ref: { kind: "branch", root: "/repos/mono", head: BRANCH } });
    expect([...kept!.touched.keys()]).toEqual(["services/api/a.rb", "lib/b.rb"]);
  });

  it("does the same for a project with no folder, such as the personal project", () => {
    expect(removed(null, "/repos/mono")[0]?.ref).toMatchObject({ kind: "branch", root: "/repos/mono" });
  });

  it("keys edits from the repository root when the thread ran in a folder below it", () => {
    const [kept] = removed("/mono", "/repos/mono/services/api");
    expect(kept?.root).toBe("/repos/mono");
    expect([...kept!.touched.keys()]).toEqual(["services/api/a.rb", "services/api/lib/b.rb"]);
  });

  it("keeps the recorded edits when neither the project folder nor where the thread ran is a repository", () => {
    expect(removed("/mono", null)[0]?.ref).toEqual({ kind: "recorded" });
    expect(removed("/mono", "/gone", { "/gone": { root: null, relative: null } })[0]?.ref).toEqual({ kind: "recorded" });
  });

  it("prefers the project's checkout when it is a repository", () => {
    const [kept] = removed("/code/mono", "/repos/mono", { "/code/mono": own("/code/mono") });
    expect(kept?.ref).toMatchObject({ kind: "branch", root: "/code/mono" });
  });

  it("marks a workspace whose folder is below its repository root with that root, so its diffs are read there", () => {
    const sub = environment({ id: "env_sub", path: "/repos/mono/services/api", mergeBaseBranch: "origin/main" });
    const { plans } = plan({ threads: [threadSummary({ id: "a", environmentId: "env_sub" })], environments: [sub],
      roots: roots("host_1", { "/repos/mono/services/api": { root: "/repos/mono", relative: "services/api" } }) });
    expect(plans[0]).toMatchObject({ key: "host_1:/repos/mono", root: "/repos/mono" });
    expect(plans[0]?.ref).toEqual({ kind: "workspace", environmentId: "env_sub", base: "origin/main", root: "/repos/mono", hostId: "host_1" });
  });

  it("reads a workspace bb's status was too slow for with git at its root", () => {
    const repo = environment({ id: "env_big", path: "/repos/mono", mergeBaseBranch: "origin/main" });
    const input = { threads: [threadSummary({ id: "a", environmentId: "env_big" })], environments: [repo], roots: roots("host_1", { "/repos/mono": own("/repos/mono") }) };
    expect(plan(input).plans[0]?.ref).toEqual({ kind: "workspace", environmentId: "env_big", base: "origin/main" });
    const slow = planRepos({ ...input, environments: new Map([["env_big", repo]]), edits: new Map(), projects, hosts, slowWorkspaces: new Set(["env_big"]) });
    expect(slow.plans[0]?.ref).toEqual({ kind: "workspace", environmentId: "env_big", base: "origin/main", root: "/repos/mono", hostId: "host_1" });
  });

  it("lets an environment at the repository root speak for a repository an environment below the root shares", () => {
    const sub = environment({ id: "env_sub", path: "/repos/mono/services/api" });
    const top = environment({ id: "env_top", path: "/repos/mono" });
    const { plans } = plan({
      threads: [threadSummary({ id: "a", environmentId: "env_sub" }), threadSummary({ id: "b", environmentId: "env_top" })], environments: [sub, top],
      roots: roots("host_1", { "/repos/mono/services/api": { root: "/repos/mono", relative: "services/api" }, "/repos/mono": own("/repos/mono") }),
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ threadIds: ["a", "b"], ref: { kind: "workspace", environmentId: "env_top" } });
    expect(plans[0]?.ref).not.toHaveProperty("root");
  });
});

describe("planRepos worked checkouts", () => {
  const live = environment({ id: "env_1", path: "/work/one", projectId: "proj_1" });
  const treeRoots = {
    "/work/one": own("/work/one"), "/code/proj": own("/code/proj"), "/code/commons": own("/code/commons"),
    "/clones/side/pkg/lib.rs": { root: "/clones/side", relative: "pkg/lib.rs" },
    "~/clones/side/pkg": { root: "/clones/side", relative: "pkg" },
    "/tmp/scratch": { root: null, relative: null },
  };
  const side = (threadEdits: Record<string, ThreadEdits>, threads = [threadSummary({ id: "a" })]) =>
    plan({ threads, environments: [live], edits: threadEdits, roots: roots("host_1", treeRoots) }).plans;

  it("marks a checkout worked when the same thread edited a file in it and ran commands in it", () => {
    const plans = side({ a: edits([record({ path: "/clones/side/pkg/lib.rs" })], null, ["/tmp/scratch", "~/clones/side/pkg"]) });
    expect(plans.map((entry) => entry.ref)).toEqual([
      { kind: "workspace", environmentId: "env_1", base: "origin/main" },
      { kind: "checkout", hostId: "host_1", root: "/clones/side", base: null, worked: true },
    ]);
    expect(plans[1]).toMatchObject({ label: "Project", projectId: "proj_1", threadIds: ["a"] });
  });

  it("leaves a checkout edited by path only when the thread never ran a command there", () => {
    const plans = side({ a: edits([record({ path: "/clones/side/pkg/lib.rs" })], null, ["/tmp/scratch"]) });
    expect(plans[1]).toMatchObject({ label: "side", projectId: null, ref: { kind: "checkout", root: "/clones/side" } });
    expect(plans[1]!.ref).not.toHaveProperty("worked");
  });

  it("needs one thread to do both: an edit by one and commands by another do not count", () => {
    const plans = side(
      { a: edits([record({ path: "/clones/side/pkg/lib.rs" })]), b: edits([], null, ["~/clones/side/pkg"]) },
      [threadSummary({ id: "a" }), threadSummary({ id: "b", parentThreadId: "a", depth: 1 })],
    );
    expect(plans[1]!.ref).not.toHaveProperty("worked");
  });

  it("makes no repository of a folder the thread only ran commands in", () => {
    expect(side({ a: edits([], null, ["~/clones/side/pkg"]) }).map((entry) => entry.ref.kind)).toEqual(["workspace"]);
  });

  it("keeps the owning project's name for a worked checkout a project owns", () => {
    const plans = plan({
      threads: [threadSummary({ id: "a" })], environments: [live],
      edits: { a: edits([record({ path: "/code/commons/x.md" })], null, ["/code/commons"]) },
      roots: roots("host_1", { ...treeRoots, "/code/commons/x.md": { root: "/code/commons", relative: "x.md" } }),
    }).plans;
    expect(plans[1]).toMatchObject({ label: "Commons", projectId: "proj_commons", ref: { kind: "checkout", worked: true } });
  });
});

describe("pathsToResolve", () => {
  it("adds a thread's command folders only when it edited files outside its own environment", () => {
    const wanted = pathsToResolve({
      threads: [threadSummary({ id: "a" }), threadSummary({ id: "b" })],
      environments: new Map([["env_1", environment({ id: "env_1", path: "/work/one" })]]),
      edits: new Map([
        ["a", edits([record({ path: "src/a.ts" }), record({ path: "/work/one/b.ts" })], null, ["~/inside-only"])],
        ["b", edits([record({ path: "/clones/side/x.rs" })], null, ["~/clones/side", "/clones/side/pkg"])],
      ]),
      projects: [],
    });
    expect(wanted.get("host_1")).toEqual([
      "/work/one", "/work/one/src/a.ts", "/work/one/b.ts", "/clones/side/x.rs", "~/clones/side", "/clones/side/pkg",
    ]);
  });

  it("lists live environment paths, resolvable edit paths and project sources per host", () => {
    const wanted = pathsToResolve({
      threads: [threadSummary({ id: "a" }), threadSummary({ id: "b", environmentId: "env_9" })],
      environments: new Map([
        ["env_1", environment({ id: "env_1", path: "/work/one" })],
        ["env_9", destroyedEnvironment({ id: "env_9", branchName: "feature/old", projectId: "proj_1" })],
      ]),
      edits: new Map([
        ["a", edits([record({ path: "src/a.ts" }), record({ path: "/code/commons/x.md" }), record({ path: "/code/commons/x.md" })])],
        ["b", edits([record({ path: "src/rel.ts" }), record({ path: "/gone/wt/abs.ts" }), record({ path: "/other/place.ts" })], "/gone/wt")],
      ]),
      projects,
    });
    expect([...wanted.keys()]).toEqual(["host_1"]);
    expect(wanted.get("host_1")).toEqual([
      "/work/one", "/work/one/src/a.ts", "/code/commons/x.md", "/code/proj", "/gone/wt", "/other/place.ts", "/code/commons",
    ]);
  });

  it("looks up where a removed environment's thread ran only while its project folder is not known to be a repository", () => {
    const input = (known: ProjectInfo[], cache?: Record<string, { root: string | null; relative: string | null }>) => pathsToResolve({
      threads: [threadSummary({ id: "b", environmentId: "env_9" })],
      environments: new Map([["env_9", destroyedEnvironment({ id: "env_9", branchName: "feature/old", projectId: "proj_1" })]]),
      edits: new Map([["b", edits([], "/clones/side")]]), projects: known,
      ...(cache === undefined ? {} : { known: (_hostId: string, path: string) => cache[path] }),
    }).get("host_1");
    expect(input(projects)).toContain("/clones/side");
    expect(input(projects, { "/code/proj": own("/code/proj") })).not.toContain("/clones/side");
    expect(input(projects, { "/code/proj": { root: null, relative: null } })).toContain("/clones/side");
    expect(input([])).toEqual(["/clones/side"]);
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
    roots: roots("host_1", { "/work/one": own("/work/one"), "/code/commons": own("/code/commons"), [path]: { root: "/code/commons", relative: "x.md" } }),
  }).plans;

  it("names each repository's project: the environment's for a workspace, the owning project's for a checkout", () => {
    const [workspace, checkout] = edited("/code/commons/x.md");
    expect(workspace?.projectId).toBe("proj_1");
    expect(checkout).toMatchObject({ ref: { kind: "checkout" }, projectId: "proj_commons" });
  });

  it("gives a checkout that no project owns no project", () => {
    expect(edited("/code/commons/x.md", [])[1]?.projectId).toBeNull();
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

const statusWith = (files: Array<{ path: string; status: string; insertions: number | null; deletions: number | null }>) => {
  const base = statusOf([]);
  return { ...base, workspace: { ...base.workspace, workingTree: { ...base.workspace.workingTree, files, fileCount: files.length } } };
};

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
    get: vi.fn(async (threadId: string) => options.edits?.[threadId] ?? { records: [], primaryCwd: null, workDirs: [], commitRuns: [], lastEventAt: null }),
    peek: vi.fn(() => undefined),
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
    const tree = await collectTree(deps, "thr_1", true);
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
    const tree = await collectTree(deps, "thr_1", true);
    expect(tree.threads.map((thread) => thread.id)).toEqual(["thr_1"]);
    expect(tree.environments.size).toBe(0);
  });

  it("caps the tree at 200 threads", async () => {
    const many = [makeThreadResponse({ id: "thr_1", environmentId: null }), ...threads(250)];
    const { deps } = setup({ threads: many });
    const tree = await collectTree(deps, "thr_1", true);
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
    await collectTree(deps, "thr_1", true);
    expect(peak).toBeLessThanOrEqual(9);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("collectTree with archived threads hidden", () => {
  const family = () => setup({
    threads: [
      makeThreadResponse({ id: "thr_1", title: "Parent", environmentId: "env_1" }),
      makeThreadResponse({ id: "thr_live", title: "Live child", parentThreadId: "thr_1", environmentId: "env_1" }),
      makeThreadResponse({ id: "thr_done", title: "Done child", parentThreadId: "thr_1", archivedAt: 5, environmentId: "env_2" }),
      makeThreadResponse({ id: "thr_deep", title: "Live grandchild", parentThreadId: "thr_done", environmentId: "env_1" }),
    ],
    descendants: ["thr_live", "thr_done", "thr_deep"],
    environments: [environment({ id: "env_1" }), environment({ id: "env_2", path: "/work/two" })],
  });

  it("drops an archived descendant and counts it, but still asks bb for archived threads", async () => {
    const { deps, sdk } = family();
    const tree = await collectTree(deps, "thr_1", false);
    expect(tree.threads.map((thread) => thread.id)).toEqual(["thr_1", "thr_live", "thr_deep"]);
    expect(tree.archivedHidden).toBe(1);
    expect(sdk.threads.experimental_listDescendants).toHaveBeenCalledWith(expect.objectContaining({ includeArchived: true }));
  });

  it("loads no environment for a dropped thread", async () => {
    const { deps, sdk } = family();
    const tree = await collectTree(deps, "thr_1", false);
    expect([...tree.environments.keys()]).toEqual(["env_1"]);
    expect(sdk.environments.get).toHaveBeenCalledTimes(1);
  });

  it("keeps the depth of a live thread under a dropped archived parent", async () => {
    const { deps } = family();
    const tree = await collectTree(deps, "thr_1", false);
    expect(tree.threads.find((thread) => thread.id === "thr_deep")).toMatchObject({ depth: 2, parentThreadId: "thr_done", rootThreadId: "thr_1" });
  });

  it("keeps everything and hides nothing when archived threads are asked for", async () => {
    const { deps } = family();
    const tree = await collectTree(deps, "thr_1", true);
    expect(tree.threads.map((thread) => thread.id)).toEqual(["thr_1", "thr_live", "thr_done", "thr_deep"]);
    expect(tree.archivedHidden).toBe(0);
  });

  it("always keeps the tree's root, even when it is archived", async () => {
    const { deps } = setup({
      threads: [
        makeThreadResponse({ id: "thr_1", archivedAt: 5, environmentId: "env_1" }),
        makeThreadResponse({ id: "thr_x", parentThreadId: "thr_1", archivedAt: 6, environmentId: null }),
      ],
    });
    const tree = await collectTree(deps, "thr_1", false);
    expect(tree.threads.map((thread) => [thread.id, thread.archived])).toEqual([["thr_1", true]]);
    expect(tree.archivedHidden).toBe(1);
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
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overview.threads.map((thread) => [thread.id, thread.status])).toEqual([["thr_1", "idle"], ["thr_2", "active"]]);
  });

  it("lists a worktree for each workspace, with its status counts and machine name", async () => {
    const { deps, sdk } = twoWorktrees();
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overviewSchema.safeParse(overview).success).toBe(true);
    expect(overview.worktrees.map((entry) => [entry.key, entry.kind, entry.branch, entry.hostName, entry.threadIds])).toEqual([
      ["host_1:/work/one", "workspace", "feature/work", "Laptop", ["thr_1"]],
      ["host_1:/work/two", "workspace", "feature/work", "Laptop", ["thr_2"]],
    ]);
    expect(overview.worktrees[1]).toMatchObject({ aheadCount: 1, behindCount: 0, projectId: "proj_1" });
    expect(overview.worktrees[1]?.uncommitted.map((file) => file.path)).toEqual(["b.ts"]);
    expect(sdk.environments.status).toHaveBeenCalledTimes(2);
    expect(sdk.environments.status).toHaveBeenCalledWith({ environmentId: "env_1", mergeBaseBranch: "origin/main", signal: expect.any(AbortSignal) });
  });

  it("flags a file two worktrees of one project both changed", async () => {
    const { deps } = twoWorktrees();
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overview.sharedFiles).toEqual([{ projectId: "proj_1", path: "README.md", worktreeKeys: ["host_1:/work/one", "host_1:/work/two"] }]);
  });

  it("keeps the repositories when a worktree's status cannot be read", async () => {
    const { deps } = setup({
      status: () => { throw new Error("status failed"); },
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overview.repos).toHaveLength(1);
    expect(overview.worktrees).toMatchObject([{ state: "unavailable", message: "status failed" }]);
    expect(overview.sharedFiles).toEqual([]);
  });
});

describe("buildOverview workspaces bb's status is too slow for", () => {
  const ROOT = "/repos/mono";
  const available = {
    outcome: "available", branch: "agent/work", base: "origin/main", aheadCount: 1, behindCount: 50000, truncated: false,
    commits: [{ sha: "abc1234", shortSha: "abc1234", subject: "Work", authorName: "Agent", authoredAt: 1000 }],
    uncommitted: [{ path: "services/api/new.rb", previousPath: null, status: "untracked", additions: 2, deletions: 0, binary: false }],
    committed: [{ path: "services/api/done.rb", previousPath: null, status: "modified", additions: 3, deletions: 1, binary: false }],
  };
  const resolveAt = (paths: string[] = []) => ({ results: paths.map((path) => ({ path, root: path === ROOT ? ROOT : null, relative: path === ROOT ? "" : null })) });
  const slowSetup = (status?: () => unknown) => {
    const host = vi.fn(async (method: string, input: { paths?: string[] }) => {
      if (method === "resolveRoots") return resolveAt(input.paths);
      if (method === "checkoutStatus") return available;
      throw new Error(`unexpected ${method}`);
    }) as unknown as HostCall & ReturnType<typeof vi.fn>;
    return setup({ host, status, environments: [environment({ id: "env_1", path: ROOT, mergeBaseBranch: "origin/main" })] });
  };
  const build = (deps: CollectDeps, scope: "uncommitted" | "branch" = "uncommitted") =>
    buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope, includeArchived: true });
  const gitCalls = (host: ReturnType<typeof vi.fn>) => host.mock.calls.filter(([method]) => method === "checkoutStatus");

  afterEach(() => { vi.useRealTimers(); });

  it("stops waiting for bb after the deadline, reads the workspace with git, and keeps doing so", async () => {
    vi.useFakeTimers();
    const { deps, sdk, host } = slowSetup(() => new Promise(() => {}));
    const slowWorkspaces = new Set<string>();
    const shared = { ...deps, cache: createRepoCache(), roots: createRootCache(), slowWorkspaces };
    const first = build(shared);
    await vi.advanceTimersByTimeAsync(BB_DEADLINE_MS);
    const overview = await first;
    expect(overviewSchema.safeParse(overview).success).toBe(true);
    expect(overview.worktrees[0]).toMatchObject({ root: ROOT, aheadCount: 1, behindCount: 50000, state: "ready" });
    expect(overview.worktrees[0]?.ref).toEqual({ kind: "workspace", environmentId: "env_1", base: "origin/main", root: ROOT, hostId: "host_1" });
    expect(overview.repos[0]?.ref).toEqual(overview.worktrees[0]?.ref);
    expect(overview.repos[0]?.files.map((file) => file.path)).toEqual(["services/api/new.rb"]);
    expect([...slowWorkspaces]).toEqual(["env_1"]);
    shared.cache.clear();
    await build(shared);
    expect(sdk.environments.status).toHaveBeenCalledTimes(1);
    expect(gitCalls(host)).toHaveLength(2);
  });

  it("keeps asking bb when it answers in time", async () => {
    const { deps, sdk, host } = slowSetup();
    const slowWorkspaces = new Set<string>();
    const overview = await build({ ...deps, slowWorkspaces });
    expect(overview.worktrees[0]?.ref).not.toHaveProperty("root");
    expect(slowWorkspaces.size).toBe(0);
    expect(sdk.environments.status).toHaveBeenCalled();
    expect(gitCalls(host)).toHaveLength(0);
  });

  it("reads a workspace already known to be slow with one git call on the host and none through bb", async () => {
    const { deps, sdk, host } = slowSetup();
    const overview = await build({ ...deps, cache: createRepoCache(), roots: createRootCache(), slowWorkspaces: new Set(["env_1"]) });
    expect(overview.worktrees[0]?.committed.map((file) => file.path)).toEqual(["services/api/done.rb"]);
    expect(sdk.environments.status).not.toHaveBeenCalled();
    expect(gitCalls(host)).toEqual([["checkoutStatus", { root: ROOT, base: "origin/main" }, { hostId: "host_1", signal: undefined }]]);
  });

  it("drops the cached git read when bb reports a change to the environment", async () => {
    const { deps, host } = slowSetup();
    const cache = createRepoCache();
    const run = () => build({ ...deps, cache, roots: createRootCache(), slowWorkspaces: new Set(["env_1"]) });
    await run();
    await run();
    cache.invalidateEnvironment("env_1");
    await run();
    expect(gitCalls(host)).toHaveLength(2);
  });

  it("falls back to git for the branch scope too", async () => {
    vi.useFakeTimers();
    const { deps, sdk, host } = slowSetup();
    sdk.environments.diffFiles.mockImplementation(() => new Promise(() => {}));
    host.mockImplementation((async (method: string, input: { paths?: string[] }) => {
      if (method === "repoFiles") return { outcome: "available", branch: null, base: "origin/main", aheadCount: 1, behindCount: null, commits: [], truncated: false, files: [] };
      if (method === "resolveRoots") return resolveAt(input.paths);
      return available;
    }) as never);
    const slowWorkspaces = new Set<string>();
    const pending = build({ ...deps, slowWorkspaces }, "branch");
    await vi.advanceTimersByTimeAsync(BB_DEADLINE_MS);
    await pending;
    expect(host.mock.calls.find(([method]) => method === "repoFiles")?.[1]).toEqual({ root: ROOT, target: { type: "merge-base", base: "origin/main" } });
    expect([...slowWorkspaces]).toEqual(["env_1"]);
  });
});

describe("buildOverview worked checkouts", () => {
  const TREE_ROOT = "/clones/side";
  const gitFile = (path: string, additions = 1) => ({ path, previousPath: null, status: "modified", additions, deletions: 0, binary: false });
  const sideHost = (status: object = {}) => vi.fn(async (method: string, input: { paths?: string[] }) => {
    if (method === "resolveRoots") {
      return {
        results: (input.paths ?? []).map((path) => path.startsWith(TREE_ROOT) || path.startsWith("~/clones/side")
          ? { path, root: TREE_ROOT, relative: path.startsWith("~") ? "pkg" : path.slice(TREE_ROOT.length + 1) }
          : { path, root: path === "/work/one" ? path : null, relative: path === "/work/one" ? "" : null }),
      };
    }
    if (method === "checkoutStatus") {
      return {
        outcome: "available", branch: "side-work", base: "origin/main", aheadCount: 2, behindCount: 0, truncated: false,
        commits: [{ sha: "abc1234", shortSha: "abc1234", subject: "Cut copies", authorName: "Agent", authoredAt: 1000 }],
        uncommitted: [gitFile("pkg/lib.rs", 3), gitFile("pkg/shell-only.rs", 5)], committed: [gitFile("pkg/committed.rs", 8)],
        ...status,
      };
    }
    throw new Error(`unexpected ${method}`);
  }) as unknown as HostCall & ReturnType<typeof vi.fn>;
  const sideEdits = { thr_1: edits([record({ path: `${TREE_ROOT}/pkg/lib.rs` })], "/work/one", ["~/clones/side/pkg"]) };

  it("gives the checkout a worktree row with its commits, and lists every change in it, from one host read", async () => {
    const host = sideHost();
    const { deps } = setup({ edits: sideEdits, host, environments: [environment({ id: "env_1", path: "/work/one" })] });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overviewSchema.safeParse(overview).success).toBe(true);
    const row = overview.worktrees.find((entry) => entry.kind === "checkout")!;
    expect(row).toMatchObject({
      key: `host_1:${TREE_ROOT}`, label: "Project", projectId: "proj_1", root: TREE_ROOT, branch: "side-work", base: "origin/main",
      aheadCount: 2, behindCount: 0, state: "ready", threadIds: ["thr_1"],
    });
    expect(row.committed.map((file) => file.path)).toEqual(["pkg/committed.rs"]);
    expect(row.commits.map((commit) => commit.subject)).toEqual(["Cut copies"]);
    const repo = overview.repos.find((entry) => entry.ref.kind === "checkout")!;
    expect(repo.ref).toEqual({ kind: "checkout", hostId: "host_1", root: TREE_ROOT, base: null, worked: true });
    expect(repo.files.map((file) => [file.path, file.edits?.count ?? null])).toEqual([["pkg/lib.rs", 1], ["pkg/shell-only.rs", null]]);
    expect(repo.otherFiles).toEqual([]);
    expect(host.mock.calls.filter(([method]) => method === "checkoutStatus")).toEqual([
      ["checkoutStatus", { root: TREE_ROOT, base: null }, { hostId: "host_1", signal: undefined }],
    ]);
  });

  it("asks for the merge-base diff when the scope is branch, and keeps the row", async () => {
    const host = sideHost();
    host.mockImplementation((async (method: string, input: { paths?: string[] }) => {
      if (method === "repoFiles") {
        return { outcome: "available", branch: "side-work", base: "origin/main", aheadCount: 2, behindCount: null, commits: [], truncated: false, files: [gitFile("pkg/committed.rs")] };
      }
      return sideHost()(method as never, input as never, { hostId: "host_1" });
    }) as never);
    const { deps } = setup({ edits: sideEdits, host, environments: [environment({ id: "env_1", path: "/work/one" })] });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "branch", includeArchived: true });
    expect(host.mock.calls.find(([method]) => method === "repoFiles")?.[1]).toEqual({ root: TREE_ROOT, target: { type: "merge-base", base: null } });
    expect(overview.worktrees.map((entry) => entry.kind)).toEqual(["workspace", "checkout"]);
  });

  it("shows the row as unavailable when the host cannot read the checkout", async () => {
    const host = sideHost({ outcome: "unavailable", reason: "not-a-repo", message: "This folder does not exist" });
    const { deps } = setup({ edits: sideEdits, host, environments: [environment({ id: "env_1", path: "/work/one" })] });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overview.worktrees.find((entry) => entry.kind === "checkout")).toMatchObject({ state: "unavailable", message: "This folder is no longer a git repository" });
    expect(overview.repos.find((entry) => entry.ref.kind === "checkout")).toMatchObject({ state: "unavailable" });
  });
});

describe("buildOverview", () => {
  it("builds a valid overview of a workspace with its live changes and a clean row for an edited file", async () => {
    const { deps } = setup({
      environments: [environment({ id: "env_1", path: "/work/one" })],
      edits: { thr_1: edits([record({ path: "/work/one/src/a.ts" }), record({ path: "/work/one/src/done.ts", kind: "add" })]) },
      status: () => statusWith([
        { path: "src/a.ts", status: "M", insertions: 3, deletions: 1 },
        { path: "src/other.ts", status: "??", insertions: 4, deletions: 0 },
      ]),
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
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

  it("lists the commits a thread made on its base branch in its worktree and its repository", async () => {
    const onMain = statusOf([]);
    const status = {
      ...onMain,
      workspace: {
        ...onMain.workspace,
        checkout: { kind: "branch", branchName: "main", headSha: "abc" },
        mergeBase: { ...onMain.workspace.mergeBase, baseRef: "main", mergeBaseBranch: "main" },
      },
    };
    const shipped = { sha: "f".repeat(40), shortSha: "fffffff", subject: "Add the parser", authorName: "Ada", authoredAt: 1_700_000_000_000 };
    const resolve = async (method: string, input: { paths?: string[] }) => {
      if (method === "threadCommits") return { outcome: "available", commits: [shipped] };
      if (method !== "resolveRoots") throw new Error(`unexpected ${method}`);
      return { results: (input.paths ?? []).map((path) => ({ path, root: "/work/one", relative: path === "/work/one" ? "" : path.slice("/work/one/".length) })) };
    };
    const { deps, host } = setup({
      threads: [makeThreadResponse({ id: "thr_1", environmentId: "env_1", status: "active" })],
      environments: [environment({ id: "env_1", path: "/work/one", branchName: "main", mergeBaseBranch: null, defaultBranch: "main" })],
      edits: { thr_1: { ...edits([]), commitRuns: [{ id: "c1", startedAt: 1_000, endedAt: null }] } },
      status: () => status,
      host: resolve as unknown as HostCall,
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overviewSchema.safeParse(overview).success).toBe(true);
    expect(overview.worktrees[0]).toMatchObject({ branch: "main", base: "main", onBase: true, threadCommits: [shipped] });
    expect(overview.repos[0]?.threadCommits).toEqual([shipped]);
    const asked = host.mock.calls.find(([method]) => method === "threadCommits");
    expect(asked?.[1]).toEqual({ root: "/work/one", windows: [{ start: 1_000, end: expect.any(Number) }] });
    expect((asked?.[1] as { windows: Array<{ end: number }> }).windows[0]!.end).toBeGreaterThan(1_000);
  });

  it("asks for the branch diff against the base when the scope is branch", async () => {
    const { deps, sdk } = setup({});
    await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "branch", includeArchived: true });
    expect(sdk.environments.diffFiles).toHaveBeenCalledWith({
      environmentId: "env_1", target: "all", mergeBaseBranch: "origin/main", signal: expect.any(AbortSignal),
    });
  });

  it("folds a checkout's other changes and keeps the files the agents touched", async () => {
    const host = vi.fn(async (method: string, input: { paths?: string[] }) => {
      if (method === "resolveRoots") {
        return {
          results: (input.paths ?? []).map((path) => path === "/code/commons/a.md"
            ? { path, root: "/code/commons", relative: "a.md" }
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
      edits: { thr_1: edits([record({ path: "/code/commons/a.md" }), record({ path: "/code/commons/gone.md" })]) },
      host,
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    const checkout = overview.repos.find((entry) => entry.ref.kind === "checkout")!;
    expect(checkout).toMatchObject({ label: "Commons", branch: "main", totals: { files: 1, additions: 2 } });
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
      status: ({ environmentId }) => {
        if (environmentId === "env_2") throw new Error("Dev box is not connected");
        return statusOf([]);
      },
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overview.repos.map((entry) => [entry.hostName, entry.state])).toEqual([["Laptop", "ready"], ["Dev box", "unavailable"]]);
    expect(overview.repos[1]?.message).toBe("Dev box is not connected");
    expect(overview.warnings).toEqual(["Could not reach Dev box: host is offline"]);
    expect(overviewSchema.safeParse(overview).success).toBe(true);
  });

  it("marks a workspace unavailable when bb cannot read its status", async () => {
    const { deps } = setup({
      status: () => ({ outcome: "unavailable", failure: { code: "path_not_found", message: "The folder is gone", workspacePath: "/work/one" } }),
    });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
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
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
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
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overview.otherFiles).toHaveLength(200);
    expect(overview.otherFiles[0]).toMatchObject({ path: "/tmp/file-000.txt", status: "modified", edits: { count: 1 } });
  });

  it("caps a repo at 500 files and says it was cut", async () => {
    const files = Array.from({ length: 520 }, (_, index) => ({ path: `f${String(index).padStart(3, "0")}.ts`, status: "M", insertions: 1, deletions: 0 }));
    const { deps } = setup({ status: () => statusWith(files) });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overview.repos[0]?.files).toHaveLength(500);
    expect(overview.repos[0]?.truncated).toBe(true);
  });

  it("sets truncatedThreads for 201 descendants", async () => {
    const { deps } = setup({ threads: [makeThreadResponse({ id: "thr_1", environmentId: null }), ...threads(201)] });
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overview.truncatedThreads).toBe(true);
    expect(overview.threads).toHaveLength(200);
  });

  it("forgets the tree's cached edits on refresh and not otherwise", async () => {
    const { deps, edits: index } = setup({ threads: [makeThreadResponse({ id: "thr_1", environmentId: null }), ...threads(2)] });
    await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(index.forget).not.toHaveBeenCalled();
    await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true, refresh: true });
    expect(index.forget).toHaveBeenCalledWith(["thr_1", "thr_c0", "thr_c1"]);
  });

  it("sends each host every path it must resolve, each path once", async () => {
    const { deps, host } = setup({
      environments: [environment({ id: "env_1", path: "/work/one" })],
      edits: { thr_1: edits([record({ path: "/work/one/src/a.ts" }), record({ path: "/work/one/src/b.ts" })]) },
    });
    await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    const calls = (host as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([method]) => method === "resolveRoots");
    const sent = calls.flatMap((call) => call[1].paths as string[]);
    expect(sent.slice().sort()).toEqual(["/code/commons", "/code/proj", "/work/one", "/work/one/src/a.ts", "/work/one/src/b.ts"]);
    expect(calls.every((call) => call[2].hostId === "host_1")).toBe(true);
  });

  it("warns when edits cannot be read but keeps going", async () => {
    const { deps, edits: index } = setup({});
    index.get.mockRejectedValueOnce(new Error("events failed"));
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
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
      environment({ id: "env_2", path: "/work/two", projectId: "proj_commons", branchName: "two" }),
      environment({ id: "env_3", path: "/work/three", projectId: "proj_commons", branchName: "three" }),
    ],
  });

  it("builds one overview across unrelated threads, with the window in it and no single thread", async () => {
    const { deps } = twoProjects();
    const overview = await buildOverview(deps, { target: ALL, scope: "uncommitted", includeArchived: true });
    expect(overviewSchema.safeParse(overview).success).toBe(true);
    expect(overview).toMatchObject({ threadId: "", target: ALL, windowHours: 24, truncatedThreads: false });
    expect(overview.threads.map((thread) => [thread.id, thread.depth, thread.rootThreadId])).toEqual([
      ["thr_1", 0, "thr_1"], ["thr_2", 0, "thr_2"], ["thr_3", 1, "thr_2"],
    ]);
    expect(overview.worktrees.map((entry) => [entry.root, entry.projectId])).toEqual([
      ["/work/one", "proj_1"], ["/work/two", "proj_commons"], ["/work/three", "proj_commons"],
    ]);
  });

  it("marks a tree overview with a null window", async () => {
    const { deps } = twoProjects();
    const overview = await buildOverview(deps, { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    expect(overview).toMatchObject({ threadId: "thr_1", target: { kind: "tree", threadId: "thr_1" }, windowHours: null });
  });

  it("needs the window and thread limit to read every thread", async () => {
    const { deps } = twoProjects();
    await expect(buildOverview({ ...deps, allOptions: undefined }, { target: ALL, scope: "uncommitted", includeArchived: true })).rejects.toThrow("time window");
  });

  it("reports that more threads matched than the limit allows", async () => {
    const { deps } = twoProjects();
    const overview = await buildOverview({ ...deps, allOptions: { windowHours: 24, maxThreads: 2 } }, { target: ALL, scope: "uncommitted", includeArchived: true });
    expect(overview.threads).toHaveLength(2);
    expect(overview.truncatedThreads).toBe(true);
  });

  it("does not forget edits on refresh, because the index only ever reads what is new", async () => {
    const { deps, edits: index } = twoProjects();
    await buildOverview(deps, { target: ALL, scope: "uncommitted", includeArchived: true, refresh: true });
    expect(index.forget).not.toHaveBeenCalled();
  });

  describe("with the repository cache", () => {
    const ask = (deps: CollectDeps, target: OverviewTarget = ALL, refresh?: boolean) =>
      buildOverview(deps, { target, scope: "uncommitted", includeArchived: true, ...(refresh === undefined ? {} : { refresh }) });

    it("reads each repository and worktree once, and again after its thread changed", async () => {
      const { deps, sdk } = twoProjects();
      const cache = createRepoCache();
      await ask({ ...deps, cache });
      expect(sdk.environments.status).toHaveBeenCalledTimes(3);
      expect(sdk.environments.diffFiles).not.toHaveBeenCalled();
      await ask({ ...deps, cache });
      expect(sdk.environments.status).toHaveBeenCalledTimes(3);
      cache.invalidateThreads(["thr_2"]);
      await ask({ ...deps, cache });
      expect(sdk.environments.status).toHaveBeenCalledTimes(4);
    });

    it("reads an environment again after bb reports it changed", async () => {
      const { deps, sdk } = twoProjects();
      const cache = createRepoCache();
      await ask({ ...deps, cache });
      cache.invalidateEnvironment("env_3");
      await ask({ ...deps, cache });
      expect(sdk.environments.status).toHaveBeenCalledTimes(4);
    });

    it("clears the cache on a refresh, so everything is read again", async () => {
      const { deps, sdk } = twoProjects();
      const cache = createRepoCache();
      await ask({ ...deps, cache });
      await ask({ ...deps, cache }, ALL, true);
      expect(sdk.environments.status).toHaveBeenCalledTimes(6);
    });

    it("keeps live edits out of the cache: a recorded repository follows the latest edits", async () => {
      const { deps, edits: index } = twoProjects();
      const cache = createRepoCache();
      const first = await ask({ ...deps, cache });
      expect(first.otherFiles).toEqual([]);
      index.get.mockImplementation(async (threadId: string) => (
        threadId === "thr_1" ? edits([record({ path: "/tmp/outside.txt" })]) : { records: [], primaryCwd: null, workDirs: [], commitRuns: [], lastEventAt: null }
      ));
      const second = await ask({ ...deps, cache });
      expect(second.otherFiles.map((file) => file.path)).toEqual(["/tmp/outside.txt"]);
    });

    it("serves a single thread's tree too, and shares its reads with the page", async () => {
      const { deps, sdk } = twoProjects();
      const cache = createRepoCache();
      const tree: OverviewTarget = { kind: "tree", threadId: "thr_1" };
      await ask({ ...deps, cache }, tree);
      await ask({ ...deps, cache }, tree);
      expect(sdk.environments.status).toHaveBeenCalledTimes(3);
      await ask({ ...deps, cache }, ALL);
      expect(sdk.environments.status).toHaveBeenCalledTimes(3);
    });
  });
});

describe("buildOverview phases", () => {
  const TREE: OverviewTarget = { kind: "tree", threadId: "thr_1" };
  const ask = (deps: CollectDeps, scope: "uncommitted" | "branch" = "uncommitted", refresh?: boolean) =>
    buildOverview(deps, { target: TREE, scope, includeArchived: true, ...(refresh === undefined ? {} : { refresh }) });
  const twoEnvironments = (extra: Partial<Setup> = {}) => setup({
    threads: [
      makeThreadResponse({ id: "thr_1", title: "Parent", environmentId: "env_1" }),
      makeThreadResponse({ id: "thr_2", title: "Child", parentThreadId: "thr_1", environmentId: "env_2" }),
    ],
    environments: [environment({ id: "env_1", path: "/work/one" }), environment({ id: "env_2", path: "/work/two" })],
    ...extra,
  });
  const gate = () => {
    let release: () => void = () => {};
    const opened = new Promise<void>((resolve) => { release = resolve; });
    return { opened, release };
  };

  it("reads a workspace's status once for its worktree and its repository, and never calls diffFiles in the uncommitted scope", async () => {
    const { deps, sdk } = twoEnvironments({ status: () => statusOf(["a.ts"]) });
    const overview = await ask(deps);
    expect(sdk.environments.status).toHaveBeenCalledTimes(2);
    expect(sdk.environments.diffFiles).not.toHaveBeenCalled();
    expect(overview.repos.map((entry) => entry.files.map((file) => file.path))).toEqual([["a.ts"], ["a.ts"]]);
    expect(overview.worktrees.map((entry) => entry.uncommitted.map((file) => file.path))).toEqual([["a.ts"], ["a.ts"]]);
  });

  it("asks for the branch diff once per workspace in the branch scope, next to the status", async () => {
    const { deps, sdk } = twoEnvironments();
    await ask(deps, "branch");
    expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(2);
    expect(sdk.environments.status).toHaveBeenCalledTimes(2);
  });

  it("starts reading workspace status while the edit index is still running", async () => {
    const { deps, sdk, edits: index } = twoEnvironments();
    const held = gate();
    index.get.mockImplementation(async () => {
      await held.opened;
      return { records: [], primaryCwd: null, workDirs: [], commitRuns: [], lastEventAt: null };
    });
    const pending = ask(deps);
    await vi.waitFor(() => expect(sdk.environments.status).toHaveBeenCalledTimes(2));
    held.release();
    await pending;
    expect(sdk.environments.status).toHaveBeenCalledTimes(2);
  });

  it("starts the branch diff while the edit index is still running", async () => {
    const { deps, sdk, edits: index } = twoEnvironments();
    const held = gate();
    index.get.mockImplementation(async () => {
      await held.opened;
      return { records: [], primaryCwd: null, workDirs: [], commitRuns: [], lastEventAt: null };
    });
    const pending = ask(deps, "branch");
    await vi.waitFor(() => expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(2));
    held.release();
    await pending;
  });

  it("starts at most 8 early status reads at a time", async () => {
    const many = Array.from({ length: 20 }, (_, index) => index + 1);
    const { deps, sdk, edits: index } = setup({
      threads: many.map((n) => makeThreadResponse({ id: `thr_${n}`, parentThreadId: n === 1 ? null : "thr_1", environmentId: `env_${n}` })),
      environments: many.map((n) => environment({ id: `env_${n}`, path: `/work/${n}` })),
    });
    const heldEdits = gate();
    const heldStatus = gate();
    index.get.mockImplementation(async () => {
      await heldEdits.opened;
      return { records: [], primaryCwd: null, workDirs: [], commitRuns: [], lastEventAt: null };
    });
    sdk.environments.status.mockImplementation(async () => {
      await heldStatus.opened;
      return statusOf([]);
    });
    const pending = ask(deps);
    await vi.waitFor(() => expect(sdk.environments.status).toHaveBeenCalledTimes(8));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sdk.environments.status).toHaveBeenCalledTimes(8);
    heldStatus.release();
    heldEdits.release();
    await pending;
  });

  it("does not read the history of an archived thread that is already indexed", async () => {
    const { deps, edits: index } = setup({
      threads: [
        makeThreadResponse({ id: "thr_1", environmentId: null }),
        makeThreadResponse({ id: "thr_done", parentThreadId: "thr_1", archivedAt: 5, environmentId: null }),
      ],
    });
    await ask(deps);
    expect(index.get.mock.calls.map((call) => [call[0], (call as unknown[])[2]])).toEqual([["thr_1", { settled: false }], ["thr_done", { settled: true }]]);
  });

  it("resolves the environment paths while the edit index runs and only the extra edit paths after it", async () => {
    const { deps, host, edits: index } = setup({
      environments: [environment({ id: "env_1", path: "/work/one" })],
    });
    const held = gate();
    index.get.mockImplementation(async () => {
      await held.opened;
      return edits([record({ path: "/work/one/src/a.ts" })]);
    });
    const pending = ask(deps);
    await vi.waitFor(() => expect(host).toHaveBeenCalledTimes(1));
    expect(host.mock.calls[0]?.[1].paths).toEqual(expect.arrayContaining(["/work/one"]));
    expect(host.mock.calls[0]?.[1].paths).not.toContain("/work/one/src/a.ts");
    held.release();
    await pending;
    expect(host).toHaveBeenCalledTimes(2);
    expect(host.mock.calls[1]?.[1].paths).toEqual(["/work/one/src/a.ts"]);
  });

  it("serves a second tree build within a minute without a status call, and sends resolveRoots only the paths it lacks", async () => {
    const { deps, sdk, host, edits: index } = twoEnvironments();
    const cache = createRepoCache();
    const roots = createRootCache();
    await ask({ ...deps, cache, roots });
    expect(sdk.environments.status).toHaveBeenCalledTimes(2);
    const firstCalls = host.mock.calls.length;
    index.get.mockImplementation(async (threadId: string) => (threadId === "thr_1" ? edits([record({ path: "/work/one/new.ts" })]) : { records: [], primaryCwd: null, workDirs: [], commitRuns: [], lastEventAt: null }));
    await ask({ ...deps, cache, roots });
    expect(sdk.environments.status).toHaveBeenCalledTimes(2);
    const later = host.mock.calls.slice(firstCalls);
    expect(later).toHaveLength(1);
    expect(later[0]?.[1].paths).toEqual(["/work/one/new.ts"]);
  });

  it("reads the status again for a tree after one of its threads changed", async () => {
    const { deps, sdk } = twoEnvironments();
    const cache = createRepoCache();
    await ask({ ...deps, cache });
    cache.invalidateThreads(["thr_2"]);
    await ask({ ...deps, cache });
    expect(sdk.environments.status).toHaveBeenCalledTimes(3);
  });

  it("on a hard refresh drops the tree's cached reads and roots, and forgets its edits", async () => {
    const { deps, sdk, host, edits: index } = twoEnvironments();
    const cache = createRepoCache();
    const roots = createRootCache();
    await ask({ ...deps, cache, roots });
    const resolved = host.mock.calls.length;
    await ask({ ...deps, cache, roots }, "uncommitted", true);
    expect(sdk.environments.status).toHaveBeenCalledTimes(4);
    expect(host.mock.calls.length).toBeGreaterThan(resolved);
    expect(index.forget).toHaveBeenCalledWith(["thr_1", "thr_2"]);
  });

  it("builds a full overview that is not partial, with the number of hidden archived threads", async () => {
    const { deps } = setup({
      threads: [
        makeThreadResponse({ id: "thr_1", environmentId: null }),
        makeThreadResponse({ id: "thr_done", parentThreadId: "thr_1", archivedAt: 5, environmentId: null }),
      ],
    });
    const hidden = await buildOverview(deps, { target: TREE, scope: "uncommitted", includeArchived: false });
    expect(hidden).toMatchObject({ partial: false, archivedHidden: 1 });
    expect(hidden.threads.map((thread) => thread.id)).toEqual(["thr_1"]);
    const shown = await ask(deps);
    expect(shown).toMatchObject({ partial: false, archivedHidden: 0 });
    expect(shown.threads).toHaveLength(2);
  });
});
