import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
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
  ghostRef: RefObject<HTMLDivElement | null>;
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
interface Gesture { pointerId: number; x: number; y: number; subject: DragSubject; started: boolean }

export function useDrag(options: DragOptions): DragController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [view, setView] = useState<DragView | null>(null);
  const viewRef = useRef<DragView | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);
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
  const finish = useCallback((cancelled: boolean) => {
    const current = gesture.current;
    if (!current) return;
    if (current.started) {
      swallowClick.current = true;
      const plan = viewRef.current?.plan;
      const target = viewRef.current?.target;
      if (!cancelled && current.subject.kind === "threads" && plan?.ok === true)
        optionsRef.current.onDropThreads(plan);
      if (!cancelled && current.subject.kind === "section" && target?.kind === "section") {
        const sections = [...optionsRef.current.sectionIds];
        const from = sections.indexOf(current.subject.sectionId);
        const to = sections.indexOf(target.sectionId);
        if (from >= 0 && to >= 0 && from !== to) {
          sections.splice(from, 1);
          const destination = sections.indexOf(target.sectionId) + (target.edge === "below" ? 1 : 0);
          sections.splice(destination, 0, current.subject.sectionId);
          if (sections.some((id, index) => id !== optionsRef.current.sectionIds[index]))
            optionsRef.current.onDropSection(sections);
        }
      }
    }
    gesture.current = null;
    clearHover();
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    removeListeners.current();
    removeListeners.current = () => {};
    show(null);
  }, [clearHover, show]);

  const onMove = useCallback((event: PointerEvent) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const horizontal = Math.abs(event.clientX - current.x);
    const vertical = Math.abs(event.clientY - current.y);
    if (!current.started && horizontal > 8 && horizontal > vertical) { finish(true); return; }
    if (!current.started && vertical < 6) return;
    current.started = true;
    const { index, metrics, hitTest, rootRef, onExpand } = optionsRef.current;
    const root = rootRef.current;
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
    if (ghostRef.current && origin) ghostRef.current.style.transform =
      `translate3d(${event.clientX - origin.left + 12}px, ${event.clientY - origin.top + 16}px, 0)`;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    let scrolling = element?.parentElement;
    while (scrolling && !/auto|scroll/.test(getComputedStyle(scrolling).overflowY)) scrolling = scrolling.parentElement;
    if (scrolling) {
      const rect = scrolling.getBoundingClientRect();
      const amount = event.clientY - rect.top < 32 ? -12 : rect.bottom - event.clientY < 32 ? 12 : 0;
      if (amount) scrollFrame.current = requestAnimationFrame(() => { scrolling.scrollTop += amount; });
    }
  }, [clearHover, finish, show]);

  const begin = useCallback((event: ReactPointerEvent, subject: DragSubject) => {
    if (!optionsRef.current.enabled || event.button !== 0 || event.pointerType === "touch" ||
        event.altKey || event.shiftKey || event.metaKey || event.ctrlKey || gesture.current) return;
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, subject, started: false };
    const onUp = (up: PointerEvent) => { if (up.pointerId === gesture.current?.pointerId) finish(false); };
    const onCancel = () => finish(true);
    const onVisibility = () => { if (document.visibilityState === "hidden") finish(true); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onEscape);
    window.addEventListener("blur", onCancel);
    document.addEventListener("visibilitychange", onVisibility);
    function onEscape(key: KeyboardEvent) { if (key.key === "Escape") finish(true); }
    removeListeners.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("blur", onCancel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [finish, onMove]);
  useEffect(() => () => {
    removeListeners.current();
    clearHover();
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
  }, [clearHover]);
  useEffect(() => { if (!options.enabled && gesture.current) finish(true); }, [options.enabled, finish]);
  const onRowPointerDown = useCallback((event: ReactPointerEvent, threadId: string) => {
    const { selection, index } = optionsRef.current;
    const ids = selection.ids.has(threadId) ? selectionRoots(selection, index) : [threadId];
    begin(event, { kind: "threads", ids });
  }, [begin]);
  const onSectionPointerDown = useCallback((event: ReactPointerEvent, sectionId: string) =>
    begin(event, { kind: "section", sectionId }), [begin]);
  const consumeClick = useCallback(() => {
    if (!swallowClick.current) return false;
    swallowClick.current = false;
    return true;
  }, []);
  return { view, ghostRef, onRowPointerDown, onSectionPointerDown, consumeClick };
}
