import type { ReactNode } from "react";
import { neededFor, summarize, wilsonLower, type Replayed } from "../../replay";
import { CARD } from "../common";
import { percent, plural } from "../format";
import { color } from "../insight-parts";
import { passes, type Tab } from "./model";

const R = 26;
const CIRCUMFERENCE = 2 * Math.PI * R;

/** How close the record is to proving its target: the 95% lower bound as a ring, the target as a tick. */
function Ring({ lower, target, needed, tab }: { lower: number | null; target: number; needed: number | null; tab: Tab }) {
  const value = Math.max(0, Math.min(1, lower ?? 0));
  const angle = ((target * 360 - 90) * Math.PI) / 180;
  const reached = lower !== null && lower >= target;
  const status = lower === null ? "nothing decided yet" : reached ? "proven" : needed === null ? "out of reach at this record" : `~${needed} more to go`;
  const label = `Proven at least ${percent(value)} of a ${percent(target)} target: ${status}`;
  return (
    <div data-proof-ring data-reached={reached} className="grid justify-items-center gap-0.5 text-center text-[11px] text-muted-foreground"
      title={tab === "comment"
        ? "How sure the record is that you would post what Shuttle posts: the 95% lower bound of how often you posted the findings that pass here. It only informs; Shuttle posts in the modes you choose."
        : "How sure the record is that you would approve what Shuttle approves: the 95% lower bound over every draft the rules approve here, comment drafts included, against what you did. It only informs; Shuttle approves in the modes you choose."}>
      <svg width={72} height={72} viewBox="0 0 72 72" role="img" aria-label={label}>
        <circle cx={36} cy={36} r={R} fill="none" strokeWidth={7} stroke="currentColor" className="text-muted" />
        <circle cx={36} cy={36} r={R} fill="none" strokeWidth={7} strokeLinecap="round" stroke={reached ? color(3) : color(1)} strokeDasharray={`${value * CIRCUMFERENCE} ${CIRCUMFERENCE}`} transform="rotate(-90 36 36)" />
        <line x1={36 + 21 * Math.cos(angle)} y1={36 + 21 * Math.sin(angle)} x2={36 + 31 * Math.cos(angle)} y2={36 + 31 * Math.sin(angle)} strokeWidth={2} stroke="currentColor" className="text-foreground" />
        <text x={36} y={40} textAnchor="middle" fill="currentColor" className="text-[13px] font-semibold text-foreground">{percent(value)}</text>
      </svg>
      <div>replayed record, target {percent(target)}</div>
      <div data-proof-status className={reached ? "text-success" : ""}>{status}</div>
    </div>
  );
}

function Fact({ value, children }: { value: number; children: ReactNode }) {
  return <span><b className="font-semibold tabular-nums text-foreground">{value}</b> {children}</span>;
}

/** The one number: how many drafts would post or be approved with the settings shown, against your saved ones; and the proof. */
export function Hero({ rows, base, tab, target }: { rows: readonly Replayed[]; base: readonly Replayed[]; tab: Tab; target: number }) {
  const count = rows.filter((row) => passes(row, tab)).length;
  const delta = count - base.filter((row) => passes(row, tab)).length;
  const sum = summarize(rows);
  const agreed = tab === "comment" ? sum.findingsAgreed : sum.approvalsAgreed;
  const against = tab === "comment" ? sum.findingsAgainst : sum.approvalsAgainst;
  const unchecked = rows.filter((row) => row.acts && row.unchecked).length;
  return (
    <section data-hero={tab} aria-label="Summary" className={`${CARD} grid grid-cols-1 items-center gap-x-6 gap-y-3 px-4 py-3.5 @3xl:grid-cols-[auto_minmax(0,1fr)_auto]`}>
      <div className="flex items-baseline gap-2">
        <span data-hero-count className="text-[2.75rem] font-semibold leading-none tabular-nums">{count}</span>
        <span className="text-sm text-muted-foreground">of {plural(rows.length, "draft")} {tab === "comment" ? "would post" : "would be approved"}</span>
        {delta !== 0 && (
          <span data-hero-delta className={`text-[13px] font-semibold tabular-nums ${delta > 0 ? "text-success" : "text-destructive-text"}`} title="Against your saved settings">
            {delta > 0 ? "+" : ""}{delta}
          </span>
        )}
      </div>
      <div data-hero-facts className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {tab === "comment" ? (
          <>
            <Fact value={sum.passing}>{sum.passing === 1 ? "finding passes" : "findings pass"}</Fact>
            <Fact value={agreed}>of them you posted</Fact>
            <Fact value={against}>you dropped</Fact>
          </>
        ) : (
          <>
            <Fact value={sum.actsAgreed}>you approved too</Fact>
            <Fact value={sum.actsPending}>undecided</Fact>
            {unchecked > 0 && <span title="Shuttle runs the verifier's blocking check on the diff before it approves; for these it has not run yet."><Fact value={unchecked}>before the blocking check</Fact></span>}
            <span title="Every draft the rules approve, comment drafts included, against what you did: the record behind the ring."><Fact value={agreed}>agree</Fact> · <Fact value={against}>against on the record</Fact></span>
          </>
        )}
      </div>
      <Ring lower={wilsonLower(agreed, agreed + against)} target={target} needed={neededFor(agreed, against, target)} tab={tab} />
    </section>
  );
}
