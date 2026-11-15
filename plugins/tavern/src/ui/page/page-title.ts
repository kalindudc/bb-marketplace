import type { ExperimentalPageTitle } from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";

/**
 * Below this window width bb's title bar can't fit a trail beside Tavern's header buttons: bb's link steps never shrink, so
 * "Character sheets" ran over the buttons and the last step shrank to nothing (measured live at 390 and 360).
 */
export const NARROW_TITLE_QUERY = "(max-width: 479px)";

/**
 * Below this page-column width the header's labelled actions and bb's trail don't fit side by side, whatever the window: bb's side
 * panel at 1400 leaves the page about 540 px, and "Character sheets" ran under Closing time. Labelled, the header takes 302 px.
 */
export const NARROW_COLUMN_PX = 640;

const media = () => typeof matchMedia === "function" ? matchMedia(NARROW_TITLE_QUERY) : null;
// The page column's width, shared from the page (which owns .tv-page-root) with the header and the title, which bb draws elsewhere.
let column: number | null = null;
const columnListeners = new Set<() => void>();
export function setPageColumn(width: number | null) {
  if (width === column) return;
  column = width;
  for (const fn of columnListeners) fn();
}
function subscribe(changed: () => void) {
  const m = media();
  m?.addEventListener("change", changed);
  columnListeners.add(changed);
  return () => { m?.removeEventListener("change", changed); columnListeners.delete(changed); };
}
/** A phone window: Closing time leaves the header for the page picker. */
export const useNarrowTitle = () => useSyncExternalStore(subscribe, () => media()?.matches ?? false, () => false);
/** A phone window or a narrow page column: the header folds to icons and the title keeps its last step. */
export const useFoldedHeader = () => useSyncExternalStore(subscribe, () => (media()?.matches ?? false) || (column !== null && column < NARROW_COLUMN_PX), () => false);
/** The page reports its column's width while it is mounted, and forgets it when it goes. */
export function usePageColumn(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPageColumn(el.getBoundingClientRect().width || null);
    if (typeof ResizeObserver === "undefined") return () => setPageColumn(null);
    const observer = new ResizeObserver(() => { const w = el.getBoundingClientRect().width; if (w) setPageColumn(w); });
    observer.observe(el);
    return () => { observer.disconnect(); setPageColumn(null); };
  }, [ref]);
}

/** The last step alone as the title, with the whole trail as the window title; the page picker and Back keep the way up. */
export function narrowTitle(t: ExperimentalPageTitle | null): ExperimentalPageTitle | null {
  if (!t?.breadcrumbs?.length) return t;
  return { title: t.breadcrumbs.at(-1)!.label, windowTitle: t.windowTitle ?? t.breadcrumbs.map((b) => b.label).join(" / ") };
}
