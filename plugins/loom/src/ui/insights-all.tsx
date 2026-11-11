// Insights across projects: five figures, done per week as small multiples on one shared axis (one row per project,
// labelled, so no series hangs on a shade), done per day with a range to count, and tables by project, model and repo.
// One project chosen is the same page at a project's scope. The server pools cycle times before their percentiles.
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { InsightsAllView, InsightsFigures, InsightsProjectRow } from "../contract";
import { compactCount, formatDuration, plural } from "../format";
import { BUTTON, TAP, useLoom } from "./common";
import { ModelName } from "./model-name";
import { createStored, useStored } from "./remember";

export const insightsWeeks = createStored<4 | 12>("insightsWeeks", 4, (value) => (value === 4 || value === 12 ? value : null));
export const insightsScope = createStored<readonly string[]>("insightsScope", [], (value) => (Array.isArray(value) && value.every((one) => typeof one === "string") ? value : null));

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayText = (at: number) => `${MONTHS[new Date(at).getUTCMonth()]} ${new Date(at).getUTCDate()}`;
const spanText = (from: number, to: number) => (dayText(from) === dayText(to) ? dayText(from) : `${dayText(from)} to ${dayText(to)}`);
const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
// Past ten minutes the seconds say nothing, so they are rounded away.
const dur = (ms: number | null) => (ms === null ? "—" : formatDuration(ms >= 600_000 ? Math.round(ms / 60_000) * 60_000 : ms));
const rounds = (mean: number | null) => (mean === null ? "—" : mean.toFixed(1));
const tokens = (n: number) => (n === 0 ? "0" : compactCount(Math.round(n)));
/** A token count that never shows an unknown as zero: "—" when no thread started, "not recorded" when none reported. */
const tokenText = (value: number, threads: number, unreported: number) => (threads === 0 ? "—" : unreported >= threads ? "not recorded" : tokens(value));

function TokenCell({ value, threads, unreported }: { value: number; threads: number; unreported: number }) {
  return (
    <td className={`${TD} ${NUM}`} data-tokens-cell={unreported > 0 ? `${unreported} unreported` : undefined}>
      {tokenText(value, threads, unreported)}
      {unreported > 0 && unreported < threads && <span className="block text-[11px] text-[var(--loom-muted)]">{unreported} unreported</span>}
    </td>
  );
}
const SEG = "inline-flex flex-wrap gap-0.5 rounded-md border border-[var(--loom-line)] p-0.5";
const segButton = (on: boolean) => `inline-flex h-7 cursor-pointer items-center justify-center gap-1 rounded px-2 @max-xl/loom:min-w-11 pointer-coarse:min-w-11 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP} ${on ? "bg-[var(--loom-sel)] font-semibold text-foreground" : "text-[var(--loom-muted)] hover:text-foreground"}`;
const TH = "py-1.5 pr-3 text-left text-[11px] font-semibold text-[var(--loom-muted)]";
const TD = "py-1.5 pr-3 align-middle";
const NUM = "loom-num text-right";

function Figure({ icon, value, label, note, tone, children }: { icon: string; value: string; label: string; note?: ReactNode; tone?: "ok" | "att"; children?: ReactNode }) {
  return (
    <div data-figure={label} className="loom-card flex min-w-0 flex-col gap-0.5 rounded-md px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-xs text-[var(--loom-muted)]">
        <Icon name={icon} className={`size-3.5 ${tone === "ok" ? "text-[var(--loom-ok)]" : tone === "att" ? "text-[var(--attention)]" : ""}`} aria-hidden />
        {label}
      </dt>
      <dd className="loom-num text-2xl leading-tight font-semibold">{value}</dd>
      <dd className="flex min-w-0 items-center gap-2 text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">
        {children}
        {note}
      </dd>
    </div>
  );
}

/** A trend beside a number: a line with no axes, its values in its name. */
function Spark({ values, label, width = 56, height = 18 }: { values: readonly number[]; label: string; width?: number; height?: number }) {
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => `${values.length > 1 ? (index / (values.length - 1)) * (width - 2) + 1 : width / 2},${height - 2 - (value / max) * (height - 4)}`).join(" ");
  return (
    <svg role="img" aria-label={`${label}: ${values.join(", ")}`} viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="shrink-0">
      <polyline points={points} fill="none" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: "var(--loom-ink)" }} />
    </svg>
  );
}

function Figures({ view }: { view: InsightsAllView }) {
  const t = view.totals;
  const weekly = view.weekStarts.map((_, index) => view.projects.reduce((sum, row) => sum + row.weekly[index]!, 0) + (view.finished?.weekly[index] ?? 0));
  const delta = t.done - t.donePrevious;
  return (
    <dl data-insights-figures className="grid grid-cols-5 gap-2 @max-5xl/loom:grid-cols-3 @max-xl/loom:grid-cols-2">
      <Figure icon="CircleCheck" tone="ok" value={String(t.done)} label="Done" note={`${delta >= 0 ? "+" : "−"}${Math.abs(delta)} on the ${view.range === null ? `${view.weeks} weeks` : "stretch"} before`}>
        {view.range === null && <Spark values={weekly} label="Done per week" />}
      </Figure>
      <Figure icon="Clock" value={dur(t.cycle.p50)} label="Median cycle" note={t.cycle.p85 === null ? "no ticket done" : `p85 ${dur(t.cycle.p85)} · ${plural(t.cycle.n, "ticket")}`} />
      <Figure icon="RotateCcw" value={rounds(t.rounds.mean)} label="Review rounds" note={t.firstPass.rate === null ? "per ticket done" : `${pct(t.firstPass.rate)} first time`} />
      <Figure icon="OctagonAlert" tone={t.blockedMs > 0 ? "att" : undefined} value={t.blockedMs === 0 ? "0" : dur(t.blockedMs)} label="Blocked" note={t.longest === null ? "nothing blocked" : `${dur(t.longest.ms)} on ${t.longest.key}`} />
      <Figure
        icon="Coins"
        value={tokenText(t.tokens, t.threads, t.unreported)}
        label="Tokens, threads started"
        note={
          <span data-cost-unrecorded>
            {t.perDone === null ? "" : `${tokens(t.perDone)} per done · `}
            {t.unreported > 0 && t.unreported < t.threads && <span data-tokens-unreported className="text-[var(--loom-warn)]">{`${t.unreported} of ${plural(t.threads, "thread")} unreported · `}</span>}
            cost not recorded yet
          </span>
        }
      />
    </dl>
  );
}

const LABEL_W = 72;
const TOTAL_W = 32;
/** Row height: the rows share about 150 px, at least 26 and at most 44 each. */
const multipleHeight = (rows: number) => Math.max(26, Math.min(44, Math.floor(150 / Math.max(1, rows))));

/**
 * Done per week, one row per project on one shared scale: each project's bars are drawn in its own row with its key beside
 * them, so neighbouring series never meet and none is told apart by a shade (defect A7).
 */
function WeeklyMultiples({ view }: { view: InsightsAllView }) {
  // Drawn at the pixel width it has, so its 11 px labels stay 11 px on a phone instead of shrinking with a viewBox.
  const box = useRef<HTMLElement>(null);
  const [W, setW] = useState(520);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const measure = () => setW(Math.max(260, Math.round(element.clientWidth || 520)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rows = [...view.projects.map((row) => ({ id: row.slug, label: row.key, name: row.name, weekly: row.weekly })), ...(view.finished === null ? [] : [{ id: "_finished", label: "Finished", name: `${plural(view.finished.count, "finished project")}`, weekly: view.finished.weekly }])];
  const max = Math.max(1, ...rows.flatMap((row) => row.weekly));
  const weeks = view.weekStarts.length;
  const plot = W - LABEL_W - TOTAL_W;
  const bw = plot / weeks;
  if (rows.length === 0)
    return (
      <figure ref={box}>
        <p className="py-6 text-center text-sm text-[var(--loom-muted)]">No project in scope</p>
      </figure>
    );
  const MULT_H = multipleHeight(rows.length);
  const H = rows.length * MULT_H + 18;
  // A count of one stays visible beside a count of forty, and every bar wide enough says its count.
  const barH = (value: number) => Math.max(2, (value / max) * (MULT_H - 18));
  const labelled = bw >= 28;
  return (
    <figure ref={box} data-weekly-multiples>
      <svg role="img" aria-label={`Done per week by project, ${weeks} weeks on one scale of 0 to ${max}. ${rows.map((row) => `${row.label}: ${row.weekly.join(", ")}`).join(". ")}.`} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full">
        {rows.map((row, r) => {
          const top = r * MULT_H;
          const base = top + MULT_H - 4;
          return (
            <g key={row.id} data-multiple={row.label}>
              <title>{`${row.name}: ${row.weekly.join(", ")} done per week`}</title>
              <text x={0} y={base - 4} fontSize={11} fontWeight={600} style={{ fill: "var(--loom-ink)" }}>
                {row.label}
              </text>
              <line x1={LABEL_W} x2={LABEL_W + plot} y1={base + 0.5} y2={base + 0.5} strokeWidth={1} style={{ stroke: "var(--loom-line)" }} />
              {row.weekly.map((value, index) =>
                value === 0 ? null : (
                  <g key={index}>
                    <rect x={LABEL_W + index * bw + bw * 0.18} y={base - barH(value)} width={bw * 0.64} height={barH(value)} rx={1} style={{ fill: "var(--loom-ink)" }} />
                    {labelled && (
                      <text x={LABEL_W + index * bw + bw / 2} y={base - barH(value) - 3} fontSize={11} textAnchor="middle" className="loom-num" style={{ fill: "var(--loom-muted)" }}>
                        {value}
                      </text>
                    )}
                  </g>
                ),
              )}
              <text x={W} y={base - 4} fontSize={11} fontWeight={600} textAnchor="end" className="loom-num" style={{ fill: "var(--loom-ink)" }}>
                {row.weekly.reduce((a, b) => a + b, 0)}
              </text>
            </g>
          );
        })}
        {[0, weeks - 1].map((index) => (
          <text key={index} x={LABEL_W + index * bw + (index === 0 ? 0 : bw)} y={H - 4} fontSize={11} textAnchor={index === 0 ? "start" : "end"} style={{ fill: "var(--loom-muted)" }}>
            {index === 0 ? `week of ${dayText(view.weekStarts[0]!)}` : "this week"}
          </text>
        ))}
      </svg>
      <figcaption className="mt-1 text-[11px] text-[var(--loom-muted)]">One scale for every row · tallest {max} a week</figcaption>
    </figure>
  );
}

const DAY_H = 150;
const PAD_L = 26;
const PAD_B = 20;

/** Done per day: arrows pick a day, Shift with an arrow keeps the anchor and extends, Enter counts that stretch, Escape the whole window. */
function DailyChart({ view, onRange }: { view: InsightsAllView; onRange(range: { from: number; to: number } | null): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [cursor, setCursorState] = useState<{ anchor: number; at: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [said, setSaid] = useState("");
  const cursorRef = useRef<{ anchor: number; at: number } | null>(null);
  const setCursor = (next: { anchor: number; at: number } | null) => {
    cursorRef.current = next;
    setCursorState(next);
  };
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const measure = () => setWidth(Math.max(280, Math.round(element.clientWidth || 560)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const data = view.daily;
  const n = data.length;
  const max = Math.max(1, ...data);
  const bw = (width - PAD_L) / n;
  const y = (value: number) => DAY_H - PAD_B - (value / max) * (DAY_H - PAD_B - 10);
  const range = view.range;
  const inRange = (index: number) => range !== null && view.dayStarts[index]! + DAY > range.from && view.dayStarts[index]! <= range.to;
  const marked = drag ?? (cursor === null ? null : { a: cursor.anchor, b: cursor.at });
  const inMarked = (index: number) => marked !== null && index >= Math.min(marked.a, marked.b) && index <= Math.max(marked.a, marked.b);
  const shown = hover ?? cursor?.at ?? null;
  const choose = (a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const next = { from: view.dayStarts[lo]!, to: Math.min(view.dayStarts[hi]! + DAY - 1, view.now) };
    const same = range !== null && range.from === next.from && range.to === next.to;
    setSaid(same ? "Counting the whole window." : `Counting ${spanText(next.from, next.to)}.`);
    onRange(same ? null : next);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = cursorRef.current;
    const at = current?.at ?? null;
    const move = (next: number) => {
      const clamped = Math.max(0, Math.min(n - 1, next));
      setHover(null);
      setCursor({ anchor: event.shiftKey && current !== null ? current.anchor : clamped, at: clamped });
      setSaid("");
      event.preventDefault();
    };
    if (event.key === "ArrowLeft") move(at === null ? n - 1 : at - 1);
    else if (event.key === "ArrowRight") move(at === null ? 0 : at + 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(n - 1);
    else if ((event.key === "Enter" || event.key === " ") && current !== null) {
      choose(current.anchor, current.at);
      event.preventDefault();
    } else if (event.key === "Escape" && (range !== null || current !== null)) {
      if (range !== null) onRange(null);
      setCursor(null);
      setSaid("Counting the whole window.");
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const indexAt = (event: ReactPointerEvent<SVGSVGElement>): number | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) {
      const own = (event.target as Element).getAttribute?.("data-day");
      return own === null || own === undefined ? null : Number(own);
    }
    const x = ((event.clientX - rect.left) / rect.width) * width - PAD_L;
    const index = Math.floor(x / bw);
    return index < 0 || index >= n ? null : index;
  };
  const tip = shown === null ? null : { index: shown, at: view.dayStarts[shown]!, value: data[shown]! };
  const markedSum = marked === null ? null : data.slice(Math.min(marked.a, marked.b), Math.max(marked.a, marked.b) + 1).reduce((a, b) => a + b, 0);
  const grid = [...new Set([0, Math.round(max / 2), max])];
  return (
    <div
      ref={box}
      data-daily-chart
      tabIndex={0}
      role="group"
      aria-label={`Done per day, ${n} days. Arrows pick a day, Shift with an arrow picks several, Enter counts only that stretch, Escape counts the whole window.`}
      aria-keyshortcuts="ArrowLeft ArrowRight Home End Shift+ArrowLeft Shift+ArrowRight Enter Escape"
      className="relative rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onKeyDown={onKey}
      onBlur={() => setCursor(null)}
    >
      <svg
        role="img"
        aria-label={`Done per day from ${dayText(view.dayStarts[0]!)} to today, ${data.reduce((a, b) => a + b, 0)} in all`}
        viewBox={`0 0 ${width} ${DAY_H}`}
        height={DAY_H}
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
          if (drag !== null && (event.buttons & 1) === 0) setDrag(null);
          else if (drag !== null && index !== null) setDrag({ ...drag, b: index });
        }}
        onPointerUp={(event) => {
          if (drag !== null) choose(drag.a, drag.b);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => drag === null && setHover(null)}
      >
        {grid.map((value) => (
          <g key={value}>
            <line x1={PAD_L} x2={width} y1={y(value)} y2={y(value)} strokeDasharray={value === 0 ? undefined : "3 3"} strokeWidth={1} style={{ stroke: "var(--loom-line)" }} />
            <text x={PAD_L - 6} y={y(value) + 4} textAnchor="end" fontSize={11} className="loom-num" style={{ fill: "var(--loom-muted)" }}>
              {value}
            </text>
          </g>
        ))}
        {data.map((value, index) => (
          <g key={index} data-day={index}>
            {(inRange(index) || inMarked(index)) && <rect data-day-selected x={PAD_L + index * bw} y={0} width={bw} height={DAY_H - PAD_B} style={{ fill: "var(--loom-sel)" }} />}
            {value > 0 && <rect x={PAD_L + index * bw + Math.min(2, bw * 0.15)} y={y(value)} width={Math.max(1, bw - 2 * Math.min(2, bw * 0.15))} height={y(0) - y(value)} rx={1} style={{ fill: "var(--loom-ink)" }} />}
            {shown === index && <rect x={PAD_L + index * bw} y={0} width={bw} height={DAY_H - PAD_B} fill="none" strokeWidth={1.5} style={{ stroke: "var(--primary)" }} />}
          </g>
        ))}
        {[0, Math.floor(n / 2), n - 1].map((index) => (
          <text key={index} x={index === n - 1 ? width : index === 0 ? PAD_L : PAD_L + index * bw + bw / 2} y={DAY_H - 4} fontSize={11} textAnchor={index === n - 1 ? "end" : index === 0 ? "start" : "middle"} style={{ fill: "var(--loom-muted)" }}>
            {index === n - 1 ? "today" : dayText(view.dayStarts[index]!)}
          </text>
        ))}
      </svg>
      {tip !== null && (
        <div data-daily-tip className="pointer-events-none absolute top-1 z-10 rounded-md border border-[var(--loom-line)] bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md" style={{ left: Math.min(Math.max(0, PAD_L + tip.index * bw + bw + 4), Math.max(0, width - 150)) }}>
          <p className="font-semibold">{dayText(tip.at)}</p>
          <p className="loom-num">{plural(tip.value, "ticket")} done</p>
          {marked !== null && marked.a !== marked.b && markedSum !== null && <p className="loom-num text-[var(--loom-muted)]">{`${spanText(view.dayStarts[Math.min(marked.a, marked.b)]!, view.dayStarts[Math.max(marked.a, marked.b)]!)}: ${markedSum}`}</p>}
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {said !== "" ? said : tip !== null && cursor !== null ? `${dayText(tip.at)}: ${plural(tip.value, "ticket")} done.` : ""}
      </p>
    </div>
  );
}

function ProjectRow({ row, label, onOpen }: { row: InsightsFigures & { weekly: number[] }; label: ReactNode; onOpen?(): void }) {
  return (
    <tr className="border-t border-[var(--loom-line)]">
      <td className={`${TD} font-semibold`}>{onOpen === undefined ? label : (
        <button type="button" className={`cursor-pointer rounded text-left hover:text-[var(--loom-link)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP} @max-xl/loom:min-w-11 max-[576px]:min-w-11 pointer-coarse:min-w-11`} onClick={onOpen}>
          {label}
        </button>
      )}</td>
      <td className={TD}>
        <Spark values={row.weekly} label="Done per week" />
      </td>
      <td className={`${TD} ${NUM}`}>{row.done}</td>
      <td className={`${TD} ${NUM}`}>{dur(row.cycle.p50)}</td>
      <td className={`${TD} ${NUM}`}>{rounds(row.rounds.mean)}</td>
      <td className={`${TD} ${NUM}`}>{pct(row.firstPass.rate)}</td>
      <td className={`${TD} ${NUM}`}>{row.blockedMs === 0 ? "—" : dur(row.blockedMs)}</td>
      <TokenCell value={row.tokens} threads={row.threads} unreported={row.unreported} />
      <td className={`${TD} ${NUM}`}>{row.perDone === null ? "—" : tokens(row.perDone)}</td>
    </tr>
  );
}

function Section({ title, count, children, side }: { title: string; count?: number; children: ReactNode; side?: ReactNode }) {
  return (
    <section aria-label={title} className="loom-card min-w-0 rounded-md px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {count !== undefined && <span className="loom-num rounded-sm border border-[var(--loom-line)] px-1 text-[11px] leading-4">{count}</span>}
        {side !== undefined && <span className="ml-auto">{side}</span>}
      </div>
      {children}
    </section>
  );
}

const REPOS_SHOWN = 6;

function Tables({ view, go }: { view: InsightsAllView; go?(slug: string): void }) {
  const [allRepos, setAllRepos] = useState(false);
  const repos = allRepos ? view.byRepo : view.byRepo.slice(0, REPOS_SHOWN);
  return (
    <>
      <Section title="By project" count={view.projects.length + (view.finished === null ? 0 : 1)}>
        <div className="overflow-x-auto">
          <table data-insights-projects className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr>
                {["Project", "Trend", "Done", "Cycle", "Rounds", "First time", "Blocked", "Tokens", "Per done"].map((head, index) => (
                  <th key={head} scope="col" className={`${TH} ${index >= 2 ? "text-right" : ""}`}>
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.projects.map((row: InsightsProjectRow) => (
                <ProjectRow key={row.slug} row={row} label={<span title={row.name}>{row.key}</span>} onOpen={go === undefined ? undefined : () => go(row.slug)} />
              ))}
              {view.finished !== null && <ProjectRow row={view.finished} label={`Finished · ${view.finished.count}`} />}
            </tbody>
          </table>
        </div>
      </Section>
      <div className="grid gap-3 @5xl/loom:grid-cols-2">
        <Section title="By model" count={view.byModel.length}>
          <table data-insights-models className="w-full text-[13px]">
            <thead>
              <tr>
                {["Model", "Role", "Threads", "Tokens", "First time"].map((head, index) => (
                  <th key={head} scope="col" className={`${TH} ${index >= 2 ? "text-right" : ""}`}>
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.byModel.map((row) => (
                <tr key={`${row.model ?? "none"} ${row.role}`} data-model-row={row.model ?? "unrecorded"} className="border-t border-[var(--loom-line)]">
                  <td className={TD}>
                    {row.model === null ? (
                      <span className="text-[var(--loom-muted)]">not recorded</span>
                    ) : (
                      <ModelName model={row.model} />
                    )}
                  </td>
                  <td className={`${TD} capitalize`}>{row.role}</td>
                  <td className={`${TD} ${NUM}`}>{row.threads}</td>
                  <TokenCell value={row.tokens} threads={row.threads} unreported={row.unreported} />
                  <td className={`${TD} ${NUM}`}>{row.firstPass === null ? "—" : pct(row.firstPass.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.unrecorded > 0 && <p data-model-unrecorded className="mt-1.5 text-xs text-[var(--loom-muted)]">{plural(view.unrecorded, "thread")} started before Loom recorded models, or are planners</p>}
        </Section>
        <Section title="By repo" count={view.byRepo.length}>
          <table data-insights-repos className="w-full text-[13px]">
            <thead>
              <tr>
                {["Repo", "Project", "Tokens", "Done"].map((head, index) => (
                  <th key={head} scope="col" className={`${TH} ${index >= 2 ? "text-right" : ""}`}>
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {repos.map((row) => (
                <tr key={`${row.slug} ${row.repo ?? ""}`} data-repo-row={row.name ?? row.slug} className="border-t border-[var(--loom-line)]">
                  <td className={`${TD} font-mono text-xs`}>{row.name ?? <span className="font-sans text-[var(--loom-muted)]">unknown</span>}</td>
                  <td className={TD}>{row.key}</td>
                  <TokenCell value={row.tokens} threads={row.threads} unreported={row.unreported} />
                  <td className={`${TD} ${NUM}`}>
                    {row.done}
                    <span className="text-[var(--loom-muted)]">/{row.total}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.byRepo.length > REPOS_SHOWN && (
            <button type="button" aria-expanded={allRepos} className={`mt-1 cursor-pointer rounded text-xs text-[var(--loom-muted)] underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`} onClick={() => setAllRepos(!allRepos)}>
              {allRepos ? "Fewer" : `${view.byRepo.length - REPOS_SHOWN} more`}
            </button>
          )}
        </Section>
      </div>
    </>
  );
}

function Scope({ view, chosen, onChoose }: { view: InsightsAllView; chosen: readonly string[]; onChoose(next: readonly string[]): void }) {
  const active = view.choices.filter((choice) => !choice.finished);
  const finished = view.choices.filter((choice) => choice.finished);
  const has = (slug: string) => chosen.includes(slug);
  const finishedOn = finished.length > 0 && finished.every((choice) => has(choice.slug));
  const toggle = (slugs: readonly string[], on: boolean) => onChoose(on ? chosen.filter((one) => !slugs.includes(one)) : [...new Set([...chosen, ...slugs])]);
  return (
    <div role="group" aria-label="Projects" data-insights-scope className={SEG}>
      <button type="button" aria-pressed={chosen.length === 0} className={segButton(chosen.length === 0)} onClick={() => onChoose([])}>
        All
      </button>
      {active.map((choice) => (
        <button key={choice.slug} type="button" aria-pressed={has(choice.slug)} title={choice.name} className={segButton(has(choice.slug))} onClick={() => toggle([choice.slug], has(choice.slug))}>
          {choice.key}
        </button>
      ))}
      {finished.length > 0 && (
        <button type="button" aria-pressed={finishedOn} className={segButton(finishedOn)} onClick={() => toggle(finished.map((choice) => choice.slug), finishedOn)}>
          Finished
          <span className="loom-num text-[11px] text-[var(--loom-muted)]">{finished.length}</span>
        </button>
      )}
    </div>
  );
}

/**
 * The Insights page. `slug` fixes it to one project, as a project's History shows it, with no choice of projects;
 * without it, the page reads every project and the person narrows it with the project buttons.
 */
export function InsightsAll({ slug, go }: { slug?: string; go?(subPath: string): void }) {
  const weeks = useStored(insightsWeeks);
  const stored = useStored(insightsScope);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const chosen = slug === undefined ? stored : [slug];
  const input = useMemo(() => ({ weeks, ...(chosen.length === 0 ? {} : { slugs: [...chosen] }), ...(range === null ? {} : range) }), [weeks, chosen.join(","), range?.from, range?.to]);
  const remote = useLoom("insightsAll", input, { keep: true });
  const view = remote.data ?? null;
  if (view === null) {
    return remote.error === null ? (
      <div data-insights-all aria-busy="true" className="grid grid-cols-5 gap-2 p-1">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="loom-card h-20 animate-pulse rounded-md" />
        ))}
        <p role="status" className="sr-only">Loading insights</p>
      </div>
    ) : (
      <div role="alert" data-insights-all className="loom-card space-y-2 rounded-md p-4 text-sm">
        <p className="font-semibold">Insights did not load</p>
        <p className="text-[var(--loom-muted)] [overflow-wrap:anywhere]">{remote.error}</p>
        <button type="button" className={BUTTON} onClick={remote.reload}>
          Retry
        </button>
      </div>
    );
  }
  const pickWeeks = (next: 4 | 12) => {
    setRange(null);
    insightsWeeks.set(next);
  };
  const nothing = view.choices.length === 0 || (view.daily.every((value) => value === 0) && view.totals.threads === 0 && view.projects.every((row) => row.done === 0));
  return (
    <div data-insights-all className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {slug === undefined && (
          <Scope
            view={view}
            chosen={stored}
            onChoose={(next) => {
              setRange(null);
              insightsScope.set(next);
            }}
          />
        )}
        <div role="group" aria-label="Window" data-insights-weeks className={`${SEG} ml-auto`}>
          {([4, 12] as const).map((value) => (
            <button key={value} type="button" aria-pressed={weeks === value} className={segButton(weeks === value)} onClick={() => pickWeeks(value)}>
              {value} weeks
            </button>
          ))}
        </div>
      </div>
      {view.range !== null && (
        <p data-insights-counting className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--loom-line)] bg-[var(--loom-sel)] py-0.5 pr-0.5 pl-2.5">
            Counting {spanText(view.range.from, view.range.to)}
            <button type="button" aria-label="Count the whole window" className={`cursor-pointer rounded-full px-1.5 text-[var(--loom-muted)] hover:bg-state-hover hover:text-foreground ${TAP}`} onClick={() => setRange(null)}>
              ×
            </button>
          </span>
          <span className="text-[var(--loom-muted)]">The charts keep the whole window</span>
        </p>
      )}
      {nothing ? (
        <p data-insights-empty className="loom-card flex items-center gap-2 rounded-md px-4 py-6 text-sm text-[var(--loom-muted)]">
          <Icon name="Clock" className="size-4" aria-hidden />
          No ticket done and no agent thread started in the last {weeks} weeks
        </p>
      ) : (
        <>
          <Figures view={view} />
          <p data-tokens-note className="-mt-1.5 text-xs text-[var(--loom-muted)]">Tokens count each thread's whole total where it started: Loom keeps no usage over time, so they are not what a stretch used.</p>
          <div className="grid gap-3 @5xl/loom:grid-cols-2">
            <Section title="Done per week">
              <WeeklyMultiples view={view} />
            </Section>
            <Section title="Done per day" side={<span className="text-[11px] text-[var(--loom-muted)] @max-xl/loom:hidden">← → pick · ⇧ extends · Enter counts</span>}>
              <DailyChart view={view} onRange={setRange} />
            </Section>
          </div>
          <Tables view={view} go={go} />
        </>
      )}
    </div>
  );
}

/** The page at /_insights: every project, from the sidebar's Insights. */
export function InsightsPage({ go }: { go(subPath: string): void }) {
  return (
    <div data-insights-page className="flex min-h-full flex-col gap-3 px-5 pt-3 pb-6 @max-xl/loom:px-3">
      <h1 className="sr-only">Insights across projects</h1>
      <InsightsAll go={go} />
    </div>
  );
}
