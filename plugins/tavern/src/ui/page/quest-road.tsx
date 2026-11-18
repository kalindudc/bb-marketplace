import type { BoardQuestDetail } from "../../shared/contract";
import type { Phase } from "../../shared/schema";
import { PageGlyph, type PageGlyphName } from "./glyphs";
import { PHASE_STEPS, phaseIndex, phaseWord } from "./model";

const ICONS: PageGlyphName[] = ["road-flag", "party", "road-hammer", "shield", "road-hearth"];

export function recordedStop(detail: BoardQuestDetail): { position: Phase | null; proven: Phase | null } {
  const stopped = detail.quest.phase === "stopped" || detail.quest.phase === "stopping";
  const through = stopped ? detail.quest.stoppingSince ?? detail.quest.endedAt ?? detail.quest.updatedAt : Infinity;
  const events = [...detail.events].filter(e => e.boardQuestId === detail.quest.id && e.at <= through).sort((a, b) => b.at - a.at || b.id - a.id);
  for (const event of events) {
    const phase = event.data.phase as { from?: Phase; to?: Phase } | undefined;
    let position = phase?.to === "stopping" ? phase.from : phase?.to;
    if (position === "held") {
      const hold = events.find(previous => previous.id < event.id && (previous.data.phase as { to?: Phase } | undefined)?.to === "held");
      position = (hold?.data.phase as { from?: Phase } | undefined)?.from;
      if (!position) return { position: null, proven: null };
    }
    if (position && !["stopped", "done", "stopping"].includes(position)) return { position, proven: position };
  }
  return { position: null, proven: null };
}

export function QuestRoad({ phase, stoppedAt = null, proven = null }: { phase: Phase; stoppedAt?: Phase | null; proven?: Phase | null }) {
  const stopped = phase === "stopped" || phase === "stopping";
  const at = stopped ? stoppedAt ? phaseIndex(stoppedAt) : -1 : phaseIndex(phase);
  const reached = stoppedAt ? at : proven ? phaseIndex(proven) : -1;
  const unknown = stopped && stoppedAt === null;
  return <div className={`tv-phase tv-phase-road-wrap ${stopped ? "stopped" : ""}`}>
    <ol className="tv-phase-road" aria-label={`Quest road: ${phaseWord(phase)}`}>
      {PHASE_STEPS.map((step, i) => {
        const state = stopped ? i === at ? "stopped here" : i <= reached ? "done" : "not reached" : i < at ? "done" : i === at ? "current" : "not reached";
        const current = i === at || phase === "done" && i === 4;
        const ahead = stopped ? i > reached : i > at;
        return <li key={step.id} className={`${state === "done" ? "done" : ""} ${current ? "current" : ""} ${ahead ? "ahead" : ""} ${state === "stopped here" ? "barrier" : ""}`} aria-current={current ? "step" : undefined} aria-label={`${step.label}, ${state}`}>
          <span className="tv-phase-road-marker" aria-hidden="true"><PageGlyph name={ICONS[i]!} size={16} /></span>
          <span className="tv-phase-road-label" aria-hidden="true">{step.label}{step.plain && <span className="anc">{step.plain}</span>}</span>
        </li>;
      })}
    </ol>
    {unknown && <p className="tv-phase-road-unknown">{phase === "stopped" ? "Stopped; the stop's position was not recorded" : "Stopping; the stop's position was not recorded"}</p>}
  </div>;
}
