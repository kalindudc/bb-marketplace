import type { ReactNode } from "react";
import { formatDuration } from "../format";
import type { ProjectMetrics, Pct } from "../metrics";
import type { TicketState } from "../states";
import { BarChart, Spark, StackedArea, type Swatch } from "./charts";
import { HEADING, plural } from "./common";

const IN_FLIGHT: readonly TicketState[] = ["working", "checking", "review", "approved", "merging", "pr_open"];
// The first key is drawn at the bottom of the cumulative flow, so finished work sits under the queue.
const FLOW_KEYS: TicketState[] = ["done", "pr_open", "merging", "approved", "review", "checking", "working", "queued", "blocked", "cancelled"];
const FLOW_COLORS: Record<TicketState, Swatch> = {
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
const count = (value: number) => value.toLocaleString("en-US");

function Tile({ id, title, value, note, children }: { id: string; title: string; value?: string; note?: string; children?: ReactNode }) {
  return (
    <div data-tile={id} className="rounded-md border border-border-seam p-3">
      <h3 className={HEADING}>{title}</h3>
      {value !== undefined && <p data-tile-value className="mt-1 text-xl font-semibold">{value}</p>}
      {note !== undefined && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
      {children}
    </div>
  );
}

const percentiles = (pct: Pct) => (pct.n === 0 ? "none yet" : `p50 ${formatDuration(pct.p50!)} · p85 ${formatDuration(pct.p85!)}`);

export function MetricsView({ metrics: m }: { metrics: ProjectMetrics }) {
  const done = m.throughput.reduce((sum, day) => sum + day.done, 0);
  const days = m.throughput.length;
  const inFlight = m.cumulativeFlow.map((row) => IN_FLIGHT.reduce((sum, state) => sum + row[state], 0));
  const failedRate = m.checks.total === 0 ? null : Math.round((m.checks.failed / m.checks.total) * 100);
  return (
    <div className="space-y-5 p-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Tile id="wip" title="Work in progress" value={String(m.wip)} note={plural(m.wip, "ticket") + " in flight"}>
          <Spark values={inFlight} label={`Work in progress over the last ${days} days`} />
        </Tile>
        <Tile id="throughput" title="Throughput" value={String(done)} note={`done in ${days} days · ${(done / Math.max(1, days)).toFixed(1)} per day`}>
          <BarChart data={m.throughput.map((day) => ({ label: day.day, value: day.done }))} unit="done" label={`Throughput: tickets done per day, last ${days} days`} />
        </Tile>
        <Tile id="cycle-time" title="Cycle time" note={m.cycleTime.n === 0 ? undefined : `${plural(m.cycleTime.n, "ticket")}, from first worked on to done`}>
          <p className="mt-1 text-sm font-semibold">{percentiles(m.cycleTime)}</p>
        </Tile>
        <Tile id="lead-time" title="Lead time" note={m.leadTime.n === 0 ? undefined : `${plural(m.leadTime.n, "ticket")}, from created to done`}>
          <p className="mt-1 text-sm font-semibold">{percentiles(m.leadTime)}</p>
        </Tile>
        <Tile id="first-pass" title="First-pass approval" value={m.firstPassApproval.rate === null ? "none yet" : `${Math.round(m.firstPassApproval.rate * 100)}%`} note={m.firstPassApproval.rate === null ? undefined : `${plural(m.firstPassApproval.n, "ticket")} with a verdict`} />
        <Tile id="review-rounds" title="Review rounds" value={m.reviewRounds.mean === null ? "none yet" : m.reviewRounds.mean.toFixed(1)} note={m.reviewRounds.mean === null ? undefined : `per done ticket (${m.reviewRounds.n} done)`} />
        <Tile id="checks" title="Check failures" value={failedRate === null ? "none run" : `${failedRate}%`} note={failedRate === null ? undefined : `${m.checks.failed} of ${m.checks.total} failed`} />
        <Tile id="blocks" title="Blocks" value={String(m.blocks)} note="times a ticket was blocked" />
        <Tile id="interventions" title="Human interventions" value={String(m.humanInterventions)} note="commands the human ran, apart from start and the first approval" />
        <Tile
          id="tokens"
          title="Tokens (sampled)"
          value={count(m.tokens.total)}
          note={`${m.tokens.perDoneTicket === null ? "no done ticket yet" : `${count(Math.round(m.tokens.perDoneTicket))} per done ticket`} · planner ${count(m.tokens.byRole.planner)} · worker ${count(m.tokens.byRole.worker)} · reviewer ${count(m.tokens.byRole.reviewer)}`}
        />
        <Tile id="active" title="Active time" value={formatDuration(m.activeMs)} note="running, without the paused spans" />
      </div>
      {m.wipAge.length > 0 && (
        <section>
          <h2 className={HEADING}>Work item age</h2>
          <ol data-wip-age className="mt-1 space-y-0.5 text-sm">
            {m.wipAge.map((item) => (
              <li key={item.key}>
                <span className="font-medium">{item.key}</span> <span className="text-muted-foreground">{item.state.replace("_", " ")} · {formatDuration(item.ageMs)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section>
        <h2 className={HEADING}>Cumulative flow</h2>
        <StackedArea
          rows={m.cumulativeFlow}
          keys={FLOW_KEYS}
          colors={FLOW_COLORS}
          label="Cumulative flow: tickets in each state at the end of each day"
        />
      </section>
    </div>
  );
}
