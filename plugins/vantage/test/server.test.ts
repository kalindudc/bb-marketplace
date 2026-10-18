import { describe, expect, it } from "vitest";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createCli, formatOverview, formatWorktree, formatWorktrees } from "../src/cli";
import { overviewSchema, type Overview } from "../src/contract";
import server from "../server";
import {
  branchRepo, branchWorktree, checkoutRepo, commit, environment, fileChange, overview, recordedRepo, repo, sharedFile, threadSummary, worktree,
} from "./fixtures";

type HostCall = { method: string; input: unknown; hostId: string };

const row = (seq: number, item: object) => ({ id: `e${seq}`, scope: { kind: "thread" }, threadId: "thr_1", seq, createdAt: seq * 1000, type: "item/completed", data: { item } });
const fileChangeRow = (seq: number, changes: object[], status = "completed") =>
  row(seq, { type: "fileChange", id: `i${seq}`, status, approvalStatus: null, changes });

const diffFile = (path: string) => ({
  path, previousPath: null, changeKind: "modified", additions: 1, deletions: 0, binary: false, origin: "tracked", loadMode: "auto",
});

const statusOf = (uncommitted: string[], committed: string[] = [], branchName = "feature/work") => ({
  outcome: "available",
  workspace: {
    branch: { currentBranch: branchName, defaultBranch: "main" },
    checkout: { kind: "branch", branchName, headSha: "abc" },
    mergeBase: {
      aheadCount: committed.length, behindCount: 0, baseRef: "origin/main", mergeBaseBranch: "origin/main", deletions: 0, fileCount: committed.length,
      commits: committed.map((_, index) => ({ sha: `${index + 1}`.padStart(40, "0"), shortSha: `${index + 1}`.padStart(7, "0"), subject: "Work", authorName: "Ada", authoredAt: 1_700_000_000_000 })),
      files: committed.map((path) => ({ path, status: "M", insertions: 1, deletions: 0 })), hasCommittedUnmergedChanges: committed.length > 0,
      insertions: 0, lineStatsComplete: true,
    },
    workingTree: {
      files: uncommitted.map((path) => ({ path, status: "M", insertions: 1, deletions: 0 })), fileCount: uncommitted.length, insertions: 0, deletions: 0,
      hasUncommittedChanges: uncommitted.length > 0, lineStatsComplete: true, state: "clean",
    },
  },
});

interface TreeThread { id: string; title: string; parentThreadId: string | null; environmentId: string | null; status?: string }
const PARENT: TreeThread = { id: "thr_1", title: "Parent", parentThreadId: null, environmentId: "env_1" };
const CHILD: TreeThread = { id: "thr_2", title: "Child A", parentThreadId: "thr_1", environmentId: "env_2", status: "active" };

function start(options: {
  files?: string[]; events?: object[]; hostResult?: (call: HostCall) => unknown; tree?: TreeThread[]; status?: (environmentId: string) => unknown;
} = {}) {
  const tree = options.tree ?? [PARENT];
  const envs: Record<string, ReturnType<typeof environment>> = {
    env_1: environment({ id: "env_1", path: "/work/one" }),
    env_2: environment({ id: "env_2", path: "/work/two", branchName: "child-work" }),
  };
  const ancestorsOf = (id: string): string[] => {
    const parent = tree.find((thread) => thread.id === id)?.parentThreadId ?? null;
    return parent === null ? [] : [parent, ...ancestorsOf(parent)];
  };
  const env = envs.env_1!;
  const result = createFakePluginHost({
    pluginId: "vantage",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const found = tree.find((thread) => thread.id === threadId);
          if (found === undefined) throw new Error(`no thread ${threadId}`);
          return makeThreadResponse({ ...found, status: (found.status ?? "idle") as "idle" });
        },
        experimental_listDescendants: async () => ({ threads: [{ threadId: "thr_1", descendantIds: tree.slice(1).map((thread) => thread.id) }] }),
        experimental_listAncestors: async ({ threadIds }: { threadIds: readonly string[] }) => ({
          threads: threadIds.map((threadId) => ({ threadId, ancestorIds: ancestorsOf(threadId) })),
        }),
        events: { list: async () => options.events ?? [] },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => envs[environmentId] ?? env,
        status: async ({ environmentId }: { environmentId: string }) => options.status?.(environmentId) ?? statusOf(["src/a.ts"]),
        diffFiles: async () => ({
          outcome: "available", files: (options.files ?? ["src/a.ts"]).map(diffFile), initialPatches: [], mergeBaseRef: null, shortstat: "", truncated: false,
        }),
        diffPatch: async () => ({ outcome: "available", patches: [{ path: "src/a.ts", patch: "+hello", truncated: false }] }),
      },
      projects: { list: async () => [{ id: "proj_1", name: "Project", sources: [] }] },
      hosts: { list: async () => [{ id: "host_1", name: "Laptop", status: "connected" }] },
    },
    experimental_callHostRpc: (call) => {
      const custom = options.hostResult?.(call as HostCall);
      if (custom !== undefined) return custom;
      const { method, input } = call as HostCall;
      if (method === "resolveRoots") {
        const paths = (input as { paths: string[] }).paths;
        const rootOf = (path: string) => ["/work/one", "/work/two"].find((root) => path === root || path.startsWith(`${root}/`)) ?? null;
        return { results: paths.map((path) => { const root = rootOf(path); return root === null ? { path, root: null, relative: null } : { path, root, relative: path.slice(root.length + 1) }; }) };
      }
      throw new Error(`unexpected host call ${method}`);
    },
  });
  return { ...result, ready: Promise.resolve(server(result.bb)) };
}

describe("server", () => {
  it("registers the rpc methods and the vantage command, and logs that it loaded", async () => {
    const { harness, ready } = start();
    await ready;
    expect(harness.registrations.rpcMethods).toEqual(["overview", "patch", "commitFiles", "recordedEdits"]);
    expect(harness.registrations.cli?.name).toBe("vantage");
    expect(harness.logEntries).toContainEqual({ level: "info", message: "loaded" });
  });

  it("answers overview with a value the schema accepts", async () => {
    const { harness, ready } = start({
      events: [fileChangeRow(1, [{ path: "/work/one/src/a.ts", kind: "update", diff: "+x" }])],
    });
    await ready;
    const result = await harness.behavior.callRpc("overview", { threadId: "thr_1", scope: "uncommitted" });
    const parsed = overviewSchema.parse(result);
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.repos[0]).toMatchObject({ label: "Project", state: "ready", threadIds: ["thr_1"] });
    expect(parsed.repos[0]?.files[0]).toMatchObject({ path: "src/a.ts", status: "modified", edits: { count: 1 } });
    const resolve = harness.experimental_hostRpcCalls.find((call) => call.method === "resolveRoots");
    expect(resolve).toMatchObject({ hostId: "host_1" });
  });

  it("rejects an overview request with an unknown field", async () => {
    const { harness, ready } = start();
    await ready;
    await expect(harness.behavior.callRpc("overview", { threadId: "thr_1", scope: "uncommitted", extra: 1 })).rejects.toThrow();
  });

  it("answers patch for a workspace with the branch scope through bb's diffPatch", async () => {
    const { harness, ready } = start();
    await ready;
    const result = await harness.behavior.callRpc("patch", {
      ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" },
      path: "src/a.ts", previousPath: null, untracked: false, scope: "branch", sha: null,
    });
    expect(result).toEqual({ patch: "+hello", truncated: false, binary: false });
    expect(harness.inspection.sdk.callsTo("environments.diffPatch")).toEqual([[
      { environmentId: "env_1", paths: ["src/a.ts"], target: { type: "all", mergeBaseBranch: "origin/main" }, signal: undefined },
    ]]);
  });

  it("answers patch for a checkout through the host", async () => {
    const { harness, ready } = start({
      hostResult: (call) => call.method === "repoPatch" ? { outcome: "available", patch: "+from host", truncated: false, binary: false } : undefined,
    });
    await ready;
    const result = await harness.behavior.callRpc("patch", {
      ref: { kind: "checkout", hostId: "host_2", root: "/code/cortex", base: null },
      path: "a.md", previousPath: null, untracked: true, scope: "uncommitted",
    });
    expect(result).toEqual({ patch: "+from host", truncated: false, binary: false });
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "repoPatch", hostId: "host_2",
      input: { root: "/code/cortex", path: "a.md", untracked: true, target: { type: "uncommitted" } },
    });
  });

  it("rejects a patch request for a recorded repository", async () => {
    const { harness, ready } = start();
    await ready;
    await expect(harness.behavior.callRpc("patch", {
      ref: { kind: "recorded" }, path: "a.ts", previousPath: null, untracked: false, scope: "uncommitted",
    })).rejects.toThrow("Use recordedEdits");
  });

  it("answers recordedEdits with the matching diffs", async () => {
    const { harness, ready } = start({
      events: [
        fileChangeRow(1, [{ path: "src/a.ts", kind: "update", diff: "+one" }]),
        fileChangeRow(2, [{ path: "src/other.ts", kind: "update", diff: "+two" }]),
        fileChangeRow(3, [{ path: "src/a.ts", kind: "update", diff: "+three" }], "failed"),
        fileChangeRow(4, [{ path: "src/a.ts", kind: "add", diff: "+four" }]),
      ],
    });
    await ready;
    const result = await harness.behavior.callRpc("recordedEdits", { threadIds: ["thr_1"], rawPaths: ["src/a.ts"] });
    expect(result).toEqual({
      edits: [
        { threadId: "thr_1", at: 1000, kind: "update", diff: "+one", truncated: false },
        { threadId: "thr_1", at: 4000, kind: "add", diff: "+four", truncated: false },
      ],
    });
  });
});

describe("server worktrees", () => {
  const TWO = { tree: [PARENT, CHILD], status: (id: string) => (id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work")) };
  const SHA = "abc1234def";
  const WORKSPACE = { kind: "workspace", environmentId: "env_1", base: "origin/main" };
  const BRANCH = { kind: "branch", hostId: "host_1", root: "/code/proj", base: "origin/main", head: "feature/old" };
  const CHECKOUT = { kind: "checkout", hostId: "host_1", root: "/code/cortex", base: null };
  const patch = (ref: object, extra: object) => ({ ref, path: "src/a.ts", previousPath: null, untracked: false, scope: "uncommitted", ...extra });

  it("answers overview with the worktrees and the files they share", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const parsed = overviewSchema.parse(await harness.behavior.callRpc("overview", { threadId: "thr_1", scope: "uncommitted" }));
    expect(parsed.worktrees.map((entry) => [entry.threadIds, entry.branch, entry.aheadCount])).toEqual([[["thr_1"], "feature/work", 0], [["thr_2"], "child-work", 1]]);
    expect(parsed.sharedFiles).toEqual([{ projectId: "proj_1", path: "README.md", worktreeKeys: ["host_1:/work/one", "host_1:/work/two"] }]);
    expect(parsed.threads.map((thread) => thread.status)).toEqual(["idle", "active"]);
  });

  it("answers commitFiles for a workspace through bb and for a branch through the host", async () => {
    const { harness, ready } = start({
      hostResult: (call) => call.method === "repoFiles"
        ? { outcome: "available", branch: null, base: null, aheadCount: null, behindCount: null, commits: [], truncated: false,
          files: [{ path: "lib.ts", previousPath: null, status: "added", additions: 1, deletions: 0, binary: false }] }
        : undefined,
    });
    await ready;
    const viaBb = await harness.behavior.callRpc("commitFiles", { ref: WORKSPACE, sha: SHA });
    expect(viaBb).toMatchObject({ files: [{ path: "src/a.ts", status: "modified" }] });
    expect(harness.inspection.sdk.callsTo("environments.diffFiles")[0]?.[0]).toEqual({ environmentId: "env_1", target: "commit", sha: SHA, signal: undefined });
    const viaHost = await harness.behavior.callRpc("commitFiles", { ref: BRANCH, sha: SHA });
    expect(viaHost).toMatchObject({ files: [{ path: "lib.ts", status: "added" }] });
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({ method: "repoFiles", hostId: "host_1", input: { root: "/code/proj", target: { type: "commit", sha: SHA } } });
    await expect(harness.behavior.callRpc("commitFiles", { ref: CHECKOUT, sha: SHA })).rejects.toThrow("not available");
    await expect(harness.behavior.callRpc("commitFiles", { ref: WORKSPACE, sha: "zz" })).rejects.toThrow();
  });

  it("answers patch for a commit and for committed changes, for workspace and branch refs", async () => {
    const { harness, ready } = start({
      hostResult: (call) => call.method === "repoPatch" ? { outcome: "available", patch: "+host", truncated: false, binary: false } : undefined,
    });
    await ready;
    await harness.behavior.callRpc("patch", patch(WORKSPACE, { scope: "committed" }));
    await harness.behavior.callRpc("patch", patch(WORKSPACE, { scope: "committed", sha: SHA }));
    expect(harness.inspection.sdk.callsTo("environments.diffPatch").map((call) => (call[0] as { target: unknown }).target)).toEqual([
      { type: "branch_committed", mergeBaseBranch: "origin/main" }, { type: "commit", sha: SHA },
    ]);
    await harness.behavior.callRpc("patch", patch(BRANCH, { scope: "committed" }));
    await harness.behavior.callRpc("patch", patch(BRANCH, { scope: "committed", sha: SHA }));
    expect(harness.experimental_hostRpcCalls.filter((call) => call.method === "repoPatch").map((call) => (call.input as { target: unknown }).target)).toEqual([
      { type: "range", base: "origin/main", head: "feature/old" }, { type: "commit", sha: SHA },
    ]);
  });

  it("rejects a committed or per-commit patch for a checkout", async () => {
    const { harness, ready } = start();
    await ready;
    await expect(harness.behavior.callRpc("patch", patch(CHECKOUT, { scope: "committed" }))).rejects.toThrow("not available");
    await expect(harness.behavior.callRpc("patch", patch(CHECKOUT, { sha: SHA }))).rejects.toThrow("not available");
  });
});

describe("bb vantage worktrees", () => {
  const TWO = { tree: [PARENT, CHILD], status: (id: string) => (id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work")) };

  it("prints one row per worktree with its columns, then the shared files", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const result = await harness.behavior.runCli(["worktrees"], { threadId: "thr_1" });
    expect(result.exitCode).toBe(0);
    const lines = (result.stdout ?? "").split("\n");
    expect(lines[0]).toMatch(/^STATUS\s+THREAD\s+AHEAD\/BEHIND\s+UNCOMMITTED\s+BRANCH$/);
    expect(lines[1]).toMatch(/^idle\s+Parent\s+↑0 ↓0\s+1 file\s+feature\/work$/);
    expect(lines[2]).toMatch(/^running\s+Child A\s+↑1 ↓0\s+1 file\s+child-work$/);
    expect(result.stdout).toContain("Shared files");
    expect(result.stdout).toMatch(/README\.md.*Parent.*Child A/);
  });

  it("prints the overview's worktrees and shared files as JSON, for another thread when asked", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const result = await harness.behavior.runCli(["worktrees", "--thread", "thr_1", "--json"], {});
    const printed = JSON.parse(result.stdout ?? "") as { threadId: string; worktrees: Array<{ key: string; threadIds: string[]; branch: string; state: string }>; sharedFiles: unknown[]; threads: unknown[] };
    expect(printed.threadId).toBe("thr_1");
    expect(printed.worktrees.map((entry) => [entry.key, entry.threadIds, entry.branch, entry.state])).toEqual([
      ["host_1:/work/one", ["thr_1"], "feature/work", "ready"], ["host_1:/work/two", ["thr_2"], "child-work", "ready"],
    ]);
    expect(printed.sharedFiles).toHaveLength(1);
    expect(printed.threads).toHaveLength(2);
  });

  it("fails with thread_required when no thread is known", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const json = await harness.behavior.runCli(["worktrees", "--json"], {});
    expect(JSON.parse(json.stdout ?? "")).toMatchObject({ ok: false, error: { code: "thread_required" } });
  });

  it("says so when the tree has no worktree", async () => {
    const { harness, ready } = start({ tree: [{ ...PARENT, environmentId: null }] });
    await ready;
    const result = await harness.behavior.runCli(["worktrees"], { threadId: "thr_1" });
    expect(result.stdout).toContain("No worktrees in this thread or its child threads yet.");
  });
});

describe("bb vantage worktree", () => {
  const TREE = [PARENT, CHILD, { id: "thr_3", title: "Grandchild", parentThreadId: "thr_2", environmentId: null }];
  const TWO = { tree: TREE, status: (id: string) => (id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work")) };

  it("finds the thread's tree root, then prints the worktree that thread is in", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const result = await harness.behavior.runCli(["worktree", "thr_2"], {});
    expect(result.exitCode).toBe(0);
    expect(harness.inspection.sdk.callsTo("threads.experimental_listAncestors")[0]?.[0]).toMatchObject({ threadIds: ["thr_2"] });
    expect(harness.inspection.sdk.callsTo("threads.experimental_listDescendants")[0]?.[0]).toMatchObject({ threadIds: ["thr_1"] });
    expect(result.stdout).toContain("Child A");
    expect(result.stdout).toContain("child-work");
    expect(result.stdout).toContain("Uncommitted");
    expect(result.stdout).toContain("b.ts");
    expect(result.stdout).toContain("Committed");
    expect(result.stdout).toContain("README.md");
  });

  it("prints the worktree object as JSON", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const result = await harness.behavior.runCli(["worktree", "thr_2", "--json"], {});
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({
      key: "host_1:/work/two", threadIds: ["thr_2"], state: "ready", branch: "child-work", aheadCount: 1, behindCount: 0,
      uncommitted: [{ path: "b.ts" }], committed: [{ path: "README.md" }],
    });
  });

  it("fails when the thread has no worktree", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const result = await harness.behavior.runCli(["worktree", "thr_3", "--json"], {});
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({ ok: false, error: { code: "worktree_not_found" } });
  });

  it("needs a thread", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const result = await harness.behavior.runCli(["worktree"], {});
    expect(result.exitCode).not.toBe(0);
  });
});

describe("formatWorktrees", () => {
  const titles = [
    threadSummary({ id: "thr_1", title: "Parent" }),
    threadSummary({ id: "thr_2", title: "A child with a very long title that must be cut off", status: "error" }),
    threadSummary({ id: "thr_3", title: "Archived child", archived: true }),
    threadSummary({ id: "thr_4", title: "Broken child", status: "idle" }),
  ];
  const rows = () => formatWorktrees(overview({
    threads: titles,
    worktrees: [
      worktree({ threadIds: ["thr_1"], aheadCount: 0, behindCount: 0 }),
      worktree({ key: "w2", threadIds: ["thr_2"], branch: "agent/two", aheadCount: 3, behindCount: 1, uncommitted: [fileChange(), fileChange({ path: "b.ts" })] }),
      branchWorktree({ threadIds: ["thr_3"], aheadCount: 1 }),
      worktree({ key: "w4", threadIds: ["thr_4"], state: "unavailable", message: "Folder is gone", branch: null, aheadCount: null, behindCount: null }),
    ],
    sharedFiles: [sharedFile({ worktreeKeys: ["host_1:/work/one", "w2"] })],
  })).split("\n");

  it("shows the status of the thread each worktree belongs to, with archived and unavailable ones named as such", () => {
    const lines = rows();
    expect(lines[1]).toMatch(/^idle\s+Parent\s+↑0 ↓0\s+clean\s+feature\/work$/);
    expect(lines[2]).toMatch(/^failed\s+/);
    expect(lines[3]).toMatch(/^archived\s+Archived child\s+↑1 ↓0\s+-\s+feature\/old$/);
    expect(lines[4]).toMatch(/^unavailable\s+Broken child\s+-\s+-\s+-$/);
  });

  it("cuts a long title to 30 characters and counts uncommitted files", () => {
    const line = rows()[2]!;
    expect(line).toContain("A child with a very long titl…");
    expect(line).not.toContain("must be cut off");
    expect(line).toMatch(/↑3 ↓1\s+2 files\s+agent\/two$/);
  });

  it("lists shared files with the threads of the worktrees that changed them", () => {
    const text = rows().join("\n");
    expect(text).toContain("Shared files (changed in more than one worktree)");
    expect(text).toContain("  README.md  (Parent, A child with a very long title that must be cut off)");
  });

  it("says so when there is no worktree", () => {
    expect(formatWorktrees(overview())).toContain("No worktrees in this thread or its child threads yet.");
  });
});

describe("formatWorktree", () => {
  const many = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => fileChange({ path: `${prefix}${String(index).padStart(3, "0")}.ts` }));
  const base = (wt: ReturnType<typeof worktree>) => overview({ threads: [threadSummary({ id: "thr_1", title: "Parent" })], worktrees: [wt] });

  it("describes the worktree, its files and its commits", () => {
    const text = formatWorktree(base(worktree({
      aheadCount: 1, behindCount: 2, uncommitted: [fileChange({ path: "u.ts", additions: 3, deletions: 1 })],
      committed: [fileChange({ path: "c.ts", status: "added", additions: 5, deletions: 0 })],
      commits: [commit({ shortSha: "abc1234", subject: "Fix the thing", authorName: "Ada" })],
    })), "thr_1");
    expect(text).toContain("Parent · feature/work · ↑1 ↓2 on origin/main");
    expect(text).toContain("path: /work/one");
    expect(text).toContain("Uncommitted (1 file)");
    expect(text).toContain("  M  u.ts  +3 −1");
    expect(text).toContain("Committed on this branch (1 file)");
    expect(text).toContain("  A  c.ts  +5 −0");
    expect(text).toContain("Commits (1)");
    expect(text).toContain("abc1234  Fix the thing");
    expect(text).toContain("Ada");
  });

  it("caps files at 50 and commits at 20", () => {
    const text = formatWorktree(base(worktree({
      uncommitted: many(60, "u"), committed: many(55, "c"), commits: Array.from({ length: 25 }, (_, index) => commit({ shortSha: `c${index}`.padEnd(7, "0"), subject: `Commit ${index}` })),
    })), "thr_1");
    expect(text).toContain("u049.ts");
    expect(text).not.toContain("u050.ts");
    expect(text).toContain("… 10 more");
    expect(text).toContain("… 5 more");
    expect(text).toContain("Commit 19");
    expect(text).not.toContain("Commit 20");
  });

  it("explains an unavailable worktree and labels a kept branch", () => {
    expect(formatWorktree(base(worktree({ state: "unavailable", message: "Folder is gone" })), "thr_1")).toContain("Unavailable: Folder is gone");
    const kept = formatWorktree(base(branchWorktree({ threadIds: ["thr_1"], committed: [fileChange({ path: "kept.ts" })] })), "thr_1");
    expect(kept).toContain("Committed on the kept branch");
    expect(kept).toContain("kept in: /code/proj");
    expect(kept).not.toContain("path:");
  });
});

describe("bb vantage changes", () => {
  it("prints the overview as JSON for the thread it runs in", async () => {
    const { harness, ready } = start();
    await ready;
    const result = await harness.behavior.runCli(["changes", "--json"], { threadId: "thr_1" });
    expect(result.exitCode).toBe(0);
    const printed = JSON.parse(result.stdout) as Overview;
    expect(overviewSchema.safeParse(printed).success).toBe(true);
    expect(printed).toMatchObject({ threadId: "thr_1", scope: "uncommitted" });
    expect(printed.repos[0]?.files.map((file) => file.path)).toEqual(["src/a.ts"]);
  });

  it("reads another thread and the branch scope when asked", async () => {
    const { harness, ready } = start();
    await ready;
    const result = await harness.behavior.runCli(["changes", "--thread", "thr_1", "--scope", "branch", "--json"], {});
    expect(JSON.parse(result.stdout)).toMatchObject({ threadId: "thr_1", scope: "branch" });
    expect(harness.inspection.sdk.callsTo("environments.diffFiles")[0]?.[0]).toMatchObject({ target: "all", mergeBaseBranch: "origin/main" });
  });

  it("caps a repository at 50 files in the text output", async () => {
    const files = Array.from({ length: 60 }, (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`);
    const { harness, ready } = start({ files });
    await ready;
    const result = await harness.behavior.runCli(["changes"], { threadId: "thr_1" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("src/file-49.ts");
    expect(result.stdout).not.toContain("src/file-50.ts");
    expect(result.stdout).toContain("… 10 more");
    expect(result.stdout).toContain("Project · Thread workspace");
  });

  it("fails with thread_required when no thread is known", async () => {
    const { harness, ready } = start();
    await ready;
    const plain = await harness.behavior.runCli(["changes"], {});
    expect(plain.exitCode).toBe(1);
    expect(plain.stderr).toContain("No thread to read");
    const json = await harness.behavior.runCli(["changes", "--json"], {});
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: "thread_required" } });
  });

  it("shows --help without reading anything", async () => {
    const { harness, ready } = start();
    await ready;
    const result = await harness.behavior.runCli(["changes", "--help"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--thread");
    expect(harness.inspection.sdk.calls).toEqual([]);
  });
});

describe("formatOverview", () => {
  it("describes every kind of repository, the threads that touched it and the folded changes", () => {
    const text = formatOverview(overview({
      scope: "branch",
      threads: [threadSummary({ id: "thr_1", title: "Parent" }), threadSummary({ id: "thr_2", title: "Old child", archived: true, depth: 1 })],
      repos: [
        repo({
          label: "Project", branch: "feature/work", threadIds: ["thr_1"],
          files: [
            fileChange({ path: "src/a.ts", additions: 2, deletions: 1 }),
            fileChange({ path: "docs/x.md", previousPath: "docs/y.md", status: "renamed", additions: 0, deletions: 0 }),
            fileChange({ path: "pic.png", status: "added", additions: null, deletions: null, binary: true }),
            fileChange({ path: "kept.ts", status: "clean", additions: null, deletions: null }),
          ],
        }),
        checkoutRepo({ threadIds: ["thr_1"], files: [fileChange({ path: "a.md", status: "untracked", additions: 3, deletions: 0 })], otherFiles: [fileChange(), fileChange({ path: "b.ts" })] }),
        branchRepo({ threadIds: ["thr_2"], files: [fileChange({ path: "lib.ts" })] }),
        recordedRepo({ threadIds: ["thr_2"], files: [fileChange({ path: "gone.ts", status: "deleted", additions: 0, deletions: 4 })] }),
        repo({ label: "Offline repo", state: "unavailable", message: "Dev box is not connected", hostId: "host_2", hostName: "Dev box", threadIds: ["thr_1"] }),
      ],
      otherFiles: [fileChange({ path: "/tmp/notes.txt", status: "added", additions: 2, deletions: 0 })],
      warnings: ["Could not reach Dev box: offline"],
    }));
    expect(text).toContain("5 repos");
    expect(text).toContain("(everything on the branch)");
    expect(text).toContain("Project · Thread workspace · branch feature/work · 3 files +2 −1 · Laptop");
    expect(text).toContain("threads: Parent");
    expect(text).toContain("  M  src/a.ts  +2 −1");
    expect(text).toContain("  R  docs/y.md → docs/x.md  +0 −0");
    expect(text).toContain("  A  pic.png  binary");
    expect(text).toContain("  ·  kept.ts  (edited, no change now)");
    expect(text).toContain("cortex · Edited by path · branch main · 1 file +3 −0 · Laptop");
    expect(text).toContain("  ?  a.md  +3 −0");
    expect(text).toContain("+ 2 other changes in this repo that these threads did not edit");
    expect(text).toContain("Project · Archived branch · 3 commits · branch feature/old");
    expect(text).toContain("threads: Old child (archived)");
    expect(text).toContain("Recorded edits only");
    expect(text).toContain("  D  gone.ts  +0 −4");
    expect(text).toContain("Offline repo · Thread workspace · branch feature/work · Dev box");
    expect(text).toContain("Unavailable: Dev box is not connected");
    expect(text).toContain("Other files (outside any repository, from recorded edits)");
    expect(text).toContain("  A  /tmp/notes.txt  +2 −0");
    expect(text).toContain("Warnings\n  - Could not reach Dev box: offline");
  });

  it("leaves the machine name out of the text when everything is on one machine", () => {
    const text = formatOverview(overview({ repos: [repo({ files: [fileChange()] })] }));
    expect(text).toContain("Project · Thread workspace · branch feature/work · 1 file +2 −1\n");
    expect(text).not.toContain("Laptop");
  });

  it("says so when nothing changed", () => {
    expect(formatOverview(overview())).toContain("No changes in this thread or its child threads yet.");
  });

  it("says when the tree was cut", () => {
    expect(formatOverview(overview({ truncatedThreads: true }))).toContain("Only the first 200 threads");
  });
});

describe("output limit", () => {
  const huge = (): Overview => overview({
    repos: [repo({
      files: Array.from({ length: 500 }, (_, index) => fileChange({ path: `${"d/".repeat(2000)}file-${index}.ts` })),
    })],
  });

  it("trims the files of a JSON overview that would not fit and says it was cut", async () => {
    const cli = createCli(async () => huge(), async (id) => id);
    const result = await cli.run(["changes", "--json"], { threadId: "thr_1" });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout ?? "")).toBeLessThan(PLUGIN_CLI_OUTPUT_MAX_BYTES);
    const printed = JSON.parse(result.stdout ?? "") as Overview;
    expect(printed.repos[0]?.truncated).toBe(true);
    expect(printed.repos[0]?.files.length).toBeLessThan(500);
    expect(printed.repos[0]?.totals.files).toBe(500);
  });

  it("trims the files and commits of a worktrees JSON that would not fit", async () => {
    const files = Array.from({ length: 500 }, (_, index) => fileChange({ path: `${"d/".repeat(2000)}file-${index}.ts` }));
    const big = overview({ worktrees: [worktree({ uncommitted: files, committed: files, commits: Array.from({ length: 100 }, () => commit()) })] });
    const cli = createCli(async () => big, async (id) => id);
    for (const argv of [["worktrees", "--json"], ["worktree", "thr_1", "--json"]]) {
      const result = await cli.run(argv, { threadId: "thr_1" });
      expect(result.exitCode).toBe(0);
      expect(Buffer.byteLength(result.stdout ?? "")).toBeLessThan(PLUGIN_CLI_OUTPUT_MAX_BYTES);
    }
    const printed = JSON.parse((await cli.run(["worktree", "thr_1", "--json"], {})).stdout ?? "") as { uncommitted: unknown[] };
    expect(printed.uncommitted.length).toBeLessThan(500);
  });

  it("keeps the full JSON overview when it fits", async () => {
    const small = overview({ repos: [repo({ files: [fileChange()] })] });
    const result = await createCli(async () => small, async (id) => id).run(["changes", "--json"], { threadId: "thr_1" });
    expect(JSON.parse(result.stdout ?? "")).toEqual(small);
  });

  it("keeps the text output under the limit", async () => {
    const many = overview({
      repos: Array.from({ length: 3000 }, (_, index) => repo({ key: `k${index}`, label: `repo-${index}`, files: [fileChange()] })),
    });
    const result = await createCli(async () => many, async (id) => id).run(["changes"], { threadId: "thr_1" });
    expect(Buffer.byteLength(result.stdout ?? "")).toBeLessThan(PLUGIN_CLI_OUTPUT_MAX_BYTES);
  });
});
