// What the page remembers on this device, so a visit elsewhere in bb does not lose the place: the last route, each
// project's tab, how far each view was scrolled and the sidebar's fold. Shared by the page, its sidebar and its title.
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

const stores: Array<{ reload(): void }> = [];

// A write that fails, on a full or disabled localStorage, keeps the value for this session only.
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
 * A value this device remembers, followed across bb windows. A stored value that no longer parses, such as one an older
 * version wrote, reads as `initial`. `delay` batches frequent writes, such as scroll positions, into one.
 */
export function createStored<T>(name: string, initial: T, parse: (value: unknown) => T | null, delay = 0) {
  const key = `loom.${name}`;
  const load = (): T => {
    const raw = read(key);
    return raw === undefined ? initial : (parse(raw) ?? initial);
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
  const stored = {
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
  stores.push(stored);
  return stored;
}

export type Stored<T> = ReturnType<typeof createStored<T>>;

export function useStored<T>(stored: Stored<T>): T {
  return useSyncExternalStore(stored.subscribe, stored.get, stored.get);
}

/** Tests clear localStorage between cases; this reads every remembered value again. */
export function reloadRemembered(): void {
  for (const stored of stores) stored.reload();
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A map that keeps its `max` most recently set keys, so it cannot grow without end. */
export function createStoredMap<V>(name: string, max: number, valid: (value: unknown) => value is V, delay = 0) {
  const stored = createStored<Readonly<Record<string, V>>>(name, {}, (value) => (isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, V] => valid(entry[1]))) : null), delay);
  return {
    ...stored,
    put(key: string, next: V): void {
      const current = stored.get();
      if (current[key] === next) return;
      // The key set last goes to the end, so the oldest drop first.
      const { [key]: _old, ...rest } = current;
      const entries = Object.entries(rest);
      stored.set(Object.fromEntries([...entries.slice(Math.max(0, entries.length - max + 1)), [key, next]]));
    },
  };
}

/** The sidebar's Done and archived group, open or folded. */
export const sidebarFinished = createStored<boolean>("sidebar.showFinished", false, (value) => (typeof value === "boolean" ? value : null));

/** How far each view of the page was scrolled, by its route and tab. */
export const scrolls = createStoredMap<number>("scroll", 40, (value): value is number => typeof value === "number" && value >= 0, 250);

/** About five seconds of frames: long enough for a view that loads cold to grow tall enough. */
const MAX_FRAMES = 300;
const USER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

const nextFrame = (callback: () => void): (() => void) => {
  if (typeof window.requestAnimationFrame === "function") {
    const handle = window.requestAnimationFrame(callback);
    return () => window.cancelAnimationFrame(handle);
  }
  const handle = window.setTimeout(callback, 16);
  return () => window.clearTimeout(handle);
};

/**
 * Remembers how far the page was scrolled under `key` and scrolls back there when that view shows again. Until the view
 * is tall enough the position is tried again each frame; scrolling, clicking or typing first wins. A null key
 * remembers nothing.
 */
export function useScrollMemory(key: string | null) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const restoring = useRef(false);
  const current = useRef(key);
  current.current = key;

  useLayoutEffect(() => {
    if (node === null || key === null) return;
    const target = scrolls.get()[key] ?? 0;
    let frames = 0;
    let cancel = () => {};
    const stop = () => {
      restoring.current = false;
      cancel();
      for (const type of USER_INPUT) node.removeEventListener(type, stop);
    };
    const attempt = () => {
      node.scrollTop = target;
      if (Math.abs(node.scrollTop - target) < 2 || ++frames > MAX_FRAMES) return stop();
      cancel = nextFrame(attempt);
    };
    restoring.current = true;
    for (const type of USER_INPUT) node.addEventListener(type, stop, { passive: true });
    attempt();
    return stop;
  }, [node, key]);

  const onScroll = useCallback(() => {
    // The browser clamps a view that is still loading; that is not where it was left.
    if (restoring.current || node === null || current.current === null) return;
    scrolls.put(current.current, node.scrollTop);
  }, [node]);

  return { ref: setNode, onScroll };
}
