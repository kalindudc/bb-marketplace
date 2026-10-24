// Small SVG charts, drawn here so no chart library is bundled. Colours come from the theme's CSS variables.
import type { TicketState } from "../states";

export interface Swatch {
  fill: string;
  opacity?: number;
}

/** One colour per ticket state, shared by the Insights charts. bb's app defines no --chart-* variables, so these use the theme's named colours. */
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

const PRIMARY = "var(--primary, currentColor)";

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
