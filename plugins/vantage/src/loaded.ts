import { useEffect, useState, useSyncExternalStore } from "react";

const MAX_CACHED = 200;
const resolved = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

let generation = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const currentGeneration = () => generation;

export function clearLoadedCache(): void {
  resolved.clear();
  inflight.clear();
}

// Refresh: every open diff loads again, since a file edited without changing its line counts keeps the same key.
export function reloadLoaded(): void {
  clearLoadedCache();
  generation++;
  for (const listener of [...listeners]) listener();
}

export function loadShared<T>(key: string, run: () => Promise<T>): Promise<T> {
  let pending = inflight.get(key) as Promise<T> | undefined;
  if (pending === undefined) {
    pending = run().then((value) => {
      resolved.set(key, value);
      if (resolved.size > MAX_CACHED) resolved.delete(resolved.keys().next().value!);
      return value;
    }).finally(() => { inflight.delete(key); });
    inflight.set(key, pending);
  }
  return pending;
}

export type Loaded<T> = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: T };

// One load per key across every card that shows it; `run` only closes over what `key` already describes.
export function useLoaded<T>(key: string, enabled: boolean, run: () => Promise<T>): [Loaded<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const reloads = useSyncExternalStore(subscribe, currentGeneration, currentGeneration);
  const [state, setState] = useState<Loaded<T>>(() => (resolved.has(key) ? { status: "ready", value: resolved.get(key) as T } : { status: "idle" }));
  useEffect(() => {
    if (resolved.has(key)) {
      setState({ status: "ready", value: resolved.get(key) as T });
      return;
    }
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    let current = true;
    setState({ status: "loading" });
    loadShared(key, run).then(
      (value) => { if (current) setState({ status: "ready", value }); },
      (error: unknown) => { if (current) setState({ status: "error", message: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { current = false; };
  }, [key, enabled, attempt, reloads]);
  return [state, () => setAttempt((count) => count + 1)];
}
