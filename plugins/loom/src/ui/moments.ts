// The list's moments: when a ticket lands, is requeued or moves group, its row appears at its new place and the rows
// between slide to close the gap, all in the list's own layout. No row's text passes over another's: a row that changes
// group fades in where it now is instead of travelling, and only rows that keep their group slide, all one way. Nothing
// is added to the page for a moment, so nothing can outlive it; a new change, an unmount or reduced motion cancels what
// runs.
import { useEffect, useLayoutEffect, useRef, type DependencyList, type RefObject } from "react";

interface Place {
  top: number;
  group: string | null;
}

const reduced = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useFlip(root: RefObject<HTMLElement | null>, deps: DependencyList): void {
  const last = useRef<Map<string, Place> | null>(null);
  const running = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    const node = root.current;
    if (node === null) return;
    for (const animation of running.current) animation.cancel();
    running.current = [];
    const origin = node.getBoundingClientRect().top;
    const next = new Map<string, Place>();
    const elements = new Map<string, HTMLElement>();
    for (const element of node.querySelectorAll<HTMLElement>("[data-flip]")) {
      const key = element.dataset.flip!;
      next.set(key, { top: element.getBoundingClientRect().top - origin, group: element.dataset.group ?? null });
      elements.set(key, element);
    }
    const before = last.current;
    last.current = next;
    if (before === null || reduced()) return;
    const animate = (element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) => {
      if (typeof element.animate !== "function") return;
      running.current.push(element.animate(frames, { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)", ...options }));
    };
    for (const [key, place] of next) {
      const was = before.get(key);
      const element = elements.get(key)!;
      if (was === undefined) continue;
      if (was.group !== place.group) {
        animate(element, [{ opacity: 0, transform: "translateX(-6px)" }, { opacity: 1, transform: "none" }], { duration: 220 });
        continue;
      }
      const dy = was.top - place.top;
      if (Math.abs(dy) > 0.5) animate(element, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], {});
    }
    // A row that left the list for the Done fold: the fold's count marks where it went.
    const left = [...before.keys()].some((key) => !next.has(key) && !key.startsWith("g-"));
    const count = node.querySelector<HTMLElement>("[data-done-count]");
    if (left && count !== null) animate(count, [{ transform: "scale(1)" }, { transform: "scale(1.35)" }, { transform: "scale(1)" }], { duration: 320 });
    // The dependencies say when to measure again; they change with the rows.
  }, deps);
  useEffect(
    () => () => {
      for (const animation of running.current) animation.cancel();
      running.current = [];
    },
    [],
  );
}
