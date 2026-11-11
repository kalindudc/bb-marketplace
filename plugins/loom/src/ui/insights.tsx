import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ActivityMark, CurrentItem, EventLine, InsightsFilter, InsightsNumbers, InsightsWindow, Phrase, ProjectInsights, StoryGroup, StoryItem } from "../contract";
import { compactCount as big, formatDuration, plural } from "../format";
import type { TicketState } from "../states";
import { markStyle, SHARE_PART, SHARE_TRACK, STATE_COLORS, type Swatch } from "./charts";
import { BUTTON, BUTTON_PRIMARY, CARD, CHIP, HEADING, useLoom } from "./common";
import { activityAxis, labelsOf, stepMax, type Bucket } from "./insights-axis";

type Chapter = Extract<StoryItem, { type: "chapter" }>;
type Activity = ProjectInsights["activity"];

const INK = "var(--foreground, currentColor)";
const SUCCESS_INK = `color-mix(in oklab, var(--success, currentColor) 75%, ${INK})`;
const SHIP = "color-mix(in oklab, var(--success, currentColor) 45%, transparent)";
const WARN = "var(--warning, currentColor)";
const BAD = "var(--destructive, currentColor)";
const PRIMARY = "var(--primary, currentColor)";
const MUTED = "var(--loom-muted, currentColor)";
/** A jump the person asked for glides, unless they asked for reduced motion; the place it ends at is the same. */
const glide = (): ScrollBehavior => (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
/** What the chart's card sits on: CARD draws no fill of its own. */
const SURFACE = "var(--background, transparent)";
const MARK_FILL: Record<"done" | "pr" | "back" | "bad", string> = { done: SUCCESS_INK, pr: SHIP, back: WARN, bad: BAD };
// The pull request's pale fill is under 3:1 against the card, so its outline carries it; blocked is hatched because the
// warning and destructive colours of some themes are nearly the same (1.0:1 in gruve light).
const MARK_RING: Partial<Record<"done" | "pr" | "back" | "bad", string>> = { pr: SUCCESS_INK, bad: BAD };
const BAD_HATCH = `repeating-linear-gradient(45deg, ${BAD} 0 1.5px, transparent 1.5px 3.5px)`;
/** A line of the surface's colour between stacked marks, so each meets 3:1 against what touches it (WCAG 1.4.11's separator). */
const SEPARATOR_PX = 1.5;
const CODE = "rounded bg-state-hover px-1 font-mono text-[11.5px] [overflow-wrap:anywhere]";
const LINK = "cursor-pointer rounded underline decoration-primary/60 decoration-[1.5px] underline-offset-2 hover:text-[var(--loom-link)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const KEY_BUTTON = "inline-flex min-h-6 @max-xl/loom:min-h-11 @max-xl/loom:min-w-11 max-[576px]:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 items-center justify-center cursor-pointer rounded text-xs font-semibold hover:text-[var(--loom-link)] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const SEG = "inline-flex flex-wrap gap-0.5 rounded-md border border-border-seam p-0.5";
const segButton = (on: boolean) => `inline-flex items-center justify-center cursor-pointer rounded px-2 py-0.5 @max-xl/loom:min-h-11 max-[576px]:min-h-11 @max-xl/loom:min-w-11 max-[576px]:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${on ? "bg-surface-selected font-semibold text-foreground" : "text-[var(--loom-muted)] hover:bg-state-hover"}`;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dated = (at: number) => new Date(at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const spanText = (from: number, to: number) => (sameDay(from, to) ? `${dated(from)} – ${clock(to)}` : `${dated(from)} – ${dated(to)}`);
const dur = (ms: number) => formatDuration(ms);
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const chapterId = (chapter: Chapter) => `${chapter.key}-${chapter.first}`;
/** Keys from what an entry is, with a count only for a true duplicate, so a new entry does not remount the others. */
function keysOf<T>(list: readonly T[], base: (item: T) => string): string[] {
  const seen = new Map<string, number>();
  return list.map((item) => {
    const key = base(item);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? key : `${key}~${count}`;
  });
}
const groupKeys = (groups: readonly StoryGroup[]) => keysOf(groups, (group) => `${group.from}-${group.state}`);
const sameWindow = (a: InsightsWindow, b: InsightsWindow) => (typeof a === "string" || typeof b === "string" ? a === b : a.from === b.from && a.to === b.to);

/** A phrase as plain text, for search and hover titles. */
export function textOf(phrase: Phrase): string {
  return phrase.map((part) => (typeof part === "string" ? part : "code" in part ? part.code : "quote" in part ? `“${part.quote}”` : "link" in part ? part.text : part.date ? dated(part.at) : clock(part.at))).join("");
}

function Words({ phrase, onLink }: { phrase: Phrase; onLink?(filter: InsightsFilter): void }) {
  return (
    <>
      {phrase.map((part, index) => {
        if (typeof part === "string") return <span key={index}>{part}</span>;
        if ("code" in part) return <code key={index} className={CODE}>{part.code}</code>;
        if ("quote" in part) return <q key={index} className="text-foreground">{part.quote}</q>;
        if ("link" in part)
          return onLink === undefined ? (
            <span key={index}>{part.text}</span>
          ) : (
            <button key={index} type="button" className={LINK} onClick={() => onLink(part.link)}>
              {part.text}
            </button>
          );
        return (
          <time key={index} dateTime={new Date(part.at).toISOString()}>
            {part.date === true ? dated(part.at) : clock(part.at)}
          </time>
        );
      })}
    </>
  );
}

const PRESETS: ReadonlyArray<{ window: "all" | "run" | "day"; label: string }> = [
  { window: "all", label: "Whole project" },
  { window: "run", label: "Latest run" },
  { window: "day", label: "Last 24 hours" },
];

/** The Insights tab: how the project went, when its work happened, what happened to each ticket and the numbers. */
export function InsightsTab({ slug, at, onTicket }: { slug: string; at: number | null; onTicket(key: string): void }) {
  const [window, setWindow] = useState<InsightsWindow>("all");
  const [filter, setFilter] = useState<InsightsFilter>("story");
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [pane, setPane] = useState<"story" | "numbers">("story");
  const [found, setFound] = useState<{ key: string; seq: number } | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const story = useRef<HTMLElement>(null);
  const remote = useLoom("insights", { slug, ...(window === "all" ? {} : { window }), ...(at === null ? {} : { at }) }, { keep: true });
  const view = remote.data ?? null;
  const live = at === null && view !== null && (view.state === "running" || view.state === "paused");
  // Elapsed times count on from when this view arrived, on the server's clock, so a skewed local clock does not matter.
  const received = useRef<{ view: ProjectInsights | null; at: number }>({ view: null, at: 0 });
  if (received.current.view !== view) received.current = { view, at: Date.now() };

  // Once the page shows a ticket's story, it brings its first chapter into view and moves focus there, because the
  // number that asked for it may sit in a pane that is now hidden.
  useEffect(() => {
    if (found === null) return;
    const frame = requestAnimationFrame(() => {
      story.current?.querySelector(`[data-chapter="${CSS.escape(found.key)}"]`)?.scrollIntoView?.({ block: "center", behavior: glide() });
      story.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [found]);
  // A preset the moment does not offer (a rewound page with one run, say) falls back to the whole project.
  useEffect(() => {
    if (view !== null && ((window === "run" && !view.presets.run) || (window === "day" && !view.presets.day))) setWindow("all");
  }, [view, window]);
  // The times "for 5m" count on between events while the page is live.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [live]);

  const pick = (next: InsightsWindow) => {
    if (sameWindow(next, window)) return;
    setWindow(next);
    setOpen(new Set());
  };
  if (view === null) {
    if (remote.error === null) return <p role="status" className="p-4 text-sm text-[var(--loom-muted)]">Loading…</p>;
    return (
      <div role="alert" className="space-y-2 p-4 text-sm text-[var(--loom-bad)]">
        <p>Could not load the insights: {remote.error}</p>
        {window !== "all" && (
          <button type="button" className={BUTTON} onClick={() => pick("all")}>
            Show the whole project
          </button>
        )}
      </div>
    );
  }
  const now = live ? view.now + Math.max(0, clock - received.current.at) : view.now;

  const showStory = () => {
    setPane("story");
    requestAnimationFrame(() => {
      story.current?.scrollIntoView?.({ block: "start", behavior: glide() });
      story.current?.focus({ preventScroll: true });
    });
  };
  const showFilter = (next: InsightsFilter) => {
    setFilter(next);
    setQuery("");
    setFound(null);
    showStory();
  };
  const findTicket = (key: string) => {
    setFilter("story");
    setQuery(key);
    setOpen(new Set(view.groups.flatMap((group) => group.items.filter((item): item is Chapter => item.type === "chapter" && item.key === key).map(chapterId))));
    setFound({ key, seq: (found?.seq ?? 0) + 1 });
    setPane("story");
  };
  const search = (next: string) => {
    setQuery(next);
    if (found !== null && next !== found.key) setFound(null);
  };

  return (
    <div data-insights className="@container space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="Stretch of the project" data-insights-window className={SEG}>
          {PRESETS.filter((preset) => preset.window === "all" || view.presets[preset.window]).map((preset) => (
            <button key={preset.window} type="button" aria-pressed={sameWindow(window, preset.window)} className={segButton(sameWindow(window, preset.window))} onClick={() => pick(preset.window)}>
              {preset.label}
            </button>
          ))}
        </div>
        {typeof window !== "string" && sameWindow(view.window, window) && view.range !== null && (
          <span data-insights-range className="inline-flex items-center gap-1 rounded-full border border-primary/50 bg-primary/10 py-0.5 pr-0.5 pl-2.5 text-xs">
            Showing {spanText(view.range.from, view.range.to)}
            <button type="button" aria-label="Show the whole project" className="cursor-pointer rounded-full px-1.5 text-[var(--loom-muted)] hover:bg-state-hover hover:text-foreground" onClick={() => pick("all")}>
              ×
            </button>
          </span>
        )}
        {at === null && view.state === "running" && (
          <span data-insights-live className="ml-auto inline-flex items-center gap-1.5 text-xs text-[var(--loom-muted)]">
            <span aria-hidden className="size-1.5 rounded-full bg-primary" />
            Live: it updates within a second of an event
          </span>
        )}
      </div>
      <Summary view={view} onLink={showFilter} />
      <section data-insights-activity className={CARD}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold">When the work happened</h2>
          <p className="text-xs text-[var(--loom-muted)]">Quiet stretches are folded. Click a bar, or drag across bars, to see only that stretch.</p>
        </div>
        <ActivityChart activity={view.activity} strategy={view.strategy} range={view.range} onRange={(range) => pick(range === null ? "all" : range)} />
      </section>
      <div role="group" aria-label="View" className={`${SEG} @4xl:hidden`}>
        {(["story", "numbers"] as const).map((value) => (
          <button key={value} type="button" aria-pressed={pane === value} className={segButton(pane === value)} onClick={() => setPane(value)}>
            {value === "story" ? "What happened" : "In numbers"}
          </button>
        ))}
      </div>
      <div className="grid items-start gap-3 @4xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section ref={story} tabIndex={-1} data-insights-story aria-label="What happened" className={`${CARD} min-w-0 focus-visible:outline-none ${pane === "numbers" ? "hidden @4xl:block" : ""}`}>
          <Story view={view} now={now} filter={filter} onFilter={setFilter} query={query} onQuery={search} order={order} onOrder={setOrder} open={open} onOpen={setOpen} hit={found?.key ?? null} onTicket={onTicket} />
        </section>
        <div data-insights-numbers className={`min-w-0 gap-3 @xl:grid-cols-2 @4xl:grid-cols-1 ${pane === "story" ? "hidden @4xl:grid" : "grid"}`}>
          <Numbers view={view} onFind={findTicket} onLink={showFilter} />
        </div>
      </div>
    </div>
  );
}

function Summary({ view, onLink }: { view: ProjectInsights; onLink(filter: InsightsFilter): void }) {
  return (
    <section data-insights-summary className={`${CARD} grid gap-4 @3xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]`}>
      <div className="min-w-0">
        <h2 className={HEADING}>{view.range === null ? "How it went" : "This stretch"}</h2>
        <p data-insights-headline className="mt-1 mb-1.5 text-lg leading-snug font-semibold">
          {view.headline}
        </p>
        {view.lines.map((line, index) => (
          <p key={index} data-insights-line className="text-sm leading-relaxed">
            <Words phrase={line} onLink={onLink} />
          </p>
        ))}
      </div>
      {/* As many columns as fit at 11rem each, so enlarged text stacks the figures rather than spill from them. */}
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-2 self-start">
        {view.figures.map((figure) => (
          <div key={figure.label} data-figure={figure.label} className="min-w-0 rounded-md border border-border-seam bg-surface-recessed px-3 py-2">
            <dt className={HEADING}>{figure.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold [overflow-wrap:anywhere]">{figure.value}</dd>
            <dd className="text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">{figure.note}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ---- the activity chart

interface Bar extends Bucket {
  marks: ActivityMark[];
  fly: number;
}

const HEIGHT = 150;
const TIP_PX = 256;
const TOP = 22;
const BOTTOM = 20;

function bucketText(bar: Bar, paused: Activity["spans"]): string[] {
  const of = (kind: ActivityMark["kind"]) => bar.marks.filter((mark) => mark.kind === kind);
  const keys = (kind: ActivityMark["kind"]) => [...new Set(of(kind).map((mark) => mark.key ?? ""))].join(", ");
  const lines: string[] = [];
  if (of("done").length > 0) lines.push(`Shipped: ${keys("done")}`);
  if (of("pr").length > 0) lines.push(`Pull request opened: ${keys("pr")}`);
  if (of("back").length > 0) lines.push(`Sent back for a fix: ${keys("back")}`);
  if (of("bad").length > 0) lines.push(`Blocked or failed: ${keys("bad")}`);
  for (const mark of [...of("you"), ...of("milestone")]) lines.push(mark.text);
  lines.push(`${plural(bar.fly, "ticket")} in flight`);
  const still = paused.find((span) => span.from < bar.to && span.to > bar.from);
  if (still !== undefined) lines.push(still.state === "paused" ? "The project was paused for some of it" : "The project was being planned for some of it");
  return lines;
}

function ActivityChart({ activity, strategy, range, onRange }: { activity: Activity; strategy: ProjectInsights["strategy"]; range: ProjectInsights["range"]; onRange(range: { from: number; to: number } | null): void }) {
  const box = useRef<HTMLDivElement>(null);
  const hatch = useId();
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [cursor, setCursorState] = useState<{ anchor: number; at: number } | null>(null);
  const [said, setSaid] = useState("");
  // Keys can come faster than renders, so the handler reads the cursor from here.
  const cursorRef = useRef<{ anchor: number; at: number } | null>(null);
  const setCursor = (next: { anchor: number; at: number } | null) => {
    cursorRef.current = next;
    setCursorState(next);
    setSaid("");
  };
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const measure = () => setWidth(Math.max(280, Math.round(element.clientWidth || 640)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const axis = useMemo(() => activityAxis(activity.times, activity.start, activity.end, width), [activity, width]);
  const bars: Bar[] = useMemo(() => axis.buckets.map((bucket) => ({ ...bucket, marks: activity.marks.filter((mark) => mark.at >= bucket.from && mark.at < bucket.to), fly: stepMax(activity.flight, bucket.from, bucket.to) })), [axis, activity]);
  const stacks = bars.map((bar) => (["done", "pr", "back", "bad"] as const).map((kind) => bar.marks.filter((mark) => mark.kind === kind).length));
  const most = Math.max(1, ...bars.map((bar, index) => Math.max(bar.fly, stacks[index]!.reduce((sum, count) => sum + count, 0))));
  const y = (value: number) => HEIGHT - BOTTOM - (value / most) * (HEIGHT - TOP - BOTTOM);
  const selected = (bar: Bar) => range !== null && bar.to > range.from && bar.from <= range.to;
  const marked = drag ?? (cursor === null ? null : { a: cursor.anchor, b: cursor.at });
  const inMarked = (index: number) => marked !== null && index >= Math.min(marked.a, marked.b) && index <= Math.max(marked.a, marked.b);
  const shown = hover ?? cursor?.at ?? null;
  const choose = (a: number, b: number) => {
    const lo = bars[Math.min(a, b)];
    const hi = bars[Math.max(a, b)];
    if (lo === undefined || hi === undefined) return;
    const next = { from: lo.from, to: hi.to - 1 };
    // The server cuts a stretch to the project's life, so picking the same bars again compares after the same cut.
    const same = range !== null && range.from === Math.max(next.from, activity.start) && range.to === Math.min(next.to, activity.end);
    setSaid(same ? "Showing the whole project." : `Showing ${spanText(next.from, next.to)}.`);
    onRange(same ? null : next);
  };
  const indexAt = (event: ReactPointerEvent<SVGSVGElement>): number | null => {
    const own = (event.target as Element).getAttribute?.("data-bucket");
    if (own !== null && own !== undefined) return Number(own);
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const index = bars.findIndex((bar) => x >= bar.x && x < bar.x + bar.w);
    return index < 0 ? null : index;
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (bars.length === 0) return;
    const current = cursorRef.current;
    const at = current?.at ?? null;
    const move = (next: number) => {
      const clamped = Math.max(0, Math.min(bars.length - 1, next));
      setHover(null);
      setCursor({ anchor: event.shiftKey && current !== null ? current.anchor : clamped, at: clamped });
      event.preventDefault();
    };
    // With no bar picked yet, Left starts at the newest bar and Right at the oldest.
    if (event.key === "ArrowLeft") move(at === null ? bars.length - 1 : at - 1);
    else if (event.key === "ArrowRight") move(at === null ? 0 : at + 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(bars.length - 1);
    else if ((event.key === "Enter" || event.key === " ") && current !== null) {
      choose(current.anchor, current.at);
      event.preventDefault();
    } else if (event.key === "Escape" && range !== null) {
      setSaid("Showing the whole project.");
      onRange(null);
      event.preventDefault();
    }
  };
  const endDrag = () => setDrag(null);
  const labels = labelsOf(axis, width, (at, date) => (date ? dated(at) : clock(at)).length * 6.6);
  const paused = activity.spans.filter((span) => span.state !== "running" && span.state !== "done" && span.state !== "archived");
  const runs: Bar[][] = [];
  bars.forEach((bar, index) => {
    if (index === 0 || bars[index - 1]!.to !== bar.from) runs.push([]);
    runs.at(-1)!.push(bar);
  });
  const tip = shown === null ? null : bars[shown];

  return (
    <div
      ref={box}
      data-activity-chart
      tabIndex={0}
      role="group"
      aria-label={`When the work happened, in ${plural(bars.length, "bar")} of ${dur(axis.bucket)}. Use the arrow keys to pick a bar, Shift with an arrow to pick several, Enter to show only that stretch and Escape to show the whole project.`}
      className="relative mt-2 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onKeyDown={onKey}
      onBlur={() => setCursor(null)}
    >
      <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--loom-muted)]">
        <Key fill={MARK_FILL.done}>Shipped</Key>
        {strategy === "pr" && <Key fill={MARK_FILL.pr} ring={MARK_RING.pr}>Pull request opened</Key>}
        <Key fill={MARK_FILL.back}>Sent back for a fix</Key>
        <Key fill={BAD_HATCH} ring={MARK_RING.bad}>Blocked or failed</Key>
        <Key fill={`color-mix(in oklab, ${PRIMARY} 22%, transparent)`} ring={PRIMARY}>Tickets in flight</Key>
        <Key fill="transparent" ring={INK} round>You</Key>
        <Key fill={PRIMARY} diamond>Milestone</Key>
        {paused.length > 0 && <Key fill={`repeating-linear-gradient(45deg, ${MUTED} 0 1.25px, transparent 1.25px 4px)`}>Paused or planning</Key>}
        <span className="ml-auto">Each bar is {dur(axis.bucket)}</span>
      </div>
      <svg
        role="img"
        aria-label={`Activity from ${dated(activity.start)} to ${dated(activity.end)}`}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        height={HEIGHT}
        className="block w-full touch-pan-y select-none"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          const index = indexAt(event);
          if (index === null) return;
          setDrag({ a: index, b: index });
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const index = indexAt(event);
          setHover(index);
          if (drag !== null && (event.buttons & 1) === 0) endDrag();
          else if (drag !== null && index !== null) setDrag({ ...drag, b: index });
        }}
        onPointerUp={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          if (drag !== null) choose(drag.a, drag.b);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          endDrag();
        }}
        onPointerCancel={endDrag}
        onContextMenu={endDrag}
        onLostPointerCapture={endDrag}
        onPointerLeave={() => {
          if (drag === null) setHover(null);
        }}
      >
        <defs>
          {/* A paused stretch is data, so its hatch is drawn in full-strength muted ink, thin and sparse, to reach 3:1. */}
          <pattern id={hatch} width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={7} style={{ stroke: MUTED }} strokeWidth={1.25} />
          </pattern>
          <pattern id={`${hatch}-bad`} width={3.5} height={3.5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={3.5} style={{ stroke: BAD }} strokeWidth={1.5} />
          </pattern>
        </defs>
        {paused
          .map((span, index) => {
            const x1 = axis.x(span.from);
            const x2 = axis.x(Math.min(span.to, activity.end));
            return x2 - x1 < 1 ? null : (
              <rect key={`${span.from}-${span.state}-${index}`} data-activity-paused x={x1} y={TOP - 6} width={x2 - x1} height={HEIGHT - TOP - BOTTOM + 6} fill={`url(#${hatch})`}>
                <title>{`${span.state === "paused" ? "Paused" : "Planning"}: ${spanText(span.from, span.to)}`}</title>
              </rect>
            );
          })}
        {runs.map((run) => {
          const line = run.map((bar) => `L${bar.x} ${y(bar.fly)} L${bar.x + bar.w} ${y(bar.fly)}`).join(" ");
          const lastBar = run.at(-1)!;
          return (
            <g key={run[0]!.from}>
              <path d={`M${run[0]!.x} ${y(0)} ${line} L${lastBar.x + lastBar.w} ${y(0)} Z`} style={{ fill: `color-mix(in oklab, ${PRIMARY} 13%, transparent)` }} />
              <path d={`M${line.slice(1)}`} fill="none" strokeWidth={1.2} style={{ stroke: PRIMARY, strokeOpacity: 0.7 }} />
            </g>
          );
        })}
        {bars.map((bar, index) => {
          const gap = Math.min(2, bar.w * 0.2);
          let base = 0;
          return (
            <g key={bar.from} data-activity-bar={index}>
              {(["done", "pr", "back", "bad"] as const).map((kind, k) => {
                const count = stacks[index]![k]!;
                if (count === 0) return null;
                const below = base;
                base += count;
                const x = bar.x + gap / 2;
                const w = Math.max(1, bar.w - gap);
                const ring = MARK_RING[kind];
                return (
                  <g key={kind}>
                    <rect data-mark={kind} x={x} y={y(base)} width={w} height={y(below) - y(base)} rx={1.5} fill={kind === "bad" ? `url(#${hatch}-bad)` : undefined} strokeWidth={ring === undefined ? undefined : 1} style={{ fill: kind === "bad" ? undefined : MARK_FILL[kind], stroke: ring }} />
                    {below > 0 && <line data-mark-separator x1={x} x2={x + w} y1={y(below)} y2={y(below)} strokeWidth={SEPARATOR_PX} style={{ stroke: SURFACE }} />}
                  </g>
                );
              })}
              {(selected(bar) || inMarked(index)) && <rect x={bar.x} y={TOP - 6} width={bar.w} height={HEIGHT - TOP - BOTTOM + 6} style={{ fill: `color-mix(in oklab, ${PRIMARY} 16%, transparent)` }} data-activity-selected />}
              {shown === index && <rect x={bar.x} y={TOP - 6} width={bar.w} height={HEIGHT - TOP - BOTTOM + 6} fill="none" strokeWidth={1} style={{ stroke: PRIMARY }} />}
              {bar.marks.some((mark) => mark.kind === "milestone") && <rect x={bar.x + bar.w / 2 - 3.5} y={2.5} width={7} height={7} transform={`rotate(45 ${bar.x + bar.w / 2} 6)`} style={{ fill: PRIMARY }} />}
              {bar.marks.some((mark) => mark.kind === "you") && <circle cx={bar.x + bar.w / 2 + (bar.marks.some((mark) => mark.kind === "milestone") ? 8 : 0)} cy={6} r={3.8} strokeWidth={1.5} style={{ fill: SURFACE, stroke: INK }} />}
            </g>
          );
        })}
        <line x1={0} x2={width} y1={y(0)} y2={y(0)} strokeWidth={1} style={{ stroke: "var(--border, currentColor)" }} />
        {axis.folds.map((fold) => (
          <g key={fold.from} data-activity-fold>
            <title>{`${dur(fold.to - fold.from)} with nothing happening (${spanText(fold.from, fold.to)})`}</title>
            {[-3, 3].map((dx) => (
              <line key={dx} x1={fold.x + fold.w / 2 + dx} x2={fold.x + fold.w / 2 + dx} y1={TOP} y2={y(0)} strokeDasharray="2 2" style={{ stroke: MUTED, strokeOpacity: 0.6 }} />
            ))}
            <text x={fold.x + fold.w / 2} y={TOP - 9} textAnchor="middle" fontSize={11} style={{ fill: MUTED, paintOrder: "stroke", stroke: SURFACE, strokeWidth: 3 }}>
              {dur(fold.to - fold.from).split(" ")[0]}
            </text>
          </g>
        ))}
        {labels.map((label) => (
          <text key={label.at} x={label.x + 1} y={HEIGHT - 5} fontSize={11} style={{ fill: MUTED }}>
            {label.date ? dated(label.at) : clock(label.at)}
          </text>
        ))}
        <text x={width} y={y(most) - 3} textAnchor="end" fontSize={11} style={{ fill: MUTED }}>
          {most}
        </text>
        {bars.map((bar, index) => (
          <rect key={bar.from} data-bucket={index} x={bar.x} y={0} width={Math.max(1, bar.w)} height={HEIGHT - BOTTOM} fill="transparent" className="cursor-pointer" />
        ))}
      </svg>
      {tip !== undefined && tip !== null && (
        <div
          data-activity-tip
          className="pointer-events-none absolute z-10 max-w-64 rounded-md border border-border-seam bg-card px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: Math.max(0, Math.min(tip.x, width - TIP_PX)), top: HEIGHT + 24, maxWidth: Math.min(TIP_PX, width) }}
        >
          <p className="font-semibold">{spanText(tip.from, tip.to)}</p>
          {bucketText(tip, paused).map((line, index) => (
            <p key={index} className="text-[var(--loom-muted)]">
              {line}
            </p>
          ))}
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {said !== "" ? said : cursor !== null && tip !== undefined && tip !== null ? `${spanText(tip.from, tip.to)}. ${bucketText(tip, paused).join(". ")}.` : ""}
      </p>
    </div>
  );
}

function Key({ fill, ring, round = false, diamond = false, children }: { fill: string; ring?: string; round?: boolean; diamond?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`inline-block size-2.5 ${round ? "rounded-full" : "rounded-sm"} ${diamond ? "scale-75 rotate-45" : ""}`} style={{ background: fill, boxShadow: ring === undefined ? undefined : `inset 0 0 0 1.5px ${ring}` }} />
      {children}
    </span>
  );
}

// ---- the story

const TONE_ICON: Record<Chapter["tone"], { mark: string; className: string }> = {
  ok: { mark: "✓", className: "bg-success/15 text-[var(--loom-ok)]" },
  fixed: { mark: "✓", className: "bg-success/15 text-[var(--loom-ok)] ring-[1.5px] ring-warning ring-inset" },
  going: { mark: "●", className: "bg-primary/10 text-[color-mix(in_oklab,var(--primary)_70%,var(--foreground))]" },
  blocked: { mark: "!", className: "bg-destructive-text/15 text-[var(--loom-bad)]" },
  pr: { mark: "↗", className: "text-[var(--loom-ok)] ring-[1.5px] ring-success ring-inset" },
  quiet: { mark: "·", className: "bg-state-hover text-[var(--loom-muted)]" },
};
const NOTE_ICON: Record<"you" | "bad" | "milestone" | "created" | "back", { mark: string; className: string }> = {
  you: { mark: "Y", className: "text-foreground ring-[1.5px] ring-foreground ring-inset" },
  bad: { mark: "!", className: "bg-destructive-text/15 text-[var(--loom-bad)]" },
  back: { mark: "↺", className: "bg-warning/15 text-[var(--loom-warn)]" },
  milestone: { mark: "◆", className: "bg-state-hover text-[var(--loom-muted)]" },
  created: { mark: "+", className: "bg-state-hover text-[var(--loom-muted)]" },
};
const CHIP_TONE: Record<string, string> = { "": "text-[var(--loom-muted)]", warn: "border-warning/50 text-[var(--loom-warn)]", bad: "border-destructive-text/40 text-[var(--loom-bad)]", you: "border-foreground text-foreground" };

function Icon({ mark, className }: { mark: string; className: string }) {
  return (
    <span aria-hidden className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${className}`}>
      {mark}
    </span>
  );
}

function Row({ icon, children, side, className = "", ...rest }: { icon: ReactNode; children: ReactNode; side?: ReactNode; className?: string; [data: `data-${string}`]: string | undefined }) {
  return (
    <li className={`grid grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,auto)] gap-x-2.5 border-b border-border-seam/60 py-2 last:border-b-0 ${className}`} {...rest}>
      {icon}
      <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
      {/* Beside the row while the page is wide; under its text on a narrow page, where enlarged text would leave none. */}
      <div className="min-w-0 max-w-[12rem] text-right text-xs text-[var(--loom-muted)] @max-xl/loom:col-start-2 @max-xl/loom:max-w-none @max-xl/loom:text-left">{side}</div>
    </li>
  );
}

function LifeBar({ parts }: { parts: Chapter["parts"] }) {
  if (parts.length === 0) return null;
  const from = parts[0]!.from;
  const total = Math.max(1, parts.at(-1)!.to - from);
  const label = parts.map((part) => `${STATE_WORD[part.state]} ${dur(part.to - part.from)}`).join(" · ");
  return (
    <div role="img" aria-label={label} title={label} className={`${SHARE_TRACK} mt-1.5 h-1.5 max-w-sm`}>
      {parts.map((part, index) => (
        <span key={index} className={SHARE_PART} style={{ width: `${((part.to - part.from) / total) * 100}%`, ...markStyle(STATE_COLORS[part.state]) }} />
      ))}
    </div>
  );
}

const STATE_WORD: Record<TicketState, string> = { queued: "Waiting", working: "Being built", checking: "Running checks", review: "In review", approved: "Approved", merging: "Merging", pr_open: "Pull request open", blocked: "Blocked", done: "Shipped", cancelled: "Cancelled" };

interface StoryProps {
  view: ProjectInsights;
  now: number;
  filter: InsightsFilter;
  onFilter(filter: InsightsFilter): void;
  query: string;
  onQuery(query: string): void;
  order: "newest" | "oldest";
  onOrder(order: "newest" | "oldest"): void;
  open: ReadonlySet<string>;
  onOpen(open: ReadonlySet<string>): void;
  hit: string | null;
  onTicket(key: string): void;
}

function Story(props: StoryProps) {
  const { view, filter, query, order } = props;
  const lines = view.groups.flatMap((group) => group.lines);
  const counts: Record<InsightsFilter, number | null> = { story: null, problems: lines.filter((line) => line.problem).length, you: lines.filter((line) => line.you).length, all: lines.length };
  const labels: Record<InsightsFilter, string> = { story: "Story", problems: "Problems", you: "You", all: "Every event" };
  const ordered = <T,>(list: readonly T[]) => (order === "newest" ? [...list].reverse() : [...list]);
  const needle = query.trim().toLowerCase();
  // A query that is a ticket's key finds that ticket alone, so CSV-1 does not find CSV-10.
  const known = new Set(view.groups.flatMap((group) => [...group.lines.flatMap((line) => (line.key === null ? [] : [line.key.toLowerCase()])), ...group.items.flatMap((item) => (item.type === "chapter" ? [item.key.toLowerCase()] : item.type === "created" ? item.tickets.map((ticket) => ticket.key.toLowerCase()) : []))]));
  for (const entry of view.numbers.tokens.byTicket) known.add(entry.key.toLowerCase());
  const exactKey = known.has(needle) || (props.hit !== null && props.hit.toLowerCase() === needle);
  const matches = (text: string, key: string | null = null) => needle === "" || (exactKey ? key?.toLowerCase() === needle : text.toLowerCase().includes(needle));
  let body: ReactNode;
  if (filter === "story") body = <StoryGroups {...props} ordered={ordered} matches={matches} />;
  else body = <LineGroups {...props} ordered={ordered} matches={matches} />;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">What happened</h2>
        <div role="group" aria-label="Order" className={`${SEG} ml-auto`}>
          {(["newest", "oldest"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={order === value} className={segButton(order === value)} onClick={() => props.onOrder(value)}>
              {value === "newest" ? "Newest first" : "Oldest first"}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter the story" data-story-filter className={SEG}>
          {(["story", "problems", "you", "all"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={filter === value} className={segButton(filter === value)} onClick={() => props.onFilter(value)}>
              {labels[value]}
              {counts[value] !== null && <span className="ml-1 text-[11px] font-medium text-[var(--loom-muted)]">{counts[value]}</span>}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Find a ticket or a word"
          placeholder="Find a ticket or a word"
          value={query}
          onChange={(event) => props.onQuery(event.target.value)}
          className="h-7 @max-xl/loom:h-11 max-[576px]:h-11 pointer-coarse:h-11 min-w-40 flex-1 rounded-md border border-[var(--loom-field-line)] bg-transparent px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-w-64"
        />
      </div>
      {filter === "story" && view.range === null && needle === "" && view.current.length > 0 && <Current items={view.current} state={view.state} now={props.now} onTicket={props.onTicket} />}
      <div data-story-body>{body}</div>
    </>
  );
}

function Current({ items, state, now, onTicket }: { items: CurrentItem[]; state: ProjectInsights["state"]; now: number; onTicket(key: string): void }) {
  const navigate = useBbNavigate();
  const blocked = items.some((item) => item.kind === "blocked");
  return (
    <div data-insights-current className={`mt-3 rounded-md border px-3 ${blocked ? "border-destructive-text/40 bg-destructive-text/5" : "border-primary/50 bg-primary/5"}`}>
      <h3 className={`${HEADING} pt-2`}>Right now</h3>
      <ul>
        {items.map((item) => (
          <Row
            key={item.key}
            data-current={item.key}
            icon={<Icon {...(item.kind === "blocked" ? TONE_ICON.blocked : item.kind === "pr" ? TONE_ICON.pr : TONE_ICON.going)} />}
            side={
              <>
                {item.kind === "pr" ? "open " : "for "}
                <span className="font-semibold text-foreground">{dur(Math.max(0, now - item.since))}</span>
              </>
            }
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <button type="button" className={KEY_BUTTON} onClick={() => onTicket(item.key)}>
                {item.key}
              </button>
              <span className="text-sm">{item.title}</span>
            </div>
            <p className="mt-0.5 text-sm text-[var(--loom-muted)]">
              {item.kind === "blocked" ? (
                <>
                  <b className="font-semibold text-[var(--loom-bad)]">Blocked, waiting for you</b>
                  {item.reason !== null && (
                    <>
                      : <q className="text-foreground">{item.reason}</q>
                    </>
                  )}
                </>
              ) : item.kind === "held" ? (
                `${STATE_WORD[item.state]}${item.state === "review" && item.reviewRound > 0 ? `, round ${item.reviewRound}` : ""}, held by the pause.`
              ) : (
                <>
                  Its pull request waits on people to review and merge it{item.prRounds > 0 ? `; ${plural(item.prRounds, "fix round")} from its feedback so far` : ""}.
                </>
              )}
            </p>
            {item.kind === "blocked" && (
              <button type="button" className={`${BUTTON_PRIMARY} mt-1.5`} onClick={() => onTicket(item.key)}>
                Answer on the ticket
              </button>
            )}
            {item.kind === "pr" && item.prUrl !== null && (
              <button type="button" className={`${BUTTON} mt-1.5`} onClick={() => navigate.openUrl(item.prUrl!)}>
                Open the pull request
              </button>
            )}
          </Row>
        ))}
      </ul>
      {state === "paused" && <p className="pb-2 text-xs text-[var(--loom-muted)]">The project is paused, so nothing moves until you resume it.</p>}
    </div>
  );
}

type Helpers = StoryProps & { ordered<T>(list: readonly T[]): T[]; matches(text: string, key?: string | null): boolean };

function GroupHead({ group, right }: { group: StoryGroup; right?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-b border-border-seam pb-1.5">
      <h3 className="text-[13px] font-semibold">{group.title}</h3>
      <span className="text-xs text-[var(--loom-muted)]">
        {group.state === "done" ? dated(group.from) : `${spanText(group.from, group.to)} · ${dur(group.to - group.from)}`}
      </span>
      {right !== undefined && right !== "" && <span className="ml-auto min-w-0 text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">{right}</span>}
    </div>
  );
}

const itemText = (item: StoryItem) => (item.type === "chapter" ? `${item.key} ${item.title} ${item.head} ${item.says.map(textOf).join(" ")}` : item.type === "created" ? item.tickets.map((ticket) => `${ticket.key} ${ticket.title}`).join(" ") : textOf(item.text));

function StoryGroups({ view, ordered, matches, open, onOpen, hit, onTicket, query }: Helpers) {
  const rendered: ReactNode[] = [];
  const groups = ordered(view.groups);
  const keys = groupKeys(groups);
  for (const [index, group] of groups.entries()) {
    const key = keys[index]!;
    const items = group.items.filter((item) => matches(itemText(item), item.type === "chapter" ? item.key : item.type === "created" && item.tickets.length === 1 ? item.tickets[0]!.key : null));
    const why = group.why === null ? "" : textOf(group.why);
    if (items.length === 0) {
      if (group.state === "paused" && query.trim() === "")
        rendered.push(
          <div key={key} data-group={group.title} className="my-3 flex items-center gap-2.5 text-xs text-[var(--loom-muted)] before:flex-1 before:border-t before:border-dashed before:border-border-seam after:flex-1 after:border-t after:border-dashed after:border-border-seam">
            {group.title} {dur(group.to - group.from)}
            {why === "" ? "" : ` · ${why}`}
          </div>,
        );
      continue;
    }
    const right = [group.shipped > 0 ? `${group.shipped} shipped` : "", group.troubled > 0 ? `${group.troubled} with problems` : "", why].filter((part) => part !== "").join(" · ");
    const byId = new Map(group.lines.map((line) => [line.id, line]));
    const list = ordered(items);
    const itemKeys = keysOf(list, (item) => (item.type === "chapter" ? chapterId(item) : `${item.type}-${item.at}`));
    rendered.push(
      <div key={key} data-group={group.title} className="mt-3.5">
        <GroupHead group={group} right={right} />
        <ul>
          {list.map((item, index) => (
            <StoryRow key={itemKeys[index]} item={item} lines={byId} open={open} onOpen={onOpen} hit={hit} onTicket={onTicket} />
          ))}
        </ul>
      </div>,
    );
  }
  return rendered.length === 0 ? <p className="py-4 text-sm text-[var(--loom-muted)]">{query.trim() === "" ? "Nothing happened in this stretch." : `Nothing matches “${query.trim()}”.`}</p> : <>{rendered}</>;
}

function StoryRow({ item, lines, open, onOpen, hit, onTicket }: { item: StoryItem; lines: Map<number, EventLine>; open: ReadonlySet<string>; onOpen(open: ReadonlySet<string>): void; hit: string | null; onTicket(key: string): void }) {
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onOpen(next);
  };
  if (item.type === "created") {
    const id = `created-${item.at}`;
    const shown = open.has(id);
    return (
      <Row data-story-created={String(item.tickets.length)} icon={<Icon {...NOTE_ICON.created} />} side={clock(item.at)}>
        <p className="text-sm">
          {plural(item.tickets.length, "ticket")} created <Words phrase={item.by} />
        </p>
        <p className="text-sm text-[var(--loom-muted)]">
          {item.tickets
            .slice(0, 6)
            .map((ticket) => ticket.key)
            .join(", ")}
          {item.tickets.length > 6 ? ` and ${item.tickets.length - 6} more` : ""}
        </p>
        {shown && (
          <ul className="mt-1.5 grid gap-1 border-l-2 border-border-seam pl-3">
            {item.tickets.map((ticket) => (
              <li key={ticket.key} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-xs">
                <button type="button" className={`${KEY_BUTTON} text-left`} onClick={() => onTicket(ticket.key)}>
                  {ticket.key}
                </button>
                <span>{ticket.title}</span>
              </li>
            ))}
          </ul>
        )}
        {item.tickets.length > 1 && (
          <button type="button" aria-expanded={shown} className="mt-1 inline-flex min-h-6 cursor-pointer items-center text-xs text-[var(--loom-muted)] hover:text-foreground @max-xl/loom:min-h-11 pointer-coarse:min-h-11" onClick={() => toggle(id)}>
            {shown ? "Hide the list" : "List them"}
          </button>
        )}
      </Row>
    );
  }
  if (item.type === "note") {
    return (
      <Row data-story-note={item.tone} icon={<Icon {...NOTE_ICON[item.tone]} />} side={clock(item.at)}>
        <p className="text-sm">
          <Words phrase={item.text} />
        </p>
      </Row>
    );
  }
  const id = chapterId(item);
  const shown = open.has(id);
  const steps = item.steps.flatMap((step) => lines.get(step) ?? []);
  return (
    <Row data-chapter={item.key} className={hit === item.key ? "rounded-md bg-primary/10 px-1" : ""} icon={<Icon {...TONE_ICON[item.tone]} />} side={<><span className="font-semibold text-foreground">{dur(item.ms)}</span><br />{clock(item.at)}</>}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <button type="button" className={KEY_BUTTON} onClick={() => onTicket(item.key)}>
          {item.key}
        </button>
        <span className="text-[13px]">{item.title}</span>
      </div>
      <p className="mt-0.5 text-[13px] text-[var(--loom-muted)]">
        <b className="font-semibold text-foreground">{item.head}.</b>{" "}
        {item.says.map((say, index) => (
          <span key={index}>
            {index > 0 ? " " : ""}
            <Words phrase={say} />
          </span>
        ))}
      </p>
      <LifeBar parts={item.parts} />
      {item.chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.chips.map((chip) => (
            <span key={chip.text} className={`${CHIP} ${CHIP_TONE[chip.tone]}`}>
              {chip.text}
            </span>
          ))}
        </div>
      )}
      {shown && (
        <ol data-chapter-steps className="mt-2 grid gap-1 border-l-2 border-border-seam pl-3">
          {steps.map((line) => (
            <li key={line.id} className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 text-xs">
              <time className="text-[var(--loom-muted)]" dateTime={new Date(line.at).toISOString()}>
                {clock(line.at)}
              </time>
              <span className={line.tone === "bad" ? "text-[var(--loom-bad)]" : line.tone === "back" ? "text-[var(--loom-warn)]" : line.you ? "font-semibold" : ""}>
                <Words phrase={line.text} />
              </span>
            </li>
          ))}
        </ol>
      )}
      {steps.length > 0 && (
        <button type="button" aria-expanded={shown} className="mt-1 inline-flex min-h-6 cursor-pointer items-center text-xs text-[var(--loom-muted)] hover:text-foreground @max-xl/loom:min-h-11 pointer-coarse:min-h-11" onClick={() => toggle(id)}>
          {shown ? "Hide the steps" : `Show ${plural(steps.length, "step")}`}
        </button>
      )}
    </Row>
  );
}

function LineGroups({ view, filter, ordered, matches, onTicket, query }: Helpers) {
  const rendered: ReactNode[] = [];
  const groups = ordered(view.groups);
  const keys = groupKeys(groups);
  for (const [index, group] of groups.entries()) {
    const lines = group.lines.filter((line) => (filter === "problems" ? line.problem : filter === "you" ? line.you : true)).filter((line) => matches(`${line.key ?? ""} ${textOf(line.text)}`, line.key));
    if (lines.length === 0) continue;
    rendered.push(
      <div key={keys[index]} data-group={group.title} className="mt-3.5">
        <GroupHead group={group} right={filter === "all" ? plural(lines.length, "event") : ""} />
        {filter === "all" ? (
          <ol>
            {ordered(lines).map((line, index, all) => {
              const same = index > 0 && clock(all[index - 1]!.at) === clock(line.at);
              return (
                <li key={line.id} data-line={line.id} className="grid grid-cols-[4.25rem_5rem_minmax(0,1fr)] gap-2 border-b border-border-seam/40 py-1 text-xs last:border-b-0">
                  <time className="text-[var(--loom-muted)]" dateTime={new Date(line.at).toISOString()}>
                    {same ? "" : clock(line.at)}
                  </time>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {line.key !== null && (
                      <button type="button" className={`${KEY_BUTTON} text-[11px] text-[var(--loom-muted)]`} onClick={() => onTicket(line.key!)}>
                        {line.key}
                      </button>
                    )}
                  </span>
                  <span className={line.problem ? "text-[var(--loom-bad)]" : line.you ? "font-semibold" : line.tone === "detail" ? "text-[var(--loom-muted)]" : ""}>
                    <Words phrase={line.text} />
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <ul>
            {ordered(lines).map((line) => (
              <Row key={line.id} data-line={String(line.id)} icon={<Icon {...(line.you ? NOTE_ICON.you : line.tone === "bad" ? NOTE_ICON.bad : NOTE_ICON.back)} />} side={clock(line.at)}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {line.key !== null && (
                    <button type="button" className={KEY_BUTTON} onClick={() => onTicket(line.key!)}>
                      {line.key}
                    </button>
                  )}
                  <span className="text-[13px]">
                    <Words phrase={line.text} />
                  </span>
                </div>
              </Row>
            ))}
          </ul>
        )}
      </div>,
    );
  }
  if (rendered.length > 0) return <>{rendered}</>;
  const empty = query.trim() !== "" ? `Nothing matches “${query.trim()}”.` : filter === "problems" ? "No problems in this stretch: nothing was sent back, blocked or failed." : filter === "you" ? "You did nothing in this stretch; Loom ran on its own." : "Nothing happened in this stretch.";
  return <p className="py-4 text-sm text-[var(--loom-muted)]">{empty}</p>;
}

// ---- the numbers

const TIME_WORD: Partial<Record<TicketState, string>> = { queued: "Waiting for a worker", working: "Being built", checking: "Running checks", review: "In review", approved: "Approved, waiting to merge", merging: "Merging", pr_open: "Pull request open", blocked: "Blocked" };
const TIME_ORDER: TicketState[] = ["queued", "working", "checking", "review", "approved", "merging", "pr_open", "blocked"];
const ROLE_FILL: Record<string, Swatch> = { worker: { fill: PRIMARY }, planner: { fill: SUCCESS_INK }, reviewer: { fill: WARN, hatch: true } };

function NumberCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-card={id} className={`${CARD} grid content-start gap-2`}>
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

const Big = ({ value, note }: { value: string; note: string }) => (
  <p className="text-xl leading-tight font-semibold">
    {value}
    <span className="ml-1.5 text-xs font-normal text-[var(--loom-muted)]">{note}</span>
  </p>
);
const Note = ({ children }: { children: ReactNode }) => <p className="text-[13px] text-[var(--loom-muted)] [&_b]:font-semibold [&_b]:text-foreground">{children}</p>;

function Numbers({ view, onFind, onLink }: { view: ProjectInsights; onFind(key: string): void; onLink(filter: InsightsFilter): void }) {
  const n = view.numbers;
  const stretch = view.range === null ? " yet" : " in this stretch";
  const toGoal = n.goal === "pr" ? "its pull request" : "shipping";
  return (
    <>
      <NumberCard id="cycle" title="How long does a ticket take?">
        {n.cycleP50 === null ? (
          <Note>No ticket has {n.goal === "pr" ? "reached a pull request" : "shipped"}{stretch}, so there is no time to show.</Note>
        ) : (
          <>
            <Big value={dur(n.cycleP50)} note="of work for a typical ticket" />
            <Dots cycle={n.cycle} p50={n.cycleP50} p85={n.cycleP85!} onFind={onFind} />
            <Note>
              Each dot is a ticket that {n.goal === "pr" ? "reached a pull request" : "shipped"}, from its first worker to {toGoal}. Half took under <b>{dur(n.cycleP50)}</b>; most (85%) under <b>{dur(n.cycleP85!)}</b>. Click a dot to find its story.
            </Note>
            {n.leadP50 !== null && (
              <Note>
                From being created to {toGoal}, a typical ticket took <b>{dur(n.leadP50)}</b>, most under {dur(n.leadP85!)}.
              </Note>
            )}
          </>
        )}
      </NumberCard>
      <TimeCard n={n} />
      {n.firstTry.length > 0 && (
        <NumberCard id="first-try" title="How often is the first try right?">
          <Big value={pct(n.firstTry.filter((entry) => entry.clean).length / n.firstTry.length)} note="passed their first review" />
          <div className="flex flex-wrap">
            {[...n.firstTry]
              .sort((a, b) => Number(b.clean) - Number(a.clean) || a.rounds - b.rounds || a.key.localeCompare(b.key))
              .map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  data-first-try={entry.key}
                  aria-label={`${entry.key}: ${entry.clean ? "passed its first review" : `needed ${plural(entry.rounds, "review round")}`}`}
                  title={`${entry.key}: ${entry.clean ? "passed its first review" : `needed ${plural(entry.rounds, "review round")}`}`}
                  className="grid size-6 cursor-pointer place-items-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => onFind(entry.key)}
                >
                  {/* More than one fix is a ring round a dot rather than a red edge, which measured 1.0 to 1.9:1 on its fill:
                      the shape tells it apart, and its orange is 3:1 or more on the card. */}
                  <span
                    aria-hidden
                    data-mark={entry.clean ? "clean" : entry.rounds > 2 ? "fixes" : "fix"}
                    className="size-3.5 rounded-sm"
                    style={entry.clean || entry.rounds <= 2 ? { background: entry.clean ? SUCCESS_INK : WARN } : { background: `radial-gradient(circle, ${WARN} 0 2.5px, transparent 3px)`, boxShadow: `inset 0 0 0 2px ${WARN}` }}
                  />
                </button>
              ))}
          </div>
          <Note>
            <b>{n.firstTry.filter((entry) => entry.clean).length}</b> passed on the first try;{" "}
            <button type="button" className={LINK} onClick={() => onLink("problems")}>
              {n.firstTry.filter((entry) => !entry.clean).length} needed a fix
            </button>
            {n.firstTry.some((entry) => entry.rounds > 2) ? ", a ringed one for more than one" : ""}. Reviewers wrote <b>{plural(n.findings.total, "finding")}</b>
            {n.findings.total > 0 ? `, ${n.findings.blocking === n.findings.total ? "all" : n.findings.blocking} blocking` : ""}.
          </Note>
          {(n.text.reviews > 0 || n.text.sentBack > 0) && (
            <Note>
              Text reviews judged <b>{plural(n.text.reviews, "change")}</b> to a pull request&apos;s title or description alone, with no checks and no code review; <b>{plural(n.text.sentBack, "round")}</b> went back to the worker for its text only.
            </Note>
          )}
          <Note>
            {n.checks.runs === 0 ? "No check has run." : n.checks.failed === 0 ? `Checks passed all ${n.checks.runs} runs.` : <>Checks failed <b>{n.checks.failed} of {n.checks.runs}</b> runs.</>}
            {n.prFeedback > 0 && (
              <>
                {" "}
                Pull request feedback started <b>{plural(n.prFeedback, "fix round")}</b>.
              </>
            )}
          </Note>
        </NumberCard>
      )}
      <CostCard n={n} ranged={view.range !== null} onFind={onFind} />
      <NumberCard id="you" title="When did you step in?">
        {n.you.length === 0 ? (
          <Note>You did nothing{stretch}: Loom ran on its own.</Note>
        ) : (
          <>
            <ul className="grid gap-1 text-xs">
              {n.you.slice(-8).map((line) => (
                <li key={line.id} className="flex justify-between gap-3">
                  <span className="min-w-0">{textOf(line.text.map((part) => (typeof part === "object" && "quote" in part ? "" : part))).replace(/: $/, ".")}</span>
                  <span className="whitespace-nowrap text-[var(--loom-muted)]">{sameDay(line.at, n.you[0]!.at) ? clock(line.at) : dated(line.at)}</span>
                </li>
              ))}
            </ul>
            {n.you.length > 8 && <Note>And {plural(n.you.length - 8, "earlier one")}.</Note>}
            <Note>
              {n.interventions === 0 ? "Only the start and the first approval, which every project needs." : <><b>{plural(n.interventions, "time")}</b> beyond the start and the first approval.</>}{" "}
              <button type="button" className={LINK} onClick={() => onLink("you")}>
                Show them in the story
              </button>
            </Note>
          </>
        )}
      </NumberCard>
      <WrongCard n={n} onLink={onLink} />
      {n.checks.commands.length > 0 && (
        <details data-card="checks" className={CARD}>
          <summary className="cursor-pointer text-[13px] font-semibold">Checks by command</summary>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-[var(--loom-muted)]">
              <tr>
                <th className="py-1 pr-2 font-normal">Command</th>
                <th className="py-1 pr-2 text-right font-normal">Runs</th>
                <th className="py-1 pr-2 text-right font-normal">Failed</th>
                <th className="py-1 text-right font-normal">Typical</th>
              </tr>
            </thead>
            <tbody>
              {n.checks.commands.map((command) => (
                <tr key={command.command} className="border-t border-border-seam align-top">
                  <td className="py-1 pr-2">
                    <code className={CODE}>{command.command}</code>
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">{command.runs}</td>
                  <td className={`py-1 pr-2 text-right tabular-nums ${command.failed > 0 ? "font-semibold text-[var(--loom-bad)]" : ""}`}>{command.failed}</td>
                  <td className="py-1 text-right whitespace-nowrap tabular-nums">{command.p50Ms === null ? "—" : dur(command.p50Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

/**
 * Each ticket's time of work as a dot. The strip is one control, so crowded dots never make targets too small to hit:
 * a click finds the nearest dot's story, and with focus on the strip, Left and Right pick a dot and Enter finds it.
 */
function Dots({ cycle, p50, p85, onFind }: { cycle: InsightsNumbers["cycle"]; p50: number; p85: number; onFind(key: string): void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const most = Math.max(1, ...cycle.map((entry) => entry.ms));
  const left = (ms: number) => 3 + (ms / most) * 94;
  // Close marks put their labels on either side of their lines, so the two words do not overlap.
  const close = p85 !== p50 && left(p85) - left(p50) < 8;
  const stacked = new Map<number, number>();
  const order = [...cycle].sort((a, b) => a.ms - b.ms);
  const current = picked === null ? null : (order[picked] ?? null);
  const nearest = (event: MouseEvent): string | null => {
    const own = (event.target as Element).getAttribute?.("data-cycle-dot");
    if (own) return own;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 || order.length === 0) return null;
    const at = ((event.clientX - rect.left) / rect.width) * 100;
    return order.reduce((best, entry) => (Math.abs(left(entry.ms) - at) < Math.abs(left(best.ms) - at) ? entry : best)).key;
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (order.length === 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      setPicked(picked === null ? (step > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, picked + step)));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setPicked(event.key === "Home" ? 0 : order.length - 1);
    } else if ((event.key === "Enter" || event.key === " ") && current !== null) {
      event.preventDefault();
      onFind(current.key);
    }
  };
  return (
    <div
      data-cycle-dots
      role="group"
      tabIndex={0}
      aria-label={`Time of work per ticket, ${plural(cycle.length, "ticket")}. Left and Right pick a ticket, Enter finds its story.`}
      className="relative h-14 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onKeyDown={onKey}
      onBlur={() => setPicked(null)}
      onClick={(event) => {
        const key = nearest(event.nativeEvent);
        if (key !== null) onFind(key);
      }}
    >
      {[
        { ms: p50, label: "half", side: close ? "-translate-x-full pr-0.5" : "-translate-x-1/2" },
        ...(p85 === p50 ? [] : [{ ms: p85, label: "most", side: close ? "pl-0.5" : "-translate-x-1/2" }]),
      ].map((mark) => (
        <span key={mark.label} aria-hidden>
          <span className="absolute top-0 bottom-4 border-l border-dashed border-foreground/40" style={{ left: `${left(mark.ms)}%` }} />
          <span data-cycle-mark={mark.label} className={`absolute bottom-0 ${mark.side} text-[11px] leading-4 text-[var(--loom-muted)]`} style={{ left: `${left(mark.ms)}%` }}>
            {mark.label}
          </span>
        </span>
      ))}
      {cycle.map((entry) => {
        const bin = Math.round(left(entry.ms) / 3);
        const row = stacked.get(bin) ?? 0;
        stacked.set(bin, row + 1);
        const on = current?.key === entry.key;
        return (
          <span
            key={entry.key}
            data-cycle-dot={entry.key}
            title={`${entry.key}: ${dur(entry.ms)} of work`}
            className={`absolute size-2 -translate-x-1/2 rounded-full ${on ? "scale-150 ring-2 ring-ring" : ""}`}
            style={{ left: `${left(entry.ms)}%`, bottom: `${18 + Math.min(row, 4) * 7}px`, background: SUCCESS_INK }}
          />
        );
      })}
      <p aria-live="polite" className="sr-only">
        {current === null ? "" : `${current.key}: ${dur(current.ms)} of work`}
      </p>
    </div>
  );
}

function TimeCard({ n }: { n: InsightsNumbers }) {
  const total = TIME_ORDER.reduce((sum, state) => sum + (n.time[state] ?? 0), 0);
  if (total === 0 || n.reached === 0) return null;
  const share = (state: TicketState) => (n.time[state] ?? 0) / total;
  // A state with under half a percent of the time would read as 0%, so it is left out.
  const states = TIME_ORDER.filter((state) => share(state) >= 0.005);
  const top = states.reduce((best, state) => (share(state) > share(best) ? state : best), states[0]!);
  const insight =
    share("blocked") > 0.2
      ? `Blocked tickets took ${pct(share("blocked"))} of the time: they waited for someone to answer them or to fix what blocked them.`
      : top === "queued" && share("queued") > 0.5
        ? `Tickets spent most of their life waiting for a free worker. This spec runs at most ${plural(n.maxWorkers, "worker")} at once, and a ticket also waits for the tickets it depends on.`
        : top === "review"
          ? "Review took the most time. More reviewers, or smaller tickets, would finish sooner."
          : top === "working"
            ? "Most of the time went into building, which is the useful part."
            : null;
  const label = `Where the time goes: ${states.map((state) => `${TIME_WORD[state]} ${pct(share(state))}`).join(", ")}`;
  return (
    <NumberCard id="time" title="Where does a ticket's time go?">
      <div role="img" aria-label={label} className={`${SHARE_TRACK} h-2.5`}>
        {states.map((state) => (
          <span key={state} title={`${TIME_WORD[state]} ${pct(share(state))}`} className={SHARE_PART} style={{ width: `${share(state) * 100}%`, ...markStyle(STATE_COLORS[state]) }} />
        ))}
      </div>
      <ul className="grid gap-0.5 text-xs">
        {states.map((state) => (
          <li key={state} className="grid grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-sm" style={markStyle(STATE_COLORS[state])} />
            <span>{TIME_WORD[state]}</span>
            <span className="text-[var(--loom-muted)] tabular-nums">
              {pct(share(state))} · {dur((n.time[state] ?? 0) / n.reached)} each
            </span>
          </li>
        ))}
      </ul>
      {insight !== null && <p className="rounded-md border border-primary/50 bg-primary/5 px-2.5 py-1.5 text-xs">{insight}</p>}
      {n.prWait.p50 !== null && (
        <Note>
          After that, pull requests waited on people for a typical <b>{dur(n.prWait.p50)}</b>, the longest {dur(n.prWait.max!)}.
        </Note>
      )}
      <p className="text-[11px] text-[var(--loom-muted)]">
        Over the {plural(n.reached, "ticket")} that {n.goal === "pr" ? "reached a pull request" : "shipped"}, from being created to {n.goal === "pr" ? "the pull request" : "shipping"}.
      </p>
    </NumberCard>
  );
}

function CostCard({ n, ranged, onFind }: { n: InsightsNumbers; ranged: boolean; onFind(key: string): void }) {
  const t = n.tokens;
  if (t.total === 0) return null;
  const roles = (["worker", "planner", "reviewer"] as const).filter((role) => t.byRole[role] > 0);
  const top = Math.max(1, ...t.byTicket.map((entry) => entry.tokens));
  return (
    <NumberCard id="cost" title="What did it cost?">
      <Big value={big(t.total)} note={`tokens${t.perReached === null ? "" : `, about ${big(Math.round(t.perReached))} per ${n.goal === "pr" ? "pull request" : "shipped ticket"}`}`} />
      {t.budget !== null && (
        <Note>
          <b>{pct(t.total / t.budget)}</b> of the {big(t.budget)} token budget.
        </Note>
      )}
      <div role="img" aria-label={`Tokens by role: ${roles.map((role) => `${role}s ${pct(t.byRole[role] / t.total)}`).join(", ")}`} className={`${SHARE_TRACK} h-2.5`}>
        {roles.map((role) => (
          <span key={role} className={SHARE_PART} style={{ width: `${(t.byRole[role] / t.total) * 100}%`, ...markStyle(ROLE_FILL[role]!) }} />
        ))}
      </div>
      <ul className="grid gap-0.5 text-xs">
        {roles.map((role) => (
          <li key={role} className="grid grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-sm" style={markStyle(ROLE_FILL[role]!)} />
            <span>{cap(role)}s</span>
            <span className="text-[var(--loom-muted)] tabular-nums">
              {big(t.byRole[role])} · {pct(t.byRole[role] / t.total)}
            </span>
          </li>
        ))}
      </ul>
      {t.byTicket.length > 0 && (
        <>
          <h4 className={HEADING}>Costliest tickets</h4>
          <ul className="grid gap-1">
            {t.byTicket.map((entry) => (
              <li key={entry.key} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3rem] items-center gap-2 text-xs">
                <button type="button" className={`${KEY_BUTTON} text-left`} onClick={() => onFind(entry.key)}>
                  {entry.key}
                </button>
                <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-state-hover">
                  <span className="block h-full rounded-full" style={{ width: `${(entry.tokens / top) * 100}%`, background: PRIMARY }} />
                </span>
                <span className="text-right text-[var(--loom-muted)] tabular-nums">{big(entry.tokens)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-[11px] text-[var(--loom-muted)]">
        {ranged ? "For the whole project: Loom keeps one total per thread. " : ""}Read from bb as each turn ends{t.unreported > 0 ? `; ${plural(t.unreported, "thread")} reported no usage, so the real total is higher` : ""}.
      </p>
    </NumberCard>
  );
}

function WrongCard({ n, onLink }: { n: InsightsNumbers; onLink(filter: InsightsFilter): void }) {
  const w = n.wrong;
  const why = [w.byReview > 0 ? `${w.byReview} by review` : "", w.byChecks > 0 ? `${w.byChecks} by checks` : "", w.byMerge > 0 ? `${w.byMerge} by a failed merge` : "", w.byPr > 0 ? `${w.byPr} by pull request feedback` : ""].filter((part) => part !== "");
  const rows: Array<[string, number | null]> = [
    [`Sent back to the worker${why.length === 0 ? "" : ` (${why.join(", ")})`}`, w.sentBack],
    ["Blocked", w.blocked],
    ["Merges that failed", w.mergesFailed],
    ["Rate-limit retries", w.retries],
    ["Checks that found files outside the ticket's scope", w.outside],
    ["Worker attempts that failed", w.failedAttempts],
    ["Workers that timed out", w.timeouts],
  ];
  const shown = rows.filter((row): row is [string, number] => row[1] !== null);
  const any = shown.some(([, value]) => value > 0);
  return (
    <NumberCard id="wrong" title="Did anything go wrong?">
      {!any && <Note><b>Nothing went wrong.</b></Note>}
      <ul className="grid gap-0.5 text-xs">
        {shown.map(([label, value]) => (
          <li key={label} className={`flex justify-between gap-3 ${value === 0 ? "text-[var(--loom-muted)]" : ""}`}>
            <span>{label}</span>
            <span className={`tabular-nums ${value === 0 ? "" : "font-semibold"}`}>{value === 0 ? "none" : value}</span>
          </li>
        ))}
      </ul>
      {any && (
        <p className="text-[13px]">
          <button type="button" className={LINK} onClick={() => onLink("problems")}>
            Show the problems in the story
          </button>
        </p>
      )}
    </NumberCard>
  );
}
