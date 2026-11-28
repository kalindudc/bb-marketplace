import { attentionView, attentionNotes } from "../../shared/attention";
import { undoKindWords, undoLaneWords } from "../../shared/undo-lane";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { experimental_useRpcQuery, experimental_useRpcMutation, experimental_useAppPanel, useBbNavigate, type ExperimentalTabReference, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import type { Decision, Rule } from "../../shared/schema";
import { QuestAuthority, activeHold, heldQuests, CheckIndependence, GuardPosture, Clamp, characterName, stoppingWords, useToday, RULE_SCOPE, localTime, ruleScopeLabel, useWidenRule, DecidedForYou, useDecisionSeen, QuietNotice, useRemembered, useRememberedView, GateRows, KeeperNoteRows, KeptInMind, ExpandsMark, FoldSummary, Glyph, OpensMark, PartyPicture, PhaseStrip, QueryState, QuestMap, SkCrest, SkDecided, SkLine, SkLines, SkPhaseStrip, StatusPill, TimeAgo, Vocabulary, clockTime, glowVars, plural, useRegistry, useSkeletonCount, useSkeletonDelay } from "../kit";
import { revealAsk } from "./state";
import { BriefSteerLine } from "../kit/brief-steer";
import { MemberSchedules } from "../kit/member-schedules";
import { NewSummaries } from "./new-summaries";
import { REPORTS_TAB } from "./reports-tab";
import { keeperGuards, keeperState, useKeeperStop } from "./keeper-state";
import { KeeperSuccessionRecord } from "../kit/succession";
import { LeadChainRows } from "./lead-chain-rows";
import { AlertAction } from "../kit/alert-action";
import { recordedScopes, ScopeRecords } from "../page/record";
import { guardAlerts } from "../kit/guard-alerts";
import "./skeletons.css";
export { JournalTab } from "./journal";

export const JOURNAL_TAB: ExperimentalTabReference & { availability: "action"; context: { kind: "thread" } } = { id: "journal", context: { kind: "thread" }, availability: "action" };
export const LEDGER_TAB: ExperimentalTabReference & { availability: "action"; context: { kind: "thread" } } = { id: "ledger", context: { kind: "thread" }, availability: "action" };

export function useKeeperVisible({ threadId }: ExperimentalThreadTabProps) { const { data } = experimental_useRpcQuery({ contract: rpcContract, method: "decor", input: { threadId } }); return data?.member?.role === "keeper"; }

/** One standing rule: its scope line with the actions, then the rule in full, since it is what the actions act on. */
function RuleRow({ rule, quest, variant = "on", lead = "", actions, onWiden }: { rule: Rule; quest: string | null; variant?: "on" | "proposed" | "off"; lead?: string; actions: ReactNode; onWiden?: () => Promise<unknown> }) {
  const { trigger, confirm } = useWidenRule({ rule, onWiden });
  const day = useToday();
  return <li className={`rule ${variant === "on" ? "" : variant}`}>
    <div className="rr-h"><span className="src" title={`Reaches ${RULE_SCOPE[rule.scope].reach}`}>{lead}{ruleScopeLabel(rule.scope, quest)}</span>{rule.widenedAt != null && <span className="m small" title={new Date(rule.widenedAt).toLocaleString()}>widened {localTime(rule.widenedAt, day)}</span>}{trigger}<span className="lg-acts">{actions}</span></div>
    <span className="t">{rule.text}</span>
    {confirm}
  </li>;
}


const SOURCE_WORD: Record<Decision["source"], string> = { steer: "your steer", ask: "your answer", user: "you", keeper: "Keeper" };
function DecisionRow({ d, undo }: { d: Decision; undo: { pending: boolean; run(id: string): void } }) {
  return <li className={d.undone ? "undone" : ""}><span className="src">{SOURCE_WORD[d.source]}</span><Clamp lines={1} text={d.text} more={d.why} /><TimeAgo at={d.createdAt} />{(d.answerReceipt || d.permanentChange) && d.reversible && !d.undone && !d.undoUnavailable && <button type="button" className="btn sm" disabled={undo.pending} onClick={() => undo.run(d.id)} aria-label={`Undo: ${d.text}`}>Undo</button>}</li>;
}
/** Older history, one bounded page per "Show more"; each page asks for the next only when the user does. */
type DecisionHistoryProps = { keeperThreadId: string; cursor: string; shown: number; total: number; undo: Parameters<typeof DecisionRow>[0]["undo"] };
function OlderDecisions({ keeperThreadId, cursor, shown, total, undo }: DecisionHistoryProps) {
  const [open, setOpen] = useState(false);
  if (!open) return <li className="lg-more"><button type="button" className="btn sm ghost act" onClick={() => setOpen(true)} aria-label={`Show older decisions: ${shown} of ${total} shown`}>Show more<span className="m">{shown} of {total}</span><ExpandsMark open={false} /></button></li>;
  return <HistoryPage keeperThreadId={keeperThreadId} cursor={cursor} shown={shown} total={total} undo={undo} />;
}
function AskHistoryPage({ threadId, cursor }: { threadId: string; cursor: string }) {
  const [open, setOpen] = useState(false);
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "askHistory", input: { threadId, cursor }, enabled: open });
  if (!open) return <li><button type="button" className="btn sm" onClick={() => setOpen(true)}>Show older</button></li>;
  return <>{query.data?.asks.map(ask => <li key={ask.id}><span className="t">{ask.question}</span><StatusPill status={ask.state}>{ask.state}</StatusPill></li>)}{query.data?.nextCursor && <AskHistoryPage threadId={threadId} cursor={query.data.nextCursor} />}<QueryState error={query.error} /></>;
}
function HistoryPage({ keeperThreadId, cursor, shown, total, undo }: DecisionHistoryProps) {
  const page = experimental_useRpcQuery({ contract: rpcContract, method: "decisionHistory", input: { keeperThreadId, cursor, limit: 100 } });
  if (!page.data) return <li className="lg-more"><QueryState error={page.error} loading={page.isLoading} retry={() => void page.refetch()} label="older decisions" skeleton={<SkLines n={3} />} /></li>;
  const now = shown + page.data.decisions.length;
  return <>{page.data.decisions.map(d => <DecisionRow key={d.id} d={d} undo={undo} />)}{page.data.nextCursor && <OlderDecisions keeperThreadId={keeperThreadId} cursor={page.data.nextCursor} shown={now} total={page.data.total} undo={undo} />}</>;
}

/** The ledger while it loads: the now line, a card per live quest this device last saw, Decided for you and the standing rules, in their own classes. */
function SkLedger({ quests }: { quests: number }) {
  return <>
    <p className="lg-now-line"><SkLine w="44%" /></p>
    {Array.from({ length: quests }, (_, i) => <section key={i} className="lg-card lg-quest">
      <div className="lg-qh"><span className="lg-qt"><b><SkLine w="20ch" /></b></span><span className="m"><SkLine w="5ch" /></span><SkPhaseStrip /></div>
      <p className="lg-move"><span className="lbl"><SkLine w="4ch" /></span><span className="mt"><SkLine w="66%" /></span></p>
      <div className="lg-move sk-crests"><SkCrest size={28} /><SkCrest size={28} /><SkCrest size={28} /></div>
      <span className="fold"><SkLine w="16ch" /></span>
    </section>)}
    <SkDecided rows={2} />
    <section className="lg-sec"><h3><SkLine w="14ch" /></h3><SkLine w="72%" /></section>
  </>;
}

function HeldResume({ quest, showHold }: { quest: import("../../shared/contract").BoardQuestSummary; showHold: boolean }) {
  const resume = experimental_useRpcMutation({ contract: rpcContract, method: "resumeBoardQuest" });
  const release = experimental_useRpcMutation({ contract: rpcContract, method: "releaseCheckerHandoff" });
  const [error, setError] = useState<unknown>(null);
  return <div className="lg-row"><span>{quest.title}</span><TimeAgo at={quest.held!.since} /><button type="button" className="btn sm" disabled={resume.isPending} onClick={() => void resume.mutate({ id: quest.id }).catch(setError)}>Resume</button>{showHold && activeHold(quest) && <button type="button" className="btn sm" disabled={release.isPending} onClick={() => void release.mutate({ boardQuestId: quest.id, holdId: activeHold(quest)!.id, via: "banner" }).catch(setError)}>Release checker handoff</button>}<QueryState error={error} /></div>;
}

export function LedgerTab({ threadId, params }: ExperimentalThreadTabProps & { params?: import("@get-bb/plugin-sdk/app").JsonValue | null }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "ledger", input: { threadId } });
  const decor = experimental_useRpcQuery({ contract: rpcContract, method: "decor", input: { threadId } });
  const registry = useRegistry();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const undo = experimental_useRpcMutation({ contract: rpcContract, method: "undoDecision" });
  const resetLane = experimental_useRpcMutation({ contract: rpcContract, method: "resetUndoLane" });
  const confirm = experimental_useRpcMutation({ contract: rpcContract, method: "confirmRule" });
  const widenRule = experimental_useRpcMutation({ contract: rpcContract, method: "widenRule" });
  const [error, setError] = useState<unknown>(null);
  // The open quest map, the history folds and scroll come back when the panel reopens on this Keeper (per device).
  const [mapOpen, setMapOpen] = useRemembered<string | null>(`ledger:${threadId}:map`, null, (v): v is string | null => v === null || typeof v === "string");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const data = query.data;
  const keeper = decor.data?.keeperView;
  const stopped = useKeeperStop(!!data);
  const activity = keeper ? keeperState(keeper, stopped) : null;
  const guard = keeperGuards(data?.scopes?.find(scope => scope.threadId === threadId) ?? decor.data?.scope);
  const root = useRef<HTMLDivElement>(null);
  useRememberedView(root, `ledger:${threadId}:view`, !!data);
  const attentionGroup = params && typeof params === "object" && !Array.isArray(params) ? params.attentionGroup : null;
  useEffect(() => {
    if (!data || (attentionGroup !== "need" && attentionGroup !== "new" && attentionGroup !== "guard")) return;
    const target = root.current?.querySelector(`[data-attention-group="${attentionGroup}"]`);
    if (target instanceof HTMLDetailsElement) target.open = true;
    target?.scrollIntoView({ block: "start" });
  }, [threadId, attentionGroup, !!data]);
  const seen = useDecisionSeen({ keeperThreadId: threadId, throughId: data?.decidedThroughId });
  const liveCount = data?.boardQuests.filter(q => q.archivedAt === null && q.phase !== "done" && q.phase !== "stopped").length;
  const skeletonQuests = useSkeletonCount(`skel:thread:ledger:${threadId}`, liveCount, 1);
  const skeletonLate = useSkeletonDelay(!data && query.isLoading);
  if (decor.data && decor.data.member?.role !== "keeper") return <div className="tavern ledger" ref={root}><p className="m">The ledger belongs to Keeper threads.</p></div>;
  const list = attentionView(data?.attention);
  const openAsks = data?.asks.filter(a => list.items.some(item => item.kind === "ask" && item.id === a.id)) ?? [];
  const guardMembers = new Map([...(decor.data?.member ? [decor.data.member] : []), ...(keeper?.errands ?? []), ...(data?.boardQuests ?? []).flatMap(quest => quest.members)].map(member => [member.threadId, member]));
  const hasGuardAlerts = recordedScopes(data?.scopes ?? [], guardMembers).some(scope => guardAlerts(scope).length > 0);
  return (
    <div className="tavern ledger" data-part="LedgerTab" ref={root}>
      <header className="journal-head">
        <div className="journal-title"><h2><Vocabulary word="ledger" /></h2><button type="button" className="btn sm narrow-only" onClick={() => panel.close()}>Back to chat</button></div>
        {!data && query.isLoading && <p className="m small" aria-hidden="true" style={skeletonLate ? undefined : { visibility: "hidden" }}><SkLine w="44%" /></p>}
        {data?.lastReanchorAt != null && <p className="m small">Re-anchored {clockTime(data.lastReanchorAt)} · <TimeAgo at={data.lastReanchorAt} /> · survives compaction</p>}
      </header>
      <QueryState error={query.error ?? registry.error ?? error} loading={query.isLoading} retry={() => void query.refetch()} label="the ledger" skeleton={<SkLedger quests={skeletonQuests} />} />
      {data?.succession && <KeeperSuccessionRecord view={data.succession} threadId={threadId} />}
      {data && <QuietNotice threadId={threadId} since={data.quietSince} />}
      {activity && activity.word !== "Quiet" && <p className="m small lg-keeper-state">{activity.word}{activity.since != null && <> since <time dateTime={new Date(activity.since).toISOString()}>{new Date(activity.since).toLocaleString()}</time></>} · {activity.detail}</p>}
      {data && <section className="lg-card lg-guards" aria-label="Guardrails">
        <details data-fold="guardrails" data-attention-group="guard" open={hasGuardAlerts}>
          <FoldSummary><Glyph name="shield" /><span>Guardrails</span></FoldSummary>
          {guard.words.length ? <ul className="lg-rows">{guard.words.map(word => <li key={word}>{word}</li>)}</ul> : <p className="m small">No guard status is recorded for this Keeper.</p>}
          {registry.data && <ScopeRecords scopes={data.scopes} observations={data.violations} keeperThreadId={threadId} registry={registry.data}
            members={guardMembers} compact bare foldViolations recheck={query.refetch} />}
        </details>
      </section>}
      {data && (() => {
        const live = data.boardQuests.filter(q => q.archivedAt === null && q.phase !== "done" && q.phase !== "stopped");
        const returned = data.boardQuests.filter(q => q.archivedAt === null && (q.phase === "done" || q.phase === "stopped"));
        const archived = data.boardQuests.filter(q => q.archivedAt !== null);
        const proposed = data.rules.filter(r => list.items.some(item => item.kind === "rule" && item.id === r.id));
        const activeRules = data.rules.filter(r => r.active);
        const offRules = data.rules.filter(r => !r.active && r.source !== "keeper-proposed");
        const answered = data.asks.filter(a => a.state !== "open");
        const keeperCalls = data.decisions.filter(d => d.source === "keeper" || d.checkChange);
        // The server's attention list (unseen, reversible Keeper calls outside the cellar) is the one the widget counts; the fallback applies the same rule to the loaded history.
        const cellared = new Set(archived.map(q => q.id));
        const attention = data.decidedForYou ?? keeperCalls.filter(d => !d.undone && d.reversible && d.seenAt == null && !(d.boardQuestId && cellared.has(d.boardQuestId)));
        const decidedCount = data.decidedCount ?? attention.length;
        const historyTotal = data.decisionsTotal ?? data.decisions.length;
        const undoFromHistory = { pending: undo.isPending, run: (decisionId: string) => void undo.mutate({ decisionId }).catch(setError) };
        const short = (id: string | null) => data.boardQuests.find(q => q.id === id)?.short ?? null;
        const setRule = (id: string, active: boolean) => void confirm.mutate({ ruleId: id, active }).catch(setError);
        const questTitle = (r: Rule) => r.scope === "quest" ? data.boardQuests.find(q => q.id === r.scopeId)?.title ?? null : null;
        const widen = (r: Rule) => () => widenRule.mutate({ ruleId: r.id, scope: "global" });
        const notes = (data.notes ?? []).filter(n => n.state === "open");
        const waiting = attentionNotes(list);
        const promises = notes.filter(n => n.kind === "commitment");
        // A hold the Keeper asked about is listed once, as its ask; the rest are released in the widget row, like an ask is answered there.
        const held = heldQuests(live, openAsks).filter(q => q.phase !== "held");
        const needsYou = list.needYou;
        const heldByYou = live.filter(q => list.items.some(item => item.kind === "held" && item.id === q.id));
        return <>
          <p className="lg-now-line" aria-label="What the Keeper knows now">{plural(live.length, "active quest")} · {needsYou} need you · {list.new} new ({plural(list.summaries ?? 0, "answer")}, {plural(list.decided ?? list.new, "unseen call")})</p>
          {heldByYou.length > 0 && <section className="lg-card" aria-label="Held by you"><h3>Held by you · {plural(list.heldByYou, "quest")}</h3>{heldByYou.map(q => <HeldResume key={q.id} quest={q} showHold={list.items.some(item => item.kind === "hold" && item.questId === q.id)} />)}</section>}
          {needsYou > 0 && <section className="lg-card lg-needs glow" style={glowVars(`needs:${threadId}`) as CSSProperties} aria-label="Needs you" data-attention-group="need">
            <h3><Glyph name="ask" size={13} /><span>Needs you</span><span className="num">{needsYou} need you</span></h3>
            {openAsks.length > 0 && <ul className="lg-rows">{openAsks.map(a => <li key={a.id}><button type="button" className="lg-row act" title={`${a.question} · answer in the Tavern row above the composer`} onClick={() => revealAsk(threadId, a.id)}><span className="t">{a.question}</span>{short(a.boardQuestId) && <span className="lg-q">{short(a.boardQuestId)}</span>}<TimeAgo at={a.createdAt} /><span className="lg-go">Answer<ExpandsMark open={false} /></span></button></li>)}</ul>}
            {held.length > 0 && <ul className="lg-rows">{held.map(q => { const hold = activeHold(q)!; return <li key={hold.id} data-ask><button type="button" className="lg-row act" title={`Checker handoff on hold: ${hold.reason} · release it in the Tavern row above the composer`} onClick={() => revealAsk(threadId, `hold:${hold.id}`)}><span className="t">Checker handoff on hold: {hold.reason}</span><span className="lg-q">{q.short}</span><TimeAgo at={hold.createdAt} /><span className="lg-go">Review<ExpandsMark open={false} /></span></button></li>; })}</ul>}
            {list.items.filter(item => item.kind === "hold" && item.id.startsWith("spend:") && item.questId).map(item => <p key={item.id}>{item.title} <AlertAction action={{ kind: "run", label: "Review quest spend",
              run: () => navigate.toPluginPanel("tavern", { subPath: `quest/${item.questId}` }) }} /></p>)}
            {waiting.length > 0 && <><p className="lbl">Waiting on you <span className="anc">the Keeper handed back</span></p><KeeperNoteRows notes={waiting} short={short} label="Waiting on you" /></>}
            {proposed.length > 0 && <ul className="lg-rows lg-rules">{proposed.map(r => <RuleRow key={r.id} rule={r} variant="proposed" lead="Proposed · " quest={questTitle(r)} actions={<><button type="button" className="btn sm pri" disabled={confirm.isPending} aria-label={`Confirm the rule: ${r.text}`} onClick={() => setRule(r.id, true)}>Confirm</button><button type="button" className="btn sm" disabled={confirm.isPending} aria-label={`Dismiss the proposed rule: ${r.text}`} onClick={() => { setRule(r.id, false); setDismissed(d => [...d, r.id]); }}>Dismiss</button></>} />)}</ul>}
          </section>}
          {!!data.keeperBlocks?.length && <section className="lg-card" aria-label="The Keeper is handling"><h3>The Keeper is handling</h3>
            <ul className="lg-rows">{data.keeperBlocks.map(block => <li key={block.id}><b>{block.question}</b> <span>{block.why}</span>
              <AlertAction action={{ kind: "tell", keeperThreadId: threadId, text: `Review the blocker “${block.question}” and tell me the next safe step.` }} /></li>)}</ul>
          </section>}
          {!!data.rangerCheckpoints?.length && <section className="lg-card" aria-label="Ranger check-ins">
            <h3>Ranger check-ins</h3>
            <ul className="lg-rows lg-briefs">{data.rangerCheckpoints.map(({ memberThreadId, boardQuestId, name, reportId, state }) => <li key={memberThreadId}>
              <p><b>{name}</b> · <span>{state}</span></p>
              <button type="button" className="lnk-btn act" aria-label={`View report from ${name}`}
                onClick={() => panel.openTab({ tab: REPORTS_TAB, params: { memberThreadId, questId: boardQuestId, reportId } })}>View report <OpensMark /></button>
            </li>)}</ul>
          </section>}
          {!!data.memberBriefs?.length && <section className="lg-card" aria-label="Pending member briefs">
            <h3>Pending member briefs</h3>
            <ul className="lg-rows lg-briefs">{data.memberBriefs.map(({ memberThreadId, name, doing, pendingBrief: brief }) => <li key={memberThreadId}>
              <p><b>{name}</b> · {{ queued: "Queued", delivering: "Delivering", unconfirmed: "Unconfirmed", blocked: "Blocked" }[brief.state]} · {plural(brief.attempts, "attempt")} · <TimeAgo at={brief.createdAt} /></p>
              <p>Current work: {doing || "None recorded"}</p>
              <p>Pending: {brief.firstLine || "No first line"} <span className="m">· {brief.id}</span></p>
              {(brief.state === "blocked" || brief.state === "unconfirmed") && <AlertAction action={{ kind: "tell", keeperThreadId: threadId,
                text: `Check whether ${name} received the pending brief. Reconcile its delivery before sending it again.` }} />}
            </li>)}</ul>
          </section>}
          <NewSummaries attention={list} />
          {live.map((q, i) => (
            <section className={`lg-card lg-quest ${i === 0 && needsYou === 0 ? "glow" : ""}`} style={i === 0 && needsYou === 0 ? glowVars(`ledger:${q.id}`) as CSSProperties : undefined} key={q.id} aria-label={`Board quest: ${q.title}`}>
              <div className="lg-qh"><button type="button" className="lg-qt act" title={`Open the quest page: ${q.title}`} onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${q.id}` })}><b className="clamp">{q.title}</b><OpensMark /></button><span className="m">plan v{q.planVersion}</span><PhaseStrip phase={q.phase} /></div>
              {q.phase === "stopping"
                ? <p className="lg-move who-nobody lg-stopping" title={`Stopping · ${stoppingWords(q)}`}><span className="lbl">Stopping</span><span className="mt">{stoppingWords(q)}</span></p>
                : <p className={`lg-move who-${q.move.who}`} title={q.move.text}><span className="lbl">{q.move.who === "you" ? "Your move" : q.move.who === "outside" ? "Waiting outside" : "Next"}</span>{q.move.askId ? <button type="button" className="lnk-btn act mt" onClick={() => revealAsk(threadId, q.move.askId!)} title={q.move.text}>Answer ask: {q.move.text}</button> : <span className="mt">{q.move.text}</span>}</p>}
              {q.plan?.fromSteer && <Clamp className="lg-steer" lines={1} text={`From your steer, ${clockTime(q.plan.fromSteer.at)}: “${q.plan.fromSteer.text}”`} />}
              <GateRows waypoints={q.waypoints} />
              {registry.data && q.members.length > 0 && <PartyPicture ambientMotion={decor.data?.ambientMotion} repeatSeconds={decor.data?.repeatSeconds} members={q.members} quests={[q]} registry={registry.data} mini onOpen={id => navigate.toThread(id)} />}
              {q.briefSteers?.map(steer => {
                const member = q.members.find(m => m.threadId === steer.memberThreadId);
                return member ? <BriefSteerLine key={member.threadId} name={registry.data ? characterName(registry.data, member) : member.displayName ?? member.classId} steer={steer} /> : null;
              })}
              {q.members.map(m => m.permanent && <div key={`permanent-${m.threadId}`}><p className="m small" data-content><b>{registry.data ? characterName(registry.data, m) : m.displayName ?? m.classId}</b> · Permanent: {m.permanent.why}{m.permanent.closingExemption && <> · Closing time pause exempt (guard required): {m.permanent.closingExemption.why}</>}</p>{m.permanent.schedules?.length ? <MemberSchedules member={m} /> : null}</div>)}
              {q.members.filter(m => m.restNote).map(m => <p className="m small" key={`rest-${m.threadId}`}><b>{registry.data ? characterName(registry.data, m) : m.displayName ?? m.classId}</b> {m.restNote}</p>)}
              {q.members.filter(m => m.checkIndependence === "same-family" || m.checkIndependence === "not-established" || m.guardPosture?.mode === "detection-only").map(m => <p className="lg-indep" key={m.threadId}><b>{registry.data ? characterName(registry.data, m) : m.displayName ?? m.classId}</b><CheckIndependence member={m} /><GuardPosture member={m} /></p>)}
              <button type="button" className="fold" aria-expanded={mapOpen === q.id} onClick={() => setMapOpen(mapOpen === q.id ? null : q.id)}><Glyph name="chevron" size={12} className={mapOpen === q.id ? "down" : ""} /><span><Vocabulary word="map" /> · {q.waypoints.length} waypoints</span></button>
              {mapOpen === q.id && <QuestMap quest={q} mode="live" rowsOnly onOpenAsk={id => revealAsk(threadId, id)} />}
              <LeadChainRows chain={q.leadChain} map={mapOpen === q.id ? q.waypoints : undefined} />
            </section>
          ))}
          <KeptInMind notes={notes} total={data.notesTotal} older={data.olderPromises} short={short} />
          <h3 data-attention-group="new">New for you</h3>
          {!!data.undoLanes?.length && <section className="lg-card" aria-label="Decisions that now ask you">
            <h3>Decisions that now ask you</h3>
            <ul className="lg-undo-lanes">{data.undoLanes.map(lane => <li key={lane.kind}>
              <span>{undoLaneWords(lane)}</span>
              <button className="btn sm" type="button" aria-label={`Reset ${undoKindWords[lane.kind]}`} disabled={resetLane.isPending} onClick={() => void resetLane.mutate({ threadId, kind: lane.kind }).catch(setError)}>Reset</button>
            </li>)}</ul>
          </section>}
          <DecidedForYou decisions={attention} total={decidedCount} pending={undo.isPending} onUndo={id => void undo.mutate({ decisionId: id }).catch(setError)} {...seen} />
          {data.boardQuests.map(q => <QuestAuthority key={q.id} questId={q.id} via="banner" compact />)}
          <section className="lg-sec" aria-label="Standing rules">
            <h3>Standing rules <span className="num">{activeRules.length} on</span></h3>
            {activeRules.length === 0 ? <p className="m small">No standing rules yet. Use “Make this a rule” on any message.</p>
              : <ul className="lg-rows lg-rules">{activeRules.map(r => <RuleRow key={r.id} rule={r} quest={questTitle(r)} onWiden={widen(r)} actions={<button type="button" className="btn sm" disabled={confirm.isPending} aria-label={`Turn off the rule: ${r.text}`} onClick={() => setRule(r.id, false)}>Turn off</button>} />)}</ul>}
          </section>
          {returned.length > 0 && <ul className="lg-rows lg-done" aria-label="Returned quests">{returned.map(q => <li key={q.id}><button type="button" className="lg-row act" title={`Open the quest page: ${q.title}. ${q.move.text}`} onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${q.id}` })}><span className="t">{q.title}</span><span className="m">{q.move.text}</span><OpensMark /></button></li>)}</ul>}
          <div className="lg-history" role="group" aria-label="History">
            <h3 className="lbl">History</h3>
            {answered.length > 0 && <details className="lg-fold" data-fold="answered"><summary><Glyph name="chevron" size={12} /><span>Past asks</span><span className="num">{answered.length}</span></summary><ul className="lg-rows">{answered.map(a => <li key={a.id}><span className="lg-row"><StatusPill status={a.state === "answered" ? "answered" : a.state}>{a.state}</StatusPill><span className="t" title={a.question}>{a.question}</span><TimeAgo at={a.answer?.at ?? a.createdAt} /></span></li>)}{data.asksNextCursor && <AskHistoryPage threadId={threadId} cursor={data.asksNextCursor} />}</ul></details>}
            <details className="lg-fold" data-fold="decisions"><summary><Glyph name="chevron" size={12} /><span>All decisions</span><span className="num">{historyTotal}</span><span className="anc">{historyTotal > data.decisions.length ? "newest first" : `${keeperCalls.length} by the Keeper alone · ${data.decisions.length - keeperCalls.length} from you`}</span></summary><ul className="lg-rows">{data.decisions.map(d => <DecisionRow key={d.id} d={d} undo={undoFromHistory} />)}{data.decisionsNextCursor && <OlderDecisions keeperThreadId={threadId} cursor={data.decisionsNextCursor} shown={data.decisions.length} total={historyTotal} undo={undoFromHistory} />}</ul></details>
            {offRules.length > 0 && <details className="lg-fold" data-fold="rules-off"><summary><Glyph name="chevron" size={12} /><span>Rules turned off</span><span className="num">{offRules.length}</span></summary><ul className="lg-rows lg-rules">{offRules.map(r => <RuleRow key={r.id} rule={r} variant="off" quest={questTitle(r)} actions={<button type="button" className="btn sm" disabled={confirm.isPending} aria-label={`Turn on the rule: ${r.text}`} onClick={() => setRule(r.id, true)}>Turn on</button>} />)}</ul></details>}
            {!!data.scheduledRounds?.length && <details className="lg-fold"><summary><Glyph name="chevron" size={12} /><span>Recent scheduled rounds</span><span className="num">{data.scheduledRounds.length}</span></summary>
              <ul className="lg-rows">{data.scheduledRounds.map(round => <li key={round.id}><span className="lg-row"><span className="t" data-content>{round.text}</span><TimeAgo at={round.at} /></span></li>)}</ul>
            </details>}
            {data.routes.length > 0 && <details className="lg-fold" data-fold="routes"><summary><Glyph name="chevron" size={12} /><span>Read as</span><span className="num">{data.routes.length}</span><span className="anc">how the Keeper took your messages</span></summary><ul className="lg-rows">{data.routes.map(r => <li key={r.id}><span className={`route-chip k-${r.kind}`}>{r.kind === "new-quest" ? "new quest" : r.kind}</span><Clamp lines={1} text={`${r.summary}${r.corrected ? " · corrected" : ""}`} /><TimeAgo at={r.createdAt} /></li>)}</ul></details>}
            {archived.length > 0 && <details className="lg-fold" data-fold="cellar"><summary><Glyph name="chevron" size={12} /><span><Vocabulary word="cellar" /></span><span className="num">{archived.length}</span></summary><ul className="lg-rows">{archived.map(q => <li key={q.id}><button type="button" className="lg-row act" onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${q.id}` })}><span className="t">{q.title}</span><OpensMark /></button></li>)}</ul></details>}
            <details className="lg-fold" data-fold="anchor"><summary><Glyph name="chevron" size={12} /><span>What the Keeper is anchored with</span></summary><pre>{data.restatement}</pre></details>
          </div>
        </>;
      })()}
    </div>
  );
}
