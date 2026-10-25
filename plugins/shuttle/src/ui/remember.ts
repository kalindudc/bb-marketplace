import { useSyncExternalStore } from "react";

// A write that fails, on a full or disabled localStorage, keeps the value for this session only: a remembered view
// choice is not worth breaking the click that made it.
function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Kept in memory.
  }
}

function read(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * A view choice this device remembers, shared by every Shuttle surface and followed across bb windows. A stored value
 * that no longer parses, such as one an older version wrote, reads as the default. `delay` batches frequent writes,
 * such as scroll positions, into one write.
 */
export function createStored<T>(name: string, initial: T, parse: (value: unknown) => T | null, delay = 0) {
  const key = `bb-plugin-shuttle:${name}`;
  const load = (): T => {
    const raw = read(key);
    return raw === undefined ? initial : parse(raw) ?? initial;
  };
  let value = load();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    write(key, JSON.stringify(value));
  };
  const reload = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    value = load();
    notify();
  };
  // Another bb window wrote; without this, the next write here would put back what that window changed.
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) reload();
  };
  return {
    get: (): T => value,
    set(next: T): void {
      if (Object.is(next, value)) return;
      value = next;
      notify();
      if (delay === 0) return flush();
      if (timer === null) timer = setTimeout(flush, delay);
    },
    reload,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) window.addEventListener("storage", onStorage);
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) window.removeEventListener("storage", onStorage);
      };
    },
  };
}

export type Stored<T> = ReturnType<typeof createStored<T>>;

export function useStored<T>(stored: Stored<T>): T {
  return useSyncExternalStore(stored.subscribe, stored.get, stored.get);
}
