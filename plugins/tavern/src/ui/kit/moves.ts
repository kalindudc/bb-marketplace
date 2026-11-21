import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { MAX_TRAVEL_PX, useTavernMotion, type Surface } from "./motion";

const scrollBox = (el: HTMLElement) => {
  for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p.getBoundingClientRect();
  return { top: 0, bottom: window.innerHeight };
};
const outOfView = (el: HTMLElement) => { const r = el.getBoundingClientRect(), v = scrollBox(el); return r.top < v.top || r.bottom > v.bottom; };
type Spot = { top: number; left: number };
const LIVE = new Set(["active", "your-move", "archived"]);
/** Rows that never move: an ask, a your-move row, a failed quest. A group holding one of them takes its new places without motion. */
const held = (el: Element) => el.matches("[data-ask], [data-variant='your-move'], .t-bad");
const rowsOf = (root: HTMLElement, also?: string) => [...root.querySelectorAll<HTMLElement>(also ? `[data-quest], ${also}` : "[data-quest]")];
const keyOf = (el: HTMLElement, i: number, also?: string) => el.dataset.quest ?? `${also}:${i}`;
/** Each row's place relative to the list, so a scroll of the page between two reads moves nothing. */
function placesOf(root: HTMLElement, rows: HTMLElement[], also?: string) {
  const base = root.getBoundingClientRect();
  return new Map(rows.map((el, i) => { const b = el.getBoundingClientRect(); return [keyOf(el, i, also), { top: b.top - base.top, left: b.left - base.left }] as const; }));
}

/**
 * The quest-return cue for a list of QuestRows under `ref` (rows carry `data-quest` and `data-variant`). When a live quest comes back
 * returned, its row slides to its returned place if the move is at most MAX_TRAVEL_PX and crosses no other row; otherwise it fades in and
 * rises 8 px where it lands. The rows below that moved slide as one group, or take their new places at once if the group holds a row that
 * never moves. `also` names other elements that move with the rows (a "+N more" fold), so nothing overlaps mid-flight.
 * Only a return moves anything; any other reflow lands without motion. A returned row is a new element in another list, so when focus
 * was inside it, focus follows it to its returned place, with or without motion.
 * A commit reads layout only when a row has just come back returned. Other position snapshots follow changes to the list's
 * contents, size or scroll, after the frame is drawn.
 * Two commits in one frame, a reorder and then a return, slide from the places before the reorder. That is rare, and the crossing rule
 * usually turns such a move into a fade.
 */
export function useReturnCue(ref: RefObject<HTMLElement | null>, { surface = "page", also }: { surface?: Surface; also?: string } = {}) {
  const places = useRef(new Map<string, Spot>());
  const variants = useRef(new Map<string, string>());
  const focused = useRef<HTMLElement | null>(null);
  const { cue } = useTavernMotion(surface);
  const drawn = useRef<{ raf: number; timer: ReturnType<typeof setTimeout> | undefined; also?: string }>({ raf: 0, timer: undefined });
  const afterDraw = () => {
    const d = drawn.current;
    if (d.raf || d.timer !== undefined) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = 0;
      d.timer = setTimeout(() => { d.timer = undefined; const root = ref.current; if (root) places.current = placesOf(root, rowsOf(root, d.also), d.also); }, 0);
    });
  };
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const on = (e: FocusEvent) => { focused.current = e.target as HTMLElement; };
    // A blur that leaves the element in the page clears it; a removal keeps it, so the commit below can move focus to the new row.
    const off = (e: FocusEvent) => { const el = e.target as HTMLElement; queueMicrotask(() => { if (el.isConnected && focused.current === el && document.activeElement !== el) focused.current = null; }); };
    root.addEventListener("focusin", on); root.addEventListener("focusout", off);
    root.addEventListener("scroll", afterDraw, { capture: true, passive: true });
    // The list's own width, not the window's: bb's side panel narrows the page column with no window resize, and rows wrap to new places.
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(afterDraw);
    sized?.observe(root);
    const changed = new MutationObserver(afterDraw);
    changed.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-quest", "data-variant", "class", "style", "hidden", "open"] });
    afterDraw();
    const d = drawn.current;
    return () => {
      root.removeEventListener("focusin", on); root.removeEventListener("focusout", off);
      root.removeEventListener("scroll", afterDraw, { capture: true }); sized?.disconnect(); changed.disconnect();
      cancelAnimationFrame(d.raf); clearTimeout(d.timer); d.raf = 0; d.timer = undefined;
    };
  }, [ref]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const lost = focused.current, lostQuest = lost?.closest<HTMLElement>("[data-quest]")?.dataset.quest;
    if (lost && !lost.isConnected && lostQuest && (document.activeElement === document.body || document.activeElement === null)) {
      const again = [...root.querySelectorAll<HTMLElement>("[data-quest]")].find(el => el.dataset.quest === lostQuest)?.querySelector<HTMLElement>("[data-quest-name]");
      if (again) {
        focused.current = again; again.focus({ preventScroll: true });
        // Landing below the fold (a long returned list on a phone) would leave focus out of sight, so bring it just into view.
        if (outOfView(again)) again.scrollIntoView?.({ block: "nearest" });
      }
    }
    drawn.current.also = also;
    const items = rowsOf(root, also);
    const was = variants.current;
    variants.current = new Map(items.map((el, i) => [keyOf(el, i, also), el.dataset.variant ?? ""]));
    const prev = places.current;
    if (!prev.size) return;
    const back = items.find(el => el.dataset.variant === "returned" && LIVE.has(was.get(el.dataset.quest ?? "") ?? ""));
    if (!back) return;
    const now = placesOf(root, items, also);
    places.current = now;
    const id = back.dataset.quest!, from = prev.get(id), is = now.get(id)!;
    // A row first drawn in the same frame it returned has no earlier place to slide from, so it fades in where it lands.
    const dx = from ? from.left - is.left : 0, dy = from ? from.top - is.top : 0;
    const lo = Math.min(from?.top ?? is.top, is.top), hi = Math.max(from?.top ?? is.top, is.top);
    const crosses = [...prev].some(([other, p]) => other !== id && now.has(other) && p.top > lo && p.top < hi);
    const slide = !!from && Math.hypot(dx, dy) <= MAX_TRAVEL_PX && !crosses;
    cue(back, "quest returns", {
      key: id, ms: 500,
      run: el => [slide
        ? el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 500, easing: "cubic-bezier(.65, 0, .35, 1)" })
        : el.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: 150, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "backwards" })],
    });
    const group = items.filter((el, i) => { const k = keyOf(el, i, also), p = prev.get(k), n = now.get(k)!; return el !== back && p && Math.abs(p.top - n.top) > 0.5; });
    if (!group.length || group.some(held)) return;
    cue(root, "rows settle", {
      key: `group:${id}`, ms: 450,
      run: () => group.map(el => { const k = keyOf(el, items.indexOf(el), also), p = prev.get(k)!, n = now.get(k)!; return el.animate([{ transform: `translate(${p.left - n.left}px, ${p.top - n.top}px)` }, { transform: "none" }], { duration: 450, easing: "cubic-bezier(.65, 0, .35, 1)" }); }),
    });
  });
}
