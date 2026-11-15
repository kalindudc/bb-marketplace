import { experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { rpcContract, type BoardQuestDetail, type Room } from "../../shared/contract";
import type { Ask, Member, Report } from "../../shared/schema";
import { verifiedOf, verifiedWords, voiceShown, CheckIndependence, Clamp, Glyph, levelFor, levelsShown, reachedInParty, reachedWords, SkLines, EvidenceList, ExpandsMark, FigureRow, GateRows, GuardPosture, KeeperNoteRows, KeptInMind, MemberReports, OpensMark, QuestMap, Vocabulary, clockTime, memberReportNames, plural, questNames, readable, taleFigures } from "../kit";
import { Ago, CrestOf, MemberLink, PageButton, PhaseStrip, StateMark, ThreadButton, Time, characterName, classLabel, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { durationWords, keeperStatus, mapAside, questMove, stoppedStory, stopperOf, taleHeadline } from "./model";
import { usePanelState } from "./panel-state";
import { DecisionLine, Guardrails, History, OlderDecisions, ReportItem, RuleRow, useHistoryLines } from "./record";
import { reportsTitle, useOpenReports, viewReportsLabel } from "./reports";
import "./finished.css";
import { FoldLoad } from "./skeletons";

/* The finished quest: the tale's rows (shared with the tale page) and the record page that returned and stopped quests share. */

type Credit = NonNullable<BoardQuestDetail["memberCredits"]>[number];

/** What a member did on this quest, from the server's credits: "made w1", "verified w2", or what its class does. */
function roleWords(member: Member, credit: Credit | undefined, registry: Registry, reports: Report[]) {
  const made = credit?.madeWaypointIds ?? [], verified = credit?.verifiedWaypointIds ?? [];
  if (made.length || verified.length) return { made, verified, plain: null };
  const cls = classLabel(registry, member.classId);
  return { made, verified, plain: cls?.plain === "scout" ? "scouted" : reports.length ? "reported" : "in the party" };
}


export function CreditCard({ member, index, detail, registry }: { member: Member; index: number; detail: BoardQuestDetail; registry: Registry }) {
  const [inline, setInline] = useState(false);
  const openReports = useOpenReports();
  const quest = detail.quest;
  const cls = classLabel(registry, member.classId);
  const character = registry.characters.find((c) => c.id === member.characterId);
  const reports = detail.reports.filter((r) => r.memberThreadId === member.threadId).sort((a, b) => b.createdAt - a.createdAt);
  const lead = reports.find((r) => r.status === "done") ?? reports[0];
  const headline = lead ? taleHeadline(lead, memberReportNames(detail, member, registry)) : null;
  // A report's own voice line always shows; the character's stock wrap line claims an ending, so only a member that finished gets it.
  const voice = lead?.voice ?? (character && member.state === "done" ? character.lines.wrap : null);
  const role = roleWords(member, detail.memberCredits?.find((c) => c.memberThreadId === member.threadId), registry, reports);
  const title = (id: string) => quest.waypoints.find((w) => w.id === id)?.title ?? id;
  const ids = (list: string[]) => list.map((id, i) => <span key={id}>{i > 0 && ", "}<span className="tv-wpid" title={title(id)}>{id}</span></span>);
  const name = characterName(registry, member);
  // The kit's one rule, from the lasting record; nothing earned, no level.
  const lv = levelFor(registry, member.characterId, member.classId);
  // A level belongs to the character, not the member: the kit says each crossing once, on the first member holding it.
  const said = levelsShown(registry) ? reachedInParty(detail, quest.members, registry.characters).find((x) => x.member.threadId === member.threadId) ?? null : null;
  return <li className={`tv-credit nested ${inline ? "open" : ""}`} style={{ ["--i" as string]: index }}>
    <div className="tv-credit-h">
      <CrestOf member={member} registry={registry} size={32} level={lv?.level} />
      <span className="tv-credit-n"><span className="tv-credit-nm"><b>{name}</b>{member.characterId && detail.tale?.keptCharacterIds?.includes(member.characterId) && <span className="tv-kept" data-kept role="img" aria-label="Kept" title={`Kept at the top of ${name}'s tales, from the character sheet`}><Glyph name="wax-seal" size={13} /></span>}</span><span className="m">{cls ? <>{cls.label} <span className="anc">{cls.plain}</span></> : member.classId}</span></span>
      {lv && lv.level >= 2 && <span className="tag tv-lvl" title={lv.words}>level {lv.level}</span>}
    </div>
    {said && <p className="tv-credit-lvl" data-reached={said.reached.level} data-earned={said.reached.earned || undefined}>{reachedWords(said.name, said.reached)}</p>}
    <CheckIndependence member={member} /><GuardPosture member={member} finished />
    <p className="tv-credit-role">{role.plain ?? <>{role.made.length > 0 && <span>made {ids(role.made)}</span>}{role.made.length > 0 && role.verified.length > 0 && " · "}{role.verified.length > 0 && <span>verified {ids(role.verified)}</span>}</>}</p>
    {headline && <p className="tv-credit-hl" data-content>{headline}</p>}
    {voice && voiceShown(registry) && <p className="tv-voice tv-credit-v" data-content>{voice}</p>}
    {reports.length > 0 && (inline
      ? <button type="button" className="lnk-btn act tv-credit-more" aria-expanded onClick={() => setInline(false)}><span>{reports.length > 1 ? "Hide the reports" : "Hide the report"}</span><ExpandsMark open /></button>
      : <button type="button" className="lnk-btn act tv-credit-more" onClick={() => { if (!openReports({ questId: quest.id, memberThreadId: member.threadId }, reportsTitle(name, quest.short))) setInline(true); }} title={`Opens ${name}'s ${reports.length > 1 ? "reports" : "report"} in the side panel`}><span>{viewReportsLabel(reports.length)}</span><OpensMark /></button>)}
    {inline && <div className="tv-credit-full"><MemberReports detail={detail} member={member} registry={registry} /></div>}
  </li>;
}

export type Waypoint = BoardQuestDetail["quest"]["waypoints"][number];
/** One verified waypoint: its title, who verified it and its done-when stay in view; the evidence folds behind "N evidence". */
export function LootRow({ waypoint: w, detail, registry }: { waypoint: Waypoint; detail: BoardQuestDetail; registry: Registry }) {
  const [open, setOpen] = usePanelState(`tale:${detail.quest.id}.loot.${w.id}`, false);
  const reports = detail.reports.filter((r) => r.waypointId === w.id && r.evidence.length > 0);
  const shown = reports.reduce((n, r) => n + r.evidence.length, 0);
  const verifierId = detail.memberCredits?.find((c) => c.verifiedWaypointIds.includes(w.id))?.memberThreadId;
  const verifier = verifierId ? detail.quest.members.find((m) => m.threadId === verifierId) : undefined;
  return <li>
    <PageGlyph name="done" className="tv-st-done-g" />
    <div className="tv-loot-b">
      <span><b>{w.title}</b><span className="m"> · {verifier ? characterName(registry, verifier) : "a Warden"} verified</span></span>
      {w.doneWhen && <span className="m tv-loot-dw" data-content>{w.doneWhen}</span>}
      {shown > 0 ? <button type="button" className="lnk-btn act tv-loot-ev" aria-expanded={open} onClick={() => setOpen(!open)}><span>{shown} evidence</span><ExpandsMark open={open} /></button> : <span className="m">{w.evidenceCount ? `${w.evidenceCount} evidence` : "No evidence attached"}</span>}
      {open && reports.map((r) => <EvidenceList key={r.id} evidence={r.evidence} />)}
    </div>
  </li>;
}


/** What a waypoint that was not verified was left as, in words. */
export function leftWord(w: Waypoint, skipped?: string): string {
  if (w.actor === "user") return "still yours";
  if (w.actor === "outside") return `waiting on ${w.owner ?? "someone outside"}`;
  if (w.state === "skipped") return skipped ? `skipped: ${skipped}` : "skipped";
  if (w.state === "rejected") return w.rejectedReason ? `rejected: ${w.rejectedReason}` : "rejected";
  return ({ planned: "planned", todo: "planned", doing: "in progress", blocked: "blocked", reported: "reported, not verified" } as Record<string, string>)[w.state] ?? w.state;
}
/** One waypoint left on the board: its title and what it was left as. */
export function LeftRow({ waypoint: w, skipped }: { waypoint: Waypoint; skipped?: string }) {
  return <li><PageGlyph name={w.actor === "user" ? "diamond" : w.actor === "outside" ? "gate" : "wait"} className={w.actor === "user" ? "tv-mn-you" : ""} /><span><b data-content>{w.title}</b><span className="m"> · <span data-content>{leftWord(w, skipped)}</span></span></span></li>;
}

function useNarrow(query: string) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return narrow;
}

/** A remembered fold of the record: the whole heading is its button, and it says what it holds and how many. */
function RecordFold({ id, title, count, aside, word = false, open: initial, className = "", children }: { id: string; title: ReactNode; count?: ReactNode; aside?: ReactNode; word?: boolean; open: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = usePanelState(id, initial);
  const body = useId();
  return <section className={`tv-card tv-rec-fold ${open ? "open" : ""} ${className}`} data-fold={id}>
    <h2 className="tv-rec-fh"><button type="button" className="tv-rec-ft act" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
      <ExpandsMark open={open} /><span className="tv-rec-tt">{title}</span>{count !== undefined && <>{" "}<span className="tv-count">{count}</span></>}{aside && <>{" "}<span className="tv-colh-aside">{aside}</span></>}<span className="tv-sp" />{word && <>{" "}<span className="tv-rec-fw">{open ? "Hide" : "Show"}</span></>}
    </button></h2>
    {open && <div id={body} className="tv-rec-fb">{children}</div>}
  </section>;
}

const VIA: Record<NonNullable<Ask["answer"]>["via"], string> = { banner: "from the banner", page: "on the Tavern page", phone: "on your phone", chat: "in chat", cli: "from the CLI", timer: "by its timer" };
/** Why Tavern withdrew an ask, where the server recorded it. Keyed by string so a cause the schema adds later still reads "withdrawn". */
const WITHDRAWN: Record<string, string> = { "quest-stopped": "withdrawn when it stopped", "quest-returned": "withdrawn when the quest returned", "backup-restored": "withdrawn when this backup was restored" };
/** How an ask ended, in words: the option chosen, by whom and how; withdrawn or still open otherwise. */
export function askOutcome(ask: Ask): string {
  const label = ask.answer ? ask.options.find((o) => o.id === ask.answer!.optionId)?.label ?? "an option no longer listed" : null;
  if (ask.answer && label) return ask.answer.by === "user" ? `You chose “${label}” ${VIA[ask.answer.via]}` : `“${label}” applied by itself ${VIA[ask.answer.via]}`;
  if (ask.state === "withdrawn") return (ask.withdrawnCause && WITHDRAWN[ask.withdrawnCause]) || "withdrawn";
  if (ask.state === "defaulted") return "applied its recommendation";
  return "still open";
}

function AsksRecord({ asks }: { asks: Ask[] }) {
  if (!asks.length) return <p className="tv-empty" data-empty>No asks on this quest.</p>;
  return <ol className="tv-li-list tv-rec-asks">{[...asks].sort((a, b) => a.createdAt - b.createdAt).map((a) => <li key={a.id}>
    <span className="tv-rec-ask"><span data-content>{a.question}</span><span className="m">{askOutcome(a)}</span>{a.answer?.note && <span className="tv-rec-note" data-content>“{a.answer.note}”</span>}</span>
    <Time at={a.answer?.at ?? a.createdAt} />
  </li>)}</ol>;
}

function PlanRecord({ detail }: { detail: BoardQuestDetail }) {
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

function RulesAndAnchor({ detail, keeperName }: { detail: BoardQuestDetail; keeperName: string }) {
  const ledger = experimental_useRpcQuery({ contract: rpcContract, method: "ledger", input: { threadId: detail.quest.keeperThreadId } });
  const shown = detail.rules.filter((r) => r.active || r.source === "keeper-proposed");
  return <div className="tv-rec-rules">
    <div className="tv-cell"><div className="lbl"><PageGlyph name="rule" />Standing rules · {detail.rules.filter((r) => r.active).length} · sent every tick</div>{shown.length ? <ul className="tv-rules">{shown.map((rule) => <RuleRow key={rule.id} rule={rule} />)}</ul> : <p className="tv-empty" data-empty>No standing rules.</p>}</div>
    <div className="tv-cell"><div className="lbl"><PageGlyph name="anchor" />What {keeperName} is re-anchored with now{ledger.data?.lastReanchorAt ? <> · last <Time at={ledger.data.lastReanchorAt} /></> : ""}</div>{ledger.data ? <pre className="tv-code" data-content>{ledger.data.restatement || "No restatement recorded."}</pre> : ledger.error ? <p className="tv-problem" role="alert">Could not load the ledger: {ledger.error.message}</p> : <FoldLoad error={null} retry={ledger.refetch} label="the re-anchor text"><pre className="tv-code"><SkLines n={4} /></pre></FoldLoad>}</div>
  </div>;
}

/**
 * A returned or stopped quest as a record: what happened first, then the figures, what was done and left, the party's credits,
 * the map folded, and the complete record in remembered folds. No side rail, no glow and no live-quest machinery.
 */
export function FinishedQuestPage({ detail, registry, room }: { detail: BoardQuestDetail; registry: Registry; room?: Room }) {
  const navigate = useBbNavigate();
  const quest = detail.quest;
  const returned = quest.phase === "done";
  const keeper = room?.keepers.find((k) => k.member.threadId === quest.keeperThreadId) ?? null;
  const keeperName = keeper ? characterName(registry, keeper.member) : "the Keeper";
  const status = keeper ? keeperStatus(keeper) : null;
  const tone = questMove(quest, detail.asks, { keeper: keeperName, member: (m) => characterName(registry, m) }, { keeperArchived: !!keeper?.archived }).tone;
  const names = useMemo(() => questNames(quest, registry, detail.reports), [quest, registry, detail.reports]);
  const end = quest.endedAt ?? quest.updatedAt;
  const span = durationWords(end - quest.createdAt);
  const nameOf = (id: string) => names.threadNames?.get(id) ?? null;
  const stopper = returned ? null : stopperOf(detail.events, quest.id, { name: nameOf });
  const story = useMemo(() => returned ? [] : stoppedStory(detail, { name: nameOf, headline: (r: Report) => { const m = quest.members.find((x) => x.threadId === r.memberThreadId); return taleHeadline(r, m ? memberReportNames(detail, m, registry) : names); } }), [detail, registry, names]); // eslint-disable-line react-hooks/exhaustive-deps
  // A finished quest has no progress left to show: its path is what was verified, and the skipped ones apart.
  const path = verifiedOf(quest);
  const steer = quest.plan?.fromSteer;
  const verified = quest.waypoints.filter((w) => w.state === "verified");
  const left = quest.waypoints.filter((w) => w.state !== "verified");
  const skippedWhy = (id: string) => { const s = detail.tale?.skipped.find((x) => x.waypointId === id); return s ? readable(s.reason, names) : undefined; };
  const notes = detail.notes ?? [];
  const handBacks = notes.filter((n) => n.kind === "waiting-on-user" && n.state === "open");
  const keptNotes = notes.filter((n) => n.kind !== "waiting-on-user");
  const members = new Map(quest.members.map((m) => [m.threadId, m]));
  const history = useHistoryLines(detail, registry, room);
  const hasGuards = (detail.scopes?.length ?? 0) + (detail.violations?.length ?? 0) > 0;
  const phone = useNarrow("(max-width: 560px)");
  const key = (part: string) => `quest:${quest.id}.${part}`;
  return <div className="tv-quest tv-record" data-phase={quest.phase}>
    <header className="tv-card tv-rec-head">
      <div className="tv-gh-l">
        <h1 className="tv-qtitle" data-content>{quest.title}</h1>
        <PhaseStrip phase={quest.phase} tone={tone} />
        <div className="tv-facts">
          <StateMark tone={tone}><b>{returned ? "Returned" : stopper ? `Stopped by ${stopper}` : "Stopped"}</b></StateMark>
          <span><Ago at={end} /></span>
          <span>{returned ? "took" : "after"} <b className="num">{span}</b></span>
          <span>path <b className="num">{path ? verifiedWords(path) : "not mapped"}</b></span>
          <span>plan <b>v{quest.planVersion}</b>{steer && <span className="tag tv-steer-tag" title={`From your steer: ${steer.text}`}>steer {clockTime(steer.at)}</span>}</span>
        </div>
      </div>
      <div className="tv-gacts">
        {returned && <PageButton path={`tale/${quest.id}`} glyph="report">The tale</PageButton>}
        {keeper && status && <MemberLink member={keeper.member} registry={registry} size={28} sub={<StateMark tone={status.tone}>{status.label}</StateMark>} />}
        <ThreadButton id={quest.keeperThreadId} name={keeperName} label={keeper ? `Open ${keeperName}’s thread` : "Open the Keeper’s thread"} quiet={!!keeper?.archived} />
      </div>
    </header>

    <section className="tv-card tv-rec-story" aria-labelledby="tv-rec-story-h">
      <header className="tv-colh"><h2 id="tv-rec-story-h">What happened</h2></header>
      {returned
        ? detail.tale ? <div className="tv-rec-prose"><Clamp text={readable(detail.tale.outcome, names)} lines={3} className="tv-outcome" /><button type="button" className="lnk-btn act tv-rec-tale" onClick={() => navigate.toPluginPanel("tavern", { subPath: `tale/${quest.id}` })}><span>The tale</span><OpensMark /></button></div> : <p className="tv-rec-prose m">The Keeper wrote no tale for this quest.</p>
        : <ul className="tv-rec-lines">{story.map((line, i) => <li key={i} data-content>{line}</li>)}</ul>}
      <FigureRow figures={taleFigures(detail)} compact={phone} />
    </section>

    <div className="tv-rec-two">
      <section className="tv-card tv-rec-sec" aria-labelledby="tv-rec-done-h">
        <header className="tv-colh"><h2 id="tv-rec-done-h">Done</h2><span className="tv-count">{path ? verifiedWords(path) : "no quest map"}</span></header>
        {verified.length ? <ul className="tv-dw tv-loot">{verified.map((w) => <LootRow key={w.id} waypoint={w} detail={detail} registry={registry} />)}</ul> : <p className="tv-empty" data-empty>Nothing was verified.</p>}
      </section>
      <section className="tv-card tv-rec-sec" aria-labelledby="tv-rec-left-h">
        <header className="tv-colh"><h2 id="tv-rec-left-h">Left</h2><span className="tv-count">{plural(left.length + handBacks.length, "item")}</span></header>
        {handBacks.length > 0 && <KeeperNoteRows notes={handBacks} label="Handed back to you" />}
        {left.length ? <ul className="tv-dw">{left.map((w) => <LeftRow key={w.id} waypoint={w} skipped={skippedWhy(w.id)} />)}</ul> : !handBacks.length && <p className="tv-empty" data-empty>Nothing was left.</p>}
      </section>
    </div>

    <section className="tv-card tv-rec-party" aria-labelledby="tv-rec-party-h">
      <header className="tv-colh"><h2 id="tv-rec-party-h"><Vocabulary word="party" /></h2><span className="tv-count">{plural(quest.members.length, "member")}</span></header>
      {quest.members.length ? <div className="tv-credits-w"><ol className={`tv-credits n-${Math.min(quest.members.length, 5) === 5 ? "many" : quest.members.length}`}>{quest.members.map((member, i) => <CreditCard key={member.threadId} member={member} index={i} detail={detail} registry={registry} />)}</ol></div> : <p className="tv-empty" data-empty>No party was hired.</p>}
    </section>

    <RecordFold id={key("map")} title={<Vocabulary word="map" />} aside={mapAside(quest)} word open={false} className="tv-rec-map">
      {quest.waypoints.length ? <QuestMap quest={quest} mode="live" /> : <p className="tv-empty" data-empty>No quest map was drawn.</p>}
      <GateRows waypoints={quest.waypoints} />
    </RecordFold>

    <div className="tv-rec-folds" role="group" aria-label="The complete record">
      <RecordFold id={key("rec.history")} title="History" count={plural(history.length, "event")} open><History detail={detail} registry={registry} room={room} bare /></RecordFold>
      <RecordFold id={key("rec.decisions")} title="Decisions" count={plural(detail.decisionsTotal ?? detail.decisions.length, "decision")} open>
        {detail.decisions.length ? <ol className="tv-li-list">{detail.decisions.map((d) => <DecisionLine key={d.id} decision={d} />)}{detail.decisionsNextCursor && <OlderDecisions keeperThreadId={quest.keeperThreadId} boardQuestId={quest.id} cursor={detail.decisionsNextCursor} />}</ol> : <p className="tv-empty" data-empty>No decisions were recorded.</p>}
      </RecordFold>
      <RecordFold id={key("rec.asks")} title="Asks and answers" count={plural(detail.asks.length, "ask")} open={false}><AsksRecord asks={detail.asks} /></RecordFold>
      <RecordFold id={key("rec.plan")} title="The plan" count={plural(detail.plans.length, "version")} open={false}><PlanRecord detail={detail} /></RecordFold>
      <RecordFold id={key("rec.reports")} title="Reports" count={plural(detail.reports.length, "report")} open={false}>{detail.reports.length ? <ul className="tv-items">{detail.reports.map((r) => <ReportItem key={r.id} report={r} registry={registry} detail={detail} />)}</ul> : <p className="tv-empty" data-empty>No reports were filed.</p>}</RecordFold>
      {hasGuards && <RecordFold id={key("rec.guards")} title="Guardrails" count={plural(detail.violations?.length ?? 0, "violation")} open={false}><Guardrails detail={detail} registry={registry} members={members} bare /></RecordFold>}
      {keptNotes.length > 0 && <RecordFold id={key("rec.kept")} title="Kept in mind" count={plural(keptNotes.length, "note")} open={false}><KeptInMind notes={keptNotes} /></RecordFold>}
      <RecordFold id={key("rec.rules")} title={`${keeperName === "the Keeper" ? "The Keeper’s" : `${keeperName}’s`} rules and re-anchor`} count={plural(detail.rules.filter((r) => r.active).length, "rule")} open={false}><RulesAndAnchor detail={detail} keeperName={keeperName} /></RecordFold>
    </div>
  </div>;
}
