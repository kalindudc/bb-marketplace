import { REQUEST_EVENT_TYPES, applyRequestEvents, type HiddenMessage } from "./hidden";
import { applyWindowDelta, prependOlderRows, spliceLatestWindow, windowOf, type LatestWindow } from "./merge";
import type { ActiveThinking, SessionLogSdk, ThreadEventRow, TimelinePage, TimelineResponse, TimelineRow } from "./types";

export interface SessionLogSnapshot {
  status: "loading" | "ready" | "error";
  /** The latest window and every older page read since, oldest first. */
  rows: readonly TimelineRow[];
  /** Input bb gave the agent but left out of the timeline, ordered by seq, for the loaded rows only. */
  hidden: readonly HiddenMessage[];
  activeThinking: ActiveThinking | null;
  projectId: string | null;
  error: string | null;
  /** Why hidden messages could not be read; the rest of the log still works. */
  hiddenError: string | null;
  /** bb holds rows older than the oldest loaded one. */
  hasOlder: boolean;
  loadingOlder: boolean;
  /** Why the last older page could not be read; older pages wait until `loadOlder` is called again. */
  olderError: string | null;
}

type OlderCursor = NonNullable<TimelinePage["olderCursor"]>;

// The most bb's thread events endpoint returns at once (THREAD_EVENT_LIST_PAGE_SIZE).
const EVENT_PAGE_SIZE = 100;
// bb builds the whole latest window for every refresh, blocking its event loop while it does, so the
// log waits at least four times as long as the last request took: at most a fifth of the server's time.
const REQUEST_COST_FACTOR = 4;
// Older pages are read for someone who is waiting, so they get half of the server's time.
const OLDER_COST_FACTOR = 1;
const MAX_REFRESH_INTERVAL_MS = 5_000;

type WindowQuery = Pick<Parameters<SessionLogSdk["threads"]["timeline"]>[0], "beforeAnchorId" | "beforeAnchorSeq">;

export interface SessionLogStore {
  getSnapshot(): SessionLogSnapshot;
  subscribe(listener: () => void): () => void;
  /** While false, the store neither loads nor refreshes; it catches up once it is true again. */
  setVisible(visible: boolean): void;
  /** Reads the next older page, and clears an older-page error so reading can go on. */
  loadOlder(): void;
  /** While true, reads older pages one after another until the whole session is loaded. */
  setLoadAll(loadAll: boolean): void;
  retry(): void;
  dispose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const beforeCursor = (cursor: OlderCursor): WindowQuery => ({
  beforeAnchorId: cursor.anchorId,
  beforeAnchorSeq: String(cursor.anchorSeq),
});

export function createSessionLogStore(options: {
  sdk: SessionLogSdk;
  threadId: string;
  refreshIntervalMs?: number;
  visible?: boolean;
}): SessionLogStore {
  const { sdk, threadId } = options;
  const refreshIntervalMs = options.refreshIntervalMs ?? 500;
  let visible = options.visible ?? true;
  const listeners = new Set<() => void>();
  let snapshot: SessionLogSnapshot = {
    status: "loading",
    rows: [],
    hidden: [],
    activeThinking: null,
    projectId: null,
    error: null,
    hiddenError: null,
    hasOlder: false,
    loadingOlder: false,
    olderError: null,
  };
  let disposed = false;
  let generation = 0;
  let busy = false;
  let reloadRequested = false;
  let refreshRequested = false;
  let olderWanted: "none" | "one" | "all" = "none";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRequestEndedAt = 0;
  let lastRequestMs = 0;
  let latestWindow: LatestWindow | null = null;
  // The cursor for the page before the oldest loaded row; rows from its anchor on are loaded.
  let oldestCursor: OlderCursor | null = null;
  let projectPromise: Promise<string> | null = null;

  // Request events are read newest first, back to the oldest loaded row, and then forward as they arrive.
  let requestEvents: readonly ThreadEventRow[] = [];
  let allHidden: readonly HiddenMessage[] = [];
  // Null until the newest request events have been read.
  let newestEventSeq: number | null = null;
  // Every request event from this seq on has been read.
  let oldestEventSeq = Infinity;
  let shownHidden: { all: readonly HiddenMessage[]; from: number | null; hidden: readonly HiddenMessage[] } | null = null;

  const isCurrent = (requestGeneration: number) => !disposed && generation === requestGeneration;
  const publish = (next: SessionLogSnapshot) => {
    if ((Object.keys(next) as (keyof SessionLogSnapshot)[]).every((key) => snapshot[key] === next[key])) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const update = (change: Partial<SessionLogSnapshot>) => publish({ ...snapshot, ...change });
  const timed = async <T>(request: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await request();
    } finally {
      lastRequestEndedAt = Date.now();
      lastRequestMs = lastRequestEndedAt - startedAt;
    }
  };
  const readWindow = (query: WindowQuery): Promise<TimelineResponse> =>
    timed(() => sdk.threads.timeline({ threadId, includeNestedRows: "true", ...query }));
  const readChanges = (afterTag: string) =>
    timed(() => sdk.threads.timeline({ threadId, includeNestedRows: "true", afterTag }));

  // Hidden messages older than the oldest loaded row would otherwise pile up above it.
  function hiddenForRows(): readonly HiddenMessage[] {
    const from = oldestCursor?.anchorSeq ?? null;
    if (shownHidden?.all === allHidden && shownHidden.from === from) return shownHidden.hidden;
    const kept = from === null ? allHidden : allHidden.filter((message) => message.seq >= from);
    shownHidden = { all: allHidden, from, hidden: kept.length === allHidden.length ? allHidden : kept };
    return shownHidden.hidden;
  }

  async function readEventsAfter(afterSeq: number): Promise<{ events: ThreadEventRow[]; lastSeq: number }> {
    const events: ThreadEventRow[] = [];
    let lastSeq = afterSeq;
    for (;;) {
      const page = await sdk.threads.events.list({
        threadId,
        types: REQUEST_EVENT_TYPES,
        order: "asc",
        limit: String(EVENT_PAGE_SIZE),
        afterSeq: String(lastSeq),
      });
      events.push(...page);
      lastSeq = page.at(-1)?.seq ?? lastSeq;
      if (page.length < EVENT_PAGE_SIZE) return { events, lastSeq };
    }
  }

  /** Reads request events newest first from before `beforeSeq` until it has every one from `downTo` on. */
  async function readEventsBack(
    beforeSeq: number | null, downTo: number,
  ): Promise<{ events: ThreadEventRow[]; complete: boolean }> {
    const events: ThreadEventRow[] = [];
    let before = beforeSeq;
    for (;;) {
      const page = await sdk.threads.events.list({
        threadId,
        types: REQUEST_EVENT_TYPES,
        order: "desc",
        limit: String(EVENT_PAGE_SIZE),
        ...(before === null ? {} : { beforeSeq: String(before) }),
      });
      events.push(...page);
      if (page.length < EVENT_PAGE_SIZE) return { events, complete: true };
      before = page.at(-1)!.seq;
      if (before <= downTo) return { events, complete: false };
    }
  }

  /** Reads request events back far enough to cover rows from `downTo` on; returns false if a reload overtook it. */
  async function coverEvents(requestGeneration: number, downTo: number): Promise<boolean> {
    if (newestEventSeq !== null && oldestEventSeq <= downTo) return true;
    const { events, complete } = await readEventsBack(newestEventSeq === null ? null : oldestEventSeq, downTo);
    if (!isCurrent(requestGeneration)) return false;
    const older = events.reverse();
    newestEventSeq ??= older.at(-1)?.seq ?? 0;
    oldestEventSeq = complete ? -Infinity : older[0]!.seq;
    requestEvents = [...older, ...requestEvents];
    // An acceptance read earlier names a request only now read, so the messages are worked out again.
    allHidden = applyRequestEvents([], requestEvents);
    return true;
  }

  async function refreshHidden(requestGeneration: number): Promise<void> {
    try {
      if (newestEventSeq === null) {
        if (!await coverEvents(requestGeneration, oldestCursor?.anchorSeq ?? -Infinity)) return;
      } else {
        const { events, lastSeq } = await readEventsAfter(newestEventSeq);
        if (!isCurrent(requestGeneration)) return;
        newestEventSeq = lastSeq;
        if (events.length > 0) {
          requestEvents = [...requestEvents, ...events];
          allHidden = applyRequestEvents(allHidden, events);
        }
      }
      update({ hidden: hiddenForRows(), hiddenError: null });
    } catch (error) {
      if (isCurrent(requestGeneration)) update({ hiddenError: errorMessage(error) });
    }
  }

  async function load(requestGeneration: number): Promise<void> {
    try {
      projectPromise ??= sdk.threads.get({ threadId })
        .then((thread) => thread.projectId)
        .catch((error: unknown) => { projectPromise = null; throw error; });
      const projectId = await projectPromise;
      if (!isCurrent(requestGeneration)) return;

      let latest: TimelineResponse;
      try {
        latest = await readWindow({});
      } catch (error) {
        if (!isCurrent(requestGeneration)) return;
        latest = await readWindow({});
      }
      if (!isCurrent(requestGeneration)) return;
      const cursor = latest.timelinePage.olderCursor;
      requestEvents = [];
      allHidden = [];
      newestEventSeq = null;
      oldestEventSeq = Infinity;
      let hiddenError: string | null = null;
      try {
        if (!await coverEvents(requestGeneration, cursor?.anchorSeq ?? -Infinity)) return;
      } catch (error) {
        if (!isCurrent(requestGeneration)) return;
        hiddenError = errorMessage(error);
      }
      latestWindow = windowOf(latest);
      oldestCursor = cursor;
      update({
        status: "ready",
        rows: latest.rows,
        hidden: hiddenForRows(),
        activeThinking: latest.activeThinking,
        projectId,
        error: null,
        hiddenError,
        hasOlder: cursor !== null,
        loadingOlder: false,
        olderError: null,
      });
    } catch (error) {
      if (isCurrent(requestGeneration)) update({ status: "error", error: errorMessage(error) });
    }
  }

  /**
   * bb refuses a cursor once the thread's title or working directory changes, so this walks a fresh
   * chain of pages back to `boundary` and returns the page that reaches past it, cut to the rows before it.
   */
  async function readOlderAgain(requestGeneration: number, boundary: number): Promise<TimelineResponse | null> {
    let page = await readWindow({});
    for (;;) {
      if (!isCurrent(requestGeneration)) return null;
      const cursor = page.timelinePage.olderCursor;
      if (cursor === null || cursor.anchorSeq < boundary) break;
      page = await readWindow(beforeCursor(cursor));
    }
    return { ...page, rows: page.rows.filter((row) => row.sourceSeqStart < boundary) };
  }

  async function loadOlderPage(requestGeneration: number): Promise<void> {
    const cursor = oldestCursor;
    if (cursor === null) return;
    if (olderWanted === "one") olderWanted = "none";
    update({ loadingOlder: true, olderError: null });
    try {
      let page: TimelineResponse | null;
      try {
        page = await readWindow(beforeCursor(cursor));
      } catch {
        if (!isCurrent(requestGeneration)) return;
        page = await readOlderAgain(requestGeneration, cursor.anchorSeq);
      }
      if (page === null || !isCurrent(requestGeneration)) return;
      const next = page.timelinePage.olderCursor;
      let hiddenError = snapshot.hiddenError;
      // Until the newest request events are read, refreshes keep trying that read instead.
      if (newestEventSeq !== null) {
        try {
          if (!await coverEvents(requestGeneration, next?.anchorSeq ?? -Infinity)) return;
        } catch (error) {
          if (!isCurrent(requestGeneration)) return;
          hiddenError = errorMessage(error);
        }
      }
      oldestCursor = next;
      if (next === null) olderWanted = "none";
      update({
        rows: prependOlderRows(page.rows, snapshot.rows),
        hidden: hiddenForRows(),
        hasOlder: next !== null,
        loadingOlder: false,
        hiddenError,
      });
    } catch (error) {
      if (isCurrent(requestGeneration)) update({ loadingOlder: false, olderError: errorMessage(error) });
    }
  }

  async function refresh(requestGeneration: number): Promise<void> {
    const hidden = refreshHidden(requestGeneration);
    await refreshRows(requestGeneration);
    await hidden;
  }

  async function refreshRows(requestGeneration: number): Promise<void> {
    const previous = latestWindow;
    if (previous === null) return;
    try {
      // bb answers with what changed since the window that carried this tag, or with a whole window
      // when it no longer holds that one.
      const response = await readChanges(previous.tag);
      if (!isCurrent(requestGeneration)) return;
      let next: LatestWindow | null;
      // Updates to rows older than the window, counting only the ones that changed since the last refresh.
      let olderRowUpdates: TimelineRow[] | undefined;
      if ("delta" in response) {
        next = applyWindowDelta(previous, response);
        olderRowUpdates = response.delta.fields.timelinePage?.olderRowUpdates ?? undefined;
      } else {
        next = windowOf(response);
        olderRowUpdates = response.timelinePage.olderRowUpdates;
      }
      if (next === null) {
        const whole = await readWindow({});
        if (!isCurrent(requestGeneration)) return;
        next = windowOf(whole);
        olderRowUpdates = whole.timelinePage.olderRowUpdates;
      }
      const rows = spliceLatestWindow(snapshot.rows, next.rows, { ...next.timelinePage, olderRowUpdates });
      if (rows === null) {
        requestReload();
        return;
      }
      latestWindow = next;
      update({ status: "ready", rows, activeThinking: next.activeThinking, error: null });
    } catch (error) {
      if (isCurrent(requestGeneration)) update({ status: "ready", error: errorMessage(error) });
    }
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function run(request: (requestGeneration: number) => Promise<void>): void {
    clearTimer();
    busy = true;
    void request(generation).finally(() => { busy = false; pump(); });
  }

  function pump(): void {
    if (disposed || busy || !visible) return;
    if (reloadRequested) {
      reloadRequested = false;
      update({ status: "loading", error: null, loadingOlder: false });
      run(load);
      return;
    }
    if (latestWindow === null || snapshot.status !== "ready") return;
    const now = Date.now();
    const olderDelay = olderWanted !== "none" && oldestCursor !== null && snapshot.olderError === null
      ? Math.max(0, lastRequestEndedAt + lastRequestMs * OLDER_COST_FACTOR - now) : Infinity;
    const refreshInterval = Math.min(
      MAX_REFRESH_INTERVAL_MS, Math.max(refreshIntervalMs, lastRequestMs * REQUEST_COST_FACTOR),
    );
    const refreshDelay = refreshRequested ? Math.max(0, lastRequestEndedAt + refreshInterval - now) : Infinity;
    if (olderDelay === 0) {
      run(loadOlderPage);
    } else if (refreshDelay === 0) {
      refreshRequested = false;
      run(refresh);
    } else {
      const delay = Math.min(olderDelay, refreshDelay);
      clearTimer();
      if (delay !== Infinity) timer = setTimeout(() => { timer = null; pump(); }, delay);
    }
  }

  function requestReload(): void {
    if (disposed) return;
    generation++;
    reloadRequested = true;
    refreshRequested = false;
    if (olderWanted === "one") olderWanted = "none";
    clearTimer();
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
    setVisible(next) {
      if (visible === next) return;
      visible = next;
      pump();
    },
    loadOlder() {
      if (disposed) return;
      if (olderWanted === "none") olderWanted = "one";
      if (snapshot.olderError !== null) update({ olderError: null });
      pump();
    },
    setLoadAll(loadAll) {
      if (disposed) return;
      if (loadAll) olderWanted = "all";
      else if (olderWanted === "all") olderWanted = "none";
      pump();
    },
    retry() { if (snapshot.status === "error") requestReload(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      clearTimer();
      unsubscribeThread();
      unsubscribeConnection();
      listeners.clear();
    },
  };
}
