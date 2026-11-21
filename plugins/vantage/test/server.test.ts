import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createCli, formatOverview, formatWorktree, formatWorktrees } from "../src/cli";
import { overviewSchema, type Overview } from "../src/contract";
import server from "../server";
import {
  branchRepo,
  branchWorktree,
  checkoutRepo,
  checkoutWorktree,
  commit,
  environment,
  fileChange,
  overview,
  recordedRepo,
  repo,
  sharedFile,
  threadSummary,
  worktree,
} from "./fixtures";

type HostCall = { method: string; input: unknown; hostId: string };

const row = (seq: number, item: object) => ({
  id: `e${seq}`,
  scope: { kind: "thread" },
  threadId: "thr_1",
  seq,
  createdAt: seq * 1000,
  type: "item/completed",
  data: { item },
});
const fileChangeRow = (seq: number, changes: object[], status = "completed") =>
  row(seq, { type: "fileChange", id: `i${seq}`, status, approvalStatus: null, changes });

const gitFile = (path: string) => ({
  path,
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
});

// What the host's checkoutStatus answers for a worktree.
const statusOf = (uncommitted: string[], committed: string[] = [], branch = "feature/work") => ({
  outcome: "available",
  branch,
  head: "e".repeat(40),
  base: "origin/main",
  skippedBase: null,
  aheadCount: committed.length,
  behindCount: 0,
  commits: committed.map((_, index) => ({
    sha: `${index + 1}`.padStart(40, "0"),
    shortSha: `${index + 1}`.padStart(7, "0"),
    subject: "Work",
    authorName: "Ada",
    authoredAt: 1_700_000_000_000,
  })),
  uncommitted: uncommitted.map(gitFile),
  committed: committed.map(gitFile),
  truncated: false,
});

interface TreeThread {
  id: string;
  title: string;
  parentThreadId: string | null;
  environmentId: string | null;
  status?: string;
}
const PARENT: TreeThread = { id: "thr_1", title: "Parent", parentThreadId: null, environmentId: "env_1" };
const CHILD: TreeThread = {
  id: "thr_2",
  title: "Child A",
  parentThreadId: "thr_1",
  environmentId: "env_2",
  status: "active",
};
const DONE: TreeThread = { id: "thr_3", title: "Finished child", parentThreadId: "thr_1", environmentId: null };

function start(
  options: {
    files?: string[];
    provider?: string;
    events?: object[];
    hostResult?: (call: HostCall) => unknown;
    tree?: TreeThread[];
    status?: (environmentId: string) => unknown;
    onList?: () => void;
    archived?: TreeThread[];
    onDescendants?: () => void | Promise<void>;
    eventsList?: (args: {
      threadId: string;
      afterSeq?: string;
      order?: string;
      limit?: string;
      types?: readonly string[];
    }) => object[];
  } = {},
) {
  const subscriptions: Array<{ event: string; callback: (event: unknown) => void }> = [];
  const unsubscribed: string[] = [];
  const tree = options.tree ?? [PARENT];
  const envs: Record<string, ReturnType<typeof environment>> = {
    env_1: environment({
      id: "env_1",
      path: "/work/one",
      ...(options.provider === undefined ? {} : { environmentProviderId: options.provider }),
    }),
    env_2: environment({ id: "env_2", path: "/work/two", branchName: "child-work" }),
  };
  envs.env_3 = environment({ id: "env_3", path: "/work/three" });
  const ancestorsOf = (id: string): string[] => {
    const parent = [...tree, ...(options.archived ?? [])].find((thread) => thread.id === id)?.parentThreadId ?? null;
    return parent === null ? [] : [parent, ...ancestorsOf(parent)];
  };
  const env = envs.env_1!;
  const result = createFakePluginHost({
    pluginId: "vantage",
    sdk: {
      subscribe: ((args: { event: string; callback: (event: unknown) => void }) => {
        subscriptions.push(args);
        return () => {
          unsubscribed.push(args.event);
        };
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
          const listed =
            archived === true
              ? (options.archived ?? []).map((thread) =>
                  makeThreadResponse({ ...thread, status: "idle", updatedAt: now, archivedAt: now }),
                )
              : tree.map((thread) =>
                  makeThreadResponse({ ...thread, status: (thread.status ?? "idle") as "idle", updatedAt: now }),
                );
          return listed.slice(offset ?? 0, (offset ?? 0) + (limit ?? 100));
        },
        experimental_listDescendants: async () => {
          await options.onDescendants?.();
          return {
            threads: [
              {
                threadId: "thr_1",
                descendantIds: [...tree, ...(options.archived ?? [])]
                  .filter((thread) => ancestorsOf(thread.id).includes("thr_1"))
                  .map((thread) => thread.id),
              },
            ],
          };
        },
        experimental_listAncestors: async ({ threadIds }: { threadIds: readonly string[] }) => ({
          threads: threadIds.map((threadId) => ({ threadId, ancestorIds: ancestorsOf(threadId) })),
        }),
        events: {
          list: async (args: Parameters<NonNullable<typeof options.eventsList>>[0]) =>
            options.eventsList?.(args) ?? options.events ?? [],
        },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => envs[environmentId] ?? env,
      },
      projects: { list: async () => [{ id: "proj_1", name: "Project", sources: [] }] },
      hosts: { list: async () => [{ id: "host_1", name: "Laptop", status: "connected" }] },
    },
    experimental_callHostRpc: (call) => {
      const custom = options.hostResult?.(call as HostCall);
      if (custom !== undefined) return custom;
      const { method, input } = call as HostCall;
      if (method === "verifyRoots") return { invalidRoots: [] };
      if (method === "resolveRoots") {
        const paths = (input as { paths: string[] }).paths;
        const rootOf = (path: string) =>
          ["/work/one", "/work/two", "/work/three"].find((root) => path === root || path.startsWith(`${root}/`)) ??
          null;
        return {
          results: paths.map((path) => {
            const root = rootOf(path);
            return root === null
              ? { path, root: null, relative: null }
              : { path, root, relative: path.slice(root.length + 1) };
          }),
        };
      }
      if (method === "checkoutStatus") {
        const root = (input as { root: string }).root;
        const id = Object.values(envs).find((entry) => entry.path === root)?.id ?? root;
        return options.status?.(id) ?? statusOf(["src/a.ts"]);
      }
      if (method === "repoFiles") {
        return {
          outcome: "available",
          branch: null,
          base: "origin/main",
          aheadCount: 0,
          behindCount: 0,
          commits: [],
          files: (options.files ?? ["src/a.ts"]).map(gitFile),
          truncated: false,
        };
      }
      if (method === "repoPatch") return { outcome: "available", patch: "+hello", truncated: false, binary: false };
      throw new Error(`unexpected host call ${method}`);
    },
  });
  const emit = (event: string, payload: object) => {
    for (const subscription of subscriptions)
      if (subscription.event === event)
        subscription.callback({ entity: event.split(":")[0], type: "changed", ...payload });
  };
  return { ...result, subscriptions, unsubscribed, emit, ready: Promise.resolve(server(result.bb)) };
}

describe("server", () => {
  it("registers the rpc methods and the vantage command, and logs that it loaded", async () => {
    const { harness, ready } = start();
    await ready;
    expect(harness.registrations.rpcMethods).toEqual([
      "shell",
      "overview",
      "patch",
      "fileSides",
      "image",
      "commitFiles",
      "recordedEdits",
      "reviewed",
      "setReviewed",
      "setWhole",
    ]);
    expect(harness.registrations.cli?.name).toBe("vantage");
    expect(harness.logEntries).toContainEqual({ level: "info", message: "loaded" });
  });

  it("answers overview with a value the schema accepts", async () => {
    const { harness, ready } = start({
      events: [fileChangeRow(1, [{ path: "/work/one/src/a.ts", kind: "update", diff: "+x" }])],
    });
    await ready;
    const result = await harness.behavior.callRpc("overview", {
      target: { kind: "tree", threadId: "thr_1" },
      scope: "uncommitted",
      includeArchived: true,
    });
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
    await expect(
      harness.behavior.callRpc("overview", {
        target: { kind: "tree", threadId: "thr_1" },
        scope: "uncommitted",
        includeArchived: true,
        extra: 1,
      }),
    ).rejects.toThrow();
  });

  it("rejects an overview request that does not say whether archived threads are wanted", async () => {
    const { harness, ready } = start();
    await ready;
    await expect(
      harness.behavior.callRpc("overview", { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted" }),
    ).rejects.toThrow();
    await expect(harness.behavior.callRpc("shell", { target: { kind: "tree", threadId: "thr_1" } })).rejects.toThrow();
  });

  it("answers patch for a workspace with the branch scope through the host at its repository root", async () => {
    const { harness, ready } = start();
    await ready;
    const result = await harness.behavior.callRpc("patch", {
      ref: { kind: "workspace", environmentId: "env_1", base: "origin/main", root: "/work/one", hostId: "host_1" },
      path: "src/a.ts",
      previousPath: null,
      untracked: false,
      scope: "branch",
      sha: null,
    });
    expect(result).toEqual({ patch: "+hello", truncated: false, binary: false });
    expect(harness.experimental_hostRpcCalls).toMatchObject([
      {
        method: "repoPatch",
        hostId: "host_1",
        input: {
          root: "/work/one",
          path: "src/a.ts",
          previousPath: null,
          untracked: false,
          target: { type: "merge-base", base: "origin/main" },
        },
      },
    ]);
  });

  it("does not exclude or look up a provider with the default settings", async () => {
    const { harness, ready } = start({ provider: "example-provider" });
    await ready;
    const ref = { kind: "workspace", environmentId: "env_1", base: null, root: "/work/one", hostId: "host_1" };
    const file = { ref, path: "src/a.ts", previousPath: null, untracked: false, scope: "uncommitted" };
    await expect(harness.behavior.callRpc("patch", file)).resolves.toMatchObject({ patch: "+hello" });
    expect(harness.inspection.sdk.callsTo("environments.get")).toEqual([]);
    expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    expect(harness.experimental_hostRpcCalls[0]?.input).not.toHaveProperty("excludedRoots");
  });

  it("refuses file and commit reads for a configured provider regardless of its path", async () => {
    const { harness, ready } = start({
      provider: "example-provider",
      hostResult: ({ method, input }) => {
        if (method === "repoPatch" && (input as { excludedRoots?: string[] }).excludedRoots?.includes("/work/one"))
          return { outcome: "unavailable", reason: "git-failed", message: "This checkout is excluded" };
        return undefined;
      },
    });
    await ready;
    await harness.behavior.setSettings({ excludedProviders: "other-provider, example-provider\nthird-provider" });
    const ref = { kind: "workspace", environmentId: "env_1", base: "origin/main", root: "/work/one", hostId: "host_1" };
    const file = { ref, path: "src/a.ts", previousPath: null, untracked: false, scope: "branch", sha: null };
    for (const method of ["patch", "image", "fileSides"]) {
      await expect(harness.behavior.callRpc(method, file)).rejects.toThrow(/excluded/);
    }
    await expect(harness.behavior.callRpc("commitFiles", { ref, sha: "a".repeat(40) })).rejects.toThrow(/excluded/);
    expect(harness.experimental_hostRpcCalls).toEqual([]);
    expect(harness.inspection.sdk.callsTo("environments.get")).toHaveLength(1);
    const checkout = { ...file, ref: { kind: "checkout", root: ref.root, base: ref.base, hostId: ref.hostId } };
    await expect(harness.behavior.callRpc("patch", checkout)).rejects.toThrow(/excluded/);
    await harness.behavior.setSettings({ excludedProviders: "other-provider" });
    await expect(harness.behavior.callRpc("patch", file)).resolves.toMatchObject({ patch: "+hello" });
    expect(harness.inspection.sdk.callsTo("environments.get")).toHaveLength(2);
  });

  it("forwards configured paths and rebuilds the overview when they change", async () => {
    const { harness, ready } = start({
      eventsList: ({ afterSeq }) =>
        afterSeq === undefined ? [fileChangeRow(1, [{ path: "/work/one/src/a.ts", kind: "update", diff: "+hello" }])] : [],
      hostResult: ({ method, input }) => {
        const { excludedRoots, paths } = input as { excludedRoots?: string[]; paths?: string[] };
        if (excludedRoots === undefined) return undefined;
        expect(excludedRoots).toEqual(["~/checkouts", "/work/one", "/work/other"]);
        if (method === "resolveRoots")
          return { results: paths!.map((path) => ({ path, root: null, relative: null, excluded: true })) };
        if (method === "repoPatch")
          return { outcome: "unavailable", reason: "git-failed", message: "Vantage does not run Git here: this checkout is excluded in Vantage's settings" };
        throw new Error(`unexpected Git read: ${method}`);
      },
    });
    const input = { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: false };
    const read = async () => overviewSchema.parse(await harness.behavior.callRpc("overview", input));
    try {
      await ready;
      expect((await read()).worktrees[0]?.state).toBe("ready");
      const before = harness.experimental_hostRpcCalls.length;
      await harness.behavior.setSettings({ excludedPaths: " ~/checkouts\n/work/one , /work/other, /work/one " });
      const excluded = await read();
      expect(excluded.worktrees[0]).toMatchObject({ state: "unavailable", message: expect.stringMatching(/excluded/) });
      expect(excluded.repos[0]?.files).toMatchObject([{ path: "src/a.ts", edits: { count: 1 } }]);
      const calls = harness.experimental_hostRpcCalls.slice(before);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(({ method }) => method === "resolveRoots")).toBe(true);
      const file = {
        ref: { kind: "checkout", hostId: "host_1", root: "/work/one", base: null },
        path: "src/a.ts",
        previousPath: null,
        untracked: false,
        scope: "uncommitted",
      };
      await expect(harness.behavior.callRpc("patch", file)).rejects.toThrow(/excluded/);
      await harness.behavior.setSettings({ excludedPaths: "" });
      expect((await read()).worktrees[0]?.state).toBe("ready");
      await expect(harness.behavior.callRpc("patch", file)).resolves.toMatchObject({ patch: "+hello" });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it.each(["git-worktree", "example-provider"])(
    "uses the awaited %s provider after 20 environment events and expiry",
    async (provider) => {
      vi.useFakeTimers();
      const { harness, ready, emit } = start();
      let resolve!: (value: ReturnType<typeof environment>) => void;
      harness.inspection.sdk.stub(
        "environments.get",
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const ref = { kind: "workspace", environmentId: "env_1", base: null, root: "/work/one", hostId: "host_1" };
      const file = { ref, path: "src/a.ts", previousPath: null, untracked: false, scope: "uncommitted" };
      const result = (read: Promise<unknown>) =>
        read.then(
          () => "allowed",
          (error: unknown) => String(error),
        );
      try {
        await ready;
        await harness.behavior.setSettings({ excludedProviders: "example-provider" });
        const completed = vi.fn();
        const pending = result(harness.behavior.callRpc("patch", file)).then(completed);
        await vi.advanceTimersByTimeAsync(0);
        for (let index = 0; index < 20; index++) {
          emit("environment:changed", { id: "env_1", changes: ["work-status-changed"] });
        }
        resolve(environment({ id: "env_1", environmentProviderId: provider }));
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.inspection.sdk.callsTo("environments.get")).toHaveLength(1);
        const expected = provider === "example-provider" ? expect.stringMatching(/excluded/) : "allowed";
        expect(completed).toHaveBeenCalledWith(expected);
        await pending;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await result(harness.behavior.callRpc("patch", file))).toEqual(expected);
        expect(harness.inspection.sdk.callsTo("environments.get")).toHaveLength(1);
        expect(harness.experimental_hostRpcCalls).toHaveLength(provider === "example-provider" ? 0 : 2);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("retries a failed provider lookup without letting the first request reach the host", async () => {
    const { harness, ready } = start();
    const ref = { kind: "workspace", environmentId: "env_1", base: null, root: "/work/one", hostId: "host_1" };
    const file = { ref, path: "src/a.ts", previousPath: null, untracked: false, scope: "uncommitted" };
    harness.inspection.sdk.stub(
      "environments.get",
      vi.fn().mockRejectedValueOnce(new Error("provider lookup failed")).mockResolvedValue(environment()),
    );
    try {
      await ready;
      await harness.behavior.setSettings({ excludedProviders: "example-provider" });
      await expect(harness.behavior.callRpc("patch", file)).rejects.toThrow("provider lookup failed");
      expect(harness.experimental_hostRpcCalls).toHaveLength(0);
      await expect(harness.behavior.callRpc("patch", file)).resolves.toMatchObject({ patch: "+hello" });
      expect(harness.inspection.sdk.callsTo("environments.get")).toHaveLength(2);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("answers patch for a checkout through the host", async () => {
    const { harness, ready } = start({
      hostResult: (call) =>
        call.method === "repoPatch"
          ? { outcome: "available", patch: "+from host", truncated: false, binary: false }
          : undefined,
    });
    await ready;
    const result = await harness.behavior.callRpc("patch", {
      ref: { kind: "checkout", hostId: "host_2", root: "/code/commons", base: null },
      path: "a.md",
      previousPath: null,
      untracked: true,
      scope: "uncommitted",
    });
    expect(result).toEqual({ patch: "+from host", truncated: false, binary: false });
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "repoPatch",
      hostId: "host_2",
      input: { root: "/code/commons", path: "a.md", untracked: true, target: { type: "uncommitted" } },
    });
  });

  it("rejects a patch request for a recorded repository", async () => {
    const { harness, ready } = start();
    await ready;
    await expect(
      harness.behavior.callRpc("patch", {
        ref: { kind: "recorded" },
        path: "a.ts",
        previousPath: null,
        untracked: false,
        scope: "uncommitted",
      }),
    ).rejects.toThrow("Use recordedEdits");
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

describe("server: a thread's tree", () => {
  const TREE = { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true };

  it("shares concurrent builds and keeps the completed overview while it is fresh", async () => {
    let builds = 0;
    const { harness, ready } = start({
      tree: [PARENT, CHILD],
      onDescendants: () => {
        builds++;
      },
    });
    await ready;
    const [first, second] = await Promise.all([
      harness.behavior.callRpc("overview", TREE),
      harness.behavior.callRpc("overview", TREE),
    ]);
    expect(builds).toBe(1);
    expect(second).toEqual(first);
    expect(await harness.behavior.callRpc("overview", TREE)).toEqual(first);
    expect(builds).toBe(1);
  });

  it("does not share a build between different threads, scopes, archived choices or hard refreshes", async () => {
    let builds = 0;
    const { harness, ready } = start({
      tree: [PARENT, CHILD],
      onDescendants: () => {
        builds++;
      },
    });
    await ready;
    await Promise.all([
      harness.behavior.callRpc("overview", TREE),
      harness.behavior.callRpc("overview", { ...TREE, target: { kind: "tree", threadId: "thr_2" } }),
      harness.behavior.callRpc("overview", { ...TREE, scope: "branch" }),
      harness.behavior.callRpc("overview", { ...TREE, includeArchived: false }),
      harness.behavior.callRpc("overview", { ...TREE, refresh: true }),
    ]);
    expect(builds).toBe(5);
  });

  it.each(["history-rewritten", "history-compacted"])(
    "resets a partial archive on %s before the next overview",
    async (change) => {
      const inChild = <T extends { threadId: string }>(event: T) => ({ ...event, threadId: DONE.id });
      let rows = [
        inChild(fileChangeRow(1, [{ path: "old.ts", kind: "add" }])),
        ...Array.from({ length: 400 }, (_, i) => inChild(row(i + 2, { type: "agentMessage", id: `m${i}`, text: "x" }))),
      ];
      const cursors: Array<string | undefined> = [];
      const { harness, ready, emit } = start({
        tree: [{ ...PARENT, environmentId: null }],
        archived: [DONE],
        eventsList: ({ threadId, afterSeq, limit }) => {
          if (threadId !== DONE.id) return [];
          cursors.push(afterSeq);
          return rows.filter((event) => event.seq > Number(afterSeq ?? 0)).slice(0, Number(limit));
        },
      });
      await ready;
      try {
        const first = overviewSchema.parse(await harness.behavior.callRpc("overview", TREE));
        expect(first.otherFiles.map((file) => file.path)).toEqual(["old.ts"]);
        expect(cursors).toEqual([undefined, "100", "200", "300"]);
        rows = [inChild(fileChangeRow(1, [{ path: "rewritten.ts", kind: "add" }]))];
        emit("thread:changed", { id: DONE.id, changes: [change] });
        await vi.waitFor(async () => {
          const fresh = overviewSchema.parse(await harness.behavior.callRpc("overview", TREE));
          expect(fresh.otherFiles.map((file) => file.path)).toEqual(["rewritten.ts"]);
          expect(fresh.warnings).toEqual([]);
        });
        expect(cursors).toEqual([undefined, "100", "200", "300", undefined]);
        expect(harness.experimental_hostRpcCalls).toEqual([]);
      } finally {
        await harness.lifecycle.dispose();
      }
    },
  );

  describe("with a build in flight", () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    function slowBuilds() {
      const gates: Array<ReturnType<typeof deferred>> = [];
      const options = {
        tree: [PARENT, CHILD],
        onDescendants: () => {
          const gate = deferred();
          gates.push(gate);
          return gate.promise;
        },
      };
      return { gates, options };
    }
    const unknownChange = { id: "thr_2", changes: ["events-appended"] };
    // Awaiting the settings and host reads before the build starts takes a few turns.
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it("coalesces 50 invalidations into one pending build behind the running build", async () => {
      const { gates, options } = slowBuilds();
      const { harness, ready, emit } = start(options);
      await ready;
      const requests = [harness.behavior.callRpc("overview", TREE)];
      try {
        await flush();
        expect(gates).toHaveLength(1);
        for (let i = 0; i < 50; i++) {
          emit("thread:changed", unknownChange);
          requests.push(harness.behavior.callRpc("overview", TREE));
          await flush();
        }
        expect(gates).toHaveLength(1);
        gates[0]!.resolve();
        await vi.waitFor(() => expect(gates).toHaveLength(2));
      } finally {
        for (const gate of gates) gate.resolve();
        await Promise.allSettled(requests);
        await harness.lifecycle.dispose();
      }
    });

    it("runs a visible tree before queued all-threads Git work", async () => {
      const gate = deferred();
      const started: string[] = [];
      const { harness, ready } = start({
        tree: [PARENT, { ...CHILD, parentThreadId: null }],
        status: (id) => {
          started.push(id);
          return id === "env_1" ? gate.promise.then(() => statusOf(["a.ts"])) : statusOf(["b.ts"]);
        },
      });
      await ready;
      const all = harness.behavior.callRpc("overview", { ...TREE, target: { kind: "all" } });
      let tree: Promise<unknown> | undefined;
      try {
        await vi.waitFor(() => expect(started).toContain("env_1"));
        expect(started).toEqual(["env_1"]);
        tree = harness.behavior.callRpc("overview", { ...TREE, target: { kind: "tree", threadId: "thr_2" } });
        await vi.waitFor(() => expect(started).toEqual(["env_1", "env_2"]));
        expect(await tree).toMatchObject({ threadId: "thr_2", worktrees: [{ state: "ready" }] });
      } finally {
        gate.resolve();
        await Promise.allSettled([all, tree]);
        await harness.lifecycle.dispose();
      }
    });

    it("does not block all-threads host reads behind an unawaited tree rebuild", async () => {
      const gate = deferred();
      let hold = false;
      const rebuilding = vi.fn();
      const { harness, ready, emit } = start({
        tree: [PARENT, { ...CHILD, parentThreadId: null }],
        onDescendants: () => {
          if (!hold) return;
          rebuilding();
          return gate.promise;
        },
      });
      try {
        await ready;
        await harness.behavior.callRpc("overview", TREE);
        hold = true;
        emit("environment:changed", { id: "env_1", changes: ["git-refs-changed"] });
        await vi.waitFor(() => expect(rebuilding).toHaveBeenCalledTimes(1));
        const answered = vi.fn();
        const all = harness.behavior.callRpc("overview", { ...TREE, target: { kind: "all" } }).then(answered);
        try {
          await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1), { timeout: 500 });
        } finally {
          gate.resolve();
          await all;
        }
      } finally {
        await harness.lifecycle.dispose();
      }
    });

    it("backs off an invalidated build by 1.5 times its duration", async () => {
      vi.useFakeTimers();
      const { gates, options } = slowBuilds();
      const { harness, ready, emit } = start(options);
      try {
        await ready;
        const first = harness.behavior.callRpc("overview", TREE);
        await vi.advanceTimersByTimeAsync(0);
        expect(gates).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(400);
        emit("thread:changed", unknownChange);
        gates[0]!.resolve();
        await first;
        await vi.advanceTimersByTimeAsync(599);
        expect(gates).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(gates).toHaveLength(2);
      } finally {
        for (const gate of gates) gate.resolve();
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("limits 30 file events across three workspaces to one all rebuild per minute, without delaying a tree", async () => {
      vi.useFakeTimers();
      const list = vi.fn();
      const descendants = vi.fn();
      const { harness, ready, emit } = start({
        tree: [PARENT, CHILD, { ...DONE, environmentId: "env_3" }],
        onList: list,
        onDescendants: descendants,
      });
      const all = { ...TREE, target: { kind: "all" } };
      try {
        await ready;
        await harness.behavior.callRpc("overview", all);
        await harness.behavior.callRpc("overview", TREE);
        const before = list.mock.calls.length;
        for (let index = 0; index < 30; index++) {
          emit("thread:changed", {
            id: [PARENT.id, CHILD.id, DONE.id][index % 3],
            changes: ["events-appended"],
            metadata: { eventTypes: ["turn/completed"] },
          });
          await vi.advanceTimersByTimeAsync(1900);
        }
        expect(descendants.mock.calls.length).toBeGreaterThan(1);
        expect(list).toHaveBeenCalledTimes(before);
        await vi.advanceTimersByTimeAsync(3000);
        expect(list).toHaveBeenCalledTimes(2 * before);
        emit("environment:changed", { id: "env_3", changes: ["work-status-changed"] });
        await vi.advanceTimersByTimeAsync(1000);
        expect(list).toHaveBeenCalledTimes(2 * before);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("publishes an all-threads sample even if another edit dirties it before the minute ends", async () => {
      vi.useFakeTimers();
      const gate = deferred();
      let statusReads = 0;
      const list = vi.fn();
      const { harness, ready, emit } = start({
        onList: list,
        status: () => (++statusReads === 1 ? statusOf(["old.ts"]) : gate.promise.then(() => statusOf(["new.ts"]))),
      });
      const all = { ...TREE, target: { kind: "all" } };
      const fileEvent = { id: PARENT.id, changes: ["events-appended"], metadata: { eventTypes: ["turn/completed"] } };
      try {
        await ready;
        await harness.behavior.callRpc("overview", all);
        const perBuild = list.mock.calls.length;
        emit("thread:changed", fileEvent);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(list).toHaveBeenCalledTimes(2 * perBuild);
        emit("thread:changed", fileEvent);
        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);
        const sample = overviewSchema.parse(await harness.behavior.callRpc("overview", all));
        expect(sample.worktrees[0]?.uncommitted.map(({ path }) => path)).toEqual(["new.ts"]);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(list).toHaveBeenCalledTimes(2 * perBuild);
        await vi.advanceTimersByTimeAsync(1);
        expect(list).toHaveBeenCalledTimes(3 * perBuild);
      } finally {
        gate.resolve();
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it.each(["archived-changed", "parent-changed"])("revalidates all for a nonmember's %s", async (change) => {
      vi.useFakeTimers();
      const tree = [PARENT];
      const { harness, ready, emit } = start({ tree });
      const all = { ...TREE, target: { kind: "all" } };
      try {
        await ready;
        await harness.behavior.callRpc("overview", all);
        await vi.advanceTimersByTimeAsync(60_000);
        tree.push(CHILD);
        emit("thread:changed", { id: CHILD.id, changes: [change] });
        await vi.advanceTimersByTimeAsync(150);
        expect(
          overviewSchema.parse(await harness.behavior.callRpc("overview", all)).threads.map(({ id }) => id),
        ).toContain(CHILD.id);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("dirties only the parent chain's trees and all when a thread is created", async () => {
      vi.useFakeTimers();
      const tree = [PARENT, CHILD, { ...DONE, parentThreadId: null }];
      const descendants = vi.fn();
      const list = vi.fn();
      const { harness, ready, emit } = start({ tree, onDescendants: descendants, onList: list });
      const parent = { ...TREE, target: { kind: "tree", threadId: CHILD.id } };
      const unrelated = { ...TREE, target: { kind: "tree", threadId: DONE.id } };
      const all = { ...TREE, target: { kind: "all" } };
      try {
        await ready;
        for (const input of [TREE, parent, unrelated, all]) await harness.behavior.callRpc("overview", input);
        descendants.mockClear();
        list.mockClear();
        await vi.advanceTimersByTimeAsync(60_000);
        const child = { ...DONE, id: "thr_new", parentThreadId: CHILD.id };
        tree.push(child);
        emit("thread:changed", { id: child.id, changes: ["thread-created"] });
        await vi.advanceTimersByTimeAsync(150);
        expect(descendants).toHaveBeenCalledTimes(2);
        expect(
          harness.inspection.sdk
            .callsTo("threads.experimental_listDescendants")
            .slice(-2)
            .map(([args]) => args),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ threadIds: [PARENT.id] }),
            expect.objectContaining({ threadIds: [CHILD.id] }),
          ]),
        );
        expect(list).toHaveBeenCalled();
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("revalidates all-threads keys only for relevant changes to members or creation", async () => {
      vi.useFakeTimers();
      const tree = [PARENT];
      const list = vi.fn();
      const { harness, ready, emit } = start({ tree, onList: list });
      const all = { ...TREE, target: { kind: "all" } };
      try {
        await ready;
        await harness.behavior.callRpc("overview", all);
        const before = list.mock.calls.length;
        emit("thread:changed", {
          id: "thr_1",
          changes: ["read-state-changed", "tabs-changed", "terminals-changed", "storage-changed"],
        });
        await vi.advanceTimersByTimeAsync(175);
        expect(list).toHaveBeenCalledTimes(before);
        emit("thread:changed", { id: "outside", changes: ["status-changed", "title-changed"] });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(list).toHaveBeenCalledTimes(before);
        for (const change of [
          "status-changed",
          "title-changed",
          "archived-changed",
          "parent-changed",
          "environment-changed",
          "thread-deleted",
          "history-rewritten",
          "history-compacted",
        ]) {
          const reads = list.mock.calls.length;
          emit("thread:changed", { id: "thr_1", changes: [change] });
          await vi.advanceTimersByTimeAsync(60_000);
          await harness.behavior.callRpc("overview", all);
          expect(list.mock.calls.length, change).toBeGreaterThan(reads);
        }
        tree.push(CHILD);
        emit("thread:changed", { id: CHILD.id, changes: ["thread-created", "events-appended"] });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(
          overviewSchema.parse(await harness.behavior.callRpc("overview", all)).threads.map(({ id }) => id),
        ).toContain(CHILD.id);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("serves stale data at once, then publishes exactly once for the new result", async () => {
      const gate = deferred();
      let filename = "old.ts";
      let reads = 0;
      const clock = vi.spyOn(Date, "now");
      const at = Date.now();
      clock.mockReturnValue(at);
      const { harness, ready } = start({
        status: () => (++reads === 1 ? statusOf([filename]) : gate.promise.then(() => statusOf([filename]))),
      });
      await ready;
      try {
        const first = await harness.behavior.callRpc("overview", TREE);
        filename = "new.ts";
        clock.mockReturnValue(at + 61_000);
        const returned = vi.fn();
        const stale = harness.behavior.callRpc("overview", TREE).then((value) => {
          returned(value);
          return value;
        });
        try {
          await flush();
          expect(returned).toHaveBeenCalledExactlyOnceWith(first);
        } finally {
          gate.resolve();
          await stale;
        }
        await vi.waitFor(() =>
          expect(harness.inspection.realtimeSignals).toEqual([
            { channel: "vantage:overview", payload: { key: JSON.stringify(["tree", "thr_1", "uncommitted", true]) } },
          ]),
        );
        const fresh = await harness.behavior.callRpc("overview", TREE);
        expect(overviewSchema.parse(fresh).repos[0]?.files.map((file) => file.path)).toEqual(["new.ts"]);
        expect(reads).toBe(2);
      } finally {
        clock.mockRestore();
        await harness.lifecycle.dispose();
      }
    });

    it("revalidates recently requested keys but stops when the last request is 90 seconds old", async () => {
      const clock = vi.spyOn(Date, "now");
      const at = Date.now();
      clock.mockReturnValue(at);
      let builds = 0;
      const { harness, ready, emit } = start({
        onDescendants: () => {
          builds++;
        },
      });
      await ready;
      try {
        await harness.behavior.callRpc("overview", TREE);
        emit("environment:changed", { id: "env_1", changes: ["git-refs-changed"] });
        await vi.waitFor(() => expect(builds).toBe(2));
        await flush();
        expect(harness.inspection.realtimeSignals).toEqual([]);
        clock.mockReturnValue(at + 90_000);
        emit("environment:changed", { id: "env_1", changes: ["git-refs-changed"] });
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        expect(builds).toBe(2);
      } finally {
        clock.mockRestore();
        await harness.lifecycle.dispose();
      }
    });

    it("keeps the content revision on an unchanged build without publishing", async () => {
      vi.useFakeTimers();
      const { harness, ready, emit } = start();
      try {
        await ready;
        const first = overviewSchema.parse(await harness.behavior.callRpc("overview", TREE));
        emit("environment:changed", { id: "env_1", changes: ["git-refs-changed"] });
        await vi.advanceTimersByTimeAsync(150);
        expect(await harness.behavior.callRpc("overview", TREE)).toEqual(first);
        expect(harness.inspection.realtimeSignals).toEqual([]);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("includes the last rebuild error in stale results until a build succeeds", async () => {
      vi.useFakeTimers();
      let fail = false;
      const { harness, ready, emit } = start({
        onDescendants: () => {
          if (fail) throw new Error("host lost");
        },
      });
      try {
        await ready;
        const first = overviewSchema.parse(await harness.behavior.callRpc("overview", TREE));
        fail = true;
        emit("environment:changed", { id: "env_1", changes: ["git-refs-changed"] });
        await vi.advanceTimersByTimeAsync(150);
        const stale = overviewSchema.parse(await harness.behavior.callRpc("overview", TREE));
        expect(stale.generatedAt).toBe(first.generatedAt);
        expect(stale.warnings.join("\n")).toMatch(/host lost/);
        fail = false;
        await vi.advanceTimersByTimeAsync(150);
        expect(overviewSchema.parse(await harness.behavior.callRpc("overview", TREE)).warnings).toEqual(first.warnings);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("does not replace a new overview with a delayed KV read", async () => {
      vi.useFakeTimers();
      const gate = deferred();
      const { bb, harness, ready, emit } = start();
      const kv = bb.storage.kv;
      const get = kv.get.bind(kv);
      const delayed = vi.spyOn(kv, "get").mockImplementation(async (key) => {
        if (!key.startsWith("overview:v1:")) return get(key);
        await gate.promise;
        return {
          key: JSON.stringify(["tree", "thr_1", "uncommitted", true]),
          value: overview({ generatedAt: 1 }),
        } as never;
      });
      try {
        await ready;
        const reading = harness.behavior.callRpc("overview", TREE);
        await vi.advanceTimersByTimeAsync(0);
        expect(delayed).toHaveBeenCalled();
        emit("environment:changed", { id: "env_1", changes: ["git-refs-changed"] });
        await vi.advanceTimersByTimeAsync(150);
        expect(await kv.list("overview:v1:")).toHaveLength(1);
        gate.resolve();
        const result = overviewSchema.parse(await reading);
        expect(result.generatedAt).toBeGreaterThan(1);
        expect(result.threads.map(({ id }) => id)).toEqual([PARENT.id]);
      } finally {
        gate.resolve();
        delayed.mockRestore();
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("keeps only four all-threads keys in memory and persisted storage", async () => {
      vi.useFakeTimers();
      const list = vi.fn();
      const { bb, harness, ready, emit } = start({ onList: list });
      try {
        await ready;
        const requests = Array.from({ length: 6 }, (_, index) => String(index + 1));
        for (const hours of requests) {
          const result = await harness.behavior.runCli(["worktrees", "--all", "--hours", hours, "--json"], {});
          expect(result.exitCode).toBe(0);
        }
        const readsPerBuild = list.mock.calls.length / requests.length;
        expect(readsPerBuild).toBeGreaterThan(0);
        list.mockClear();
        emit("thread:changed", { id: PARENT.id, changes: ["title-changed"] });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(list).toHaveBeenCalledTimes(4 * readsPerBuild);
        expect(await bb.storage.kv.list("overview:v1:")).toHaveLength(4);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("serves the stored overview across a plugin reload without waiting for Git", async () => {
      const gate = deferred();
      let hold = false;
      let { harness, ready } = start({
        status: () => (hold ? gate.promise.then(() => statusOf(["new.ts"])) : statusOf(["old.ts"])),
      });
      await ready;
      try {
        const first = await harness.behavior.callRpc("overview", TREE);
        hold = true;
        ({ harness } = await harness.lifecycle.reload(server));
        const returned = vi.fn();
        const stored = harness.behavior.callRpc("overview", TREE).then((value) => {
          returned(value);
          return value;
        });
        try {
          await flush();
          expect(returned).toHaveBeenCalledExactlyOnceWith(first);
        } finally {
          gate.resolve();
          await stored;
        }
      } finally {
        await harness.lifecycle.dispose();
      }
    });

    it("keeps an oversized overview in memory without exceeding KV's byte cap", async () => {
      const { bb, harness, ready } = start({
        status: () => statusOf(Array.from({ length: 300 }, (_, i) => `folder/${i}-${"x".repeat(800)}`)),
      });
      await ready;
      try {
        const result = overviewSchema.parse(await harness.behavior.callRpc("overview", TREE));
        expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(256 * 1024);
        expect(await bb.storage.kv.list("overview:v1:")).toEqual([]);
        expect(await harness.behavior.callRpc("overview", TREE)).toEqual(result);
      } finally {
        await harness.lifecycle.dispose();
      }
    });

    it("uses incremental edits on hard Refresh and preserves other trees' root entries", async () => {
      const cursors: Array<string | undefined> = [];
      const { harness, ready } = start({
        tree: [PARENT, { ...CHILD, parentThreadId: null }],
        eventsList: ({ threadId, afterSeq }) => {
          if (threadId !== "thr_1") return [];
          cursors.push(afterSeq);
          return afterSeq === undefined ? [fileChangeRow(1, [{ path: "/work/one/a.ts", kind: "add" }])] : [];
        },
      });
      await ready;
      try {
        const other = { ...TREE, target: { kind: "tree", threadId: "thr_2" } };
        await harness.behavior.callRpc("overview", other);
        await harness.behavior.callRpc("overview", TREE);
        await harness.behavior.callRpc("overview", { ...TREE, refresh: true });
        const probes = () =>
          harness.experimental_hostRpcCalls.filter(
            (call) => call.method === "resolveRoots" && (call.input as { paths: string[] }).paths.includes("/work/two"),
          );
        expect(probes()).toHaveLength(1);
        expect(cursors).toEqual([undefined, "1"]);
        // Another scope forces a build; absence of a probe now checks the shared root cache, not the overview cache.
        await harness.behavior.callRpc("overview", { ...other, scope: "branch" });
        expect(probes()).toHaveLength(1);
      } finally {
        await harness.lifecycle.dispose();
      }
    });

    it("hard Refresh of all threads keeps stale cursors and reads at most four pages per thread", async () => {
      vi.useFakeTimers();
      const tree = Array.from({ length: 30 }, (_, index) => ({
        ...DONE,
        id: `thr_stale_${index}`,
        parentThreadId: null,
      }));
      const scan = vi.fn();
      let length = 300;
      const { harness, ready } = start({
        tree,
        eventsList: ({ afterSeq }) => {
          const cursor = Number(afterSeq ?? 0);
          scan(cursor);
          return Array.from({ length: Math.min(100, length - cursor) }, (_, i) => fileChangeRow(cursor + i + 1, []));
        },
      });
      const all = { ...TREE, target: { kind: "all" } };
      try {
        await ready;
        await harness.behavior.callRpc("overview", all);
        await vi.advanceTimersByTimeAsync(300_001);
        length = 900;
        scan.mockClear();
        await harness.behavior.callRpc("overview", { ...all, refresh: true });
        expect(scan).toHaveBeenCalledTimes(4 * tree.length);
        expect([...new Set(scan.mock.calls.map(([cursor]) => cursor))].sort()).toEqual([300, 400, 500, 600]);
        scan.mockClear();
        await harness.behavior.callRpc("overview", { ...all, refresh: true });
        expect([...new Set(scan.mock.calls.map(([cursor]) => cursor))].sort()).toEqual([700, 800, 900]);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("bounds both reads of a stale tree recheck and continues them even after five minutes", async () => {
      vi.useFakeTimers();
      const scan = vi.fn();
      let length = 850;
      const { harness, ready } = start({
        eventsList: ({ afterSeq }) => {
          const cursor = Number(afterSeq ?? 0);
          scan(cursor);
          return Array.from({ length: Math.min(100, length - cursor) }, (_, i) => fileChangeRow(cursor + i + 1, []));
        },
      });
      try {
        await ready;
        await harness.behavior.callRpc("overview", TREE);
        await vi.advanceTimersByTimeAsync(300_001);
        length = 1251;
        scan.mockClear();
        await harness.behavior.callRpc("overview", { ...TREE, refresh: true });
        expect(scan.mock.calls.flat()).toEqual([0, 100, 200, 300, 850, 950, 1050, 1150]);
        await vi.advanceTimersByTimeAsync(300_001);
        scan.mockClear();
        await harness.behavior.callRpc("overview", { ...TREE, refresh: true });
        expect(scan.mock.calls.flat()).toEqual([400, 500, 600, 700, 1250]);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("hard Refresh re-reads stale live event history but leaves recently read history incremental", async () => {
      vi.useFakeTimers();
      const cursors: Array<[string, string | undefined]> = [];
      const { harness, ready } = start({
        tree: [PARENT, CHILD],
        eventsList: ({ threadId, afterSeq }) => {
          cursors.push([threadId, afterSeq]);
          return afterSeq === undefined ? [fileChangeRow(1, [{ path: "a.ts", kind: "add" }])] : [];
        },
      });
      try {
        await ready;
        await harness.behavior.callRpc("overview", TREE);
        await vi.advanceTimersByTimeAsync(300_001);
        await harness.behavior.callRpc("overview", { ...TREE, target: { kind: "tree", threadId: CHILD.id } });
        cursors.length = 0;
        await harness.behavior.callRpc("overview", { ...TREE, refresh: true });
        expect(cursors).toContainEqual([PARENT.id, undefined]);
        expect(cursors).toContainEqual([CHILD.id, "1"]);
      } finally {
        await harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    });

    it("starts a new build for a request that comes after an invalidation, not joins the one that began before it", async () => {
      const { gates, options } = slowBuilds();
      const { harness, ready, emit } = start(options);
      await ready;
      const first = harness.behavior.callRpc("overview", TREE);
      await flush();
      expect(gates).toHaveLength(1);
      emit("thread:changed", unknownChange);
      const second = harness.behavior.callRpc("overview", TREE);
      await flush();
      expect(gates).toHaveLength(1);
      gates[0]!.resolve();
      await first;
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      gates[1]!.resolve();
      await second;
    });

    it("starts a new build after an environment's files changed", async () => {
      const { gates, options } = slowBuilds();
      const { harness, ready, emit } = start(options);
      await ready;
      const first = harness.behavior.callRpc("overview", TREE);
      await flush();
      emit("environment:changed", { id: "env_2", changes: ["git-refs-changed"] });
      const second = harness.behavior.callRpc("overview", TREE);
      await flush();
      expect(gates).toHaveLength(1);
      gates[0]!.resolve();
      await first;
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      gates[1]!.resolve();
      await second;
    });

    it("waits for a fresh hard Refresh rather than joining a normal build already in flight", async () => {
      let statusCalls = 0;
      const stale = deferred();
      const { harness, ready } = start({
        tree: [PARENT],
        status: () => {
          statusCalls++;
          return statusCalls === 1 ? stale.promise.then(() => statusOf(["stale.ts"])) : statusOf(["fresh.ts"]);
        },
      });
      await ready;
      const filesOf = (value: unknown) => overviewSchema.parse(value).repos[0]?.files.map((file) => file.path);
      const normal = harness.behavior.callRpc("overview", TREE);
      await flush();
      expect(statusCalls).toBe(1);
      const fresh = harness.behavior.callRpc("overview", { ...TREE, refresh: true });
      await flush();
      expect(statusCalls).toBe(1);
      stale.resolve();
      expect(filesOf(await normal)).toEqual(["stale.ts"]);
      expect(filesOf(await fresh)).toEqual(["fresh.ts"]);
      expect(filesOf(await harness.behavior.callRpc("overview", TREE))).toEqual(["fresh.ts"]);
    });

    it("lets the CLI join a browser tree build without starting a second one", async () => {
      const { gates, options } = slowBuilds();
      const { harness, ready } = start(options);
      await ready;
      const browser = harness.behavior.callRpc("overview", TREE);
      await flush();
      const cli = harness.behavior.runCli(["worktrees", "--thread", "thr_1", "--json"], {});
      try {
        await flush();
        expect(gates).toHaveLength(1);
      } finally {
        for (const gate of gates) gate.resolve();
        await browser;
      }
      expect((await cli).exitCode).toBe(0);
    });
  });

  it("does not hand a failed build to the next request", async () => {
    let fail = true;
    const { harness, ready } = start({
      tree: [PARENT, CHILD],
      onDescendants: () => {
        if (fail) {
          fail = false;
          throw new Error("down");
        }
      },
    });
    await ready;
    await expect(harness.behavior.callRpc("overview", TREE)).rejects.toThrow();
    expect(overviewSchema.parse(await harness.behavior.callRpc("overview", TREE)).threads).toHaveLength(2);
  });
});

describe("server: every thread", () => {
  const ALL = { target: { kind: "all" }, scope: "uncommitted", includeArchived: false };
  const EVENT_TREE = { ...ALL, target: { kind: "tree", threadId: PARENT.id } };
  const TWO = {
    tree: [PARENT, CHILD],
    status: (id: string) =>
      id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work"),
  };
  type Calls = { experimental_hostRpcCalls: ReadonlyArray<{ method: string }> };
  const diffs = (harness: Calls) =>
    harness.experimental_hostRpcCalls.filter((call) => call.method === "repoFiles").length;
  const statuses = (harness: Calls) =>
    harness.experimental_hostRpcCalls.filter((call) => call.method === "checkoutStatus").length;
  // The edit index also lists events, for both started and completed items; the file-event gate asks for completed ones only.
  const isGateRead = (args: { types?: readonly string[] }) => args.types?.length === 1;
  const threadEvent = (id: string, eventTypes?: string[]) => ({
    id,
    changes: ["events-appended"],
    ...(eventTypes === undefined ? {} : { metadata: { eventTypes } }),
  });

  it("declares the window and thread limit as bounded integer settings with defaults 24 and 200", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    expect(harness.registrations.settingsDescriptors).toMatchObject({
      windowHours: { type: "number", default: 24, label: "Time window for the full-screen page (hours)" },
      maxThreads: { type: "number", default: 200, label: "Most threads on the full-screen page" },
    });
    const outOfRange: Array<Record<string, number>> = [
      { windowHours: 0 },
      { windowHours: 721 },
      { windowHours: 1.5 },
      { maxThreads: 9 },
      { maxThreads: 501 },
    ];
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
    expect(parsed.threads.map((thread) => [thread.id, thread.rootThreadId])).toEqual([
      ["thr_1", "thr_1"],
      ["thr_2", "thr_1"],
    ]);
    expect(parsed.worktrees).toHaveLength(2);
  });

  it("logs one timing line per all-threads build, with page and host read counts and follow-up wait", async () => {
    let readingStatus!: () => void;
    const entered = new Promise<void>((resolve) => {
      readingStatus = resolve;
    });
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    let pages = 0;
    const { harness, ready } = start({
      ...TWO,
      eventsList: () => {
        pages++;
        return [];
      },
      hostResult: ({ method, input }) => {
        if (method !== "checkoutStatus" || (input as { root: string }).root !== "/work/one") return undefined;
        readingStatus();
        return stalled.then(() => statusOf(["README.md"]));
      },
    });
    try {
      await ready;
      const first = harness.behavior.callRpc("overview", ALL);
      await entered;
      const refresh = harness.behavior.callRpc("overview", { ...ALL, refresh: true });
      await Promise.resolve();
      await Promise.resolve();
      clock.mockReturnValue(100);
      release();
      await Promise.all([first, refresh]);
      await harness.behavior.callRpc("overview", ALL);
      await harness.behavior.callRpc("overview", EVENT_TREE);
      const timings = harness.logEntries.filter(
        ({ level, message }) => level === "debug" && message.startsWith("all overview timing "),
      );
      expect(timings).toHaveLength(2);
      const fields =
        /^all overview timing waitMs=(\d+) setupMs=\d+ threadListingMs=\d+ editIndexMs=\d+ editPages=(\d+) rootResolutionMs=\d+ rootDirectories=(\d+) rootHostCalls=(\d+) rootRevalidated=(\d+) hostReadsMs=\d+ hostReads=(\d+)$/;
      const initial = fields.exec(timings[0]!.message);
      const followUp = fields.exec(timings[1]!.message);
      expect(initial?.slice(1)).toEqual(["0", "2", "2", "1", "0", "2"]);
      expect(followUp?.slice(1)).toEqual(["100", "2", "2", "1", "2", "2"]);
      expect(pages).toBeGreaterThanOrEqual(4);
    } finally {
      release();
      clock.mockRestore();
      await harness.lifecycle.dispose();
    }
  });

  it("reads the window and limit from the settings on every build", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.setSettings({ windowHours: 6, maxThreads: 10 });
    expect(await harness.behavior.callRpc("overview", ALL)).toMatchObject({ windowHours: 6 });
  });

  it("answers a second all overview from the cache, without asking git for any status", async () => {
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
    await harness.behavior.callRpc("overview", EVENT_TREE);
    emit("thread:changed", threadEvent("thr_2", ["item/completed"]));
    await harness.behavior.callRpc("overview", EVENT_TREE);
    await vi.waitFor(() => expect(statuses(harness)).toBe(3));
  });

  it("ignores a thread event that carries only streaming deltas, and one for an unrelated thread", async () => {
    const { harness, ready, emit } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", EVENT_TREE);
    emit("thread:changed", threadEvent("thr_2", ["item/agentMessage/delta", "item/commandExecution/outputDelta"]));
    emit("thread:changed", threadEvent("thr_unrelated", ["item/completed"]));
    await harness.behavior.callRpc("overview", EVENT_TREE);
    expect(statuses(harness)).toBe(2);
  });

  describe("a thread event that cannot have changed files", () => {
    const rows: object[] = [];
    const list = (args: { afterSeq?: string; order?: string; limit?: string }) => {
      const after = Number(args.afterSeq ?? 0);
      const found = rows.filter((entry) => (entry as { seq: number }).seq > after);
      return (args.order === "desc" ? found.reverse() : found).slice(0, Number(args.limit ?? 100));
    };
    const withRows = () => start({ ...TWO, eventsList: list });
    const agentMessage = (seq: number) => row(seq, { type: "agentMessage", id: `m${seq}`, text: "Done" });
    const edit = (seq: number) => fileChangeRow(seq, []);
    const command = (seq: number) =>
      row(seq, { type: "commandExecution", id: `c${seq}`, command: "touch a", cwd: "/work/two" });
    beforeEach(() => {
      rows.length = 0;
    });

    // The first completed item of a thread has nothing to compare with, so it counts as a change.
    async function warmed() {
      const { harness, ready, emit } = withRows();
      await ready;
      rows.push(agentMessage(1));
      await harness.behavior.callRpc("overview", EVENT_TREE);
      emit("thread:changed", threadEvent("thr_2", ["item/completed"]));
      await harness.behavior.callRpc("overview", EVENT_TREE);
      await vi.waitFor(() => expect(statuses(harness)).toBe(3));
      return { harness, emit };
    }

    it("keeps the cache when a thread only completed an agent message", async () => {
      const { harness, emit } = await warmed();
      rows.push(agentMessage(2), row(3, { type: "reasoning", id: "r3", text: "Thinking" }));
      emit("thread:changed", threadEvent("thr_2", ["item/started", "item/completed", "thread/tokenUsage/updated"]));
      await harness.behavior.callRpc("overview", EVENT_TREE);
      expect(statuses(harness)).toBe(3);
    });

    it.each([
      ["a file change", edit],
      ["a command", command],
    ])("drops the thread's cache when it completed %s", async (_name, make) => {
      const { harness, emit } = await warmed();
      rows.push(agentMessage(2), make(3));
      emit("thread:changed", threadEvent("thr_2", ["item/completed"]));
      await harness.behavior.callRpc("overview", EVENT_TREE);
      await vi.waitFor(() => expect(statuses(harness)).toBe(4));
    });

    it("looks only at items completed since the last event", async () => {
      const { harness, emit } = await warmed();
      rows.push(edit(2));
      emit("thread:changed", threadEvent("thr_2", ["item/completed"]));
      await harness.behavior.callRpc("overview", EVENT_TREE);
      await vi.waitFor(() => expect(statuses(harness)).toBe(4));
      rows.push(agentMessage(3));
      emit("thread:changed", threadEvent("thr_2", ["item/completed"]));
      await harness.behavior.callRpc("overview", EVENT_TREE);
      expect(statuses(harness)).toBe(4);
    });

    it.each([
      ["turn/completed"],
      ["turn/diff/updated"],
      ["item/backgroundTask/completed"],
      ["a type bb has not shipped yet"],
    ])("drops the cache for %s without reading any item", async (type) => {
      const { harness, emit } = await warmed();
      emit("thread:changed", threadEvent("thr_2", [type]));
      await harness.behavior.callRpc("overview", EVENT_TREE);
      await vi.waitFor(() => expect(statuses(harness)).toBe(4));
    });

    it("drops the cache after history was rewritten or compacted, whatever the event types say", async () => {
      const { harness, emit } = await warmed();
      emit("thread:changed", {
        id: "thr_2",
        changes: ["history-compacted"],
        metadata: { eventTypes: ["thread/tokenUsage/updated"] },
      });
      await harness.behavior.callRpc("overview", EVENT_TREE);
      await vi.waitFor(() => expect(statuses(harness)).toBe(4));
      emit("thread:changed", { id: "thr_2", changes: ["history-rewritten"] });
      await harness.behavior.callRpc("overview", EVENT_TREE);
      await vi.waitFor(() => expect(statuses(harness)).toBe(5));
    });

    it("drops the cache when the items cannot be read", async () => {
      const { harness, ready, emit } = start({
        ...TWO,
        eventsList: () => {
          throw new Error("no events");
        },
      });
      await ready;
      await harness.behavior.callRpc("overview", EVENT_TREE);
      emit("thread:changed", threadEvent("thr_2", ["item/completed"]));
      emit("thread:changed", threadEvent("thr_2", ["item/completed"]));
      await harness.behavior.callRpc("overview", EVENT_TREE);
      await vi.waitFor(() => expect(statuses(harness)).toBe(3));
      emit("thread:changed", threadEvent("thr_2", ["item/completed"]));
      await harness.behavior.callRpc("overview", EVENT_TREE);
      await vi.waitFor(() => expect(statuses(harness)).toBe(4));
    });
  });

  it("reads no events for a thread nothing is cached for", async () => {
    const reads: string[] = [];
    const { harness, ready, emit } = start({
      ...TWO,
      eventsList: (args) => {
        if (isGateRead(args)) reads.push(args.threadId);
        return [];
      },
    });
    await ready;
    for (const id of ["thr_1", "thr_2", "thr_unrelated"]) emit("thread:changed", threadEvent(id, ["item/completed"]));
    await harness.behavior.callRpc("overview", EVENT_TREE);
    expect(reads).toEqual([]);
    expect(statuses(harness)).toBe(2);
  });

  it("answers a stale overview and delays only the Git read affected by an undecided file event", async () => {
    let release!: (rows: object[]) => void;
    let hold = false;
    const { harness, ready, emit } = start({
      ...TWO,
      eventsList: (args) =>
        hold && isGateRead(args)
          ? (new Promise<object[]>((resolve) => {
              release = resolve;
            }) as never)
          : [],
    });
    await ready;
    await harness.behavior.callRpc("overview", EVENT_TREE);
    hold = true;
    emit("thread:changed", threadEvent("thr_2", ["item/completed"]));
    let answered = false;
    const overview = harness.behavior.callRpc("overview", EVENT_TREE).then((value) => {
      answered = true;
      return value;
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 175));
      expect(answered).toBe(true);
      expect(statuses(harness)).toBe(2);
    } finally {
      release([]);
      await overview;
    }
    await vi.waitFor(() => expect(statuses(harness)).toBe(3));
  });

  it("treats a thread event with no event types as a change", async () => {
    const { harness, ready, emit } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", EVENT_TREE);
    emit("thread:changed", threadEvent("thr_1"));
    await harness.behavior.callRpc("overview", EVENT_TREE);
    await vi.waitFor(() => expect(statuses(harness)).toBe(3));
  });

  it("reads an environment again when bb reports its work status, refs or status changed", async () => {
    for (const change of ["work-status-changed", "git-refs-changed", "status-changed"]) {
      const { harness, ready, emit } = start(TWO);
      await ready;
      await harness.behavior.callRpc("overview", EVENT_TREE);
      emit("environment:changed", { id: "env_2", changes: [change] });
      await harness.behavior.callRpc("overview", EVENT_TREE);
      await vi.waitFor(() => expect(statuses(harness), change).toBe(3));
    }
  });

  it("ignores an environment change that touches no files", async () => {
    const { harness, ready, emit } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", EVENT_TREE);
    emit("environment:changed", { id: "env_2", changes: ["renamed"] });
    await harness.behavior.callRpc("overview", EVENT_TREE);
    expect(statuses(harness)).toBe(2);
  });

  it("clears the cache on a refresh", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", ALL);
    await harness.behavior.callRpc("overview", { ...ALL, refresh: true });
    expect(statuses(harness)).toBe(4);
  });

  it("shares one build between concurrent all overviews, and serves it on a fresh cache hit", async () => {
    let lists = 0;
    const { harness, ready } = start({
      ...TWO,
      onList: () => {
        lists++;
      },
    });
    await ready;
    const results = await Promise.all([
      harness.behavior.callRpc("overview", ALL),
      harness.behavior.callRpc("overview", ALL),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(lists).toBe(2);
    expect(await harness.behavior.callRpc("overview", ALL)).toEqual(results[0]);
    expect(lists).toBe(2);
  });

  it("clears the cache and tells open pages when a setting changes", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.callRpc("overview", ALL);
    expect(harness.inspection.realtimeSignals).toEqual([]);
    await harness.behavior.setSettings({ windowHours: 12 });
    expect(harness.inspection.realtimeSignals).toEqual([{ channel: "vantage:settings", payload: {} }]);
    await harness.behavior.callRpc("overview", ALL);
    await vi.waitFor(() => expect(statuses(harness)).toBe(4));
  });

  it("declares toasts as off, no navigation badge and no per-thread choices", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    expect(harness.registrations.settingsDescriptors).toMatchObject({
      toasts: { type: "boolean", default: false, label: "Show a toast when a thread needs you" },
    });
    expect(harness.registrations.settingsDescriptors).not.toHaveProperty("badge");
    expect(harness.registrations.settingsDescriptors).not.toHaveProperty("watchByDefault");
    expect(harness.registrations.settingsDescriptors).not.toHaveProperty("reviewsByDefault");
  });

  it("changes nothing on the server when an alert setting changes", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.setSettings({ toasts: true });
    expect(harness.inspection.experimental_rpcInvalidations).toEqual([]);
    expect(harness.inspection.realtimeSignals).toEqual([]);
  });

  it("keeps the reviewed marks of each worktree apart and drops a mark set to null", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.callRpc("setReviewed", {
      key: "host_1:/work/one",
      marks: [{ mark: "uncommitted\0src/a.ts", signature: "modified:1:0:" }],
    });
    await harness.behavior.callRpc("setReviewed", {
      key: "host_1:/work/two",
      marks: [{ mark: "committed\0b.ts", signature: "added:3:0:" }],
    });
    expect(
      await harness.behavior.callRpc("reviewed", { keys: ["host_1:/work/one", "host_1:/work/two", "host_1:/none"] }),
    ).toEqual({
      "host_1:/work/one": { "uncommitted\0src/a.ts": "modified:1:0:" },
      "host_1:/work/two": { "committed\0b.ts": "added:3:0:" },
      "host_1:/none": {},
    });
    await harness.behavior.callRpc("setReviewed", {
      key: "host_1:/work/one",
      marks: [{ mark: "uncommitted\0src/a.ts", signature: null }],
    });
    expect(await harness.behavior.callRpc("reviewed", { keys: ["host_1:/work/one"] })).toEqual({
      "host_1:/work/one": {},
    });
  });

  it("tells the open windows a worktree's reviewed marks changed after saving them", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.callRpc("setReviewed", {
      key: "host_1:/work/one",
      marks: [{ mark: "uncommitted\0src/a.ts", signature: "modified:1:0:" }],
    });
    expect(JSON.stringify(harness.inspection.experimental_rpcInvalidations)).toContain(
      "vantage:reviewed:host_1:/work/one",
    );
  });

  it("reads a worktree the user asked to see whole with nothing picked, and tells open pages", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const tree = {
      target: { kind: "tree", threadId: "thr_1" },
      scope: "uncommitted",
      includeArchived: true,
      refresh: true,
    };
    const picks = () =>
      harness.experimental_hostRpcCalls
        .filter((call) => call.method === "checkoutStatus")
        .map((call) => [(call.input as { root: string }).root, (call.input as { pick: boolean }).pick]);
    expect(await harness.behavior.callRpc("setWhole", { key: "host_1:/work/two", whole: true })).toEqual({ ok: true });
    expect(harness.inspection.realtimeSignals).toEqual([{ channel: "vantage:settings", payload: {} }]);
    const whole = overviewSchema.parse(await harness.behavior.callRpc("overview", tree));
    expect(picks()).toEqual([
      ["/work/one", true],
      ["/work/two", false],
    ]);
    expect(whole.worktrees.map((entry) => entry.whole)).toEqual([undefined, true]);
    await harness.behavior.callRpc("setWhole", { key: "host_1:/work/two", whole: false });
    await harness.behavior.callRpc("overview", tree);
    expect(picks().slice(2)).toEqual([
      ["/work/one", true],
      ["/work/two", true],
    ]);
  });

  it("answers the next normal overview fresh after setWhole and settings changes", async () => {
    const { harness, ready } = start(TWO);
    const input = { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true };
    const key = "host_1:/work/two";
    const read = async () => overviewSchema.parse(await harness.behavior.callRpc("overview", input));
    try {
      await ready;
      expect((await read()).worktrees.find((row) => row.key === key)?.whole).toBeUndefined();
      await harness.behavior.callRpc("setWhole", { key, whole: true });
      expect((await read()).worktrees.find((row) => row.key === key)?.whole).toBe(true);
      await harness.behavior.setSettings({ folderLimit: 40 });
      await read();
      expect(harness.experimental_hostRpcCalls.filter((call) => call.method === "checkoutStatus").slice(-2)).toEqual([
        expect.objectContaining({ input: expect.objectContaining({ folderLimit: 40 }) }),
        expect.objectContaining({ input: expect.objectContaining({ folderLimit: 40 }) }),
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("does not serve an evicted all-threads overview from before the settings changed", async () => {
    const { harness, ready } = start(TWO);
    try {
      await ready;
      const readHours = async (hours: string) => {
        const result = await harness.behavior.runCli(["worktrees", "--all", "--hours", hours, "--json"], {});
        expect(result.exitCode).toBe(0);
      };
      await readHours("1");
      await harness.behavior.callRpc("overview", ALL);
      for (const hours of ["2", "3", "1", "4"]) await readHours(hours);
      await harness.behavior.setSettings({ windowHours: 48 });
      const next = overviewSchema.parse(await harness.behavior.callRpc("overview", ALL));
      expect(next.windowHours).toBe(48);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("reads every worktree as it is when the closest base setting is off", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    await harness.behavior.setSettings({ closestBase: false, folderLimit: 40 });
    await harness.behavior.callRpc("overview", {
      target: { kind: "tree", threadId: "thr_1" },
      scope: "uncommitted",
      includeArchived: true,
    });
    expect(
      harness.experimental_hostRpcCalls.filter((call) => call.method === "checkoutStatus").map((call) => call.input),
    ).toEqual([
      { root: "/work/one", base: "origin/main", pick: false, folderLimit: 40 },
      { root: "/work/two", base: "origin/main", pick: false, folderLimit: 40 },
    ]);
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
  const TWO = {
    tree: [PARENT, CHILD],
    status: (id: string) =>
      id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work"),
  };
  const WITH_ARCHIVED = { ...TWO, archived: [DONE] };
  const ALL = (includeArchived: boolean) => ({ target: { kind: "all" }, scope: "uncommitted", includeArchived });
  const TREE = (includeArchived: boolean) => ({
    target: { kind: "tree", threadId: "thr_1" },
    scope: "uncommitted",
    includeArchived,
  });
  const ids = (overview: { threads: Array<{ id: string }> }) => overview.threads.map((thread) => thread.id);

  it("answers shell with a partial overview of loading rows, without asking the host for any git state", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const parsed = overviewSchema.parse(
      await harness.behavior.callRpc("shell", { target: { kind: "all" }, includeArchived: false }),
    );
    expect(parsed).toMatchObject({
      partial: true,
      archivedHidden: 0,
      sharedFiles: [],
      target: { kind: "all" },
      windowHours: 24,
    });
    expect(parsed.worktrees.map((entry) => [entry.threadIds, entry.state, entry.branch])).toEqual([
      [["thr_1"], "loading", "feature/work"],
      [["thr_2"], "loading", "child-work"],
    ]);
    expect(harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(0);
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("answers shell for a thread's tree", async () => {
    const { harness, ready } = start(WITH_ARCHIVED);
    await ready;
    const parsed = overviewSchema.parse(
      await harness.behavior.callRpc("shell", { target: { kind: "tree", threadId: "thr_1" }, includeArchived: false }),
    );
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
    expect(ids(overviewSchema.parse(await harness.behavior.callRpc("overview", TREE(false))))).toEqual([
      "thr_1",
      "thr_2",
    ]);
    expect(ids(overviewSchema.parse(await harness.behavior.callRpc("overview", TREE(true))))).toEqual([
      "thr_1",
      "thr_2",
      "thr_3",
    ]);
  });

  it("does not share a build between overviews that differ in whether they include archived threads", async () => {
    let lists = 0;
    const { harness, ready } = start({
      ...WITH_ARCHIVED,
      onList: () => {
        lists++;
      },
    });
    await ready;
    await Promise.all([
      harness.behavior.callRpc("overview", ALL(false)),
      harness.behavior.callRpc("overview", ALL(true)),
    ]);
    expect(lists).toBe(4);
  });
});

describe("bb vantage --archived", () => {
  const WITH_ARCHIVED = {
    tree: [PARENT, CHILD],
    archived: [DONE],
    status: (id: string) =>
      id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work"),
  };

  it("hides archived threads with --all and says how many", async () => {
    const { harness, ready } = start(WITH_ARCHIVED);
    await ready;
    const json = JSON.parse((await harness.behavior.runCli(["worktrees", "--all", "--json"], {})).stdout ?? "") as {
      threads: Array<{ id: string }>;
      archivedHidden: number;
    };
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
    const json = JSON.parse(
      (await harness.behavior.runCli(["worktrees", "--thread", "thr_1", "--json"], {})).stdout ?? "",
    ) as { threads: Array<{ id: string }> };
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
    expect(formatWorktrees(overview({ archivedHidden: 3, worktrees: [worktree()] }))).toContain(
      "3 archived threads hidden (use --archived)",
    );
    expect(formatWorktrees(overview({ worktrees: [worktree()] }))).not.toContain("hidden");
    expect(formatWorktrees(overview({ archivedHidden: 2 }))).toContain("2 archived threads hidden (use --archived)");
    expect(formatOverview(overview({ archivedHidden: 1 }))).toContain("1 archived thread hidden (use --archived)");
    expect(formatOverview(overview())).not.toContain("hidden");
  });
});

describe("server worktrees", () => {
  const TWO = {
    tree: [PARENT, CHILD],
    status: (id: string) =>
      id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work"),
  };
  const SHA = "abc1234def";
  const WORKSPACE = {
    kind: "workspace",
    environmentId: "env_1",
    base: "origin/main",
    root: "/work/one",
    hostId: "host_1",
  };
  const BRANCH = { kind: "branch", hostId: "host_1", root: "/code/proj", base: "origin/main", head: "feature/old" };
  const CHECKOUT = { kind: "checkout", hostId: "host_1", root: "/code/commons", base: null };
  const patch = (ref: object, extra: object) => ({
    ref,
    path: "src/a.ts",
    previousPath: null,
    untracked: false,
    scope: "uncommitted",
    ...extra,
  });

  it("answers overview with the worktrees and the files they share", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const parsed = overviewSchema.parse(
      await harness.behavior.callRpc("overview", {
        target: { kind: "tree", threadId: "thr_1" },
        scope: "uncommitted",
        includeArchived: true,
      }),
    );
    expect(parsed.worktrees.map((entry) => [entry.threadIds, entry.branch, entry.aheadCount])).toEqual([
      [["thr_1"], "feature/work", 0],
      [["thr_2"], "child-work", 1],
    ]);
    expect(parsed.sharedFiles).toEqual([
      { projectId: "proj_1", path: "README.md", worktreeKeys: ["host_1:/work/one", "host_1:/work/two"] },
    ]);
    expect(parsed.threads.map((thread) => thread.status)).toEqual(["idle", "active"]);
  });

  it("answers commitFiles for a workspace, a branch and a checkout through the host", async () => {
    const { harness, ready } = start({
      hostResult: (call) =>
        call.method === "repoFiles"
          ? {
              outcome: "available",
              branch: null,
              base: null,
              aheadCount: null,
              behindCount: null,
              commits: [],
              truncated: false,
              files: [
                { path: "lib.ts", previousPath: null, status: "added", additions: 1, deletions: 0, binary: false },
              ],
            }
          : undefined,
    });
    await ready;
    const viaWorkspace = await harness.behavior.callRpc("commitFiles", { ref: WORKSPACE, sha: SHA });
    expect(viaWorkspace).toMatchObject({ files: [{ path: "lib.ts", status: "added" }] });
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "repoFiles",
      hostId: "host_1",
      input: { root: "/work/one", target: { type: "commit", sha: SHA } },
    });
    const viaHost = await harness.behavior.callRpc("commitFiles", { ref: BRANCH, sha: SHA });
    expect(viaHost).toMatchObject({ files: [{ path: "lib.ts", status: "added" }] });
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "repoFiles",
      hostId: "host_1",
      input: { root: "/code/proj", target: { type: "commit", sha: SHA } },
    });
    await harness.behavior.callRpc("commitFiles", { ref: CHECKOUT, sha: SHA });
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "repoFiles",
      input: { root: "/code/commons", target: { type: "commit", sha: SHA } },
    });
    await expect(harness.behavior.callRpc("commitFiles", { ref: WORKSPACE, sha: "zz" })).rejects.toThrow();
  });

  it("answers patch for a commit and for committed changes, for workspace and branch refs", async () => {
    const { harness, ready } = start({
      hostResult: (call) =>
        call.method === "repoPatch"
          ? { outcome: "available", patch: "+host", truncated: false, binary: false }
          : undefined,
    });
    await ready;
    await harness.behavior.callRpc("patch", patch(WORKSPACE, { scope: "committed" }));
    await harness.behavior.callRpc("patch", patch(WORKSPACE, { scope: "committed", sha: SHA }));
    await harness.behavior.callRpc("patch", patch(BRANCH, { scope: "committed" }));
    await harness.behavior.callRpc("patch", patch(BRANCH, { scope: "committed", sha: SHA }));
    expect(
      harness.experimental_hostRpcCalls
        .filter((call) => call.method === "repoPatch")
        .map((call) => [(call.input as { root: string }).root, (call.input as { target: unknown }).target]),
    ).toEqual([
      ["/work/one", { type: "committed", base: "origin/main" }],
      ["/work/one", { type: "commit", sha: SHA }],
      ["/code/proj", { type: "range", base: "origin/main", head: "feature/old" }],
      ["/code/proj", { type: "commit", sha: SHA }],
    ]);
  });

  it("answers a committed or per-commit patch for a checkout through the host", async () => {
    const { harness, ready } = start({
      hostResult: (call) =>
        call.method === "repoPatch"
          ? { outcome: "available", patch: "+host", truncated: false, binary: false }
          : undefined,
    });
    await ready;
    await harness.behavior.callRpc("patch", patch(CHECKOUT, { scope: "committed" }));
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "repoPatch",
      input: { root: "/code/commons", target: { type: "committed", base: null } },
    });
    await harness.behavior.callRpc("patch", patch(CHECKOUT, { sha: SHA }));
    expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({
      method: "repoPatch",
      input: { target: { type: "commit", sha: SHA } },
    });
  });
});

describe("bb vantage worktrees", () => {
  const TWO = {
    tree: [PARENT, CHILD],
    status: (id: string) =>
      id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work"),
  };

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
    const printed = JSON.parse(result.stdout ?? "") as {
      threadId: string;
      worktrees: Array<{ key: string; threadIds: string[]; branch: string; state: string }>;
      sharedFiles: unknown[];
      threads: unknown[];
    };
    expect(printed.threadId).toBe("thr_1");
    expect(printed.worktrees.map((entry) => [entry.key, entry.threadIds, entry.branch, entry.state])).toEqual([
      ["host_1:/work/one", ["thr_1"], "feature/work", "ready"],
      ["host_1:/work/two", ["thr_2"], "child-work", "ready"],
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
  const TWO = {
    tree: TREE,
    status: (id: string) =>
      id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work"),
  };

  it("finds the thread's tree root, then prints the worktree that thread is in", async () => {
    const { harness, ready } = start(TWO);
    await ready;
    const result = await harness.behavior.runCli(["worktree", "thr_2"], {});
    expect(result.exitCode).toBe(0);
    expect(harness.inspection.sdk.callsTo("threads.experimental_listAncestors")[0]?.[0]).toMatchObject({
      threadIds: ["thr_2"],
    });
    expect(harness.inspection.sdk.callsTo("threads.experimental_listDescendants")[0]?.[0]).toMatchObject({
      threadIds: ["thr_1"],
    });
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
      key: "host_1:/work/two",
      threadIds: ["thr_2"],
      state: "ready",
      branch: "child-work",
      aheadCount: 1,
      behindCount: 0,
      uncommitted: [{ path: "b.ts" }],
      committed: [{ path: "README.md" }],
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
  const rows = () =>
    formatWorktrees(
      overview({
        threads: titles,
        worktrees: [
          worktree({ threadIds: ["thr_1"], aheadCount: 0, behindCount: 0 }),
          worktree({
            key: "w2",
            threadIds: ["thr_2"],
            branch: "agent/two",
            aheadCount: 3,
            behindCount: 1,
            uncommitted: [fileChange(), fileChange({ path: "b.ts" })],
          }),
          branchWorktree({ threadIds: ["thr_3"], aheadCount: 1 }),
          worktree({
            key: "w4",
            threadIds: ["thr_4"],
            state: "unavailable",
            message: "Folder is gone",
            branch: null,
            aheadCount: null,
            behindCount: null,
          }),
        ],
        sharedFiles: [sharedFile({ worktreeKeys: ["host_1:/work/one", "w2"] })],
      }),
    ).split("\n");

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
    const lines = formatWorktrees(
      overview({
        threads: [threadSummary({ id: "thr_1", title: "Parser" }), threadSummary({ id: "thr_2", title: "Docs" })],
        worktrees: [
          worktree({
            branch: "main",
            base: "main",
            onBase: true,
            threadCommits: [commit(), commit({ sha: "b".repeat(40) })],
          }),
          worktree({ key: "w2", threadIds: ["thr_2"], branch: "main", base: "main", onBase: true }),
        ],
      }),
    ).split("\n");
    expect(lines[1]).toMatch(/^idle\s+Parser\s+on base\s+clean\s+main · 2 commits by its threads$/);
    expect(lines[2]).toMatch(/^idle\s+Docs\s+on base\s+clean\s+main$/);
  });
});

describe("formatWorktree", () => {
  const many = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => fileChange({ path: `${prefix}${String(index).padStart(3, "0")}.ts` }));
  const base = (wt: ReturnType<typeof worktree>) =>
    overview({ threads: [threadSummary({ id: "thr_1", title: "Parent" })], worktrees: [wt] });

  it("describes the worktree, its files and its commits", () => {
    const text = formatWorktree(
      base(
        worktree({
          aheadCount: 1,
          behindCount: 2,
          uncommitted: [fileChange({ path: "u.ts", additions: 3, deletions: 1 })],
          committed: [fileChange({ path: "c.ts", status: "added", additions: 5, deletions: 0 })],
          commits: [commit({ shortSha: "abc1234", subject: "Fix the thing", authorName: "Ada" })],
        }),
      ),
      "thr_1",
    );
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
    const text = formatWorktree(
      base(
        worktree({
          uncommitted: many(60, "u"),
          committed: many(55, "c"),
          commits: Array.from({ length: 25 }, (_, index) =>
            commit({ shortSha: `c${index}`.padEnd(7, "0"), subject: `Commit ${index}` }),
          ),
        }),
      ),
      "thr_1",
    );
    expect(text).toContain("u049.ts");
    expect(text).not.toContain("u050.ts");
    expect(text).toContain("… 10 more");
    expect(text).toContain("… 5 more");
    expect(text).toContain("Commit 19");
    expect(text).not.toContain("Commit 20");
  });

  it("prints every worktree of a thread that also works in a checkout outside bb", () => {
    const text = formatWorktree(
      overview({
        threads: [threadSummary({ id: "thr_1", title: "Parent" })],
        worktrees: [
          worktree(),
          checkoutWorktree({ threadIds: ["thr_1"], committed: [fileChange({ path: "lib.rs" })] }),
        ],
      }),
      "thr_1",
    );
    expect(text).toContain("path: /work/one");
    expect(text).toContain("Parent · side-work");
    expect(text).toContain("path: /clones/side");
    expect(text).toContain("Committed on this branch (1 file)");
  });

  it("lists the commits its threads made on the base branch it works on", () => {
    const text = formatWorktree(
      base(
        worktree({
          branch: "main",
          base: "main",
          onBase: true,
          threadCommits: [
            commit({ shortSha: "1a2b3c4", subject: "Add the parser", authorName: "Ada" }),
            commit({ shortSha: "5d6e7f8", subject: "Fix the tests" }),
          ],
        }),
      ),
      "thr_1",
    );
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
    expect(text).toContain(
      "Works on main, its base branch, so nothing counts as ahead; no commits its threads made were found.",
    );
  });

  it("lists the commits its threads made that are already on the base branch", () => {
    const text = formatWorktree(
      base(worktree({ threadCommits: [commit({ shortSha: "abc1234", subject: "Merged work" })] })),
      "thr_1",
    );
    expect(text).toContain("Commits its threads made, already on origin/main (1)");
    expect(text).toContain("abc1234  Merged work");
  });

  it("explains an unavailable worktree and labels a kept branch", () => {
    expect(formatWorktree(base(worktree({ state: "unavailable", message: "Folder is gone" })), "thr_1")).toContain(
      "Unavailable: Folder is gone",
    );
    const kept = formatWorktree(
      base(branchWorktree({ threadIds: ["thr_1"], committed: [fileChange({ path: "kept.ts" })] })),
      "thr_1",
    );
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
    expect(printed).toMatchObject({
      target: { kind: "tree", threadId: "thr_1" },
      scope: "uncommitted",
      partial: false,
      archivedHidden: 0,
    });
    expect(printed.repos[0]?.files.map((file) => file.path)).toEqual(["src/a.ts"]);
  });

  it("reads another thread and the branch scope when asked", async () => {
    const { harness, ready } = start();
    await ready;
    const result = await harness.behavior.runCli(["changes", "--thread", "thr_1", "--scope", "branch", "--json"], {});
    expect(JSON.parse(result.stdout)).toMatchObject({ threadId: "thr_1", scope: "branch" });
    expect(harness.experimental_hostRpcCalls.find((call) => call.method === "repoFiles")).toMatchObject({
      hostId: "host_1",
      input: { root: "/work/one", target: { type: "merge-base", base: "origin/main" } },
    });
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
    const made = Array.from({ length: 7 }, (_, index) =>
      commit({ shortSha: `c${index}`.padEnd(7, "0"), subject: `Commit ${index}` }),
    );
    const text = formatOverview(
      overview({
        threads: [threadSummary({ id: "thr_1", title: "Parser" })],
        repos: [
          repo({
            branch: "main",
            threadIds: ["thr_1"],
            threadCommits: made,
            files: [fileChange({ path: "README.md", status: "clean", additions: null, deletions: null })],
          }),
        ],
      }),
    );
    expect(text).toContain("  7 commits by its threads on main");
    expect(text).toContain("    c000000  Commit 0");
    expect(text).toContain("    c400000  Commit 4");
    expect(text).not.toContain("Commit 5");
    expect(text).toContain("    … 2 more (bb vantage worktree <thread>)");
    expect(text.indexOf("commits by its threads")).toBeLessThan(text.indexOf("README.md"));
  });

  it("prints no commit line for a repository its threads made no commits in", () => {
    expect(formatOverview(overview({ repos: [repo({ threadIds: ["thr_1"] })] }))).not.toContain(
      "commits by its threads",
    );
  });
});

describe("formatOverview", () => {
  it("describes every kind of repository, the threads that touched it and the folded changes", () => {
    const text = formatOverview(
      overview({
        scope: "branch",
        threads: [
          threadSummary({ id: "thr_1", title: "Parent" }),
          threadSummary({ id: "thr_2", title: "Old child", archived: true, depth: 1 }),
        ],
        repos: [
          repo({
            label: "Project",
            branch: "feature/work",
            threadIds: ["thr_1"],
            files: [
              fileChange({ path: "src/a.ts", additions: 2, deletions: 1 }),
              fileChange({
                path: "docs/x.md",
                previousPath: "docs/y.md",
                status: "renamed",
                additions: 0,
                deletions: 0,
              }),
              fileChange({ path: "pic.png", status: "added", additions: null, deletions: null, binary: true }),
              fileChange({ path: "kept.ts", status: "clean", additions: null, deletions: null }),
            ],
          }),
          checkoutRepo({
            threadIds: ["thr_1"],
            files: [fileChange({ path: "a.md", status: "untracked", additions: 3, deletions: 0 })],
            otherFiles: [fileChange(), fileChange({ path: "b.ts" })],
          }),
          branchRepo({ threadIds: ["thr_2"], files: [fileChange({ path: "lib.ts" })] }),
          recordedRepo({
            threadIds: ["thr_2"],
            files: [fileChange({ path: "gone.ts", status: "deleted", additions: 0, deletions: 4 })],
          }),
          repo({
            label: "Offline repo",
            state: "unavailable",
            message: "Dev box is not connected",
            hostId: "host_2",
            hostName: "Dev box",
            threadIds: ["thr_1"],
          }),
        ],
        otherFiles: [fileChange({ path: "/tmp/notes.txt", status: "added", additions: 2, deletions: 0 })],
        warnings: ["Could not reach Dev box: offline"],
      }),
    );
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
  // Long enough that 500 files go past the CLI's output limit, whatever the SDK sets it to.
  const LONG_DIR = "d/".repeat(Math.ceil(PLUGIN_CLI_OUTPUT_MAX_BYTES / 500 / 2));
  const huge = (): Overview =>
    overview({
      repos: [
        repo({
          files: Array.from({ length: 500 }, (_, index) => fileChange({ path: `${LONG_DIR}file-${index}.ts` })),
        }),
      ],
    });

  it("trims the files of a JSON overview that would not fit and says it was cut", async () => {
    const cli = createCli(
      async () => huge(),
      async (id) => id,
    );
    const result = await cli.run(["changes", "--json"], { threadId: "thr_1" });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout ?? "")).toBeLessThan(PLUGIN_CLI_OUTPUT_MAX_BYTES);
    const printed = JSON.parse(result.stdout ?? "") as Overview;
    expect(printed.repos[0]?.truncated).toBe(true);
    expect(printed.repos[0]?.files.length).toBeLessThan(500);
    expect(printed.repos[0]?.totals.files).toBe(500);
  });

  it("trims the files and commits of a worktrees JSON that would not fit", async () => {
    const files = Array.from({ length: 500 }, (_, index) => fileChange({ path: `${LONG_DIR}file-${index}.ts` }));
    const big = overview({
      worktrees: [
        worktree({ uncommitted: files, committed: files, commits: Array.from({ length: 100 }, () => commit()) }),
      ],
    });
    const cli = createCli(
      async () => big,
      async (id) => id,
    );
    for (const argv of [
      ["worktrees", "--json"],
      ["worktree", "thr_1", "--json"],
    ]) {
      const result = await cli.run(argv, { threadId: "thr_1" });
      expect(result.exitCode).toBe(0);
      expect(Buffer.byteLength(result.stdout ?? "")).toBeLessThan(PLUGIN_CLI_OUTPUT_MAX_BYTES);
    }
    const printed = JSON.parse((await cli.run(["worktree", "thr_1", "--json"], {})).stdout ?? "") as {
      uncommitted: unknown[];
    };
    expect(printed.uncommitted.length).toBeLessThan(500);
  });

  it("keeps the full JSON overview when it fits", async () => {
    const small = overview({ repos: [repo({ files: [fileChange()] })] });
    const result = await createCli(
      async () => small,
      async (id) => id,
    ).run(["changes", "--json"], { threadId: "thr_1" });
    expect(JSON.parse(result.stdout ?? "")).toEqual(small);
  });

  it("keeps the text output under the limit", async () => {
    const many = overview({
      repos: Array.from({ length: 3000 }, (_, index) =>
        repo({ key: `k${index}`, label: `repo-${index}`, files: [fileChange()] }),
      ),
    });
    const result = await createCli(
      async () => many,
      async (id) => id,
    ).run(["changes"], { threadId: "thr_1" });
    expect(Buffer.byteLength(result.stdout ?? "")).toBeLessThan(PLUGIN_CLI_OUTPUT_MAX_BYTES);
  });
});

describe("bb vantage --all", () => {
  const TWO = {
    tree: [PARENT, CHILD],
    status: (id: string) =>
      id === "env_1" ? statusOf(["README.md"]) : statusOf(["b.ts"], ["README.md"], "child-work"),
  };

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
    const result = await harness.behavior.runCli(["worktrees", "--all", "--hours", "6", "--json"], {
      threadId: "thr_1",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({
      target: { kind: "all" },
      windowHours: 6,
      worktrees: [{ threadIds: ["thr_1"] }, { threadIds: ["thr_2"] }],
    });
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
