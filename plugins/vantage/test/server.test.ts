import { describe, expect, it } from "vitest";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createCli, formatOverview, formatWorktree, formatWorktrees } from "../src/cli";
import { overviewSchema, type Overview } from "../src/contract";
import server from "../server";
import {
  branchRepo, branchWorktree, checkoutRepo, checkoutWorktree, commit, environment, fileChange, overview, recordedRepo, repo, sharedFile, threadSummary, worktree,
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
const DONE: TreeThread = { id: "thr_3", title: "Finished child", parentThreadId: "thr_1", environmentId: null };

function start(options: {
  files?: string[]; events?: object[]; hostResult?: (call: HostCall) => unknown; tree?: TreeThread[]; status?: (environmentId: string) => unknown;
  onList?: () => void; archived?: TreeThread[];
} = {}) {
  const subscriptions: Array<{ event: string; callback: (event: unknown) => void }> = [];
  const unsubscribed: string[] = [];
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
      subscribe: ((args: { event: string; callback: (event: unknown) => void }) => {
        subscriptions.push(args);
        return () => { unsubscribed.push(args.event); };
      }) as never,
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const found = tree.find((thread) => thread.id === threadId);
          if (found === undefined) {
            const kept = options.archived?.find((thread) => thread.id === threadId);
            if (kept === undefined) throw new Error(`no thread ${threadId}`);
            return makeThreadResponse({ ...kept, status: "idle", archivedAt: Date.now() });
          }
          return makeThreadResponse({ ...found, status: (found.status ?? "idle") as "idle" });
        },
        list: async ({ archived, limit, offset }: { archived?: boolean; limit?: number; offset?: number } = {}) => {
          options.onList?.();
          // One timestamp per call: a clock tick between threads would reorder them, since collectAll sorts newest first.
          const now = Date.now();
          const listed = archived === true
            ? (options.archived ?? []).map((thread) => makeThreadResponse({ ...thread, status: "idle", updatedAt: now, archivedAt: now }))
            : tree.map((thread) => makeThreadResponse({ ...thread, status: (thread.status ?? "idle") as "idle", updatedAt: now }));
          return listed.slice(offset ?? 0, (offset ?? 0) + (limit ?? 100));
        },
        experimental_listDescendants: async () => ({
          threads: [{ threadId: "thr_1", descendantIds: [...tree.slice(1), ...(options.archived ?? [])].map((thread) => thread.id) }],
        }),
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
  const emit = (event: string, payload: object) => {
    for (const subscription of subscriptions) if (subscription.event === event) subscription.callback({ entity: event.split(":")[0], type: "changed", ...payload });
  };
  return { ...result, subscriptions, unsubscribed, emit, ready: Promise.resolve(server(result.bb)) };
}

describe("server", () => {
  it("registers the rpc methods and the vantage command, and logs that it loaded", async () => {
    const { harness, ready } = start();
    await ready;
    expect(harness.registrations.rpcMethods).toEqual([
      "shell", "overview", "patch", "fileSides", "commitFiles", "recordedEdits", "reviewed", "setReviewed",
    ]);
    expect(harness.registrations.cli?.name).toBe("vantage");
    expect(harness.logEntries).toContainEqual({ level: "info", message: "loaded" });
  });

  it("answers overview with a value the schema accepts", async () => {
    const { harness, ready } = start({
      events: [fileChangeRow(1, [{ path: "/work/one/src/a.ts", kind: "update", diff: "+x" }])],
    });
    await ready;
    const result = await harness.behavior.callRpc("overview", { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
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
    await expect(harness.behavior.callRpc("overview", { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true, extra: 1 })).rejects.toThrow();
  });

  it("rejects an overview request that does not say whether archived threads are wanted", async () => {
    const { harness, ready } = start();
    await ready;
    await expect(harness.behavior.callRpc("overview", { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("shell", { target: { kind: "tree", threadId: "thr_1" } })).rejects.toThrow();
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
      ref: { kind: "checkout", hostId: "host_2", root: "/code/commons", base: null },
      path: "a.md", previousPath: null, untracked: true, scope: "uncommitted",
    });
    expect(result).toEqual({ patch: "+from host", truncated: false, binary: false });
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "repoPatch", hostId: "host_2",
      input: { root: "/code/commons", path: "a.md", untracked: true, target: { type: "uncommitted" } },
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

describe("server: every thread", () => {
  const ALL = { target: { kind: "all" }, scope: "uncommitted", includeArchived: false };
  const TWO = { tree: [PARENT, CHILD], status: (id: string) => (id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work")) };
  const diffs = (harness: { inspection: { sdk: { callsTo(path: string): unknown[][] } } }) => harness.inspection.sdk.callsTo("environments.diffFiles").length;
  const statuses = (harness: { inspection: { sdk: { callsTo(path: string): unknown[][] } } }) => harness.inspection.sdk.callsTo("environments.status").length;
  const threadEvent = (id: string, eventTypes?: string[]) => ({
    id, changes: ["events-appended"], ...(eventTypes === undefined ? {} : { metadata: { eventTypes } }),
  });

  it("declares the window and thread limit as bounded integer settings with defaults 24 and 200", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    expect(harness.registrations.settingsDescriptors).toMatchObject({
      windowHours: { type: "number", default: 24, label: "Time window for the full-screen page (hours)" },
      maxThreads: { type: "number", default: 200, label: "Most threads on the full-screen page" },
    });
    const outOfRange: Array<Record<string, number>> = [{ windowHours: 0 }, { windowHours: 721 }, { windowHours: 1.5 }, { maxThreads: 9 }, { maxThreads: 501 }];
    for (const bad of outOfRange) {
      await expect(harness.behavior.setSettings(bad)).rejects.toThrow();
    }
    await harness.behavior.setSettings({ windowHours: 720, maxThreads: 10 });
  });

  it("answers an all overview over every listed thread, with the default window", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const parsed = overviewSchema.parse(await harness.behavior.callRpc("overview", ALL));
    expect(parsed).toMatchObject({ threadId: "", target: { kind: "all" }, windowHours: 24, truncatedThreads: false });
    expect(parsed.threads.map((thread) => [thread.id, thread.rootThreadId])).toEqual([["thr_1", "thr_1"], ["thr_2", "thr_1"]]);
    expect(parsed.worktrees).toHaveLength(2);
  });

  it("reads the window and limit from the settings on every build", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.setSettings({ windowHours: 6, maxThreads: 10 });
    expect(await harness.behavior.callRpc("overview", ALL)).toMatchObject({ windowHours: 6 });
  });

  it("answers a second all overview from the cache, without asking bb for any status", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", ALL);
    expect(statuses(harness)).toBe(2);
    expect(diffs(harness)).toBe(0);
    await harness.behavior.callRpc("overview", ALL);
    expect([diffs(harness), statuses(harness)]).toEqual([0, 2]);
  });

  it("uses the same cache for a thread's own tree, and a hard refresh on the tree reads it again", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const tree = { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true };
    await harness.behavior.callRpc("overview", tree);
    await harness.behavior.callRpc("overview", tree);
    expect(statuses(harness)).toBe(2);
    await harness.behavior.callRpc("overview", ALL);
    expect(statuses(harness)).toBe(2);
    await harness.behavior.callRpc("overview", { ...tree, refresh: true });
    expect(statuses(harness)).toBe(4);
  });

  it("reads a repository again after a change in one of its threads", async () => {
    const { harness, ready, emit } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", ALL);
    emit("thread:changed", threadEvent("thr_2", ["item/completed"]));
    await harness.behavior.callRpc("overview", ALL);
    expect(statuses(harness)).toBe(3);
  });

  it("ignores a thread event that carries only streaming deltas, and one for an unrelated thread", async () => {
    const { harness, ready, emit } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", ALL);
    emit("thread:changed", threadEvent("thr_2", ["item/agentMessage/delta", "item/commandExecution/outputDelta"]));
    emit("thread:changed", threadEvent("thr_unrelated", ["item/completed"]));
    await harness.behavior.callRpc("overview", ALL);
    expect(statuses(harness)).toBe(2);
  });

  it("treats a thread event with no event types as a change", async () => {
    const { harness, ready, emit } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", ALL);
    emit("thread:changed", threadEvent("thr_1"));
    await harness.behavior.callRpc("overview", ALL);
    expect(statuses(harness)).toBe(3);
  });

  it("reads an environment again when bb reports its work status, refs or status changed", async () => {
    for (const change of ["work-status-changed", "git-refs-changed", "status-changed"]) {
      const { harness, ready, emit } = start(TWO);
      await ready;
      await harness.behavior.callRpc("overview", ALL);
      emit("environment:changed", { id: "env_2", changes: [change] });
      await harness.behavior.callRpc("overview", ALL);
      expect(statuses(harness), change).toBe(3);
    }
  });

  it("ignores an environment change that touches no files", async () => {
    const { harness, ready, emit } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", ALL);
    emit("environment:changed", { id: "env_2", changes: ["renamed"] });
    await harness.behavior.callRpc("overview", ALL);
    expect(statuses(harness)).toBe(2);
  });

  it("clears the cache on a refresh", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", ALL);
    await harness.behavior.callRpc("overview", { ...ALL, refresh: true });
    expect(statuses(harness)).toBe(4);
  });

  it("shares one build between concurrent all overviews, and builds again once it is done", async () => {
    let lists = 0;
    const { harness, ready } = start({ ...TWO, onList: () => { lists++; } });
    await ready;
    const results = await Promise.all([harness.behavior.callRpc("overview", ALL), harness.behavior.callRpc("overview", ALL)]);
    expect(results[0]).toEqual(results[1]);
    expect(lists).toBe(2);
    await harness.behavior.callRpc("overview", ALL);
    expect(lists).toBe(4);
  });

  it("clears the cache and tells open pages when a setting changes", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", ALL);
    expect(harness.inspection.realtimeSignals).toEqual([]);
    await harness.behavior.setSettings({ windowHours: 12 });
    expect(harness.inspection.realtimeSignals).toEqual([{ channel: "vantage:settings", payload: {} }]);
    await harness.behavior.callRpc("overview", ALL);
    expect(statuses(harness)).toBe(4);
  });

  it("declares the badge as on and toasts as off, and no per-thread choices", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    expect(harness.registrations.settingsDescriptors).toMatchObject({
      badge: { type: "boolean", default: true, label: "Badge the Vantage icon when a thread needs you" },
      toasts: { type: "boolean", default: false, label: "Show a toast when a thread needs you" },
    });
    expect(harness.registrations.settingsDescriptors).not.toHaveProperty("watchByDefault");
    expect(harness.registrations.settingsDescriptors).not.toHaveProperty("reviewsByDefault");
  });

  it("changes nothing on the server when an alert setting changes", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.setSettings({ toasts: true, badge: false });
    expect(harness.inspection.experimental_rpcInvalidations).toEqual([]);
    expect(harness.inspection.realtimeSignals).toEqual([]);
  });

  it("keeps the reviewed marks of each worktree apart and drops a mark set to null", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.callRpc("setReviewed", { key: "host_1:/work/one", marks: [{ mark: "uncommitted\0src/a.ts", signature: "modified:1:0:" }] });
    await harness.behavior.callRpc("setReviewed", { key: "host_1:/work/two", marks: [{ mark: "committed\0b.ts", signature: "added:3:0:" }] });
    expect(await harness.behavior.callRpc("reviewed", { keys: ["host_1:/work/one", "host_1:/work/two", "host_1:/none"] })).toEqual({
      "host_1:/work/one": { "uncommitted\0src/a.ts": "modified:1:0:" },
      "host_1:/work/two": { "committed\0b.ts": "added:3:0:" },
      "host_1:/none": {},
    });
    await harness.behavior.callRpc("setReviewed", { key: "host_1:/work/one", marks: [{ mark: "uncommitted\0src/a.ts", signature: null }] });
    expect(await harness.behavior.callRpc("reviewed", { keys: ["host_1:/work/one"] })).toEqual({ "host_1:/work/one": {} });
  });

  it("stops listening when the plugin is disposed", async () => {
    const { harness, ready, subscriptions, unsubscribed } = start(TWO);
    await ready;
    expect(subscriptions.map((entry) => entry.event).sort()).toEqual(["environment:changed", "thread:changed"]);
    await harness.lifecycle.dispose();
    expect(unsubscribed.sort()).toEqual(["environment:changed", "thread:changed"]);
  });
});

describe("server: shell and archived threads", () => {
  const TWO = { tree: [PARENT, CHILD], status: (id: string) => (id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work")) };
  const WITH_ARCHIVED = { ...TWO, archived: [DONE] };
  const ALL = (includeArchived: boolean) => ({ target: { kind: "all" }, scope: "uncommitted", includeArchived });
  const TREE = (includeArchived: boolean) => ({ target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived });
  const ids = (overview: { threads: Array<{ id: string }> }) => overview.threads.map((thread) => thread.id);

  it("answers shell with a partial overview of loading rows, without asking bb or the host for any git state", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const parsed = overviewSchema.parse(await harness.behavior.callRpc("shell", { target: { kind: "all" }, includeArchived: false }));
    expect(parsed).toMatchObject({ partial: true, archivedHidden: 0, sharedFiles: [], target: { kind: "all" }, windowHours: 24 });
    expect(parsed.worktrees.map((entry) => [entry.threadIds, entry.state, entry.branch])).toEqual([
      [["thr_1"], "loading", "feature/work"], [["thr_2"], "loading", "child-work"],
    ]);
    for (const path of ["environments.status", "environments.diffFiles", "threads.events.list"]) {
      expect(harness.inspection.sdk.callsTo(path), path).toHaveLength(0);
    }
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("answers shell for a thread's tree", async () => {
    const { harness, ready } = start(WITH_ARCHIVED);
    await ready;
    const parsed = overviewSchema.parse(await harness.behavior.callRpc("shell", { target: { kind: "tree", threadId: "thr_1" }, includeArchived: false }));
    expect(parsed).toMatchObject({ partial: true, threadId: "thr_1", archivedHidden: 1 });
    expect(ids(parsed)).toEqual(["thr_1", "thr_2"]);
  });

  it("leaves archived threads out of an all overview unless asked, and counts them", async () => {
    const { harness, ready } = start(WITH_ARCHIVED);
    await ready;
    const hidden = overviewSchema.parse(await harness.behavior.callRpc("overview", ALL(false)));
    expect(ids(hidden).sort()).toEqual(["thr_1", "thr_2"]);
    expect(hidden).toMatchObject({ archivedHidden: 1, partial: false });
    const shown = overviewSchema.parse(await harness.behavior.callRpc("overview", ALL(true)));
    expect(ids(shown).sort()).toEqual(["thr_1", "thr_2", "thr_3"]);
    expect(shown.archivedHidden).toBe(0);
  });

  it("leaves archived threads out of a tree overview unless asked", async () => {
    const { harness, ready } = start(WITH_ARCHIVED);
    await ready;
    expect(ids(overviewSchema.parse(await harness.behavior.callRpc("overview", TREE(false))))).toEqual(["thr_1", "thr_2"]);
    expect(ids(overviewSchema.parse(await harness.behavior.callRpc("overview", TREE(true))))).toEqual(["thr_1", "thr_2", "thr_3"]);
  });

  it("does not share a build between overviews that differ in whether they include archived threads", async () => {
    let lists = 0;
    const { harness, ready } = start({ ...WITH_ARCHIVED, onList: () => { lists++; } });
    await ready;
    await Promise.all([harness.behavior.callRpc("overview", ALL(false)), harness.behavior.callRpc("overview", ALL(true))]);
    expect(lists).toBe(4);
  });
});

describe("bb vantage --archived", () => {
  const WITH_ARCHIVED = {
    tree: [PARENT, CHILD], archived: [DONE],
    status: (id: string) => (id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work")),
  };

  it("hides archived threads with --all and says how many", async () => {
    const { harness, ready } = start(WITH_ARCHIVED);
    await ready;
    const json = JSON.parse((await harness.behavior.runCli(["worktrees", "--all", "--json"], {})).stdout ?? "") as { threads: Array<{ id: string }>; archivedHidden: number };
    expect(json.threads.map((thread) => thread.id).sort()).toEqual(["thr_1", "thr_2"]);
    expect(json.archivedHidden).toBe(1);
    const text = await harness.behavior.runCli(["worktrees", "--all"], {});
    expect(text.stdout).toContain("1 archived thread hidden (use --archived)");
    const changes = await harness.behavior.runCli(["changes", "--all"], {});
    expect(changes.stdout).toContain("1 archived thread hidden (use --archived)");
  });

  it("includes them with --archived, and then says nothing is hidden", async () => {
    const { harness, ready } = start(WITH_ARCHIVED);
    await ready;
    for (const command of ["worktrees", "changes"]) {
      const result = await harness.behavior.runCli([command, "--all", "--archived", "--json"], {});
      const json = JSON.parse(result.stdout ?? "") as { threads: Array<{ id: string }>; archivedHidden: number };
      expect(json.threads.map((thread) => thread.id).sort(), command).toEqual(["thr_1", "thr_2", "thr_3"]);
      expect(json.archivedHidden, command).toBe(0);
    }
    expect((await harness.behavior.runCli(["worktrees", "--all", "--archived"], {})).stdout).not.toContain("hidden");
  });

  it("always includes archived threads for one thread's tree", async () => {
    const { harness, ready } = start(WITH_ARCHIVED);
    await ready;
    const json = JSON.parse((await harness.behavior.runCli(["worktrees", "--thread", "thr_1", "--json"], {})).stdout ?? "") as { threads: Array<{ id: string }> };
    expect(json.threads.map((thread) => thread.id)).toEqual(["thr_1", "thr_2", "thr_3"]);
    const one = await harness.behavior.runCli(["worktree", "thr_1", "--json"], {});
    expect(one.exitCode).toBe(0);
  });

  it("refuses --archived without --all", async () => {
    const { harness, ready } = start(WITH_ARCHIVED);
    await ready;
    for (const command of ["changes", "worktrees"]) {
      const result = await harness.behavior.runCli([command, "--archived", "--json"], { threadId: "thr_1" });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout ?? "")).toMatchObject({ ok: false, error: { code: "archived_requires_all" } });
    }
  });

  it("prints the hidden count in the text outputs only when some threads are hidden", () => {
    expect(formatWorktrees(overview({ archivedHidden: 3, worktrees: [worktree()] }))).toContain("3 archived threads hidden (use --archived)");
    expect(formatWorktrees(overview({ worktrees: [worktree()] }))).not.toContain("hidden");
    expect(formatWorktrees(overview({ archivedHidden: 2 }))).toContain("2 archived threads hidden (use --archived)");
    expect(formatOverview(overview({ archivedHidden: 1 }))).toContain("1 archived thread hidden (use --archived)");
    expect(formatOverview(overview())).not.toContain("hidden");
  });
});

describe("server worktrees", () => {
  const TWO = { tree: [PARENT, CHILD], status: (id: string) => (id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work")) };
  const SHA = "abc1234def";
  const WORKSPACE = { kind: "workspace", environmentId: "env_1", base: "origin/main" };
  const BRANCH = { kind: "branch", hostId: "host_1", root: "/code/proj", base: "origin/main", head: "feature/old" };
  const CHECKOUT = { kind: "checkout", hostId: "host_1", root: "/code/commons", base: null };
  const patch = (ref: object, extra: object) => ({ ref, path: "src/a.ts", previousPath: null, untracked: false, scope: "uncommitted", ...extra });

  it("answers overview with the worktrees and the files they share", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const parsed = overviewSchema.parse(await harness.behavior.callRpc("overview", { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true }));
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
    await harness.behavior.callRpc("commitFiles", { ref: CHECKOUT, sha: SHA });
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({ method: "repoFiles", input: { root: "/code/commons", target: { type: "commit", sha: SHA } } });
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

  it("answers a committed or per-commit patch for a checkout through the host", async () => {
    const { harness, ready } = start({
      hostResult: (call) => call.method === "repoPatch" ? { outcome: "available", patch: "+host", truncated: false, binary: false } : undefined,
    });
    await ready;
    await harness.behavior.callRpc("patch", patch(CHECKOUT, { scope: "committed" }));
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({ method: "repoPatch", input: { root: "/code/commons", target: { type: "committed", base: null } } });
    await harness.behavior.callRpc("patch", patch(CHECKOUT, { sha: SHA }));
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({ method: "repoPatch", input: { target: { type: "commit", sha: SHA } } });
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

  it("marks a worktree on its base branch, and counts the commits its threads made there", () => {
    const lines = formatWorktrees(overview({
      threads: [threadSummary({ id: "thr_1", title: "Parser" }), threadSummary({ id: "thr_2", title: "Docs" })],
      worktrees: [
        worktree({ branch: "main", base: "main", onBase: true, threadCommits: [commit(), commit({ sha: "b".repeat(40) })] }),
        worktree({ key: "w2", threadIds: ["thr_2"], branch: "main", base: "main", onBase: true }),
      ],
    })).split("\n");
    expect(lines[1]).toMatch(/^idle\s+Parser\s+on base\s+clean\s+main · 2 commits by its threads$/);
    expect(lines[2]).toMatch(/^idle\s+Docs\s+on base\s+clean\s+main$/);
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

  it("prints every worktree of a thread that also works in a checkout outside bb", () => {
    const text = formatWorktree(overview({
      threads: [threadSummary({ id: "thr_1", title: "Parent" })],
      worktrees: [worktree(), checkoutWorktree({ threadIds: ["thr_1"], committed: [fileChange({ path: "lib.rs" })] })],
    }), "thr_1");
    expect(text).toContain("path: /work/one");
    expect(text).toContain("Parent · side-work");
    expect(text).toContain("path: /clones/side");
    expect(text).toContain("Committed on this branch (1 file)");
  });

  it("lists the commits its threads made on the base branch it works on", () => {
    const text = formatWorktree(base(worktree({
      branch: "main", base: "main", onBase: true,
      threadCommits: [commit({ shortSha: "1a2b3c4", subject: "Add the parser", authorName: "Ada" }), commit({ shortSha: "5d6e7f8", subject: "Fix the tests" })],
    })), "thr_1");
    expect(text).toContain("Parent · main · on main, its base branch · idle");
    expect(text).not.toContain("↑0 ↓0");
    expect(text).toContain("Commits its threads made on main (2)");
    expect(text).toContain("  1a2b3c4  Add the parser  (Ada, 2023-11-14)");
    expect(text).toContain("  5d6e7f8  Fix the tests");
    expect(text).not.toContain("No changes.");
  });

  it("says why a worktree on its base branch shows no commits when its threads made none", () => {
    const text = formatWorktree(base(worktree({ branch: "main", base: "main", onBase: true })), "thr_1");
    expect(text).toContain("No changes.");
    expect(text).toContain("Works on main, its base branch, so nothing counts as ahead; no commits its threads made were found.");
  });

  it("lists the commits its threads made that are already on the base branch", () => {
    const text = formatWorktree(base(worktree({ threadCommits: [commit({ shortSha: "abc1234", subject: "Merged work" })] })), "thr_1");
    expect(text).toContain("Commits its threads made, already on origin/main (1)");
    expect(text).toContain("abc1234  Merged work");
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
    expect(printed).toMatchObject({ target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", partial: false, archivedHidden: 0 });
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
    const { harness, ready } = start({ status: () => statusOf(files) });
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
    expect(harness.inspection.sdk.calls.filter((call) => call.path !== "subscribe")).toEqual([]);
  });
});

describe("formatOverview commits", () => {
  it("lists up to five commits its threads made in a repository, newest first", () => {
    const made = Array.from({ length: 7 }, (_, index) => commit({ shortSha: `c${index}`.padEnd(7, "0"), subject: `Commit ${index}` }));
    const text = formatOverview(overview({
      threads: [threadSummary({ id: "thr_1", title: "Parser" })],
      repos: [repo({ branch: "main", threadIds: ["thr_1"], threadCommits: made, files: [fileChange({ path: "README.md", status: "clean", additions: null, deletions: null })] })],
    }));
    expect(text).toContain("  7 commits by its threads on main");
    expect(text).toContain("    c000000  Commit 0");
    expect(text).toContain("    c400000  Commit 4");
    expect(text).not.toContain("Commit 5");
    expect(text).toContain("    … 2 more (bb vantage worktree <thread>)");
    expect(text.indexOf("commits by its threads")).toBeLessThan(text.indexOf("README.md"));
  });

  it("prints no commit line for a repository its threads made no commits in", () => {
    expect(formatOverview(overview({ repos: [repo({ threadIds: ["thr_1"] })] }))).not.toContain("commits by its threads");
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
    expect(text).toContain("commons · Edited by path · branch main · 1 file +3 −0 · Laptop");
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

describe("bb vantage --all", () => {
  const TWO = { tree: [PARENT, CHILD], status: (id: string) => (id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work")) };

  it("prints every thread's changes as JSON, without a thread", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const result = await harness.behavior.runCli(["changes", "--all", "--json"], {});
    expect(result.exitCode).toBe(0);
    const printed = JSON.parse(result.stdout ?? "") as Overview;
    expect(overviewSchema.safeParse(printed).success).toBe(true);
    expect(printed).toMatchObject({ target: { kind: "all" }, windowHours: 24 });
    expect(printed.repos).toHaveLength(2);
  });

  it("prints the worktrees of every thread, for a window of 6 hours when asked", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const result = await harness.behavior.runCli(["worktrees", "--all", "--hours", "6", "--json"], { threadId: "thr_1" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({ target: { kind: "all" }, windowHours: 6, worktrees: [{ threadIds: ["thr_1"] }, { threadIds: ["thr_2"] }] });
    const text = await harness.behavior.runCli(["worktrees", "--all", "--hours", "6"], {});
    expect(text.stdout).toContain("Project · 2 worktrees");
  });

  it("does not let --hours change the setting for the next call", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.runCli(["worktrees", "--all", "--hours", "6"], {});
    const next = await harness.behavior.runCli(["worktrees", "--all", "--json"], {});
    expect(JSON.parse(next.stdout ?? "")).toMatchObject({ windowHours: 24 });
  });

  it("groups the text output under a heading for each project", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const changes = await harness.behavior.runCli(["changes", "--all"], {});
    expect(changes.stdout).toContain("Project · 2 repos · 2 files");
    expect(changes.stdout).toMatch(/last 24 hours/);
    const worktrees = await harness.behavior.runCli(["worktrees", "--all"], {});
    const lines = (worktrees.stdout ?? "").split("\n");
    expect(lines[0]).toMatch(/^STATUS\s+THREAD\s+AHEAD\/BEHIND\s+UNCOMMITTED\s+BRANCH$/);
    expect(lines[1]).toBe("Project · 2 worktrees");
    expect(lines[2]).toMatch(/^idle\s+Parent\s+↑0 ↓0\s+1 file\s+feature\/work$/);
  });

  it("refuses --all together with --thread", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    for (const command of ["changes", "worktrees"]) {
      const result = await harness.behavior.runCli([command, "--all", "--thread", "thr_1", "--json"], {});
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout ?? "")).toMatchObject({ ok: false, error: { code: "target_conflict" } });
    }
  });

  it("refuses --hours without --all", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    for (const command of ["changes", "worktrees"]) {
      const result = await harness.behavior.runCli([command, "--hours", "6", "--json"], { threadId: "thr_1" });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout ?? "")).toMatchObject({ ok: false, error: { code: "hours_requires_all" } });
    }
  });

  it("rejects a window outside 1 to 720 hours", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    for (const hours of ["0", "721"]) {
      const result = await harness.behavior.runCli(["changes", "--all", "--hours", hours], {});
      expect(result.exitCode).not.toBe(0);
    }
  });

  it("keeps the thread_required error without --all", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const result = await harness.behavior.runCli(["worktrees", "--json"], {});
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({ ok: false, error: { code: "thread_required" } });
  });
});
