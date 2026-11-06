import type { ReactNode } from "react";
import { percent } from "./format";

// bb defines no chart colours inside a plugin's page; every theme defines a terminal palette, so a series takes one of its colours.
const FALLBACKS = ["var(--ansi-4)", "var(--ansi-3)", "var(--ansi-2)", "var(--ansi-5)", "var(--ansi-6)", "var(--ansi-1)"];
export const color = (n: number) => `var(--chart-${n}, ${FALLBACKS[(n - 1) % FALLBACKS.length]})`;

export function Kpi({ label, value, sub, warn = false }: { label: string; value: string; sub: ReactNode; warn?: boolean }) {
  return (
    <div data-kpi={label} className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-px text-xl font-bold ${warn ? "text-warning-text" : ""}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

export function Panel({ title, sub, children }: { title: ReactNode; sub: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card px-3.5 py-3">
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">{title}</h3>
      <div className="mb-2.5 mt-0.5 text-[11.5px] text-muted-foreground">{sub}</div>
      {children}
    </section>
  );
}

/** Shares as one bar with a legend; each part's share is of the parts' total. */
export function SegBar({ label, parts }: { label: string; parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const shown = parts.filter((part) => part.value > 0);
  return (
    <div data-segbar={label}>
      <div role="img" aria-label={`${label}: ${parts.map((part) => `${part.label} ${total === 0 ? "0%" : percent(part.value / total)}`).join(", ")}`} className="flex h-3.5 gap-0.5 overflow-hidden rounded-full bg-background">
        {shown.map((part) => <div key={part.label} title={`${part.label}: ${percent(part.value / total)}`} style={{ flex: part.value, background: part.color }} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5 text-[11.5px] text-muted-foreground">
        {parts.map((part) => (
          <span key={part.label} className="inline-flex items-center gap-1.5">
            <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: part.color }} />
            {part.label} <b className="text-foreground">{total === 0 ? "0%" : percent(part.value / total)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
