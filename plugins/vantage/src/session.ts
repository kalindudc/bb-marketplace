import { useEffect, useState, useSyncExternalStore } from "react";
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { OverviewTarget, rpcContract } from "./contract";
import { createVantageStore, type VantageSnapshot, type VantageStore } from "./store";

// The page and its sidebar, title bar and Agent tab are separate React trees, and so are a thread's tab, composer segment
// and Info section. Each surface shares one store per target; it outlives its last reader briefly, so moving between
// views does not load everything again.
export type Surface = "page" | "thread";

const LINGER_MS = 30_000;
export const EMPTY_SNAPSHOT: VantageSnapshot = { status: "loading", overview: null, scope: "uncommitted", refreshing: false, error: null };

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Sdk = ReturnType<typeof useSdk>;
interface Entry { store: VantageStore; refs: number; timer: ReturnType<typeof setTimeout> | null; client: { rpc: Rpc; sdk: Sdk } }

const entries = new Map<string, Entry>();

export const sessionKey = (surface: Surface, target: OverviewTarget): string =>
  `${surface}\0${target.kind === "tree" ? `tree\0${target.threadId}` : "all"}`;

function acquire(key: string, target: OverviewTarget, includeArchived: boolean, rpc: Rpc, sdk: Sdk): Entry {
  let entry = entries.get(key);
  if (entry === undefined) {
    const client = { rpc, sdk };
    const store = createVantageStore({
      rpc: { call: (method, input) => client.rpc.call(method, input) },
      sdk: { subscribe: (options) => client.sdk.subscribe(options) },
      target,
      includeArchived,
    });
    entry = { store, refs: 0, timer: null, client };
    entries.set(key, entry);
  }
  entry.client.rpc = rpc;
  entry.client.sdk = sdk;
  entry.refs++;
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
  return entry;
}

function release(key: string, entry: Entry): void {
  entry.refs--;
  if (entry.refs > 0 || entry.timer !== null) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.refs > 0 || entries.get(key) !== entry) return;
    entries.delete(key);
    entry.store.dispose();
  }, LINGER_MS);
}

// Tests mount and unmount many surfaces; this drops every store at once.
export function disposeSessions(): void {
  for (const entry of entries.values()) {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.store.dispose();
  }
  entries.clear();
}

export function useSession(surface: Surface, target: OverviewTarget | null, includeArchived: boolean): { store: VantageStore | null; snapshot: VantageSnapshot } {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const key = target === null ? null : sessionKey(surface, target);
  const [entry, setEntry] = useState<{ key: string; entry: Entry } | null>(null);
  useEffect(() => {
    if (key === null || target === null) return;
    const acquired = acquire(key, target, includeArchived, rpc, sdk);
    setEntry({ key, entry: acquired });
    return () => release(key, acquired);
    // The entry follows the key; the archived choice is applied below without replacing it.
  }, [key]);
  const store = entry !== null && entry.key === key ? entry.entry.store : null;
  useEffect(() => { store?.setIncludeArchived(includeArchived); }, [store, includeArchived]);
  const snapshot = useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => {}),
    () => store?.getSnapshot() ?? EMPTY_SNAPSHOT,
    () => store?.getSnapshot() ?? EMPTY_SNAPSHOT,
  );
  return { store, snapshot };
}

// A small shared value with listeners, for state two separate React trees both read.
export function createShared<T>(initial: T, persist?: { win: Window; key: string; parse(raw: string): T | null }) {
  let value = initial;
  if (persist !== undefined) {
    const raw = persist.win.localStorage.getItem(persist.key);
    const parsed = raw === null ? null : persist.parse(raw);
    if (parsed !== null) value = parsed;
  }
  const listeners = new Set<() => void>();
  return {
    get: (): T => value,
    set(next: T): void {
      if (Object.is(next, value)) return;
      value = next;
      if (persist !== undefined) persist.win.localStorage.setItem(persist.key, String(next));
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type Shared<T> = ReturnType<typeof createShared<T>>;

export function useShared<T>(shared: Shared<T>): T {
  return useSyncExternalStore(shared.subscribe, shared.get, shared.get);
}
