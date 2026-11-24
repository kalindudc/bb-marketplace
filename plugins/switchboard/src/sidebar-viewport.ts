import { useLayoutEffect, useState, type RefObject } from "react";

const COMPACT_WIDTH = 300;
const INFO_GAP = 8;
// Below the normal At a glance width, use the scrollable compact details instead.
const MIN_ADJACENT_INFO_WIDTH = 288;

export function infoPlacement(
  sidebar: Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom">,
  viewportWidth: number, viewportHeight: number,
) {
  const left = Math.max(0, sidebar.left);
  const top = Math.max(0, sidebar.top);
  const besideLeft = Math.max(INFO_GAP, sidebar.right + INFO_GAP);
  const besideWidth = Math.max(0, viewportWidth - besideLeft - INFO_GAP);
  return {
    left, top, width: Math.max(0, Math.min(viewportWidth, sidebar.right) - left),
    height: Math.max(0, Math.min(viewportHeight, sidebar.bottom) - top),
    besideLeft, besideWidth, fitsBeside: besideWidth >= MIN_ADJACENT_INFO_WIDTH,
  };
}

export function sidebarScrollParent(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current && !/auto|scroll/.test(getComputedStyle(current).overflowY)) current = current.parentElement;
  return current;
}

export function useCompactSidebar(root: RefObject<HTMLElement | null>, hostCompact: boolean): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const node = root.current;
    if (hostCompact || !node) return;
    const touch = window.matchMedia?.("(pointer: coarse), (hover: none)");
    let width = 0;
    let previous: boolean | undefined;
    const update = () => {
      const next = touch?.matches === true || (width > 0 && width <= COMPACT_WIDTH);
      if (next !== previous) { previous = next; setCompact(next); }
    };
    // The observer supplies laid-out width; reading the entire list here would force layout during mount.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([entry]) => {
      if (entry) { width = entry.contentRect.width; update(); }
    });
    const fallback = () => { width = node.clientWidth; update(); };
    if (observer) { observer.observe(node); update(); }
    else { fallback(); window.addEventListener("resize", fallback); }
    touch?.addEventListener("change", update);
    return () => {
      observer?.disconnect();
      touch?.removeEventListener("change", update);
      window.removeEventListener("resize", fallback);
    };
  }, [root, hostCompact]);
  return hostCompact || compact;
}
