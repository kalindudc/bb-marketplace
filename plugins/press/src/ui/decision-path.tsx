import { useId } from "react";
import type { ThreadStatusDto } from "../contract";
import { Glyph } from "./glyphs";
import { timeText } from "./model";
import { decisionPath, decisionRows, type PanelState } from "./runway";

export function PressDecisionPath({ d, state, elapsed }: { d: ThreadStatusDto; state: PanelState; elapsed: number }) {
  const heading = useId();
  const rows = decisionRows(d);
  return <section className="pp-section" aria-labelledby={heading}>
    <h3 className="pp-h" id={heading} title="Press checks force at first, then vetoes, then points">Decision path</h3>
    <ol className="pp-gates">
      {decisionPath(d, state, elapsed).map((gate) => <li key={gate.id} className={`pp-gate is-${gate.state}`} data-gate={gate.id}>
        <span className="pp-gate-mark"><Glyph name={gate.mark} /></span>
        <span className="pp-gate-name">{gate.name}</span>
        <span className="pp-gate-val">{gate.lines.map((line) => <span key={line.text} className="pp-veto">
          {line.struck ? <s>{line.text}</s> : line.strong ? <em>{line.text}</em> : line.text}
        </span>)}</span>
      </li>)}
    </ol>
    <h4 className="pp-subh">Last decisions{rows.length > 0 && <span className="pp-meta">{rows.length}</span>}</h4>
    {rows.length === 0 ? <p className="pp-empty" data-empty>None yet</p>
      : <ol className="pp-decisions">{rows.map((row) => <li key={row.key} className={`pp-dec is-${row.decision}`} title={row.full}>
        <time dateTime={row.at}>{timeText(row.at)}</time>
        <span className="pp-dec-glyph"><Glyph name={row.decision === "veto" ? "slash" : "press"} /></span>
        <span className="pp-dec-what">{row.what}</span>
        <span className="pp-dec-detail">{row.detail}</span>
        <span className="pp-dec-pct">{row.percent}</span>
      </li>)}</ol>}
  </section>;
}
