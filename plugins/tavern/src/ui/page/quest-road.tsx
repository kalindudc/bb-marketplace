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
    if (event.type !== "quest.stopping") continue;
    const step = PHASE_STEPS.find(p => p.id === event.data.phaseBeforeStop);
    if (step) return { position: step.id, proven: step.id };
  }
  let lastPhase: Phase | null = null;
  for (const event of events) {
    if (event.type !== "quest.phase") continue;
    const data = event.data as { phase?: unknown };
    const phase = typeof data.phase === "string" ? data.phase : /^Board quest moved to (scout|greenlight|build|check|wrap)$/.exec(event.text)?.[1];
    const step = PHASE_STEPS.find(p => p.id === phase);
    if (step) { lastPhase = step.id; break; }
  }
  const quest = detail.quest;
  const greenlight = detail.asks.some(a => a.boardQuestId === quest.id && a.kind === "greenlight" && a.planVersion === quest.planVersion && a.createdAt <= through && (a.state === "open" || a.state === "withdrawn" && a.withdrawnCause === "quest-stopped"));
  const position = quest.planVersion === 0 ? "scout"
    : quest.planVersion > 0 && quest.greenlitVersion !== quest.planVersion && greenlight ? "greenlight"
    : lastPhase === "check" || lastPhase === "wrap" ? lastPhase
    : quest.planVersion > 0 && quest.greenlitVersion === quest.planVersion ? "build"
    : null;
  return { position, proven: position };
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
