import { forwardRef } from "react";
import type { Replayed, ReplaySettings } from "../../replay";
import { FIELD_SMALL, Pill } from "../common";
import { Panel } from "../insight-parts";
import { findingReasons } from "./model";

const W = 560;
const H = 230;
const X0 = 36;
const Y0 = 200;
const PLOT_W = 510;
const PLOT_H = 180;

type You = NonNullable<Replayed["findings"][number]["you"]>;
const YOU_CLASS: Record<You, string> = { posted: "text-success", dropped: "text-destructive-text", pending: "text-muted-foreground" };
const YOU_LABEL: Record<You, string> = { posted: "you posted", dropped: "you dropped", pending: "undecided" };

/** A floor as a slider with its value beside it. */
function Floor({ label, value, onChange }: { label: string; value: number; onChange(next: number): void }) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      <span>{label}, at least <b className="font-semibold tabular-nums text-foreground">{value.toFixed(2)}</b></span>
      <input type="range" min={0} max={1} step={0.05} value={value} aria-label={`${label}, at least`} className="w-full cursor-pointer accent-foreground"
        onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(Math.round(next * 100) / 100); }} />
    </label>
  );
}

/**
 * Every finding the verifier scored, by how sure it is the finding is right and how worth posting it is, coloured by what you
 * did; the floors as dashed lines with the passing corner shaded, and sliders to move them.
 */
export const Verifier = forwardRef<HTMLDivElement, { rows: readonly Replayed[]; settings: ReplaySettings; onChange(patch: Partial<ReplaySettings>): void }>(function Verifier({ rows, settings, onChange }, ref) {
  const scored = rows.flatMap((row) => row.findings.filter((f) => f.holds !== null && f.worth !== null).map((f) => ({ row, f })));
  const x = (v: number) => X0 + v * PLOT_W;
  const y = (v: number) => Y0 - v * PLOT_H;
  // Findings with the same scores and outcome share one dot, sized and numbered by how many they are.
  const dots = new Map<string, { holds: number; worth: number; you: You; titles: string[] }>();
  for (const { row, f } of scored) {
    const you: You = f.you ?? "pending";
    const key = `${f.holds},${f.worth},${you}`;
    const dot = dots.get(key) ?? { holds: f.holds!, worth: f.worth!, you, titles: [] };
    dot.titles.push(`${row.draft.display} · ${f.severity} · right ${f.holds!.toFixed(2)}, worth ${f.worth!.toFixed(2)} · ${f.body}`);
    dots.set(key, dot);
  }
  const reasons = findingReasons(rows);
  return (
    <div ref={ref} data-verifier className="min-w-0 scroll-mt-3">
      <Panel title="Findings and the verifier" sub="Each scored finding by the verifier's two scores; move a floor to see which findings pass.">
        {scored.length === 0
          ? <div className="text-sm text-muted-foreground">The verifier has not scored a finding in this range.</div>
          : (
            <svg data-chart="scatter" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" className="block text-muted-foreground"
              aria-label="Each finding the verifier scored, by how sure it is the finding is right and how worth posting it is, coloured by what you did">
              <rect x={x(settings.holds)} y={y(1)} width={(1 - settings.holds) * PLOT_W} height={(1 - settings.worth) * PLOT_H} rx={6} fill="currentColor" className="text-success" opacity={0.12} />
              <rect x={X0} y={y(1)} width={PLOT_W} height={PLOT_H} rx={6} fill="none" stroke="currentColor" className="text-border" />
              <text x={x(1) - 6} y={y(1) + 14} fontSize={10} textAnchor="end" fill="currentColor">passes</text>
              <text x={X0 + PLOT_W / 2} y={Y0 + 16} fontSize={10} textAnchor="middle" fill="currentColor">sure it's right →</text>
              <text x={12} y={Y0 - PLOT_H / 2} fontSize={10} textAnchor="middle" fill="currentColor" transform={`rotate(-90 12 ${Y0 - PLOT_H / 2})`}>worth posting →</text>
              <line x1={x(settings.holds)} x2={x(settings.holds)} y1={y(1)} y2={Y0} stroke="currentColor" strokeDasharray="4 3" className="text-foreground" opacity={0.6} />
              <line x1={X0} x2={x(1)} y1={y(settings.worth)} y2={y(settings.worth)} stroke="currentColor" strokeDasharray="4 3" className="text-foreground" opacity={0.6} />
              {[...dots.entries()].map(([key, dot]) => {
                const n = dot.titles.length;
                return (
                  <g key={key} data-you={dot.you} data-count={n}>
                    <circle cx={x(dot.holds)} cy={y(dot.worth)} r={Math.min(11, 6 + (n - 1) * 1.5)} fill="currentColor" className={YOU_CLASS[dot.you]} stroke="var(--card)" strokeWidth={1.5}>
                      <title>{dot.titles.join("\n")}</title>
                    </circle>
                    {n > 1 && <text x={x(dot.holds)} y={y(dot.worth) + 3.5} fontSize={9.5} fontWeight={600} textAnchor="middle" fill="var(--card)" pointerEvents="none">{n}</text>}
                  </g>
                );
              })}
            </svg>
          )}
        <div className="mt-3 grid grid-cols-1 items-end gap-3 @xl:grid-cols-[1fr_1fr_auto]">
          <Floor label="Sure it's right" value={settings.holds} onChange={(holds) => onChange({ holds })} />
          <Floor label="Worth posting" value={settings.worth} onChange={(worth) => onChange({ worth })} />
          <label className="grid gap-1 text-xs text-muted-foreground" title="Nits never post, whatever this says.">
            <span>Lowest severity that posts</span>
            <select aria-label="Lowest severity that posts" value={settings.minSeverity} className={FIELD_SMALL} onChange={(event) => onChange({ minSeverity: event.target.value as ReplaySettings["minSeverity"] })}>
              {(["low", "medium", "high"] as const).map((severity) => <option key={severity} value={severity}>{severity}</option>)}
            </select>
          </label>
        </div>
        <div data-finding-reasons className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[11.5px] text-muted-foreground">
          {(Object.keys(YOU_LABEL) as You[]).map((you) => <span key={you} className="inline-flex items-center gap-1.5"><i aria-hidden className={`inline-block size-2.5 rounded-full bg-current ${YOU_CLASS[you]}`} />{YOU_LABEL[you]}</span>)}
          {reasons.map(({ name, findings }) => <Pill key={name} title="Why a held finding failed first, and how many did">{name} {findings}</Pill>)}
        </div>
      </Panel>
    </div>
  );
});
