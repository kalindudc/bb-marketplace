import { useLayoutEffect, useRef, type ReactNode } from "react";

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Scroll to a section and move focus to its heading, so the next Tab continues inside that section. Focus goes first, without
 * scrolling, so the held columns' focus handler never adds a second scroll. An explicit smooth scroll would beat the CSS rule,
 * so reduced motion is asked for here.
 */
let pending: { id: string; at: number } | null = null;
/** A jump for the common room to make when it next shows, for links that open it from elsewhere ("All Keepers"). Kept 5 s. */
export function jumpWhenShown(id: string) { pending = { id, at: Date.now() }; }
/** The pending jump, once, if it is fresh. */
export function takePendingJump(): string | null { const p = pending; pending = null; return p && Date.now() - p.at < 5000 ? p.id : null; }

export function jumpTo(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  const target = (section.matches("h1, h2, h3") ? section : section.querySelector("h1, h2, h3") ?? section) as HTMLElement;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  section.scrollIntoView?.({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
}

/** Where a held column sits, as a pure step: what `useHeldColumn` computes on each frame. */
export type HeldInput = {
  /** The page's scroll position, the visible height and the scroll since the last frame. */
  scroll: number; view: number; moved: number;
  /** The column's height, and the top of the band it lives in, in page coordinates. */
  height: number; bandTop: number;
  /** The column's current shift below its band's top. */
  shift: number;
  /** The band's natural height: the taller column's own height. A column shifted past it would lengthen the page. */
  room?: number;
};

/**
 * A column taller than the screen moves with the page and holds once its end (scrolling down) or its start (scrolling up)
 * is in view; a shorter one holds at the top. A column that just grew or shrank sits outside those bounds and eases back
 * only as fast as the page scrolls, so expanding something never moves what is under the pointer.
 */
export function placeHeld({ scroll, view, moved, height, bandTop, shift, room }: HeldInput): number {
  const lowest = Math.min(0, view - height - 16);
  let y = bandTop + shift - scroll;
  if (y < lowest) y = Math.min(lowest, y + moved); else if (y > 0) y = Math.max(0, y - moved);
  const next = Math.max(0, scroll + y - bandTop);
  if (room === undefined) return next;
  // Past the band's natural end a column may only ease back. Growing there lengthens the page, which makes room for the next
  // push: at the page's end, where its 16 px bound cannot be reached, each wheel input added the page's bottom space again.
  const cap = Math.max(0, room - height);
  return next > cap ? Math.max(cap, Math.min(next, shift)) : next;
}

/** What each held column needs of its band, so two columns never overwrite each other's minimum height. */
const bandNeeds = new WeakMap<HTMLElement, Map<HTMLElement, number>>();

/**
 * A column that holds, with no scroll area of its own (Steve's rail, design/room/why.md). It moves only with `transform`,
 * at most once per frame. Below the rail's 900 px switch the columns dissolve (`display: contents`), and the hook stands still.
 */
export function useHeldColumn<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const scroller = el?.closest(".tv-page-root") as HTMLElement | null;
    const band = el?.parentElement;
    if (!el || !scroller || !band) return;
    let shift = 0, raf = 0, last = scroller.scrollTop;
    const place = () => {
      raf = 0;
      const scroll = scroller.scrollTop, moved = Math.abs(scroll - last);
      last = scroll;
      const needs = bandNeeds.get(band) ?? new Map<HTMLElement, number>();
      bandNeeds.set(band, needs);
      if (getComputedStyle(el).display === "contents") { shift = 0; el.style.transform = ""; needs.delete(el); band.style.minHeight = ""; return; }
      const bandTop = band.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroll;
      // The columns align to the top of their row, so each one's offsetHeight is its own height, whatever the band's minimum.
      const natural = Math.max(...[...band.children].map((c) => (c as HTMLElement).offsetHeight));
      shift = placeHeld({ scroll, view: scroller.clientHeight, moved, height: el.offsetHeight, bandTop, shift, room: natural });
      needs.set(el, shift + el.offsetHeight);
      const need = Math.max(...needs.values());
      band.style.minHeight = need > natural ? `${Math.ceil(need)}px` : "";
      el.style.transform = shift ? `translateY(${shift}px)` : "";
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(place); };
    // Keyboard focus that lands in a held column settles the column, then brings the control fully into view. A click needs
    // nothing, and a section jump's heading (tabindex -1) has already scrolled.
    const onFocus = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (!target.matches(":focus-visible") || target.tabIndex < 0) return;
      requestAnimationFrame(() => { place(); target.scrollIntoView({ block: "nearest" }); requestAnimationFrame(place); });
    };
    place();
    scroller.addEventListener("scroll", schedule, { passive: true });
    el.addEventListener("focusin", onFocus);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    ro?.observe(el); ro?.observe(scroller);
    return () => { scroller.removeEventListener("scroll", schedule); el.removeEventListener("focusin", onFocus); ro?.disconnect(); if (raf) cancelAnimationFrame(raf); bandNeeds.get(band)?.delete(el); };
  }, []);
  return ref;
}

const PLACE_ITEMS = ".tv-askrow, .di, .tv-ev, .qrow, .rm-nh, .krow, .tv-erow, [data-sec], .tv-colh";
/**
 * Keeps your place while the page changes width (bb's side panel opening, a window resize), across the switch to one column
 * and every reflow after it. The topmost item on screen is remembered while you scroll and frozen for the whole resize, then
 * put back at the same height after each change and again once the held columns settle. With two columns it is the topmost
 * item of the column you are reading (the last one you scrolled over, pressed, touched or focused; the rail until then),
 * because a held board item can sit higher than the line you are on, and it moves below the rail when the columns become one.
 * Hover does not count: Chrome sends hover events whenever content scrolls under a resting pointer. A few items are kept, so
 * one that a refresh replaced or emptied is skipped, and they are picked again after the content changes.
 */
export function useKeepPlaceOnResize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const grid = ref.current;
    const scroller = grid?.closest(".tv-page-root") as HTMLElement | null;
    if (!grid || !scroller || typeof ResizeObserver === "undefined") return;
    let anchors: { el: Element; offset: number }[] = [], raf = 0, settle = 0, resizing = false, width = grid.clientWidth;
    let reading: "rail" | "main" = "rail";
    const top = () => scroller.getBoundingClientRect().top;
    const columnOf = (target: EventTarget | null) => (target instanceof Element ? target.closest("[data-col]")?.getAttribute("data-col") : null);
    const onReader = (e: Event) => { const col = columnOf(e.target); if ((col === "rail" || col === "main") && col !== reading) { reading = col; if (!resizing && !raf) raf = requestAnimationFrame(pick); } };
    const changed = new MutationObserver(() => { if (!resizing && !raf) raf = requestAnimationFrame(pick); });
    const pick = () => {
      raf = 0;
      if (resizing) return;
      const col = grid.querySelector<HTMLElement>(`[data-col="${reading}"]`);
      const scope = col && getComputedStyle(col).display !== "contents" ? col : scroller;
      const seen: { el: Element; offset: number }[] = [];
      for (const el of scope.querySelectorAll(PLACE_ITEMS)) {
        const box = el.getBoundingClientRect();
        const y = box.top - top();
        if (y >= -4 && box.height > 0) seen.push({ el, offset: y });
      }
      anchors = seen.sort((a, b) => a.offset - b.offset).slice(0, 4);
    };
    const restore = () => {
      const a = anchors.find((x) => x.el.isConnected && x.el.getBoundingClientRect().height > 0);
      if (a) scroller.scrollTop += a.el.getBoundingClientRect().top - top() - a.offset;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(pick); };
    const ro = new ResizeObserver(() => {
      if (grid.clientWidth === width) return;
      width = grid.clientWidth;
      resizing = true;
      restore();
      requestAnimationFrame(() => { restore(); requestAnimationFrame(restore); });
      clearTimeout(settle);
      settle = window.setTimeout(() => { resizing = false; }, 300);
    });
    pick();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const intents = ["wheel", "pointerdown", "touchstart", "focusin"] as const;
    for (const type of intents) grid.addEventListener(type, onReader, { passive: true });
    changed.observe(grid, { childList: true, subtree: true });
    ro.observe(grid);
    return () => { scroller.removeEventListener("scroll", onScroll); for (const type of intents) grid.removeEventListener(type, onReader); changed.disconnect(); ro.disconnect(); clearTimeout(settle); if (raf) cancelAnimationFrame(raf); };
  }, []);
  return ref;
}

/**
 * The rail: two held columns at a page of 900 px and wider. Left: what needs you, the side lists, the history. Right: the
 * board, the cellar. Narrower, one column in why.md's order: needs, decided, review, board, side lists, history, cellar.
 */
export function Rail({ attention, board, lists, events, cellar }: { attention: ReactNode; board: ReactNode; lists: ReactNode; events: ReactNode; cellar: ReactNode }) {
  const left = useHeldColumn<HTMLElement>();
  const right = useHeldColumn<HTMLDivElement>();
  const grid = useKeepPlaceOnResize<HTMLDivElement>();
  return <div ref={grid} className="rm-a-grid">
    <aside ref={left} className="rm-a-rail" data-col="rail" aria-label="What needs you and what happened">
      <div className="rm-o1 rm-stackcol">{attention}</div>
      <div className="rm-o3 rm-stackcol">{lists}</div>
      <div className="rm-o4">{events}</div>
    </aside>
    <div ref={right} className="rm-a-main" data-col="main">
      <div className="rm-o2">{board}</div>
      <div className="rm-o5">{cellar}</div>
    </div>
  </div>;
}
