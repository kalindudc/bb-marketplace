import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useBorderBoxWidth } from "./border-box";

/** Per-device view memory (scroll, folds, filters), in local storage under Tavern's plugin id. Display state only; nothing here reaches the server. */
/** A store: its key prefix, the index that orders its keys by last write, and how many keys it keeps. */
interface MemorySpace { prefix: string; index: string; max: number }
const VIEW: MemorySpace = { prefix: "tavern:view:", index: "tavern:view-index", max: 120 };
/** Keys under "skel:" (skeleton row counts and widths, one per card, quest and list) get their own store, so a long chat never pushes filters and scroll positions out of VIEW. */
const SKELETON: MemorySpace = { prefix: "tavern:skel:", index: "tavern:skel-index", max: 240 };
const spaceOf = (key: string) => key.startsWith("skel:") ? SKELETON : VIEW;

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function readRemembered<T>(key: string): T | undefined {
  const space = spaceOf(key);
  const raw = storage()?.getItem(space.prefix + key);
  if (raw == null) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

/** Writes and keeps only the most recent keys, so per-thread memory cannot grow without bound. Storage that refuses (quota, private mode) only loses the memory. */
export function writeRemembered(key: string, value: unknown) {
  const space = spaceOf(key);
  const s = storage();
  if (!s) return;
  try {
    s.setItem(space.prefix + key, JSON.stringify(value));
    const index = (JSON.parse(s.getItem(space.index) ?? "[]") as string[]).filter(k => k !== key);
    index.push(key);
    for (const old of index.splice(0, Math.max(0, index.length - space.max))) s.removeItem(space.prefix + old);
    s.setItem(space.index, JSON.stringify(index));
  } catch { /* storage full or blocked: the view simply is not remembered */ }
}

export function useRememberedWidth<T extends HTMLElement>(key: string) {
  return useBorderBoxWidth<T>(useCallback((width: number) => {
    const rounded = Math.round(width);
    if (rounded > 0 && rounded !== readRemembered<number>(key)) writeRemembered(key, rounded);
  }, [key]));
}

/** useState that survives leaving the panel. `accept` rejects stale or malformed values, which fall back to `initial`. */
export function useRemembered<T>(key: string, initial: T, accept: (value: unknown) => value is T = (v): v is T => v !== undefined): [T, (next: T | ((prev: T) => T)) => void] {
  const read = useCallback(() => { const v = readRemembered<unknown>(key); return accept(v) ? v : initial; }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: read() }));
  const value = state.key === key ? state.value : read();
  useEffect(() => { if (state.key !== key) setState({ key, value: read() }); }, [key, state.key, read]);
  const set = useCallback((next: T | ((prev: T) => T)) => setState(prev => {
    const base = prev.key === key ? prev.value : read();
    const v = typeof next === "function" ? (next as (p: T) => T)(base) : next;
    writeRemembered(key, v);
    return { key, value: v };
  }), [key, read]);
  return [value, set];
}

function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let e = el; e; e = e.parentElement) {
    const oy = getComputedStyle(e).overflowY;
    if (oy === "auto" || oy === "scroll") return e;
  }
  return null;
}

type View = { scroll: number; folds: Record<string, boolean> };

/** Restores the folds (`<details data-fold="name">`) and scroll position under `root` once `ready`, and saves them as they change. A user scroll during the restore wins. */
export function useRememberedView(root: RefObject<HTMLElement | null>, key: string, ready: boolean) {
  const restored = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !ready || restored.current === key) return;
    restored.current = key;
    const view = readRemembered<View>(key);
    if (!view) return;
    for (const d of el.querySelectorAll<HTMLDetailsElement>("details[data-fold]")) {
      const want = view.folds?.[d.dataset.fold!];
      if (typeof want === "boolean") d.open = want;
    }
    const sc = scroller(el);
    if (!sc || !(view.scroll > 0)) return;
    let userMoved = false;
    const stop = () => { userMoved = true; };
    sc.addEventListener("wheel", stop, { passive: true, once: true });
    sc.addEventListener("touchstart", stop, { passive: true, once: true });
    sc.addEventListener("keydown", stop, { once: true });
    const apply = () => { if (!userMoved) sc.scrollTop = view.scroll; };
    apply();
    const timers = [requestAnimationFrame(apply)];
    const later = [setTimeout(apply, 120), setTimeout(apply, 400)];
    return () => { timers.forEach(cancelAnimationFrame); later.forEach(clearTimeout); sc.removeEventListener("wheel", stop); sc.removeEventListener("touchstart", stop); sc.removeEventListener("keydown", stop); };
  }, [root, key, ready]);
  useEffect(() => {
    const el = root.current;
    if (!el || !ready) return;
    const sc = scroller(el);
    let frame = 0;
    const save = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const folds: Record<string, boolean> = {};
        for (const d of el.querySelectorAll<HTMLDetailsElement>("details[data-fold]")) folds[d.dataset.fold!] = d.open;
        writeRemembered(key, { scroll: sc?.scrollTop ?? 0, folds } satisfies View);
      });
    };
    el.addEventListener("toggle", save, true);
    sc?.addEventListener("scroll", save, { passive: true });
    return () => { cancelAnimationFrame(frame); el.removeEventListener("toggle", save, true); sc?.removeEventListener("scroll", save); };
  }, [root, key, ready]);
}

/**
 * Starting a Keeper (or any class) from the page: the page has no pickers, so it arms the class here and opens bb's composer, and
 * the composer's class banner applies the class's provider, model, reasoning and permission once. One record, under a minute old.
 */
const CLASS_ARM_KEY = "tavern:armed-class:v1";
export const CLASS_ARM_TTL_MS = 60_000;

export function armClassSettings(classId: string) {
  try { storage()?.setItem(CLASS_ARM_KEY, JSON.stringify({ classId, armedAt: Date.now() })); } catch { /* storage blocked: the composer keeps its own pickers */ }
}

/**
 * Read and clear for one class: true once while the record names it and is fresh. A stale or malformed record is dropped; one for
 * another class is kept, because a leftover pill can show for a moment before the page's pill replaces it.
 */
export function takeArmedClass(classId: string, now = Date.now()): boolean {
  const s = storage();
  const raw = s?.getItem(CLASS_ARM_KEY);
  if (!s || !raw) return false;
  try {
    const r = JSON.parse(raw) as { classId?: unknown; armedAt?: unknown };
    if (typeof r.classId !== "string" || typeof r.armedAt !== "number" || r.armedAt > now + 60_000 || now - r.armedAt >= CLASS_ARM_TTL_MS) { s.removeItem(CLASS_ARM_KEY); return false; }
    if (r.classId !== classId) return false;
    s.removeItem(CLASS_ARM_KEY);
    return true;
  } catch { s.removeItem(CLASS_ARM_KEY); return false; }
}
