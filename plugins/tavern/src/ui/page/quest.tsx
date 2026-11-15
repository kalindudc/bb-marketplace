import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useId, useMemo, useState } from "react";
import { rpcContract, type BoardQuestDetail, type Room } from "../../shared/contract";

import { AskCard, verifiedOf, verifiedWords, questNames, readable, heldQuests, stoppingWords as kitStoppingWords, CELLAR, CheckIndependence, ExpandsMark, GateRows, GuardPosture, KeeperNoteRows, KeptInMind, OpensMark, QuestMap, QuietNotice, Vocabulary, clockTime, glowVars, vocab } from "../kit";
import { DecidedForYou, KIND, heldTitles } from "./asks";
import { ArchiveReceiptLine, ArchivedList, FinishedRow, finishedQuests, useArchive } from "./archive";
import { Ago, CrestOf, MemberLink, PageButton, PhaseStrip, Section, SegFilter, StateMark, ThreadButton, characterName, classLabel, type Registry, plural } from "./common";
import { PageGlyph } from "./glyphs";
import { durationWords, stopperOf, endedCounts, isFinished, keeperStatus, mapAside, pathProgress, phaseWord, questMove, visibleMembers, waypointMove } from "./model";

import { MemberIdentity, PartyPicture as KitPartyPicture } from "../kit";
import { CheckerHold } from "./hold";
import { usePanelState } from "./panel-state";

import { Confidence, Guardrails, History, OlderDecisions, ReportItem, useHistoryLines } from "./record";
import { CreditCard, LeftRow, LootRow } from "./finished";
import { AsksRecord, PlanRecord, RecordFold, RulesAndAnchor } from "./quest-record";
import { QuestLead } from "./quest-lead";
import { recordedStop } from "./quest-road";



/** The stopping words the page and its tests share: how many stops wait on a confirmation. */
export const stoppingWords = (unconfirmed: number) => `Stopping · ${kitStoppingWords({ stopUnconfirmed: unconfirmed })}`;
const PHASE_RANK = (phase: string) => phase === "stopped" || phase === "done" ? 2 : phase === "stopping" ? 1 : 0;

/**
 * Stop, then while the server confirms each member's stop: what is still running, when Tavern last tried, and a quiet Retry now.
 * A stop call's own answer counts until the page's data catches up, and never moves the quest backwards.
 */
function StopQuest({ detail, registry }: { detail: BoardQuestDetail; registry: Registry }) {
  const [armed, setArmed] = useState(false);
  const [answer, setAnswer] = useState<{ phase: "stopping" | "stopped"; unconfirmed: number; at: number } | null>(null);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const stop = experimental_useRpcMutation({ contract: rpcContract, method: "stopBoardQuest" });
  const quest = detail.quest;
  const call = async (why: string | null) => { try { const out = await stop.mutate({ id: quest.id, reason: why }); setAnswer({ ...out, at: Date.now() }); setArmed(false); } catch { /* The refusal shows below; the confirmation stays open. */ } };
  const ahead = answer && PHASE_RANK(answer.phase) > PHASE_RANK(quest.phase);
  const phase = ahead ? answer.phase : quest.phase;
  if (phase === "stopped" && quest.phase !== "stopped") return { button: <StateMark tone="bad">Stopped</StateMark>, confirm: null, stopping: null };
  if (phase === "done" || phase === "stopped") return { button: null, confirm: null, stopping: null };
  const problem = stop.error && <p role="alert" className="tavern problem">Could not stop: {stop.error.message}</p>;
  if (phase === "stopping") {
    const pending = quest.members.filter((m) => m.stopPending);
    /** Hires that were cancelled before they bound to a thread, which Tavern hasn't confirmed ended: no thread to open, so a title and its class. */
    const hires = quest.stopPendingHires ?? [];
    const fresher = answer && answer.at >= quest.updatedAt;
    const unconfirmed = fresher || ahead ? answer!.unconfirmed : quest.stopUnconfirmed ?? pending.length;
    const since = quest.stoppingSince ?? (ahead ? answer!.at : null);
    const tried = answer && !ahead ? <span className="m small" role="status">Tried again at {clockTime(answer.at)}: {answer.phase === "stopped" ? "every stop confirmed" : `${plural(answer.unconfirmed, "stop")} not confirmed`}.</span> : null;
    return {
      button: null,
      stopping: { unconfirmed, since },
      confirm: <><section className="tavern tv-stopping" aria-labelledby="tv-stopping-h">
        <header className="tv-stopping-h"><PageGlyph name="stop" /><h2 id="tv-stopping-h">{unconfirmed > 0 ? `${plural(unconfirmed, "stop")} not confirmed` : "Confirming the last stop"}</h2><span className="tv-sp" />
          <button type="button" className="btn sm" disabled={stop.isPending} onClick={() => void call(null)} title="Ask every member that hasn’t confirmed to stop again, now">{stop.isPending ? "Retrying…" : "Retry now"}</button></header>
        {pending.length > 0 && <ul className="tv-stopping-l" aria-label="Members whose stop isn’t confirmed">{pending.map((m) => <li key={m.threadId} data-stuck={!!m.stopError || undefined}>
          <MemberLink member={m} registry={registry} size={18} sub={<span className="m small">{m.lastStopAttemptAt ? `last tried ${clockTime(m.lastStopAttemptAt)}` : "not tried yet"}</span>} />
          {m.stopError && <p className="m small tv-stopping-e" data-content>{m.stopError}</p>}
        </li>)}</ul>}
        {hires.length > 0 && <ul className="tv-stopping-l" aria-label="Hires whose stop isn’t confirmed">{hires.map((h) => { const cls = classLabel(registry, h.classId); return <li key={h.token} className="tv-stopping-hire">
          <PageGlyph name="hire" size={18} /><span><b>Unconfirmed hire:</b> <span data-content>{h.title}</span> <span className="m small">· {cls ? cls.label : h.classId} · no thread yet</span></span>
        </li>; })}</ul>}
        <p className="m small">The quest takes no new work while it stops. Tavern keeps retrying, and asks you if a stop isn’t confirmed within 2 minutes.</p>
        {tried}
      </section>{problem}</>,
    };
  }
  const live = quest.members.filter((m) => m.state !== "done" && m.state !== "stopped").length;
  const act = () => call(reason.trim() || null);
  return {
    button: <button type="button" className="btn danger" aria-expanded={armed} onClick={() => setArmed(!armed)}><PageGlyph name="stop" /><span>Stop quest</span></button>,
    stopping: null,
    confirm: <>{armed && <div className="tavern problem tv-stop" role="group" aria-label="Confirm stopping quest"><PageGlyph name="stop" /><span className="tv-sp"><b>Stop every thread of “{detail.quest.short}” now?</b> This halts {live} member thread{live === 1 ? "" : "s"} without a model. Other board quests keep running.</span><span className="tv-stop-why"><label htmlFor={reasonId}>Reason (optional, kept in the quest’s record)</label><input id={reasonId} type="text" className="tv-text" maxLength={500} value={reason} disabled={stop.isPending} onChange={(event) => setReason(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void act(); }} /></span><button type="button" className="btn danger" disabled={stop.isPending} onClick={() => void act()}>{stop.isPending ? "Stopping…" : "Yes, stop this quest"}</button><button type="button" className="btn" disabled={stop.isPending} onClick={() => setArmed(false)}>Keep running</button></div>}{problem}</>,
  };
}

/** A quest's page: the live page while it is in play, the record once it has returned or stopped. */
export function QuestPage({ detail, registry, room }: { detail: BoardQuestDetail; registry: Registry; room?: Room }) {
  const navigate = useBbNavigate();
  const quest = detail.quest;
  const roadStop = recordedStop(detail);
  const keeper = room?.keepers.find((k) => k.member.threadId === quest.keeperThreadId) ?? null;
  const keeperName = keeper ? characterName(registry, keeper.member) : "the Keeper";
  const move = questMove(quest, detail.asks, { keeper: keeperName, member: (m) => characterName(registry, m) }, { keeperArchived: !!keeper?.archived });
  const path = pathProgress(quest);
  const names = useMemo(() => questNames(quest, registry, detail.reports), [quest, registry, detail.reports]);
  const stopper = stopperOf(detail.events, quest.id, { name: id => names.threadNames?.get(id) ?? null });
  const finishedPath = verifiedOf(quest);
  const stop = StopQuest({ detail, registry });
  const members = new Map([...(room ? visibleMembers(room) : []), ...quest.members].map((m) => [m.threadId, m]));
  const openAsks = detail.asks.filter((a) => a.state === "open");
  const finished = isFinished(quest.phase);
  const [promisesMore, setPromisesMore] = usePanelState("quest.promises.more", false);
  const [factsMore, setFactsMore] = usePanelState("quest.facts.more", false);
  const [decisionsMore, setDecisionsMore] = usePanelState("quest.decisions.more", false);
  const status = keeper ? keeperStatus(keeper) : null;
  const groups = ["Your next moves", "Ready for review", "Blocked", "Working", "Waiting on others", "Left when stopped", "Done"] as const;
  const groupTone: Record<(typeof groups)[number], "you" | "done" | "bad" | "work" | "wait"> = { "Your next moves": "you", "Ready for review": "done", Blocked: "bad", Working: "work", "Waiting on others": "wait", "Left when stopped": "wait", Done: "done" };
  /** A stopped quest has no moves left: whatever was not done is what was left when it stopped. */
  const groupOf = (w: (typeof quest.waypoints)[number]) => { const move = waypointMove(w); return quest.phase === "stopped" && move !== "Done" ? "Left when stopped" : move; };
  const [mapOpen, setMapOpen] = usePanelState(`quest:${quest.id}.map`, false);
  const showMap = !isFinished(quest.phase) || mapOpen;
  const [showDone, setShowDone] = usePanelState(`quest:${quest.id}.done`, false);

  const history = useHistoryLines(detail, registry, room);
  const notes = detail.notes ?? [];
  const handBacks = notes.filter((n) => n.kind === "waiting-on-user" && n.state === "open");
  const keptNotes = notes.filter((n) => n.kind !== "waiting-on-user");
  const steer = quest.plan?.fromSteer;
  return <div className={`tv-quest ${finished ? "tv-record" : ""}`} data-phase={quest.phase}>
    <header className={`tv-ghead ${finished ? "" : "lit"}`} style={finished ? undefined : glowVars(`quest:${quest.id}`)}>
      <div className="tv-gh-l">
        <h1 className="tv-qtitle" data-content>{quest.title}</h1>
        <PhaseStrip phase={quest.phase} tone={move.tone} stoppedAt={roadStop.position} proven={roadStop.proven} />
        <div className="tv-facts">
          {finished ? <><StateMark tone={move.tone}><b>{quest.phase === "stopped" ? stopper ? `Stopped by ${stopper}` : "Stopped" : "Returned"}</b></StateMark><span><Ago at={quest.endedAt ?? quest.updatedAt} /></span><span>{quest.phase === "done" ? "took" : "after"} <b>{durationWords((quest.endedAt ?? quest.updatedAt) - quest.createdAt)}</b></span></>
            : stop.stopping ? <><StateMark tone="warn"><b>{stoppingWords(stop.stopping.unconfirmed)}</b></StateMark>{stop.stopping.since && <span>since <b>{clockTime(stop.stopping.since)}</b></span>}</>
            : <><StateMark tone={move.tone}><b>{phaseWord(quest.phase)} · {move.who === "You" ? "your move" : move.who}</b>{move.next ? ` · ${move.next}` : ""}</StateMark><span>updated <b><Ago at={quest.updatedAt} /></b></span></>}
          <span>path <b className="num">{finished ? finishedPath ? verifiedWords(finishedPath) : "not mapped" : path ? `${path.done} of ${path.total}` : "not mapped yet"}</b></span>
          <span>plan <b>v{quest.planVersion}</b>{steer && <span className="tag tv-steer-tag" title={`From your steer: ${steer.text}`}>steer {clockTime(steer.at)}</span>}</span>
          {room && !finished && <span>review <b className="num">{room.review.waiting} of {room.review.budget}</b></span>}
        </div>

        {!finished && keeper && !keeper.archived && <QuietNotice threadId={keeper.member.threadId} since={keeper.quietSince} />}
      </div>
      <div className="tv-gacts">

        {quest.phase === "done" && <PageButton path={`tale/${quest.id}`} glyph="report">The tale</PageButton>}
        {keeper && status && <MemberLink member={keeper.member} registry={registry} size={28} sub={<StateMark tone={status.tone}>{status.label}</StateMark>} />}
        <ThreadButton id={quest.keeperThreadId} name={keeperName} label={keeper ? `Open ${keeperName}'s thread` : "Open the Keeper's thread"} className={finished || keeper?.archived ? "" : "pri"} quiet={finished || !!keeper?.archived} />
        {stop.button}
      </div>
    </header>
    {stop.confirm}
    {finished && <QuestLead detail={detail} registry={registry} />}
    <section className={`tv-card tv-qmapcard ${finished ? "" : "lit"} ${showMap ? "" : "folded"}`} aria-labelledby="tv-qmap-h" style={finished ? undefined : glowVars(`questmap:${quest.id}`)}>
      <header className="tv-colh"><h2 id="tv-qmap-h"><Vocabulary word="map" /></h2><span className="tv-colh-aside">{mapAside(quest)}</span><span className="tv-sp" />{steer && showMap && <span className="tag tv-steer-tag" title={steer.text}><PageGlyph name="steer" /><span>v{quest.planVersion} from your steer, {clockTime(steer.at)}</span></span>}{finished && <button type="button" className="tv-fold act" aria-label={`${vocab("map")} ${mapAside(quest)} ${mapOpen ? "Hide" : "Show"}`} aria-expanded={mapOpen} aria-controls="tv-qmap-b" onClick={() => setMapOpen(!mapOpen)}><ExpandsMark open={mapOpen} /><span>{mapOpen ? "Hide" : "Show"}</span></button>}</header>
      {showMap && <div id="tv-qmap-b">
        {steer && quest.plan?.changeNote && <ChangeNote text={quest.plan.changeNote} />}
        {quest.waypoints.length ? <QuestMap quest={quest} mode="live" /> : <p className="tv-empty tv-qmap-empty" data-empty><PageGlyph name="plan" />No quest map yet: {move.who}{move.next ? ` · ${move.next}` : ""}.</p>}
        <GateRows waypoints={quest.waypoints} />
      </div>}
    </section>
    <div className="tv-ggrid" role="group" aria-label="The quest sections">
      <div className="tv-col">
        {!finished ? <Section title="By whose move" count={`${openAsks.length + heldQuests([quest], openAsks).length + quest.waypoints.filter((w) => waypointMove(w) !== "Done").length} ${quest.phase === "stopped" ? "left" : "open"}`}>
          {!finished && <CheckerHold quest={quest} asks={openAsks} />}
          {handBacks.length > 0 && <div className="tv-grp"><KeeperNoteRows notes={handBacks} label="Handed back to you" /></div>}
          {openAsks.length > 0 && <div className="tv-grp"><div className="tv-grp-h"><StateMark tone="you">Needs you</StateMark><span className="num m">{openAsks.length}</span></div>
            <div className="tv-asks">{openAsks.map((ask) => <details key={ask.id} open className={`tv-ask-disclosure ${ask.kind === "blocker" ? "blk" : ""}`}><summary className="tv-askrow"><PageGlyph name={ask.kind === "blocker" ? "fail" : "you"} size={13} className="tv-askrow-g" /><span className="tv-askrow-t"><span className="tv-askrow-q" data-content>{ask.question}</span><span className="tv-askrow-s">{KIND[ask.kind]} · {heldTitles(ask, quest).length ? `holds ${heldTitles(ask, quest).join(", ")}` : ask.why}</span></span><span className="tv-askrow-a"><Ago at={ask.createdAt} /></span></summary><AskCard ask={ask} via="page" headless /></details>)}</div></div>}
          {groups.map((group) => { const items = quest.waypoints.filter((w) => groupOf(w) === group); if (!items.length) return null; if (group === "Done" && !showDone) return <button key={group} type="button" className="tv-fold act" aria-expanded={false} onClick={() => setShowDone(true)}><ExpandsMark open={false} />Done · {items.length}</button>; return <div className="tv-grp" key={group}><div className="tv-grp-h"><StateMark tone={groupTone[group]}>{group}</StateMark><span className="num m">{items.length}</span></div><ul className="tv-items">{items.map((w) => {
            const owner = w.actor === "user" ? "You" : w.ownerMember ? characterName(registry, w.ownerMember) : w.owner ?? "Unassigned";
            const report = detail.reports.find((r) => r.waypointId === w.id);
            return <li key={w.id} className={`tv-item ${group === "Your next moves" ? "you" : group === "Blocked" ? "bad" : ""}`} data-stuck={group === "Blocked" || undefined}>
              {w.ownerMember ? <CrestOf member={w.ownerMember} registry={registry} size={16} /> : <PageGlyph name={w.actor === "user" ? "diamond" : w.actor === "outside" ? "gate" : "wait"} className={w.actor === "user" ? "tv-mn-you" : ""} />}
              <span className="tv-item-t" data-content title={`${owner}: ${w.title}`}>{owner}: {w.title}</span>
              <span className="m small num">{w.leadTime ?? "lead time unknown"}</span>
              <span className="tv-item-s">{w.ownerMember && <><CheckIndependence member={w.ownerMember} /><GuardPosture member={w.ownerMember} /></>}<span>{w.doneWhen ? `done when ${w.doneWhen}` : "no done-when"}</span>{w.evidenceCount > 0 && <span>{w.evidenceCount} evidence</span>}{w.verifiedBy && <span>verified by the Warden</span>}{w.rejectedReason && <span className="tv-st-bad">rejected: {w.rejectedReason}</span>}{report && <Confidence report={report} />}</span>
            </li>;
          })}</ul></div>; })}
          {!openAsks.length && !quest.waypoints.length && <p className="tv-empty" data-empty>Nothing to move yet: {move.who}{move.next ? ` · ${move.next}` : ""}.</p>}
        </Section> : <Section title="Done and left"><div className="tv-rec-two">
          <section className="tv-card tv-rec-sec" aria-label="Done"><header className="tv-colh"><h2>Done</h2></header>
            {quest.waypoints.some(w => w.state === "verified") ? <ul className="tv-dw tv-loot">{quest.waypoints.filter(w => w.state === "verified").map(w => <LootRow key={w.id} waypoint={w} detail={detail} registry={registry} />)}</ul> : <p className="tv-empty" data-empty>Nothing was verified.</p>}
          </section>
          <section className="tv-card tv-rec-sec" aria-label="Left"><header className="tv-colh"><h2>Left</h2></header>
            {handBacks.length > 0 && <KeeperNoteRows notes={handBacks} label="Handed back to you" />}
            {quest.waypoints.some(w => w.state !== "verified") ? <ul className="tv-dw">{quest.waypoints.filter(w => w.state !== "verified").map(w => <LeftRow key={w.id} waypoint={w} skipped={detail.tale?.skipped.find(s => s.waypointId === w.id) ? readable(detail.tale.skipped.find(s => s.waypointId === w.id)!.reason, names) : undefined} />)}</ul> : !handBacks.length && <p className="tv-empty" data-empty>Nothing was left.</p>}
          </section>
        </div></Section>}
        <RecordFold id="quest.reports" title="Reports and evidence" count={plural(detail.reports.length, "report")} open={false}>
          {detail.reports.length ? <ul className="tv-items">{detail.reports.map(r => <ReportItem key={r.id} report={r} registry={registry} detail={detail} />)}</ul> : <p className="tv-empty" data-empty>No reports were filed.</p>}
        </RecordFold>
        <RecordFold id="quest.history" title="History" count={plural(history.length, "event")} open><History detail={detail} registry={registry} room={room} bare /></RecordFold>
      </div>
      <aside className="tv-col" aria-label="Party and ledger">
        <RecordFold id="quest.party" title={<Vocabulary word="party" />} count={plural(quest.members.length, "member")} open={!finished}>
          {finished ? <div className="tv-credits-w"><ol className="tv-credits n-1">{quest.members.map((member, i) => <CreditCard identity key={member.threadId} member={member} index={i} detail={detail} registry={registry} />)}</ol></div> : <KitPartyPicture members={quest.members} registry={registry} quests={[quest]} renderMember={(member, summary) => <div className="tv-party-identity"><CrestOf member={member} registry={registry} size={20} /><MemberIdentity member={member} registry={registry} compact scope={detail.scopes?.find(s => s.threadId === member.threadId)} violations={detail.violations?.filter(v => v.threadId === member.threadId)} /><button type="button" className="lnk-btn act" onClick={() => navigate.toThread(member.threadId)} aria-label={`Open ${characterName(registry, member)}’s thread`} title={summary}><OpensMark /></button></div>} />}
        </RecordFold>
        <RecordFold id="quest.kept" title="Kept in mind" count={plural(keptNotes.filter(n => n.state === "open").length, "note")} open={false}>
          <KeptInMind headless notes={keptNotes} newestFirst folds={{ promises: [promisesMore, setPromisesMore], facts: [factsMore, setFactsMore] }} />
        </RecordFold>
        <RecordFold id="quest.guards" title="Guardrails" count={plural(detail.violations?.length ?? 0, "violation")} open={!finished} preview={!finished ? <Guardrails detail={detail} registry={registry} members={members} bare compact /> : undefined}>
          <Guardrails detail={detail} registry={registry} members={members} bare compact={!finished} />
        </RecordFold>
        <RecordFold id="quest.decisions" title="Decided for you" count={plural(detail.decisionsTotal ?? detail.decisions.length, "decision")} open>
          <DecidedForYou headless decisions={[...detail.decisions].sort((a, b) => b.createdAt - a.createdAt)} limit={3} expanded={decisionsMore} onExpandedChange={setDecisionsMore} readOnly={finished} />
          {detail.decisionsNextCursor && <ol className="tv-li-list"><OlderDecisions keeperThreadId={quest.keeperThreadId} boardQuestId={quest.id} cursor={detail.decisionsNextCursor} /></ol>}
        </RecordFold>
        <RecordFold id="quest.asks" title="Asks and answers" count={plural(detail.asks.length, "ask")} open={false}><AsksRecord asks={detail.asks} /></RecordFold>
        <RecordFold id="quest.plan" title="The plan" count={plural(detail.plans.length, "version")} open={false}><PlanRecord detail={detail} /></RecordFold>
        <RecordFold id="quest.rules" title={`${keeperName === "the Keeper" ? "The Keeper’s" : `${keeperName}’s`} rules and re-anchor`} count={plural(detail.rules.filter(r => r.active).length, "rule")} open={false}><RulesAndAnchor detail={detail} keeperName={keeperName} /></RecordFold>
        <button type="button" className="btn ghost sm" onClick={() => navigate.toPluginPanel("tavern", { subPath: "map" })}><PageGlyph name="map" /><span>See it on the map</span><OpensMark /></button>
      </aside>
    </div>
  </div>;
}

/** What the steer changed: two lines, expanded in place. */
function ChangeNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 140;
  return <p className={`tv-changenote ${open ? "open" : ""}`}><span className="tv-changenote-t">{text}</span>{long && <button type="button" className="tv-fold act" aria-expanded={open} onClick={() => setOpen(!open)}><ExpandsMark open={open} /><span>{open ? "Less" : "More"}</span></button>}</p>;
}

export function ReturnedList({ room, registry, initialView = "board" }: { room: Room; registry: Registry; initialView?: "board" | "archive" }) {
  const api = useArchive();
  const navigate = useBbNavigate();
  const view = initialView;
  const setView = (next: "board" | "archive") => navigate.toPluginPanel("tavern", { subPath: next === "archive" ? "archive" : "returned", replace: true });
  const done = finishedQuests(room).filter((q) => !api.hidden.has(q.id));
  const archived = Math.max(0, room.archivedCount + api.hidden.size - api.shown.size);
  const ended = endedCounts(done);
  return <div className="tv-returned">
    <div className="tv-sline"><h1 className="tv-hero"><b className="num">{ended.returned}</b><span>returned</span></h1><div className="tv-facts">{ended.stopped > 0 && <span><b className="num">{ended.stopped}</b> stopped</span>}<span><b className="num">{archived}</b> in the cellar</span><span>each one keeps its tale and loot</span></div></div>
    <div className="tv-returned-bar"><SegFilter label="Show returned quests" value={view} onChange={setView} options={[{ id: "board", label: "On the board", count: done.length }, { id: "archive", label: vocab("cellar"), count: archived }]} /><span className="tv-sp" />{view === "board" && done.length > 1 && <button type="button" className="lnk-btn act" onClick={() => void api.archive(done)} disabled={api.pending}><PageGlyph name="archive" /><span>{CELLAR.sendAllReturned}</span></button>}</div>
    <ArchiveReceiptLine api={api} />
    <div className="tv-card tv-rows tv-wrapped">{view === "board" ? done.length ? done.map((q) => <FinishedRow key={q.id} quest={q} registry={registry} action={{ label: CELLAR.send, run: () => void api.archive([q]), disabled: api.pending }} />) : <p className="tv-empty" data-empty>No returned quests on the board{archived ? "; the rest are in the cellar" : " yet"}.</p> : <ArchivedList registry={registry} api={api} total={archived} />}</div>
  </div>;
}
