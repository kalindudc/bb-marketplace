import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { AgentRow } from "../contract";
import { endLabel, formatDuration, noTokenUsage } from "../format";
import type { Role } from "../states";
import { ShareBar, type Swatch } from "./charts";
import { BUTTON, CARD, HEADING, plural } from "./common";

const ROLE_SWATCHES: Record<Role, Swatch> = {
  worker: { fill: "var(--primary, currentColor)" },
  reviewer: { fill: "var(--success, currentColor)" },
  planner: { fill: "var(--muted-foreground, currentColor)" },
};
const count = (value: number) => value.toLocaleString("en-US");
const tokensText = (tokens: number | null) => (tokens === null ? "not reported" : count(tokens));
const CELL = "py-1 pr-3 align-top";

function ticketText(row: AgentRow): string {
  if (row.ticketKey === null) return "the project's planner";
  return row.role === "reviewer" ? `${row.ticketKey} · round ${row.reviewRound}` : `${row.ticketKey} · ${row.ticketTitle ?? ""}`;
}

function AgentTable({ rows, now, ended }: { rows: AgentRow[]; now: number; ended: boolean }) {
  const navigate = useBbNavigate();
  return (
    <div className="overflow-x-auto">
      <table className="mt-1 w-full min-w-[560px] text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            {["Role", "Ticket", "Model", ended ? "Ran for" : "Running for", ...(ended ? ["Ended"] : []), "Tokens", "Retries", ""].map((heading) => (
              <th key={heading} className={`${CELL} font-normal`}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.threadId ?? `${row.role}-${index}`} data-agent-row={row.threadId ?? row.role} className="border-t border-border-seam">
              <td className={CELL}>{row.role}</td>
              <td className={CELL}>{ticketText(row)}</td>
              <td className={`${CELL} text-muted-foreground`}>{row.model ?? "default"}</td>
              <td className={CELL}>
                {formatDuration((row.endedAt ?? now) - row.startedAt)}
                {row.timeoutAt !== null && <span className="text-warning-text"> · timeout at {formatDuration(row.timeoutAt - row.startedAt)}</span>}
              </td>
              {ended && <td className={CELL}>{endLabel(row.endReason)}</td>}
              <td className={CELL}>{tokensText(row.tokens)}</td>
              <td className={CELL}>{row.rateLimitRetries === 0 ? "0" : plural(row.rateLimitRetries, "rate limit")}</td>
              <td className={CELL}>
                {row.threadId !== null && (
                  <button type="button" className={BUTTON} onClick={() => navigate.toThread(row.threadId!)}>
                    Thread
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlannerOnCall({ rows }: { rows: AgentRow[] }) {
  const navigate = useBbNavigate();
  return (
    <section data-agents-planner className={CARD}>
      <h2 className={HEADING}>Planner</h2>
      {rows.map((row, index) => (
        <div key={row.threadId ?? index} className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="flex-1 text-muted-foreground">On call for triage rounds</span>
          <span>Tokens {tokensText(row.tokens)}</span>
          {row.threadId !== null && (
            <button type="button" className={BUTTON} onClick={() => navigate.toThread(row.threadId!)}>
              Thread
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

/** The project's planner, worker and reviewer threads: who works now, where the tokens went, and how threads ended. */
export function AgentsView({ agents, byRole, unreported, now }: { agents: AgentRow[]; byRole: Record<Role, number>; unreported: number; now: number }) {
  const live = agents.filter((row) => row.state !== "ended" && row.role !== "planner");
  const planners = agents.filter((row) => row.state !== "ended" && row.role === "planner");
  const ended = agents.filter((row) => row.state === "ended");
  const endings = new Map<string, number>();
  for (const row of ended) endings.set(endLabel(row.endReason), (endings.get(endLabel(row.endReason)) ?? 0) + 1);
  return (
    <div className="space-y-4 p-4">
      <section data-agents-live className={CARD}>
        <h2 className={HEADING}>Working now</h2>
        {live.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">No agent is working now.</p> : <AgentTable rows={live} now={now} ended={false} />}
      </section>
      {planners.length > 0 && <PlannerOnCall rows={planners} />}
      <div className="grid gap-4 lg:grid-cols-2">
        <section data-agents-tokens className={CARD}>
          <h2 className={HEADING}>Tokens by role (sampled)</h2>
          <ShareBar
            label="Tokens by role"
            parts={[
              { label: `workers ${count(byRole.worker)}`, value: byRole.worker, swatch: ROLE_SWATCHES.worker },
              { label: `reviewers ${count(byRole.reviewer)}`, value: byRole.reviewer, swatch: ROLE_SWATCHES.reviewer },
              { label: `planner ${count(byRole.planner)}`, value: byRole.planner, swatch: ROLE_SWATCHES.planner },
            ]}
          />
          {unreported > 0 && <p className="mt-2 text-xs text-muted-foreground">{noTokenUsage(unreported)}</p>}
        </section>
        <section className={CARD}>
          <h2 className={HEADING}>How threads ended</h2>
          {endings.size === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">No thread has ended yet.</p>
          ) : (
            <table className="mt-1 text-sm">
              <tbody>
                {[...endings].sort((a, b) => b[1] - a[1]).map(([label, total]) => (
                  <tr key={label} data-ending={label}>
                    <td className="py-0.5 pr-6">{label}</td>
                    <td className="py-0.5 tabular-nums">{total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      {ended.length > 0 && (
        <details data-agents-history className={CARD}>
          <summary className="cursor-pointer text-sm">Ended threads ({ended.length})</summary>
          <AgentTable rows={ended} now={now} ended />
        </details>
      )}
    </div>
  );
}
