import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createCli, type OverviewRequest } from "./src/cli";
import { buildOverview, buildShell, type CollectDeps, type HostCall } from "./src/collect";
import { hostContract, reviewedTag, rpcContract, type HostInput, type HostMethod, type HostOutput, type Overview, type ShellInput } from "./src/contract";
import { createEditIndex, findRecordedEdits, type EventsSdk } from "./src/edits";
import { createFileEventGate } from "./src/file-events";
import { createRepoCache } from "./src/repo-cache";
import { createReviewStore } from "./src/review-store";
import { createRootCache } from "./src/root-cache";
import { loadCommitFiles, loadFileSides, loadPatch, type Counting } from "./src/sources";
import { createWholeStore } from "./src/whole-store";

const HOST_TIMEOUT_MS = 25_000;
const MAX_RECORDED_EDITS = 50;
const SETTINGS_CHANNEL = "vantage:settings";
const FILE_ENVIRONMENT_CHANGES = ["work-status-changed", "git-refs-changed", "status-changed"];

export default function vantage(bb: BbPluginApi): void {
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  // HostCall's generic method name is what the client's per-method return type cannot see through.
  const host: HostCall = <M extends HostMethod>(method: M, input: HostInput<M>, options: { hostId: string; signal?: AbortSignal }) =>
    hostClient.call(method, input, { ...options, timeoutMs: HOST_TIMEOUT_MS }) as Promise<HostOutput<M>>;
  // bb.sdk only works while the plugin is bound, so it is read inside calls, never at load.
  const events: EventsSdk = { threads: { events: { list: (args) => bb.sdk.threads.events.list(args) } } };
  const edits = createEditIndex(events);
  // A build that started before an invalidation, whoever caused it, may have read the old state, so no later request may join it.
  const cache = createRepoCache({ pending: (threadIds) => fileEvents.pending(threadIds), onInvalidate: () => building.clear() });
  const fileEvents = createFileEventGate(events, {
    invalidate: (threadId) => cache.invalidateThreads([threadId]), hasThread: (threadId) => cache.hasThread(threadId),
  });
  const roots = createRootCache();

  const settings = bb.settings.define({
    windowHours: {
      type: "number", default: 24, label: "Time window for the full-screen page (hours)",
      description: "The full-screen page shows threads active within this many hours, plus anything running and threads archived in that time.",
      experimental_schema: z.number().int().min(1).max(720),
    },
    maxThreads: {
      type: "number", default: 200, label: "Most threads on the full-screen page",
      description: "The page reads at most this many of the most recent threads. A higher limit makes the first load slower.",
      experimental_schema: z.number().int().min(10).max(500),
    },
    // Read by the app; the server only declares them.
    badge: {
      type: "boolean", default: true, label: "Badge the Vantage icon when a thread needs you",
      description: "Shows on Vantage's icon in bb's navigation how many threads wait for your answer or failed.",
    },
    toasts: {
      type: "boolean", default: false, label: "Show a toast when a thread needs you",
      description: "Pops up a toast when a thread starts waiting for your answer or fails, unless you are looking at it. bb's own notifications are separate.",
    },
    closestBase: {
      type: "boolean", default: true, label: "Compare with the closest base branch",
      description: "Compares each worktree with whichever likely base its branch is fewest commits ahead of: the base bb records, that branch on origin, origin's default branch, origin/main or origin/master. Off, Vantage compares with the base bb records, as Vantage 0.8 did.",
    },
    historyThreshold: {
      type: "number", default: 50, label: "Leave out branch history above this many commits",
      description: "When a branch is more commits ahead of its base than this, and its threads made only a small share of them, Vantage shows and counts only their commits and the uncommitted files. 0 never leaves anything out.",
      experimental_schema: z.number().int().min(0).max(100_000),
    },
    historyShare: {
      type: "number", default: 10, label: "Share of those commits a thread must have made to see the whole branch (%)",
      description: "Below this share of the commits ahead, the branch's older history is left out. 100 leaves it out unless the threads made every commit.",
      experimental_schema: z.number().int().min(1).max(100),
    },
    folderLimit: {
      type: "number", default: 200, label: "Fold untracked folders with more files than this",
      description: "An untracked folder with more files than this, or one holding a git repository of its own such as a clone, shows as one entry that no count includes.",
      experimental_schema: z.number().int().min(1).max(1_000_000),
    },
  });
  const store = createReviewStore(() => bb.storage.kv);
  const wholeStore = createWholeStore(() => bb.storage.kv);
  const countingOf = (values: { closestBase: boolean; historyThreshold: number; historyShare: number; folderLimit: number }): Counting => ({
    pick: values.closestBase, historyThreshold: values.historyThreshold, historyShare: values.historyShare, folderLimit: values.folderLimit,
  });
  const deps = async (): Promise<CollectDeps> => {
    const [values, whole] = await Promise.all([settings.get(), wholeStore.keys()]);
    return { sdk: bb.sdk, host, edits, cache, roots, counting: countingOf(values), whole };
  };
  const COUNTING_KEYS = ["closestBase", "historyThreshold", "historyShare", "folderLimit"] as const;
  settings.onChange((next, prev) => {
    if (next.windowHours !== prev.windowHours || next.maxThreads !== prev.maxThreads || COUNTING_KEYS.some((key) => next[key] !== prev[key])) {
      cache.clear();
      building.clear();
      bb.realtime.publish(SETTINGS_CHANNEL, {});
    }
  });

  const unsubscribers = [
    bb.sdk.subscribe({
      event: "thread:changed",
      callback(event) {
        if (event.id !== undefined) fileEvents.handle(event.id, event.changes, event.metadata?.eventTypes);
      },
    }),
    bb.sdk.subscribe({
      event: "environment:changed",
      callback(event) {
        if (event.id === undefined || !event.changes.some((change) => FILE_ENVIRONMENT_CHANGES.includes(change))) return;
        cache.invalidateEnvironment(event.id);
      },
    }),
  ];
  bb.onDispose(() => { for (const unsubscribe of unsubscribers) unsubscribe(); });

  const allOptionsFor = async (hours?: number) => {
    const { windowHours, maxThreads } = await settings.get();
    return { windowHours: hours ?? windowHours, maxThreads };
  };

  // Every open window asks for the same page at once, so they share one build; the cache makes the next one cheap.
  const building = new Map<string, Promise<Overview>>();
  async function overview(input: OverviewRequest & { refresh?: boolean }): Promise<Overview> {
    const { target, scope, includeArchived, refresh } = input;
    const base = await deps();
    const allOptions = target.kind === "all" ? await allOptionsFor(input.hours) : undefined;
    const key = [
      ...(target.kind === "tree" ? ["tree", target.threadId] : [allOptions?.windowHours, allOptions?.maxThreads]),
      scope, includeArchived, refresh === true,
    ].join("\0");
    let pending = building.get(key);
    if (pending === undefined) {
      // No caller's abort signal: the build is shared, and finishing it warms the cache for the next one.
      pending = buildOverview(allOptions === undefined ? base : { ...base, allOptions }, { target, scope, includeArchived, refresh });
      building.set(key, pending);
      const done = () => { if (building.get(key) === pending) building.delete(key); };
      pending.then(done, done);
    }
    return pending;
  }

  async function shell(input: ShellInput): Promise<Overview> {
    const base = await deps();
    return buildShell(input.target.kind === "all" ? { ...base, allOptions: await allOptionsFor() } : base, input);
  }

  bb.rpc.register(rpcContract, {
    shell: (input) => shell(input),
    overview: (input) => overview(input),
    patch: async (input) => loadPatch(await deps(), input),
    fileSides: async (input) => loadFileSides(await deps(), input),
    commitFiles: async (input) => loadCommitFiles(await deps(), input),
    setWhole: async ({ key, whole }) => {
      await wholeStore.set(key, whole);
      // A page build started before the choice would answer the refresh with the old one.
      building.clear();
      bb.realtime.publish(SETTINGS_CHANNEL, {});
      return { ok: true as const };
    },
    reviewed: ({ keys }) => store.reviewed(keys),
    setReviewed: async (input) => {
      const marks = await store.setReviewed(input);
      bb.rpc.experimental_invalidate([reviewedTag(input.key)]);
      return marks;
    },
    recordedEdits: async ({ threadIds, rawPaths }) => ({
      edits: await findRecordedEdits(events, threadIds, new Set(rawPaths), MAX_RECORDED_EDITS),
    }),
  });
  // `ancestorIds` runs from the parent up to the tree's root.
  const rootOf = async (threadId: string, signal: AbortSignal): Promise<string> => {
    const found = await bb.sdk.threads.experimental_listAncestors({ threadIds: [threadId], signal });
    return found.threads.find((entry) => entry.threadId === threadId)?.ancestorIds.at(-1) ?? threadId;
  };
  bb.cli.register(createCli(async (input, signal) => (
    input.target.kind === "tree" ? buildOverview(await deps(), input, signal) : overview(input)
  ), rootOf));
  bb.log.info("loaded");
}
