import { useId, useState } from "react";
import type { CompactionSummary, ThreadStatusDto } from "../contract";
import { Glyph } from "./glyphs";
import { clockText, numberText, pointName, reasonText, timeText } from "./model";
import { dropChart, historyOutcome, totalsText } from "./runway";
import { PressSummary } from "./summary";

/** Rows shown before "Show all"; the store keeps more than a glance needs. */
export const HISTORY_PAGE = 8;

function PressDropChart({ d, now }: { d: ThreadStatusDto; now: number }) {
  const chart = dropChart(d, now);
  if (chart === null) return null;
  const { softPercent: soft, hardPercent: hard } = d.thresholds;
  return <figure className="pp-chart">
    <div className="pp-chart-area" role="img" aria-label={chart.label}>
      <div className="pp-chart-plot">
        <div className="pp-chart-line" style={{ top: `${100 - hard}%` }}><span>{hard}%</span></div>
        <div className="pp-chart-line" style={{ top: `${100 - soft}%` }}><span>{soft}%</span></div>
        {chart.drops.map((drop) => <div key={drop.id} className="pp-drop" title={drop.label}
          style={{ left: `${drop.x}%`, top: `${100 - drop.before}%`, height: `${Math.max(0, drop.before - drop.after)}%` }} />)}
        {chart.now && <div className="pp-now" title={`now ${Math.round(chart.now.percent)}%`}
          style={{ left: `${chart.now.x}%`, top: `${100 - chart.now.percent}%` }} />}
      </div>
    </div>
    <figcaption className="pp-chart-axis"><span>{timeText(chart.start)}</span>{chart.now && <span>now {Math.round(chart.now.percent)}%</span>}</figcaption>
  </figure>;
}

function Fact({ name, children, wide }: { name: string; children: string; wide?: boolean }) {
  return <><dt>{name}</dt><dd className={wide ? "wide" : undefined}>{children}</dd></>;
}

function PressHistoryRow({ row, threadId }: { row: CompactionSummary; threadId: string }) {
  const [open, setOpen] = useState(false);
  const failed = row.outcome === "failed" || row.outcome === "cancelled";
  const freed = row.tokensBefore !== null && row.tokensAfter !== null ? row.tokensBefore - row.tokensAfter : null;
  return <li>
    <details className={`pp-hist${failed ? " is-failed" : ""}`} data-outcome={row.outcome} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <time dateTime={row.at}>{timeText(row.at)}</time>
        <span className="pp-hist-point">{pointName(row.point)}</span>
        <span className="pp-hist-tokens">{historyOutcome(row)}</span>
        <span className="pp-hist-ms">{row.ms === null ? "" : clockText(row.ms / 1000)}</span>
        <span className="pp-chev"><Glyph name="chev" /></span>
      </summary>
      <div className="pp-hist-body">
        <dl className="pp-facts">
          <Fact name="Before">{numberText(row.tokensBefore)}</Fact>
          <Fact name="After">{numberText(row.tokensAfter)}</Fact>
          <Fact name="Freed">{numberText(freed)}</Fact>
          <Fact name="Took">{row.ms === null ? "—" : clockText(row.ms / 1000)}</Fact>
          <Fact name="Why" wide>{reasonText(row.reason) ?? "—"}</Fact>
          <Fact name="Model" wide>{row.model ?? "thread model"}</Fact>
          {row.error !== null && <Fact name="Error" wide>{row.error}</Fact>}
        </dl>
        {open && row.hasSummary && <PressSummary threadId={threadId} compactionId={row.id} label={`Summary from ${timeText(row.at)}`} />}
        {!row.hasSummary && <p className="pp-summary-note">{row.outcome === "pending"
          ? "The summary arrives when this compaction lands." : "No summary was kept for this compaction."}</p>}
      </div>
    </details>
  </li>;
}

export function PressHistory({ d, now }: { d: ThreadStatusDto; now: number }) {
  const heading = useId();
  const [all, setAll] = useState(false);
  if (d.history.length === 0) {
    return <section className="pp-section" aria-labelledby={heading}>
      <h3 className="pp-h" id={heading}>History</h3>
      <p className="pp-empty" data-empty>No compactions yet</p>
    </section>;
  }
  const rows = all ? d.history : d.history.slice(0, HISTORY_PAGE);
  return <section className="pp-section" aria-labelledby={heading}>
    <h3 className="pp-h" id={heading}>History</h3>
    <p className="pp-totals">{totalsText(d)}</p>
    <PressDropChart d={d} now={now} />
    <ol className="pp-hist-list">{rows.map((row) => <PressHistoryRow key={row.id} row={row} threadId={d.threadId} />)}</ol>
    {d.history.length > HISTORY_PAGE && <div className="pp-summary-tools">
      <button type="button" className="pp-quiet" aria-expanded={all} onClick={() => setAll(!all)}>
        {all ? "Show fewer" : `Show all ${d.history.length}`}
      </button>
    </div>}
  </section>;
}
