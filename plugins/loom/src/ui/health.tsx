import type { ReactNode } from "react";
import type { ProjectHealth } from "../contract";
import { ShareBar, type Swatch } from "./charts";
import { formatDuration } from "../format";
import { CARD, HEADING, plural } from "./common";

const DONE: Swatch = { fill: "var(--success, currentColor)" };
const IN_FLIGHT: Swatch = { fill: "var(--primary, currentColor)" };
const BLOCKED: Swatch = { fill: "var(--destructive, currentColor)" };
const WAITING: Swatch = { fill: "var(--muted-foreground, currentColor)", opacity: 0.35 };
const USED: Swatch = { fill: "var(--warning, currentColor)" };
const count = (value: number) => value.toLocaleString("en-US");
const MINUTE = 60_000;

function paceNote({ perHour, remaining, etaMs }: ProjectHealth["pace"]): string {
  if (remaining === 0) return "nothing left";
  if (perHour === null) return `${remaining} left; not run in the last 14 days`;
  if (etaMs === null) return `${remaining} left; none done in the last 14 days`;
  return `${remaining} left: about ${formatDuration(Math.ceil(etaMs / MINUTE) * MINUTE)} of running at this pace`;
}

function Part({ id, title, value, note, children }: { id: string; title: string; value: ReactNode; note?: string; children?: ReactNode }) {
  return (
    <div data-health={id} className={CARD}>
      <h3 className={HEADING}>{title}</h3>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {children}
      {note !== undefined && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/** The project's health above its tabs. Pace is over the time the project ran in the last 14 days; the budget and deadline show only when the spec sets them. */
export function HealthStrip({ health }: { health: ProjectHealth }) {
  const { progress, pace, budget, deadline, capacity } = health;
  const small = (text: string) => <span className="text-xs font-normal text-muted-foreground">{text}</span>;
  return (
    <div data-health-strip className="grid shrink-0 grid-cols-2 gap-3 border-b border-border-seam px-4 py-3 lg:grid-cols-5">
      <Part id="progress" title="Progress" value={<>{progress.done} {small(`of ${progress.total} done`)}</>}>
        <ShareBar
          label="Progress"
          parts={[
            { label: `${progress.done} done`, value: progress.done, swatch: DONE },
            { label: `${progress.inFlight} in flight`, value: progress.inFlight, swatch: IN_FLIGHT },
            { label: `${progress.blocked} blocked`, value: progress.blocked, swatch: BLOCKED },
            { label: `${progress.queued} queued`, value: progress.queued, swatch: WAITING },
          ]}
        />
      </Part>
      <Part
        id="pace"
        title="Pace"
        value={pace.perHour === null ? "none yet" : pace.perHour >= 1 ? <>{pace.perHour.toFixed(1)}{small("/hour")}</> : <>{(pace.perHour * 24).toFixed(1)}{small("/day")}</>}
        note={paceNote(pace)}
      />
      {budget !== null && (
        <Part id="budget" title="Token budget" value={`${Math.round((budget.used / budget.max) * 100)}%`} note={`${count(budget.used)} of ${count(budget.max)} (sampled)`}>
          <ShareBar
            label="Token budget"
            parts={[
              { label: `${count(budget.used)} used`, value: Math.min(budget.used, budget.max), swatch: USED },
              { label: `${count(Math.max(0, budget.max - budget.used))} left`, value: Math.max(0, budget.max - budget.used), swatch: WAITING },
            ]}
          />
        </Part>
      )}
      {deadline !== null && <Part id="deadline" title="Deadline" value={deadline.daysLeft > 0 ? plural(deadline.daysLeft, "day") : "passed"} note={deadline.date} />}
      <Part
        id="capacity"
        title="Capacity"
        value={<>{capacity.workers}/{capacity.maxWorkers} {small("workers")}</>}
        note={`${capacity.reviewers}/${capacity.maxReviewers} reviewers · ${plural(capacity.readyWaiting, "ready ticket")} waiting for a slot`}
      />
    </div>
  );
}
