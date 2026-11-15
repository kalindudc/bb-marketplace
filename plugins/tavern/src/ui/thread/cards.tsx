import type { CSSProperties } from "react";
import { useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { experimental_useRpcQuery, experimental_useRpcMutation, experimental_useAppPanel, useBbNavigate, useComposer, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { rpcContract, type BoardQuestDetail } from "../../shared/contract";
import type { CharacterDef, ClassDef, Report } from "../../shared/schema";
import { voiceShown, AskCard, Clamp, Crest, levelsShown, reachedInParty, reachedWords, DecidedForYou, EvidenceList, FigureRow, taleFigures, ExpandsMark, Glyph, OpensMark, QuestMap, QueryState, ReportView, SkCrest, SkFigureRow, SkGlyph, SkLine, SkLines, SkMapNode, StatusPill, TimeAgo, Vocabulary, clockTime, levelFor, memberIdentity, questNames, readable, summaryNames, useRegistry, useSkeletonCount } from "../kit";
import type { ReportHeadlineNames } from "../../shared/report-headline";
import { REPORTS_TAB } from "./reports-tab";
import { glowVars } from "../kit";
import { useMoment } from "../kit/moment";
import { LEDGER_TAB } from "./tabs";
import { revealAsk } from "./state";
import "./skeletons.css";

type Identity = { cls: ClassDef; character: CharacterDef };
const REPORT_WORD = { done: "done", "needs-decision": "needs your decision", blocked: "blocked" } as const;

/** A member's report in short: the headline, two lines of outcome, the evidence count with "View report ›", and the two-part confidence. Voice appears only on good news. */
export function ReportCard({ report, who, onOpen, names, onView, voice = true }: { report: Report; who?: Identity | null; onOpen?: (threadId: string) => void; names?: ReportHeadlineNames; onView?: () => void; voice?: boolean }) {
  const name = who ? `${who.character.name}` : "A member";
  return (
    <article className={`tavern tcard report r-${report.status}`} aria-label={`Report from ${name}: ${REPORT_WORD[report.status]}`}>
      <header className="tc-h">
        {who && onOpen ? <button type="button" className="who who-btn act" title={`Open ${name}’s thread`} onClick={() => onOpen(report.memberThreadId)}><Crest {...who} size={18} /><span className="who-t"><b>{name}</b><span className="anc">{who.cls.label} · {who.cls.plain}</span></span><OpensMark /></button>
          : who ? <span className="who"><Crest {...who} size={18} /><span className="who-t"><b>{name}</b><span className="anc">{who.cls.label} · {who.cls.plain}</span></span></span> : <b>Report</b>}
        {report.waypointId && <span className="m">waypoint {report.waypointId.replace(/^w/, "")}</span>}
        <span className="tc-sp" />
        <StatusPill status={report.status}>{REPORT_WORD[report.status]}</StatusPill>
        <TimeAgo at={report.createdAt} />
      </header>
      <ReportView report={report} names={names ?? {}} compact voice={voice} {...(onView ? { onView } : {})} />
      {report.confidence && <div className="conf"><span className="conf-l">Confidence</span><span className="conf-t">matches intent {report.confidence.intent}% · safe to ship {report.confidence.safe}%</span><span className="conf-b" aria-hidden="true"><i style={{ width: `${report.confidence.intent}%` }} /></span><span className="conf-b safe" aria-hidden="true"><i style={{ width: `${report.confidence.safe}%` }} /></span></div>}
      {voice && report.status === "done" && report.voice && <p className="voice">{report.voice}</p>}
    </article>
  );
}

export function QuestMapCard({ detail, version }: { detail: BoardQuestDetail; version: number | null }) {
  const undo = experimental_useRpcMutation({ contract: rpcContract, method: "undoDecision" });
  const answer = experimental_useRpcMutation({ contract: rpcContract, method: "answerAsk" });
  const registry = useRegistry();
  const composer = useComposer();
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState<null | "findings" | "decided">(null);
  const plan = version === null ? detail.quest.plan : detail.plans.find(p => p.version === version);
  const card = useRef<HTMLElement>(null);
  const isSealed = !!plan && detail.quest.greenlitVersion !== null && detail.quest.greenlitVersion >= plan.version;
  // The seal stamps and the party is dealt once per device: when sealed here, or the first time this device sees it sealed.
  const moment = useMoment(card, { surface: `thread:${detail.quest.keeperThreadId ?? "chat"}`, kind: "party forms", rememberKey: `moment:seal:${detail.quest.id}:${plan?.version ?? 0}`, active: isSealed, className: "mo-seal", ms: 1200 });
  if (!plan) return <p className="tavern problem" role="alert">This plan version is not available.</p>;
  const current = plan.version === detail.quest.planVersion;
  const greenlight = detail.asks.find(a => a.kind === "greenlight" && a.state === "open");
  const sealed = isSealed;
  const quest = current ? detail.quest : { ...detail.quest, plan, waypoints: plan.waypoints.map(w => ({ ...w, state: "planned" as const, ownerMember: null, evidenceCount: 0, verifiedBy: null, rejectedReason: null })) };
  const decided = detail.decisions.filter(d => d.source === "keeper");
  const formOption = greenlight?.options.find(o => o.recommended) ?? greenlight?.options[0];
  const unknownLead = plan.waypoints.filter(w => w.leadTime === null).length;
  const redirect = () => { composer.insert(`About ${detail.quest.title}, plan v${plan.version}: `); composer.focus(); };
  return (
    <article ref={card} {...moment} className={`tavern tcard qmcard ${sealed ? "sealed" : ""}`} style={glowVars(`map:${detail.quest.id}`) as CSSProperties} aria-label={`Quest map (greenlight): ${detail.quest.title}, plan v${plan.version}`} data-part="QuestMapCard">
      <header className="qm-h">
        <span className="qm-t"><b><Vocabulary word="map" /></b><span className="qm-q">{detail.quest.title} · plan v{plan.version}</span></span>
        {plan.fromSteer && <span className="qm-steer" title={`From your steer: ${plan.fromSteer.text}`}><Glyph name="route" size={12} /><span>from your steer, {clockTime(plan.fromSteer.at)}</span></span>}
        <span className="tc-sp" />
        {sealed ? <span className="sealmark"><Glyph name="wax-seal" size={16} /><span>Sealed · party formed</span></span> : current ? <span className="qm-wait">Waits for your seal</span> : <StatusPill status="superseded">superseded</StatusPill>}
      </header>
      <p className="qm-goal"><b>{plan.goal}</b><span className="m"> · done when {plan.doneWhen.charAt(0).toLowerCase() + plan.doneWhen.slice(1)}</span></p>
      <QuestMap quest={quest} mode={sealed ? "live" : "plan"} dealt={sealed} />
      <div className="qm-key m"><span><i className="k crest" />agent</span><span><i className="k you" />your move</span><span><i className="k gate" />outside owner</span><span>left to right is order, not a schedule</span></div>
      <div className="qm-cols">
        <section className="qm-qs" aria-label="Questions for you">
          <h4>{plan.questions.length ? `${plan.questions.length} question${plan.questions.length === 1 ? "" : "s"} for you` : "No open questions"}</h4>
          <ol>{plan.questions.map((q, i) => <li key={q.id}><span className="qn">{i + 1}</span><span className="qx"><span className="qtx">{q.text}</span><span className="m">{q.recommended !== null && q.options[q.recommended] ? `recommends ${q.options[q.recommended]}` : q.options.join(" or ")} · {q.reversible ? "reversible" : "needs your decision"}</span></span></li>)}</ol>
        </section>
        <section className="qm-party" aria-label="Proposed party (team)">
          <h4><Vocabulary word="party" /> · {sealed ? "formed" : "proposed"}</h4>
          <ul>{plan.party.map((p, i) => { const cls = registry.data?.classes.find(c => c.id === p.classId); const character = registry.data?.characters.find(c => c.id === p.characterId); return <li key={i} style={{ ["--i" as string]: i }}>{cls && character ? <Crest cls={cls} character={character} size={18} /> : <span className="tag">?</span>}<span className="pn"><b>{character?.name ?? "On hire"}</b> <span className="anc">{cls ? `${cls.label} · ${cls.plain}` : p.classId}</span></span><span className="pw m">{p.waypointIds.map(w => w.replace(/^w/, "")).join(", ")}</span></li>; })}</ul>
        </section>
      </div>
      <div className="qm-facts"><span><b>Forecast</b> {plan.eta ?? (unknownLead ? `pending ${unknownLead} unknown lead time${unknownLead === 1 ? "" : "s"}` : "no ETA given")}</span><span><b>Review load</b> {plan.reviewLoad}</span><span className="qm-more">
        {plan.findings.length + plan.assumptions.length > 0 && <button type="button" className="lnk-btn act" aria-expanded={more === "findings"} onClick={() => setMore(more === "findings" ? null : "findings")}>{plan.findings.length + plan.assumptions.length} findings and assumptions<ExpandsMark open={more === "findings"} /></button>}
        {decided.length > 0 && <button type="button" className="lnk-btn act" aria-expanded={more === "decided"} onClick={() => setMore(more === "decided" ? null : "decided")}><Glyph name="decided" size={12} /><span>{decided.filter(d => !d.undone).length} decided for you</span><ExpandsMark open={more === "decided"} /></button>}
      </span></div>
      {more === "findings" && <div className="qm-fold"><ul className="dots">{plan.findings.map((f, i) => <li key={`f${i}`}>{f}</li>)}{plan.assumptions.map((f, i) => <li key={`a${i}`} className="m">Assumes: {f}</li>)}</ul></div>}
      {more === "decided" && <DecidedForYou decisions={decided} pending={undo.isPending} onUndo={id => void undo.mutate({ decisionId: id }).catch(setError)} />}
      <QueryState error={error} />
      {current && !sealed && (
        <footer className="qm-f">
          {greenlight && formOption ? <button type="button" className="btn pri seal" disabled={answer.isPending} onClick={() => void answer.mutate({ askId: greenlight.id, optionId: formOption.id, note: null, via: "chat" }).catch(setError)}><Glyph name="wax-seal" />{answer.isPending ? "Sealing…" : "Form the party (greenlight)"}</button> : <span className="m small">The greenlight ask is not open yet.</span>}
          <button type="button" className="btn" onClick={redirect}>Redirect in chat</button>
          <span className="qm-scope m">Staffs the party only. Production steps and anything sent as you still ask you. Or reply in chat, e.g. “seal, 1 Monday”.</span>
        </footer>
      )}
      {!sealed && !current && <p className="m small qm-old">This plan was superseded; it cannot be greenlit here.</p>}
    </article>
  );
}

const id = z.string().min(1).max(120);
export const DIRECTIVE_IDS = ["tavern-questmap", "tavern-ask", "tavern-reports", "tavern-ledger", "tavern-party", "tavern-errand", "tavern-tale"] as const;
export type DirectiveKind = typeof DIRECTIVE_IDS[number];
export function directiveAttributes(kind: DirectiveKind, attributes: Readonly<Record<string, string>>) {
  if (kind === "tavern-reports") return z.object({ ids: z.string().min(1).transform(value => value.split(",").map(s => s.trim())).pipe(z.array(id).min(1).max(30)) }).safeParse(attributes);
  if (kind === "tavern-ask") return z.object({ id }).safeParse(attributes);
  if (kind === "tavern-errand") return z.object({ member: id }).safeParse(attributes);
  return z.object({ quest: id, version: z.string().regex(/^[1-9]\d{0,5}$/).transform(Number).optional() }).safeParse(attributes);
}

export function DirectiveCard({ kind, ...props }: PluginMessageDirectiveProps & { kind: DirectiveKind }) {
  const parsed = directiveAttributes(kind, props.attributes);
  if (!parsed.success) return <code>{props.source}</code>;
  if (kind === "tavern-ask") return <AskPointer threadId={props.message.threadId} askId={props.attributes.id!} />;
  if (kind === "tavern-reports" || kind === "tavern-errand") return <ReportDigest ids={kind === "tavern-reports" ? props.attributes.ids!.split(",").map(s => s.trim()) : []} memberThreadId={kind === "tavern-errand" ? props.attributes.member! : null} />;
  return <QuestDirective kind={kind} questId={props.attributes.quest!} version={props.attributes.version ? Number(props.attributes.version) : null} />;
}

const cardKey = (kind: string, id: string) => `skel:thread:card:${kind.replace(/^tavern-/, "")}:${id}`;
const CARD_LABEL: Record<DirectiveKind, string> = { "tavern-questmap": "the quest map", "tavern-ask": "the ask", "tavern-reports": "the reports", "tavern-ledger": "the ledger change", "tavern-party": "the party", "tavern-errand": "the errand result", "tavern-tale": "the tale" };
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

function AskPointer({ threadId, askId }: { threadId: string; askId: string }) {
  const ledger = experimental_useRpcQuery({ contract: rpcContract, method: "ledger", input: { threadId } });
  const hide = experimental_useRpcMutation({ contract: rpcContract, method: "setHidden" });
  const [error, setError] = useState<unknown>(null);
  const ask = ledger.data?.asks.find(a => a.id === askId);
  // One ask, drawn as this device last saw it: the open pointer (1) or the answered receipt (2).
  const shape = useSkeletonCount(cardKey("ask", askId), ask ? (ask.state === "open" ? 1 : 2) : undefined, 1);
  if (!ask) return <div className="tavern"><QueryState error={ledger.error} loading={ledger.isLoading} retry={() => void ledger.refetch()} label="the ask" skeleton={shape === 2 ? <SkReceipt /> : <SkPointer />} />{ledger.data && <p className="m small">This ask is no longer on the ledger.</p>}</div>;
  if (ask.state !== "open") return <AskCard ask={ask} />;
  return (
    <div className="tavern pointer" role="group" aria-label={`Needs you: ${ask.question}`} data-ask>
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

function ReportDigest({ ids, memberThreadId }: { ids: string[]; memberThreadId: string | null }) {
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
    <section className="tavern digest" aria-label={memberThreadId ? "Side quest result (errand)" : `${count} report${count === 1 ? "" : "s"} from the party`}>
      <h3 className="dg-h">{memberThreadId ? <><Vocabulary word="errand" /> · result</> : <>{count} report{count === 1 ? "" : "s"} from the party</>}</h3>
      <QueryState error={query.error} loading={query.isLoading} retry={() => void query.refetch()} label={memberThreadId ? "the errand result" : "the reports"} skeleton={<>{Array.from({ length: Math.min(8, rows) }, (_, i) => <SkReportCard key={i} confidence={i < confident} />)}</>} />
      {questIds.map(qid => <QuestReports key={qid ?? "errand"} questId={qid} reports={reports.filter(r => r.boardQuestId === qid)} who={who} onOpen={tid => navigate.toThread(tid)} onView={r => panel.openTab({ tab: REPORTS_TAB, params: { memberThreadId: r.memberThreadId, questId: r.boardQuestId, reportId: r.id } })} />)}
      {query.data && reports.length === 0 && <p className="m small">0 reports are available yet.</p>}
    </section>
  );
}

/** Reports about one board quest (or errands, with no quest), named from that quest's party so no raw id shows. */
function QuestReports({ questId, reports, who, onOpen, onView }: { questId: string | null; reports: Report[]; who: (threadId: string) => Identity | null; onOpen: (threadId: string) => void; onView: (report: Report) => void }) {
  const detail = experimental_useRpcQuery({ contract: rpcContract, method: "boardQuest", input: { id: questId ?? "" }, enabled: questId !== null });
  const registry = useRegistry();
  const quest = detail.data?.quest ?? null;
  return <>{reports.map(r => <ReportCard key={r.id} report={r} who={who(r.memberThreadId)} onOpen={onOpen} onView={() => onView(r)} voice={voiceShown(registry.data)} names={registry.data ? summaryNames({ threadId: r.memberThreadId }, quest?.members ?? [], registry.data, quest ? [quest] : [], detail.data?.reports ?? reports) : {}} />)}</>;
}

function QuestDirective({ kind, questId, version }: { kind: DirectiveKind; questId: string; version: number | null }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "boardQuest", input: { id: questId } });
  const registry = useRegistry();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const card = useRef<HTMLElement>(null);
  const deal = useMoment(card, { surface: `thread:${query.data?.quest.keeperThreadId ?? "chat"}`, kind: "party forms", rememberKey: `moment:deal:${questId}`, active: kind === "tavern-party" && !!query.data, className: "mo-deal", ms: 1200 });
  const rows = useSkeletonCount(cardKey(kind, questId), query.data ? cardRows(kind, query.data, version) : undefined, kind === "tavern-ledger" ? 1 : 3);
  if (!query.data) return <div className="tavern"><QueryState error={query.error} loading={query.isLoading} retry={() => void query.refetch()} label={CARD_LABEL[kind]} skeleton={<SkQuestCard kind={kind} rows={rows} />} /></div>;
  const detail = query.data;
  if (kind === "tavern-questmap") return <QuestMapCard detail={detail} version={version} />;
  const openQuest = <button type="button" className="lnk-btn act" onClick={() => navigate.toPluginPanel("tavern", { subPath: `${detail.quest.phase === "done" ? "tale" : "quest"}/${detail.quest.id}` })}>Open the quest page<OpensMark /></button>;
  let content: ReactNode;
  if (kind === "tavern-party") {
    content = <>
      <header className="qm-h"><span className="qm-t"><b>The party forms</b> <span className="anc">team</span><span className="qm-q">{detail.quest.title}</span></span><span className="tc-sp" />{openQuest}</header>
      <ul className="deal">{detail.quest.members.filter(m => !m.errand).map((m, i) => { const idn = registry.data ? memberIdentity(registry.data, m) : null; const lv = registry.data ? levelFor(registry.data, m.characterId, m.classId) : null; const wp = detail.quest.waypoints.find(w => w.id === m.waypointId); return (
        <li key={m.threadId} className="mcard" style={{ ["--i" as string]: i }}>
          {idn ? <button type="button" className="who who-btn act" title={`Open ${idn.character.name}’s thread${lv ? ` · ${lv.words}` : ""}`} onClick={() => navigate.toThread(m.threadId)}><Crest {...idn} size={26} level={lv?.level} /><span className="who-t"><b>{idn.character.name}</b><span className="anc">{idn.cls.label} · {idn.cls.plain}</span></span><OpensMark /></button> : <b>{m.characterId}</b>}
          <span className="mc-w">{wp ? `Waypoint ${wp.id.replace(/^w/, "")} · ${wp.title}` : m.title ?? ""}</span>
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
  return <article ref={card} {...(kind === "tavern-party" ? deal : {})} className={`tavern tcard k-${kind}`} style={glowVars(`${kind}:${questId}`) as CSSProperties}>{content}</article>;
}
