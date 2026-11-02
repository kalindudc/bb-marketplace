import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePortalScope } from "./common";
import { panelWidth } from "./prefs";
import { useStored } from "./remember";

export const PANEL_DEFAULT_PX = 640;
export const PANEL_MIN_PX = 400;
/** Beside a list, the list keeps at least this much of the page. */
const LIST_MIN_PX = 360;
/** Over a list, this much of it stays in sight, for a click that closes the panel. */
const SCRIM_MIN_PX = 48;
const STEP_PX = 32;
const BIG_STEP_PX = 128;

const FRAME_SIDE = "relative flex min-w-0 shrink-0 flex-col border-l border-border";
const FRAME_OVERLAY = "absolute inset-y-0 right-0 z-20 flex flex-col border-l border-border bg-background shadow-lg animate-in slide-in-from-right duration-200";

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * The PR panel beside a list, or over it in a narrower window, with an edge that drags it wider or narrower.
 * Focused, the edge takes the arrows (Shift for bigger steps), Home and End; a double-click puts back the default width.
 * The width is remembered on this device and shared by both. The panel's own scroller comes in as `children`.
 */
export function ResizablePanel({ overlay, children }: { overlay: boolean; children: ReactNode }) {
  const stored = useStored(panelWidth);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; max: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const reserve = overlay ? SCRIM_MIN_PX : LIST_MIN_PX;
  const scope = usePortalScope();

  const bounds = () => {
    const node = frame.current;
    const shown = node?.getBoundingClientRect().width ?? 0;
    const room = node?.parentElement?.clientWidth ?? 0;
    return { width: shown > 0 ? shown : stored ?? PANEL_DEFAULT_PX, max: room > 0 ? room - reserve : Number.POSITIVE_INFINITY };
  };
  const set = (width: number, max: number) => {
    if (Number.isFinite(width)) panelWidth.set(Math.round(clamp(width, PANEL_MIN_PX, max)));
  };

  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    const before = root.style.userSelect;
    root.style.userSelect = "none";
    return () => {
      root.style.userSelect = before;
    };
  }, [dragging]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const { width, max } = bounds();
    drag.current = { x: event.clientX, width, max };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    // The edge is on the panel's left, so moving left makes it wider.
    if (start !== null) set(start.width + start.x - event.clientX, start.max);
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const { width, max } = bounds();
    const step = event.shiftKey ? BIG_STEP_PX : STEP_PX;
    const next = event.key === "ArrowLeft" ? width + step : event.key === "ArrowRight" ? width - step
      : event.key === "Home" ? PANEL_MIN_PX : event.key === "End" ? max : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    set(next, max);
  };

  const now = stored ?? PANEL_DEFAULT_PX;
  const style = stored === null ? undefined : { width: `${stored}px`, maxWidth: `calc(100% - ${reserve}px)` };
  const width = stored !== null ? "" : overlay ? "w-[min(640px,88%)]" : "w-[640px] max-w-[55%]";
  return (
    <div ref={frame} data-panel-frame className={`${overlay ? FRAME_OVERLAY : FRAME_SIDE} ${width}`} style={style}>
      <div role="separator" aria-orientation="vertical" aria-label="Resize the PR panel" aria-valuemin={PANEL_MIN_PX} aria-valuenow={now} aria-valuetext={`${now} pixels wide`}
        tabIndex={0} title="Drag to resize. Double-click for the default width." data-resize={dragging ? "dragging" : ""}
        className="group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none outline-none"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onLostPointerCapture={onPointerEnd}
        onDoubleClick={() => panelWidth.set(null)} onKeyDown={onKeyDown}>
        <span aria-hidden className={`mx-auto block h-full w-0.5 transition-colors ${dragging ? "bg-ring" : "bg-transparent group-hover:bg-ring group-focus-visible:bg-ring"}`} />
      </div>
      {children}
      {/* While dragging, a sheet over everything keeps the resize cursor, whatever the pointer passes over. */}
      {dragging && createPortal(<div {...scope} aria-hidden className="fixed inset-0 z-[100] cursor-col-resize" />, document.body)}
    </div>
  );
}
