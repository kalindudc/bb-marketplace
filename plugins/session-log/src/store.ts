import { applyDelta, prependOlderRows, spliceLatestWindow } from "./merge";
import type { ActiveThinking, SessionLogSdk, TimelineResponse, TimelineRow } from "./types";

export interface SessionLogSnapshot {
  status: "loading" | "ready" | "error";
  rows: readonly TimelineRow[];
  activeThinking: ActiveThinking | null;
  projectId: string | null;
  error: string | null;
}

export interface SessionLogStore {
  getSnapshot(): SessionLogSnapshot;
  subscribe(listener: () => void): () => void;
  retry(): void;
  dispose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSessionLogStore(options: {
  sdk: SessionLogSdk;
  threadId: string;
  refreshIntervalMs?: number;
}): SessionLogStore {
  const { sdk, threadId } = options;
  const refreshIntervalMs = options.refreshIntervalMs ?? 500;
  const listeners = new Set<() => void>();
  let snapshot: SessionLogSnapshot = {
    status: "loading",
    rows: [],
    activeThinking: null,
    projectId: null,
    error: null,
  };
  let disposed = false;
  let generation = 0;
  let busy = false;
  let reloadRequested = false;
  let refreshRequested = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRequestEndedAt = 0;
  let latestMaxSeq: number | null = null;
  let latestWindow: readonly TimelineRow[] | null = null;
  let projectPromise: Promise<string> | null = null;

  const isCurrent = (requestGeneration: number) => !disposed && generation === requestGeneration;
  const publish = (next: SessionLogSnapshot) => {
    if (
      snapshot.status === next.status && snapshot.rows === next.rows &&
      snapshot.activeThinking === next.activeThinking && snapshot.projectId === next.projectId &&
      snapshot.error === next.error
    ) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const update = (change: Partial<SessionLogSnapshot>) => publish({ ...snapshot, ...change });
  const requestTimeline = async (
    query: Omit<Parameters<SessionLogSdk["threads"]["timeline"]>[0], "threadId" | "includeNestedRows">,
  ): Promise<TimelineResponse> => {
    try {
      return await sdk.threads.timeline({ threadId, includeNestedRows: "true", ...query });
    } finally {
      lastRequestEndedAt = Date.now();
    }
  };

  async function walkPages(): Promise<{ latest: TimelineResponse; rows: readonly TimelineRow[] }> {
    const latest = await requestTimeline({});
    let rows: readonly TimelineRow[] = latest.rows;
    let cursor = latest.timelinePage.olderCursor;
    while (cursor !== null) {
      const page = await requestTimeline({
        beforeAnchorId: cursor.anchorId,
        beforeAnchorSeq: String(cursor.anchorSeq),
      });
      rows = prependOlderRows(page.rows, rows);
      cursor = page.timelinePage.olderCursor;
    }
    return { latest, rows };
  }

  async function load(requestGeneration: number): Promise<void> {
    try {
      projectPromise ??= sdk.threads.get({ threadId })
        .then((thread) => thread.projectId)
        .catch((error: unknown) => { projectPromise = null; throw error; });
      const projectId = await projectPromise;
      if (!isCurrent(requestGeneration)) return;

      let result: Awaited<ReturnType<typeof walkPages>>;
      try {
        result = await walkPages();
      } catch (error) {
        if (!isCurrent(requestGeneration)) return;
        result = await walkPages();
      }
      if (!isCurrent(requestGeneration)) return;
      latestWindow = result.latest.rows;
      latestMaxSeq = result.latest.maxSeq;
      update({
        status: "ready",
        rows: result.rows,
        activeThinking: result.latest.activeThinking,
        projectId,
        error: null,
      });
    } catch (error) {
      if (isCurrent(requestGeneration)) update({ status: "error", error: errorMessage(error) });
    }
  }

  async function refresh(requestGeneration: number): Promise<void> {
    if (latestMaxSeq === null || latestWindow === null) return;
    try {
      let response = await requestTimeline({ afterSequence: String(latestMaxSeq) });
      if (!isCurrent(requestGeneration)) return;
      // The server's delta is relative to the latest window, not to all paginated rows.
      let window = response.delta ? applyDelta(latestWindow, response.delta) : response.rows;
      if (window === null) {
        response = await requestTimeline({});
        if (!isCurrent(requestGeneration)) return;
        window = response.rows;
      }
      const rows = spliceLatestWindow(snapshot.rows, window, response.timelinePage);
      if (rows === null) {
        requestReload();
        return;
      }
      latestWindow = window;
      latestMaxSeq = response.maxSeq;
      update({ status: "ready", rows, activeThinking: response.activeThinking, error: null });
    } catch (error) {
      if (isCurrent(requestGeneration)) update({ status: "ready", error: errorMessage(error) });
    }
  }

  function pump(): void {
    if (disposed || busy || refreshTimer !== null) return;
    if (reloadRequested) {
      reloadRequested = false;
      busy = true;
      const requestGeneration = generation;
      update({ status: "loading", error: null });
      void load(requestGeneration).finally(() => { busy = false; pump(); });
      return;
    }
    if (!refreshRequested || latestMaxSeq === null || snapshot.status !== "ready") return;
    const delay = Math.max(0, lastRequestEndedAt + refreshIntervalMs - Date.now());
    if (delay > 0) {
      refreshTimer = setTimeout(() => { refreshTimer = null; pump(); }, delay);
      return;
    }
    refreshRequested = false;
    busy = true;
    const requestGeneration = generation;
    void refresh(requestGeneration).finally(() => { busy = false; pump(); });
  }

  function requestReload(): void {
    if (disposed) return;
    generation++;
    reloadRequested = true;
    refreshRequested = false;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    pump();
  }

  function requestRefresh(): void {
    if (disposed) return;
    refreshRequested = true;
    pump();
  }

  const unsubscribeThread = sdk.subscribe({
    event: "thread:changed",
    threadId,
    callback(event) {
      if (event.changes.includes("history-rewritten") || event.changes.includes("history-compacted")) {
        requestReload();
      } else if (event.changes.includes("events-appended")) {
        requestRefresh();
      }
    },
  });
  const unsubscribeConnection = sdk.subscribe({
    event: "realtime:connection",
    callback(event) { if (event.reconnected) requestRefresh(); },
  });
  requestReload();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    retry() { if (snapshot.status === "error") requestReload(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
      unsubscribeThread();
      unsubscribeConnection();
      listeners.clear();
    },
  };
}
