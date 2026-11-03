import type { ReactNode } from "react";

// bb defines no chart colours inside a plugin's page; every theme defines a terminal palette, so a series takes one of its colours.
const FALLBACKS = ["var(--ansi-4)", "var(--ansi-3)", "var(--ansi-2)", "var(--ansi-5)", "var(--ansi-6)", "var(--ansi-1)"];
export const color = (n: number) => `var(--chart-${n}, ${FALLBACKS[(n - 1) % FALLBACKS.length]})`;

export function Kpi({ label, value, sub, warn = false }: { label: string; value: string; sub: string; warn?: boolean }) {
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
