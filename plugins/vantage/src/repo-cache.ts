import type { RepoPlan } from "./collect";

export interface CacheMeta { threadIds: readonly string[]; environmentId: string | null }

export interface RepoCache {
  /** `ttlFor` lets a result outlive the default time to live, for example a branch that is gone for good. */
  get<T>(key: string, meta: CacheMeta, load: () => Promise<T>, ttlFor?: (value: T) => number | undefined): Promise<T>;
  invalidateThreads(threadIds: readonly string[]): void;
  invalidateEnvironment(environmentId: string): void;
  /** Whether an entry, loaded or still loading, was built for the thread. */
  hasThread(threadId: string): boolean;
  clear(): void;
  size(): number;
}

interface Entry {
  promise: Promise<unknown>;
  settledAt: number | null;
  ttlMs: number;
  threadIds: ReadonlySet<string>;
  environmentId: string | null;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 500;

export function createRepoCache(options: {
  ttlMs?: number; maxEntries?: number; now?: () => number;
  /** A lookup for these threads waits for the promise it returns, such as for an event that may have made their entries stale. */
  pending?: (threadIds: readonly string[]) => Promise<void> | null;
  /** Called after entries were dropped on purpose, so work that started before it, and may have read them, can be set apart. */
  onInvalidate?: () => void;
} = {}): RepoCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const dropWhere = (matches: (entry: Entry) => boolean): void => {
    for (const [key, entry] of entries) if (matches(entry)) entries.delete(key);
  };

  function get<T>(key: string, meta: CacheMeta, load: () => Promise<T>, ttlFor?: (value: T) => number | undefined): Promise<T> {
    const waiting = options.pending?.(meta.threadIds) ?? null;
    if (waiting !== null) return waiting.then(() => get(key, meta, load, ttlFor));
    const known = entries.get(key);
    // A thread the entry never saw may have changed this repository, so it cannot vouch for it.
    const covers = known !== undefined && meta.threadIds.every((id) => known.threadIds.has(id));
    if (known !== undefined && covers && (known.settledAt === null || now() - known.settledAt < known.ttlMs)) {
      return known.promise as Promise<T>;
    }
    const entry: Entry = { promise: Promise.resolve(), settledAt: null, ttlMs, threadIds: new Set(meta.threadIds), environmentId: meta.environmentId };
    entry.promise = new Promise<T>((resolve) => resolve(load())).then(
      (value) => {
        entry.settledAt = now();
        entry.ttlMs = ttlFor?.(value) ?? ttlMs;
        return value;
      },
      (error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      },
    );
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    return entry.promise as Promise<T>;
  }

  return {
    get,
    invalidateThreads(threadIds) {
      dropWhere((entry) => threadIds.some((id) => entry.threadIds.has(id)));
      options.onInvalidate?.();
    },
    invalidateEnvironment(environmentId) {
      dropWhere((entry) => entry.environmentId === environmentId);
      options.onInvalidate?.();
    },
    hasThread: (threadId) => [...entries.values()].some((entry) => entry.threadIds.has(threadId)),
    clear() {
      entries.clear();
      options.onInvalidate?.();
    },
    size: () => entries.size,
  };
}

// Recorded edits are not read from git: they differ for every request, so they are never cached.
export function planCached<T>(cache: RepoCache | undefined, plan: RepoPlan, variant: string, load: () => Promise<T>): Promise<T> {
  if (cache === undefined || plan.ref.kind === "recorded") return load();
  return cache.get(
    `${plan.key}\0${variant}`,
    { threadIds: plan.threadIds, environmentId: plan.ref.kind === "workspace" ? plan.ref.environmentId : null },
    load,
  );
}
