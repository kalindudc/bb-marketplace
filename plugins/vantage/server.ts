import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { z } from "zod";
import { createCli, type OverviewRequest } from "./src/cli";
import {
  buildOverview,
  buildShell,
  type CollectDeps,
  type Environment,
  type HostCall,
  type OverviewTiming,
} from "./src/collect";
import {
  exclusionRootSchema,
  hostContract,
  MAX_EXCLUDED_PATHS,
  MAX_EXCLUDED_PROVIDER_ROOTS,
  overviewSchema,
  reviewedTag,
  rpcContract,
  type HostInput,
  type HostMethod,
  type HostOutput,
  type Overview,
  type RepoRef,
  type ShellInput,
} from "./src/contract";
import { createEditIndex, findRecordedEdits, type EventsSdk } from "./src/edits";
import { EXCLUDED_UNAVAILABLE, isExcludedProvider, parseExclusionList } from "./src/exclusion-gate";
import { createFileEventGate } from "./src/file-events";
import { overviewKey } from "./src/overview-key";
import { createRepoCache } from "./src/repo-cache";
import { createReviewStore } from "./src/review-store";
import { createRootCache } from "./src/root-cache";
import { loadCommitFiles, loadFileSides, loadImages, loadPatch, type Counting } from "./src/sources";
import { createWholeStore } from "./src/whole-store";

const HOST_TIMEOUT_MS = 25_000;
const MAX_RECORDED_EDITS = 50;
const SETTINGS_CHANNEL = "vantage:settings";
const OVERVIEW_CHANNEL = "vantage:overview";
const OVERVIEW_TTL_MS = 60_000;
const ACTIVE_WINDOW_MS = 90_000;
const INVALIDATION_DELAY_MS = 150;
const BACKOFF_FACTOR = 1.5;
const MAX_OVERVIEWS = 64;
const MAX_ALL_OVERVIEWS = 4;
const OVERVIEW_KV_PREFIX = "overview:v1:";
const ALL_OVERVIEW_KV_PREFIX = `${OVERVIEW_KV_PREFIX}all:`;
const OVERVIEW_EPOCH_KEY = "overview:epoch:v1";
const KV_VALUE_LIMIT = 256 * 1024;
const PROVIDER_CHECK_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_CHECKS = 512;
const FILE_ENVIRONMENT_CHANGES = ["work-status-changed", "git-refs-changed", "status-changed"];
const OVERVIEW_THREAD_CHANGES = [
  "status-changed",
  "title-changed",
  "archived-changed",
  "parent-changed",
  "environment-changed",
  "thread-deleted",
  "history-rewritten",
  "history-compacted",
];

type Request = OverviewRequest & { refresh?: boolean };
interface FollowUp {
  refresh: boolean;
  requestedAt: number;
  waiters: number;
  promise: Promise<Overview>;
  resolve: (overview: Overview) => void;
  reject: (reason: unknown) => void;
}
interface OverviewEntry {
  input: OverviewRequest;
  lastRequested: number;
  checkedAt: number | null;
  lastBuildAt?: number;
  latestGeneration?: number;
  revalidateAt: number;
  value?: Overview;
  lastError?: string;
  dirty: boolean;
  forceFresh?: true;
  stored?: Promise<void>;
  running?: { refresh: boolean; promise: Promise<Overview> };
  pending?: FollowUp;
  timer?: ReturnType<typeof setTimeout>;
}

async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  let abort!: ReturnType<typeof addAbortListener>;
  const cancelled = new Promise<never>((_, reject) => {
    abort = addAbortListener(signal, () => reject(signal.reason));
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    abort[Symbol.dispose]();
  }
}

const sameOverview = (left: Overview, right: Overview): boolean =>
  JSON.stringify({ ...left, generatedAt: 0 }) === JSON.stringify({ ...right, generatedAt: 0 });

const storageKey = (key: string, everyThread: boolean): string =>
  `${everyThread ? ALL_OVERVIEW_KV_PREFIX : OVERVIEW_KV_PREFIX}${createHash("sha256").update(key).digest("hex")}`;

export default function vantage(bb: BbPluginApi): void {
  const runtime = new AbortController();
  const requestSignal = (caller: AbortSignal) => AbortSignal.any([caller, runtime.signal]);
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  // HostCall's generic method name is what the client's per-method return type cannot see through.
  const host: HostCall = <M extends HostMethod>(
    method: M,
    input: HostInput<M>,
    options: { hostId: string; signal?: AbortSignal },
  ) =>
    hostClient.call(method, input, {
      hostId: options.hostId,
      signal: options.signal === undefined ? runtime.signal : requestSignal(options.signal),
      timeoutMs: HOST_TIMEOUT_MS,
    }) as Promise<HostOutput<M>>;
  // bb.sdk only works while the plugin is bound, so it is read inside calls, never at load.
  const events: EventsSdk = { threads: { events: { list: (args) => bb.sdk.threads.events.list(args) } } };
  const edits = createEditIndex(events);
  const overviews = new Map<string, OverviewEntry>();
  const providerChecks = new Map<string, Promise<boolean>>();
  const observedProviderRoots = new Map<string, { hostId: string; path: string }>();
  let exclusionPolicy = new AbortController();
  const rememberExcludedEnvironment = ({ id, hostId, path }: Environment) => {
    if (path === null) return;
    observedProviderRoots.delete(id);
    observedProviderRoots.set(id, { hostId, path });
    if (observedProviderRoots.size > MAX_EXCLUDED_PROVIDER_ROOTS)
      observedProviderRoots.delete(observedProviderRoots.keys().next().value!);
  };
  const hostWithExclusions = (paths: readonly string[], policy: AbortSignal): HostCall =>
    (method, input, options) => {
      const signal = options.signal === undefined ? policy : AbortSignal.any([policy, options.signal]);
      signal.throwIfAborted();
      const excludedRoots =
        paths.length === 0 ? input.excludedRoots : [...new Set([...paths, ...(input.excludedRoots ?? [])])];
      return host(method, excludedRoots === undefined ? input : { ...input, excludedRoots }, { ...options, signal });
    };
  const cache = createRepoCache({ pending: (threadIds) => fileEvents.pending(threadIds) });
  const fileEvents = createFileEventGate(events, {
    invalidate: (threadId) => {
      cache.invalidateThreads([threadId]);
      invalidateOverviews((value) => value === undefined || value.threads.some((thread) => thread.id === threadId));
    },
    hasThread: (threadId) =>
      cache.hasThread(threadId) ||
      [...overviews.values()].some(
        (entry) => recent(entry) && entry.value?.threads.some((thread) => thread.id === threadId) === true,
      ),
  });
  const roots = createRootCache();

  let awaitingTrees = 0;
  const allReads = new Map<string, { active: boolean; waiting: Array<() => void> }>();
  function pumpAllReads() {
    for (const [hostId, queue] of allReads) {
      if (queue.active) continue;
      if (queue.waiting.length === 0) allReads.delete(hostId);
      else if (awaitingTrees === 0) {
        queue.active = true;
        queue.waiting.shift()!();
      }
    }
  }
  // Admit before touching the repo cache so a tree cannot join a queued all-threads read.
  const deferHostRead: NonNullable<CollectDeps["deferHostRead"]> = (hostId, read, signal) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const queue = allReads.get(hostId) ?? { active: false, waiting: [] };
      allReads.set(hostId, queue);
      const abort =
        signal &&
        addAbortListener(signal, () => {
          const index = queue.waiting.indexOf(start);
          if (index !== -1) queue.waiting.splice(index, 1);
          reject(signal.reason);
          pumpAllReads();
        });
      const start = () => {
        abort?.[Symbol.dispose]();
        Promise.resolve()
          .then(() => {
            signal?.throwIfAborted();
            return read();
          })
          .then(resolve, reject)
          .finally(() => {
            queue.active = false;
            pumpAllReads();
          });
      };
      queue.waiting.push(start);
      pumpAllReads();
    });

  const settings = bb.settings.define({
    excludedPaths: {
      type: "string",
      default: "",
      label: "Folders excluded from Git",
      description:
        "Never run Git in these folders. Enter absolute paths or paths starting with ~/ (expanded on each host), one per line or separated by commas. Vantage still shows edits a thread recorded there.",
      experimental_multiline: true,
      experimental_schema: z.string().refine((value) => {
        const paths = parseExclusionList(value);
        return paths.length <= MAX_EXCLUDED_PATHS && paths.every((path) => exclusionRootSchema.safeParse(path).success);
      }, `Enter up to ${MAX_EXCLUDED_PATHS} absolute paths or paths starting with ~/.`),
    },
    excludedProviders: {
      type: "string",
      default: "",
      label: "Environment providers excluded from Git",
      description:
        "Never run Git in checkouts from these environment provider IDs. Enter one ID per line or separate them with commas.",
      experimental_multiline: true,
    },
    windowHours: {
      type: "number",
      default: 24,
      label: "Time window for the full-screen page (hours)",
      description:
        "The full-screen page shows threads active within this many hours, plus anything running and threads archived in that time.",
      experimental_schema: z.number().int().min(1).max(720),
    },
    maxThreads: {
      type: "number",
      default: 200,
      label: "Most threads on the full-screen page",
      description:
        "The page reads at most this many of the most recent threads. A higher limit makes the first load slower.",
      experimental_schema: z.number().int().min(10).max(500),
    },
    // Read by the app; the server only declares it.
    toasts: {
      type: "boolean",
      default: false,
      label: "Show a toast when a thread needs you",
      description:
        "Pops up a toast when a thread starts waiting for your answer or fails, unless you are looking at it. bb's own notifications are separate.",
    },
    closestBase: {
      type: "boolean",
      default: true,
      label: "Compare with the closest base branch",
      description:
        "Compares each worktree with whichever likely base its branch is fewest commits ahead of: the base bb records, that branch on origin, origin's default branch, origin/main or origin/master. Off, Vantage compares with the base bb records, as Vantage 0.8 did.",
    },
    historyThreshold: {
      type: "number",
      default: 50,
      label: "Leave out branch history above this many commits",
      description:
        "When a branch is more commits ahead of its base than this, and its threads made only a small share of them, Vantage shows and counts only their commits and the uncommitted files. 0 never leaves anything out.",
      experimental_schema: z.number().int().min(0).max(100_000),
    },
    historyShare: {
      type: "number",
      default: 10,
      label: "Share of those commits a thread must have made to see the whole branch (%)",
      description:
        "Below this share of the commits ahead, the branch's older history is left out. 100 leaves it out unless the threads made every commit.",
      experimental_schema: z.number().int().min(1).max(100),
    },
    folderLimit: {
      type: "number",
      default: 200,
      label: "Fold untracked folders with more files than this",
      description:
        "An untracked folder with more files than this, or one holding a git repository of its own such as a clone, shows as one entry that no count includes.",
      experimental_schema: z.number().int().min(1).max(1_000_000),
    },
  });
  const store = createReviewStore(() => bb.storage.kv);
  const wholeStore = createWholeStore(() => bb.storage.kv);
  const countingOf = (values: {
    closestBase: boolean;
    historyThreshold: number;
    historyShare: number;
    folderLimit: number;
  }): Counting => ({
    pick: values.closestBase,
    historyThreshold: values.historyThreshold,
    historyShare: values.historyShare,
    folderLimit: values.folderLimit,
  });
  let settingsRead: ReturnType<typeof settings.get> | undefined;
  const valuesOf = () => {
    if (settingsRead !== undefined) return settingsRead;
    const reading = settings.get().catch((error: unknown) => {
      if (settingsRead === reading) settingsRead = undefined;
      throw error;
    });
    settingsRead = reading;
    return reading;
  };
  const deps = async (): Promise<CollectDeps> => {
    const policy = exclusionPolicy.signal;
    const [values, whole] = await Promise.all([valuesOf(), wholeStore.keys()]);
    policy.throwIfAborted();
    return {
      sdk: bb.sdk,
      host: hostWithExclusions(parseExclusionList(values.excludedPaths), policy),
      edits,
      cache,
      roots,
      counting: countingOf(values),
      whole,
      runtimeSignal: requestSignal(policy),
      excludedProviders: new Set(parseExclusionList(values.excludedProviders)),
      rememberExcludedEnvironment(env) {
        policy.throwIfAborted();
        rememberExcludedEnvironment(env);
      },
    };
  };
  const COUNTING_KEYS = ["closestBase", "historyThreshold", "historyShare", "folderLimit"] as const;
  settings.onChange((next, prev) => {
    settingsRead = Promise.resolve(next);
    const exclusionsChanged = next.excludedPaths !== prev.excludedPaths || next.excludedProviders !== prev.excludedProviders;
    if (exclusionsChanged) {
      exclusionPolicy.abort(new Error("Vantage exclusions changed. Try again with the new settings."));
      exclusionPolicy = new AbortController();
      providerChecks.clear();
      observedProviderRoots.clear();
      roots.clear();
    }
    if (
      exclusionsChanged ||
      next.windowHours !== prev.windowHours ||
      next.maxThreads !== prev.maxThreads ||
      COUNTING_KEYS.some((key) => next[key] !== prev[key])
    ) {
      cache.clear();
      void advanceOverviewEpoch();
      invalidateOverviews(() => true, true);
      bb.realtime.publish(SETTINGS_CHANNEL, {});
    }
  });

  const unsubscribers = [
    bb.sdk.subscribe({
      event: "thread:changed",
      callback(event) {
        const { id, changes } = event;
        if (id === undefined) return;
        const resetHistory = changes.includes("history-rewritten") || changes.includes("history-compacted");
        if (resetHistory) edits.forget([id]);
        if (changes.includes("thread-created")) {
          invalidateOverviews((_, input) => input.target.kind === "all");
          if ([...overviews.values()].some((entry) => entry.input.target.kind === "tree")) {
            void bb.sdk.threads
              .experimental_listAncestors({ threadIds: [id], signal: runtime.signal })
              .then(({ threads }) => {
                if (runtime.signal.aborted) return;
                const ancestors = new Set(threads.find((thread) => thread.threadId === id)?.ancestorIds);
                invalidateOverviews((_, input) => input.target.kind === "tree" && ancestors.has(input.target.threadId));
              })
              .catch((error: unknown) => {
                if (!runtime.signal.aborted) bb.log.warn(`Could not find the new thread's ancestors: ${String(error)}`);
              });
          }
        } else if (changes.some((change) => OVERVIEW_THREAD_CHANGES.includes(change))) {
          const membershipChanged = changes.includes("archived-changed") || changes.includes("parent-changed");
          invalidateOverviews(
            (value, input) =>
              (input.target.kind === "all" && membershipChanged) ||
              (value?.threads.some((thread) => thread.id === id) ?? input.target.kind === "tree"),
          );
        }
        if (resetHistory || changes.includes("events-appended"))
          fileEvents.handle(id, changes, event.metadata?.eventTypes);
      },
    }),
    bb.sdk.subscribe({
      event: "environment:changed",
      callback(event) {
        const id = event.id;
        if (id === undefined) return;
        if (!event.changes.some((change) => FILE_ENVIRONMENT_CHANGES.includes(change))) return;
        cache.invalidateEnvironment(id);
        invalidateOverviews((value) => value === undefined || value.environmentIds.includes(id));
      },
    }),
  ];
  bb.onDispose(() => {
    runtime.abort();
    for (const entry of overviews.values()) clearTimeout(entry.timer);
    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  const allOptionsFor = async (hours?: number) => {
    const { windowHours, maxThreads } = await valuesOf();
    return { windowHours: hours ?? windowHours, maxThreads };
  };

  const recent = (entry: OverviewEntry) => Date.now() - entry.lastRequested < ACTIVE_WINDOW_MS;
  const stale = (entry: OverviewEntry) =>
    entry.dirty || entry.checkedAt === null || Date.now() - entry.checkedAt >= OVERVIEW_TTL_MS;

  function invalidateOverviews(
    matches: (value: Overview | undefined, input: OverviewRequest) => boolean,
    fresh = false,
  ) {
    for (const [key, entry] of overviews) {
      if (!matches(entry.value, entry.input)) continue;
      entry.dirty = true;
      if (fresh) entry.forceFresh = true;
      revalidateSoon(key, entry);
    }
  }

  function revalidateSoon(key: string, entry: OverviewEntry) {
    if (runtime.signal.aborted || entry.running !== undefined || entry.timer !== undefined || !recent(entry)) return;
    const notBefore =
      entry.input.target.kind === "all" && entry.lastBuildAt !== undefined
        ? Math.max(entry.revalidateAt, entry.lastBuildAt + OVERVIEW_TTL_MS)
        : entry.revalidateAt;
    const scheduledAt = performance.now();
    entry.timer = setTimeout(
      () => {
        delete entry.timer;
        if (!runtime.signal.aborted && recent(entry) && stale(entry) && entry.running === undefined)
          void runBuild(key, entry, false, scheduledAt);
      },
      Math.max(INVALIDATION_DELAY_MS, notBefore - Date.now()),
    );
    entry.timer.unref();
  }

  let persistedKeys: Set<string> | undefined;
  let writes = Promise.resolve();
  let overviewEpoch: Promise<string | undefined> | undefined;
  const readOverviewEpoch = () =>
    (overviewEpoch ??= bb.storage.kv.get<string>(OVERVIEW_EPOCH_KEY).then(
      (epoch) => epoch ?? "",
      (error: unknown) => {
        bb.log.warn(`Overview cache epoch read failed: ${String(error)}`);
        return undefined;
      },
    ));

  // Evicted entries can outlive the settings that produced them in KV.
  function advanceOverviewEpoch(): Promise<void> {
    const epoch = randomUUID();
    overviewEpoch = Promise.resolve(epoch);
    writes = writes
      .then(() => bb.storage.kv.set(OVERVIEW_EPOCH_KEY, epoch))
      .catch((error: unknown) => {
        if (!runtime.signal.aborted) bb.log.warn(`Overview cache epoch write failed: ${String(error)}`);
      });
    return writes;
  }

  function saveOverview(key: string, value: Overview): Promise<void> {
    const epochRead = readOverviewEpoch();
    const write = async () => {
      const epoch = await epochRead;
      if (epoch === undefined || epochRead !== overviewEpoch) return;
      const record = { key, value, epoch };
      if (Buffer.byteLength(JSON.stringify(record)) > KV_VALUE_LIMIT) return;
      runtime.signal.throwIfAborted();
      const kv = bb.storage.kv;
      const everyThread = value.target.kind === "all";
      const savedKey = storageKey(key, everyThread);
      const keys = (persistedKeys ??= new Set(await kv.list(OVERVIEW_KV_PREFIX)));
      if (!keys.has(savedKey)) {
        if (everyThread) {
          const allKeys = [...keys].filter((stored) => stored.startsWith(ALL_OVERVIEW_KV_PREFIX));
          for (const oldest of allKeys.slice(0, Math.max(0, allKeys.length - MAX_ALL_OVERVIEWS + 1))) {
            await kv.delete(oldest);
            keys.delete(oldest);
          }
        }
        while (keys.size >= MAX_OVERVIEWS) {
          const oldest = keys.values().next().value!;
          await kv.delete(oldest);
          keys.delete(oldest);
        }
      }
      await kv.set(savedKey, record);
      keys.delete(savedKey);
      keys.add(savedKey);
    };
    writes = writes.then(write).catch((error: unknown) => {
      if (!runtime.signal.aborted) bb.log.warn(`Overview cache write failed: ${String(error)}`);
    });
    return writes;
  }

  function runBuild(key: string, entry: OverviewEntry, refresh: boolean, requestedAt: number): Promise<Overview> {
    clearTimeout(entry.timer);
    delete entry.timer;
    entry.dirty = false;
    const startedAt = Date.now();
    entry.lastBuildAt = startedAt;
    const signal = requestSignal(AbortSignal.any([AbortSignal.timeout(45_000), exclusionPolicy.signal]));
    const tree = entry.input.target.kind === "tree";
    const timing: OverviewTiming | undefined = tree
      ? undefined
      : {
          threadListingMs: 0,
          editIndexMs: 0,
          editPages: 0,
          rootResolutionMs: 0,
          rootDirectories: 0,
          rootHostCalls: 0,
          rootRevalidated: 0,
          hostReadsMs: 0,
          hostReads: 0,
        };
    const buildStarted = timing === undefined ? 0 : performance.now();
    let setupMs = 0;
    const promise = (async () => {
      const [base, allOptions] = await Promise.all([deps(), tree ? undefined : allOptionsFor(entry.input.hours)]);
      if (timing !== undefined) setupMs = performance.now() - buildStarted;
      const built = await buildOverview(
        allOptions === undefined ? base : { ...base, allOptions, deferHostRead },
        { ...entry.input, refresh },
        signal,
        timing,
      );
      signal.throwIfAborted();
      const previous = entry.value;
      const changed = previous === undefined || !sameOverview(previous, built);
      // The browser uses this timestamp as the revision of the content, not as a freshness check.
      const value = changed
        ? {
            ...built,
            generatedAt: Math.max(built.generatedAt, (entry.latestGeneration ?? previous?.generatedAt ?? -1) + 1),
          }
        : previous;
      entry.latestGeneration = Math.max(entry.latestGeneration ?? 0, value.generatedAt);
      // A busy all-threads view can use this sample without losing the dirty bit for the next minute.
      if (!entry.dirty || (!tree && !entry.forceFresh)) {
        const recovered = entry.lastError !== undefined;
        const shouldSave = changed || entry.checkedAt === null || entry.forceFresh === true;
        entry.value = value;
        entry.checkedAt = Date.now();
        delete entry.forceFresh;
        delete entry.lastError;
        if (previous !== undefined && (changed || recovered)) bb.realtime.publish(OVERVIEW_CHANNEL, { key });
        if (shouldSave) await saveOverview(key, value);
      } else if (entry.value === undefined) entry.value = value;
      return value;
    })();
    entry.running = { refresh, promise };
    const done = (failure?: { error: unknown }) => {
      if (timing !== undefined) {
        const fields = Object.entries({ waitMs: buildStarted - requestedAt, setupMs, ...timing });
        bb.log.debug(`all overview timing ${fields.map(([name, value]) => `${name}=${Math.round(value)}`).join(" ")}`);
      }
      const invalidated = entry.dirty;
      if (failure !== undefined) {
        const { error } = failure;
        entry.lastError = error instanceof Error ? error.message : String(error);
        entry.dirty = true;
      }
      const endedAt = Date.now();
      entry.revalidateAt = endedAt + BACKOFF_FACTOR * (endedAt - startedAt);
      delete entry.running;
      const next = entry.pending;
      delete entry.pending;
      if (runtime.signal.aborted) next?.reject(runtime.signal.reason);
      else if (next !== undefined && next.waiters > 0)
        runBuild(key, entry, next.refresh, next.requestedAt).then(next.resolve, next.reject);
      else if (invalidated) revalidateSoon(key, entry);
    };
    void promise.then(
      () => done(),
      (error: unknown) => done({ error }),
    );
    return promise;
  }

  function afterBuild(entry: OverviewEntry, refresh: boolean, requestedAt: number): FollowUp {
    const prior = entry.pending;
    if (prior !== undefined) {
      prior.refresh ||= refresh;
      return prior;
    }
    let resolve!: FollowUp["resolve"];
    let reject!: FollowUp["reject"];
    const promise = new Promise<Overview>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return (entry.pending = { refresh, requestedAt, waiters: 0, promise, resolve, reject });
  }

  async function overview(input: Request, fresh = false, signal?: AbortSignal): Promise<Overview> {
    signal?.throwIfAborted();
    const { target, scope, includeArchived, hours, refresh } = input;
    const key = overviewKey(input);
    const everyThread = target.kind === "all";
    const requestedAt = everyThread ? performance.now() : 0;
    let entry = overviews.get(key);
    if (entry === undefined) {
      const allAtLimit =
        everyThread &&
        [...overviews.values()].filter((item) => item.input.target.kind === "all").length >= MAX_ALL_OVERVIEWS;
      if (allAtLimit || overviews.size >= MAX_OVERVIEWS) {
        const oldest = [...overviews].find(
          ([, item]) =>
            (!allAtLimit || item.input.target.kind === "all") &&
            item.running === undefined &&
            item.stored === undefined,
        );
        if (oldest === undefined) throw new Error("Too many Vantage overviews are loading. Try again shortly.");
        clearTimeout(oldest[1].timer);
        overviews.delete(oldest[0]);
      }
      const item: OverviewEntry = {
        input: { target, scope, includeArchived, ...(hours === undefined ? {} : { hours }) },
        lastRequested: Date.now(),
        checkedAt: null,
        revalidateAt: 0,
        dirty: false,
      };
      const epochRead = readOverviewEpoch();
      item.stored = Promise.all([
        bb.storage.kv.get<{ key: string; value: unknown; epoch?: string }>(storageKey(key, everyThread)),
        epochRead,
      ])
        .then(([record, epoch]) => {
          if (
            item.value !== undefined ||
            record?.key !== key ||
            epoch === undefined ||
            epochRead !== overviewEpoch ||
            (record.epoch ?? "") !== epoch
          )
            return;
          const result = overviewSchema.safeParse(record.value);
          if (result.success && !result.data.partial) item.value = result.data;
        })
        .catch((error: unknown) => bb.log.warn(`Overview cache read failed: ${String(error)}`))
        .finally(() => {
          delete item.stored;
        });
      entry = item;
    } else overviews.delete(key);
    overviews.set(key, entry);
    entry.lastRequested = Date.now();
    if (entry.value === undefined && entry.stored !== undefined) await waitFor(entry.stored, signal);
    if (entry.value !== undefined && refresh !== true && !entry.forceFresh && (!fresh || !stale(entry))) {
      if (stale(entry)) revalidateSoon(key, entry);
      const { value, lastError } = entry;
      if (lastError === undefined) return value;
      const checked = new Date(value.generatedAt).toISOString();
      return {
        ...value,
        warnings: [...value.warnings, `Overview refresh failed: ${lastError}. Showing the result from ${checked}.`],
      };
    }
    if (!everyThread) awaitingTrees++;
    let followUp: FollowUp | undefined;
    try {
      const running = entry.running;
      if (running !== undefined && (entry.dirty || (refresh === true && !running.refresh))) {
        followUp = afterBuild(entry, refresh === true, requestedAt);
        followUp.waiters++;
      }
      return await waitFor(
        followUp?.promise ?? running?.promise ?? runBuild(key, entry, refresh === true, requestedAt),
        signal,
      );
    } finally {
      if (followUp !== undefined && --followUp.waiters === 0 && entry.pending === followUp) delete entry.pending;
      if (!everyThread && --awaitingTrees === 0) pumpAllReads();
    }
  }

  async function shell(input: ShellInput, signal: AbortSignal): Promise<Overview> {
    const base = await deps();
    return buildShell(
      input.target.kind === "all" ? { ...base, allOptions: await allOptionsFor() } : base,
      input,
      signal,
    );
  }

  async function liveDeps(ref: RepoRef, signal: AbortSignal): Promise<Pick<CollectDeps, "host">> {
    const policy = exclusionPolicy.signal;
    const readSignal = AbortSignal.any([policy, signal]);
    readSignal.throwIfAborted();
    const values = await waitFor(valuesOf(), readSignal);
    const providers = new Set(parseExclusionList(values.excludedProviders));
    if (providers.size > 0 && ref.kind === "workspace" && ref.root !== undefined && ref.hostId !== undefined) {
      const { environmentId } = ref;
      let check = providerChecks.get(environmentId);
      if (check === undefined) {
        const current = bb.sdk.environments
          .get({
            environmentId,
            signal: requestSignal(AbortSignal.any([policy, AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS)])),
          })
          .then((env) => {
            policy.throwIfAborted();
            const excluded = isExcludedProvider(env.environmentProviderId, providers);
            if (excluded) rememberExcludedEnvironment(env);
            return excluded;
          });
        providerChecks.set(environmentId, current);
        if (providerChecks.size > MAX_PROVIDER_CHECKS) providerChecks.delete(providerChecks.keys().next().value!);
        void current.catch(() => {
          if (providerChecks.get(environmentId) === current) providerChecks.delete(environmentId);
        });
        check = current;
      }
      const blocked = await waitFor(check, readSignal);
      readSignal.throwIfAborted();
      if (blocked) throw new Error(EXCLUDED_UNAVAILABLE);
    }
    const paths = parseExclusionList(values.excludedPaths);
    if (ref.kind !== "recorded") {
      for (const { hostId, path } of observedProviderRoots.values()) if (ref.hostId === hostId) paths.push(path);
    }
    return { host: hostWithExclusions(paths, policy) };
  }

  bb.rpc.register(rpcContract, {
    shell: (input, context) => shell(input, requestSignal(context.experimental_signal)),
    overview: (input, context) => overview(input, false, requestSignal(context.experimental_signal)),
    patch: async (input, context) => {
      const signal = requestSignal(context.experimental_signal);
      return loadPatch(await liveDeps(input.ref, signal), input, signal);
    },
    fileSides: async (input, context) => {
      const signal = requestSignal(context.experimental_signal);
      return loadFileSides(await liveDeps(input.ref, signal), input, signal);
    },
    image: async (input, context) => {
      const signal = requestSignal(context.experimental_signal);
      return loadImages(await liveDeps(input.ref, signal), input, signal);
    },
    commitFiles: async (input, context) => {
      const signal = requestSignal(context.experimental_signal);
      return loadCommitFiles(await liveDeps(input.ref, signal), input, signal);
    },
    setWhole: async ({ key, whole }) => {
      await wholeStore.set(key, whole);
      const saved = advanceOverviewEpoch();
      invalidateOverviews(
        (value) => value === undefined || value.worktrees.some((worktree) => worktree.key === key),
        true,
      );
      bb.realtime.publish(SETTINGS_CHANNEL, {});
      await saved;
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
  bb.cli.register(createCli((input, signal) => overview(input, true, requestSignal(signal)), rootOf));
  bb.log.info("loaded");
}
