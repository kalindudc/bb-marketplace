import { useSyncExternalStore } from "react";

// A write that fails, such as on a full or disabled localStorage, keeps the value for this session only: a remembered
// view choice is not worth breaking the click that made it.
export function writeStorage(win: Window, key: string, value: string | null): void {
  try {
    if (value === null) win.localStorage.removeItem(key);
    else win.localStorage.setItem(key, value);
  } catch {
    // Kept in memory.
  }
}

// Keys mapped to values this device remembers, such as the files folded by hand. It holds at most `max` entries and drops
// the one set longest ago first, because bb and every plugin share one localStorage.
export function createRemembered<T>(win: Window, key: string, parse: (value: unknown) => T | null, max: number) {
  const read = (): ReadonlyMap<string, T> => {
    const out = new Map<string, T>();
    let stored: unknown;
    try {
      stored = JSON.parse(win.localStorage.getItem(key) ?? "[]");
    } catch {
      return out;
    }
    if (!Array.isArray(stored)) return out;
    for (const entry of stored) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
      const value = parse(entry[1]);
      if (value !== null) out.set(entry[0], value);
    }
    return out;
  };
  let entries = read();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  // Another bb window wrote; without this, the next write here would put back what that window changed.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return;
    entries = read();
    notify();
  };

  // Undefined forgets a key, so it follows its default again.
  const setMany = (changes: Iterable<readonly [string, T | undefined]>): void => {
    const next = new Map(entries);
    const written = new Set<string>();
    let changed = false;
    for (const [entryKey, value] of changes) {
      written.add(entryKey);
      if (value === undefined) {
        changed = next.delete(entryKey) || changed;
      } else if (!next.has(entryKey) || !Object.is(next.get(entryKey), value)) {
        next.delete(entryKey);
        next.set(entryKey, value);
        changed = true;
      }
    }
    if (!changed) return;
    // Never the entries this write just made, so one large write keeps all of itself.
    for (const oldest of [...next.keys()]) {
      if (next.size <= max) break;
      if (!written.has(oldest)) next.delete(oldest);
    }
    entries = next;
    notify();
    writeStorage(win, key, next.size === 0 ? null : JSON.stringify([...next]));
  };

  return {
    snapshot: (): ReadonlyMap<string, T> => entries,
    get: (entryKey: string): T | undefined => entries.get(entryKey),
    set: (entryKey: string, value: T | undefined): void => setMany([[entryKey, value]]),
    setMany,
    reload(): void {
      entries = read();
      notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) win.addEventListener("storage", onStorage);
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) win.removeEventListener("storage", onStorage);
      };
    },
  };
}

export type Remembered<T> = ReturnType<typeof createRemembered<T>>;

export function useRemembered<T>(store: Remembered<T>): ReadonlyMap<string, T> {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
