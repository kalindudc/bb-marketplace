import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRealtime, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { Overview, OverviewTarget, rpcContract } from "./contract";
import { overviewKey } from "./overview-key";
import { writeStorage } from "./remember";
import { createVantageStore, OVERVIEW_INTERVAL_MS, type VantageSnapshot, type VantageStore } from "./store";

// The page and thread slots each share a store; their archive and change-scope choices can differ.
export type Surface = "page" | "thread" | "sidebar";

const MAX_IDLE_SESSIONS = 12;
const MAX_WARM_OVERVIEWS = 12;
export const EMPTY_SNAPSHOT: VantageSnapshot = {
  status: "loading",
  overview: null,
  scope: "uncommitted",
  refreshing: false,
  error: null,
};

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Sdk = ReturnType<typeof useSdk>;
interface Entry {
  store: VantageStore;
  refs: number;
  surface: Surface;
  client: { rpc: Rpc; sdk: Sdk };
}

const entries = new Map<string, Entry>();
const visibleOverviewReady = createShared(true);
let pendingReaderPatches = 0;
const inFlight = new Map<string, Promise<Overview>>();
const warmOverviews = new Map<string, { overview: Overview; receivedAt: number }>();

function updateVisibleOverviewReady(): void {
  if (pendingReaderPatches > 0) {
    visibleOverviewReady.set(false);
    return;
  }
  for (const { refs, surface, store } of entries.values()) {
    if (refs === 0 || surface === "sidebar") continue;
    const { overview, error, refreshing } = store.getSnapshot();
    if ((overview === null || overview.partial) && (error === null || refreshing)) {
      visibleOverviewReady.set(false);
      return;
    }
  }
  visibleOverviewReady.set(true);
}

export const useVisibleOverviewReady = () => useShared(visibleOverviewReady);

export function useReaderPatchPending(pending: boolean) {
  useLayoutEffect(() => {
    if (!pending) return;
    pendingReaderPatches++;
    updateVisibleOverviewReady();
    return () => {
      pendingReaderPatches--;
      updateVisibleOverviewReady();
    };
  }, [pending]);
}

export const sessionKey = (surface: Surface, target: OverviewTarget): string =>
  `${surface}\0${target.kind === "tree" ? `tree\0${target.threadId}` : "all"}`;

const readKey = (method: string, input: object) => JSON.stringify([method, input]);

// Full screen and the thread panel can ask for the same data without sharing their UI preferences.
function sharedRead(key: string, run: () => Promise<Overview>, warmKey: string | null): Promise<Overview> {
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  const read = run();
  inFlight.set(key, read);
  const finish = (overview?: Overview) => {
    if (inFlight.get(key) !== read) return;
    inFlight.delete(key);
    if (warmKey === null || overview === undefined || overview.partial) return;
    const previous = warmOverviews.get(warmKey);
    if (previous !== undefined && previous.overview.generatedAt > overview.generatedAt) return;
    warmOverviews.delete(warmKey);
    warmOverviews.set(warmKey, { overview, receivedAt: Date.now() });
    if (warmOverviews.size > MAX_WARM_OVERVIEWS) warmOverviews.delete(warmOverviews.keys().next().value!);
  };
  void read.then(finish, () => finish());
  return read;
}

function acquire(
  key: string,
  surface: Surface,
  target: OverviewTarget,
  includeArchived: boolean,
  rpc: Rpc,
  sdk: Sdk,
): Entry {
  let entry = entries.get(key);
  if (entry === undefined) {
    const client = { rpc, sdk };
    const sidebar = surface === "sidebar";
    const warm = sidebar
      ? undefined
      : warmOverviews.get(overviewKey({ target, scope: "uncommitted", includeArchived }));
    const store = createVantageStore({
      rpc: {
        call: (method, input) =>
          sharedRead(
            readKey(method, input),
            () => client.rpc.call(method, input),
            !sidebar && "scope" in input ? overviewKey(input) : null,
          ),
      },
      sdk: { subscribe: (options) => client.sdk.subscribe(options) },
      target,
      includeArchived,
      sidebar,
      active: false,
      ...(warm !== undefined && Date.now() - warm.receivedAt < OVERVIEW_INTERVAL_MS ? { seed: warm } : {}),
    });
    store.subscribe(updateVisibleOverviewReady);
    entry = { store, refs: 0, surface, client };
  }
  entries.delete(key);
  entries.set(key, entry);
  entry.client.rpc = rpc;
  entry.client.sdk = sdk;
  if (entry.refs++ === 0) {
    entry.store.setActive(true);
    updateVisibleOverviewReady();
  }
  return entry;
}

function release(entry: Entry): void {
  if (--entry.refs > 0) return;
  entry.store.setActive(false);
  const idle = [...entries].filter(([, candidate]) => candidate.refs === 0 && candidate.surface !== "sidebar");
  for (const [key, candidate] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_SESSIONS))) {
    entries.delete(key);
    candidate.store.dispose();
  }
  updateVisibleOverviewReady();
}

// Tests mount and unmount many surfaces; this drops every store at once.
export function disposeSessions(): void {
  for (const entry of entries.values()) entry.store.dispose();
  entries.clear();
  inFlight.clear();
  warmOverviews.clear();
  visibleOverviewReady.set(true);
}

export function useSession(
  surface: Surface,
  target: OverviewTarget | null,
  includeArchived: boolean,
  { syncArchives = true, load = true }: { syncArchives?: boolean; load?: boolean } = {},
): { store: VantageStore | null; snapshot: VantageSnapshot } {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const key = target === null ? null : sessionKey(surface, target);
  const [entry, setEntry] = useState<{ key: string; entry: Entry } | null>(null);
  const latest = useRef({ target, includeArchived, rpc, sdk });
  latest.current = { target, includeArchived, rpc, sdk };
  useEffect(() => {
    if (!load || key === null) return;
    let acquired: Entry | undefined;
    let released = false;
    const start = () => {
      const current = latest.current;
      if (released || current.target === null) return;
      acquired = acquire(key, surface, current.target, current.includeArchived, current.rpc, current.sdk);
      setEntry({ key, entry: acquired });
    };
    let frame: number | undefined;
    if (surface === "sidebar") {
      // Give a newly visible reader time to commit its first diff before starting background work.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (visibleOverviewReady.get()) start();
        });
      });
    } else start();
    return () => {
      released = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (acquired !== undefined) release(acquired);
    };
  }, [key, surface, load]);
  const store = key === null ? null : entry?.key === key ? entry.entry.store : (entries.get(key)?.store ?? null);
  useEffect(() => {
    if (syncArchives) store?.setIncludeArchived(includeArchived);
  }, [store, includeArchived, syncArchives]);
  useRealtime("vantage:settings", () => {
    warmOverviews.clear();
    store?.invalidate();
  });
  useRealtime("vantage:overview", (payload) => {
    if (typeof payload !== "object" || payload === null || !("key" in payload) || typeof payload.key !== "string")
      return;
    warmOverviews.delete(payload.key);
    if (store?.getOverviewKey() === payload.key) store.invalidate();
  });
  const snapshot = useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => {}),
    () => store?.getSnapshot() ?? EMPTY_SNAPSHOT,
    () => store?.getSnapshot() ?? EMPTY_SNAPSHOT,
  );
  return { store, snapshot };
}

// A small shared value with listeners, for state two separate React trees both read.
export function createShared<T>(initial: T, persist?: { win: Window; key: string; parse(raw: string): T | null }) {
  const stored = (): T => {
    if (persist === undefined) return initial;
    const raw = persist.win.localStorage.getItem(persist.key);
    const parsed = raw === null ? null : persist.parse(raw);
    return parsed ?? initial;
  };
  let value = stored();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const reload = (): void => {
    const next = stored();
    if (Object.is(next, value)) return;
    value = next;
    notify();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === persist?.key || event.key === null) reload();
  };
  return {
    get: (): T => value,
    set(next: T): void {
      if (Object.is(next, value)) return;
      value = next;
      notify();
      if (persist !== undefined) writeStorage(persist.win, persist.key, String(next));
    },
    reload,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (persist !== undefined && listeners.size === 1) persist.win.addEventListener("storage", onStorage);
      return () => {
        if (!listeners.delete(listener)) return;
        if (persist !== undefined && listeners.size === 0) persist.win.removeEventListener("storage", onStorage);
      };
    },
  };
}

export type Shared<T> = ReturnType<typeof createShared<T>>;

export function useShared<T>(shared: Shared<T>): T {
  return useSyncExternalStore(shared.subscribe, shared.get, shared.get);
}
