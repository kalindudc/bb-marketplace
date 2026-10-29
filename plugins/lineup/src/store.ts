import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { moveModel, setPinned, type CatalogProvider, type LineupState, type ModelRef, type RecentModel, type View } from "./lineup";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export interface Snapshot {
  state: LineupState | null;
  recent: RecentModel[] | null;
  catalog: CatalogProvider[] | null;
}

const CATALOG_TTL_MS = 60_000;

/** One copy per window, shared by every composer's menu and the settings page. */
let snapshot: Snapshot = { state: null, recent: null, catalog: null };
let catalogAt = 0;
let pendingWrites = 0;
/** A read of the state was dropped while a write was on its way; read again once writes finish. */
let staleWhileWriting = false;
let stateLoading: Promise<void> | null = null;
/** Someone asked for the state while a read was running, which may predate their change. */
let stateAgain = false;
/** This window's writes, sent one at a time so the server applies them in the order they were made. */
let writeQueue: Promise<void> = Promise.resolve();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function publish(change: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...change };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function once(key: string, load: () => Promise<void>): Promise<void> {
  let running = inflight.get(key);
  if (running === undefined) {
    running = load().finally(() => inflight.delete(key));
    inflight.set(key, running);
  }
  return running;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** For tests: forget the shared copy. */
export function resetStore(initial: Partial<Snapshot> = {}) {
  snapshot = { state: null, recent: null, catalog: null, ...initial };
  catalogAt = initial.catalog ? Date.now() : 0;
  pendingWrites = 0;
  staleWhileWriting = false;
  stateLoading = null;
  stateAgain = false;
  writeQueue = Promise.resolve();
  inflight.clear();
  listeners.clear();
}

export interface LineupStore extends Snapshot {
  refreshState(): Promise<void>;
  refreshRecent(): Promise<void>;
  refreshCatalog(force?: boolean): Promise<void>;
  setPinned(ref: ModelRef, pinned: boolean): void;
  moveModel(ref: ModelRef, delta: -1 | 1): void;
  setLastView(view: View): void;
}

export function useLineupStore(): LineupStore {
  const rpc: Rpc = useRpc<typeof rpcContract>();
  const current = useSyncExternalStore(subscribe, () => snapshot);

  const refreshState = useCallback((): Promise<void> => {
    if (stateLoading !== null) {
      stateAgain = true;
      return stateLoading;
    }
    stateLoading = (async () => {
      do {
        stateAgain = false;
        try {
          const state = await rpc.call("state", null);
          // A write still on its way would be overwritten by this older read.
          if (pendingWrites === 0) publish({ state });
          else staleWhileWriting = true;
        } catch (cause) {
          toast.error(`Lineup could not load: ${message(cause)}`);
        }
      } while (stateAgain);
    })().finally(() => {
      stateLoading = null;
    });
    return stateLoading;
  }, [rpc]);
  const refreshRecent = useCallback(
    () =>
      once("recent", async () => {
        try {
          publish({ recent: (await rpc.call("recent", null)).models });
        } catch (cause) {
          publish({ recent: snapshot.recent ?? [] });
          toast.error(`Lineup could not read recent models: ${message(cause)}`);
        }
      }),
    [rpc],
  );
  const refreshCatalog = useCallback(
    (force = false) => {
      if (!force && snapshot.catalog !== null && Date.now() - catalogAt < CATALOG_TTL_MS) {
        return Promise.resolve();
      }
      return once("catalog", async () => {
        try {
          const { providers } = await rpc.call("catalog", null);
          catalogAt = Date.now();
          publish({ catalog: providers });
        } catch (cause) {
          publish({ catalog: snapshot.catalog ?? [] });
          toast.error(`Lineup could not load the model list: ${message(cause)}`);
        }
      });
    },
    [rpc],
  );

  /** Show the change at once, then send it after this window's earlier writes. */
  const write = useCallback(
    (change: (state: LineupState) => LineupState, send: () => Promise<LineupState>) => {
      if (snapshot.state === null) return;
      publish({ state: change(snapshot.state) });
      pendingWrites += 1;
      writeQueue = writeQueue.then(() =>
        send().then(
          (saved) => {
            pendingWrites -= 1;
            if (pendingWrites > 0) return;
            publish({ state: saved });
            // Another window's change arrived while this write was on its way, and
            // this reply may predate it.
            if (staleWhileWriting) {
              staleWhileWriting = false;
              void refreshState();
            }
          },
          (cause: unknown) => {
            pendingWrites -= 1;
            toast.error(`Lineup could not save: ${message(cause)}`);
            staleWhileWriting = false;
            void refreshState();
          },
        ),
      );
    },
    [refreshState],
  );
  const pin = useCallback(
    (ref: ModelRef, pinned: boolean) =>
      write(
        (state) => ({ ...state, lineup: setPinned(state.lineup, ref, pinned) }),
        () => rpc.call("pin", { providerId: ref.providerId, model: ref.model, pinned }),
      ),
    [rpc, write],
  );
  const move = useCallback(
    (ref: ModelRef, delta: -1 | 1) =>
      write(
        (state) => ({ ...state, lineup: moveModel(state.lineup, ref, delta) }),
        () => rpc.call("move", { providerId: ref.providerId, model: ref.model, delta }),
      ),
    [rpc, write],
  );
  const setLastView = useCallback(
    (view: View) => {
      if (snapshot.state?.lastView === view) return;
      write((state) => ({ ...state, lastView: view }), () => rpc.call("setLastView", { view }));
    },
    [rpc, write],
  );

  useEffect(() => {
    if (snapshot.state === null) void refreshState();
  }, [refreshState]);
  useRealtime("state-changed", () => {
    void refreshState();
    void refreshRecent();
  });

  return { ...current, refreshState, refreshRecent, refreshCatalog, setPinned: pin, moveModel: move, setLastView };
}
