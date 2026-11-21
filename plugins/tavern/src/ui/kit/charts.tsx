import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** One series as Insights sends it: category or day points, with the unit as a word ("ratio", "s", "min", "h", "bytes", "chars", "usd"). */
export type ChartSeries = { id: string; label: string; unit: string; points: { x: string; y: number | null }[] };
export type Format = (value: number | null | undefined, unit: string) => string;

/** Every number in its unit, in words people read: 22 min, 82%, 11.5 KB, 6.2M tokens, $4.90. */
export const formatValue: Format = (value, unit) => {
  if (value === null || value === undefined) return "no data";
  switch (unit) {
    case "ratio": return `${Math.round(value * 100)}%`;
    case "s": return value < 120 ? `${Math.round(value)} s` : value < 5400 ? `${Math.round(value / 60)} min` : value < 172_800 ? `${(value / 3600).toFixed(1)} h` : `${(value / 86_400).toFixed(1)} d`;
    case "min": return `${Math.round(value)} min`;
    case "h": return `${value.toFixed(1)} h`;
    case "bytes": return value < 1000 ? `${value} B` : `${(value / 1000).toFixed(1)} KB`;
    case "chars": return `${value.toLocaleString("en")} chars`;
    case "tokens": { const short = (n: number, sfx: string) => `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)}${sfx}`; return value < 1000 ? `${Math.round(value)} tokens` : value < 999_500 ? `${short(value / 1000, "k")} tokens` : `${short(value / 1_000_000, "M")} tokens`; }
    case "usd": return `$${value.toFixed(2)}`;
    default: return Math.round(value).toLocaleString("en");
  }
};

const isDay = (x: string) => /^\d{4}-\d{2}-\d{2}$/.test(x);
const dayLabel = (x: string) => isDay(x) ? new Date(`${x}T12:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" }) : x;

/** A headline number. `delta` compares it with the previous period; the tint says better or worse, the arrow says up or down. */
export function Kpi({ label, value, sub, warn = false, delta, format = formatValue }: {
  label: string; value: string; sub?: ReactNode; warn?: boolean;
  delta?: { value: number | null; previous: number | null | undefined; unit: string; lowerIsBetter?: boolean };
  format?: Format;
}) {
  return <div className="tkpi" data-kpi={label}>
    <span className="tkpi-l">{label}</span>
    <b className={`tkpi-v num ${warn ? "warn" : ""}`}>{value}</b>
    {sub && <span className="tkpi-s">{sub}</span>}
    {delta && <Delta {...delta} format={format} />}
  </div>;
}

function Delta({ value, previous, unit, lowerIsBetter = false, format }: { value: number | null; previous: number | null | undefined; unit: string; lowerIsBetter?: boolean; format: Format }) {
  if (value === null || previous === null || previous === undefined) return null;
  if (previous === value) return <span className="tkpi-d">same as before</span>;
  const up = value > previous, good = up !== lowerIsBetter;
  return <span className={`tkpi-d ${good ? "good" : "bad"}`} title={`${good ? "Better" : "Worse"} than the previous period (${format(previous, unit)})`}>
    <span aria-hidden="true">{up ? "▲" : "▼"}</span><span className="sr">{good ? "better," : "worse,"} {up ? "up" : "down"}</span> from {format(previous, unit)}
  </span>;
}

function useMeasuredWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (contentWidth: number) => { const next = Math.floor(contentWidth); if (next > 0) setWidth(next); };
    const style = getComputedStyle(el);
    const inset = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((px, value) => px + (parseFloat(value) || 0), 0);
    measure(el.getBoundingClientRect().width - inset);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => { if (entry) measure(entry.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A chart for one series. Bars: categories with the value written at the end of each bar. Trend: days as a line, drawn at its measured width so its 11 px labels stay 11 px; first, last, lowest and highest are labelled, and a missing day breaks the line. */
export function Chart({ type, series, limit, unit, format = formatValue }: { type: "bars" | "trend"; series: ChartSeries | ChartSeries[]; limit?: number; unit?: string; format?: Format }) {
  if (Array.isArray(series)) return <NamedChart type={type} series={series} unit={unit ?? series[0]?.unit ?? ""} format={format} />;
  const u = unit ?? series.unit;
  return type === "bars" ? <Bars series={series} unit={u} format={format} /> : <Trend series={series} unit={u} limit={limit} format={format} />;
}

function NamedChart({ type, series, unit, format }: { type: "bars" | "trend"; series: ChartSeries[]; unit: string; format: Format }) {
  const [ref, width] = useMeasuredWidth<HTMLElement>(480);
  const values = series.flatMap(item => item.points.map(point => point.y ?? 0));
  const scale = Math.max(1, ...values.map(Math.abs));
  const low = Math.min(0, ...values.map(value => value / scale));
  const high = Math.max(0, ...values.map(value => value / scale));
  const span = high - low || 1;
  const position = (value: number) => ((value / scale - low) / span) * 100;
  const baseline = position(0);
  const count = series[0]?.points.length ?? 0;
  const endings = series.flatMap((item, j) => {
    const last = item.points.at(-1);
    return last ? [{ item, j, last, y: Math.max(12, 94 - position(last.y ?? 0) * 0.8) }] : [];
  }).sort((a, b) => a.y - b.y);
  endings.forEach((label, i) => { if (i) label.y = Math.max(label.y, endings[i - 1]!.y + 14); });
  const overflow = Math.max(0, (endings.at(-1)?.y ?? 0) - 112);
  endings.forEach(label => { label.y -= overflow; });
  return <figure ref={ref} className="tchart tchart-named" data-chart={type}>
    <figcaption>{series.map(item => item.label).join(", ")}{unit ? ` in ${unit}` : ""}</figcaption>
    {type === "bars" ? <ul className="tchart-bars">{Array.from({ length: count }, (_, i) => series.map((item, j) => {
      const point = item.points[i]!, at = position(point.y ?? 0);
      return <li key={`${i}:${j}`}><span className="l">{point.x}{series.length > 1 ? `: ${item.label}` : ""}</span><span className="t" aria-hidden="true"><span className={`b series-${j}`} style={{ marginLeft: `${Math.min(at, baseline)}%`, width: `${Math.abs(at - baseline)}%` }} /></span><span className="v num">{format(point.y, unit)}</span></li>;
    }))}</ul> : <svg className="tchart-trend" width={width} height={136} viewBox={`0 0 ${width} 136`} role="img" aria-label={`Trend for ${series.map(item => item.label).join(", ")}; values in the accompanying table`}>
      {series.map((item, j) => <polyline key={j} className={`line series-${j}`} strokeDasharray={j === 0 ? undefined : j === 1 ? "6 3" : "2 3"} points={item.points.map((point, i) => `${8 + i * (width - 16) / Math.max(1, count - 1)},${100 - position(point.y ?? 0) * 0.8}`).join(" ")} />)}
      {endings.map(({ item, j, last, y }) => <text key={j} className={`val series-${j}`} x={width - 8} y={y} textAnchor="end">{item.label}: {format(last.y, unit)}</text>)}
      <text className="ax" x={8} y={130}>{series[0]?.points[0]?.x}</text><text className="ax" x={width - 8} y={130} textAnchor="end">{series[0]?.points.at(-1)?.x}</text>
    </svg>}
    {type === "trend" && <ul className="tchart-legend">{series.map((item, j) => <li key={j}><svg width="28" height="10" aria-hidden="true"><line x1="0" x2="28" y1="5" y2="5" stroke="currentColor" strokeDasharray={j === 0 ? undefined : j === 1 ? "6 3" : "2 3"} /></svg>{item.label}</li>)}</ul>}
  </figure>;
}

function Bars({ series, unit, format }: { series: ChartSeries; unit: string; format: Format }) {
  const max = Math.max(1, ...series.points.map(p => p.y ?? 0));
  return <figure className="tchart" data-chart="bars">
    <figcaption>{series.label}</figcaption>
    {series.points.length === 0 ? <p className="m tchart-empty" data-empty>No data yet.</p>
      : <ul className="tchart-bars">{series.points.map(p => <li key={p.x}>
        <span className="l" title={p.x}>{p.x}</span>
        <span className="t" aria-hidden="true"><span className="b" style={{ width: `${((p.y ?? 0) / max) * 100}%` }} /></span>
        <span className={`v num ${p.y === null ? "none" : ""}`}>{format(p.y, unit)}</span>
      </li>)}</ul>}
  </figure>;
}

const H = 136, L = 8, R = 8, T = 20, B = 40;
function Trend({ series, unit, limit, format }: { series: ChartSeries; unit: string; limit?: number; format: Format }) {
  const [ref, W] = useMeasuredWidth<HTMLElement>(480);
  const all = series.points;
  const known = all.map((p, i) => ({ ...p, i })).filter((p): p is { x: string; y: number; i: number } => p.y !== null);
  if (known.length < 2) return <figure ref={ref} className="tchart" data-chart="trend"><figcaption>{series.label}</figcaption><p className="m tchart-empty" data-empty>Not enough days yet.</p></figure>;
  const ys = known.map(p => p.y);
  const lo = Math.min(...ys, limit ?? Infinity), hi = Math.max(...ys, limit ?? -Infinity), span = Math.max(hi - lo, Math.abs(hi) * 0.05, 1e-9);
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, all.length - 1);
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / span);
  const runs: { x: number; y: number }[][] = [];
  all.forEach((p, i) => { if (p.y === null) { if (runs.at(-1)?.length) runs.push([]); return; } if (!runs.length) runs.push([]); runs.at(-1)!.push({ x: x(i), y: y(p.y) }); });
  const first = known[0]!, last = known.at(-1)!;
  const low = known.reduce((a, b) => b.y < a.y ? b : a), high = known.reduce((a, b) => b.y > a.y ? b : a);
  const placed: { left: number; right: number; at: number }[] = [];
  const labels = [first, last, high, low].filter((p, n, list) => list.findIndex(q => q.i === p.i) === n).flatMap(p => {
    const value = format(p.y, unit);
    const labelWidth = Array.from(value).length * 8;
    if (labelWidth > W - L - R) return [];
    const center = p === first ? 0 : p === last ? labelWidth : labelWidth / 2;
    const left = Math.max(L, Math.min(W - R - labelWidth, x(p.i) - center)), right = left + labelWidth;
    const strokeNear = (at: number) => runs.some(run => run.some((point, i) => {
      if (point.x >= left - 3 && point.x <= right + 3 && point.y >= at - 13 && point.y <= at + 4) return true;
      const next = run[i + 1];
      if (!next) return false;
      const a = Math.max(point.x, left - 2), b = Math.min(next.x, right + 2);
      if (a > b) return false;
      const along = (px: number) => point.y + (next.y - point.y) * (px - point.x) / (next.x - point.x);
      const ya = along(a), yb = along(b);
      return Math.max(ya, yb) >= at - 13 && Math.min(ya, yb) <= at + 4;
    }));
    const cy = y(p.y);
    const offsets = p === low || p === last ? [15, -7, 29, -21, 43, -35] : [-7, 15, -21, 29, -35, 43];
    const ly = offsets.map(offset => cy + offset).find(at => at >= 11 && at <= H - 23 && !strokeNear(at) &&
      placed.every(q => right + 3 <= q.left || q.right + 3 <= left || Math.abs(q.at - at) >= 15));
    if (ly === undefined) return [];
    placed.push({ left, right, at: ly });
    return [{ p, lx: left + center, ly, anchor: (p === first ? "start" : p === last ? "end" : "middle") as "start" | "end" | "middle", value }];
  });
  const describe = `${series.label}: from ${format(first.y, unit)} on ${dayLabel(first.x)} to ${format(last.y, unit)} on ${dayLabel(last.x)}; lowest ${format(low.y, unit)}, highest ${format(high.y, unit)}${limit !== undefined ? `; limit ${format(limit, unit)}` : ""}${known.length < all.length ? `; ${all.length - known.length} days without data` : ""}`;
  return <figure ref={ref} className="tchart" data-chart="trend">
    <figcaption>{series.label}</figcaption>
    <svg className="tchart-trend" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={describe}>
      <line className="base" x1={L} x2={W - R} y1={H - B} y2={H - B} />
      {limit !== undefined && <><line className="limit" x1={L} x2={W - R} y1={y(limit)} y2={y(limit)} /><text className="ax" x={W - R} y={y(limit) - 4} textAnchor="end">limit {format(limit, unit)}</text></>}
      {runs.filter(r => r.length > 0).map((r, n) => r.length === 1 ? <circle key={n} className="dot" cx={r[0]!.x} cy={r[0]!.y} r={2} /> : <polyline key={n} className="line" points={r.map(q => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ")} />)}
      {labels.map(({ p, lx, ly, anchor, value }) => <g key={p.i}><circle className="dot" cx={x(p.i)} cy={y(p.y)} r={2.5} /><text className="val" x={lx} y={ly} textAnchor={anchor}>{value}</text></g>)}
      <text className="ax" x={L} y={H - 6}>{dayLabel(all[0]!.x)}</text>
      <text className="ax" x={W - R} y={H - 6} textAnchor="end">{dayLabel(all.at(-1)!.x)}</text>
    </svg>
  </figure>;
}
