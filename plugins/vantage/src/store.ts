import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk";
import { FILE_EVENT_TYPES } from "./event-types";
import type { Overview, OverviewInput, OverviewTarget, Scope, ShellInput } from "./contract";
import { overviewKey } from "./overview-key";

export interface VantageSnapshot {
  status: "loading" | "ready" | "error";
  overview: Overview | null;
  scope: Scope;
  refreshing: boolean;
  error: string | null;
}

export interface VantageStore {
  getSnapshot(): VantageSnapshot;
  getOverviewKey(): string;
  subscribe(listener: () => void): () => void;
  setScope(scope: Scope): void;
  setIncludeArchived(includeArchived: boolean): void;
  refresh(options?: { hard?: boolean }): void;
  catchUp(): void;
  invalidate(): void;
  setActive(active: boolean): void;
  dispose(): void;
}

const TREE_REFRESH_DELAY_MS = 1500;
const TREE_FALLBACK_MS = 30_000;
const WORKING_STATUSES = new Set(["active", "starting", "pending"]);
const ALL_REFRESH_DELAY_MS = 5000;
export const OVERVIEW_INTERVAL_MS = 60_000;
// A slow overview means a loaded machine: wait this many times as long as the last one took before asking again.
const BACKOFF_FACTOR = 1.5;
const MEMBERSHIP_CHANGES = ["archived-changed", "parent-changed"];
const ENVIRONMENT_CHANGES = ["work-status-changed", "git-refs-changed", "status-changed"];

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Switching archived threads on or off changes which rows exist, not the active rows' numbers: keep those on screen, add the
// outline's new rows below them, and drop the rows of threads the outline no longer has. The full result then replaces it all.
export function mergeOutline(current: Overview, outline: Overview): Overview {
  const threadIds = new Set(outline.threads.map((thread) => thread.id));
  const stays = (row: { threadIds: readonly string[] }) =>
    row.threadIds.length === 0 || row.threadIds.some((id) => threadIds.has(id));
  const merge = <T extends { key: string; threadIds: readonly string[] }>(
    shown: readonly T[],
    next: readonly T[],
  ): T[] => {
    const kept = shown.filter(stays);
    const keys = new Set(kept.map((row) => row.key));
    return [...kept, ...next.filter((row) => !keys.has(row.key))];
  };
  const worktrees = merge(current.worktrees, outline.worktrees);
  const worktreeKeys = new Set(worktrees.map((row) => row.key));
  return {
    ...current,
    threads: outline.threads,
    worktrees,
    repos: merge(current.repos, outline.repos),
    sharedFiles: current.sharedFiles
      .map((file) => ({ ...file, worktreeKeys: file.worktreeKeys.filter((key) => worktreeKeys.has(key)) }))
      .filter((file) => file.worktreeKeys.length >= 2),
    environmentIds: [...new Set([...current.environmentIds, ...outline.environmentIds])],
    archivedHidden: outline.archivedHidden,
  };
}

interface StoreCalls {
  shell: ShellInput;
  overview: OverviewInput;
}

export function createVantageStore(options: {
  rpc: { call<M extends keyof StoreCalls>(method: M, input: StoreCalls[M]): Promise<Overview> };
  sdk: Pick<PluginBrowserBbSdk, "subscribe">;
  target: OverviewTarget;
  includeArchived: boolean;
  refreshDelayMs?: number;
  sidebar?: boolean;
  active?: boolean;
  seed?: { overview: Overview; receivedAt: number };
}): VantageStore {
  const { rpc, sdk, target, sidebar, seed } = options;
  let includeArchived = options.includeArchived;
  const everyThread = target.kind === "all";
  const refreshDelayMs = sidebar
    ? OVERVIEW_INTERVAL_MS
    : (options.refreshDelayMs ?? (everyThread ? ALL_REFRESH_DELAY_MS : TREE_REFRESH_DELAY_MS));
  let active = options.active ?? true;
  const listeners = new Set<() => void>();
  let snapshot: VantageSnapshot = {
    status: seed === undefined ? "loading" : "ready",
    overview: seed?.overview ?? null,
    scope: "uncommitted",
    refreshing: false,
    error: null,
  };
  let disposed = false;
  let generation = 0;
  let fullGeneration = seed === undefined ? -1 : 0;
  let running: { generation: number } | null = null;
  let pending: { hard: boolean; urgent: boolean; quiet: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEndedAt: number | null = seed?.receivedAt ?? null;
  let signalQueued = false;
  let staleWhileInactive = false;
  let lastDurationMs = 0;
  let startedAt = 0;
  // Events that arrived while the page was hidden; one refresh runs when it is shown again.
  let missed: { hard: boolean } | null = null;
  let known: { overview: Overview; threads: Set<string>; environments: Set<string> } | null = null;
  // A load (the first one, or one after the scope or the archived choice changed) draws the outline while the full result is read.
  let outlineWanted = !sidebar && seed === undefined;
  // After an archived switch the outline is merged into the rows on screen instead of replacing them.
  let mergeNextOutline = false;

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

  function start(hard: boolean, quiet: boolean): void {
    const token = { generation };
    running = token;
    startedAt = Date.now();
    if (snapshot.overview === null) update({ status: "loading", error: null });
    else if (!quiet || snapshot.overview.partial) update({ refreshing: true });
    const input: OverviewInput = { target, scope: snapshot.scope, includeArchived, ...(hard ? { refresh: true } : {}) };
    let fullArrived = false;
    if (outlineWanted) {
      outlineWanted = false;
      const merging = mergeNextOutline;
      mergeNextOutline = false;
      // A failed outline is ignored: the full result is on its way and paints the same rows.
      rpc.call("shell", { target, includeArchived }).then(
        (outline) => {
          if (disposed || token.generation !== generation || fullArrived) return;
          const shown = snapshot.overview;
          const next =
            merging && shown !== null && !shown.partial
              ? mergeOutline(shown, outline)
              : { ...outline, scope: snapshot.scope };
          update({ status: "ready", overview: next, refreshing: true, error: null });
        },
        () => {},
      );
    }
    const finish = (change: () => Partial<VantageSnapshot>) => {
      fullArrived = true;
      if (disposed || token.generation !== generation) return;
      update(change());
      running = null;
      lastEndedAt = Date.now();
      lastDurationMs = lastEndedAt - startedAt;
      pump();
      scheduleTreeFallback();
    };
    rpc.call("overview", input).then(
      (overview) =>
        finish(() => {
          const shown = snapshot.overview;
          const same =
            shown !== null &&
            fullGeneration === token.generation &&
            shown.generatedAt === overview.generatedAt &&
            shown.scope === overview.scope &&
            shown.partial === overview.partial &&
            shown.warnings.length === overview.warnings.length &&
            shown.warnings.every((warning, index) => warning === overview.warnings[index]);
          fullGeneration = token.generation;
          return { status: "ready", overview: same ? shown : overview, refreshing: false, error: null };
        }),
      (error: unknown) =>
        finish(() => ({
          status: snapshot.overview === null ? "error" : "ready",
          refreshing: false,
          error: errorMessage(error),
        })),
    );
  }

  function pump(): void {
    if (disposed || !active || pending === null || timer !== null) return;
    if (running !== null && running.generation === generation) return;
    if ((sidebar || !pending.urgent) && isHidden()) {
      missed = { hard: pending.hard || missed?.hard === true };
      pending = null;
      return;
    }
    const delayMs = Math.max(refreshDelayMs, BACKOFF_FACTOR * lastDurationMs);
    const wait = pending.urgent || lastEndedAt === null ? 0 : Math.max(0, lastEndedAt + delayMs - Date.now());
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, wait);
      return;
    }
    const { hard, quiet } = pending;
    pending = null;
    start(hard, quiet);
  }

  const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

  function request(hard: boolean, urgent: boolean, quiet = false): void {
    if (disposed) return;
    if (sidebar) urgent = false;
    pending = {
      hard: hard || pending?.hard === true,
      urgent: urgent || pending?.urgent === true,
      quiet: quiet && pending?.quiet !== false,
    };
    if (urgent && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pump();
  }

  let fallback: ReturnType<typeof setTimeout> | undefined;
  function clearTreeFallback() {
    clearTimeout(fallback);
    fallback = undefined;
  }
  function scheduleTreeFallback(workHint = false) {
    if (!workHint) clearTreeFallback();
    if (everyThread || disposed || !active || isHidden() || running !== null || fallback !== undefined) return;
    if (
      !workHint &&
      snapshot.overview?.threads.some((thread) => !thread.archived && WORKING_STATUSES.has(thread.status)) !== true
    )
      return;
    fallback = setTimeout(() => {
      fallback = undefined;
      if (running === null) request(false, true, true);
    }, TREE_FALLBACK_MS);
  }

  let wasHidden = isHidden();
  const onVisibility = () => {
    const hidden = isHidden();
    const shownAgain = wasHidden && !hidden;
    wasHidden = hidden;
    if (hidden) {
      clearTreeFallback();
      return;
    }
    if (!active) return;
    const caughtUp = missed;
    missed = null;
    if (everyThread || shownAgain || caughtUp !== null) request(caughtUp?.hard === true, !everyThread, true);
    scheduleTreeFallback();
  };

  const unsubscribers = [
    sdk.subscribe({
      event: "thread:changed",
      callback(event) {
        if (event.changes.includes("thread-created")) {
          if (everyThread) request(false, false);
          return;
        }
        if (event.id === undefined) return;
        const member = ids()?.threads.has(event.id) === true;
        if (member && (event.changes.includes("history-rewritten") || event.changes.includes("history-compacted")))
          return request(true, false);
        const types = event.metadata?.eventTypes;
        const filesMayHaveChanged =
          event.changes.includes("events-appended") &&
          (types === undefined || types.some((type) => FILE_EVENT_TYPES.includes(type)));
        const status = event.metadata?.statusChange?.status;
        // An idle tree may have timed out of server revalidation before work starts again.
        if (!everyThread && member && (filesMayHaveChanged || (status !== undefined && WORKING_STATUSES.has(status))))
          scheduleTreeFallback(true);
        if (
          (everyThread && filesMayHaveChanged) ||
          ((member || everyThread) && event.changes.some((change) => MEMBERSHIP_CHANGES.includes(change))) ||
          (member && event.changes.includes("environment-changed"))
        )
          request(false, false);
      },
    }),
    sdk.subscribe({
      event: "environment:changed",
      callback(event) {
        if (event.id === undefined || ids()?.environments.has(event.id) !== true) return;
        if (event.changes.some((change) => ENVIRONMENT_CHANGES.includes(change))) request(false, false);
      },
    }),
    sdk.subscribe({
      event: "realtime:connection",
      callback(event) {
        if (event.reconnected) request(false, false);
      },
    }),
  ];
  // A page that stays open keeps up with changes no event announces, such as a file edited by hand.
  let stopWatching = () => {};
  if (typeof document !== "undefined") {
    const heartbeat = everyThread
      ? setInterval(() => {
          if (active && !isHidden()) request(false, false);
        }, OVERVIEW_INTERVAL_MS)
      : null;
    document.addEventListener("visibilitychange", onVisibility);
    stopWatching = () => {
      if (heartbeat !== null) clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }
  if (active && seed === undefined) request(false, true);

  return {
    getSnapshot: () => snapshot,
    getOverviewKey: () => overviewKey({ target, scope: snapshot.scope, includeArchived }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setScope(scope) {
      if (disposed || scope === snapshot.scope) return;
      generation++;
      outlineWanted = true;
      update({ scope, error: null });
      request(false, true);
    },
    setIncludeArchived(next) {
      if (disposed || next === includeArchived) return;
      includeArchived = next;
      generation++;
      outlineWanted = true;
      mergeNextOutline = true;
      update({ error: null });
      request(false, true);
    },
    refresh(refreshOptions) {
      request(refreshOptions?.hard === true, true);
    },
    catchUp() {
      if (active && running === null && !signalQueued && !isHidden()) request(false, true, true);
    },
    invalidate() {
      if (disposed || signalQueued) return;
      if (!active) {
        staleWhileInactive = true;
        return;
      }
      signalQueued = true;
      queueMicrotask(() => {
        signalQueued = false;
        request(false, !isHidden(), true);
      });
    },
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (!active) {
        clearTreeFallback();
        if (timer !== null) clearTimeout(timer);
        timer = null;
        return;
      }
      const stale = lastEndedAt === null || Date.now() - lastEndedAt >= OVERVIEW_INTERVAL_MS;
      if (staleWhileInactive || missed !== null || (running === null && stale)) {
        const hard = missed?.hard === true;
        missed = null;
        staleWhileInactive = false;
        request(hard, false);
      } else pump();
      scheduleTreeFallback();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      clearTreeFallback();
      stopWatching();
      for (const unsubscribe of unsubscribers) unsubscribe();
      listeners.clear();
    },
  };
}
