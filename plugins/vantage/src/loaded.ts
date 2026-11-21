import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const MAX_CACHED = 200;
type Ready<T> = Extract<Loaded<T>, { status: "ready" }>;
const resolved = new Map<string, Ready<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

let generation = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
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
  const cached = resolved.get(key) as Ready<T> | undefined;
  if (cached !== undefined) return Promise.resolve(cached.value);
  let pending = inflight.get(key) as Promise<T> | undefined;
  if (pending === undefined) {
    pending = run()
      .then((value) => {
        if (inflight.get(key) === pending) {
          resolved.set(key, { status: "ready", value });
          if (resolved.size > MAX_CACHED) resolved.delete(resolved.keys().next().value!);
        }
        return value;
      })
      .finally(() => {
        if (inflight.get(key) === pending) inflight.delete(key);
      });
    inflight.set(key, pending);
  }
  return pending;
}

export const hasLoaded = (key: string): boolean => resolved.has(key);

export function prefetchLoaded<T>(key: string, run: () => Promise<T>): void {
  void loadShared(key, run).catch(() => {});
}

export type Loaded<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

const failure = (error: unknown) => ({
  status: "error" as const,
  message: error instanceof Error ? error.message : String(error),
});

// One load per key across every card that shows it; `run` only closes over what `key` already describes.
export function useLoaded<T>(key: string, enabled: boolean, run: () => Promise<T>): [Loaded<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const reloads = useSyncExternalStore(subscribe, currentGeneration, currentGeneration);
  const latestRun = useRef(run);
  latestRun.current = run;
  const [entry, setEntry] = useState<{ key: string; state: Loaded<T> }>(() => ({
    key,
    state: (resolved.get(key) as Ready<T> | undefined) ?? { status: "idle" },
  }));
  useEffect(() => {
    const setState = (state: Loaded<T>) => setEntry({ key, state });
    const cached = resolved.get(key) as Ready<T> | undefined;
    if (cached !== undefined) {
      setState(cached);
      return;
    }
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    let current = true;
    setState({ status: "loading" });
    loadShared(key, () => latestRun.current()).then(
      (value) => {
        if (current) setState({ status: "ready", value });
      },
      (error: unknown) => {
        if (current) setState(failure(error));
      },
    );
    return () => {
      current = false;
    };
  }, [key, enabled, attempt, reloads]);
  return [entry.key === key ? entry.state : { status: "idle" }, () => setAttempt((count) => count + 1)];
}
