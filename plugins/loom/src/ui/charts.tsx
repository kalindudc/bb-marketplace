// Small SVG charts, drawn here so no chart library is bundled. Colours come from the theme's CSS variables.
import type { CSSProperties } from "react";
import type { TicketState } from "../states";

export interface Swatch {
  fill: string;
  opacity?: number;
  /** Striped rather than solid: tells apart two states a theme colours alike (gruve dark's primary is its warning). */
  hatch?: boolean;
}

/** A share's segment or key. A faded fill is mixed, not given opacity, so the 1.5 px edge of its own ink stays at full
 * strength: every ink here is 3:1 or more on cards and tracks (WCAG 1.4.11), whatever its neighbour. */
export function markStyle(swatch: Swatch): CSSProperties {
  const faded = swatch.opacity !== undefined && swatch.opacity < 1;
  const fill = faded ? `color-mix(in oklab, ${swatch.fill} ${Math.round(swatch.opacity! * 100)}%, transparent)` : swatch.fill;
  return { background: swatch.hatch === true ? `repeating-linear-gradient(135deg, ${swatch.fill} 0 1.5px, transparent 1.5px 3.5px)` : fill, boxShadow: `inset 0 0 0 1.5px ${swatch.fill}` };
}

/** A stacked share bar's track: 2 px of track between segments, so two neighbours never meet edge to edge. */
export const SHARE_TRACK = "flex gap-[2px] overflow-hidden rounded-full bg-state-hover";
/** A segment: it keeps 3 px however small its share, so its edge still shows. */
export const SHARE_PART = "h-full min-w-[3px] rounded-[2px]";

/** One colour per ticket state, shared by the Insights charts. bb's app defines no --chart-* variables, so these use the theme's named colours. */
export const STATE_COLORS: Record<TicketState, Swatch> = {
  done: { fill: "var(--success, currentColor)" },
  pr_open: { fill: "var(--success, currentColor)", opacity: 0.35 },
  merging: { fill: "var(--success, currentColor)", opacity: 0.5 },
  approved: { fill: "var(--success, currentColor)", opacity: 0.7 },
  review: { fill: "var(--warning, currentColor)", hatch: true },
  checking: { fill: "var(--primary, currentColor)", opacity: 0.6 },
  working: { fill: "var(--primary, currentColor)" },
  queued: { fill: "var(--loom-mark-quiet, currentColor)" },
  blocked: { fill: "var(--loom-mark-bad, currentColor)" },
  cancelled: { fill: "var(--loom-mark-quiet, currentColor)" },
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
  return (
    <figure className="mt-1.5">
      <div role="img" aria-label={`${label}: ${parts.map((part) => part.label).join(", ")}`} className={`${SHARE_TRACK} h-2 w-full`}>
        {total > 0 && parts.filter((part) => part.value > 0).map((part) => <span key={part.label} title={part.label} className={SHARE_PART} style={{ width: `${(part.value / total) * 100}%`, ...markStyle(part.swatch) }} />)}
      </div>
      <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--loom-muted)]">
        {parts.map((part) => (
          <span key={part.label} className="inline-flex items-center gap-1">
            <span aria-hidden className="size-2 rounded-sm" style={markStyle(part.swatch)} />
            {part.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
