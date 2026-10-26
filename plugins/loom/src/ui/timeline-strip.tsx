import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Moment, MomentKind, ProjectTimeline, SessionBar, TicketBar } from "../contract";
import { formatDuration } from "../format";
import type { ProjectState, TicketState } from "../states";
import { HEADING, plural, useLoom } from "./common";
import { axisOf, foldsOf, lastIndexAt, nearestIndex, stateAt, ticksOf, type Axis } from "./timeline-axis";

const OPEN_KEY = "loom.timeline.open";
const SEEK_MS = 120;
const TRACK_PX = 30;
const BASE_Y = 19;
const ROW_PX = 20;
const BAR_PX = 10;
/** Rows shown before the list scrolls. */
const ROWS_SHOWN = 16;
/** A pointer this close to a fold's edge points at the moment there, not at the quiet stretch. */
const FOLD_EDGE_PX = 3;
/** About how wide one character of an axis label is. */
const CHAR_PX = 5.6;
const SPEEDS = [
  { label: "1 min/s", times: 60 },
  { label: "5 min/s", times: 300 },
  { label: "20 min/s", times: 1200 },
] as const;

// Three columns: names, the plot and a status or summary. A frame under 36rem wide gives the plots the whole width and
// stacks what does not fit; the `@max-xl:` classes are container queries on the frame.
const COLUMNS = "grid grid-cols-[124px_minmax(0,1fr)_150px] gap-x-3.5";
const HEAD_ROW = `${COLUMNS} items-center @max-xl:grid-cols-[minmax(0,1fr)_auto] @max-xl:gap-y-1`;
const MOMENT_ROW = `${COLUMNS} items-center @max-xl:grid-cols-[minmax(0,1fr)_auto]`;
const CONTROLS_ROW = `${COLUMNS} items-center @max-xl:flex @max-xl:flex-wrap @max-xl:gap-2`;
const LANES_ROW = `${COLUMNS} items-stretch @max-xl:grid-cols-[88px_minmax(0,1fr)]`;
const FOOT_ROW = `${COLUMNS} items-center @max-xl:grid-cols-[88px_minmax(0,1fr)]`;

// The frame's own background, so the fade over the future and the marks' cut-outs match it rewound or not.
const FRAME = "var(--loom-timeline-bg)";
const INK = "var(--foreground, currentColor)";
const mix = (color: string, percent: number, base = FRAME) => `color-mix(in oklab, ${color} ${percent}%, ${base})`;
const PRIMARY = "var(--primary, currentColor)";
const SUCCESS = "var(--success, currentColor)";
const WARNING = "var(--warning, currentColor)";
const DANGER = "var(--destructive, currentColor)";
const SUBTLE = "var(--subtle-foreground, currentColor)";
// Light themes' success and warning colours are pale against the frame, so their outlines and marks lean towards the ink.
const SUCCESS_INK = mix(SUCCESS, 70, INK);
const WARNING_INK = "var(--warning-text, var(--warning, currentColor))";

/** A light fill carries an outline in a strong colour, so the mark still stands out from the frame. */
type Paint = { fill: string; stroke?: string };
const CHECKS: Paint = { fill: mix(PRIMARY, 40), stroke: PRIMARY };
const SHIPPING: Paint = { fill: mix(SUCCESS, 45), stroke: SUCCESS_INK };
const REVIEW: Paint = { fill: WARNING, stroke: WARNING_INK };
const PAINT: Partial<Record<TicketState, Paint>> = { working: { fill: PRIMARY }, checking: CHECKS, review: REVIEW, approved: SHIPPING, merging: SHIPPING, pr_open: SHIPPING };
const ROLE_PAINT: Record<SessionBar["role"], Paint> = { worker: { fill: PRIMARY }, reviewer: REVIEW };
const svgPaint = (paint: Paint): CSSProperties => ({ fill: paint.fill, stroke: paint.stroke, strokeWidth: paint.stroke === undefined ? undefined : 0.8 });
const cssPaint = (paint: Paint): CSSProperties => ({ background: paint.fill, boxShadow: paint.stroke === undefined ? undefined : `inset 0 0 0 1px ${paint.stroke}` });
const KIND_DOT: Record<MomentKind, CSSProperties> = {
  move: { background: mix(INK, 55, "transparent") },
  done: { background: SUCCESS_INK },
  trouble: { background: DANGER },
  you: { boxShadow: `inset 0 0 0 1.5px ${INK}` },
  milestone: { background: PRIMARY },
};
const STATE_DOT: Record<TicketState, CSSProperties> = {
  queued: { boxShadow: `inset 0 0 0 1.2px ${mix(INK, 55, "transparent")}` },
  working: cssPaint(PAINT.working!),
  checking: cssPaint(CHECKS),
  review: cssPaint(PAINT.review!),
  approved: cssPaint(SHIPPING),
  merging: cssPaint(SHIPPING),
  pr_open: cssPaint(SHIPPING),
  blocked: { background: DANGER },
  done: { background: SUCCESS_INK },
  cancelled: { background: SUBTLE },
};
const STATE_WORD: Record<TicketState, string> = { queued: "queued", working: "working", checking: "in checks", review: "in review", approved: "approved", merging: "merging", pr_open: "with a PR open", blocked: "blocked", done: "done", cancelled: "cancelled" };
const PART_WORD: Partial<Record<TicketState, string>> = { checking: "checks", approved: "shipping", merging: "shipping", pr_open: "shipping" };

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayOf = (at: number) => new Date(at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const weekday = (at: number) => new Date(at).toLocaleDateString([], { weekday: "short" });
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
/** "4:55 PM", or "Fri 4:55 PM" when `at` is on another day than `before`. */
const clockAfter = (before: number, at: number) => (sameDay(before, at) ? clock(at) : `${weekday(at)} ${clock(at)}`);
const live = (state: ProjectState) => state === "running" || state === "paused";
/** Whole minutes from a minute on: a row and its hover read "13m", not "13m 27s". */
const roughly = (ms: number) => formatDuration(ms < 60_000 ? ms : Math.round(ms / 60_000) * 60_000);
/** The line that gave the moment its kind. */
const tellingLine = (moment: Moment) => moment.lines.find((line) => line.kind === moment.kind) ?? moment.lines[0]!;
const hasKind = (moment: Moment, kind: MomentKind) => moment.lines.some((line) => line.kind === kind);

type Row = { key: string | null; title: string; bar: TicketBar | null; sessions: SessionBar[] };
type Lanes = "tickets" | "agents";
type Plot = "track" | "lanes";
type Hover = { plot: Plot; x: number; y: number };
/** A press on a plot: a mouse or pen drags, and a finger on the rows seeks only when it lifts (`tap`), since it may be scrolling. */
type Drag = { pointerId: number; row: number | null; tap: number | null };
type Span = { from: number; to: number };

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

/** A row per started ticket, or per ticket's agent sessions; Only trouble keeps the tickets that blocked or were sent back. */
function rowsOf(data: ProjectTimeline, lanes: Lanes, troubleOnly: boolean): Row[] {
  const trouble = new Set(data.trouble);
  const keep = (key: string | null) => !troubleOnly || (key !== null && trouble.has(key));
  const bars = new Map(data.tickets.map((bar) => [bar.key, bar]));
  if (lanes === "tickets") return [...data.tickets].sort((a, b) => a.from - b.from).filter((bar) => keep(bar.key)).map((bar) => ({ key: bar.key, title: bar.title, bar, sessions: [] }));
  const byKey = new Map<string | null, SessionBar[]>();
  for (const session of data.sessions) byKey.set(session.key, [...(byKey.get(session.key) ?? []), session]);
  const first = (sessions: SessionBar[]) => Math.min(...sessions.map((session) => session.from));
  return [...byKey.entries()]
    .sort((a, b) => first(a[1]) - first(b[1]))
    .filter(([key]) => keep(key))
    .map(([key, sessions]) => ({ key, title: key === null ? "" : (bars.get(key)?.title ?? ""), bar: key === null ? null : (bars.get(key) ?? null), sessions }));
}

/** Your actions closer than 7 pixels draw as one ring. */
function yourMarks(moments: readonly Moment[], axis: Axis): number[] {
  const xs: number[] = [];
  for (const moment of moments) {
    if (!hasKind(moment, "you")) continue;
    const x = axis.x(moment.at);
    if (xs.length === 0 || x - xs.at(-1)! >= 7) xs.push(x);
  }
  return xs;
}

const Ring = ({ x, y, r }: { x: number; y: number; r: number }) => <circle cx={x} cy={y} r={r} style={{ fill: FRAME, stroke: INK, strokeWidth: 1.3 }} />;

/** The collapsed strip: how much happened when, on the time axis, with trouble below the line and your actions on it. */
const Track = memo(function Track({ moments, folds, axis, width }: { moments: readonly Moment[]; folds: readonly Span[]; axis: Axis; width: number }) {
  const bins = new Map<number, number>();
  for (const moment of moments) {
    const bin = Math.floor(axis.x(moment.at) / 3);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  const most = Math.max(1, ...bins.values());
  const shown = folds.map((fold) => ({ x0: axis.x(fold.from), x1: axis.x(fold.to) })).filter((fold) => fold.x1 - fold.x0 >= 2);
  const folded = (x: number) => shown.some((fold) => x > fold.x0 + 0.5 && x < fold.x1 - 0.5);
  const base = BASE_Y + 0.5;
  const solid: Array<[number, number]> = [];
  let from = 0;
  for (const fold of shown) {
    solid.push([from, fold.x0]);
    from = fold.x1;
  }
  solid.push([from, width]);
  return (
    <svg aria-hidden width={width} height={TRACK_PX} className="block overflow-visible">
      {[...bins].map(([bin, count]) => {
        if (folded(bin * 3 + 1)) return null;
        const height = 2 + 12 * Math.sqrt(count / most);
        return <rect key={bin} x={bin * 3} y={BASE_Y - height} width={2} height={height} rx={0.6} style={{ fill: mix(INK, 60, "transparent") }} />;
      })}
      {solid.map(([x0, x1], index) => (
        <line key={index} x1={x0} x2={x1} y1={base} y2={base} style={{ stroke: mix(INK, 25, "transparent"), strokeWidth: 1 }} />
      ))}
      {shown.map((fold, index) => (
        <line key={index} data-timeline-fold x1={fold.x0 + 1} x2={fold.x1 - 1} y1={base} y2={base} style={{ stroke: mix(INK, 45, "transparent"), strokeWidth: 1.2, strokeDasharray: "1.2 2.6" }} />
      ))}
      {moments.filter((moment) => hasKind(moment, "trouble")).map((moment) => (
        <circle key={moment.id} cx={axis.x(moment.at)} cy={BASE_Y + 7} r={2.2} style={{ fill: DANGER }} />
      ))}
      {yourMarks(moments, axis).map((x) => (
        <Ring key={x} x={x} y={base} r={3} />
      ))}
    </svg>
  );
});

/** One row for the project's states and your actions, then one row per ticket or per ticket's agent sessions. */
const LanesArt = memo(function LanesArt({ rows, lanes, data, folds, axis, width, hatch }: { rows: readonly Row[]; lanes: Lanes; data: ProjectTimeline; folds: readonly Span[]; axis: Axis; width: number; hatch: string }) {
  const height = (rows.length + 1) * ROW_PX;
  const middle = ROW_PX / 2;
  return (
    <svg data-timeline-lanes role="img" aria-label={lanes === "tickets" ? "Tickets over time" : "Agent sessions over time"} width={width} height={height} className="relative block overflow-visible">
      <defs>
        <pattern id={hatch} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={4} height={4} style={{ fill: mix(DANGER, 18) }} />
          <line x1={0} y1={0} x2={0} y2={4} style={{ stroke: DANGER, strokeWidth: 1.6 }} />
        </pattern>
      </defs>
      {folds.map((fold, index) => {
        const x0 = axis.x(fold.from);
        const x1 = axis.x(fold.to);
        return x1 - x0 < 2 ? null : <line key={index} x1={(x0 + x1) / 2} x2={(x0 + x1) / 2} y1={0} y2={height} style={{ stroke: mix(INK, 22, "transparent"), strokeWidth: 1, strokeDasharray: "1.2 2.6" }} />;
      })}
      {data.project.map((band, index) => {
        const x0 = axis.x(band.from);
        const x1 = axis.x(band.to);
        if (x1 - x0 < 1) return null;
        const stroke = band.state === "running" ? mix(PRIMARY, 75, "transparent") : band.state === "paused" ? WARNING_INK : mix(INK, 25, "transparent");
        return (
          <g key={index} data-timeline-band={band.state}>
            <line x1={x0 + 2} x2={Math.max(x0 + 2, x1 - 2)} y1={middle} y2={middle} style={{ stroke, strokeWidth: 3, strokeLinecap: "round", strokeDasharray: band.state === "paused" ? "1 3" : undefined }} />
            {band.state === "paused" && x1 - x0 > 64 && (
              <text x={x0 + 4} y={middle - 5} style={{ fill: SUBTLE, fontSize: 9.5 }}>
                paused {roughly(band.to - band.from)}
              </text>
            )}
          </g>
        );
      })}
      {yourMarks(data.moments, axis).map((x) => (
        <Ring key={x} x={x} y={middle} r={3.4} />
      ))}
      {rows.map((row, index) => {
        const y = (index + 1) * ROW_PX + (ROW_PX - BAR_PX) / 2;
        if (lanes === "agents")
          return (
            <g key={row.key ?? ""} data-timeline-row={row.key ?? ""}>
              {row.sessions.map((session, at) => (
                <rect key={at} data-timeline-session={session.role} x={axis.x(session.from)} y={y} width={Math.max(1.5, axis.x(session.to) - axis.x(session.from) - 0.8)} height={BAR_PX} rx={2} style={svgPaint(ROLE_PAINT[session.role])} />
              ))}
            </g>
          );
        const bar = row.bar!;
        const end = axis.x(bar.to);
        return (
          <g key={bar.key} data-timeline-row={bar.key}>
            {bar.parts.map((part, at) => {
              const x0 = axis.x(part.from);
              const box = { x: x0, y, width: Math.max(1.2, axis.x(part.to) - x0 - 0.6), height: BAR_PX, rx: 1.5 };
              if (part.state === "blocked") return <rect key={at} data-timeline-part="blocked" {...box} style={{ fill: `url(#${hatch})`, stroke: DANGER, strokeWidth: 1 }} />;
              if (part.state === "queued") return <rect key={at} data-timeline-part="queued" {...box} style={{ fill: "none", stroke: mix(INK, 50, "transparent"), strokeDasharray: "2 2" }} />;
              return <rect key={at} data-timeline-part={part.state} {...box} style={svgPaint(PAINT[part.state] ?? { fill: SUBTLE })} />;
            })}
            {bar.sentBack.map((time, at) => (
              <path key={at} data-timeline-sent-back d={`M${axis.x(time) - 3.2},${y - 4.2} h6.4 l-3.2,3.6 Z`} style={{ fill: DANGER }} />
            ))}
            {bar.final === "done" && (
              <g data-timeline-done>
                <circle cx={end + 1} cy={y + BAR_PX / 2} r={3.6} style={{ fill: SUCCESS_INK }} />
                <path d={`M${end - 0.9},${y + BAR_PX / 2} l1.4,1.4 l2.4,-2.6`} style={{ fill: "none", stroke: FRAME, strokeWidth: 1.3 }} />
              </g>
            )}
            {bar.final === "cancelled" && <path data-timeline-cancelled d={`M${end - 2},${y + 3} l5,5 M${end + 3},${y + 3} l-5,5`} style={{ stroke: SUBTLE, strokeWidth: 1.4 }} />}
          </g>
        );
      })}
    </svg>
  );
});

/** The times under a plot: its start, labels between, and its end. A narrow plot leaves the date off the start. */
function AxisLabels({ data, folds, axis, width }: { data: ProjectTimeline; folds: readonly Span[]; axis: Axis; width: number }) {
  const startText = width < 360 ? clock(data.start) : `${dayOf(data.start)} ${clock(data.start)}`;
  const endLength = live(data.state) ? 3 : sameDay(data.start, data.end) ? 8 : 12;
  let previous = data.start;
  const ticks = ticksOf(folds, data.start, data.end, axis, width, { startRoom: startText.length * CHAR_PX + 40, endRoom: endLength * CHAR_PX + 40 }).map((tick) => {
    const text = clockAfter(previous, tick.at);
    previous = tick.at;
    return { ...tick, text };
  });
  const endText = live(data.state) ? "now" : clockAfter(previous, data.end);
  const label = "absolute top-px whitespace-nowrap";
  return (
    <div data-timeline-axis className="relative h-3.5 text-[10px] text-subtle-foreground tabular-nums" style={{ width }}>
      <span className={`${label} left-0`}>{startText}</span>
      {ticks.map((tick, index) => (
        <span key={index} className={`${label} -translate-x-1/2`} style={{ left: tick.x }}>
          {tick.text}
        </span>
      ))}
      {width > (startText.length + endText.length) * CHAR_PX + 16 && <span className={`${label} right-0`}>{endText}</span>}
    </div>
  );
}

function Dot({ style, className = "" }: { style: CSSProperties; className?: string }) {
  return <span aria-hidden className={`inline-block size-[7px] shrink-0 rounded-full ${className}`} style={style} />;
}

const icon = (path: ReactNode, size = 13) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
);
const PLAY = (
  <svg aria-hidden width={11} height={11} viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" />
  </svg>
);
const PAUSE = (
  <svg aria-hidden width={11} height={11} viewBox="0 0 24 24" fill="currentColor">
    <rect x={5} y={4} width={5} height={16} rx={1} />
    <rect x={14} y={4} width={5} height={16} rx={1} />
  </svg>
);
const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
// aria-disabled rather than disabled, so a step button at either end keeps keyboard focus.
const STEP = `inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-md border border-border-seam text-foreground hover:bg-state-hover ${FOCUS} aria-disabled:cursor-default aria-disabled:opacity-35 aria-disabled:hover:bg-transparent`;
const CHOICE = `cursor-pointer whitespace-nowrap rounded-[5px] px-2 py-px text-[11.5px] hover:bg-state-hover ${FOCUS}`;

function Legend({ lanes, hatch }: { lanes: Lanes; hatch: string }) {
  const swatch = (paint: Paint) => <span aria-hidden className="inline-block h-[7px] w-3.5 rounded-sm" style={cssPaint(paint)} />;
  const items: Array<[string, ReactNode]> =
    lanes === "tickets"
      ? [
          ["working", swatch(PAINT.working!)],
          ["checks", swatch(CHECKS)],
          ["review", swatch(PAINT.review!)],
          ["shipping", swatch(SHIPPING)],
          [
            "blocked",
            <svg key="blocked" aria-hidden width={14} height={7}>
              <rect width={14} height={7} rx={1.5} style={{ fill: `url(#${hatch})`, stroke: DANGER, strokeWidth: 1 }} />
            </svg>,
          ],
          [
            "sent back",
            <svg key="back" aria-hidden width={9} height={7}>
              <path d="M1,1 h7 l-3.5,5 Z" style={{ fill: DANGER }} />
            </svg>,
          ],
          ["done", <Dot key="done" style={{ background: SUCCESS_INK }} />],
          ["you", <Dot key="you" style={KIND_DOT.you} />],
        ]
      : [
          ["worker session", swatch(ROLE_PAINT.worker)],
          ["review session", swatch(ROLE_PAINT.reviewer)],
          ["you", <Dot key="you" style={KIND_DOT.you} />],
        ];
  return (
    <ul aria-label="Legend" className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground @max-xl:order-last @max-xl:basis-full">
      {items.map(([label, mark]) => (
        <li key={label} className="inline-flex items-center gap-1.5">
          {mark}
          {label}
        </li>
      ))}
    </ul>
  );
}

/** How a row went up to `until`: Infinity at now, the playhead's time while rewound. */
function rowSummary(row: Row, lanes: Lanes, until: number): ReactNode {
  if (lanes === "agents") {
    const started = row.sessions.filter((session) => session.from <= until);
    const workers = started.filter((session) => session.role === "worker").length;
    const reviews = started.length - workers;
    return started.length === 0 ? "not started" : `${plural(workers, "worker")}${reviews > 0 ? ` · ${plural(reviews, "review")}` : ""}`;
  }
  const bar = row.bar!;
  if (until < bar.from) return "not started";
  const back = bar.sentBack.filter((at) => at <= until).length;
  return (
    <>
      {back > 0 && (
        <span className="text-destructive-text" title={`Sent back ${back === 1 ? "once" : `${back} times`}`}>
          <span aria-hidden>↩ </span>
          <span className="sr-only">sent back </span>
          {back}
        </span>
      )}
      {bar.parts.some((part) => part.state === "blocked" && part.from <= until) && <span className="text-destructive-text">blocked</span>}
      <span>{roughly(Math.min(bar.to, until) - bar.from)}</span>
    </>
  );
}

function partTotals(bar: TicketBar): string {
  const totals = new Map<string, number>();
  for (const part of bar.parts) {
    const word = PART_WORD[part.state] ?? part.state;
    totals.set(word, (totals.get(word) ?? 0) + part.to - part.from);
  }
  return [...totals].map(([word, ms]) => `${word} ${roughly(ms)}`).join(" · ");
}

/** A project's history under its health strip: a strip that rewinds the page to the moment chosen, and, open, a row per ticket. */
export function TimelineStrip({ slug, at, onSeek, onTicket }: { slug: string; at: number | null; onSeek(at: number | null): void; onTicket(key: string): void }) {
  const data = useLoom("timeline", { slug }).data ?? null;
  const [open, setOpen] = useState(savedOpen);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [speed, setSpeed] = useState<number>(SPEEDS[1].times);
  const [lanes, setLanes] = useState<Lanes>("tickets");
  const [troubleOnly, setTroubleOnly] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  // The live region stays silent until the first seek, so opening the page reads nothing out.
  const [spoken, setSpoken] = useState(false);
  const [trackRef, trackWidth] = useWidth();
  const [lanesRef, lanesWidth] = useWidth();
  const hatch = `loom-timeline-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const section = useRef<HTMLElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const clockRef = useRef(0);
  const current = useRef(at);
  current.current = at;
  const seekTo = useCallback(
    (next: number | null) => {
      setSpoken(true);
      if (next !== current.current) onSeek(next);
    },
    [onSeek],
  );
  const { send: sendSeek, cancel: cancelSeek } = useThrottle(seekTo, SEEK_MS);

  useEffect(() => {
    if (at !== null) return;
    setPlaying(false);
    cancelSeek();
  }, [at, cancelSeek]);

  const moments = useMemo(() => data?.moments ?? [], [data]);
  const n = moments.length;
  const times = useMemo(() => moments.map((moment) => moment.at), [moments]);
  const ids = useMemo(() => moments.map((moment) => moment.id), [moments]);
  const folds = useMemo(() => (data === null ? [] : foldsOf([...data.events.map(([, time]) => time), data.end])), [data]);
  const trackAxis = useMemo(() => (data === null ? null : axisOf(folds, data.start, data.end, trackWidth)), [data, folds, trackWidth]);
  const lanesAxis = useMemo(() => (data === null ? null : axisOf(folds, data.start, data.end, lanesWidth)), [data, folds, lanesWidth]);
  const rows = useMemo(() => (data === null ? [] : rowsOf(data, lanes, troubleOnly)), [data, lanes, troubleOnly]);
  const troubleRows = useMemo(() => (data === null ? 0 : rowsOf(data, lanes, true).length), [data, lanes]);
  // The newest moment is the live page when nothing happened after it, in time: a rewind takes in every event of its millisecond.
  const tailIsNow = n > 0 && moments[n - 1]!.at >= (data?.events.at(-1)?.[1] ?? 0);
  const idOf = (index: number) => (index >= n || (tailIsNow && index === n - 1) ? null : moments[Math.max(0, index)]!.id);

  useEffect(() => {
    if (!playing || data === null) return;
    let before = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      clockRef.current += (now - before) * speed;
      before = now;
      const fold = folds.find((entry) => clockRef.current > entry.from && clockRef.current < entry.to);
      if (fold !== undefined) clockRef.current = fold.to;
      if (clockRef.current >= times[n - 1]!) {
        setPlaying(false);
        cancelSeek();
        seekTo(null);
        return;
      }
      setPlayhead(clockRef.current);
      sendSeek(idOf(lastIndexAt(times, clockRef.current)));
    }, SEEK_MS);
    return () => clearInterval(timer);
  }, [playing, speed, data]);

  // Runs after every render while hovering, so the tooltip follows its content, a live refresh and the rows' scrolling.
  useLayoutEffect(() => {
    const box = tip.current;
    const frame = section.current;
    if (box === null || frame === null || hover === null) return;
    const plot = frame.querySelector<HTMLElement>(hover.plot === "track" ? "[data-timeline-track]" : "[data-timeline-lanes-plot]");
    if (plot === null) return;
    const outer = frame.getBoundingClientRect();
    const inner = plot.getBoundingClientRect();
    const clip = frame.closest("[data-loom-scroll]")?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const left = Math.max(6, Math.min(outer.width - box.offsetWidth - 6, inner.left - outer.left + hover.x - box.offsetWidth / 2));
    let top: number;
    if (hover.plot === "track") {
      top = inner.top - outer.top - box.offsetHeight - 8;
      if (outer.top + top < clip.top + 4) top = inner.bottom - outer.top + 18;
    } else {
      const row = Math.floor(hover.y / ROW_PX);
      top = inner.top - outer.top + (row + 1) * ROW_PX + 6;
      if (outer.top + top + box.offsetHeight > clip.bottom - 4) top = inner.top - outer.top + row * ROW_PX - box.offsetHeight - 6;
    }
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  });

  if (data === null || trackAxis === null || lanesAxis === null || n < 2) return null;

  const rewound = at !== null;
  const past = rewound || playing;
  const index = playing ? lastIndexAt(times, playhead) : at === null ? n - 1 : lastIndexAt(ids, at);
  const shownAt = playing ? playhead : at === null ? data.end : moments[index]!.at;
  // Positions run from the first moment to now, which is the last.
  const nowPosition = tailIsNow ? n - 1 : n;
  const position = at === null && !playing ? nowPosition : index;
  const axisFor = (plot: Plot) => (plot === "track" ? trackAxis : lanesAxis);

  const stop = () => {
    setPlaying(false);
    cancelSeek();
  };
  const seekPosition = (next: number, repeat = false) => {
    const clamped = Math.min(nowPosition, Math.max(0, next));
    const id = clamped === nowPosition ? null : idOf(clamped);
    // The strip's Back to now goes away at now; focus on it moves to the section instead of the page.
    if (id === null && section.current?.contains(document.activeElement)) section.current.focus({ preventScroll: true });
    setPlaying(false);
    // A held arrow key goes through the throttle, so it asks for one past page at a time.
    if (repeat) sendSeek(id);
    else {
      cancelSeek();
      seekTo(id);
    }
  };
  const backToNow = () => seekPosition(nowPosition);
  const play = () => {
    if (playing) return stop();
    clockRef.current = at === null ? data.start : shownAt;
    setPlayhead(clockRef.current);
    setPlaying(true);
  };
  const toggle = () => {
    saveOpen(!open);
    setOpen(!open);
    setHover(null);
  };
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLSelectElement) return;
    if (event.key === "ArrowLeft") seekPosition(position - 1, event.repeat);
    else if (event.key === "ArrowRight") seekPosition(position + 1, event.repeat);
    else if (event.key === "Home") seekPosition(0);
    else if (event.key === "Escape" && past) seekPosition(nowPosition);
    else if (event.key === " " && event.target === event.currentTarget) play();
    else return;
    event.preventDefault();
  };

  /** What a pointer in a plot points at: inside a fold, its quiet stretch; on a ticket's row, the nearest moment about that ticket. */
  const pointed = (spot: Hover) => {
    const axis = axisFor(spot.plot);
    const row = spot.plot === "lanes" ? Math.floor(spot.y / ROW_PX) : null;
    const key = row !== null && row >= 1 ? (rows[row - 1]?.key ?? null) : null;
    const fits = (moment: Moment) => (key !== null ? moment.lines.some((line) => line.key === key) : row === 0 ? hasKind(moment, "you") || hasKind(moment, "milestone") : true);
    const all = moments.map((moment, momentIndex) => ({ moment, momentIndex }));
    const fitting = all.filter(({ moment }) => fits(moment));
    const candidates = fitting.length > 0 ? fitting : all;
    const found = candidates[nearestIndex(candidates.map(({ moment }) => axis.x(moment.at)), spot.x)]!;
    const fold = folds.find((entry) => spot.x > axis.x(entry.from) + FOLD_EDGE_PX && spot.x < axis.x(entry.to) - FOLD_EDGE_PX) ?? null;
    return { index: found.momentIndex, row, key, fold };
  };
  // The plots draw one pixel per pixel, so a pointer's x is its offset from the plot's left edge.
  const spotOf = (plot: Plot, element: Element, clientX: number, clientY: number): Hover => {
    const box = element.getBoundingClientRect();
    return { plot, x: clientX - box.left, y: clientY - box.top };
  };
  const seekMoment = (momentIndex: number, now: boolean) => {
    const id = idOf(momentIndex);
    if (now) {
      stop();
      seekTo(id);
    } else sendSeek(id);
  };
  const plotEvents = (plot: Plot) => ({
    onMouseMove: (event: { currentTarget: Element; clientX: number; clientY: number }) => {
      const spot = spotOf(plot, event.currentTarget, event.clientX, event.clientY);
      const row = drag.current?.tap === null ? drag.current.row : null;
      // While dragging on the rows, the highlight and the tooltip stay on the row the drag scrubs.
      setHover(row === null ? spot : { ...spot, y: row * ROW_PX + ROW_PX / 2 });
    },
    onMouseLeave: () => setHover(null),
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
      const target = pointed(spotOf(plot, event.currentTarget, event.clientX, event.clientY));
      if (target.fold !== null) return;
      section.current?.focus({ preventScroll: true });
      if (event.pointerType === "touch" && plot === "lanes") {
        drag.current = { pointerId: event.pointerId, row: target.row, tap: target.index };
        return;
      }
      seekMoment(target.index, true);
      drag.current = { pointerId: event.pointerId, row: target.row, tap: null };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const active = drag.current;
      if (active === null || active.pointerId !== event.pointerId || active.tap !== null) return;
      if (event.buttons === 0) {
        drag.current = null;
        return;
      }
      const spot = spotOf(plot, event.currentTarget, event.clientX, event.clientY);
      // A drag stays on the row it started on.
      seekMoment(pointed(active.row === null ? spot : { ...spot, y: active.row * ROW_PX + ROW_PX / 2 }).index, false);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const active = drag.current;
      drag.current = null;
      if (active !== null && active.tap !== null && active.pointerId === event.pointerId) seekMoment(active.tap, true);
    },
    onPointerCancel: () => {
      drag.current = null;
    },
    onLostPointerCapture: () => {
      if (drag.current?.tap === null) drag.current = null;
    },
  });

  const shownMoment = moments[Math.max(0, Math.min(n - 1, index))]!;
  const caption = tellingLine(shownMoment);
  const spot = hover === null ? null : pointed(hover);
  // The hovered time, drawn as a guide on both plots.
  const guideAt = spot === null ? null : spot.fold !== null ? axisFor(hover!.plot).at(hover!.x) : moments[spot.index]!.at;
  const overlay = (axis: Axis, height: number) => {
    const headX = axis.x(shownAt);
    return (
      <>
        {past && (
          <>
            <span aria-hidden className="pointer-events-none absolute -top-0.5 right-0" style={{ left: headX + 1, height: height + 4, background: FRAME, opacity: 0.66 }} />
            <span aria-hidden data-timeline-playhead className="pointer-events-none absolute -top-0.5 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: headX, height: height + 2 }} />
          </>
        )}
        {guideAt !== null && <span aria-hidden data-timeline-guide className="pointer-events-none absolute top-0 border-l border-foreground/45" style={{ left: axis.x(guideAt), height }} />}
      </>
    );
  };

  const status = past ? (
    <>
      <span data-timeline-when className="text-xs font-semibold text-warning-text tabular-nums">
        {clock(shownAt)}
      </span>
      <span className="text-[11px] text-muted-foreground @max-xl:hidden">
        {dayOf(shownAt)}
        {live(data.state) && ` · ${roughly(data.end - shownAt)} ago`}
      </span>
      <button type="button" className={`inline-flex cursor-pointer items-center gap-1 rounded text-[11.5px] text-foreground underline decoration-foreground/40 underline-offset-2 ${FOCUS}`} onClick={backToNow}>
        Back to now <span aria-hidden>»</span>
      </button>
    </>
  ) : (
    <>
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
        <Dot style={{ background: SUCCESS }} />
        {data.state === "running" ? "Live" : "Now"}
      </span>
      <span className="text-[11px] text-muted-foreground">{data.state === "running" ? "updates as it runs" : data.state === "paused" ? "paused" : `last change ${clock(data.end)}`}</span>
    </>
  );

  const tipBody = (() => {
    if (spot === null) return null;
    if (spot.fold !== null) {
      const { from, to } = spot.fold;
      return (
        <>
          <p className="font-semibold">Quiet for {roughly(to - from)}</p>
          <p className="text-muted-foreground">
            Nothing happened from {sameDay(from, to) ? clock(from) : `${weekday(from)} ${clock(from)}`} to {clockAfter(from, to)}, so this stretch is folded.
          </p>
        </>
      );
    }
    const moment = moments[spot.index]!;
    const row = spot.row !== null && spot.row >= 1 ? rows[spot.row - 1] : undefined;
    const hint = <p className="mt-1.5 border-t border-dotted border-border pt-1 text-[11px] text-subtle-foreground">Click to see the project at {clock(moment.at)}</p>;
    if (row !== undefined && row.key !== null) {
      const line = moment.lines.find((entry) => entry.key === row.key) ?? tellingLine(moment);
      const bar = row.bar;
      const session = row.sessions.find((entry) => lanesAxis.x(entry.from) <= hover!.x && lanesAxis.x(entry.to) >= hover!.x);
      const latest = bar?.parts.at(-1);
      return (
        <>
          <p className="font-semibold">
            {row.key}
            {row.title !== "" && ` · ${row.title}`}
          </p>
          <p className="mt-1 flex items-baseline gap-1.5">
            <Dot style={KIND_DOT[line.kind]} className="translate-y-[-1px]" />
            <span>
              <b className="tabular-nums">{clock(moment.at)}</b> {line.text}
            </span>
          </p>
          {session !== undefined && (
            <p className="mt-1 text-muted-foreground">
              {session.role === "worker" ? "Worker" : "Reviewer"}
              {session.label !== "" && `, ${session.label}`}: {roughly(session.to - session.from)}
              {session.endReason === null ? ", still running" : `, ended: ${session.endReason}`}
            </p>
          )}
          {bar !== null && lanes === "tickets" && (
            <>
              <p className="mt-1 text-muted-foreground">{partTotals(bar)}</p>
              <p className="text-muted-foreground">
                {bar.sentBack.length > 0 && `Sent back ${bar.sentBack.length === 1 ? "once" : `${bar.sentBack.length} times`} · `}
                {bar.final === "done" ? `done after ${roughly(bar.to - bar.from)}` : bar.final === "cancelled" ? "cancelled" : `${STATE_WORD[stateAt(bar, data.end)]} for ${roughly(data.end - (latest?.from ?? bar.from))}`}
              </p>
            </>
          )}
          {hint}
        </>
      );
    }
    return (
      <>
        <p className="font-semibold tabular-nums">
          {dayOf(moment.at)} · {clock(moment.at)}
        </p>
        <ul className="mt-1 space-y-0.5">
          {moment.lines.slice(0, 4).map((line, lineIndex) => (
            <li key={lineIndex} className="flex items-baseline gap-1.5">
              <Dot style={KIND_DOT[line.kind]} className="translate-y-[-1px]" />
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
        {moment.lines.length > 4 && <p className="text-muted-foreground">+{moment.lines.length - 4} more</p>}
        {hint}
      </>
    );
  })();

  const stateTime = past ? shownAt : Infinity;
  // bb draws a plugin's panel on its recessed surface; the frame's solid colour matches it, so the fade over the future can too.
  const page = "var(--surface-recessed-solid, var(--background))";
  const frameStyle = { "--loom-timeline-bg": past ? `color-mix(in oklab, var(--warning) 6%, ${page})` : page, background: FRAME } as CSSProperties;
  const ticketRows = rows.filter((row) => row.key !== null).length;

  return (
    <section
      ref={section}
      data-timeline-strip
      data-rewound={past || undefined}
      tabIndex={0}
      aria-label="Timeline"
      onKeyDown={onKey}
      style={frameStyle}
      className={`relative mx-4 my-3 shrink-0 rounded-[9px] border border-dashed px-3 pt-2 pb-2.5 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 ${past ? "border-warning/75" : "border-foreground/35"}`}
    >
      {/* The container query lives on this wrapper: a query container is a stacking context, and the tooltip must not be in it. */}
      <div className="@container">
        <p data-timeline-announce aria-live="polite" className="sr-only">
          {!spoken || playing ? "" : past ? `${clock(shownAt)}: ${caption.text}` : "Back at the live page"}
        </p>
        <div className={HEAD_ROW}>
          <div className="flex items-center justify-between gap-1.5 @max-xl:justify-start @max-xl:gap-2.5">
            <button type="button" aria-expanded={open} onClick={toggle} className={`${HEADING} inline-flex cursor-pointer items-center gap-1 rounded py-0.5 pr-1 hover:bg-state-hover ${FOCUS}`}>
              <span aria-hidden className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>
                {icon(<path d="m9 18 6-6-6-6" />, 12)}
              </span>
              Timeline
            </button>
            <button type="button" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play the project back (Space)"} onClick={play} className={`inline-grid size-[26px] shrink-0 cursor-pointer place-items-center rounded-full border ${FOCUS} ${playing ? "border-foreground/40 text-foreground hover:bg-state-hover" : "border-transparent bg-foreground text-background"}`}>
              {playing ? PAUSE : PLAY}
            </button>
          </div>
          <div className="min-w-0 @max-xl:col-span-2 @max-xl:row-start-2">
            <div ref={trackRef} data-timeline-track className="relative cursor-pointer touch-none" {...plotEvents("track")}>
              <Track moments={moments} folds={folds} axis={trackAxis} width={trackWidth} />
              {overlay(trackAxis, TRACK_PX)}
              {past ? (
                <span aria-hidden className="pointer-events-none absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-foreground" style={{ left: trackAxis.x(shownAt), top: BASE_Y + 0.5, borderColor: FRAME }} />
              ) : (
                <span aria-hidden className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: trackWidth - 1, top: BASE_Y + 0.5, background: SUCCESS, borderColor: FRAME }} />
              )}
            </div>
            <AxisLabels data={data} folds={folds} axis={trackAxis} width={trackWidth} />
          </div>
          <div data-timeline-status className="flex flex-col items-end gap-0.5 text-right @max-xl:col-start-2 @max-xl:row-start-1 @max-xl:flex-row @max-xl:items-baseline @max-xl:gap-2">
            {status}
          </div>
        </div>

        {open && (
          <div data-timeline-open className="mt-2 grid gap-2 border-t border-dotted border-foreground/20 pt-2">
            <div className={MOMENT_ROW}>
              <div className="@max-xl:hidden">
                <p className={HEADING}>Moment</p>
                <p data-timeline-count className="text-[11px] text-muted-foreground tabular-nums">
                  {at === null && !playing ? "now" : `${index + 1} of ${n}`}
                </p>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <button type="button" className={STEP} aria-label="Previous moment" title="Previous moment (←)" aria-disabled={position === 0} onClick={() => position > 0 && seekPosition(position - 1)}>
                  {icon(<path d="m15 18-6-6 6-6" />)}
                </button>
                <button type="button" className={STEP} aria-label="Next moment" title="Next moment (→)" aria-disabled={position === nowPosition} onClick={() => position < nowPosition && seekPosition(position + 1)}>
                  {icon(<path d="m9 18 6-6-6-6" />)}
                </button>
                <Dot style={KIND_DOT[caption.kind]} />
                <p data-timeline-moment title={shownMoment.lines.map((line) => line.text).join("\n")} className="min-w-0 truncate text-[12.5px]">
                  <b className="mr-1.5 tabular-nums">{clock(shownMoment.at)}</b>
                  {caption.text}
                  {shownMoment.lines.length > 1 && <span className="ml-1 text-[11.5px] text-muted-foreground">+{shownMoment.lines.length - 1} more</span>}
                </p>
              </div>
              <select aria-label="Playback speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} className={`h-6 max-w-full justify-self-end rounded-md border border-border-seam bg-transparent px-1 text-[11.5px] text-foreground ${FOCUS}`}>
                {SPEEDS.map((entry) => (
                  <option key={entry.times} value={entry.times}>
                    Play at {entry.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={CONTROLS_ROW}>
              <div role="group" aria-label="Rows" className="inline-flex w-fit gap-0.5 rounded-md border border-border-seam p-0.5">
                {(["tickets", "agents"] as const).map((entry) => (
                  <button key={entry} type="button" aria-pressed={lanes === entry} onClick={() => setLanes(entry)} className={`${CHOICE} ${lanes === entry ? "bg-surface-selected font-semibold text-foreground" : "text-muted-foreground"}`}>
                    {entry === "tickets" ? "Tickets" : "Agents"}
                  </button>
                ))}
              </div>
              <Legend lanes={lanes} hatch={hatch} />
              <button type="button" role="switch" aria-checked={troubleOnly} onClick={() => setTroubleOnly(!troubleOnly)} className={`inline-flex cursor-pointer items-center gap-1.5 justify-self-end whitespace-nowrap rounded text-[11.5px] @max-xl:ml-auto ${FOCUS}`}>
                <span aria-hidden className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors ${troubleOnly ? "bg-destructive" : "bg-foreground/25"}`}>
                  <span className={`absolute top-0.5 size-2.5 rounded-full bg-background transition-[left] ${troubleOnly ? "left-3" : "left-0.5"}`} />
                </span>
                Only trouble · {troubleRows}
              </button>
            </div>

            <div className="overflow-x-hidden overflow-y-auto" style={{ maxHeight: (ROWS_SHOWN + 1) * ROW_PX + 2 }} onScroll={() => setHover(null)}>
              <div className={LANES_ROW}>
                <ul aria-label={lanes === "tickets" ? "Tickets" : "Tickets with agent sessions"} className="grid auto-rows-[20px] text-[11px]">
                  <li className={`${HEADING} flex items-center pl-0.5`}>Project</li>
                  {rows.map((row, rowIndex) => {
                    const state = row.bar === null ? null : stateAt(row.bar, stateTime);
                    return (
                      <li key={row.key ?? ""} className="min-w-0">
                        <button
                          type="button"
                          disabled={row.key === null}
                          aria-label={row.key === null ? "No ticket" : `Open ${row.key}`}
                          aria-describedby={`${hatch}-row-${rowIndex}`}
                          title={row.key === null ? undefined : `${row.key}${row.title === "" ? "" : ` · ${row.title}`}${state === null ? "" : `, ${STATE_WORD[state]}`}`}
                          onClick={() => row.key !== null && onTicket(row.key)}
                          className={`flex h-5 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded pl-0.5 text-left font-mono hover:bg-state-hover disabled:cursor-default ${FOCUS} ${spot?.row === rowIndex + 1 ? "bg-state-hover" : ""}`}
                        >
                          <Dot style={state === null ? {} : STATE_DOT[state]} />
                          <span className="truncate">{row.key ?? "no ticket"}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div ref={lanesRef} data-timeline-lanes-plot className="relative cursor-pointer touch-pan-y" {...plotEvents("lanes")}>
                  {spot !== null && spot.row !== null && <span aria-hidden className="pointer-events-none absolute -inset-x-1 h-5 rounded bg-state-hover" style={{ top: spot.row * ROW_PX }} />}
                  <LanesArt rows={rows} lanes={lanes} data={data} folds={folds} axis={lanesAxis} width={lanesWidth} hatch={hatch} />
                  {overlay(lanesAxis, (rows.length + 1) * ROW_PX)}
                </div>
                <div className="grid auto-rows-[20px] text-[11px] text-muted-foreground tabular-nums @max-xl:hidden">
                  <span aria-hidden />
                  {rows.map((row, rowIndex) => (
                    <span key={row.key ?? ""} id={`${hatch}-row-${rowIndex}`} data-timeline-summary className={`flex items-center justify-end gap-1.5 whitespace-nowrap rounded pr-0.5 ${spot?.row === rowIndex + 1 ? "bg-state-hover" : ""}`}>
                      {rowSummary(row, lanes, stateTime)}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className={FOOT_ROW}>
              <p data-timeline-note className="text-[11px] text-subtle-foreground">
                {plural(ticketRows, "ticket")}
                {lanes === "tickets" && !troubleOnly && data.ticketCount > data.tickets.length && ` · ${data.ticketCount - data.tickets.length} not started`}
              </p>
              <AxisLabels data={data} folds={folds} axis={lanesAxis} width={lanesWidth} />
              <span className="@max-xl:hidden" />
            </div>
            <div className={`${FOOT_ROW} @max-xl:hidden`}>
              <span />
              <p className="text-[11px] text-subtle-foreground">
                Hover to read a moment, click to see the page then. <Key>←</Key>
                <Key>→</Key> step · <Key>Space</Key> play · <Key>Esc</Key> back to now
              </p>
              <span />
            </div>
          </div>
        )}
      </div>
      {tipBody !== null && (
        <div ref={tip} data-timeline-tip role="tooltip" className="pointer-events-none absolute z-10 w-max max-w-[min(340px,calc(100%-12px))] min-w-[200px] rounded-lg border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg [overflow-wrap:anywhere]">
          {tipBody}
        </div>
      )}
    </section>
  );
}

const Key = ({ children }: { children: ReactNode }) => <kbd className="mx-px rounded border border-b-2 border-border px-1 font-mono text-[10px] text-muted-foreground">{children}</kbd>;
