import { Glyph } from "./glyphs";
import { clockText } from "./model";
import type { NextStep, PanelState } from "./runway";

export function PressNextStep({ step, state, now, title }: { step: NextStep; state: PanelState; now: number; title?: string }) {
  const elapsed = step.since === null ? null : Math.max(0, (now - Date.parse(step.since)) / 1000);
  const expected = step.expectedMs === null ? null : step.expectedMs / 1000;
  return <section className={`pp-next tone-${step.tone}`} aria-label="What Press does next" title={title}>
    <span className={`pp-next-glyph tone-${step.tone}`}><Glyph name={step.glyph} /></span>
    <p className="pp-next-title">{step.title}</p>
    {elapsed === null ? <span /> : <p className="pp-next-elapsed" aria-hidden="true">{clockText(elapsed)}</p>}
    {step.sub && <p className="pp-next-sub">{step.sub}</p>}
    {elapsed !== null && expected !== null && <div className="pp-progress" role="progressbar" aria-label="Elapsed against the expected time"
      aria-valuemin={0} aria-valuemax={Math.round(expected)} aria-valuenow={Math.min(Math.round(elapsed), Math.round(expected))}
      aria-valuetext={`${clockText(elapsed)} of ${step.expectedWord} ${clockText(expected)}`}>
      <span style={{ width: `${Math.min(100, elapsed / expected * 100)}%` }} />
    </div>}
    {/* Mounted for the panel's lifetime so a state change is announced; it never carries a ticking clock. */}
    <p className="pp-vh" role="status" aria-live="polite">{announcement(step, state)}</p>
  </section>;
}

/** The state word, plus the title where it holds no number that changes while a turn runs. */
export function announcement(step: NextStep, state: PanelState): string {
  if (state.key === "safe" || state.key === "range" || state.key === "unknown") return `${state.word}.`;
  const title = step.countdown === null ? step.title : step.title.replace(/ in \d+(?::\d\d)+$/u, " after the wait");
  return `${state.word}. ${title}.`;
}
