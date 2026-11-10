import type { PhaseView } from "../phases";
import { CARD, HEADING } from "./common";

export function PhaseStrip({ phases }: { phases: PhaseView[] | null }) {
  if (phases === null) return null;
  return (
    <ol aria-label="Phases" className="flex flex-wrap gap-2 px-4 pt-3">
      {phases.map((phase, index) => (
        <li key={phase.ref} data-phase={phase.ref} className={`${CARD} min-w-36 flex-1 py-2 ${phase.state === "planned" ? "text-subtle-foreground" : "text-foreground"}`}>
          <p className={HEADING}>Phase {index + 1} · {phase.state}</p>
          <p className="mt-1 text-xs font-medium">{phase.state === "done" && <span className="text-success">✓ </span>}{phase.title}</p>
          {phase.state !== "planned" && <p className="mt-1 text-[11px] text-muted-foreground">{phase.tickets.done} of {phase.tickets.total} done{phase.tickets.cancelled > 0 ? ` · ${phase.tickets.cancelled} cancelled` : ""}</p>}
        </li>
      ))}
    </ol>
  );
}
