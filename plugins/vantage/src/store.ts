import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk";
import type { Overview, OverviewInput, Scope } from "./contract";

export interface VantageSnapshot {
  status: "loading" | "ready" | "error";
  overview: Overview | null;
  scope: Scope;
  refreshing: boolean;
  error: string | null;
}

export interface VantageStore {
  getSnapshot(): VantageSnapshot;
  subscribe(listener: () => void): () => void;
  setScope(scope: Scope): void;
  refresh(options?: { hard?: boolean }): void;
  dispose(): void;
}

const DEFAULT_REFRESH_DELAY_MS = 1500;
const THREAD_CHANGES = ["archived-changed", "environment-changed", "parent-changed"];
const ENVIRONMENT_CHANGES = ["work-status-changed", "git-refs-changed", "status-changed"];
const FILE_EVENT_TYPES = ["item/completed", "turn/completed"];

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createVantageStore(options: {
  rpc: { call(method: "overview", input: OverviewInput): Promise<Overview> };
  sdk: Pick<PluginBrowserBbSdk, "subscribe">;
  threadId: string;
  refreshDelayMs?: number;
}): VantageStore {
  const { rpc, sdk, threadId } = options;
  const refreshDelayMs = options.refreshDelayMs ?? DEFAULT_REFRESH_DELAY_MS;
  const listeners = new Set<() => void>();
  let snapshot: VantageSnapshot = { status: "loading", overview: null, scope: "uncommitted", refreshing: false, error: null };
  let disposed = false;
  let generation = 0;
  let running: { generation: number } | null = null;
  let pending: { hard: boolean; urgent: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEndedAt: number | null = null;
  let known: { overview: Overview; threads: Set<string>; environments: Set<string> } | null = null;

  const update = (change: Partial<VantageSnapshot>) => {
    const next = { ...snapshot, ...change };
    if ((Object.keys(next) as (keyof VantageSnapshot)[]).every((key) => next[key] === snapshot[key])) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const ids = () => {
    const overview = snapshot.overview;
    if (overview === null) return null;
    if (known?.overview !== overview) {
      known = {
        overview,
        threads: new Set(overview.threads.map((thread) => thread.id)),
        environments: new Set(overview.environmentIds),
      };
    }
    return known;
  };

  function start(hard: boolean): void {
    const token = { generation };
    running = token;
    update(snapshot.overview === null ? { status: "loading", error: null } : { refreshing: true });
    const input: OverviewInput = { threadId, scope: snapshot.scope, ...(hard ? { refresh: true } : {}) };
    const finish = (change: () => Partial<VantageSnapshot>) => {
      if (disposed || token.generation !== generation) return;
      update(change());
      running = null;
      lastEndedAt = Date.now();
      pump();
    };
    rpc.call("overview", input).then(
      (overview) => finish(() => ({ status: "ready", overview, refreshing: false, error: null })),
      (error: unknown) => finish(() => ({
        status: snapshot.overview === null ? "error" : "ready", refreshing: false, error: errorMessage(error),
      })),
    );
  }

  function pump(): void {
    if (disposed || pending === null || timer !== null) return;
    if (running !== null && running.generation === generation) return;
    const wait = pending.urgent || lastEndedAt === null ? 0 : Math.max(0, lastEndedAt + refreshDelayMs - Date.now());
    if (wait > 0) {
      timer = setTimeout(() => { timer = null; pump(); }, wait);
      return;
    }
    const { hard } = pending;
    pending = null;
    start(hard);
  }

  function request(hard: boolean, urgent: boolean): void {
    if (disposed) return;
    pending = { hard: hard || pending?.hard === true, urgent: urgent || pending?.urgent === true };
    if (urgent && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pump();
  }

  const unsubscribers = [
    sdk.subscribe({
      event: "thread:changed",
      callback(event) {
        if (event.changes.includes("thread-created")) return request(false, false);
        const tree = ids();
        if (event.id === undefined || tree === null || !tree.threads.has(event.id)) return;
        if (event.changes.includes("history-rewritten") || event.changes.includes("history-compacted")) return request(true, false);
        const types = event.metadata?.eventTypes;
        const filesMayHaveChanged = event.changes.includes("events-appended") &&
          (types === undefined || types.some((type) => FILE_EVENT_TYPES.includes(type)));
        if (filesMayHaveChanged || event.changes.some((change) => THREAD_CHANGES.includes(change))) request(false, false);
      },
    }),
    sdk.subscribe({
      event: "environment:changed",
      callback(event) {
        if (event.id === undefined || ids()?.environments.has(event.id) !== true) return;
        if (event.changes.some((change) => ENVIRONMENT_CHANGES.includes(change))) request(false, false);
      },
    }),
    sdk.subscribe({ event: "realtime:connection", callback(event) { if (event.reconnected) request(false, false); } }),
  ];
  request(false, false);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setScope(scope) {
      if (disposed || scope === snapshot.scope) return;
      generation++;
      update({ scope, error: null });
      request(false, true);
    },
    refresh(refreshOptions) {
      request(refreshOptions?.hard === true, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const unsubscribe of unsubscribers) unsubscribe();
      listeners.clear();
    },
  };
}
