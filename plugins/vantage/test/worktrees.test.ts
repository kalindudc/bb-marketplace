import { describe, expect, it, vi } from "vitest";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { CollectDeps, Environment, HostCall, RepoPlan } from "../src/collect";
import type { GitFile, HostOutput, RepoRef } from "../src/contract";
import { createRepoCache } from "../src/repo-cache";
import { loadRepoFiles } from "../src/sources";
import { findSharedFiles, loadWorktrees, primaryThreadId } from "../src/worktrees";
import { branchWorktree, destroyedEnvironment, environment, fileChange, worktree } from "./fixtures";

type Status = HostOutput<"checkoutStatus">;
type Available = Extract<Status, { outcome: "available" }>;
const gitFile = (path: string, status: GitFile["status"] = "modified", additions: number | null = 1, deletions: number | null = 0): GitFile => ({
  path, previousPath: null, status, additions, deletions, binary: false,
});
const hostCommit = (n: number) => ({
  sha: `${String(n).padStart(40, "0")}`, shortSha: String(n).padStart(7, "0"), subject: `Commit ${n}`, authorName: "Ada", authoredAt: 1_700_000_000_000 + n,
});
const HEAD = "f".repeat(40);

function available(overrides: Partial<Available> = {}): Status {
  return {
    outcome: "available", branch: "feature/work", head: HEAD, base: "origin/main", skippedBase: null, aheadCount: 0, behindCount: 0,
    commits: [], uncommitted: [], committed: [], truncated: false, ...overrides,
  };
}

type HostOptions = { hostId: string; signal?: AbortSignal };
function setup(options: { status?: (root: string) => unknown | Promise<unknown>; host?: unknown } = {}) {
  const host = vi.fn(async (method: string, input: { root: string }, _options?: HostOptions): Promise<unknown> => {
    if (method === "checkoutStatus") {
      const result = options.status === undefined ? available() : await options.status(input.root);
      if (result instanceof Error) throw result;
      return result;
    }
    return options.host ?? { outcome: "available", branch: "feature/old", base: "origin/main", aheadCount: 0, behindCount: 0, commits: [], files: [], truncated: false };
  });
  const deps: CollectDeps = { sdk: {} as PluginBbSdk, host: host as unknown as HostCall, edits: {} as CollectDeps["edits"] };
  const statusCalls = () => host.mock.calls.filter(([method]) => method === "checkoutStatus");
  return { deps, host, statusCalls };
}

const workspaceRef = (n: number, base: string | null = "origin/main"): RepoRef => ({
  kind: "workspace", environmentId: `env_${n}`, base, root: `/work/${n}`, hostId: "host_1",
});
const workspacePlan = (n: number, overrides: Partial<RepoPlan> = {}): RepoPlan => ({
  key: `host_1:/work/${n}`, ref: workspaceRef(n), label: "Project", projectId: "proj_1", root: `/work/${n}`, hostId: "host_1",
  threadIds: [`thr_${n}`], touched: new Map(), ...overrides,
});
const branchPlan = (overrides: Partial<RepoPlan> = {}): RepoPlan => ({
  key: "host_1:/code/proj@feature/old",
  ref: { kind: "branch", hostId: "host_1", root: "/code/proj", base: "origin/main", head: "feature/old" },
  label: "Project", projectId: "proj_1", root: "/code/proj", hostId: "host_1", threadIds: ["thr_9"], touched: new Map(), ...overrides,
});
const checkoutPlan: RepoPlan = {
  key: "host_1:/code/commons", ref: { kind: "checkout", hostId: "host_1", root: "/code/commons", base: null }, label: "commons", projectId: null,
  root: "/code/commons", hostId: "host_1", threadIds: ["thr_1"], touched: new Map(),
};
const recordedPlan: RepoPlan = {
  key: "recorded:env_9", ref: { kind: "recorded" }, label: "Gone", projectId: "proj_1", root: null, hostId: "host_1", threadIds: ["thr_3"], touched: new Map(),
};

const environments = (...list: Environment[]): ReadonlyMap<string, Environment> => new Map(list.map((env) => [env.id, env]));
const names = new Map([["host_1", "Laptop"]]);

describe("loadWorktrees workspaces", () => {
  it("takes the branch, counts, files and commits from one host status call per worktree, at its repository root", async () => {
    const { deps, host, statusCalls } = setup({
      status: () => available({
        uncommitted: [gitFile("src/a.ts"), gitFile("new.txt", "untracked", 4, 0)],
        aheadCount: 2, behindCount: 3, commits: [hostCommit(2), hostCommit(1)], committed: [gitFile("src/b.ts", "added", 5, 0)],
      }),
    });
    const [result] = await loadWorktrees(deps, [workspacePlan(1)], environments(environment({ id: "env_1" })), names);
    expect(host).toHaveBeenCalledTimes(1);
    expect(statusCalls()[0]?.slice(1)).toEqual([
      { root: "/work/1", base: "origin/main", pick: true, folderLimit: 200 }, { hostId: "host_1", signal: undefined },
    ]);
    expect(result).toMatchObject({
      key: "host_1:/work/1", kind: "workspace", label: "Project", projectId: "proj_1", hostId: "host_1", hostName: "Laptop", root: "/work/1",
      branch: "feature/work", base: "origin/main", threadIds: ["thr_1"], state: "ready", message: null, aheadCount: 2, behindCount: 3, skippedBase: null,
    });
    expect(result?.ref).toEqual(workspaceRef(1));
    expect(result?.uncommitted.map((file) => [file.path, file.status])).toEqual([["src/a.ts", "modified"], ["new.txt", "untracked"]]);
    expect(result?.committed.map((file) => [file.path, file.status])).toEqual([["src/b.ts", "added"]]);
    expect(result?.commits.map((entry) => entry.subject)).toEqual(["Commit 2", "Commit 1"]);
  });

  it("reads its later diffs against the base the host compared with, and keeps the base it skipped", async () => {
    const { deps } = setup({ status: () => available({ base: "origin/feature/work", skippedBase: { name: "origin/main", aheadCount: 40 }, aheadCount: 1 }) });
    const [result] = await loadWorktrees(deps, [workspacePlan(1)], environments(environment({ id: "env_1" })), names);
    expect(result).toMatchObject({ base: "origin/feature/work", skippedBase: { name: "origin/main", aheadCount: 40 }, aheadCount: 1 });
    expect(result?.ref).toEqual(workspaceRef(1, "origin/feature/work"));
  });

  it("keeps no base for later reads when none resolved, so they show uncommitted files instead of failing", async () => {
    const { deps } = setup({ status: () => available({ base: null, aheadCount: null, behindCount: null }) });
    const [result] = await loadWorktrees(deps, [workspacePlan(1, { ref: workspaceRef(1, "main") })], environments(environment({ id: "env_1" })), names);
    expect(result?.ref).toEqual(workspaceRef(1, null));
    expect(result?.head).toBe(HEAD);
  });

  it("reads a worktree the user asked to see whole against its recorded base, with nothing picked", async () => {
    const { deps, statusCalls } = setup();
    const whole = { ...deps, whole: new Set(["host_1:/work/1"]) };
    const result = await loadWorktrees(whole, [workspacePlan(1), workspacePlan(2)], environments(environment({ id: "env_1" }), environment({ id: "env_2" })), names);
    expect(statusCalls().map(([, input]) => [input.root, (input as { pick?: boolean }).pick])).toEqual([["/work/1", false], ["/work/2", true]]);
    expect(result.map((entry) => entry.whole)).toEqual([true, undefined]);
  });

  it("says when a worktree works on its base branch, before any commits its threads made are known", async () => {
    const onMain = setup({ status: () => available({ branch: "main", base: "main" }) });
    const [main] = await loadWorktrees(onMain.deps, [workspacePlan(1, { ref: workspaceRef(1, "main") })], environments(environment({ id: "env_1" })), names);
    expect(main).toMatchObject({ branch: "main", base: "main", onBase: true, threadCommits: [] });
    const [feature] = await loadWorktrees(setup().deps, [workspacePlan(1)], environments(environment({ id: "env_1" })), names);
    expect(feature).toMatchObject({ branch: "feature/work", base: "origin/main", onBase: false, threadCommits: [] });
  });

  it("asks without a base when the plan has none", async () => {
    const { deps, statusCalls } = setup();
    await loadWorktrees(deps, [workspacePlan(1, { ref: workspaceRef(1, null) })], environments(environment({ id: "env_1" })), names);
    expect(statusCalls()[0]?.[1]).toMatchObject({ base: null });
  });

  it("keeps the first 100 commits and 500 files of each list", async () => {
    const many = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => gitFile(`${prefix}/${index}.ts`));
    const { deps } = setup({
      status: () => available({
        uncommitted: many(600, "w"), committed: many(520, "c"), aheadCount: 150,
        commits: Array.from({ length: 100 }, (_, index) => hostCommit(index + 1)),
      }),
    });
    const [result] = await loadWorktrees(deps, [workspacePlan(1)], environments(environment({ id: "env_1" })), names);
    expect(result?.uncommitted).toHaveLength(500);
    expect(result?.committed).toHaveLength(500);
    expect(result?.commits).toHaveLength(100);
    expect(result?.aheadCount).toBe(150);
  });

  it("gives empty committed files and null counts when there is no base", async () => {
    const { deps } = setup({ status: () => available({ base: null, aheadCount: null, behindCount: null, uncommitted: [gitFile("a.ts")] }) });
    const [result] = await loadWorktrees(deps, [workspacePlan(1, { ref: workspaceRef(1, null) })], environments(environment({ id: "env_1" })), names);
    expect(result).toMatchObject({ state: "ready", base: null, aheadCount: null, behindCount: null, committed: [], commits: [] });
    expect(result?.uncommitted).toHaveLength(1);
  });

  it("has no branch for a detached checkout", async () => {
    const { deps } = setup({ status: () => available({ branch: null }) });
    const [result] = await loadWorktrees(deps, [workspacePlan(1)], environments(environment({ id: "env_1" })), names);
    expect(result).toMatchObject({ state: "ready", branch: null });
  });

  it("makes one worktree unavailable when git cannot read it, without touching the others", async () => {
    const responses: Record<string, unknown> = {
      "/work/1": { outcome: "unavailable", reason: "not-a-repo", message: "not a git repository" },
      "/work/2": new Error("socket hang up"),
      "/work/3": { outcome: "unavailable", reason: "git-failed", message: "Folder is gone" },
      "/work/4": available({ uncommitted: [gitFile("ok.ts")] }),
    };
    const { deps } = setup({ status: (root) => responses[root] });
    const list = [1, 2, 3, 4].map((n) => environment({ id: `env_${n}`, branchName: `branch-${n}` }));
    const result = await loadWorktrees(deps, [1, 2, 3, 4].map((n) => workspacePlan(n)), environments(...list), names);
    expect(result.map((entry) => [entry.state, entry.message])).toEqual([
      ["unavailable", "This folder is no longer a git repository"], ["unavailable", "socket hang up"], ["unavailable", "Folder is gone"], ["ready", null],
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
    const { deps, statusCalls } = setup();
    const result = await loadWorktrees(deps, [workspacePlan(1, { threadIds: ["thr_a", "thr_b"] })], environments(environment({ id: "env_1" })), names);
    expect(result).toHaveLength(1);
    expect(result[0]?.threadIds).toEqual(["thr_a", "thr_b"]);
    expect(statusCalls()).toHaveLength(1);
  });
});

describe("loadWorktrees branches", () => {
  const destroyed = destroyedEnvironment({ id: "env_9", hostId: "host_1", branchName: "feature/old", projectId: "proj_7" });

  it("reads an archived branch from the host range, with ahead, behind, commits and no uncommitted files", async () => {
    const { deps, host } = setup({
      host: {
        outcome: "available", branch: "feature/old", base: "origin/main", aheadCount: 2, behindCount: 5, truncated: false,
        commits: [hostCommit(2), hostCommit(1)],
        files: [{ path: "a.ts", previousPath: null, status: "added", additions: 3, deletions: 0, binary: false }],
      },
    });
    const [result] = await loadWorktrees(deps, [branchPlan()], environments(destroyed), names);
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
    const base = setup({ status: () => available({ uncommitted: [gitFile("src/a.ts"), gitFile("new.txt", "untracked", 4, 0)] }) });
    let now = 0;
    const cache = createRepoCache({ now: () => now });
    const deps: CollectDeps = { ...base.deps, cache };
    return { ...base, deps, cache, advance: (ms: number) => { now += ms; } };
  }
  const env = environments(environment({ id: "env_1" }));

  it("serves a worktree row and an uncommitted repository from one status call", async () => {
    const { deps, host } = shared();
    const [rows, repo] = await Promise.all([loadWorktrees(deps, [workspacePlan(1)], env, names), loadRepoFiles(deps, workspacePlan(1), "uncommitted", undefined, true)]);
    expect(host.mock.calls.map(([method]) => method)).toEqual(["checkoutStatus"]);
    expect(rows[0]?.uncommitted.map((file) => file.path)).toEqual(["src/a.ts", "new.txt"]);
    if (!("files" in repo)) throw new Error("expected files");
    expect(repo.files.map((file) => [file.path, file.status])).toEqual([["src/a.ts", "modified"], ["new.txt", "untracked"]]);
    expect(repo).toMatchObject({ base: null, aheadCount: null, truncated: false });
  });

  it("still asks for the merge-base diff in the branch scope, and shares the status with the row", async () => {
    const { deps, host, statusCalls } = shared();
    await Promise.all([loadWorktrees(deps, [workspacePlan(1)], env, names), loadRepoFiles(deps, workspacePlan(1), "branch")]);
    expect(host.mock.calls.filter(([method]) => method === "repoFiles").map((call) => call.slice(1))).toEqual([[
      { root: "/work/1", target: { type: "merge-base", base: "origin/main" }, folderLimit: 200 }, { hostId: "host_1", signal: undefined },
    ]]);
    expect(statusCalls()).toHaveLength(1);
  });

  it("reads the status again for a different base", async () => {
    const { deps, statusCalls } = shared();
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    await loadWorktrees(deps, [workspacePlan(1, { ref: workspaceRef(1, "main") })], env, names);
    expect(statusCalls()).toHaveLength(2);
  });

  it("reads the status again with nothing picked, or with another folder limit", async () => {
    const { deps, statusCalls } = shared();
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    await loadWorktrees({ ...deps, whole: new Set(["host_1:/work/1"]) }, [workspacePlan(1)], env, names);
    await loadWorktrees({ ...deps, counting: { pick: true, folderLimit: 50, historyThreshold: 50, historyShare: 10 } }, [workspacePlan(1)], env, names);
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    expect(statusCalls().map(([, input]) => input)).toEqual([
      { root: "/work/1", base: "origin/main", pick: true, folderLimit: 200 },
      { root: "/work/1", base: "origin/main", pick: false, folderLimit: 200 },
      { root: "/work/1", base: "origin/main", pick: true, folderLimit: 50 },
    ]);
  });

  it("reads the status again after the thread that works there changed, or its environment did", async () => {
    const { deps, statusCalls, cache } = shared();
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    expect(statusCalls()).toHaveLength(1);
    cache.invalidateThreads(["thr_1"]);
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    expect(statusCalls()).toHaveLength(2);
    cache.invalidateEnvironment("env_1");
    await loadWorktrees(deps, [workspacePlan(1)], env, names);
    expect(statusCalls()).toHaveLength(3);
  });

  it("makes an uncommitted repository unavailable when the status is", async () => {
    const failed = setup({ status: () => ({ outcome: "unavailable", reason: "git-failed", message: "Folder is gone" }) });
    expect(await loadRepoFiles(failed.deps, workspacePlan(1), "uncommitted")).toEqual({ unavailable: "Folder is gone" });
  });

  it("does not hand a caller's abort signal to a load that other callers share, but does when nothing is shared", async () => {
    const { deps, host, cache } = shared();
    // Aborts the caller while the host call is in flight and notes whether the host call saw it.
    const original = host.getMockImplementation()!;
    const seen: boolean[] = [];
    const abortDuring = (caller: AbortController) => host.mockImplementationOnce(async (method, input, options) => {
      caller.abort();
      seen.push(options?.signal?.aborted === true);
      return original(method, input, options);
    });
    const sharedCaller = new AbortController();
    abortDuring(sharedCaller);
    await loadWorktrees(deps, [workspacePlan(1)], env, names, sharedCaller.signal);
    cache.clear();
    const soleCaller = new AbortController();
    abortDuring(soleCaller);
    await loadWorktrees({ ...deps, cache: undefined }, [workspacePlan(1)], env, names, soleCaller.signal);
    expect(seen).toEqual([false, true]);
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

  it("leaves out folded untracked folders", () => {
    const folder = { files: 900, repository: false, sample: [] };
    expect(findSharedFiles([
      worktree({ key: "a", uncommitted: [fileChange({ path: "node_modules/", status: "untracked", folder })] }),
      worktree({ key: "b", uncommitted: [fileChange({ path: "node_modules/", status: "untracked", folder })] }),
    ])).toEqual([]);
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
