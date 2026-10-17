import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";
import {
  experimental_copyToClipboard, experimental_Icon as Icon, useBbNavigate, useSdk,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { consumePanelFocus, onPanelFocusRequest } from "./commands";
import { collectTurnStats, previewLines, toLogEntries, type EntryCategory, type LogEntry } from "./entries";
import { LogRow } from "./log-row";
import type { ExpandedPreference } from "./preference";
import { DEFAULT_SETTINGS } from "./settings";
import { createSessionLogStore, type SessionLogSnapshot, type SessionLogStore } from "./store";
import { useSessionLogSettings } from "./use-settings";

const EMPTY_SNAPSHOT: SessionLogSnapshot = {
  status: "loading", rows: [], activeThinking: null, projectId: null, error: null,
};

// bb's own sticky scrollers use the same threshold and intent window (useStickyBottomScroll).
const STICKY_BOTTOM_THRESHOLD_PX = 4;
const USER_SCROLL_INTENT_MS = 350;
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", " "]);

function isDefaultExpanded(entry: LogEntry, expandFailures: boolean): boolean {
  return expandFailures && entry.isError && entry.row.kind === "work" &&
    (entry.row.workKind === "command" || entry.row.workKind === "tool");
}

function chatHref(entry: LogEntry, projectId: string | null, threadId: string): string | null {
  if (entry.messageSeq === null || entry.row.kind !== "conversation" || projectId === null) return null;
  const path = projectId === "proj_personal"
    ? `/threads/${threadId}` : `/projects/${projectId}/threads/${threadId}`;
  return `${path}#msg=${entry.messageSeq}`;
}

export function SessionLogPanel({ threadId, preference }: PluginThreadPanelProps & {
  preference: ExpandedPreference;
}) {
  const sdk = useSdk();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const navigate = useBbNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [mountedStore, setMountedStore] = useState<{ threadId: string; store: SessionLogStore } | null>(null);
  const store = mountedStore?.threadId === threadId ? mountedStore.store : null;

  useEffect(() => {
    const next = createSessionLogStore({ sdk: sdkRef.current, threadId });
    setMountedStore({ threadId, store: next });
    return () => next.dispose();
  }, [threadId]);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store]);
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? EMPTY_SNAPSHOT, [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const expandedView = useSyncExternalStore(preference.subscribe, preference.isExpanded);
  const settings = useSessionLogSettings();
  const effectiveSettings = settings ?? DEFAULT_SETTINGS;

  // The chips start from the settings; once the reader toggles one, their choice wins.
  const [chosenFilters, setChosenFilters] = useState<Record<EntryCategory, boolean> | null>(null);
  const filters = useMemo(() => chosenFilters ?? {
    message: effectiveSettings.showMessages, thinking: effectiveSettings.showThinking, tool: effectiveSettings.showTools,
  }, [chosenFilters, effectiveSettings]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [helpVisible, setHelpVisible] = useState(false);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const trackNewestRef = useRef(true);
  const followingRef = useRef(true);
  const pausedIdsRef = useRef<Set<string> | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingSearchFocusRef = useRef<string | null>(null);
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const pointerScrollRef = useRef(false);
  const scrollIntentUntilRef = useRef(0);
  const trackingFocusRef = useRef(false);

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

  const entries = useMemo(() => toLogEntries(snapshot.rows), [snapshot.rows]);
  const turnStats = useMemo(() => collectTurnStats(entries), [entries]);
  const normalizedQuery = query.toLowerCase();
  const visible = useMemo(() => entries.filter((entry) => {
    if (!filters[entry.category] && !(errorsOnly && entry.divider)) return false;
    if (errorsOnly && !entry.isError && !entry.divider) return false;
    return !normalizedQuery || entry.searchText.includes(normalizedQuery);
  }), [entries, errorsOnly, filters, normalizedQuery]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
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

  const pinToBottom = useCallback(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, []);
  const pauseFollow = useCallback(() => {
    if (!followingRef.current) return;
    followingRef.current = false;
    pausedIdsRef.current = new Set(visibleRef.current.map((entry) => entry.id));
    setFollowing(false);
  }, []);
  const resumeFollow = useCallback(() => {
    if (followingRef.current) return;
    followingRef.current = true;
    pausedIdsRef.current = null;
    setFollowing(true);
    setNewCount(0);
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (followingRef.current) {
      list.scrollTop = list.scrollHeight;
      setNewCount((count) => count === 0 ? count : 0);
    } else {
      const seen = pausedIdsRef.current;
      const added = seen ? visible.filter((entry) => !seen.has(entry.id)).length : 0;
      setNewCount((count) => count === added ? count : added);
    }
  }, [visible, snapshot.activeThinking, expandedView, overrides]);

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
    element?.focus();
    element?.scrollIntoView({ block: "nearest" });
  }, [pauseFollow]);
  useLayoutEffect(() => {
    const id = pendingSearchFocusRef.current;
    if (id && visible.some((entry) => entry.id === id)) {
      pendingSearchFocusRef.current = null;
      focusEntry(id);
    }
  }, [visible, focusEntry]);
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
    if (list.scrollHeight - list.clientHeight - list.scrollTop <= STICKY_BOTTOM_THRESHOLD_PX) {
      resumeFollow();
    } else if (pointerScrollRef.current || performance.now() <= scrollIntentUntilRef.current) {
      pauseFollow();
    } else if (followingRef.current) {
      // Layout moved the view (a row grew past its placeholder height), not the reader.
      pinToBottom();
    }
  }, [pauseFollow, pinToBottom, resumeFollow]);
  const jumpLatest = useCallback(() => {
    trackNewestRef.current = true;
    const newestId = visibleRef.current.at(-1)?.id ?? null;
    focusedIdRef.current = newestId;
    setFocusedId(newestId);
    followingRef.current = true;
    pausedIdsRef.current = null;
    setFollowing(true);
    setNewCount(0);
    pinToBottom();
  }, [pinToBottom]);
  const move = useCallback((direction: 1 | -1): boolean => {
    const rows = visibleRef.current;
    if (rows.length === 0) return false;
    const index = rows.findIndex((entry) => entry.id === focusedIdRef.current);
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
    const rows = visibleRef.current;
    if (!rows.length) return false;
    focusEntry(rows[last ? rows.length - 1 : 0]!.id);
    if (last) jumpLatest();
    return true;
  }, [focusEntry, jumpLatest]);

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
      case "n": handled = seek(1, (entry) => entry.row.kind === "conversation" && entry.row.role === "assistant"); break;
      case "N": handled = seek(-1, (entry) => entry.row.kind === "conversation" && entry.row.role === "assistant"); break;
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
  }, [focusEdge, markScrollIntent, move, onCopy, seek, toggleExpanded, toggleRow]);
  const onSearchKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      trackNewestRef.current = false;
      pendingSearchFocusRef.current = null;
      const needle = rawQuery.trim().toLowerCase();
      const first = entries.find((entry) =>
        (filters[entry.category] || (errorsOnly && entry.divider)) &&
        (!errorsOnly || entry.isError || entry.divider) &&
        (!needle || entry.searchText.includes(needle)));
      setQuery(rawQuery.trim());
      if (first) {
        if (visibleRef.current.some((entry) => entry.id === first.id)) focusEntry(first.id);
        else pendingSearchFocusRef.current = first.id;
      }
    } else if (event.key === "Escape") {
      pendingSearchFocusRef.current = null;
      if (rawQuery) { setRawQuery(""); setQuery(""); }
      else rootRef.current?.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }, [entries, errorsOnly, filters, focusEntry, rawQuery]);
  const toggleFilter = useCallback((category: EntryCategory) => {
    setChosenFilters({ ...filters, [category]: !filters[category] });
  }, [filters]);

  return (
    <section ref={rootRef} data-session-log-panel tabIndex={-1} onKeyDown={onKeyDown}
      className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground">
      <div className="shrink-0 space-y-2 border-b border-border-seam p-2">
        <div className="flex flex-wrap items-center gap-1">
          {(["message", "thinking", "tool"] as const).map((category) => (
            <button key={category} type="button" aria-pressed={filters[category]}
              className={`rounded px-2 py-1 text-xs ${filters[category] ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}
              onClick={() => toggleFilter(category)}>
              {{ message: "Messages", thinking: "Thinking", tool: "Tools" }[category]}
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
          <span aria-live="polite" className="shrink-0 text-xs text-muted-foreground">
            {visible.length === entries.length ? `${entries.length} rows` : `${visible.length} of ${entries.length} rows`}
          </span>
          <button type="button" aria-label="Keyboard help" aria-expanded={helpVisible}
            onClick={() => setHelpVisible((shown) => !shown)} className="text-muted-foreground hover:text-foreground">?</button>
        </div>
        {helpVisible && <div className="text-xs text-muted-foreground">j/k move · n/N replies · e/E errors · g/G ends · Enter/o expand · x expand all · / search · c copy · s show in chat · ? help</div>}
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
      <div ref={listRef} data-session-log-list onScroll={onScroll} onWheel={markScrollIntent}
        onTouchStart={markScrollIntent} onTouchMove={markScrollIntent}
        onPointerDown={() => { pointerScrollRef.current = true; }}
        className="min-h-0 flex-1 overflow-y-auto">
        <div ref={contentRef}>
          {(settings === null || (snapshot.status === "loading" && entries.length === 0)) && (
            <p className="p-3 text-sm text-muted-foreground">Loading session…</p>
          )}
          {settings !== null && snapshot.status === "ready" && entries.length === 0 && !snapshot.activeThinking && (
            <p className="p-3 text-sm text-muted-foreground">Nothing has happened in this thread yet.</p>
          )}
          {settings !== null && snapshot.status === "ready" && entries.length > 0 && visible.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">No rows match these filters.</p>
          )}
          <div role="list" aria-label="Session log entries">
            {settings !== null && visible.map((entry) => (
              <LogRow key={entry.id} entry={entry} focused={entry.id === focusedId} query={query}
                expanded={overrides.get(entry.id) ?? (expandedView || !!query || isDefaultExpanded(entry, effectiveSettings.expandFailures))}
                turnStats={entry.divider ? turnStats.get(entry.id) : undefined}
                chatHref={chatHref(entry, snapshot.projectId, threadId)} settings={effectiveSettings}
                onToggle={toggleRow} onFocusRow={onFocusRow} onCopy={onCopy}
                onOpenThread={onOpenThread} registerElement={registerElement} />
            ))}
          </div>
          {settings !== null && snapshot.activeThinking && filters.thinking && !errorsOnly && !query && (
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
