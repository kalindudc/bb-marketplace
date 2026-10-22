// Small SVG charts, drawn here so no chart library is bundled. Colours come from the theme's CSS variables.
import type { TicketState } from "../states";

export interface Swatch {
  fill: string;
  opacity?: number;
}

/** One colour per ticket state, shared by the cumulative flow and the timeline. bb's app defines no --chart-* variables, so these use the theme's named colours. */
export const STATE_COLORS: Record<TicketState, Swatch> = {
  done: { fill: "var(--success, currentColor)" },
  pr_open: { fill: "var(--success, currentColor)", opacity: 0.35 },
  merging: { fill: "var(--success, currentColor)", opacity: 0.5 },
  approved: { fill: "var(--success, currentColor)", opacity: 0.7 },
  review: { fill: "var(--warning, currentColor)" },
  checking: { fill: "var(--primary, currentColor)", opacity: 0.6 },
  working: { fill: "var(--primary, currentColor)" },
  queued: { fill: "var(--muted-foreground, currentColor)", opacity: 0.5 },
  blocked: { fill: "var(--destructive, currentColor)" },
  cancelled: { fill: "var(--subtle-foreground, currentColor)", opacity: 0.5 },
};

const MUTED = "var(--muted-foreground, currentColor)";
const PRIMARY = "var(--primary, currentColor)";
const axis = { stroke: "var(--border, currentColor)", strokeWidth: 1 } as const;
const note = { fill: MUTED, fontSize: 8 } as const;

/** One bar per item; each bar's <title> is its hover text. */
export function BarChart({ data, label, unit }: { data: { label: string; value: number }[]; label: string; unit?: string }) {
  const width = 280;
  const height = 100;
  const top = 12;
  const bottom = 14;
  const max = Math.max(1, ...data.map((item) => item.value));
  const step = width / Math.max(1, data.length);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
      <line x1={0} x2={width} y1={height - bottom} y2={height - bottom} {...axis} />
      {data.map((item, index) => {
        const barHeight = (item.value / max) * (height - top - bottom);
        return (
          <rect key={item.label} x={index * step + 1} y={height - bottom - barHeight} width={Math.max(1, step - 2)} height={barHeight} rx={1} style={{ fill: PRIMARY }}>
            <title>{`${item.label}: ${item.value}${unit === undefined ? "" : ` ${unit}`}`}</title>
          </rect>
        );
      })}
      <text x={0} y={9} style={note}>{max}</text>
      {data.length > 0 && <text x={0} y={height - 2} style={note}>{data[0]!.label}</text>}
      {data.length > 1 && <text x={width} y={height - 2} textAnchor="end" style={note}>{data.at(-1)!.label}</text>}
    </svg>
  );
}

/** Stacked areas, the first key at the bottom. Hovering a day shows its counts as text. */
export function StackedArea<K extends string>({ rows, keys, label, colors = {} }: { rows: Array<{ day: string } & Record<K, number>>; keys: K[]; label: string; colors?: Partial<Record<K, Swatch>> }) {
  const width = 320;
  const height = 120;
  const top = 6;
  const bottom = 6;
  const totals = rows.map((row) => keys.reduce((sum, key) => sum + row[key], 0));
  const max = Math.max(1, ...totals);
  const y = (value: number) => height - bottom - (value / max) * (height - top - bottom);
  // A single day still draws a band, so it is stretched across the width.
  const points = rows.length === 1 ? [rows[0]!, rows[0]!] : rows;
  const x = (index: number) => (points.length === 1 ? 0 : (index / (points.length - 1)) * width);
  const below = (row: Record<K, number>, index: number) => keys.slice(0, index).reduce((sum, key) => sum + row[key], 0);
  const column = width / Math.max(1, rows.length);

  return (
    <figure>
      <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} className="h-auto w-full max-w-2xl">
        {keys.map((key, index) => {
          const upper = points.map((row, at) => `${x(at)},${y(below(row, index) + row[key])}`);
          const lower = points.map((row, at) => `${x(at)},${y(below(row, index))}`).reverse();
          const swatch = colors[key] ?? { fill: MUTED };
          return (
            <path key={key} d={`M${upper.join(" L")} L${lower.join(" L")} Z`} style={{ fill: swatch.fill, fillOpacity: swatch.opacity ?? 1 }}>
              <title>{key}</title>
            </path>
          );
        })}
        {rows.map((row, index) => (
          <rect key={row.day} data-flow-day={row.day} x={index * column} y={0} width={column} height={height} style={{ fill: "transparent" }}>
            <title>{[row.day, ...keys.map((key) => `${key}: ${row[key]}`)].join("\n")}</title>
          </rect>
        ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {[...keys].reverse().map((key) => (
          <span key={key} className="inline-flex items-center gap-1">
            <svg aria-hidden viewBox="0 0 8 8" className="size-2"><rect width={8} height={8} style={{ fill: (colors[key] ?? { fill: MUTED }).fill, fillOpacity: colors[key]?.opacity ?? 1 }} /></svg>
            {key.replace("_", " ")}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** A line with no axes, for a trend beside a number. */
export function Spark({ values, label }: { values: number[]; label: string }) {
  const width = 100;
  const height = 24;
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => `${values.length > 1 ? (index / (values.length - 1)) * width : width / 2},${height - 2 - (value / max) * (height - 4)}`).join(" ");
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} className="h-6 w-24">
      <title>{`${label}: ${values.join(", ")}`}</title>
      <polyline points={points} fill="none" strokeWidth={1.5} strokeLinejoin="round" style={{ stroke: PRIMARY }} />
    </svg>
  );
}

/** One horizontal bar split into parts by value, with a legend. Plain elements: its aria-label lists the parts' labels. */
export function ShareBar({ parts, label }: { parts: { label: string; value: number; swatch: Swatch }[]; label: string }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const tint = (swatch: Swatch) => ({ background: swatch.fill, opacity: swatch.opacity ?? 1 });
  return (
    <figure className="mt-1.5">
      <div role="img" aria-label={`${label}: ${parts.map((part) => part.label).join(", ")}`} className="flex h-2 w-full overflow-hidden rounded-full bg-state-hover">
        {total > 0 && parts.filter((part) => part.value > 0).map((part) => <span key={part.label} title={part.label} className="h-full" style={{ width: `${(part.value / total) * 100}%`, ...tint(part.swatch) }} />)}
      </div>
      <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {parts.map((part) => (
          <span key={part.label} className="inline-flex items-center gap-1">
            <span aria-hidden className="size-2 rounded-sm" style={tint(part.swatch)} />
            {part.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
