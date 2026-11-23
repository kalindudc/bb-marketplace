import type { CSSProperties } from "react";
import type { ThreadStatusDto } from "../contract";
import { Glyph } from "./glyphs";
import { numberText, shortTokens } from "./model";
import type { Landing, PanelState } from "./runway";

interface Mark {
  id: "floor" | "soft" | "hard";
  at: number;
  value: string;
  word: string;
  wordShort: string;
}

/** About how wide a label is, in percent of the meter at 300 px. */
const LABEL_WIDTH = 14;

type PlacedMark = Mark & { label: boolean; alignEnd: boolean };

/**
 * Places each label right of its tick, or left of it near the end of the meter or beside a
 * neighbour. Force at is placed first, then compact at, then the floor; a label that fits
 * neither way is kept for screen readers only.
 */
export function thresholdMarks(d: Pick<ThreadStatusDto, "thresholds" | "window">): PlacedMark[] {
  const { softPercent, hardPercent, floorTokens } = d.thresholds;
  const marks: Mark[] = [
    { id: "hard", at: hardPercent, value: `${hardPercent}%`, word: "force at", wordShort: "force" },
    { id: "soft", at: softPercent, value: `${softPercent}%`, word: "compact at", wordShort: "compact" },
  ];
  if (d.window !== null && d.window > 0 && floorTokens > 0 && floorTokens < d.window) {
    marks.push({ id: "floor", at: floorTokens / d.window * 100, value: shortTokens(floorTokens), word: "floor", wordShort: "floor" });
  }
  const taken: Array<[number, number]> = [];
  const free = ([from, to]: [number, number]) => taken.every(([a, b]) => to <= a || from >= b);
  const placed = marks.map((mark): PlacedMark => {
    const right: [number, number] = [mark.at, mark.at + LABEL_WIDTH];
    const left: [number, number] = [mark.at - LABEL_WIDTH, mark.at];
    const fitsRight = mark.at <= 100 - LABEL_WIDTH && free(right);
    const span = fitsRight ? right : free(left) ? left : null;
    if (span) taken.push(span);
    return { ...mark, label: span !== null, alignEnd: span === left };
  });
  return placed.sort((a, b) => a.at - b.at);
}

export function PressGauge({ d, state, landing }: { d: ThreadStatusDto; state: PanelState; landing: Landing | null }) {
  const { hardPercent } = d.thresholds;
  const percent = d.percent === null ? null : Math.max(0, Math.min(100, d.percent));
  const shown = d.percent === null ? null : Math.round(d.percent);
  const marks = thresholdMarks(d);
  const freedFrom = landing?.outcome === "ok" && landing.fromPercent !== null && percent !== null && landing.fromPercent > percent
    ? Math.min(100, landing.fromPercent) : null;
  const valueText = shown === null ? undefined : `${shown}% used, ${numberText(d.tokens)} of ${numberText(d.window)} tokens`;
  return <section className="pp-gauge" aria-label="Context window">
    <div className="pp-head">
      <p className="pp-pct" aria-hidden="true">{shown === null ? "—" : <>{shown}<span className="pp-pct-unit">%</span></>}</p>
      <div className="pp-state">
        <p className={`pp-state-word tone-${state.tone}`} data-state={state.key}><Glyph name={state.glyph} /><span>{state.word}</span></p>
        {d.tokens !== null && <p className="pp-tokens">{numberText(d.tokens)} of {numberText(d.window)}</p>}
      </div>
    </div>
    <div className="pp-meter" {...(percent === null
      ? { "aria-label": "Context used: not reported" }
      : { role: "meter", "aria-label": "Context used", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": shown ?? 0, "aria-valuetext": valueText })}>
      <div className="pp-track">
        <div className="pp-zone-over" style={{ left: `${hardPercent}%` }} />
        <div className={`pp-fill${d.compacting || d.held ? " is-pressing" : ""}`}
          style={{ "--pp-hard": `${hardPercent}%`, "--pp-p": `${percent ?? 0}%` } as CSSProperties} />
        {freedFrom !== null && <div className="pp-freed" style={{ left: `${percent}%`, width: `${freedFrom - percent!}%` }} />}
        {marks.map((mark) => <span key={mark.id} className={`pp-tick${mark.id === "floor" ? " is-floor" : ""}`} style={{ left: `${mark.at}%` }} />)}
      </div>
    </div>
    <ul className="pp-marks" aria-label="Thresholds">
      {marks.map((mark) => <li key={mark.id} className={`pp-mark${mark.alignEnd ? " is-end" : ""}${mark.label ? "" : " pp-vh"}`} style={{ left: `${mark.at}%` }}>
        <b>{mark.value}</b>
        <span>{mark.wordShort}{mark.word !== mark.wordShort && <span className="pp-at">{mark.word.slice(mark.wordShort.length)}</span>}</span>
      </li>)}
    </ul>
  </section>;
}
