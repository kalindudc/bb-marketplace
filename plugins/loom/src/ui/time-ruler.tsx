// The time ruler: one line on every project view (decision 5). Its ticks are the project's moments, shaped by kind; the
// playhead shows where the page is, and dragging it, the arrow keys, [ and ] or the step buttons rewind the page.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Moment, ProjectTimeline } from "../contract";
import { useLoom } from "./common";
import { Tip } from "./kit";
import { axisOf, foldsOf, lastIndexAt, nearestIndex } from "./timeline-axis";

const PAD = 8;
const LABEL_GAP = 10;
const PLAY_MS = 650;

const dayLabel = (at: number) => new Date(at).toLocaleDateString([], { weekday: "short", day: "numeric" });
const momentWhen = (at: number) => new Date(at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const shortWhen = (at: number) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const tellingLine = (moment: Moment) => moment.lines.find((line) => line.kind === moment.kind) ?? moment.lines[0];

export interface Moments {
  data: ProjectTimeline | null;
  moments: readonly Moment[];
  /** The last position, which is now. */
  nowPosition: number;
  /** Where the page is: nowPosition while live. */
  position: number;
  seekPosition(position: number): void;
  step(delta: number): void;
  /** The moment the page is rewound to; null at now. */
  shown: Moment | null;
}

/** The project's moments and the page's place among them, shared by the ruler and the page's [ and ] keys. */
export function useMoments(slug: string, at: number | null, onSeek: (at: number | null) => void): Moments {
  const data = useLoom("timeline", { slug }).data ?? null;
  const moments = data?.moments ?? [];
  const n = moments.length;
  // The newest moment is the live page when nothing happened after it, as the full timeline counts it.
  const tailIsNow = n > 0 && moments[n - 1]!.at >= (data?.events.at(-1)?.[1] ?? 0);
  const nowPosition = n === 0 ? 0 : tailIsNow ? n - 1 : n;
  const ids = moments.map((moment) => moment.id);
  const index = at === null ? -1 : lastIndexAt(ids, at);
  const position = at === null ? nowPosition : Math.max(0, index);
  const seekPosition = (next: number) => {
    const clamped = Math.min(nowPosition, Math.max(0, next));
    onSeek(clamped === nowPosition ? null : moments[clamped]!.id);
  };
  return {
    data,
    moments,
    nowPosition,
    position,
    seekPosition,
    step: (delta) => seekPosition(position + delta),
    shown: at === null ? null : (moments[position] ?? null),
  };
}

/** Text widths from the font the ruler draws in; jsdom, which has no canvas, falls back to the monospace advance. */
function measurer(element: HTMLElement | null): (text: string) => number {
  const style = element === null ? null : getComputedStyle(element);
  const size = style === null ? 11 : Number.parseFloat(style.fontSize) || 11;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  } catch {
    context = null;
  }
  if (context !== null && style !== null) context.font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
  return (text) => (context === null ? text.length * size * 0.62 : context.measureText(text).width);
}

const TICK: Record<Moment["kind"], { y: number; h: number; w: number; className: string }> = {
  you: { y: 0, h: 0, w: 0, className: "" },
  trouble: { y: 0, h: 0, w: 0, className: "" },
  milestone: { y: 15, h: 19, w: 2, className: "fill-foreground" },
  done: { y: 19, h: 11, w: 1, className: "fill-foreground" },
  move: { y: 21, h: 7, w: 1, className: "fill-[var(--loom-muted)]" },
};

function Ticks({ xs, moments }: { xs: readonly number[]; moments: readonly Moment[] }) {
  return (
    <>
      {moments.map((moment, index) => {
        const x = xs[index]!;
        if (moment.kind === "you") return <rect key={moment.id} x={x - 3.5} y={21} width={7} height={7} transform={`rotate(45 ${x} ${24.5})`} className="fill-foreground" />;
        if (moment.kind === "trouble") return <rect key={moment.id} x={x - 4} y={20.5} width={8} height={8} className="fill-[var(--attention)] stroke-background" strokeWidth={0.75} />;
        const tick = TICK[moment.kind];
        return <rect key={moment.id} x={x - tick.w / 2} y={tick.y} width={tick.w} height={tick.h} className={tick.className} />;
      })}
    </>
  );
}

export function TimeRuler({ moments: timeline, compact = false }: { moments: Moments; compact?: boolean }) {
  const { data, moments, nowPosition, position, seekPosition, shown } = timeline;
  const strip = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; index: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const dragging = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = strip.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const inner = Math.max(0, width - 2 * PAD);
  const axis = useMemo(() => (data === null || inner === 0 ? null : axisOf(foldsOf([...data.events.map(([, time]) => time), data.end]), data.start, data.end, inner)), [data, inner]);
  const xs = useMemo(() => (axis === null ? [] : moments.map((moment) => PAD + axis.x(moment.at))), [axis, moments]);
  const xOf = (index: number) => (index >= moments.length ? PAD + inner : (xs[index] ?? PAD));
  const days = useMemo(() => {
    if (axis === null || moments.length === 0) return [];
    const measure = measurer(strip.current);
    const placed: Array<{ x: number; text: string }> = [];
    let right = -Infinity;
    let day = "";
    moments.forEach((moment, index) => {
      const text = dayLabel(moment.at);
      if (text === day) return;
      day = text;
      const x = xs[index]!;
      const w = measure(text);
      // A label is kept only where it fits whole, clear of the one before and of the strip's end.
      if (x < right + LABEL_GAP || x + w > PAD + inner + PAD) return;
      placed.push({ x, text });
      right = x + w;
    });
    return placed;
  }, [axis, moments, xs, inner]);

  useEffect(() => {
    if (!playing) return;
    if (position >= nowPosition) return setPlaying(false);
    const timer = setTimeout(() => seekPosition(position + 1), PLAY_MS);
    return () => clearTimeout(timer);
  }, [playing, position, nowPosition]);

  const nearest = (clientX: number) => {
    const box = strip.current!.getBoundingClientRect();
    const x = clientX - box.left;
    const candidates = [...xs, PAD + inner].slice(0, nowPosition + 1);
    return { x, index: nearestIndex(candidates, x) };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || moments.length === 0) return;
    setPlaying(false);
    dragging.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    strip.current?.focus({ preventScroll: true });
    seekPosition(nearest(event.clientX).index);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (moments.length === 0) return;
    const spot = nearest(event.clientX);
    if (dragging.current === event.pointerId) {
      if (spot.index !== position) seekPosition(spot.index);
      return;
    }
    if (event.pointerType === "mouse") setHover(spot);
  };
  const endDrag = () => (dragging.current = null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => seekPosition(position - 1),
      ArrowRight: () => seekPosition(position + 1),
      Home: () => seekPosition(0),
      End: () => seekPosition(nowPosition),
      Escape: () => seekPosition(nowPosition),
      " ": () => setPlaying((was) => !was && position < nowPosition),
    };
    const move = moves[event.key];
    if (move === undefined || (event.key === "Escape" && position === nowPosition)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key !== " ") setPlaying(false);
    move();
  };

  const live = shown === null;
  const hovered = hover === null ? null : (moments[hover.index] ?? null);
  const readout = live ? "Now" : shortWhen(shown.at);
  const valueText = live ? "Now" : `${momentWhen(shown.at)}: ${tellingLine(shown)?.text ?? ""}`;
  return (
    <div data-time-ruler className="flex min-w-0 flex-1 items-center gap-2.5">
      <span aria-hidden className={`inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap ${live ? "text-[var(--loom-muted)]" : "font-semibold text-foreground"} ${compact ? "max-[520px]:hidden" : ""}`}>
        <Icon name="Clock" className="size-3.5" aria-hidden />
        <span data-ruler-when className="loom-num">{readout}</span>
      </span>
      <div
        ref={strip}
        role="slider"
        tabIndex={0}
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={nowPosition}
        aria-valuenow={position}
        aria-valuetext={valueText}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape Space"
        data-ruler-strip
        className="relative h-[38px] min-w-[120px] flex-1 cursor-ew-resize @max-xl/loom:h-11 pointer-coarse:h-11 touch-none select-none text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        {days.map((day) => (
          <span key={`${day.text}-${day.x}`} aria-hidden data-ruler-day className="pointer-events-none absolute top-0 whitespace-nowrap leading-[13px] text-[var(--loom-muted)]" style={{ left: day.x }}>
            {day.text}
          </span>
        ))}
        <svg aria-hidden className="absolute inset-0 overflow-visible" width={width} height={38}>
          <rect x={PAD} y={24} width={inner} height={1} className="fill-[var(--loom-muted)]" />
          {axis !== null && <Ticks xs={xs} moments={moments} />}
          {nowPosition === moments.length && <rect x={PAD + inner - 1} y={16} width={2} height={21} className="fill-[var(--loom-muted)]" />}
          {hover !== null && <rect x={xOf(hover.index) - 0.5} y={12} width={1} height={26} className="fill-foreground/45" />}
        </svg>
        <span aria-hidden data-ruler-head className="pointer-events-none absolute top-[14px] h-6 w-[3px] -translate-x-1/2 bg-primary shadow-[0_0_10px_color-mix(in_oklab,var(--primary)_70%,transparent)] transition-[left] duration-150 ease-out" style={{ left: xOf(position) }}>
          <span className="absolute -top-[7px] left-1/2 h-[9px] w-[11px] -translate-x-1/2 bg-primary [clip-path:polygon(0_0,100%_0,50%_100%)]" />
        </span>
        {hovered !== null && dragging.current === null && (
          <span role="presentation" className="loom-pop pointer-events-none absolute bottom-[calc(100%+4px)] z-30 max-w-72 truncate border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md" style={{ left: Math.max(0, Math.min(width - 288, (hover?.x ?? 0) - 40)) }}>
            <b className="loom-num">{shortWhen(hovered.at)}</b> {tellingLine(hovered)?.text}
          </span>
        )}
      </div>
      <span className="inline-flex shrink-0 items-center gap-0.5">
        <Tip text="Previous moment" keys="[">
          <button type="button" aria-label="Previous moment" aria-keyshortcuts="[" disabled={position === 0 || moments.length === 0} className={STEP} onClick={() => seekPosition(position - 1)}>
            <Icon name="ChevronLeft" className="size-4" aria-hidden />
          </button>
        </Tip>
        <Tip text="Next moment" keys="]">
          <button type="button" aria-label="Next moment" aria-keyshortcuts="]" disabled={position >= nowPosition} className={STEP} onClick={() => seekPosition(position + 1)}>
            <Icon name="ChevronRight" className="size-4" aria-hidden />
          </button>
        </Tip>
      </span>
    </div>
  );
}

const STEP = "inline-flex size-7 @max-xl/loom:size-11 pointer-coarse:size-11 cursor-pointer items-center justify-center rounded-md text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40";

export { momentWhen, tellingLine };
