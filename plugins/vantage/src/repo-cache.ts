import type { RepoPlan } from "./collect";

export interface CacheMeta { threadIds: readonly string[]; environmentId: string | null }

export interface RepoCache {
  /** `ttlFor` lets a result outlive the default time to live, for example a branch that is gone for good. */
  get<T>(key: string, meta: CacheMeta, load: () => Promise<T>, ttlFor?: (value: T) => number | undefined): Promise<T>;
  invalidateThreads(threadIds: readonly string[]): void;
  invalidateEnvironment(environmentId: string): void;
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
// Streaming chunks change no file, so these events never invalidate an entry.
const DELTA_EVENT_TYPES = new Set([
  "item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta", "item/plan/delta", "item/toolCall/progress",
]);

export function isDeltaOnly(eventTypes: readonly string[] | undefined): boolean {
  return eventTypes !== undefined && eventTypes.length > 0 && eventTypes.every((type) => DELTA_EVENT_TYPES.has(type));
}

export function createRepoCache(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): RepoCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const dropWhere = (matches: (entry: Entry) => boolean): void => {
    for (const [key, entry] of entries) if (matches(entry)) entries.delete(key);
  };

  return {
    get<T>(key: string, meta: CacheMeta, load: () => Promise<T>, ttlFor?: (value: T) => number | undefined): Promise<T> {
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
    },
    invalidateThreads(threadIds) {
      dropWhere((entry) => threadIds.some((id) => entry.threadIds.has(id)));
    },
    invalidateEnvironment(environmentId) {
      dropWhere((entry) => entry.environmentId === environmentId);
    },
    clear: () => entries.clear(),
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
