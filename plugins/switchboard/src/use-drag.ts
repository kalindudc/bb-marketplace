import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefCallback, type RefObject } from "react";
import { resolveHeaderEdge, resolveRowInstruction } from "./drop-geometry";
import type { DensityMetrics } from "./metrics";
import { planDrop, type DropPlan, type DropTarget, type TreeIndex } from "./drop-plan";
import type { CollapseKey, GroupKey } from "./layout";
import { selectionRoots, type Selection } from "./selection";

export type DragSubject = { kind: "threads"; ids: readonly string[] } | { kind: "section"; sectionId: string };
export type DragTarget = DropTarget | { kind: "section"; sectionId: string; edge: "above" | "below" };
export interface DragView {
  subject: DragSubject;
  target: DragTarget | null;
  plan: DropPlan | null;
  indicator: { top: number; left: number; width: number } | null;
}
export interface DragController {
  view: DragView | null;
  ghostRef: RefCallback<HTMLDivElement>;
  onRowPointerDown(event: ReactPointerEvent, threadId: string): void;
  onSectionPointerDown(event: ReactPointerEvent, sectionId: string): void;
  consumeClick(): boolean;
}
export interface DragOptions {
  index: TreeIndex;
  selection: Selection;
  metrics: DensityMetrics;
  enabled: boolean;
  rootRef: RefObject<HTMLElement | null>;
  sectionIds: readonly string[];
  hitTest?: (x: number, y: number) => Element | null;
  onDropThreads(plan: Extract<DropPlan, { ok: true }>): void;
  onDropSection(ids: readonly string[]): void;
  onExpand(key: CollapseKey): void;
}
interface Gesture {
  pointerId: number; x: number; y: number; subject: DragSubject;
  started: boolean; cancelled: boolean; scroller: HTMLElement | null;
}
type Ending = "drop" | "cancel" | "lost";
// Any direction counts: bb's split drag takes over past the sidebar edge by dispatching Escape, which cancels this one.
const DRAG_START_PX = 5;

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current && !/auto|scroll/.test(getComputedStyle(current).overflowY)) current = current.parentElement;
  return current;
}

export function useDrag(options: DragOptions): DragController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [view, setView] = useState<DragView | null>(null);
  const viewRef = useRef<DragView | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);
  const swallowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverKey = useRef<CollapseKey | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const removeListeners = useRef<() => void>(() => {});
  const show = useCallback((next: DragView | null) => {
    viewRef.current = next;
    setView(next);
  }, []);
  const clearHover = useCallback(() => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    hoverKey.current = null;
  }, []);
  const stopSwallowing = useCallback(() => {
    if (swallowTimer.current !== null) clearTimeout(swallowTimer.current);
    swallowTimer.current = null;
    swallowClick.current = false;
  }, []);
  const placeGhost = useCallback((origin = optionsRef.current.rootRef.current?.getBoundingClientRect()) => {
    if (ghost.current && origin) ghost.current.style.transform =
      `translate3d(${pointer.current.x - origin.left + 12}px, ${pointer.current.y - origin.top + 16}px, 0)`;
  }, []);
  // React attaches the ghost before painting it, so placing it here keeps its first frame at the cursor.
  const ghostRef = useCallback((element: HTMLDivElement | null) => {
    ghost.current = element;
    placeGhost();
  }, [placeGhost]);
  const hide = useCallback(() => {
    clearHover();
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    show(null);
  }, [clearHover, show]);
  const applyDrop = useCallback((subject: DragSubject) => {
    const plan = viewRef.current?.plan;
    const target = viewRef.current?.target;
    if (subject.kind === "threads" && plan?.ok === true) optionsRef.current.onDropThreads(plan);
    if (subject.kind === "section" && target?.kind === "section") {
      const sections = [...optionsRef.current.sectionIds];
      const from = sections.indexOf(subject.sectionId);
      const to = sections.indexOf(target.sectionId);
      if (from >= 0 && to >= 0 && from !== to) {
        sections.splice(from, 1);
        const destination = sections.indexOf(target.sectionId) + (target.edge === "below" ? 1 : 0);
        sections.splice(destination, 0, subject.sectionId);
        if (sections.some((id, index) => id !== optionsRef.current.sectionIds[index]))
          optionsRef.current.onDropSection(sections);
      }
    }
  }, []);
  const end = useCallback((ending: Ending) => {
    const current = gesture.current;
    if (!current) return;
    // A cancelled drag keeps its press until release, so that release's click does not open the row.
    if (ending === "cancel" && current.started) {
      current.cancelled = true;
      hide();
      return;
    }
    if (ending === "drop" && current.started) {
      if (!current.cancelled) applyDrop(current.subject);
      stopSwallowing();
      swallowClick.current = true;
      // The browser fires a release's click before any timer its pointerup queued, so only that click is swallowed.
      swallowTimer.current = setTimeout(stopSwallowing, 0);
    }
    gesture.current = null;
    removeListeners.current();
    removeListeners.current = () => {};
    hide();
  }, [applyDrop, hide, stopSwallowing]);

  const onMove = useCallback((event: PointerEvent) => {
    const current = gesture.current;
    if (!current || current.cancelled || event.pointerId !== current.pointerId) return;
    if (!current.started && Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_START_PX) return;
    const { index, metrics, hitTest, rootRef, onExpand } = optionsRef.current;
    const root = rootRef.current;
    if (!current.started) {
      current.started = true;
      current.scroller = scrollParent(root);
    }
    pointer.current = { x: event.clientX, y: event.clientY };
    const element = (hitTest ?? ((x, y) => document.elementFromPoint(x, y)))(event.clientX, event.clientY);
    const row = element?.closest<HTMLElement>("[data-sb-row]");
    const drop = row ? null : element?.closest<HTMLElement>("[data-sb-drop]");
    let target: DragTarget | null = null;
    let expansion: CollapseKey | null = null;
    let indicator: DragView["indicator"] = null;
    const origin = root?.getBoundingClientRect();
    if (current.subject.kind === "threads" && row?.dataset.threadId) {
      const rect = row.getBoundingClientRect();
      const depth = Number(row.dataset.depth ?? 0);
      const instruction = resolveRowInstruction({ x: event.clientX, y: event.clientY, rect, depth,
        base: metrics.base, indent: metrics.indent,
        isLastChild: row.dataset.lastChild === "true", hasOpenChildren: row.dataset.openChildren === "true" });
      target = { kind: "row", threadId: row.dataset.threadId, instruction };
      if (row.dataset.collapsed === "true") expansion = `thread:${row.dataset.threadId}`;
      if (origin) indicator = { top: (instruction.kind === "above" ? rect.top : rect.bottom) - origin.top,
        left: rect.left - origin.left + metrics.base + (instruction.kind === "out" ? instruction.level : depth) * metrics.indent,
        width: Math.max(12, rect.width - metrics.base - depth * metrics.indent) };
    } else if (drop?.dataset.sbDrop) {
      const rect = drop.getBoundingClientRect();
      if (current.subject.kind === "section" && drop.dataset.sbSection) {
        target = { kind: "section", sectionId: drop.dataset.sbSection, edge: resolveHeaderEdge(event.clientY, rect) };
      } else if (current.subject.kind === "threads") {
        target = { kind: "group", key: drop.dataset.sbDrop as GroupKey };
        if (drop.dataset.collapsed === "true") expansion = drop.dataset.sbDrop as CollapseKey;
      }
      if (origin) indicator = { top: (target?.kind === "section" && target.edge === "below" ? rect.bottom : rect.top) - origin.top,
        left: rect.left - origin.left + metrics.base, width: Math.max(12, rect.width - metrics.base) };
    }
    if (expansion !== hoverKey.current) {
      clearHover();
      hoverKey.current = expansion;
      if (expansion) hoverTimer.current = setTimeout(() => onExpand(expansion), 500);
    }
    const previous = viewRef.current;
    if (!previous || JSON.stringify(previous.target) !== JSON.stringify(target)) {
      const plan = current.subject.kind === "threads" && target && target.kind !== "section" ?
        planDrop(index, current.subject.ids, target) : null;
      show({ subject: current.subject, target: plan?.ok === "noop" ? null : target,
        plan, indicator: plan?.ok === "noop" ? null : indicator });
    }
    placeGhost(origin);
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    // Only the sidebar scrolls: a drag heading for bb's split must not scroll the thread under the pointer.
    const scroller = current.scroller;
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      const over = event.clientX >= rect.left && event.clientX <= rect.right;
      const amount = !over ? 0 : event.clientY - rect.top < 32 ? -12 : rect.bottom - event.clientY < 32 ? 12 : 0;
      if (amount) scrollFrame.current = requestAnimationFrame(() => { scroller.scrollTop += amount; });
    }
  }, [clearHover, placeGhost, show]);

  const begin = useCallback((event: ReactPointerEvent, subject: DragSubject) => {
    const stale = gesture.current;
    if (stale && stale.pointerId !== event.pointerId) return;
    // A new press from the same pointer means its last release never reached the window.
    if (stale) end("lost");
    if (!optionsRef.current.enabled || event.button !== 0 || event.pointerType === "touch" ||
        event.altKey || event.shiftKey || event.metaKey || event.ctrlKey) return;
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, subject,
      started: false, cancelled: false, scroller: null };
    const onUp = (up: PointerEvent) => { if (up.pointerId === gesture.current?.pointerId) end("drop"); };
    const onCancel = () => end("lost");
    const onVisibility = () => { if (document.visibilityState === "hidden") end("lost"); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onEscape);
    window.addEventListener("blur", onCancel);
    document.addEventListener("visibilitychange", onVisibility);
    function onEscape(key: KeyboardEvent) { if (key.key === "Escape") end("cancel"); }
    removeListeners.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("blur", onCancel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [end, onMove]);
  useEffect(() => () => {
    removeListeners.current();
    clearHover();
    stopSwallowing();
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
  }, [clearHover, stopSwallowing]);
  useEffect(() => { if (!options.enabled && gesture.current) end("cancel"); }, [options.enabled, end]);
  const onRowPointerDown = useCallback((event: ReactPointerEvent, threadId: string) => {
    const { selection, index } = optionsRef.current;
    const ids = selection.ids.has(threadId) ? selectionRoots(selection, index) : [threadId];
    begin(event, { kind: "threads", ids });
  }, [begin]);
  const onSectionPointerDown = useCallback((event: ReactPointerEvent, sectionId: string) =>
    begin(event, { kind: "section", sectionId }), [begin]);
  const consumeClick = useCallback(() => {
    if (!swallowClick.current) return false;
    stopSwallowing();
    return true;
  }, [stopSwallowing]);
  return { view, ghostRef, onRowPointerDown, onSectionPointerDown, consumeClick };
}
