export interface RootEntry {
  root: string | null;
  relative: string | null;
  excluded?: true;
}

export interface RootCache {
  peek(hostId: string, path: string): RootEntry | undefined;
  missing(hostId: string, paths: readonly string[]): string[];
  store(hostId: string, path: string, entry: RootEntry): void;
  dropRoots(hostId: string, roots: ReadonlySet<string>): void;
  clear(): void;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 5_000;

export function createRootCache(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): RootCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, RootEntry & { at: number }>();
  const keyOf = (hostId: string, path: string) => `${hostId}\0${path}`;

  const peek = (hostId: string, path: string): RootEntry | undefined => {
    const key = keyOf(hostId, path);
    const found = entries.get(key);
    if (found === undefined) return undefined;
    if (now() - found.at >= ttlMs) {
      entries.delete(key);
      return undefined;
    }
    const { at: _, ...entry } = found;
    return entry;
  };

  return {
    peek,
    missing: (hostId, paths) => paths.filter((path) => peek(hostId, path) === undefined),
    store(hostId, path, entry) {
      const key = keyOf(hostId, path);
      entries.delete(key);
      entries.set(key, { ...entry, at: now() });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    },
    dropRoots(hostId, roots) {
      if (roots.size === 0) return;
      const prefix = `${hostId}\0`;
      for (const [key, entry] of entries) {
        if (key.startsWith(prefix) && entry.root !== null && roots.has(entry.root)) entries.delete(key);
      }
    },
    clear: () => entries.clear(),
  };
}
