import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { useId, type ReactNode } from "react";
import { rpcContract, type BoardQuestDetail } from "../../shared/contract";
import type { Ask } from "../../shared/schema";
import { ExpandsMark, SkLines, clockTime } from "../kit";
import { Time } from "./common";
import { askOutcome } from "./finished";
import { PageGlyph } from "./glyphs";
import { usePanelState } from "./panel-state";
import { RuleRow } from "./record";
import { FoldLoad } from "./skeletons";
import "./finished.css";

/** A remembered fold of the record: the whole heading is its button, and it says what it holds and how many. */
export function RecordFold({ id, title, count, aside, word = false, open: initial, className = "", children, preview }: { id: string; title: ReactNode; count?: ReactNode; aside?: ReactNode; word?: boolean; open: boolean; className?: string; children: ReactNode; preview?: ReactNode }) {
  const [open, setOpen] = usePanelState(id, initial);
  const body = useId();
  return <section className={`tv-card tv-rec-fold ${open ? "open" : ""} ${className}`} data-fold={id} aria-labelledby={`${body}-h`}>
    <h2 className="tv-rec-fh" id={`${body}-h`}><button type="button" className="tv-rec-ft act" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
      <ExpandsMark open={open} /><span className="tv-rec-tt">{title}</span>{count !== undefined && <>{" "}<span className="tv-count">{count}</span></>}{aside && <>{" "}<span className="tv-colh-aside">{aside}</span></>}<span className="tv-sp" />{word && <>{" "}<span className="tv-rec-fw">{open ? "Hide" : "Show"}</span></>}
    </button></h2>
    {open ? <div id={body} className="tv-rec-fb">{children}</div> : preview && <div className="tv-rec-fb">{preview}</div>}
  </section>;
}

export function AsksRecord({ asks }: { asks: Ask[] }) {
  if (!asks.length) return <p className="tv-empty" data-empty>No asks on this quest.</p>;
  return <ol className="tv-li-list tv-rec-asks">{[...asks].sort((a, b) => a.createdAt - b.createdAt).map((a) => <li key={a.id}>
    <span className="tv-rec-ask"><span data-content>{a.question}</span><span className="m">{askOutcome(a)}</span>{a.answer?.note && <span className="tv-rec-note" data-content>“{a.answer.note}”</span>}</span>
    <Time at={a.answer?.at ?? a.createdAt} />
  </li>)}</ol>;
}

export function PlanRecord({ detail }: { detail: BoardQuestDetail }) {
  const plan = detail.quest.plan;
  const plans = [...detail.plans].sort((a, b) => b.version - a.version);
  const fromPlans = plans.flatMap((p) => p.fromSteer ? [{ id: p.fromSteer.routeId, at: p.fromSteer.at, text: p.fromSteer.text, version: p.version }] : []);
  const steers = [...fromPlans, ...detail.routes.filter((r) => r.kind === "steer" && !fromPlans.some((s) => s.id === r.id)).map((r) => ({ id: r.id, at: r.createdAt, text: r.summary, version: null as number | null }))].sort((a, b) => a.at - b.at);
  if (!plan && !plans.length) return <p className="tv-empty" data-empty>No quest map was drawn.</p>;
  return <div className="tv-rec-plan">
    {plan && <div className="tv-cell"><div className="lbl">Done when</div><p data-content>{plan.doneWhen}</p></div>}
    <div className="tv-cell"><div className="lbl">Plan versions</div><ol className="tv-li-list">{plans.map((p) => <li key={p.version}><span><b>v{p.version}</b> <span data-content>{p.changeNote ?? (p.version === 1 ? "first quest map" : p.goal)}</span>{p.fromSteer && <> <span className="tag tv-steer-tag">from your steer</span></>}</span><Time at={p.createdAt} /></li>)}</ol></div>
    {steers.length > 0 && <div className="tv-cell"><div className="lbl"><PageGlyph name="steer" />Your steers</div><ol className="tv-li-list">{steers.map((s) => <li key={s.id}><span data-content>“{s.text}”{s.version !== null && <span className="m"> · became v{s.version}</span>}</span><Time at={s.at} /></li>)}</ol></div>}
    {plan && plan.findings.length > 0 && <div className="tv-cell"><div className="lbl">Findings</div><ul className="tv-li-list">{plan.findings.map((f, i) => <li key={i}><span data-content>{f}</span></li>)}</ul></div>}
    {plan && plan.assumptions.length > 0 && <div className="tv-cell"><div className="lbl">Assumptions</div><ul className="tv-li-list">{plan.assumptions.map((f, i) => <li key={i}><span data-content>{f}</span></li>)}</ul></div>}
  </div>;
}

export function RulesAndAnchor({ detail, keeperName }: { detail: BoardQuestDetail; keeperName: string }) {
  const ledger = experimental_useRpcQuery({ contract: rpcContract, method: "ledger", input: { threadId: detail.quest.keeperThreadId } });
  const shown = detail.rules.filter((r) => r.active || r.source === "keeper-proposed");
  return <div className="tv-rec-rules">
    <div className="tv-cell"><div className="lbl"><PageGlyph name="rule" />Standing rules · {detail.rules.filter((r) => r.active).length} · sent every tick</div>{shown.length ? <ul className="tv-rules">{shown.map((rule) => <RuleRow key={rule.id} rule={rule} />)}</ul> : <p className="tv-empty" data-empty>No standing rules.</p>}</div>
    <div className="tv-cell"><div className="lbl"><PageGlyph name="anchor" />What {keeperName} is re-anchored with now{ledger.data?.lastReanchorAt ? <> · last <Time at={ledger.data.lastReanchorAt} /></> : ""}</div>{ledger.data ? <pre className="tv-code" data-content>{ledger.data.restatement || "No restatement recorded."}</pre> : ledger.error ? <p className="tv-problem" role="alert">Could not load the ledger: {ledger.error.message}</p> : <FoldLoad error={null} retry={ledger.refetch} label="the re-anchor text"><pre className="tv-code"><SkLines n={4} /></pre></FoldLoad>}</div>
  </div>;
}

