import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { rememberScroll, scrolls } from "./prefs";

/** About five seconds of frames: enough for a cold list or late-rendering PR description to settle. */
const MAX_FRAMES = 300;
const USER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

const nextFrame = (callback: () => void): (() => void) => {
  if (typeof window.requestAnimationFrame === "function") {
    const handle = window.requestAnimationFrame(callback);
    return () => window.cancelAnimationFrame(handle);
  }
  const handle = window.setTimeout(callback, 16);
  return () => window.clearTimeout(handle);
};

/**
 * Remembers how far a scrolling list was scrolled under `key`, and scrolls back there when the list shows again: after
 * a visit elsewhere in bb, on returning from a PR on a phone, or when a PR opening beside it moves the list to another
 * element. Until the list is tall enough the position is tried again each frame; scrolling, clicking or typing first
 * wins. PR panes use `settle` to hold the position while Markdown finishes rendering. A null key remembers nothing.
 */
export function useScrollMemory(key: string | null, settle = false) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const restoring = useRef(false);
  const current = useRef(key);
  current.current = key;

  useLayoutEffect(() => {
    if (node === null || key === null) return;
    const target = scrolls.get()[key] ?? 0;
    let frames = 0;
    let cancel = () => {};
    const anchor = node.style.overflowAnchor;
    if (settle) node.style.overflowAnchor = "none";
    const stop = () => {
      restoring.current = false;
      cancel();
      if (settle) node.style.overflowAnchor = anchor;
      for (const type of USER_INPUT) node.removeEventListener(type, stop);
    };
    const attempt = () => {
      node.scrollTop = target;
      if ((!settle && Math.abs(node.scrollTop - target) < 2) || ++frames > MAX_FRAMES) return stop();
      cancel = nextFrame(attempt);
    };
    restoring.current = true;
    for (const type of USER_INPUT) node.addEventListener(type, stop, { passive: true });
    attempt();
    return stop;
  }, [node, key, settle]);

  const onScroll = useCallback(() => {
    // The browser clamps a list that is still loading; that is not where the user left it.
    if (restoring.current || node === null || current.current === null) return;
    rememberScroll(current.current, node.scrollTop);
  }, [node]);

  return { ref: setNode, onScroll };
}
