import type { ReactNode } from "react";
import { formatDuration, noTokenUsage } from "../format";
import type { ProjectMetrics, Pct } from "../metrics";
import { TICKET_STATES, WINDOW_DAYS, type TicketState, type WindowDays } from "../states";
import { BarChart, ShareBar, Spark, StackedArea, STATE_COLORS as FLOW_COLORS } from "./charts";
import { BUTTON, CARD, HEADING, plural } from "./common";

const IN_FLIGHT: readonly TicketState[] = ["working", "checking", "review", "approved", "merging", "pr_open"];
// The first key is drawn at the bottom of the cumulative flow, so finished work sits under the queue.
const FLOW_KEYS: TicketState[] = ["done", "pr_open", "merging", "approved", "review", "checking", "working", "queued", "blocked", "cancelled"];
const count = (value: number) => value.toLocaleString("en-US");
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const EMPTY = "mt-1 text-sm text-muted-foreground";
const CELL = "py-1 pr-4";

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

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-section={id} className={CARD}>
      <h2 className={HEADING}>{title}</h2>
      {children}
    </section>
  );
}

function TimeInState({ time }: { time: ProjectMetrics["timeInState"] }) {
  if (time.n === 0 || time.flowEfficiency === null) return <p className={EMPTY}>No ticket is done yet.</p>;
  const total = TICKET_STATES.reduce((sum, state) => sum + time.ms[state], 0);
  const states = TICKET_STATES.filter((state) => time.ms[state] > 0);
  return (
    <>
      <ShareBar label="Time in state" parts={states.map((state) => ({ label: `${state.replace("_", " ")} ${percent(time.ms[state] / total)}`, value: time.ms[state], swatch: FLOW_COLORS[state] }))} />
      <p className="mt-2 text-xs text-muted-foreground">
        Flow efficiency {percent(time.flowEfficiency)}: of a done ticket's lead time, the share a worker held it ({plural(time.n, "done ticket")}).
      </p>
    </>
  );
}

function ChecksByCommand({ checks, scope }: { checks: ProjectMetrics["checksByCommand"]; scope: ProjectMetrics["scopeFlags"] }) {
  if (checks.length === 0) return <p className={EMPTY}>No check has run yet.</p>;
  return (
    <>
      <table className="mt-1 w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            {["Command", "Runs", "Failed", "p50"].map((heading) => (
              <th key={heading} className={`${CELL} font-normal`}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check.command} className="border-t border-border-seam">
              <td className={CELL}><code className="[overflow-wrap:anywhere]">{check.command}</code></td>
              <td className={CELL}>{check.runs}</td>
              <td className={`${CELL} ${check.failed > 0 ? "text-destructive-text" : ""}`}>{check.failed === 0 ? "0" : `${check.failed} · ${percent(check.failed / check.runs)}`}</td>
              <td className={CELL}>{check.p50Ms === null ? "none" : formatDuration(check.p50Ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        {plural(scope.outside, "check")} found files outside its ticket's scope; {scope.protectedHits} found protected paths.
      </p>
    </>
  );
}

function Findings({ findings: f }: { findings: ProjectMetrics["findings"] }) {
  if (f.rounds === 0) return <p className={EMPTY}>No review has a verdict yet.</p>;
  const figure = (value: number, note: string, tone = "") => (
    <div>
      <p className={`text-xl font-semibold ${tone}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
  return (
    <>
      <div className="mt-1 grid grid-cols-3 gap-3">
        {figure(f.total, `findings in ${plural(f.rounds, "round")}`)}
        {figure(f.blocking, "blocking", f.blocking > 0 ? "text-destructive-text" : "")}
        {figure(f.shouldFix, "should-fix")}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Changes requested in {f.changesRequested} of {plural(f.rounds, "round")} ({percent(f.changesRequested / f.rounds)}).
      </p>
    </>
  );
}

function TokensByTicket({ tickets }: { tickets: ProjectMetrics["tokensByTicket"] }) {
  if (tickets.length === 0) return <p className={EMPTY}>No ticket has used tokens yet.</p>;
  const max = Math.max(...tickets.map((entry) => entry.tokens));
  return (
    <div className="mt-1 space-y-1">
      {tickets.map((entry) => (
        <div key={entry.key} data-ticket-tokens={entry.key} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 font-medium">{entry.key}</span>
          <span aria-hidden className="h-2 flex-1 overflow-hidden rounded-full bg-state-hover">
            <span className="block h-full rounded-full" style={{ width: `${(entry.tokens / max) * 100}%`, background: "var(--primary, currentColor)" }} />
          </span>
          <span className="w-16 shrink-0 text-right text-muted-foreground">{count(entry.tokens)}</span>
        </div>
      ))}
    </div>
  );
}

function Reliability({ reliability: r }: { reliability: ProjectMetrics["reliability"] }) {
  const rows: Array<[string, number]> = [
    ["Worker attempts that failed", r.failedAttempts],
    ["Rate-limit retries", r.rateLimitRetries],
    ["Workers timed out", r.timeouts],
    ["Merges sent back", r.mergesSentBack],
  ];
  return (
    <table className="mt-1 text-sm">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td className="py-0.5 pr-6">{label}</td>
            <td className="py-0.5 tabular-nums">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** `days` is the throughput and cumulative flow window; every other figure is over the whole project. */
export function MetricsView({ metrics: m, days: windowDays, onDays }: { metrics: ProjectMetrics; days: WindowDays; onDays(days: WindowDays): void }) {
  const done = m.throughput.reduce((sum, day) => sum + day.done, 0);
  const days = m.throughput.length;
  const inFlight = m.cumulativeFlow.map((row) => IN_FLIGHT.reduce((sum, state) => sum + row[state], 0));
  const failedRate = m.checks.total === 0 ? null : Math.round((m.checks.failed / m.checks.total) * 100);
  return (
    <div className="space-y-5 p-4">
      <div role="group" aria-label="Window" data-window className="flex items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Window</span>
        {WINDOW_DAYS.map((option) => (
          <button key={option} type="button" aria-pressed={option === windowDays} className={`${BUTTON} ${option === windowDays ? "bg-surface-selected" : ""}`} onClick={() => onDays(option)}>
            {option} days
          </button>
        ))}
      </div>
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
        >
          {m.tokens.unreported > 0 && <p className="mt-0.5 text-xs text-muted-foreground">{noTokenUsage(m.tokens.unreported)}</p>}
        </Tile>
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
      <Section id="time-in-state" title="Where the time goes">
        <TimeInState time={m.timeInState} />
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section id="checks-by-command" title="Checks by command">
          <ChecksByCommand checks={m.checksByCommand} scope={m.scopeFlags} />
        </Section>
        <Section id="findings" title="Review findings">
          <Findings findings={m.findings} />
        </Section>
        <Section id="tokens-by-ticket" title="Tokens by ticket (top 5, sampled)">
          <TokensByTicket tickets={m.tokensByTicket} />
        </Section>
        <Section id="reliability" title="Reliability">
          <Reliability reliability={m.reliability} />
        </Section>
      </div>
    </div>
  );
}
