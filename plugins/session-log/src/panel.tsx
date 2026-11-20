import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";
import {
  experimental_copyToClipboard, experimental_Icon as Icon, experimental_useTabVisible, useBbNavigate, useSdk,
} from "@get-bb/plugin-sdk/app";
import { consumePanelFocus, onPanelFocusRequest } from "./commands";
import {
  collectTurnStats, previewLines, toLogEntries, type EntryCategory, type LogEntry, type TurnStats,
} from "./entries";
import { LogRow } from "./log-row";
import type { ExpandedPreference } from "./preference";
import {
  findMatches, indexOfMatch, positionOf, publishHighlights, type MatchPosition, type SearchMatch,
} from "./search";
import { DEFAULT_SETTINGS } from "./settings";
import { createSessionLogStore, type SessionLogSnapshot, type SessionLogStore } from "./store";
import { useSessionLogSettings } from "./use-settings";
import {
  LATEST_WINDOW, holdWindow, resolveRange, rowsAfter, sameWindow, windowAround, windowDown, windowUp,
  windowWith, type RenderWindow,
} from "./window";

const EMPTY_SNAPSHOT: SessionLogSnapshot = {
  status: "loading", rows: [], hidden: [], activeThinking: null, projectId: null, error: null, hiddenError: null,
  hasOlder: false, loadingOlder: false, olderError: null,
};

const CHIPS: ReadonlyArray<[EntryCategory, string]> = [
  ["message", "Messages"], ["thinking", "Thinking"], ["tool", "Tools"], ["hidden", "Hidden"],
];

// bb's own sticky scrollers use the same threshold and intent window (useStickyBottomScroll).
const STICKY_BOTTOM_THRESHOLD_PX = 4;
const USER_SCROLL_INTENT_MS = 350;
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", " "]);
const NO_MATCH = { count: 0, index: null, entryId: null } as const;
// The log never draws more than this many pages of rows; reading further drops rows from the far end.
const MAX_PAGES_DRAWN = 4;

interface MatchState {
  count: number;
  index: number | null;
  entryId: string | null;
}

// `more` says some matching rows are not drawn or not loaded yet, so the count is a floor.
function matchLabel({ count, index }: MatchState, more: boolean): string {
  if (count === 0) return more ? "Searching…" : "No matches";
  const total = more ? `${count}+` : String(count);
  return index === null ? `${total} ${count === 1 && !more ? "match" : "matches"}` : `${index + 1} of ${total}`;
}

const isReply = (entry: LogEntry) => entry.row.kind === "conversation" && entry.row.role === "assistant";

// Without a current match, search runs from the row the reader moved to, wrapping at the ends;
// while the cursor follows the newest row, it starts from the first or last match.
function firstMatchFrom(
  matches: readonly SearchMatch[], rowOf: (match: SearchMatch) => number, cursor: number | undefined, direction: 1 | -1,
): number {
  const last = matches.length - 1;
  if (cursor !== undefined) {
    for (let step = 0; step <= last; step++) {
      const index = direction > 0 ? step : last - step;
      const row = rowOf(matches[index]!);
      if (direction > 0 ? row >= cursor : row <= cursor) return index;
    }
  }
  return direction > 0 ? 0 : last;
}

// Centers a match in the list, or shows the top of one taller than the list.
function centerInList(list: HTMLElement, target: DOMRect): void {
  const view = list.getBoundingClientRect();
  const margin = target.height > list.clientHeight ? 8 : (list.clientHeight - target.height) / 2;
  const delta = target.top - view.top - margin;
  if (Math.abs(delta) >= 1) list.scrollTop += delta;
}

function isDefaultExpanded(entry: LogEntry, expandFailures: boolean): boolean {
  return expandFailures && entry.isError && entry.row.kind === "work" &&
    (entry.row.workKind === "command" || entry.row.workKind === "tool");
}

function isShown(
  entry: LogEntry, filters: Record<EntryCategory, boolean>, errorsOnly: boolean, needle: string,
): boolean {
  // Errors keeps dividers as context, except hidden ones the reader has filtered out.
  const context = errorsOnly && entry.divider !== null && entry.category !== "hidden";
  if (!filters[entry.category] && !context) return false;
  if (errorsOnly && !entry.isError && !entry.divider) return false;
  return !needle || entry.searchText.includes(needle);
}

function chatHref(entry: LogEntry, projectId: string | null, threadId: string): string | null {
  if (entry.messageSeq === null || entry.row.kind !== "conversation" || projectId === null) return null;
  const path = projectId === "proj_personal"
    ? `/threads/${threadId}` : `/projects/${projectId}/threads/${threadId}`;
  return `${path}#msg=${entry.messageSeq}`;
}

export function SessionLogPanel({ threadId, preference }: { threadId: string; preference: ExpandedPreference }) {
  const sdk = useSdk();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const navigate = useBbNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // bb keeps a closed panel's tab mounted, so the log stops reading the thread until it shows again.
  const tabVisible = experimental_useTabVisible();
  const tabVisibleRef = useRef(tabVisible);
  tabVisibleRef.current = tabVisible;
  const [mountedStore, setMountedStore] = useState<{ threadId: string; store: SessionLogStore } | null>(null);
  const store = mountedStore?.threadId === threadId ? mountedStore.store : null;
  const storeRef = useRef(store);
  storeRef.current = store;

  const [renderWindow, setRenderWindow] = useState<RenderWindow>(LATEST_WINDOW);
  const windowRef = useRef(renderWindow);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const trackNewestRef = useRef(true);

  useEffect(() => {
    const next = createSessionLogStore({ sdk: sdkRef.current, threadId, visible: tabVisibleRef.current });
    setMountedStore({ threadId, store: next });
    // Another thread's log opens on its newest rows.
    windowRef.current = LATEST_WINDOW;
    setRenderWindow(LATEST_WINDOW);
    followingRef.current = true;
    trackNewestRef.current = true;
    setFollowing(true);
    return () => next.dispose();
  }, [threadId]);
  useEffect(() => { store?.setVisible(tabVisible); }, [store, tabVisible]);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store]);
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? EMPTY_SNAPSHOT, [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const expandedView = useSyncExternalStore(preference.subscribe, preference.isExpanded);
  const settings = useSessionLogSettings();
  const effectiveSettings = settings ?? DEFAULT_SETTINGS;
  const pageRows = effectiveSettings.rowsPerPage;
  const maxRows = pageRows * MAX_PAGES_DRAWN;
  const pageRowsRef = useRef(pageRows);
  pageRowsRef.current = pageRows;
  const maxRowsRef = useRef(maxRows);
  maxRowsRef.current = maxRows;

  // The chips start from the settings; once the reader toggles one, their choice wins.
  const [chosenFilters, setChosenFilters] = useState<Record<EntryCategory, boolean> | null>(null);
  const filters = useMemo<Record<EntryCategory, boolean>>(() => chosenFilters ?? {
    message: effectiveSettings.showMessages, thinking: effectiveSettings.showThinking, tool: effectiveSettings.showTools,
    hidden: effectiveSettings.showHidden,
  }, [chosenFilters, effectiveSettings]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [helpVisible, setHelpVisible] = useState(false);
  const [matchState, setMatchState] = useState<MatchState>(NO_MATCH);
  const [highlightOwner] = useState(() => ({}));
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  // `g` waits for the whole session to load before it moves to the first row.
  const [wantFirst, setWantFirst] = useState(false);
  const pausedNewestIdRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<SearchMatch[]>([]);
  const currentMatchRef = useRef<MatchPosition | null>(null);
  const pendingMatchStepRef = useRef<1 | -1 | null>(null);
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const pointerScrollRef = useRef(false);
  const scrollIntentUntilRef = useRef(0);
  const trackingFocusRef = useRef(false);
  const afterDrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(rawQuery.trim()), 150);
    return () => window.clearTimeout(timer);
  }, [rawQuery]);
  useEffect(() => preference.subscribe(() => setOverrides(new Map())), [preference]);
  useEffect(() => {
    const focusIfRequested = () => {
      if (consumePanelFocus(threadId)) rootRef.current?.focus();
    };
    const unsubscribe = onPanelFocusRequest(focusIfRequested);
    focusIfRequested();
    return unsubscribe;
  }, [threadId]);

  const entries = useMemo(() => toLogEntries(snapshot.rows, snapshot.hidden), [snapshot.rows, snapshot.hidden]);
  const entryOrder = useMemo(() => new Map(entries.map((entry, index) => [entry.id, index])), [entries]);
  const entryOrderRef = useRef(entryOrder);
  entryOrderRef.current = entryOrder;
  const turnStatsRef = useRef<ReadonlyMap<string, TurnStats>>(new Map());
  // Reuses each divider's stats object while its numbers hold, so a refresh does not redraw every divider.
  const turnStats = useMemo(() => collectTurnStats(entries, turnStatsRef.current), [entries]);
  turnStatsRef.current = turnStats;
  const normalizedQuery = query.toLowerCase();
  const visible = useMemo(
    () => entries.filter((entry) => isShown(entry, filters, errorsOnly, normalizedQuery)),
    [entries, errorsOnly, filters, normalizedQuery],
  );
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const range = useMemo(
    () => resolveRange(renderWindow, visible, entryOrder, pageRows, maxRows),
    [renderWindow, visible, entryOrder, pageRows, maxRows],
  );
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const drawn = useMemo(() => visible.slice(range.start, range.end), [visible, range.start, range.end]);
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;
  const drawsNewest = range.end >= visible.length;
  const focusedIdRef = useRef(focusedId);
  focusedIdRef.current = focusedId;
  const expandedRef = useRef(expandedView);
  expandedRef.current = expandedView;
  const queryRef = useRef(query);
  queryRef.current = query;
  const expandFailuresRef = useRef(effectiveSettings.expandFailures);
  expandFailuresRef.current = effectiveSettings.expandFailures;

  useEffect(() => {
    if (trackNewestRef.current || !visible.some((entry) => entry.id === focusedIdRef.current)) {
      trackNewestRef.current = true;
      const newestId = visible.at(-1)?.id ?? null;
      const active = document.activeElement;
      const rowHasFocus = active instanceof HTMLElement && active.dataset.entryId !== undefined &&
        active.dataset.entryId !== newestId && rootRef.current?.contains(active) === true;
      focusedIdRef.current = newestId;
      setFocusedId(newestId);
      if (rowHasFocus && newestId !== null) {
        // Keyboard focus follows the newest row too, so Enter, c and s act on it.
        trackingFocusRef.current = true;
        elementsRef.current.get(newestId)?.focus({ preventScroll: true });
        trackingFocusRef.current = false;
      }
    }
  }, [visible]);

  const setWindow = useCallback((next: RenderWindow): boolean => {
    if (sameWindow(next, windowRef.current)) return false;
    windowRef.current = next;
    setRenderWindow(next);
    return true;
  }, []);
  // Draws `next`, then runs `after` once its rows are in the DOM, or straight away when nothing changes.
  const redraw = useCallback((next: RenderWindow | null, after?: () => void) => {
    if (next !== null && setWindow(next)) afterDrawRef.current = after ?? null;
    else after?.();
  }, [setWindow]);
  useLayoutEffect(() => {
    const after = afterDrawRef.current;
    if (after === null) return;
    afterDrawRef.current = null;
    after();
  });
  // Notes where the top row in view sits, and returns what puts it back after rows above it change.
  const keepInPlace = useCallback((): (() => void) => {
    const list = listRef.current;
    if (!list) return () => {};
    const listTop = list.getBoundingClientRect().top;
    for (const entry of drawnRef.current) {
      const element = elementsRef.current.get(entry.id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom - listTop <= 0) continue;
      const offset = rect.top - listTop;
      return () => {
        const moved = elementsRef.current.get(entry.id);
        if (!moved || followingRef.current) return;
        const delta = moved.getBoundingClientRect().top - list.getBoundingClientRect().top - offset;
        if (Math.abs(delta) >= 1) list.scrollTop += delta;
      };
    }
    return () => {};
  }, []);

  const pinToBottom = useCallback(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, []);
  const pauseFollow = useCallback(() => {
    if (!followingRef.current) return;
    followingRef.current = false;
    pausedNewestIdRef.current = visibleRef.current.at(-1)?.id ?? null;
    // The drawn rows stay put while new ones arrive below them.
    if (windowRef.current.startId === null) setWindow(holdWindow(rangeRef.current, visibleRef.current));
    setFollowing(false);
  }, [setWindow]);
  const resumeFollow = useCallback(() => {
    if (followingRef.current) return;
    followingRef.current = true;
    pausedNewestIdRef.current = null;
    setWindow(LATEST_WINDOW);
    setFollowing(true);
    setNewCount(0);
  }, [setWindow]);
  const jumpLatest = useCallback(() => {
    trackNewestRef.current = true;
    const newestId = visibleRef.current.at(-1)?.id ?? null;
    focusedIdRef.current = newestId;
    setFocusedId(newestId);
    followingRef.current = true;
    pausedNewestIdRef.current = null;
    setWindow(LATEST_WINDOW);
    setFollowing(true);
    setNewCount(0);
    pinToBottom();
  }, [pinToBottom, setWindow]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (followingRef.current) {
      list.scrollTop = list.scrollHeight;
      setNewCount((count) => count === 0 ? count : 0);
    } else {
      const seen = pausedNewestIdRef.current;
      const added = seen === null ? 0 : rowsAfter(visible, entryOrder, seen);
      setNewCount((count) => count === added ? count : added);
    }
  }, [visible, entryOrder, drawn, snapshot.activeThinking, expandedView, overrides]);

  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content) return;
    // Rows render at a placeholder height until they come into view and outputs grow while
    // they stream, so the log re-pins on every size change while it follows.
    const observer = new ResizeObserver(() => { if (followingRef.current) pinToBottom(); });
    observer.observe(list);
    observer.observe(content);
    const endPointer = () => { pointerScrollRef.current = false; };
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);
    return () => {
      observer.disconnect();
      window.removeEventListener("pointerup", endPointer);
      window.removeEventListener("pointercancel", endPointer);
    };
  }, [pinToBottom]);

  /** Draws a page of earlier rows, reading older ones from bb as the drawn rows near the oldest loaded one. */
  const showEarlier = useCallback((): boolean => {
    const range = rangeRef.current;
    const next = windowUp(windowRef.current, range, visibleRef.current, pageRowsRef.current, maxRowsRef.current);
    if (next) redraw(next, keepInPlace());
    const start = next ? Math.max(0, range.start - pageRowsRef.current) : range.start;
    const current = storeRef.current?.getSnapshot();
    if (start < pageRowsRef.current && current?.hasOlder && !current.loadingOlder && current.olderError === null) {
      storeRef.current?.loadOlder();
    }
    return next !== null;
  }, [keepInPlace, redraw]);
  const showLater = useCallback((): boolean => {
    const next = windowDown(rangeRef.current, visibleRef.current, pageRowsRef.current, maxRowsRef.current);
    if (next) redraw(next, keepInPlace());
    return next !== null;
  }, [keepInPlace, redraw]);

  useLayoutEffect(() => {
    const list = listRef.current;
    // A list with no height is not laid out (a hidden tab), so it says nothing about what is in view.
    if (!list || settings === null || snapshot.status !== "ready" || list.clientHeight === 0) return;
    const edge = list.clientHeight;
    const short = list.scrollHeight <= list.clientHeight;
    const paused = !followingRef.current;
    if ((short || (paused && list.scrollTop <= edge)) && showEarlier()) return;
    if (short || (paused && list.scrollHeight - list.clientHeight - list.scrollTop <= edge)) showLater();
  }, [drawn, settings, snapshot.status, snapshot.hasOlder, snapshot.loadingOlder, showEarlier, showLater]);

  const registerElement = useCallback((id: string, element: HTMLElement | null) => {
    if (element) elementsRef.current.set(id, element);
    else elementsRef.current.delete(id);
  }, []);
  const onFocusRow = useCallback((id: string) => {
    if (trackingFocusRef.current) return;
    trackNewestRef.current = false;
    focusedIdRef.current = id;
    setFocusedId(id);
  }, []);
  const focusEntry = useCallback((id: string) => {
    trackNewestRef.current = false;
    // Reading an older row pauses follow, so new output does not pull the view away from it.
    if (id !== visibleRef.current.at(-1)?.id) pauseFollow();
    focusedIdRef.current = id;
    setFocusedId(id);
    const element = elementsRef.current.get(id);
    if (element) {
      element.focus();
      element.scrollIntoView({ block: "nearest" });
      return;
    }
    const range = rangeRef.current;
    const index = visibleRef.current.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const next = windowWith(index, windowRef.current, range, visibleRef.current, pageRowsRef.current, maxRowsRef.current);
    const nextTo = index === range.start - 1 || index === range.end;
    redraw(next, () => {
      const drawnElement = elementsRef.current.get(id);
      drawnElement?.focus({ preventScroll: true });
      drawnElement?.scrollIntoView({ block: nextTo ? "nearest" : "center" });
    });
  }, [pauseFollow, redraw]);
  const showMatches = useCallback((matches: SearchMatch[], index: number | null) => {
    matchesRef.current = matches;
    currentMatchRef.current = index === null ? null : positionOf(matches, index);
    publishHighlights(highlightOwner, matches, index === null ? null : matches[index]!.range);
    const entryId = index === null ? null : matches[index]!.entryId;
    setMatchState((shown) => shown.count === matches.length && shown.index === index && shown.entryId === entryId
      ? shown : { count: matches.length, index, entryId });
  }, [highlightOwner]);
  const refreshMatches = useCallback(() => {
    const needle = queryRef.current.toLowerCase();
    const matches = needle && contentRef.current ? findMatches(contentRef.current, needle) : [];
    showMatches(matches, indexOfMatch(matches, currentMatchRef.current));
  }, [showMatches]);
  const scrollToMatch = useCallback((match: SearchMatch) => {
    const list = listRef.current;
    const row = elementsRef.current.get(match.entryId);
    if (!list || !row) return;
    const place = () => centerInList(list, (match.range ?? row).getBoundingClientRect());
    place();
    // Rows that scroll into view grow from their placeholder height, which can move the match.
    window.requestAnimationFrame(place);
  }, []);
  const selectMatch = useCallback((target: number, focusRow: boolean) => {
    const matches = matchesRef.current;
    const match = matches[target];
    if (!match) return;
    showMatches(matches, target);
    trackNewestRef.current = false;
    pauseFollow();
    focusedIdRef.current = match.entryId;
    setFocusedId(match.entryId);
    if (focusRow) elementsRef.current.get(match.entryId)?.focus({ preventScroll: true });
    scrollToMatch(match);
  }, [pauseFollow, scrollToMatch, showMatches]);
  // Draws `next`, then finds the matches in the rows it added and goes on from there.
  const drawMatches = useCallback((next: RenderWindow, then: () => void) => {
    redraw(next, () => { refreshMatches(); then(); });
  }, [redraw, refreshMatches]);
  const goToMatchRef = useRef<(direction: 1 | -1, focusRow: boolean) => boolean>(() => false);
  const goToMatch = useCallback((direction: 1 | -1, focusRow: boolean): boolean => {
    const matches = matchesRef.current;
    if (matches.length === 0) return false;
    const rows = visibleRef.current;
    const range = rangeRef.current;
    const pages = pageRowsRef.current;
    const current = indexOfMatch(matches, currentMatchRef.current);
    if (current !== null && matches[current]!.entryId === focusedIdRef.current) {
      const target = current + direction;
      if (target >= 0 && target < matches.length) {
        selectMatch(target, focusRow);
        return true;
      }
      // Every visible row matches, so rows past the drawn ones hold the next match.
      const further = direction < 0
        ? windowUp(windowRef.current, range, rows, pages, maxRowsRef.current)
        : windowDown(range, rows, pages, maxRowsRef.current);
      if (further) {
        drawMatches(further, () => goToMatchRef.current(direction, focusRow));
        return true;
      }
      const otherEnd = direction < 0 ? range.end < rows.length : range.start > 0;
      if (otherEnd) {
        drawMatches(windowAround(direction < 0 ? rows.length - 1 : 0, rows, pages),
          () => selectMatch(direction < 0 ? matchesRef.current.length - 1 : 0, focusRow));
        return true;
      }
      selectMatch((target + matches.length) % matches.length, focusRow);
      return true;
    }
    const indexes = new Map(rows.map((entry, index) => [entry.id, index]));
    const cursor = trackNewestRef.current ? undefined : indexes.get(focusedIdRef.current ?? "");
    if (cursor === undefined && direction > 0 && range.start > 0) {
      drawMatches(windowAround(0, rows, pages), () => selectMatch(0, focusRow));
      return true;
    }
    selectMatch(firstMatchFrom(matches, (match) => indexes.get(match.entryId) ?? -1, cursor, direction), focusRow);
    return true;
  }, [drawMatches, selectMatch]);
  goToMatchRef.current = goToMatch;
  // A new filter or search keeps the reader on their row when it still shows, and otherwise follows the newest.
  const shownKey = `${normalizedQuery}\u0000${errorsOnly}\u0000${CHIPS.map(([category]) => filters[category]).join()}`;
  const shownKeyRef = useRef(shownKey);
  useLayoutEffect(() => {
    if (shownKeyRef.current === shownKey) return;
    shownKeyRef.current = shownKey;
    const rows = visibleRef.current;
    const id = focusedIdRef.current;
    const index = followingRef.current || id === null ? -1 : rows.findIndex((entry) => entry.id === id);
    if (index < 0 || id === null) {
      // The empty follow-up still marks a draw as pending, so a search step waits for these rows.
      redraw(LATEST_WINDOW, () => {});
      if (!followingRef.current) jumpLatest();
      return;
    }
    redraw(windowAround(index, rows, pageRowsRef.current),
      () => elementsRef.current.get(id)?.scrollIntoView({ block: "center" }));
  }, [shownKey, jumpLatest, redraw]);
  useLayoutEffect(() => {
    currentMatchRef.current = null;
    refreshMatches();
    const step = pendingMatchStepRef.current;
    pendingMatchStepRef.current = null;
    if (!step) return;
    const drawing = afterDrawRef.current;
    if (drawing === null) goToMatch(step, false);
    else afterDrawRef.current = () => { drawing(); refreshMatches(); goToMatch(step, false); };
  }, [query, refreshMatches, goToMatch]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    // Markdown, diffs and streamed output change the text after React commits, so matches follow the DOM.
    const observer = new MutationObserver(() => { if (queryRef.current) refreshMatches(); });
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      publishHighlights(highlightOwner, [], null);
    };
  }, [highlightOwner, refreshMatches]);
  const toggleRow = useCallback((id: string) => {
    const entry = visibleRef.current.find((item) => item.id === id);
    if (!entry) return;
    setOverrides((current) => {
      const expanded = current.get(id) ?? (expandedRef.current || !!queryRef.current || isDefaultExpanded(entry, expandFailuresRef.current));
      const next = new Map(current);
      next.set(id, !expanded);
      return next;
    });
  }, []);
  const toggleExpanded = useCallback(() => preference.toggle(), [preference]);
  const onCopy = useCallback((entry: LogEntry) => {
    void experimental_copyToClipboard({ text: entry.copyText })
      .then((copied) => { if (copied) toast("Copied"); else toast.error("Could not copy"); })
      .catch(() => toast.error("Could not copy"));
  }, []);
  const onOpenThread = useCallback((id: string) => navigateRef.current.toThread(id, { split: true }), []);

  const markScrollIntent = useCallback(() => {
    scrollIntentUntilRef.current = performance.now() + USER_SCROLL_INTENT_MS;
  }, []);
  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const fromBottom = list.scrollHeight - list.clientHeight - list.scrollTop;
    const newestDrawn = rangeRef.current.end >= visibleRef.current.length;
    if (fromBottom <= STICKY_BOTTOM_THRESHOLD_PX && newestDrawn) {
      resumeFollow();
    } else if (pointerScrollRef.current || performance.now() <= scrollIntentUntilRef.current) {
      pauseFollow();
    } else if (followingRef.current) {
      // Layout moved the view (a row grew past its placeholder height), not the reader.
      pinToBottom();
    }
    if (followingRef.current || list.clientHeight === 0) return;
    // Rows are drawn a screen before the reader reaches the edge of the drawn ones.
    if (list.scrollTop <= list.clientHeight) showEarlier();
    else if (fromBottom <= list.clientHeight && !newestDrawn) showLater();
  }, [pauseFollow, pinToBottom, resumeFollow, showEarlier, showLater]);
  const move = useCallback((direction: 1 | -1): boolean => {
    const rows = visibleRef.current;
    if (rows.length === 0) return false;
    const index = rows.findIndex((entry) => entry.id === focusedIdRef.current);
    if (index === 0 && direction < 0) {
      const current = storeRef.current?.getSnapshot();
      if (current?.hasOlder && !current.loadingOlder) storeRef.current?.loadOlder();
    }
    const next = index < 0 ? (direction > 0 ? 0 : rows.length - 1)
      : Math.max(0, Math.min(rows.length - 1, index + direction));
    focusEntry(rows[next]!.id);
    return true;
  }, [focusEntry]);
  const seek = useCallback((direction: 1 | -1, test: (entry: LogEntry) => boolean): boolean => {
    const rows = visibleRef.current;
    if (rows.length === 0) return false;
    const index = rows.findIndex((entry) => entry.id === focusedIdRef.current);
    const start = index >= 0 ? index : direction > 0 ? -1 : 0;
    for (let offset = 1; offset <= rows.length; offset++) {
      const candidate = rows[(start + direction * offset + rows.length * 2) % rows.length]!;
      if (test(candidate)) { focusEntry(candidate.id); return true; }
    }
    return false;
  }, [focusEntry]);
  const focusEdge = useCallback((last: boolean): boolean => {
    setWantFirst(!last && storeRef.current?.getSnapshot().hasOlder === true);
    const rows = visibleRef.current;
    if (!rows.length) return false;
    focusEntry(rows[last ? rows.length - 1 : 0]!.id);
    if (last) jumpLatest();
    return true;
  }, [focusEntry, jumpLatest]);

  useEffect(() => {
    if (!wantFirst || snapshot.status !== "ready") return;
    if (snapshot.olderError !== null) setWantFirst(false);
    else if (!snapshot.hasOlder) {
      setWantFirst(false);
      const first = visibleRef.current[0];
      if (first) focusEntry(first.id);
    }
  }, [wantFirst, snapshot.status, snapshot.hasOlder, snapshot.olderError, focusEntry]);
  // Search covers the whole session, so it reads the older pages too; only the matching rows are drawn.
  useEffect(() => { store?.setLoadAll(query !== "" || wantFirst); }, [store, query, wantFirst]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
    if (SCROLL_KEYS.has(event.key)) markScrollIntent();
    const focused = visibleRef.current.find((entry) => entry.id === focusedIdRef.current);
    let handled = true;
    switch (event.key) {
      case "j": case "ArrowDown": handled = move(1); break;
      case "k": case "ArrowUp": handled = move(-1); break;
      case "Enter": case "o":
        handled = target instanceof HTMLElement && target.dataset.entryId === focused?.id && !!focused;
        if (handled) toggleRow(focused!.id);
        break;
      case "x": toggleExpanded(); break;
      case "n": handled = queryRef.current ? goToMatch(1, true) : seek(1, isReply); break;
      case "N": handled = queryRef.current ? goToMatch(-1, true) : seek(-1, isReply); break;
      case "e": handled = seek(1, (entry) => entry.isError); break;
      case "E": handled = seek(-1, (entry) => entry.isError); break;
      case "g": handled = focusEdge(false); break;
      case "G": handled = focusEdge(true); break;
      case "/": searchRef.current?.focus(); break;
      case "c": if (focused) onCopy(focused); else handled = false; break;
      case "s": {
        const link = focused && elementsRef.current.get(focused.id)?.querySelector<HTMLAnchorElement>("[data-chat-link]");
        if (link) link.click(); else handled = false;
        break;
      }
      case "?": setHelpVisible((shown) => !shown); break;
      default: handled = false;
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }, [focusEdge, goToMatch, markScrollIntent, move, onCopy, seek, toggleExpanded, toggleRow]);
  const onSearchKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      const direction = event.shiftKey ? -1 : 1;
      const typed = rawQuery.trim();
      // Enter can beat the search debounce; the step then waits for the new query's matches.
      if (typed !== queryRef.current) { pendingMatchStepRef.current = direction; setQuery(typed); }
      else goToMatch(direction, false);
    } else if (event.key === "ArrowDown") {
      // Enter stays in the box, so ArrowDown is the way into the log without clearing the search.
      const id = focusedIdRef.current;
      if (!id) return;
      if (currentMatchRef.current?.entryId === id) elementsRef.current.get(id)?.focus({ preventScroll: true });
      else focusEntry(id);
    } else if (event.key === "Escape") {
      pendingMatchStepRef.current = null;
      if (rawQuery) { setRawQuery(""); setQuery(""); }
      else rootRef.current?.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }, [focusEntry, goToMatch, rawQuery]);
  const toggleFilter = useCallback((category: EntryCategory) => {
    setChosenFilters({ ...filters, [category]: !filters[category] });
  }, [filters]);

  const ready = settings !== null && snapshot.status === "ready";
  const olderPending = snapshot.hasOlder && snapshot.olderError === null;
  const loadedRows = `${entries.length}${snapshot.hasOlder ? "+" : ""}`;
  const rowsLabel = visible.length === entries.length ? `${loadedRows} rows` : `${visible.length} of ${loadedRows} rows`;
  const loadingAll = olderPending && (query !== "" || wantFirst);
  const edgeClass = "flex min-h-8 flex-wrap items-center justify-center gap-x-2 border-b border-border-seam px-3 py-1 text-xs text-muted-foreground";
  const edgeButton = "rounded px-2 py-0.5 text-foreground hover:bg-state-hover";

  return (
    <section ref={rootRef} data-session-log-panel tabIndex={-1} onKeyDown={onKeyDown}
      className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground">
      <div className="shrink-0 space-y-2 border-b border-border-seam p-2">
        <div className="flex flex-wrap items-center gap-1">
          {CHIPS.map(([category, label]) => (
            <button key={category} type="button" aria-pressed={filters[category]}
              className={`rounded px-2 py-1 text-xs ${filters[category] ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}
              onClick={() => toggleFilter(category)}>
              {label}
            </button>
          ))}
          <button type="button" aria-pressed={errorsOnly} onClick={() => setErrorsOnly((active) => !active)}
            className={`rounded px-2 py-1 text-xs ${errorsOnly ? "bg-surface-selected text-destructive-text" : "text-muted-foreground hover:bg-state-hover"}`}>Errors</button>
          <button type="button" aria-label="Toggle expanded view" aria-pressed={expandedView}
            onClick={toggleExpanded} className="ml-auto rounded px-2 py-1 text-xs text-muted-foreground hover:bg-state-hover">
            {expandedView ? "Show previews" : "Expand all"}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input ref={searchRef} type="search" aria-label="Search session log" value={rawQuery}
            onChange={(event) => setRawQuery(event.target.value)} onKeyDown={onSearchKeyDown}
            placeholder="Search the whole session" className="min-w-0 flex-1 rounded border border-border-seam bg-surface-recessed px-2 py-1 text-sm text-foreground" />
          {query && (
            <div className="flex shrink-0 items-center gap-0.5">
              <span aria-live="polite" className="mr-1 text-xs tabular-nums text-muted-foreground">
                {matchLabel(matchState, olderPending || range.start > 0 || !drawsNewest)}
              </span>
              {([[-1, "Previous match", "ChevronUp", "Shift+Enter"], [1, "Next match", "ChevronDown", "Enter"]] as const)
                .map(([direction, label, icon, key]) => (
                  <button key={label} type="button" aria-label={label} title={`${label} (${key}, or ${direction > 0 ? "n" : "N"} in the log)`}
                    disabled={matchState.count === 0}
                    // Keeps focus in the search box, so Enter keeps stepping after a click.
                    onMouseDown={(event) => event.preventDefault()} onClick={() => goToMatch(direction, false)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40">
                    <Icon name={icon} className="size-4" aria-hidden />
                  </button>
                ))}
            </div>
          )}
          <span aria-live="polite" className="shrink-0 text-xs text-muted-foreground"
            title={snapshot.hasOlder ? "Older rows load as you scroll up" : undefined}>
            {loadingAll ? `${rowsLabel} · loading older` : rowsLabel}
          </span>
          <button type="button" aria-label="Keyboard help" aria-expanded={helpVisible}
            onClick={() => setHelpVisible((shown) => !shown)} className="text-muted-foreground hover:text-foreground">?</button>
        </div>
        {helpVisible && <div className="text-xs text-muted-foreground">j/k move · n/N replies, or matches while searching · e/E errors · g/G ends · Enter/o expand · x expand all · / search, then Enter/Shift+Enter next/previous match and ↓ back to the log · c copy · s show in chat · ? help</div>}
      </div>
      {snapshot.status === "error" && (
        <div role="alert" className="border-b border-border-seam p-2 text-sm text-destructive-text">
          Could not load session log: {snapshot.error}
          <button type="button" className="ml-2 underline" onClick={() => store?.retry()}>Retry</button>
        </div>
      )}
      {snapshot.status === "ready" && snapshot.error && (
        <div role="alert" className="border-b border-border-seam p-2 text-xs text-warning-text">Could not refresh: {snapshot.error}</div>
      )}
      {snapshot.status === "ready" && snapshot.hiddenError && (
        <div role="alert" className="border-b border-border-seam p-2 text-xs text-warning-text">Could not load hidden messages: {snapshot.hiddenError}</div>
      )}
      <div ref={listRef} data-session-log-list onScroll={onScroll} onWheel={markScrollIntent}
        onTouchStart={markScrollIntent} onTouchMove={markScrollIntent}
        onPointerDown={() => { pointerScrollRef.current = true; }}
        className="min-h-0 flex-1 overflow-y-auto">
        <div ref={contentRef}>
          {(settings === null || (snapshot.status === "loading" && entries.length === 0)) && (
            <p className="p-3 text-sm text-muted-foreground">Loading session…</p>
          )}
          {ready && entries.length === 0 && !snapshot.activeThinking && !snapshot.hasOlder && (
            <p className="p-3 text-sm text-muted-foreground">Nothing has happened in this thread yet.</p>
          )}
          {ready && (range.start > 0 || snapshot.hasOlder) && (
            <div data-session-log-edge="earlier" className={edgeClass}>
              {range.start > 0 ? (
                <button type="button" className={edgeButton} onClick={() => showEarlier()}>Show earlier rows</button>
              ) : snapshot.olderError !== null ? (
                <span role="alert" className="text-warning-text">
                  Could not load older rows: {snapshot.olderError}
                  <button type="button" className="ml-2 underline" onClick={() => store?.loadOlder()}>Retry</button>
                </span>
              ) : snapshot.loadingOlder ? (
                <span>Loading older rows…</span>
              ) : (
                <button type="button" className={edgeButton} onClick={() => store?.loadOlder()}>Load older rows</button>
              )}
            </div>
          )}
          {ready && entries.length > 0 && visible.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">
              {olderPending ? "No loaded rows match these filters yet." : "No rows match these filters."}
            </p>
          )}
          <div role="list" aria-label="Session log entries">
            {settings !== null && drawn.map((entry) => (
              <LogRow key={entry.id} entry={entry} focused={entry.id === focusedId} searchCurrent={entry.id === matchState.entryId}
                expanded={overrides.get(entry.id) ?? (expandedView || !!query || isDefaultExpanded(entry, effectiveSettings.expandFailures))}
                turnStats={entry.divider ? turnStats.get(entry.id) : undefined}
                chatHref={chatHref(entry, snapshot.projectId, threadId)} settings={effectiveSettings}
                onToggle={toggleRow} onFocusRow={onFocusRow} onCopy={onCopy}
                onOpenThread={onOpenThread} registerElement={registerElement} />
            ))}
          </div>
          {ready && !drawsNewest && (
            <div data-session-log-edge="later" className={edgeClass}>
              <button type="button" className={edgeButton} onClick={() => showLater()}>Show later rows</button>
            </div>
          )}
          {settings !== null && drawsNewest && snapshot.activeThinking && filters.thinking && !errorsOnly && !query && (
            <div data-live-thinking className="border-b border-border-seam px-3 py-2 text-sm text-muted-foreground"
              style={{ contentVisibility: "auto", containIntrinsicSize: "auto 48px" }}>
              <div className="flex items-center gap-2"><Icon name="AiBrain01" className="size-4" aria-hidden />Thinking…</div>
              {(expandedView || effectiveSettings.thinkingLines > 0) && (
                <pre className="font-mono text-xs whitespace-pre-wrap break-words">
                  {expandedView
                    ? snapshot.activeThinking.text
                    : previewLines(snapshot.activeThinking.text, 0, effectiveSettings.thinkingLines).text}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
      {!following && (
        <button type="button" onClick={() => { jumpLatest(); rootRef.current?.focus({ preventScroll: true }); }}
          className="shrink-0 border-t border-border-seam bg-surface-selected p-2 text-sm text-foreground">
          {newCount ? `↓ ${newCount} new` : "↓ Latest"}
        </button>
      )}
    </section>
  );
}
