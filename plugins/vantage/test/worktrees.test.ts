import { describe, expect, it, vi } from "vitest";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { CollectDeps, Environment, HostCall, RepoPlan } from "../src/collect";
import type { RepoRef } from "../src/contract";
import { createRepoCache } from "../src/repo-cache";
import { fileFromStatus, loadRepoFiles } from "../src/sources";
import { findSharedFiles, loadWorktrees, primaryThreadId } from "../src/worktrees";
import { branchWorktree, destroyedEnvironment, environment, fileChange, worktree } from "./fixtures";

type Status = { path: string; status: string; insertions: number | null; deletions: number | null };
const statusFile = (path: string, status = "M", insertions: number | null = 1, deletions: number | null = 0): Status => ({
  path, status, insertions, deletions,
});
const sdkCommit = (n: number, authoredAt = 1_700_000_000_000 + n) => ({
  sha: `${String(n).padStart(40, "0")}`, shortSha: String(n).padStart(7, "0"), subject: `Commit ${n}`, authorName: "Ada", authoredAt,
});

function available(overrides: { branchName?: string | null; mergeBase?: object | null; workingTree?: object } = {}) {
  const mergeBase = overrides.mergeBase === undefined
    ? { aheadCount: 0, behindCount: 0, baseRef: "origin/main", commits: [], deletions: 0, fileCount: 0, files: [], hasCommittedUnmergedChanges: false,
      insertions: 0, lineStatsComplete: true, mergeBaseBranch: "origin/main" }
    : overrides.mergeBase;
  return {
    outcome: "available",
    workspace: {
      branch: { currentBranch: "feature/work", defaultBranch: "main" },
      checkout: { kind: "branch", branchName: overrides.branchName === undefined ? "feature/work" : overrides.branchName, headSha: "abc" },
      mergeBase,
      workingTree: { files: [], fileCount: 0, insertions: 0, deletions: 0, hasUncommittedChanges: false, lineStatsComplete: true, state: "clean", ...overrides.workingTree },
    },
  };
}

function setup(options: { status?: (environmentId: string) => unknown | Promise<unknown>; host?: unknown } = {}) {
  const status = vi.fn(async (args: { environmentId: string }) => {
    const result = options.status === undefined ? available() : await options.status(args.environmentId);
    if (result instanceof Error) throw result;
    return result;
  });
  const host = vi.fn(async (..._args: unknown[]) =>
    options.host ?? { outcome: "available", branch: "feature/old", base: "origin/main", aheadCount: 0, behindCount: 0, commits: [], files: [], truncated: false });
  const deps: CollectDeps = {
    sdk: { environments: { status } } as unknown as PluginBbSdk,
    host: host as unknown as HostCall,
    edits: {} as CollectDeps["edits"],
  };
  return { deps, status, host };
}

const workspaceRef = (environmentId: string, base: string | null = "origin/main"): RepoRef => ({ kind: "workspace", environmentId, base });
const workspacePlan = (n: number, overrides: Partial<RepoPlan> = {}): RepoPlan => ({
  key: `host_1:/work/${n}`, ref: workspaceRef(`env_${n}`), label: "Project", projectId: "proj_1", root: `/work/${n}`, hostId: "host_1",
  threadIds: [`thr_${n}`], touched: new Map(), ...overrides,
});
const branchPlan = (overrides: Partial<RepoPlan> = {}): RepoPlan => ({
  key: "host_1:/code/proj@feature/old",
  ref: { kind: "branch", hostId: "host_1", root: "/code/proj", base: "origin/main", head: "feature/old" },
  label: "Project", projectId: "proj_1", root: "/code/proj", hostId: "host_1", threadIds: ["thr_9"], touched: new Map(), ...overrides,
});
const checkoutPlan: RepoPlan = {
  key: "host_1:/code/cortex", ref: { kind: "checkout", hostId: "host_1", root: "/code/cortex", base: null }, label: "cortex", projectId: null,
  root: "/code/cortex", hostId: "host_1", threadIds: ["thr_1"], touched: new Map(),
};
const recordedPlan: RepoPlan = {
  key: "recorded:env_9", ref: { kind: "recorded" }, label: "Gone", projectId: "proj_1", root: null, hostId: "host_1", threadIds: ["thr_3"], touched: new Map(),
};

const environments = (...list: Environment[]): ReadonlyMap<string, Environment> => new Map(list.map((env) => [env.id, env]));
const names = new Map([["host_1", "Laptop"]]);

describe("fileFromStatus", () => {
  it.each([
    ["A", "added"], ["M", "modified"], ["D", "deleted"], ["R", "renamed"], ["C", "copied"], ["U", "unmerged"], ["?", "untracked"], ["??", "untracked"],
  ])("maps the letter %s to %s", (letter, expected) => {
    expect(fileFromStatus(statusFile("a.ts", letter, 3, 1))).toMatchObject({ status: expected, untracked: letter.startsWith("?") });
  });

  it("keeps the counts, and treats two null counts as a binary file", () => {
    expect(fileFromStatus(statusFile("a.ts", "M", 3, 1))).toEqual({
      path: "a.ts", previousPath: null, status: "modified", additions: 3, deletions: 1, binary: false, untracked: false, tooLarge: false, edits: null,
    });
    expect(fileFromStatus(statusFile("pic.png", "A", null, null))).toMatchObject({ additions: null, deletions: null, binary: true });
    expect(fileFromStatus(statusFile("odd.txt", "M", 2, null))).toMatchObject({ additions: 2, deletions: null, binary: false });
  });
});

describe("loadWorktrees workspaces", () => {
  it("takes the branch, counts, files and commits from one status call per worktree", async () => {
    const { deps, status, host } = setup({
      status: () => available({
        workingTree: { files: [statusFile("src/a.ts"), statusFile("new.txt", "??", 4, 0)] },
        mergeBase: {
          aheadCount: 2, behindCount: 3, baseRef: "origin/main", mergeBaseBranch: "origin/main", commits: [sdkCommit(2), sdkCommit(1)],
          files: [statusFile("src/b.ts", "A", 5, 0)],
        },
      }),
    });
    const [result] = await loadWorktrees(deps, [workspacePlan(1)], environments(environment({ id: "env_1" })), names);
    expect(status).toHaveBeenCalledTimes(1);
    expect(status.mock.calls[0]?.[0]).toEqual({ environmentId: "env_1", mergeBaseBranch: "origin/main", signal: undefined });
    expect(host).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      key: "host_1:/work/1", kind: "workspace", label: "Project", projectId: "proj_1", hostId: "host_1", hostName: "Laptop", root: "/work/1",
      branch: "feature/work", base: "origin/main", threadIds: ["thr_1"], state: "ready", message: null, aheadCount: 2, behindCount: 3,
    });
    expect(result?.ref).toEqual({ kind: "workspace", environmentId: "env_1", base: "origin/main" });
    expect(result?.uncommitted.map((file) => [file.path, file.status])).toEqual([["src/a.ts", "modified"], ["new.txt", "untracked"]]);
    expect(result?.committed.map((file) => [file.path, file.status])).toEqual([["src/b.ts", "added"]]);
    expect(result?.commits.map((entry) => entry.subject)).toEqual(["Commit 2", "Commit 1"]);
  });

  it("asks without a base when the plan has none", async () => {
    const { deps, status } = setup();
    await loadWorktrees(deps, [workspacePlan(1, { ref: workspaceRef("env_1", null) })], environments(environment({ id: "env_1" })), names);
    expect(status.mock.calls[0]?.[0]).not.toHaveProperty("mergeBaseBranch", expect.anything());
  });

  it("keeps the first 100 commits and 500 files of each list", async () => {
    const many = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => statusFile(`${prefix}/${index}.ts`));
    const { deps } = setup({
      status: () => available({
        workingTree: { files: many(600, "w") },
        mergeBase: {
          aheadCount: 150, behindCount: 0, baseRef: "origin/main", mergeBaseBranch: "origin/main",
          commits: Array.from({ length: 150 }, (_, index) => sdkCommit(index + 1)), files: many(520, "c"),
        },
      }),
    });
    const [result] = await loadWorktrees(deps, [workspacePlan(1)], environments(environment({ id: "env_1" })), names);
    expect(result?.uncommitted).toHaveLength(500);
    expect(result?.committed).toHaveLength(500);
    expect(result?.commits).toHaveLength(100);
    expect(result?.aheadCount).toBe(150);
  });

  it("gives empty committed files and null counts when there is no base", async () => {
    const { deps } = setup({ status: () => available({ mergeBase: null, workingTree: { files: [statusFile("a.ts")] } }) });
    const [result] = await loadWorktrees(deps, [workspacePlan(1, { ref: workspaceRef("env_1", null) })], environments(environment({ id: "env_1" })), names);
    expect(result).toMatchObject({ state: "ready", base: null, aheadCount: null, behindCount: null, committed: [], commits: [] });
    expect(result?.uncommitted).toHaveLength(1);
  });

  it("reads the commit time as milliseconds, whether bb sent seconds or milliseconds", async () => {
    const { deps } = setup({
      status: () => available({
        mergeBase: {
          aheadCount: 2, behindCount: 0, baseRef: "origin/main", mergeBaseBranch: "origin/main", files: [],
          commits: [sdkCommit(2, 1_700_000_000), sdkCommit(1, 1_700_000_000_000)],
        },
      }),
    });
    const [result] = await loadWorktrees(deps, [workspacePlan(1)], environments(environment({ id: "env_1" })), names);
    expect(result?.commits.map((entry) => entry.authoredAt)).toEqual([1_700_000_000_000, 1_700_000_000_000]);
  });

  it("has no branch for a detached checkout", async () => {
    const detached = { ...available(), workspace: { ...available().workspace, checkout: { kind: "detached", headSha: "abc" } } };
    const { deps } = setup({ status: () => detached });
    const [result] = await loadWorktrees(deps, [workspacePlan(1)], environments(environment({ id: "env_1" })), names);
    expect(result).toMatchObject({ state: "ready", branch: null });
  });

  it("makes one worktree unavailable when bb cannot read it, without touching the others", async () => {
    const responses: Record<string, unknown> = {
      env_1: { outcome: "not_applicable", reason: "non_git_environment", message: "Not a git workspace" },
      env_2: new Error("socket hang up"),
      env_3: { outcome: "unavailable", failure: { code: "path_not_found", message: "Folder is gone", workspacePath: "/work/3" } },
      env_4: available({ workingTree: { files: [statusFile("ok.ts")] } }),
    };
    const { deps } = setup({ status: (id) => responses[id] });
    const list = [1, 2, 3, 4].map((n) => environment({ id: `env_${n}`, branchName: `branch-${n}` }));
    const result = await loadWorktrees(deps, [1, 2, 3, 4].map((n) => workspacePlan(n)), environments(...list), names);
    expect(result.map((entry) => [entry.state, entry.message])).toEqual([
      ["unavailable", "Not a git workspace"], ["unavailable", "socket hang up"], ["unavailable", "Folder is gone"], ["ready", null],
    ]);
    expect(result[0]).toMatchObject({ branch: "branch-1", aheadCount: null, behindCount: null, uncommitted: [], committed: [], commits: [] });
    expect(result[3]?.uncommitted).toHaveLength(1);
  });

  it("runs at most 8 status calls at a time", async () => {
    let running = 0;
    let peak = 0;
    const { deps } = setup({
      status: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return available();
      },
    });
    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    await loadWorktrees(deps, ids.map((n) => workspacePlan(n)), environments(...ids.map((n) => environment({ id: `env_${n}` }))), names);
    expect(peak).toBe(8);
  });

  it("gives one worktree to several threads on one environment, keeping their order", async () => {
    const { deps, status } = setup();
    const result = await loadWorktrees(deps, [workspacePlan(1, { threadIds: ["thr_a", "thr_b"] })], environments(environment({ id: "env_1" })), names);
    expect(result).toHaveLength(1);
    expect(result[0]?.threadIds).toEqual(["thr_a", "thr_b"]);
    expect(status).toHaveBeenCalledTimes(1);
  });
});

describe("loadWorktrees branches", () => {
  const destroyed = destroyedEnvironment({ id: "env_9", hostId: "host_1", branchName: "feature/old", projectId: "proj_7" });

  it("reads an archived branch from the host range, with ahead, behind, commits and no uncommitted files", async () => {
    const { deps, status, host } = setup({
      host: {
        outcome: "available", branch: "feature/old", base: "origin/main", aheadCount: 2, behindCount: 5, truncated: false,
        commits: [sdkCommit(2), sdkCommit(1)],
        files: [{ path: "a.ts", previousPath: null, status: "added", additions: 3, deletions: 0, binary: false }],
      },
    });
    const [result] = await loadWorktrees(deps, [branchPlan()], environments(destroyed), names);
    expect(status).not.toHaveBeenCalled();
    expect(host.mock.calls).toEqual([[
      "repoFiles", { root: "/code/proj", target: { type: "range", base: "origin/main", head: "feature/old" } }, { hostId: "host_1", signal: undefined },
    ]]);
    expect(result).toMatchObject({
      key: "host_1:/code/proj@feature/old", kind: "branch", branch: "feature/old", base: "origin/main", projectId: "proj_7", hostName: "Laptop",
      root: "/code/proj", threadIds: ["thr_9"], state: "ready", aheadCount: 2, behindCount: 5, uncommitted: [],
    });
    expect(result?.committed.map((file) => [file.path, file.status])).toEqual([["a.ts", "added"]]);
    expect(result?.commits).toHaveLength(2);
  });

  it("leaves out a branch that no longer exists, and marks other host failures unavailable", async () => {
    const gone = setup({ host: { outcome: "unavailable", reason: "missing-ref", message: "The branch feature/old no longer exists" } });
    expect(await loadWorktrees(gone.deps, [branchPlan()], environments(destroyed), names)).toEqual([]);
    const broken = setup({ host: { outcome: "unavailable", reason: "not-a-repo", message: "x" } });
    const [result] = await loadWorktrees(broken.deps, [branchPlan()], environments(destroyed), names);
    expect(result).toMatchObject({ state: "unavailable", message: "This folder is no longer a git repository", branch: "feature/old" });
    const rejected = setup();
    rejected.host.mockRejectedValueOnce(new Error("machine offline"));
    const [offline] = await loadWorktrees(rejected.deps, [branchPlan()], environments(destroyed), names);
    expect(offline).toMatchObject({ state: "unavailable", message: "machine offline" });
  });

  it("lists only workspace and branch plans, in the plans' order", async () => {
    const { deps } = setup();
    const result = await loadWorktrees(
      deps, [workspacePlan(2), checkoutPlan, branchPlan(), recordedPlan, workspacePlan(1)],
      environments(environment({ id: "env_1" }), environment({ id: "env_2" }), destroyed), names,
    );
    expect(result.map((entry) => entry.key)).toEqual(["host_1:/work/2", "host_1:/code/proj@feature/old", "host_1:/work/1"]);
  });
});

describe("shared loads", () => {
  function shared() {
    const base = setup({ status: () => available({ workingTree: { files: [statusFile("src/a.ts"), statusFile("new.txt", "??", 4, 0)] } }) });
    const diffFiles = vi.fn(async (..._args: unknown[]) => ({
      outcome: "available", files: [], initialPatches: [], mergeBaseRef: null, shortstat: "", truncated: false,
    }));
    let now = 0;
    const cache = createRepoCache({ now: () => now });
    const deps: CollectDeps = { ...base.deps, sdk: { environments: { status: base.status, diffFiles } } as unknown as PluginBbSdk, cache };
    return { ...base, deps, diffFiles, cache, advance: (ms: number) => { now += ms; } };
  }
  const env = environments(environment({ id: "env_1" }));

  it("serves a worktree row and an uncommitted repository from one status call", async () => {
    const { deps, status, diffFiles } = shared();
    const [rows, repo] = await Promise.all([loadWorktrees(deps, [workspacePlan(1)], env, names), loadRepoFiles(deps, workspacePlan(1), "uncommitted")]);
    expect(status).toHaveBeenCalledTimes(1);
    expect(diffFiles).not.toHaveBeenCalled();
    expect(rows[0]?.uncommitted.map((file) => file.path)).toEqual(["src/a.ts", "new.txt"]);
    if (!("files" in repo)) throw new Error("expected files");
    expect(repo.files.map((file) => [file.path, file.status])).toEqual([["src/a.ts", "modified"], ["new.txt", "untracked"]]);
    expect(repo).toMatchObject({ base: null, aheadCount: null, truncated: false });
  });

  it("still asks for the branch diff in the branch scope, and shares the status with the row", async () => {
    const { deps, status, diffFiles } = shared();
    await Promise.all([loadWorktrees(deps, [workspacePlan(1)], env, names), loadRepoFiles(deps, workspacePlan(1), "branch")]);
    expect(diffFiles).toHaveBeenCalledTimes(1);
    expect(diffFiles.mock.calls[0]?.[0]).toEqual({ environmentId: "env_1", target: "all", mergeBaseBranch: "origin/main", signal: undefined });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("reads the status again for a different base", async () => {
    const { deps, status } = shared();
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    await loadWorktrees(deps, [workspacePlan(1, { ref: workspaceRef("env_1", "main") })], env, names);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("reads the status again after the thread that works there changed", async () => {
    const { deps, status, cache } = shared();
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    expect(status).toHaveBeenCalledTimes(1);
    cache.invalidateThreads(["thr_1"]);
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("makes an uncommitted repository unavailable when the status is", async () => {
    const { deps } = shared();
    const failed = setup({ status: () => ({ outcome: "unavailable", failure: { code: "path_not_found", message: "Folder is gone", workspacePath: "/x" } }) });
    expect(await loadRepoFiles({ ...deps, sdk: { environments: { status: failed.status } } as unknown as PluginBbSdk }, workspacePlan(1), "uncommitted"))
      .toEqual({ unavailable: "Folder is gone" });
  });

  it("does not hand a caller's abort signal to a load that other callers share, but does when nothing is shared", async () => {
    const { deps, status, cache } = shared();
    const controller = new AbortController();
    await loadWorktrees(deps, [workspacePlan(1)], env, names, controller.signal);
    expect(status.mock.calls[0]?.[0]).toMatchObject({ signal: undefined });
    cache.clear();
    await loadWorktrees({ ...deps, cache: undefined }, [workspacePlan(1)], env, names, controller.signal);
    expect(status.mock.calls[1]?.[0]).toMatchObject({ signal: controller.signal });
  });

  const destroyed = destroyedEnvironment({ id: "env_9", hostId: "host_1", branchName: "feature/old", projectId: "proj_7" });

  it("serves a branch worktree and its repository from one host range call", async () => {
    const { deps, host } = shared();
    const [rows, repo] = await Promise.all([
      loadWorktrees(deps, [branchPlan()], environments(destroyed), names), loadRepoFiles(deps, branchPlan(), "uncommitted"),
    ]);
    expect(host).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(repo).toMatchObject({ branch: "feature/old", aheadCount: 0 });
  });

  it("remembers a branch that is gone for ten minutes, and everything else for a minute", async () => {
    const gone = shared();
    gone.host.mockResolvedValue({ outcome: "unavailable", reason: "missing-ref", message: "The branch no longer exists" });
    await loadWorktrees(gone.deps, [branchPlan()], environments(destroyed), names);
    gone.advance(9 * 60_000);
    expect(await loadRepoFiles(gone.deps, branchPlan(), "uncommitted")).toEqual({ missingRef: true });
    expect(gone.host).toHaveBeenCalledTimes(1);
    gone.advance(61_000);
    await loadRepoFiles(gone.deps, branchPlan(), "uncommitted");
    expect(gone.host).toHaveBeenCalledTimes(2);

    const present = shared();
    await loadWorktrees(present.deps, [branchPlan()], environments(destroyed), names);
    present.advance(61_000);
    await loadWorktrees(present.deps, [branchPlan()], environments(destroyed), names);
    expect(present.host).toHaveBeenCalledTimes(2);
  });
});

describe("findSharedFiles", () => {
  const wt = (key: string, projectId: string, uncommitted: string[], committed: string[] = []) =>
    worktree({ key, projectId, uncommitted: uncommitted.map((path) => fileChange({ path })), committed: committed.map((path) => fileChange({ path })) });

  it("flags a path changed in two worktrees of one project, whether uncommitted or committed", () => {
    const shared = findSharedFiles([
      wt("a", "p1", ["README.md", "only-a.ts"]),
      wt("b", "p1", ["x.ts"], ["README.md"]),
      wt("c", "p1", [], ["z.ts", "x.ts"]),
    ]);
    expect(shared).toEqual([
      { projectId: "p1", path: "README.md", worktreeKeys: ["a", "b"] },
      { projectId: "p1", path: "x.ts", worktreeKeys: ["b", "c"] },
    ]);
  });

  it("needs two different worktrees, and never joins projects", () => {
    expect(findSharedFiles([wt("a", "p1", ["a.ts"], ["a.ts"])])).toEqual([]);
    expect(findSharedFiles([wt("a", "p1", ["a.ts"]), wt("b", "p2", ["a.ts"])])).toEqual([]);
  });

  it("ignores unavailable worktrees, includes archived branches, sorts by path and caps at 200", () => {
    expect(findSharedFiles([
      worktree({ key: "a", state: "unavailable", uncommitted: [fileChange({ path: "u.ts" })] }),
      worktree({ key: "b", uncommitted: [fileChange({ path: "u.ts" })] }),
    ])).toEqual([]);
    expect(findSharedFiles([
      wt("a", "p1", ["b.ts", "a.ts"]),
      branchWorktree({ key: "br", projectId: "p1", committed: [fileChange({ path: "a.ts" }), fileChange({ path: "b.ts" })] }),
    ]).map((entry) => entry.path)).toEqual(["a.ts", "b.ts"]);
    const paths = Array.from({ length: 250 }, (_, index) => `f${String(index).padStart(3, "0")}.ts`);
    const capped = findSharedFiles([wt("a", "p1", paths), wt("b", "p1", paths)]);
    expect(capped).toHaveLength(200);
    expect(capped[0]?.path).toBe("f000.ts");
  });
});

describe("primaryThreadId", () => {
  it("speaks for the panel's own thread when it is in the worktree, even if other threads share it", () => {
    expect(primaryThreadId(worktree({ threadIds: ["thr_cur"] }), "thr_cur")).toBe("thr_cur");
    expect(primaryThreadId(worktree({ threadIds: ["thr_a", "thr_cur"] }), "thr_cur")).toBe("thr_cur");
  });

  it("speaks for the first thread of any other worktree", () => {
    expect(primaryThreadId(worktree({ threadIds: ["thr_a", "thr_b"] }), "thr_cur")).toBe("thr_a");
  });
});
