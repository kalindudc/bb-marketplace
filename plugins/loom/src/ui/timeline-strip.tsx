import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { ProjectTimeline } from "../contract";
import { formatDuration } from "../format";
import type { ProjectState, TicketState } from "../states";
import { STATE_COLORS, type Swatch } from "./charts";
import { BUTTON, HEADING, momentLabel, plural, useRemote } from "./common";
import { axisOf, eventIndexAt, foldsOf, packRows } from "./timeline-axis";

const OPEN_KEY = "loom.timeline.open";
const SEEK_MS = 120;
const ROW_PX = 13;
const SPEEDS = [
  { label: "1 min/s", times: 60 },
  { label: "5 min/s", times: 300 },
  { label: "20 min/s", times: 1200 },
] as const;
const ZOOMS = [
  { label: "Whole project", ms: null },
  { label: "2 h", ms: 2 * 3_600_000 },
  { label: "30 min", ms: 30 * 60_000 },
] as const;
type Zoom = (typeof ZOOMS)[number]["ms"];
type Axis = ReturnType<typeof axisOf>;

const QUEUED: Swatch = STATE_COLORS.queued;
const SWATCHES: Partial<Record<TicketState, Swatch>> = STATE_COLORS;
// Bottom to top; a cancelled ticket has left the work, so the flow leaves it out.
const STACK: TicketState[] = ["done", "pr_open", "merging", "approved", "review", "checking", "working", "blocked", "queued"];
const BANDS: Partial<Record<ProjectState, Swatch>> = { running: { fill: "var(--primary, currentColor)" }, paused: { fill: "var(--warning, currentColor)" } };
const ROLE_SWATCHES = { worker: SWATCHES.working!, reviewer: SWATCHES.review! };
const LEGEND: Array<{ label: string; swatch: Swatch }> = [
  { label: "working", swatch: SWATCHES.working! },
  { label: "checking", swatch: SWATCHES.checking! },
  { label: "review", swatch: SWATCHES.review! },
  { label: "approved and merging", swatch: SWATCHES.merging! },
  { label: "done", swatch: SWATCHES.done! },
  { label: "blocked", swatch: SWATCHES.blocked! },
  { label: "queued", swatch: QUEUED },
];
const fillOf = (swatch: Swatch | undefined) => ({ fill: (swatch ?? QUEUED).fill, opacity: (swatch ?? QUEUED).opacity ?? 1 });
const PRESSED = "bg-surface-selected font-semibold";

// Storage can be unavailable: then the section starts collapsed and is not remembered.
function savedOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

function saveOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, String(open));
  } catch {}
}

/** The element's width; 720 where nothing measures it, as in tests. */
function useWidth(): [(element: HTMLElement | null) => void, number] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}

/** Calls `fn` at most once every `ms`, always with the newest value; `cancel` drops a value still waiting. */
function useThrottle<T>(fn: (value: T) => void, ms: number) {
  const latest = useRef(fn);
  latest.current = fn;
  const state = useRef<{ timer: ReturnType<typeof setTimeout> | null; last: number; value: { v: T } | null }>({ timer: null, last: 0, value: null });
  useEffect(() => () => void (state.current.timer !== null && clearTimeout(state.current.timer)), []);
  const cancel = useCallback(() => {
    if (state.current.timer !== null) clearTimeout(state.current.timer);
    state.current.timer = null;
    state.current.value = null;
  }, []);
  const send = useCallback(
    (value: T) => {
      const s = state.current;
      const wait = s.last + ms - Date.now();
      if (wait <= 0 && s.timer === null) {
        s.last = Date.now();
        latest.current(value);
        return;
      }
      s.value = { v: value };
      s.timer ??= setTimeout(() => {
        s.timer = null;
        s.last = Date.now();
        const next = s.value;
        s.value = null;
        if (next !== null) latest.current(next.v);
      }, Math.max(0, wait));
    },
    [ms],
  );
  return { send, cancel };
}

function stepPath(segments: Array<{ x0: number; x1: number; low: number; high: number }>, y: (value: number) => number): string {
  const top = segments.map((s) => `L${s.x0},${y(s.high)}L${s.x1},${y(s.high)}`).join("");
  const bottom = [...segments].reverse().map((s) => `L${s.x1},${y(s.low)}L${s.x0},${y(s.low)}`).join("");
  return `M${segments[0]!.x0},${y(segments[0]!.low)}${top}${bottom}Z`;
}

/** The share of tickets in each state over time, as stacked steps. */
function FlowArea({ flow, end, axis, top, height }: { flow: ProjectTimeline["flow"]; end: number; axis: Axis; top: number; height: number }) {
  if (flow.length === 0) return null;
  const total = (counts: Partial<Record<TicketState, number>>) => STACK.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  const max = Math.max(1, ...flow.map((entry) => total(entry.counts)));
  const y = (value: number) => top + height - (value / max) * height;
  const steps = flow.map((entry, index) => ({ x0: axis.x(entry.at), x1: axis.x(flow[index + 1]?.at ?? end), counts: entry.counts }));
  return (
    <g>
      {STACK.map((state, layer) => {
        const segments = steps.map((step) => {
          const low = STACK.slice(0, layer).reduce((sum, below) => sum + (step.counts[below] ?? 0), 0);
          return { x0: step.x0, x1: step.x1, low, high: low + (step.counts[state] ?? 0) };
        });
        if (segments.every((segment) => segment.high === segment.low)) return null;
        return (
          <path key={state} d={stepPath(segments, y)} style={fillOf(SWATCHES[state])}>
            <title>{state.replace("_", " ")}</title>
          </path>
        );
      })}
    </g>
  );
}

function Folds({ folds, axis, height }: { folds: Array<{ from: number; to: number }>; axis: Axis; height: number }) {
  return (
    <g>
      {folds.map((fold) => {
        const x0 = axis.x(fold.from);
        const x1 = axis.x(fold.to);
        if (x1 - x0 < 1) return null;
        return (
          <g key={fold.from} data-timeline-fold>
            <rect x={x0} y={0} width={x1 - x0} height={height} style={{ fill: "var(--surface-recessed, transparent)", opacity: 0.9 }}>
              <title>{`Quiet for ${formatDuration(fold.to - fold.from)}`}</title>
            </rect>
            <text x={(x0 + x1) / 2} y={height / 2 + 3} textAnchor="middle" style={{ fill: "var(--muted-foreground, currentColor)", fontSize: 9 }}>
              ≈
            </text>
          </g>
        );
      })}
    </g>
  );
}

const Playhead = ({ x, height, rewound }: { x: number; height: number; rewound: boolean }) => (
  <line data-timeline-playhead x1={x} x2={x} y1={0} y2={height} style={{ stroke: rewound ? "var(--warning, currentColor)" : "var(--foreground, currentColor)", strokeWidth: 1.5 }} />
);

/** Seeks to the time under the pointer, and keeps seeking while the pointer drags. */
function scrubber(axis: Axis, width: number, onTime: (at: number) => void, onStart: () => void) {
  return (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const timeAt = (clientX: number) => {
      const box = svg.getBoundingClientRect();
      return axis.at((clientX - box.left) * (box.width > 0 ? width / box.width : 1));
    };
    onStart();
    onTime(timeAt(event.clientX));
    const move = (next: PointerEvent) => onTime(timeAt(next.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

/** A project's history under its health strip: a strip of its ticket flow that rewinds the page to the moment chosen, and, open, the controls, markers and bars. */
export function TimelineStrip({ slug, at, onSeek }: { slug: string; at: number | null; onSeek(at: number | null): void }) {
  const { data } = useRemote((rpc) => rpc.call("timeline", { slug }), `timeline:${slug}`, slug);
  const [open, setOpen] = useState(savedOpen);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(SPEEDS[1].times);
  const [lanes, setLanes] = useState<"tickets" | "sessions">("tickets");
  const [zoom, setZoom] = useState<Zoom>(null);
  const [troubleOnly, setTroubleOnly] = useState(false);
  const [miniRef, miniWidth] = useWidth();
  const [openRef, openWidth] = useWidth();
  const section = useRef<HTMLElement>(null);
  const clock = useRef(0);
  const current = useRef(at);
  current.current = at;
  const seekTo = useCallback((next: number | null) => {
    if (next !== current.current) onSeek(next);
  }, [onSeek]);
  const { send: sendSeek, cancel: cancelSeek } = useThrottle(seekTo, SEEK_MS);

  useEffect(() => {
    if (at !== null) return;
    setPlaying(false);
    cancelSeek();
  }, [at, cancelSeek]);

  const events = data?.events ?? [];
  const last = events.length - 1;
  const idAt = (index: number) => (index >= last ? null : events[Math.max(0, index)]![0]);
  const times = events.map(([, time]) => time);
  const folds = data === null ? [] : foldsOf([...times, data.end]);

  useEffect(() => {
    if (!playing || data === null) return;
    let before = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      clock.current += (now - before) * speed;
      before = now;
      const fold = folds.find((entry) => clock.current > entry.from && clock.current < entry.to);
      if (fold !== undefined) clock.current = fold.to;
      if (clock.current >= times[last]!) {
        setPlaying(false);
        cancelSeek();
        seekTo(null);
        return;
      }
      sendSeek(idAt(eventIndexAt(events, clock.current)));
    }, SEEK_MS);
    return () => clearInterval(timer);
  }, [playing, speed, data]);

  if (data === null || events.length < 2) return null;
  const index = at === null ? last : Math.max(0, events.filter(([id]) => id <= at).length - 1);
  const shownAt = at === null ? data.end : events[index]![1];
  const rewound = at !== null;

  const seekIndex = (next: number) => {
    setPlaying(false);
    cancelSeek();
    seekTo(idAt(Math.min(last, Math.max(0, next))));
  };
  const seekId = (id: number) => seekIndex(events.findIndex(([eventId]) => eventId >= id));
  const dragTo = (time: number) => sendSeek(idAt(eventIndexAt(events, time)));
  const stopPlaying = () => setPlaying(false);
  const play = () => {
    if (playing) return stopPlaying();
    clock.current = at === null ? data.start : shownAt;
    setPlaying(true);
  };
  const toggle = () => {
    saveOpen(!open);
    setOpen(!open);
  };
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft") seekIndex(index - 1);
    else if (event.key === "ArrowRight") seekIndex(index + 1);
    else if (event.key === " " && event.target === event.currentTarget) play();
    else return;
    event.preventDefault();
  };

  const miniAxis = axisOf(folds, data.start, data.end, miniWidth);
  const shown = <span className={`shrink-0 text-xs ${rewound ? "text-warning-text" : "text-muted-foreground"}`}>{rewound ? momentLabel(shownAt) : "Now"}</span>;

  return (
    <section ref={section} data-timeline-strip tabIndex={0} aria-label="Timeline" onKeyDown={onKey} className="shrink-0 space-y-2 border-b border-border-seam px-4 py-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      <div className="flex items-center gap-3">
        <button type="button" aria-expanded={open} onClick={toggle} className={`${HEADING} cursor-pointer rounded px-1 hover:bg-state-hover`}>
          <span aria-hidden>{open ? "▾ " : "▸ "}</span>Timeline
        </button>
        {!open && (
          <>
            <div ref={miniRef} className="min-w-0 flex-1">
              <svg data-timeline-mini role="img" aria-label="Ticket flow over time" width="100%" height={22} viewBox={`0 0 ${miniWidth} 22`} preserveAspectRatio="none" className="block cursor-pointer" onPointerDown={scrubber(miniAxis, miniWidth, dragTo, () => section.current?.focus())}>
                <FlowArea flow={data.flow} end={data.end} axis={miniAxis} top={1} height={20} />
                <Folds folds={folds} axis={miniAxis} height={22} />
                <Playhead x={miniAxis.x(shownAt)} height={22} rewound={rewound} />
              </svg>
            </div>
            {shown}
            <button type="button" className={BUTTON} onClick={play}>
              {playing ? "Pause" : "Play"}
            </button>
          </>
        )}
        {open && <span className="ml-auto">{shown}</span>}
      </div>
      {open && (
        <div ref={openRef} data-timeline-open className="space-y-2">
          <Expanded
            data={data}
            width={openWidth}
            folds={folds}
            index={index}
            shownAt={shownAt}
            rewound={rewound}
            playing={playing}
            speed={speed}
            lanes={lanes}
            zoom={zoom}
            troubleOnly={troubleOnly}
            on={{ seekIndex, seekId, dragTo, play, setSpeed, setLanes, setZoom, setTroubleOnly, focus: () => section.current?.focus() }}
          />
        </div>
      )}
    </section>
  );
}

interface ExpandedProps {
  data: ProjectTimeline;
  width: number;
  folds: Array<{ from: number; to: number }>;
  index: number;
  shownAt: number;
  rewound: boolean;
  playing: boolean;
  speed: number;
  lanes: "tickets" | "sessions";
  zoom: Zoom;
  troubleOnly: boolean;
  on: {
    seekIndex(index: number): void;
    seekId(id: number): void;
    dragTo(at: number): void;
    play(): void;
    setSpeed(times: number): void;
    setLanes(lanes: "tickets" | "sessions"): void;
    setZoom(zoom: Zoom): void;
    setTroubleOnly(on: boolean): void;
    focus(): void;
  };
}

function Expanded({ data, width, folds, index, shownAt, rewound, playing, speed, lanes, zoom, troubleOnly, on }: ExpandedProps) {
  const last = data.events.length - 1;
  const whole = axisOf(folds, data.start, data.end, width);
  const span = zoom === null ? null : Math.min(zoom, data.end - data.start);
  const from = span === null ? data.start : Math.min(Math.max(data.start, shownAt - span / 2), data.end - span);
  const to = span === null ? data.end : from + span;
  const axis = axisOf(folds, from, to, width);
  const trouble = new Set(data.trouble);
  const bars = lanes === "tickets" ? data.tickets.filter((bar) => !troubleOnly || trouble.has(bar.key)) : data.sessions.filter((bar) => !troubleOnly || (bar.key !== null && trouble.has(bar.key)));
  const packed = packRows<(typeof bars)[number]>(bars);
  const height = Math.max(1, packed.rows) * ROW_PX + 14;
  const button = (label: string, onClick: () => void, disabled = false) => (
    <button type="button" className={BUTTON} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
  const choice = (label: string, pressed: boolean, onClick: () => void) => (
    <button key={label} type="button" aria-pressed={pressed} onClick={onClick} className={`cursor-pointer rounded px-2 py-0.5 text-xs hover:bg-state-hover ${pressed ? PRESSED : "text-muted-foreground"}`}>
      {label}
    </button>
  );
  const spaces = Math.max(2, Math.floor(width / 120));
  const ticks = Array.from({ length: spaces + 1 }, (_, n) => (n / spaces) * width);
  const tickLabel = (time: number) => new Date(time).toLocaleString([], to - from > 86_400_000 ? { month: "short", day: "numeric", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {button("First event", () => on.seekIndex(0), index === 0)}
        {button("Previous event", () => on.seekIndex(index - 1), index === 0)}
        {button(playing ? "Pause" : "Play", on.play)}
        {button("Next event", () => on.seekIndex(index + 1), index === last)}
        {button("Now", () => on.seekIndex(last), index === last && !rewound)}
        <div role="group" aria-label="Speed" className="inline-flex gap-0.5 rounded-md border border-border-seam p-0.5">
          {SPEEDS.map((entry) => choice(entry.label, speed === entry.times, () => on.setSpeed(entry.times)))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          event {index + 1} of {data.events.length}
        </span>
      </div>
      <svg data-timeline-overview role="group" aria-label="The project over time" width="100%" height={48} viewBox={`0 0 ${width} 48`} preserveAspectRatio="none" className="block cursor-pointer" onPointerDown={scrubber(whole, width, on.dragTo, on.focus)}>
        {data.project.map((band, n) => (
          <rect key={n} x={whole.x(band.from)} y={0} width={Math.max(0, whole.x(band.to) - whole.x(band.from))} height={4} style={fillOf(BANDS[band.state])}>
            <title>{`${band.state} from ${momentLabel(band.from)}`}</title>
          </rect>
        ))}
        <FlowArea flow={data.flow} end={data.end} axis={whole} top={8} height={30} />
        <Folds folds={folds} axis={whole} height={48} />
        {span !== null && <rect data-timeline-window x={whole.x(from)} y={6} width={Math.max(2, whole.x(to) - whole.x(from))} height={34} style={{ fill: "none", stroke: "var(--ring, currentColor)", strokeWidth: 1 }} />}
        {data.marks.map((mark) => {
          const x = whole.x(mark.at);
          return (
            <path
              key={mark.id}
              role="button"
              aria-label={`You ran ${mark.action}`}
              d={`M${x},38 l4,4 l-4,4 l-4,-4 Z`}
              className="cursor-pointer"
              style={{ fill: "var(--warning, currentColor)" }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => on.seekId(mark.id)}
            >
              <title>{`You ran ${mark.action}${mark.key === null ? "" : ` on ${mark.key}`}, ${momentLabel(mark.at)}`}</title>
            </path>
          );
        })}
        <Playhead x={whole.x(shownAt)} height={48} rewound={rewound} />
      </svg>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Lanes" className="inline-flex gap-0.5 rounded-md border border-border-seam p-0.5">
          {choice("Tickets", lanes === "tickets", () => on.setLanes("tickets"))}
          {choice("Agent sessions", lanes === "sessions", () => on.setLanes("sessions"))}
        </div>
        <div role="group" aria-label="Zoom" className="inline-flex gap-0.5 rounded-md border border-border-seam p-0.5">
          {ZOOMS.map((entry) => choice(entry.label, zoom === entry.ms, () => on.setZoom(entry.ms)))}
        </div>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={troubleOnly} onChange={(event) => on.setTroubleOnly(event.target.checked)} />
          Trouble only
        </label>
        <span data-timeline-note className="ml-auto text-xs text-muted-foreground">
          {plural(bars.length, lanes === "tickets" ? "ticket" : "session")} in {plural(packed.rows, "row")}
        </span>
      </div>
      <svg data-timeline-lanes role="img" aria-label={lanes === "tickets" ? "Tickets in flight" : "Agent sessions"} width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block cursor-pointer" onPointerDown={scrubber(axis, width, on.dragTo, on.focus)}>
        <Folds folds={folds} axis={axis} height={height - 14} />
        {packed.bars.map((bar, n) => {
          const x0 = axis.x(bar.from);
          const x1 = axis.x(bar.to);
          if (x1 < 0 || x0 > width) return null;
          const y = bar.row * ROW_PX;
          const ticket = "parts" in bar;
          const name = ticket ? bar.key : `${bar.key ?? "no ticket"}${bar.label === "" ? "" : ` ${bar.label}`}`;
          const hover = ticket ? `${bar.key} · ${bar.title}: ${bar.parts.map((part) => `${part.state.replace("_", " ")} ${formatDuration(part.to - part.from)}`).join(", ")}` : `${name}, ${bar.role}${bar.endReason === null ? "" : `, ended: ${bar.endReason}`}`;
          return (
            <g key={n} data-timeline-bar={bar.key ?? ""}>
              <title>{hover}</title>
              {ticket ? (
                bar.parts.map((part, m) => <rect key={m} x={axis.x(part.from)} y={y} width={Math.max(1, axis.x(part.to) - axis.x(part.from))} height={ROW_PX - 2} style={fillOf(SWATCHES[part.state])} />)
              ) : (
                <rect x={x0} y={y} width={Math.max(1, x1 - x0)} height={ROW_PX - 2} style={fillOf(ROLE_SWATCHES[bar.role])} />
              )}
              {x1 - x0 > 50 && (
                <text x={x0 + 3} y={y + ROW_PX - 4} style={{ fill: "var(--foreground, currentColor)", fontSize: 8, pointerEvents: "none" }}>
                  {name}
                </text>
              )}
            </g>
          );
        })}
        <Playhead x={axis.x(shownAt)} height={height - 14} rewound={rewound} />
        {ticks.map((x, n) => (
          <text key={x} x={x} y={height - 3} textAnchor={n === 0 ? "start" : n === ticks.length - 1 ? "end" : "middle"} style={{ fill: "var(--muted-foreground, currentColor)", fontSize: 8 }}>
            {tickLabel(axis.at(x))}
          </text>
        ))}
      </svg>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {(lanes === "tickets" ? LEGEND : [{ label: "worker", swatch: ROLE_SWATCHES.worker }, { label: "reviewer", swatch: ROLE_SWATCHES.reviewer }]).map((entry) => (
          <li key={entry.label} className="flex items-center gap-1">
            <svg aria-hidden width={8} height={8}>
              <rect width={8} height={8} rx={1} style={fillOf(entry.swatch)} />
            </svg>
            {entry.label}
          </li>
        ))}
      </ul>
    </>
  );
}
