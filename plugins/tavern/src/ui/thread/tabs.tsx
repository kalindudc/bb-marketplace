import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { experimental_useRpcQuery, experimental_useRpcMutation, experimental_useAppPanel, useBbNavigate, type ExperimentalTabReference, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import type { Decision, Rule } from "../../shared/schema";
import { QuestAuthority, activeHold, heldQuests, CheckIndependence, GuardPosture, Clamp, characterName, stoppingWords, useToday, RULE_SCOPE, localTime, ruleScopeLabel, useWidenRule, DecidedForYou, useDecisionSeen, QuietNotice, useRemembered, useRememberedView, GateRows, KeeperNoteRows, KeptInMind, ExpandsMark, Glyph, OpensMark, PartyPicture, PhaseStrip, QueryState, QuestMap, SkCrest, SkDecided, SkLine, SkLines, SkPhaseStrip, StatusPill, TimeAgo, Vocabulary, clockTime, glowVars, plural, useRegistry, useSkeletonCount, useSkeletonDelay } from "../kit";
import { revealAsk } from "./state";
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
function DecisionRow({ d }: { d: Decision }) {
  return <li className={d.undone ? "undone" : ""}><span className="src">{SOURCE_WORD[d.source]}</span><Clamp lines={1} text={d.text} more={d.why} /><TimeAgo at={d.createdAt} /></li>;
}
/** Older history, one bounded page per "Show more"; each page asks for the next only when the user does. */
function OlderDecisions({ keeperThreadId, cursor, shown, total }: { keeperThreadId: string; cursor: string; shown: number; total: number }) {
  const [open, setOpen] = useState(false);
  if (!open) return <li className="lg-more"><button type="button" className="btn sm ghost act" onClick={() => setOpen(true)} aria-label={`Show older decisions: ${shown} of ${total} shown`}>Show more<span className="m">{shown} of {total}</span><ExpandsMark open={false} /></button></li>;
  return <HistoryPage keeperThreadId={keeperThreadId} cursor={cursor} shown={shown} total={total} />;
}
function HistoryPage({ keeperThreadId, cursor, shown, total }: { keeperThreadId: string; cursor: string; shown: number; total: number }) {
  const page = experimental_useRpcQuery({ contract: rpcContract, method: "decisionHistory", input: { keeperThreadId, cursor, limit: 100 } });
  if (!page.data) return <li className="lg-more"><QueryState error={page.error} loading={page.isLoading} retry={() => void page.refetch()} label="older decisions" skeleton={<SkLines n={3} />} /></li>;
  const now = shown + page.data.decisions.length;
  return <>{page.data.decisions.map(d => <DecisionRow key={d.id} d={d} />)}{page.data.nextCursor && <OlderDecisions keeperThreadId={keeperThreadId} cursor={page.data.nextCursor} shown={now} total={page.data.total} />}</>;
}

/** The ledger while it loads: the now line, a card per live quest this device last saw, Decided for you and the standing rules, in their own classes. */
function SkLedger({ quests }: { quests: number }) {
  return <>
    <p className="lg-now-line"><SkLine w="58%" /></p>
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

export function LedgerTab({ threadId }: ExperimentalThreadTabProps) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "ledger", input: { threadId } });
  const decor = experimental_useRpcQuery({ contract: rpcContract, method: "decor", input: { threadId } });
  const registry = useRegistry();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const undo = experimental_useRpcMutation({ contract: rpcContract, method: "undoDecision" });
  const confirm = experimental_useRpcMutation({ contract: rpcContract, method: "confirmRule" });
  const widenRule = experimental_useRpcMutation({ contract: rpcContract, method: "widenRule" });
  const [error, setError] = useState<unknown>(null);
  // The open quest map, the history folds and scroll come back when the panel reopens on this Keeper (per device).
  const [mapOpen, setMapOpen] = useRemembered<string | null>(`ledger:${threadId}:map`, null, (v): v is string | null => v === null || typeof v === "string");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const data = query.data;
  const root = useRef<HTMLDivElement>(null);
  useRememberedView(root, `ledger:${threadId}:view`, !!data);
  const seen = useDecisionSeen({ keeperThreadId: threadId, throughId: data?.decidedThroughId });
  const liveCount = data?.boardQuests.filter(q => q.archivedAt === null && q.phase !== "done" && q.phase !== "stopped").length;
  const skeletonQuests = useSkeletonCount(`skel:thread:ledger:${threadId}`, liveCount, 1);
  const skeletonLate = useSkeletonDelay(!data && query.isLoading);
  if (decor.data && decor.data.member?.role !== "keeper") return <div className="tavern ledger" ref={root}><p className="m">The ledger belongs to Keeper threads.</p></div>;
  const openAsks = data?.asks.filter(a => a.state === "open" && a.lane !== "keeper") ?? [];
  return (
    <div className="tavern ledger" data-part="LedgerTab" ref={root}>
      <header className="journal-head">
        <div className="journal-title"><h2><Vocabulary word="ledger" /></h2><button type="button" className="btn sm narrow-only" onClick={() => panel.close()}>Back to chat</button></div>
        {!data && query.isLoading && <p className="m small" aria-hidden="true" style={skeletonLate ? undefined : { visibility: "hidden" }}><SkLine w="44%" /></p>}
        {data?.lastReanchorAt != null && <p className="m small">Re-anchored {clockTime(data.lastReanchorAt)} · <TimeAgo at={data.lastReanchorAt} /> · survives compaction</p>}
      </header>
      <QueryState error={query.error ?? registry.error ?? error} loading={query.isLoading} retry={() => void query.refetch()} label="the ledger" skeleton={<SkLedger quests={skeletonQuests} />} />
      {data && <QuietNotice threadId={threadId} since={data.quietSince} />}
      {data && (() => {
        const live = data.boardQuests.filter(q => q.archivedAt === null && q.phase !== "done" && q.phase !== "stopped");
        const returned = data.boardQuests.filter(q => q.archivedAt === null && (q.phase === "done" || q.phase === "stopped"));
        const archived = data.boardQuests.filter(q => q.archivedAt !== null);
        const proposed = data.rules.filter(r => !r.active && r.source === "keeper-proposed" && !dismissed.includes(r.id));
        const activeRules = data.rules.filter(r => r.active);
        const offRules = data.rules.filter(r => !r.active && r.source !== "keeper-proposed");
        const answered = data.asks.filter(a => a.state !== "open");
        const keeperCalls = data.decisions.filter(d => d.source === "keeper");
        // The server's attention list (unseen, reversible Keeper calls outside the cellar) is the one the widget counts; the fallback applies the same rule to the loaded history.
        const cellared = new Set(archived.map(q => q.id));
        const attention = data.decidedForYou ?? keeperCalls.filter(d => !d.undone && d.reversible && d.seenAt == null && !(d.boardQuestId && cellared.has(d.boardQuestId)));
        const decidedCount = data.decidedCount ?? attention.length;
        const historyTotal = data.decisionsTotal ?? data.decisions.length;
        const short = (id: string | null) => data.boardQuests.find(q => q.id === id)?.short ?? null;
        const setRule = (id: string, active: boolean) => void confirm.mutate({ ruleId: id, active }).catch(setError);
        const questTitle = (r: Rule) => r.scope === "quest" ? data.boardQuests.find(q => q.id === r.scopeId)?.title ?? null : null;
        const widen = (r: Rule) => () => widenRule.mutate({ ruleId: r.id, scope: "global" });
        const notes = (data.notes ?? []).filter(n => n.state === "open");
        const waiting = notes.filter(n => n.kind === "waiting-on-user");
        const promises = notes.filter(n => n.kind === "commitment");
        // A hold the Keeper asked about is listed once, as its ask; the rest are released in the widget row, like an ask is answered there.
        const held = heldQuests(live, openAsks);
        const needsYou = openAsks.length + held.length + proposed.length + waiting.length;
        return <>
          <p className="lg-now-line" aria-label="What the Keeper knows now">{plural(live.length, "active quest")} · {plural(openAsks.length, "ask")} open{held.length > 0 && <> · {plural(held.length, "hold")} to release</>}{proposed.length > 0 && <> · {plural(proposed.length, "rule")} to confirm</>}{promises.length > 0 && <> · {plural(promises.length, "promise")} kept</>} · {decidedCount} decided for you</p>
          {needsYou > 0 && <section className="lg-card lg-needs glow" style={glowVars(`needs:${threadId}`) as CSSProperties} aria-label="Needs you">
            <h3><Glyph name="ask" size={13} /><span>Needs you</span><span className="num">{[openAsks.length > 0 && plural(openAsks.length, "ask"), held.length > 0 && plural(held.length, "hold"), proposed.length > 0 && plural(proposed.length, "rule"), waiting.length > 0 && plural(waiting.length, "hand-back")].filter(Boolean).join(" · ")}</span></h3>
            {openAsks.length > 0 && <ul className="lg-rows">{openAsks.map(a => <li key={a.id}><button type="button" className="lg-row act" title={`${a.question} · answer in the Tavern row above the composer`} onClick={() => revealAsk(threadId, a.id)}><span className="t">{a.question}</span>{short(a.boardQuestId) && <span className="lg-q">{short(a.boardQuestId)}</span>}<TimeAgo at={a.createdAt} /><span className="lg-go">Answer<ExpandsMark open={false} /></span></button></li>)}</ul>}
            {held.length > 0 && <ul className="lg-rows">{held.map(q => { const hold = activeHold(q)!; return <li key={hold.id} data-ask><button type="button" className="lg-row act" title={`Checker handoff on hold: ${hold.reason} · release it in the Tavern row above the composer`} onClick={() => revealAsk(threadId, `hold:${hold.id}`)}><span className="t">Checker handoff on hold: {hold.reason}</span><span className="lg-q">{q.short}</span><TimeAgo at={hold.createdAt} /><span className="lg-go">Review<ExpandsMark open={false} /></span></button></li>; })}</ul>}
            {waiting.length > 0 && <><p className="lbl">Waiting on you <span className="anc">the Keeper handed back</span></p><KeeperNoteRows notes={waiting} short={short} label="Waiting on you" /></>}
            {proposed.length > 0 && <ul className="lg-rows lg-rules">{proposed.map(r => <RuleRow key={r.id} rule={r} variant="proposed" lead="Proposed · " quest={questTitle(r)} actions={<><button type="button" className="btn sm pri" disabled={confirm.isPending} aria-label={`Confirm the rule: ${r.text}`} onClick={() => setRule(r.id, true)}>Confirm</button><button type="button" className="btn sm" disabled={confirm.isPending} aria-label={`Dismiss the proposed rule: ${r.text}`} onClick={() => { setRule(r.id, false); setDismissed(d => [...d, r.id]); }}>Dismiss</button></>} />)}</ul>}
          </section>}
          {live.map((q, i) => (
            <section className={`lg-card lg-quest ${i === 0 && needsYou === 0 ? "glow" : ""}`} style={i === 0 && needsYou === 0 ? glowVars(`ledger:${q.id}`) as CSSProperties : undefined} key={q.id} aria-label={`Board quest: ${q.title}`}>
              <div className="lg-qh"><button type="button" className="lg-qt act" title={`Open the quest page: ${q.title}`} onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${q.id}` })}><b className="clamp">{q.title}</b><OpensMark /></button><span className="m">plan v{q.planVersion}</span><PhaseStrip phase={q.phase} /></div>
              {q.phase === "stopping"
                ? <p className="lg-move who-nobody lg-stopping" title={`Stopping · ${stoppingWords(q)}`}><span className="lbl">Stopping</span><span className="mt">{stoppingWords(q)}</span></p>
                : <p className={`lg-move who-${q.move.who}`} title={q.move.text}><span className="lbl">{q.move.who === "you" ? "Your move" : q.move.who === "outside" ? "Waiting outside" : "Next"}</span><span className="mt">{q.move.text}</span></p>}
              {q.plan?.fromSteer && <Clamp className="lg-steer" lines={1} text={`From your steer, ${clockTime(q.plan.fromSteer.at)}: “${q.plan.fromSteer.text}”`} />}
              <GateRows waypoints={q.waypoints} />
              {registry.data && q.members.length > 0 && <PartyPicture ambientMotion={decor.data?.ambientMotion} repeatSeconds={decor.data?.repeatSeconds} members={q.members} quests={[q]} registry={registry.data} mini onOpen={id => navigate.toThread(id)} />}
              {q.members.filter(m => m.restNote).map(m => <p className="m small" key={`rest-${m.threadId}`}><b>{registry.data ? characterName(registry.data, m) : m.displayName ?? m.classId}</b> {m.restNote}</p>)}
              {q.members.filter(m => m.checkIndependence === "same-family" || m.checkIndependence === "not-established" || m.guardPosture?.mode === "detection-only").map(m => <p className="lg-indep" key={m.threadId}><b>{registry.data ? characterName(registry.data, m) : m.displayName ?? m.classId}</b><CheckIndependence member={m} /><GuardPosture member={m} /></p>)}
              <button type="button" className="fold" aria-expanded={mapOpen === q.id} onClick={() => setMapOpen(mapOpen === q.id ? null : q.id)}><Glyph name="chevron" size={12} className={mapOpen === q.id ? "down" : ""} /><span><Vocabulary word="map" /> · {q.waypoints.length} waypoints</span></button>
              {mapOpen === q.id && <QuestMap quest={q} mode="live" />}
            </section>
          ))}
          <KeptInMind notes={notes} total={data.notesTotal} older={data.olderPromises} short={short} />
          <DecidedForYou decisions={attention} total={decidedCount} pending={undo.isPending} onUndo={id => void undo.mutate({ decisionId: id }).catch(setError)} {...seen} />
          {data.boardQuests.map(q => <QuestAuthority key={q.id} questId={q.id} via="banner" compact />)}
          <section className="lg-sec" aria-label="Standing rules">
            <h3>Standing rules <span className="num">{activeRules.length} on</span></h3>
            {activeRules.length === 0 ? <p className="m small">No standing rules yet. Use “Make this a rule” on any message.</p>
              : <ul className="lg-rows lg-rules">{activeRules.map(r => <RuleRow key={r.id} rule={r} quest={questTitle(r)} onWiden={widen(r)} actions={<button type="button" className="btn sm" disabled={confirm.isPending} aria-label={`Turn off the rule: ${r.text}`} onClick={() => setRule(r.id, false)}>Turn off</button>} />)}</ul>}
          </section>
          {returned.length > 0 && <ul className="lg-rows lg-done" aria-label="Returned quests">{returned.map(q => { const verified = q.waypoints.filter(w => w.verifiedBy !== null).length; return <li key={q.id}><button type="button" className="lg-row act" title={`Open the quest page: ${q.title}`} onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${q.id}` })}><span className="t">{q.title}</span><span className="m">{q.phase === "stopped" ? "Stopped" : "Returned"} · verified {verified} of {q.waypoints.length}</span><OpensMark /></button></li>; })}</ul>}
          <div className="lg-history" role="group" aria-label="History">
            <h3 className="lbl">History</h3>
            {answered.length > 0 && <details className="lg-fold" data-fold="answered"><summary><Glyph name="chevron" size={12} /><span>Answered asks</span><span className="num">{answered.length}</span></summary><ul className="lg-rows">{answered.map(a => <li key={a.id}><span className="lg-row"><StatusPill status={a.state === "answered" ? "answered" : a.state}>{a.state}</StatusPill><span className="t" title={a.question}>{a.question}</span><TimeAgo at={a.answer?.at ?? a.createdAt} /></span></li>)}</ul></details>}
            <details className="lg-fold" data-fold="decisions"><summary><Glyph name="chevron" size={12} /><span>All decisions</span><span className="num">{historyTotal}</span><span className="anc">{historyTotal > data.decisions.length ? "newest first" : `${keeperCalls.length} by the Keeper alone · ${data.decisions.length - keeperCalls.length} from you`}</span></summary><ul className="lg-rows">{data.decisions.map(d => <DecisionRow key={d.id} d={d} />)}{data.decisionsNextCursor && <OlderDecisions keeperThreadId={threadId} cursor={data.decisionsNextCursor} shown={data.decisions.length} total={historyTotal} />}</ul></details>
            {offRules.length > 0 && <details className="lg-fold" data-fold="rules-off"><summary><Glyph name="chevron" size={12} /><span>Rules turned off</span><span className="num">{offRules.length}</span></summary><ul className="lg-rows lg-rules">{offRules.map(r => <RuleRow key={r.id} rule={r} variant="off" quest={questTitle(r)} actions={<button type="button" className="btn sm" disabled={confirm.isPending} aria-label={`Turn on the rule: ${r.text}`} onClick={() => setRule(r.id, true)}>Turn on</button>} />)}</ul></details>}
            {data.routes.length > 0 && <details className="lg-fold" data-fold="routes"><summary><Glyph name="chevron" size={12} /><span>Read as</span><span className="num">{data.routes.length}</span><span className="anc">how the Keeper took your messages</span></summary><ul className="lg-rows">{data.routes.map(r => <li key={r.id}><span className={`route-chip k-${r.kind}`}>{r.kind === "new-quest" ? "new quest" : r.kind}</span><Clamp lines={1} text={`${r.summary}${r.corrected ? " · corrected" : ""}`} /><TimeAgo at={r.createdAt} /></li>)}</ul></details>}
            {archived.length > 0 && <details className="lg-fold" data-fold="cellar"><summary><Glyph name="chevron" size={12} /><span><Vocabulary word="cellar" /></span><span className="num">{archived.length}</span></summary><ul className="lg-rows">{archived.map(q => <li key={q.id}><button type="button" className="lg-row act" onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${q.id}` })}><span className="t">{q.title}</span><OpensMark /></button></li>)}</ul></details>}
            <details className="lg-fold" data-fold="anchor"><summary><Glyph name="chevron" size={12} /><span>What the Keeper is anchored with</span></summary><pre>{data.restatement}</pre></details>
          </div>
        </>;
      })()}
    </div>
  );
}
