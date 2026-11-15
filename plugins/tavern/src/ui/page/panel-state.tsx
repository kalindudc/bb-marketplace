import { createContext, useCallback, useContext, useEffect, useRef, useState, type RefObject } from "react";

/** Where the Tavern panel was left, per device: the last route, each route's scroll, and every remembered fold, filter, range and toggle. */
export type PanelSnapshot = { v: 1; path: string; scroll: Record<string, number>; ui: Record<string, unknown> };

const UI_LIMIT = 200;
const SCROLL_LIMIT = 60;
const empty = (): PanelSnapshot => ({ v: 1, path: "", scroll: {}, ui: {} });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const panelStorageKey = (pluginId: string) => `${pluginId}:panel-state:v1`;

export function readPanel(key: string): PanelSnapshot {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (isRecord(parsed) && parsed.v === 1 && typeof parsed.path === "string" && isRecord(parsed.scroll) && isRecord(parsed.ui)) {
      const scroll = Object.fromEntries(Object.entries(parsed.scroll).filter(([, n]) => typeof n === "number" && Number.isFinite(n) && n > 0)) as Record<string, number>;
      return { v: 1, path: parsed.path, scroll, ui: parsed.ui };
    }
  } catch { /* Unreadable or foreign state: start fresh, as on a new device. */ }
  return empty();
}

/** Keeps the newest entries: a key written again moves to the end, and the oldest fall off past the limit. */
function bump<T>(record: Record<string, T>, name: string, value: T | undefined, limit: number) {
  delete record[name];
  if (value !== undefined) record[name] = value;
  const keys = Object.keys(record);
  for (const old of keys.slice(0, Math.max(0, keys.length - limit))) delete record[old];
}

export function writePanel(key: string, change: (s: PanelSnapshot) => void) {
  try {
    const next = readPanel(key);
    change(next);
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch { /* Storage can be off or full; the panel then forgets its place, as it did before. */ }
}

export const rememberPath = (key: string, path: string) => writePanel(key, (s) => { s.path = path; });
export const rememberScroll = (key: string, path: string, top: number) => writePanel(key, (s) => bump(s.scroll, path, top > 0 ? Math.round(top) : undefined, SCROLL_LIMIT));

const PanelKey = createContext<string | null>(null);
/** Only the Tavern panel provides a key; the same components elsewhere (the homepage section) keep plain state. */
export const PanelStateProvider = PanelKey.Provider;
export const usePanelKey = () => useContext(PanelKey);

const sameShape = (initial: unknown) => (v: unknown) => typeof v === typeof initial && Array.isArray(v) === Array.isArray(initial);

/** useState that the panel remembers per device under `name` (null: plain state); `accept` rejects stale values (an option that no longer exists), which fall back to `initial`. */
export function usePanelState<T>(name: string | null, initial: T, accept: (v: unknown) => boolean = sameShape(initial)): [T, (next: T) => void] {
  const key = usePanelKey();
  const load = (): T => { if (!key || name === null) return initial; const v = readPanel(key).ui[name]; return v !== undefined && accept(v) ? v as T : initial; };
  const [state, setState] = useState<{ name: string | null; value: T }>(() => ({ name, value: load() }));
  const value = state.name === name ? state.value : load();
  const initialJson = JSON.stringify(initial);
  const set = useCallback((next: T) => {
    setState({ name, value: next });
    if (key && name !== null) writePanel(key, (s) => bump(s.ui, name, JSON.stringify(next) === initialJson ? undefined : next, UI_LIMIT));
  }, [key, name, initialJson]);
  return [value, set];
}

/** Remembers the scroller's position per route and puts it back once the route's content is tall enough, unless the person scrolls first. */
export function useRestoreScroll(key: string, ref: RefObject<HTMLElement | null>, path: string, ready: boolean) {
  const restored = useRef<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!key || !el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => { timer = null; if (restored.current === path) rememberScroll(key, path, el.scrollTop); };
    const onScroll = () => { if (timer === null) timer = setTimeout(save, 150); };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); if (timer !== null) { clearTimeout(timer); save(); } };
  }, [key, path, ref]);
  useEffect(() => {
    const el = ref.current;
    if (!key || !el || !ready || restored.current === path) return;
    const target = readPanel(key).scroll[path] ?? 0;
    let done = false;
    const finish = () => { if (done) return; done = true; restored.current = path; cleanup(); };
    const place = () => { el.scrollTop = target; if (target === 0 || el.scrollTop >= target - 1) finish(); };
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    const stop = setTimeout(finish, 2500);
    const gave = () => finish();
    const cleanup = () => { ro?.disconnect(); clearTimeout(stop); for (const e of ["wheel", "touchstart", "keydown", "pointerdown"] as const) el.removeEventListener(e, gave); };
    for (const e of ["wheel", "touchstart", "keydown", "pointerdown"] as const) el.addEventListener(e, gave, { passive: true });
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    place();
    return () => { if (!done) cleanup(); };
  }, [key, path, ready, ref]);
}
