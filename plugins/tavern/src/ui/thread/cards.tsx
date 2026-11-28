import type { CSSProperties } from "react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { experimental_useRpcQuery, experimental_useRpcMutation, experimental_useAppPanel, useBbNavigate, useComposer, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { PlacementFacts } from "../kit/placement";
import { PlanChanges } from "../kit/plan-changes";
import { PlanOwnerMark, PlanRoad, planOwnerText, planSteps, stepNumber, type PlanStep } from "../kit/plan-steps";
import type { Registry } from "../kit/registry";
import { memberName } from "../../shared/member-name";
import { scheduleLabel } from "../../shared/member-schedule";
import { SHAPE_PATHS } from "../../shared/heraldry";
import { rpcContract, type BoardQuestDetail } from "../../shared/contract";
import { checkName, doneParts, planForecast, sentences } from "../../shared/plan-text";
import { settled } from "../../shared/waypoint";
import type { CharacterDef, ClassDef, Plan, Report } from "../../shared/schema";
import { voiceShown, AskCard, Clamp, Crest, levelsShown, reachedInParty, reachedWords, DecidedForYou, EvidenceList, FigureRow, taleFigures, ExpandsMark, Glyph, OpensMark, QuestMap, QueryState, ReportView, SkCrest, SkFigureRow, SkGlyph, SkLine, SkLines, SkMapNode, StatusPill, TimeAgo, VOCABULARY, Vocabulary, clockTime, levelFor, memberIdentity, questNames, readable, summaryNames, useRegistry, useSkeletonCount } from "../kit";
import type { ReportHeadlineNames } from "../../shared/report-headline";
import { TaleAction } from "../kit/tale-delivery";
import { TaleResults } from "../kit/tale-results";
import { WaiverRows } from "../kit/waiver-rows";
import { SummaryCard, summaryPath } from "../kit/summary-card";
import { REPORTS_TAB } from "./reports-tab";
import { glowVars } from "../kit";
import { useMoment } from "../kit/moment";
import { LEDGER_TAB } from "./tabs";
import { revealAsk } from "./state";
import { useStudyCard, type StudyCard } from "./study-cards";
import "./skeletons.css";

type Identity = { cls: ClassDef; character: CharacterDef };
const REPORT_WORD = { done: "done", "needs-decision": "needs your decision", blocked: "blocked", checkpoint: "checkpoint" } as const;

import { MemberEstimate } from "../kit/member-estimate";

/** A member's report in short: the headline, two lines of outcome, the evidence count with "View report ›", and the two-part confidence. Voice appears only on good news. */
export function ReportCard({ report, who, onOpen, names, onView, voice = true, pullRequests, measurement }: { pullRequests?: import("../../shared/pull-request").PullRequest[]; report: Report; who?: Identity | null; onOpen?: (threadId: string) => void; names?: ReportHeadlineNames; onView?: () => void; voice?: boolean; measurement?: StudyCard }) {
  const probe = useStudyCard(measurement);
  const name = who ? `${who.character.name}` : "A member";
  return (
    <article ref={probe} className={`tavern tcard report r-${report.status}`} data-tavern-report-at={report.deliveredAt ?? report.createdAt} aria-label={`Report from ${name}: ${REPORT_WORD[report.status]}`}>
      <header className="tc-h">
        {who && onOpen ? <button type="button" className="who who-btn act" title={`Open ${name}’s thread`} onClick={() => onOpen(report.memberThreadId)}><Crest {...who} size={18} /><span className="who-t"><b>{name}</b><span className="anc">{who.cls.label} · {who.cls.plain}</span></span><OpensMark /></button>
          : who ? <span className="who"><Crest {...who} size={18} /><span className="who-t"><b>{name}</b><span className="anc">{who.cls.label} · {who.cls.plain}</span></span></span> : <b>Report</b>}
        {report.waypointId && <span className="m">waypoint {report.waypointId.replace(/^w/, "")}</span>}
        <span className="tc-sp" />
        <StatusPill status={report.status}>{REPORT_WORD[report.status]}</StatusPill>
        <TimeAgo at={report.createdAt} />
      </header>
      <ReportView report={report} pullRequests={pullRequests} names={names ?? {}} compact voice={voice} {...(onView ? { onView } : {})} />
      <MemberEstimate confidence={report.confidence} />
      {voice && report.status === "done" && report.voice && <p className="voice">{report.voice}</p>}
    </article>
  );
}

function PlanMapFold({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const content = useId();
  return <div className="qm-mapfold">
    <button type="button" className="btn" aria-expanded={open} aria-controls={content} onClick={() => setOpen(!open)}>
      <Glyph name="quest-map" />Quest map<ExpandsMark open={open} />
    </button>
    <div id={content} hidden={!open}>{open && children}</div>
  </div>;
}

function PlanDoneWhen({ text }: { text: string }) {
  const { criteria, checks, never, neverSource } = doneParts(text);
  const [open, setOpen] = useState(false);
  const heading = useId(), commands = useId();
  return <section className="qm-done" aria-labelledby={heading} data-part="DoneWhen">
    <div className="qm-charter-line"><h4 id={heading}>Done when</h4><span className="m">{criteria.length} {criteria.length === 1 ? "criterion" : "criteria"}</span></div>
    {criteria.length > 0 && <ul className="qm-criteria">{criteria.map((criterion, i) => <li key={i}>{criterion.split(/\s+/).length > 60 ? <Clamp text={criterion} lines={3} /> : <span data-content>{criterion}</span>}</li>)}</ul>}
    {checks.length > 0 && <div className="qm-checks">
      <b><Glyph name="check" size={12} />Checks</b>
      <span className="qm-chips">{checks.map((command, i) => <code key={i} title={command}>{checkName(command)}</code>)}</span>
      <button type="button" className="lnk-btn act" aria-expanded={open} aria-controls={commands} onClick={() => setOpen(!open)}>Exact commands<ExpandsMark open={open} /></button>
      <div id={commands} hidden={!open}>{open && <pre data-content><code>{checks.join("\n")}</code></pre>}</div>
    </div>}
    {never.length > 0 && <div className="qm-never" role="group" aria-label="Never" aria-description={neverSource.join(" ")} title={neverSource.join(" ")}><b><Glyph name="block" size={12} />Never</b><span data-content>{never.join(" · ")}</span></div>}
  </section>;
}

function CharterRow({ label, summary, open, onToggle, children }: { label: string; summary: ReactNode; open?: boolean; onToggle?: () => void; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const content = useId();
  const shown = open ?? expanded;
  return <div className="qm-charter-row">
    <button type="button" className="qm-charter-line" aria-controls={content} aria-expanded={shown} onClick={onToggle ?? (() => setExpanded(!expanded))}>
      <span>{label}</span>{" "}<span className="qm-answer">{summary}</span><ExpandsMark open={shown} />
    </button>
    <div className="qm-charter-body" id={content} hidden={!shown}>{children}</div>
  </div>;
}

const counted = (n: number, label: string) => `${n} ${label}${n === 1 ? "" : "s"}`;
const checkGroups = { warden: "Warden", keeper: "Keeper", you: "You", none: "No check" } as const;

function PermanentSlot({ permanent }: { permanent: NonNullable<Plan["party"][number]["permanent"]> }) {
  return <>
    <span className="qm-permanent m">Permanent: {permanent.why}</span>
    {permanent.schedules?.map((schedule, index) => <span className="qm-permanent m" key={index} data-content>{scheduleLabel(schedule)} (server time) · {schedule.duty}</span>)}
  </>;
}

function PlanCharter({ quest, plan, previous, registry, sealed, onOpenAsk }: { quest: BoardQuestDetail["quest"]; plan: Plan; previous: Plan | undefined; registry: Registry | undefined; sealed: boolean; onOpenAsk: (id: string) => void }) {
  const road = planSteps(quest, plan, previous, registry);
  const [orderOpen, setOrderOpen] = useState(false);
  const [toYouOpen, setToYouOpen] = useState(plan.questions.length > 0);
  const [jump, setJump] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const id = useId();
  const stepId = (idOfStep: string) => `${id}-${idOfStep}`;
  useLayoutEffect(() => {
    if (!jump || !orderOpen) return;
    const root = sheet.current?.getRootNode() as Document | ShadowRoot | undefined;
    const target = root?.getElementById(jump);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "center" });
    setJump(null);
  }, [jump, orderOpen]);
  const jumpButton = (step: PlanStep, label: string) => <button key={step.w.id} type="button" className="btn qm-jump" aria-label={`${label} ${stepNumber(step.w.id)}`} onClick={() => { setOrderOpen(true); setJump(stepId(step.w.id)); }}>{stepNumber(step.w.id)}</button>;

  const [lead, ...goal] = sentences(plan.goal);
  const moves = road.steps.filter(s => s.owner.kind === "you");
  const outside = road.steps.filter(s => s.owner.kind === "outside" || s.owner.kind === "permanent" && !s.owner.slot);
  const flags = road.steps.filter(s => s.warning);
  const standing = road.slots.filter(s => s.slot.permanent);
  const done = road.steps.filter(s => settled(s.w)).length;
  const doing = road.steps.filter(s => s.w.state === "doing").length;
  const owners = new Map<string, { owner: PlanStep["owner"]; count: number }>();
  for (const { owner } of road.steps) {
    const key = owner.slot ? `slot:${road.slots.indexOf(owner.slot)}` : `${owner.kind}:${owner.name}`;
    const group = owners.get(key);
    if (group) group.count++;
    else owners.set(key, { owner, count: 1 });
  }
  const who = [...owners.values()].sort((a, b) => Number(b.owner.kind === "you") - Number(a.owner.kind === "you"));
  const checks = Object.entries(checkGroups).map(([kind, label]) => ({ kind, label, steps: road.steps.filter(s => s.kind === kind) }));
  const wardens = road.slots.filter(s => s.slot.classId === "warden").map(s => ({ ...s,
    checks: road.steps.filter(step => step.kind === "warden" && s.slot.waypointIds.includes(step.w.id)).map(step => step.w.id),
  }));
  const running = [...standing.map(s => ({ kind: "permanent" as const, name: s.name, slot: s })), ...outside.map(s => s.owner)];
  return <div className="qm-charter" ref={sheet}>
    <section className="qm-goal" aria-label="Goal" data-part="PlanGoal"><p data-content><b>{lead}</b></p>{goal.length > 0 && <Clamp text={goal.join(" ")} lines={2} />}</section>
    <PlanDoneWhen text={plan.doneWhen} />
    <CharterRow label="Who" summary={<>
      <span className="qm-owner-bar" aria-hidden="true">{who.flatMap(({ owner, count }, i) => Array.from({ length: count }, (_, j) => <i key={`${i}:${j}`} className={`owner-${owner.kind}${i > 0 && j === 0 ? " group-start" : ""}`} />))}</span>
      {who.map(({ owner, count }, i) => <span key={i} className="qm-person" style={{ "--i": i } as CSSProperties}><PlanOwnerMark owner={owner} size={12} /><b>{owner.name}</b>{` ${count} `}</span>)}
    </>}>
      <section className="qm-party" aria-label={sealed ? "Formed party (team)" : "Proposed party (team)"}>
        <h4><Vocabulary word="party" /> · {sealed ? "formed" : "proposed"}</h4>
        {road.slots.length === 0 ? <p className="m">No party slots</p> : <ul role="list">{road.slots.map((s, i) => <li key={i} style={{ "--i": i } as CSSProperties}>
          <PlanOwnerMark owner={{ kind: s.slot.permanent ? "permanent" : "member", name: s.name, slot: s }} />
          <span data-content><b>{s.name}</b>{s.name !== s.className && <span className="anc"> {s.className}{s.cls ? ` · ${s.cls.plain}` : ""}</span>}{!s.character && <span className="m"> · On hire</span>}
            {s.slot.waypointIds.length > 0 && <span className="m"> · {s.slot.classId === "warden" ? "checks " : "steps "}{s.slot.waypointIds.map(stepNumber).join(", ")}</span>}
            {s.slot.permanent && <PermanentSlot permanent={s.slot.permanent} />}
          </span>
        </li>)}</ul>}
      </section>
    </CharterRow>
    <CharterRow label="Order" summary={<span>{counted(road.steps.length, "step")} · {counted(road.stages.length, "stage")}{done > 0 && ` · ${done} done`}{doing > 0 && ` · ${doing} in progress`}</span>} open={orderOpen} onToggle={() => setOrderOpen(!orderOpen)}>
      <PlanRoad road={road} stepId={stepId} onOpenAsk={onOpenAsk} compact={plan.version > 1} />
    </CharterRow>
    <CharterRow label="Checks" summary={<span>{checks.filter(g => g.steps.length > 0).map(g => `${g.label} ${g.steps.length}`).join(" · ")}</span>}>
      <ul className="qm-lines" role="list">
        {wardens.map((s, i) => <li key={i}><PlanOwnerMark owner={{ kind: s.slot.permanent ? "permanent" : "member", name: s.name, slot: s }} /><span><b>{s.name}</b> checks {s.checks.map(stepNumber).join(", ") || "no assigned steps"}</span></li>)}
        {checks.map(g => {
          const steps = g.steps.filter(s => g.kind !== "warden" || !wardens.some(w => w.checks.includes(s.w.id)));
          return steps.length > 0 && <li key={g.kind}><Glyph name={g.kind === "none" ? "close" : g.kind === "you" ? "check" : "shield"} /><span><b>{g.label}</b> · {steps.map(s => stepNumber(s.w.id)).join(", ")}</span></li>;
        })}
      </ul>
    </CharterRow>
    <CharterRow label="To you" summary={<span>{counted(plan.questions.length, "question")} · {counted(moves.length, "move")}</span>} open={toYouOpen} onToggle={() => setToYouOpen(!toYouOpen)}>
      <ul className="qm-lines qm-qs" role="list" aria-label="Comes back to you">
        {plan.questions.length === 0 && <li><Glyph name="ask" /><span>No open questions</span></li>}
        {plan.questions.map((q, i) => <li key={q.id}><span className="qn">{i + 1}</span><span className="qx"><span data-content>{q.text}</span><span className="m" data-content>{q.recommended !== null && q.options[q.recommended] ? `recommends ${q.options[q.recommended]}` : q.options.join(" or ")} · {q.reversible ? "reversible" : "needs your decision"}</span></span></li>)}
        {moves.length > 0 && <li><PlanOwnerMark owner={{ kind: "you", name: "You" }} size={14} /><span className="qm-jumps"><b>Your moves</b>{moves.map(s => jumpButton(s, "Your move: waypoint"))}</span></li>}
        <li><Glyph name="report" /><span className="qm-review"><b>Review load</b><Clamp text={plan.reviewLoad} lines={1} /></span></li>
        <li><Glyph name="wax-seal" /><span>Production steps and anything sent as you still ask you.</span></li>
      </ul>
    </CharterRow>
    <CharterRow label="Keeps running" summary={<>
      {running.map((owner, i) => <span key={i} className="qm-person"><PlanOwnerMark owner={owner} size={12} /><b>{owner.name}</b>{" "}</span>)}
      {flags.length > 0 && <span className="qm-warn"><Glyph name="st-stale" size={12} />{counted(flags.length, "step")} to check</span>}
      {!running.length && !flags.length && <span className="m">Nothing</span>}
    </>}>
      <section className="qm-running" aria-label="Keeps running after the quest">
        {running.length === 0 && flags.length === 0 ? <p className="m">No permanent roles or outside steps are listed.</p> : <ul className="qm-lines" role="list">
          {standing.map((s, i) => <li key={i}><PlanOwnerMark owner={{ kind: "permanent", name: s.name, slot: s }} /><span><b>{s.name}</b><PermanentSlot permanent={s.slot.permanent!} /></span></li>)}
          {outside.map(s => <li key={s.w.id}><PlanOwnerMark owner={s.owner} /><span className="qm-jumps">{jumpButton(s, "Go to waypoint")}<span>{s.w.title}<span className="qm-permanent m">{planOwnerText(s.owner)}</span></span></span></li>)}
          {flags.length > 0 && <li><Glyph name="st-stale" /><div><span className="qm-jumps"><b>To check</b>{flags.map(s => jumpButton(s, "Check waypoint"))}</span><p className="m">Mentions {Array.from(new Set(flags.map(s => s.warning))).join(", ")}. These steps may set up work that outlasts the quest, but no permanent member owns them.</p></div></li>}
        </ul>}
      </section>
    </CharterRow>
  </div>;
}

export function QuestMapCard({ detail, version, measurement }: { detail: BoardQuestDetail; version: number | null; measurement?: StudyCard }) {
  const undo = experimental_useRpcMutation({ contract: rpcContract, method: "undoDecision" });
  const answer = experimental_useRpcMutation({ contract: rpcContract, method: "answerAsk" });
  const registry = useRegistry();
  const composer = useComposer();
  const [error, setError] = useState<unknown>(null);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [decidedOpen, setDecidedOpen] = useState(false);
  const findingsId = useId(), decidedId = useId();
  const plan = version === null ? detail.quest.plan : detail.plans.find(p => p.version === version);
  const card = useRef<HTMLElement>(null);
  const probe = useStudyCard(plan ? measurement : undefined, card);
  const currentChecks = !!plan && detail.quest.checkPlanVersion === plan.version && detail.quest.planVersion === plan.version && detail.quest.phase !== "greenlight";
  const noStaffingGreenlight = currentChecks && detail.quest.greenlitVersion === null;
  const isSealed = !!plan && !noStaffingGreenlight && ((detail.quest.greenlitVersion ?? 0) >= plan.version || currentChecks);
  // The seal stamps and the party is dealt once per device: when sealed here, or the first time this device sees it sealed.
  const moment = useMoment(card, { surface: `thread:${detail.quest.keeperThreadId ?? "chat"}`, kind: "party forms", rememberKey: `moment:seal:${detail.quest.id}:${plan?.version ?? 0}`, active: isSealed, className: "mo-seal", ms: 1200 });
  const { data: authority } = experimental_useRpcQuery({
    contract: rpcContract, method: "questAuthority", input: { boardQuestId: detail.quest.id },
    enabled: !isSealed && plan?.version === detail.quest.planVersion && plan.party.some(slot => slot.classId === "smith"),
  });
  const review = authority?.review;
  if (!plan) return <p className="tavern problem" role="alert">This plan version is not available.</p>;
  const current = plan.version === detail.quest.planVersion;
  const greenlight = detail.asks.find(a => a.kind === "greenlight" && a.state === "open");
  const sealed = isSealed;
  const quest = current ? detail.quest : { ...detail.quest, plan, waypoints: plan.waypoints.map(w => ({ ...w, state: "planned" as const, ownerMember: null, evidenceCount: 0, verifiedBy: null, rejectedReason: null })) };
  const decided = detail.decisions.filter(d => d.source === "keeper" || d.checkChange);
  const reviewLead = greenlight?.effect?.type === "lead-plan" ? greenlight : null;
  const waitsForParent = detail.quest.leadPlanLane === "keeper";
  const formOption = reviewLead ? null : greenlight?.options.find(o => o.recommended) ?? greenlight?.options[0];
  const redirect = () => { composer.insert(`About ${detail.quest.title}, plan v${plan.version}: `); composer.focus(); };
  const mode = sealed || noStaffingGreenlight ? "live" : "plan";
  const forecast = planForecast(plan);
  const showScope = !noStaffingGreenlight && !reviewLead && !waitsForParent;
  const sealLabel = answer.isPending ? "Sealing…" : greenlight?.effect?.type === "greenlight" && greenlight.effect.requiresExplicit ? "Approve the updated plan" : "Form the party (greenlight)";
  const openAsk = (id: string) => revealAsk(quest.keeperThreadId, id);
  return (
    <article ref={probe} {...moment} className={`tavern tcard qmcard ${sealed ? "sealed" : ""}`} style={glowVars(`map:${detail.quest.id}`) as CSSProperties} aria-label={`Quest map${noStaffingGreenlight ? "" : " (greenlight)"}: ${detail.quest.title}, plan v${plan.version}`} data-part="QuestMapCard">
      <header className="qm-h">
        <span className="qm-t"><b>{noStaffingGreenlight ? VOCABULARY.map[0] : <Vocabulary word="map" />}</b><span className="qm-q" title={detail.quest.title}>{detail.quest.short || detail.quest.title} · plan v{plan.version}</span></span>
        {plan.fromSteer && <span className="qm-steer" title={`From your steer: ${plan.fromSteer.text}`}><Glyph name="route" size={12} /><span>from your steer, {clockTime(plan.fromSteer.at)}</span></span>}
        <span className="tc-sp" />
        {sealed ? <span className="sealmark"><Glyph name="wax-seal" size={16} /><span>Sealed · party formed</span></span> : noStaffingGreenlight ? <span className="qm-wait">No staffing greenlight needed</span> : current ? <span className="qm-wait">{waitsForParent ? "Hiring Keeper decides" : "Waits for your seal"}</span> : <StatusPill status="superseded">superseded</StatusPill>}
      </header>
      <PlanChanges plan={plan} plans={detail.plans} quest={quest} registry={registry.data} />
      <PlanCharter key={`charter:${plan.version}`} quest={quest} plan={plan} previous={detail.plans.find(p => p.version === plan.version - 1)} registry={registry.data} sealed={sealed} onOpenAsk={openAsk} />
      <div className="qm-facts"><span className="qm-forecast"><b>Forecast</b><Clamp text={forecast} lines={1} /></span><span className="qm-more">
        {plan.findings.length + plan.assumptions.length > 0 && <button type="button" className="lnk-btn act" aria-expanded={findingsOpen} aria-controls={findingsId} onClick={() => setFindingsOpen(!findingsOpen)}>{plan.findings.length + plan.assumptions.length} findings and assumptions<ExpandsMark open={findingsOpen} /></button>}
        {decided.length > 0 && <button type="button" className="lnk-btn act" aria-expanded={decidedOpen} aria-controls={decidedId} onClick={() => setDecidedOpen(!decidedOpen)}><Glyph name="decided" size={12} /><span>{decided.filter(d => !d.undone).length} decided for you</span><ExpandsMark open={decidedOpen} /></button>}
      </span></div>
      {plan.findings.length + plan.assumptions.length > 0 && <div id={findingsId} className="qm-fold" hidden={!findingsOpen}>{findingsOpen && <ul className="dots">{plan.findings.map((f, i) => <li key={`f${i}`} data-content>{f}</li>)}{plan.assumptions.map((f, i) => <li key={`a${i}`} className="m" data-content>Assumes: {f}</li>)}</ul>}</div>}
      {decided.length > 0 && <div id={decidedId} hidden={!decidedOpen}>{decidedOpen && <DecidedForYou decisions={decided} pending={undo.isPending} onUndo={id => void undo.mutate({ decisionId: id }).catch(setError)} />}</div>}
      <PlanMapFold key={`map:${plan.version}`}>
        <QuestMap quest={quest} mode={mode} dealt={sealed} stretch={!sealed} showChecks drawn onOpenAsk={openAsk} />
        <div className="qm-key m"><span><i className="k crest" />agent</span><span><i className="k you" />your move</span><span><i className="k gate" />outside owner</span><span>dependency order, not a schedule</span></div>
      </PlanMapFold>
      <QueryState error={error} />
      {current && !sealed && <>
        {review && review.used >= review.total && plan.party.some(slot => slot.classId === "smith") &&
          <p className="qm-reply" role="status">Your review queue is full ({review.used} of {review.total}). Smith hires wait for space or your one-review allowance.</p>}
        {showScope && <p className="qm-reply m">Or reply in chat, e.g. “seal, 1 Monday”.</p>}
        <footer className="qm-f">
          {noStaffingGreenlight ? null : reviewLead && detail.quest.keeperThreadId ? <button type="button" className="btn" onClick={() => revealAsk(detail.quest.keeperThreadId, reviewLead.id)}>Review lead plan and limits</button> : greenlight && formOption ? <button type="button" className="btn pri seal" aria-label={sealLabel === "Form the party (greenlight)" ? `Approve: ${sealLabel}` : sealLabel} disabled={answer.isPending} onClick={() => void answer.mutate({ askId: greenlight.id, optionId: formOption.id, note: null, via: "chat" }).catch(setError)}><Glyph name="wax-seal" /><span className="qm-full">{sealLabel}</span><span className="qm-short" aria-hidden="true">{answer.isPending ? "Sealing…" : "Approve"}</span></button> : waitsForParent ? <span className="m small">Staffing waits for the hiring Keeper’s decision.</span> : <span className="m small">The greenlight ask is not open yet.</span>}
          <button type="button" className="btn" aria-label="Redirect in chat" onClick={redirect}><span className="qm-full">Redirect in chat</span><span className="qm-short" aria-hidden="true">Redirect</span></button>
          {showScope && <span className="qm-scope m">Approves the party and these checks.</span>}
        </footer>
      </>}
      {!sealed && !current && <p className="m small qm-old">This plan was superseded; it cannot be greenlit here.</p>}
    </article>
  );
}

const id = z.string().min(1).max(120);
export const DIRECTIVE_IDS = ["tavern-questmap", "tavern-ask", "tavern-reports", "tavern-ledger", "tavern-party", "tavern-errand", "tavern-tale", "tavern-summary"] as const;
export type DirectiveKind = typeof DIRECTIVE_IDS[number];
export function directiveAttributes(kind: DirectiveKind, attributes: Readonly<Record<string, string>>) {
  if (kind === "tavern-reports") return z.object({ ids: z.string().min(1).transform(value => value.split(",").map(s => s.trim())).pipe(z.array(id).min(1).max(30)) }).safeParse(attributes);
  if (kind === "tavern-ask" || kind === "tavern-summary") return z.object({ id }).safeParse(attributes);
  if (kind === "tavern-errand") return z.object({ member: id }).safeParse(attributes);
  return z.object({ quest: id, version: z.string().regex(/^[1-9]\d{0,5}$/).transform(Number).optional() }).safeParse(attributes);
}

export function DirectiveCard({ kind, ...props }: PluginMessageDirectiveProps & { kind: DirectiveKind }) {
  const parsed = directiveAttributes(kind, props.attributes);
  if (!parsed.success) return <code>{props.source}</code>;
  const source = { threadId: props.message.threadId, messageId: props.message.id };
  if (kind === "tavern-summary") return <SummaryDirective {...source} id={props.attributes.id!} />;
  if (kind === "tavern-ask") return <AskPointer {...source} askId={props.attributes.id!} />;
  if (kind === "tavern-reports" || kind === "tavern-errand") return <ReportDigest {...source} ids={kind === "tavern-reports" ? props.attributes.ids!.split(",").map(s => s.trim()) : []} memberThreadId={kind === "tavern-errand" ? props.attributes.member! : null} />;
  return <QuestDirective {...source} kind={kind} questId={props.attributes.quest!} version={props.attributes.version ? Number(props.attributes.version) : null} />;
}

type CardSource = Pick<StudyCard, "threadId" | "messageId">;

function SummaryDirective({ threadId, messageId, id }: CardSource & { id: string }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "summary", input: { id, threadId } });
  const navigate = useBbNavigate();
  const mark = experimental_useRpcMutation({ contract: rpcContract, method: "markSummariesSeen" });
  const [acknowledged, setAcknowledged] = useState<string>();
  const probe = useStudyCard(query.data?.summary ? { threadId, messageId, cardId: id, cardType: "summary", questId: query.data.summary.boardQuestId } : undefined);
  if (!query.data) return <div className="tavern tcard"><QueryState error={query.error} loading={query.isLoading} label="the Keeper’s answer" retry={() => void query.refetch()} /></div>;
  const { summary, ask, handBack } = query.data;
  if (!summary) return <p className="tavern m">This answer is not available in this thread.</p>;
  const seen = summary.seen || acknowledged === summary.id;
  return <SummaryCard summary={{ ...summary, seen }} ask={ask} handBack={handBack} chat cardRef={probe}>
    <footer className="tv-sum-actions"><button type="button" className="lnk-btn act" onClick={() => navigate.toPluginPanel("tavern", { subPath: summaryPath(summary.boardQuestId, summary.id) })}>Open on the quest page<OpensMark /></button>
      {!seen && summary.correctedBy === null && <button type="button" className="btn sm" disabled={mark.isPending} onClick={() => void mark.mutate({ boardQuestId: summary.boardQuestId, ids: [summary.id] }).then(() => setAcknowledged(summary.id)).catch(() => { /* The refusal is shown below. */ })}>OK</button>}
      {acknowledged === summary.id && <span className="m" role="status">Seen</span>}
    </footer><QueryState error={mark.error} />
  </SummaryCard>;
}

const cardKey = (kind: string, id: string) => `skel:thread:card:${kind.replace(/^tavern-/, "")}:${id}`;
const CARD_LABEL: Record<DirectiveKind, string> = { "tavern-questmap": "the quest map", "tavern-ask": "the ask", "tavern-reports": "the reports", "tavern-ledger": "the ledger change", "tavern-party": "the party", "tavern-errand": "the errand result", "tavern-tale": "the tale", "tavern-summary": "the Keeper’s answer" };
/** What a quest card's skeleton counts: waypoints on a map, the party on the party and tale cards, and a ledger change's lines. */
function cardRows(kind: DirectiveKind, detail: BoardQuestDetail, version: number | null) {
  if (kind === "tavern-questmap") return ((version === null ? detail.quest.plan : detail.plans.find(p => p.version === version))?.waypoints.length ?? 0);
  if (kind === "tavern-ledger") return (version === null ? detail.quest.plan : detail.plans.find(p => p.version === version))?.fromSteer ? 2 : 1;
  return detail.quest.members.filter(m => !m.errand).length;
}

/** A chat card while its quest loads, in the card's own classes: header, then the body the card draws, sized by `rows`. */
function SkQuestCard({ kind, rows }: { kind: DirectiveKind; rows: number }) {
  const head = <header className="qm-h"><span className="qm-t"><b><SkLine w="9ch" /></b><span className="qm-q"><SkLine w="22ch" /></span></span><span className="tc-sp" /><span className="lnk-btn"><SkLine w="12ch" /></span></header>;
  if (kind === "tavern-questmap") return <div className="tavern tcard qmcard">
    {head}
    <p className="qm-goal"><SkLine w="78%" /></p>
    <div className="sk-qmap">{Array.from({ length: Math.max(1, rows) }, (_, i) => <SkMapNode key={i} w={150} />)}</div>
    <div className="qm-facts"><SkLine w="16ch" /><SkLine w="14ch" /></div>
  </div>;
  if (kind === "tavern-party") return <div className="tavern tcard k-tavern-party">
    {head}
    <ul className="deal">{Array.from({ length: Math.max(1, rows) }, (_, i) => <li key={i} className="mcard"><span className="who who-btn"><SkCrest size={26} /><span className="who-t"><SkLine w="8ch" /></span></span><span className="mc-w"><SkLine w="90%" /><SkLine w="55%" className="sk-wrap" /></span><span className="voice"><SkLine w="70%" /></span></li>)}</ul>
  </div>;
  if (kind === "tavern-tale") return <div className="tavern tcard k-tavern-tale">
    {head}
    <span className="lg-clamp still l2 tale-lead"><span className="ct"><SkLines n={2} /></span></span>
    <div className="tale-foot"><SkFigureRow compact count={4} /><ul className="tale-crests">{Array.from({ length: Math.max(1, rows) }, (_, i) => <li key={i}><span className="tc-crest"><SkCrest size={22} /></span></li>)}</ul></div>
  </div>;
  return <div className={`tavern tcard k-${kind}`}>
    {head}
    <p className="lc-note"><SkLine w="92%" /><SkLine w="48%" className="sk-wrap" /></p>
    {rows > 1 && <p className="m small"><SkLine w="90%" /><SkLine w="40%" className="sk-wrap" /></p>}
  </div>;
}

function SkReportCard({ confidence }: { confidence: boolean }) {
  return <div className="tavern tcard report"><div className="tc-h"><span className="who who-btn"><SkCrest size={18} /><span className="who-t"><SkLine w="8ch" /></span></span><span className="tc-sp" /><span className="tag"><SkLine w="5ch" /></span><time className="ago"><SkLine w="5ch" /></time></div>
    <div className="rv compact"><p className="rv-lead"><SkLine w="92%" /><SkLine w="40%" className="sk-wrap" /></p><span className="lg-clamp still l2 rv-out"><span className="ct"><SkLine w="88%" /><SkLine w="60%" className="sk-wrap" /></span></span><p className="rv-foot"><SkLine w="30%" /></p></div>
    {confidence && <div className="conf"><span className="conf-l"><SkLine w="9ch" /></span><span className="conf-t"><SkLine w="30ch" /></span></div>}
    <p className="voice"><SkLine w="40%" /></p>
  </div>;
}
/** The open ask's pointer line, neutral: the attention colour would claim an ask before it is known to be open. */
function SkPointer() {
  return <div className="tavern pointer sk-pointer"><SkGlyph size={13} /><span className="pk"><SkLine w="8ch" /></span><span className="pq"><SkLine w="70%" /></span><span className="lnk-btn"><SkLine w="11ch" /></span></div>;
}
function SkReceipt() {
  return <div className="tavern receipt"><SkGlyph size={16} /><SkLine w="8ch" /><SkLine w="14ch" /><span className="m"><SkLine w="20ch" /></span></div>;
}

function AskPointer({ threadId, messageId, askId }: CardSource & { askId: string }) {
  const ledger = experimental_useRpcQuery({ contract: rpcContract, method: "ledger", input: { threadId } });
  const hide = experimental_useRpcMutation({ contract: rpcContract, method: "setHidden" });
  const [error, setError] = useState<unknown>(null);
  const ask = ledger.data?.asks.find(a => a.id === askId);
  const probe = useStudyCard(ask ? { threadId, messageId, cardId: askId, cardType: "ask", questId: ask.boardQuestId } : undefined);
  // One ask, drawn as this device last saw it: the open pointer (1) or the answered receipt (2).
  const shape = useSkeletonCount(cardKey("ask", askId), ask ? (ask.state === "open" ? 1 : 2) : undefined, 1);
  if (!ask) return <div className="tavern"><QueryState error={ledger.error} loading={ledger.isLoading} retry={() => void ledger.refetch()} label="the ask" skeleton={shape === 2 ? <SkReceipt /> : <SkPointer />} />{ledger.data && <p className="m small">This ask is no longer on the ledger.</p>}</div>;
  if (ask.state !== "open") return <AskCard ask={ask} cardRef={probe} />;
  return (
    <div ref={probe} className="tavern pointer" role="group" aria-label={`Needs you: ${ask.question}`} data-ask>
      <Glyph name="ask" size={13} />
      <span className="pk">Needs you</span>
      <span className="pq" title={ask.question}>{ask.question}</span>
      <button type="button" className="lnk-btn act" onClick={() => void hide.mutate({ threadId, hidden: false }).then(() => revealAsk(threadId, askId)).catch(setError)} title="Open this ask in the Tavern row above the composer">Answer below<ExpandsMark open={false} /></button>
      <QueryState error={error} />
    </div>
  );
}

function useIdentities(threadIds: string[]) {
  const registry = useRegistry();
  const crests = experimental_useRpcQuery({ contract: rpcContract, method: "crests", input: { threadIds: [...new Set(threadIds)] } });
  return (threadId: string): Identity | null => { const c = crests.data?.crests.find(x => x.threadId === threadId); return c && registry.data ? memberIdentity(registry.data, c) : null; };
}

function ReportDigest({ threadId, messageId, ids, memberThreadId }: CardSource & { ids: string[]; memberThreadId: string | null }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "reports", input: { ids, memberThreadId } });
  const navigate = useBbNavigate();
  const reports = query.data?.reports ?? [];
  const who = useIdentities(reports.map(r => r.memberThreadId));
  const count = query.data ? reports.length : ids.length;
  const panel = experimental_useAppPanel();
  const questIds = [...new Set(reports.map(r => r.boardQuestId))];
  // A digest knows its reports from its ids; an errand does not, so it draws what this device last saw for errands.
  const errandRows = useSkeletonCount("skel:thread:card:errand", memberThreadId && query.data ? reports.length : undefined, 1);
  const rows = memberThreadId ? errandRows : ids.length;
  // How many of the card's reports carried a confidence line, so those report shapes draw it too.
  const confident = useSkeletonCount(memberThreadId ? "skel:thread:card:errand:conf" : `skel:thread:card:reports:${ids[0] ?? ""}:${ids.length}:conf`, query.data ? reports.filter(r => r.confidence).length : undefined, 0);
  return (
    <section className="tavern digest" data-tavern-report-thread={threadId} aria-label={memberThreadId ? "Errand result" : `${count} report${count === 1 ? "" : "s"} from the party`}>
      <h3 className="dg-h">{memberThreadId ? <><Vocabulary word="errand" /> · result</> : <>{count} report{count === 1 ? "" : "s"} from the party</>}</h3>
      <QueryState error={query.error} loading={query.isLoading} retry={() => void query.refetch()} label={memberThreadId ? "the errand result" : "the reports"} skeleton={<>{Array.from({ length: Math.min(8, rows) }, (_, i) => <SkReportCard key={i} confidence={i < confident} />)}</>} />
      {questIds.map(qid => <QuestReports source={{ threadId, messageId }} cardType={memberThreadId ? "errand" : "reports"} pullRequests={query.data?.pullRequests} key={qid ?? "errand"} questId={qid} reports={reports.filter(r => r.boardQuestId === qid)} who={who} onOpen={tid => navigate.toThread(tid)} onView={r => panel.openTab({ tab: REPORTS_TAB, params: { memberThreadId: r.memberThreadId, questId: r.boardQuestId, reportId: r.id } })} />)}
      {query.data && reports.length === 0 && <p className="m small">0 reports are available yet.</p>}
    </section>
  );
}

/** Reports about one board quest (or errands, with no quest), named from that quest's party so no raw id shows. */
function QuestReports({ questId, source, cardType, reports, who, onOpen, onView, pullRequests }: { source: CardSource; cardType: "errand" | "reports"; pullRequests?: import("../../shared/pull-request").PullRequest[]; questId: string | null; reports: Report[]; who: (threadId: string) => Identity | null; onOpen: (threadId: string) => void; onView: (report: Report) => void }) {
  const detail = experimental_useRpcQuery({ contract: rpcContract, method: "boardQuest", input: { id: questId ?? "" }, enabled: questId !== null });
  const registry = useRegistry();
  const quest = detail.data?.quest ?? null;
  return <>{reports.map(r => <ReportCard key={r.id} report={r} measurement={{ ...source, cardType, cardId: r.id, questId }} pullRequests={pullRequests} who={who(r.memberThreadId)} onOpen={onOpen} onView={() => onView(r)} voice={voiceShown(registry.data)} names={registry.data ? summaryNames({ threadId: r.memberThreadId }, quest?.members ?? [], registry.data, quest ? [quest] : [], detail.data?.reports ?? reports) : {}} />)}</>;
}

function QuestDirective({ kind, questId, version, ...source }: CardSource & { kind: DirectiveKind; questId: string; version: number | null }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "boardQuest", input: { id: questId } });
  const registry = useRegistry();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const card = useRef<HTMLElement>(null);
  const measurement = { ...source, cardType: kind.replace(/^tavern-/, "") as StudyCard["cardType"], cardId: kind === "tavern-questmap" || kind === "tavern-ledger" ? String(version ?? query.data?.quest.planVersion ?? "current") : questId, questId };
  const probe = useStudyCard(query.data && kind !== "tavern-questmap" ? measurement : undefined, card);
  const deal = useMoment(card, { surface: `thread:${query.data?.quest.keeperThreadId ?? "chat"}`, kind: "party forms", rememberKey: `moment:deal:${questId}`, active: kind === "tavern-party" && !!query.data, className: "mo-deal", ms: 1200 });
  const rows = useSkeletonCount(cardKey(kind, questId), query.data ? cardRows(kind, query.data, version) : undefined, kind === "tavern-ledger" ? 1 : 3);
  if (!query.data) return <div className="tavern"><QueryState error={query.error} loading={query.isLoading} retry={() => void query.refetch()} label={CARD_LABEL[kind]} skeleton={<SkQuestCard kind={kind} rows={rows} />} /></div>;
  const detail = query.data;
  if (kind === "tavern-questmap") return <QuestMapCard detail={detail} version={version} measurement={measurement} />;
  const openQuest = <button type="button" className="lnk-btn act" onClick={() => navigate.toPluginPanel("tavern", { subPath: `${detail.quest.phase === "done" ? "tale" : "quest"}/${detail.quest.id}` })}>Open the quest page<OpensMark /></button>;
  let content: ReactNode;
  if (kind === "tavern-party") {
    content = <>
      <header className="qm-h"><span className="qm-t"><b>The party forms</b> <span className="anc">team</span><span className="qm-q">{detail.quest.title}</span></span><span className="tc-sp" />{openQuest}</header>
      <ul className="deal">{detail.quest.members.filter(m => !m.errand).map((m, i) => { const idn = registry.data ? memberIdentity(registry.data, m) : null; const lv = registry.data ? levelFor(registry.data, m.characterId, m.classId) : null; const wp = detail.quest.waypoints.find(w => w.id === m.waypointId); return (
        <li key={m.threadId} className="mcard" style={{ ["--i" as string]: i }}>
          {idn ? <button type="button" className="who who-btn act" title={`Open ${idn.character.name}’s thread${lv ? ` · ${lv.words}` : ""}`} onClick={() => navigate.toThread(m.threadId)}><Crest {...idn} size={26} level={lv?.level} /><span className="who-t"><b>{idn.character.name}</b><span className="anc">{idn.cls.label} · {idn.cls.plain}</span></span><OpensMark /></button> : <b>{m.characterId}</b>}
          <span className="mc-w">{wp ? `Waypoint ${wp.id.replace(/^w/, "")} · ${wp.title}` : m.title ?? ""}</span>
          <PlacementFacts placement={m.placement} memberName={memberName(m, registry.data ?? { classes: [], characters: [] })} variant="card" />
          {voiceShown(registry.data) && m.state !== "failed" && m.state !== "waiting" && m.strikes === 0 && idn && <span className="voice">{idn.character.lines.hired}</span>}
        </li>
      ); })}</ul>
    </>;
  } else if (kind === "tavern-tale") {
    const party = detail.quest.members.filter(m => !m.errand);
    const reached = registry.data && levelsShown(registry.data) ? reachedInParty(detail, party, registry.data.characters).map(x => ({ id: x.member.threadId, text: reachedWords(x.name, x.reached) })) : [];
    const openTale = <button type="button" className="lnk-btn act" title="Open the tale page: the full path, who made and verified each waypoint, and every report" onClick={() => navigate.toPluginPanel("tavern", { subPath: `tale/${detail.quest.id}` })}>Open the tale<OpensMark /></button>;
    content = <>
      <header className="qm-h"><span className="qm-t"><b><Vocabulary word="tale" /></b><span className="qm-q" title={detail.quest.title}>{detail.quest.title}</span></span><span className="tc-sp" />{openTale}</header>
      {detail.tale ? <Clamp className="tale-lead" lines={2} text={registry.data ? readable(detail.tale.outcome, questNames(detail.quest, registry.data, detail.reports)) : detail.tale.outcome} /> : <p className="m tale-lead">No tale was written for this quest; its reports are on the tale page.</p>}
      <TaleResults results={detail.tale?.results} compact />
      {detail.tale?.closure === "closed-early" && <div className="tale-next"><b>Closed early at your request</b><WaiverRows items={detail.tale.waivers ?? []} final /></div>}
      {detail.tale?.next?.length ? <div className="tale-next"><p><b>What to do now: </b><TaleAction text={detail.tale.next[0]!} tale={detail.tale} threadId={detail.quest.keeperThreadId} /></p>{detail.tale.next.length > 1 && <button type="button" className="lnk-btn act" onClick={() => navigate.toPluginPanel("tavern", { subPath: `tale/${detail.quest.id}` })}>{detail.tale.next.length - 1} more</button>}</div> : null}
      <div className="tale-foot">
        <FigureRow compact figures={taleFigures(detail)} />
        <ul className="tale-crests" aria-label="The party (team)">{party.map(m => { const idn = registry.data ? memberIdentity(registry.data, m) : null; const lv = registry.data ? levelFor(registry.data, m.characterId, m.classId) : null; return idn ? <li key={m.threadId}><button type="button" className="tc-crest act" title={`Open ${idn.character.name}’s thread · ${idn.cls.label} (${idn.cls.plain})${lv ? ` · ${lv.words}` : ""}`} aria-label={`Open ${idn.character.name}’s thread, ${idn.cls.label} (${idn.cls.plain})${lv && lv.notches ? `, level ${lv.level}` : ""}`} onClick={() => navigate.toThread(m.threadId)}><Crest {...idn} size={24} level={lv?.level} /></button></li> : null; })}</ul>
      </div>
      {reached.length > 0 && <ul className="tale-lvls" aria-label="Levels reached on this quest">{reached.map(r => <li key={r.id}>{r.text}</li>)}</ul>}
    </>;
  } else {
    const plan = version === null ? detail.quest.plan : detail.plans.find(p => p.version === version);
    const prev = plan ? detail.plans.find(p => p.version === plan.version - 1) : undefined;
    content = <>
      <header className="qm-h"><span className="qm-t"><Glyph name="book" size={13} /><b>Ledger changed</b><span className="qm-q">{detail.quest.title} · plan {prev ? `v${prev.version} → ` : ""}v{plan?.version ?? version}</span></span>{plan?.fromSteer && <span className="qm-steer"><Glyph name="route" size={12} /><span>from your steer, {clockTime(plan.fromSteer.at)}</span></span>}<span className="tc-sp" /><button type="button" className="lnk-btn act" onClick={() => panel.openTab({ tab: LEDGER_TAB })}>Open the ledger<OpensMark /></button></header>
      <p className="lc-note">{plan?.changeNote ?? "Plan recorded."}</p>
      {plan?.fromSteer && <p className="m small">You said: “{plan.fromSteer.text}”</p>}
    </>;
  }
  return <article ref={probe} {...(kind === "tavern-party" ? deal : {})} className={`tavern tcard k-${kind}`} style={glowVars(`${kind}:${questId}`) as CSSProperties}>{content}</article>;
}
