import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { useMemo, useState } from "react";
import { rpcContract, type BoardQuestDetail, type Room } from "../../shared/contract";
import type { Decision, Member, Report, Rule } from "../../shared/schema";
import { memberName } from "../../shared/member-name";
import { voiceShown, CheckIndependence, GuardPosture, ExpandsMark, OpensMark, RULE_SCOPE, guardRecordWords, useToday, isFinished, ReportView, memberReportNames, ruleScopeLabel, useWidenRule } from "../kit";
import { Ago, CrestOf, Section, SegFilter, StateMark, characterName, plural, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { describeEvent, foldRuns, questsIn, taleHeadline, visibleMembers, type EventLine } from "./model";
import { EventList } from "./room";
import { usePanelState } from "./panel-state";
import { reportsTitle, useOpenReports } from "./reports";
import { MemberEstimate } from "../kit/member-estimate";
import { FoldLoad } from "./skeletons";
import { GuardAlerts, guardAlerts } from "../kit/guard-alerts";

/* Pieces of a quest's record that the live quest page and the finished record page both draw. */

/** A standing rule as the Ledger shows it: who it reaches on one line with its actions, then the full text. On the quest's own page the scope needs no title. */
export function RuleRow({ rule }: { rule: Rule }) {
  const widen = experimental_useRpcMutation({ contract: rpcContract, method: "widenRule" });
  const decide = experimental_useRpcMutation({ contract: rpcContract, method: "confirmRule" });
  const [dismissed, setDismissed] = useState(false);
  const proposed = !rule.active && rule.source === "keeper-proposed";
  const { trigger, confirm } = useWidenRule({ rule, onWiden: () => widen.mutate({ ruleId: rule.id, scope: "global" }) });
  if (dismissed) return null;
  return <li className={`tv-rule ${proposed ? "pending" : ""}`}>
    <span className="tv-rule-scope"><span title={`Reaches ${RULE_SCOPE[rule.scope].reach}`}>{proposed ? "Proposed · " : ""}{ruleScopeLabel(rule.scope)}</span>{trigger}
      {proposed && <span className="tv-rule-acts">
        <button type="button" className="btn sm pri" disabled={decide.isPending} aria-label={`Confirm the rule: ${rule.text}`} onClick={() => void decide.mutate({ ruleId: rule.id, active: true })}>Confirm</button>
        <button type="button" className="btn sm" disabled={decide.isPending} aria-label={`Dismiss the proposed rule: ${rule.text}`} onClick={() => void decide.mutate({ ruleId: rule.id, active: false }).then(() => setDismissed(true))}>Dismiss</button>
      </span>}
    </span>
    <span className="tv-rule-t" data-content>{rule.text}</span>
    {confirm}
  </li>;
}

export function DecisionLine({ decision: d }: { decision: Decision }) {
  return <li><span data-content className={d.undone ? "undone" : ""}><b>{d.text}</b> <span className="m">· {d.why}</span></span><span className="m small">{d.undone ? "undone" : d.source === "keeper" ? "decided" : d.source}</span></li>;
}

/** Older decisions past the quest detail's first page, fetched a page at a time on request. */
export function OlderDecisions({ keeperThreadId, boardQuestId, cursor }: { keeperThreadId: string; boardQuestId: string; cursor: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <li className="tv-li-more"><button type="button" className="tv-fold act" onClick={() => setOpen(true)}><ExpandsMark open={false} /><span>Show older decisions</span></button></li>;
  return <DecisionPage keeperThreadId={keeperThreadId} boardQuestId={boardQuestId} cursor={cursor} />;
}
function DecisionPage({ keeperThreadId, boardQuestId, cursor }: { keeperThreadId: string; boardQuestId: string; cursor: string }) {
  const page = experimental_useRpcQuery({ contract: rpcContract, method: "decisionHistory", input: { keeperThreadId, boardQuestId, cursor, limit: 100 } });
  if (!page.data) return <li className="tv-li-more"><FoldLoad error={page.error} retry={page.refetch} label="older decisions" /></li>;
  return <>{page.data.decisions.map((d) => <DecisionLine key={d.id} decision={d} />)}{page.data.nextCursor && <OlderDecisions keeperThreadId={keeperThreadId} boardQuestId={boardQuestId} cursor={page.data.nextCursor} />}</>;
}

type HistoryFilter = "all" | "steers" | "anchors" | "decided" | "reports" | "asks";
const HISTORY_FILTERS: readonly HistoryFilter[] = ["all", "steers", "anchors", "decided", "reports", "asks"];
/** Every event of the quest as a readable line, newest first, with steers and plan versions the events did not record. */
export function useHistoryLines(detail: BoardQuestDetail, registry: Registry, room: Room | undefined) {
  return useMemo(() => {
    const members = new Map([...(room ? visibleMembers(room) : []), ...detail.quest.members].map((m) => [m.threadId, m]));
    const keeper = room?.keepers.find((k) => k.member.threadId === detail.quest.keeperThreadId)?.member ?? null;
    if (keeper) members.set(keeper.threadId, keeper);
    const waypointTitles = new Map(detail.quest.waypoints.map((w) => [w.id, w.title]));
    const ctx = { members, characterName: (id: string) => registry.characters.find((c) => c.id === id)?.name ?? null, memberName: (m: Member) => memberName(m, registry), questShort: (id: string) => id === detail.quest.id ? detail.quest.short : room ? questsIn(room).find((q) => q.id === id)?.short ?? null : null, decisions: new Map(detail.decisions.map((d) => [d.id, d.text])), waypoints: (id: string) => id === detail.quest.id ? waypointTitles : new Map<string, string>() };
    const out: EventLine[] = detail.events.map((e) => describeEvent(e, ctx)).filter((l): l is EventLine => l !== null);
    const leadActor = keeper ? { kind: "keeper" as const, member: keeper } : { kind: "tavern" as const };
    const plansSeen = new Set(detail.events.filter((e) => e.type === "plan.proposed").map((e) => (e.data as { version?: number }).version));
    for (const p of detail.plans) if (p.fromSteer && !plansSeen.has(p.version)) out.push({ id: -p.version, at: p.fromSteer.at, icon: "plan", tone: "steer", filter: "steers", actor: leadActor, head: `drew quest map v${p.version} from your steer`, detail: `“${p.fromSteer.text}”`, questId: null });
    const routesSeen = new Set(detail.events.filter((e) => e.type === "route.recorded").map((e) => (e.data as { routeId?: string }).routeId));
    for (const r of detail.routes) if (r.kind === "steer" && !routesSeen.has(r.id)) out.push({ id: -1000 - out.length, at: r.createdAt, icon: "steer", tone: "steer", filter: "steers", actor: { kind: "you" }, head: "steered", detail: r.summary, questId: null });
    return foldRuns(out.sort((a, b) => b.at - a.at));
  }, [detail, registry, room]);
}

/** The quest's history with its filters; `bare` drops the section heading, for a fold that carries its own. */
export function History({ detail, registry, room, bare = false }: { detail: BoardQuestDetail; registry: Registry; room: Room | undefined; bare?: boolean }) {
  const [filter, setFilter] = usePanelState<HistoryFilter>(`quest:${detail.quest.id}.history`, "all", (v) => HISTORY_FILTERS.includes(v as HistoryFilter));
  const [more, setMore] = usePanelState(`quest:${detail.quest.id}.history.more`, false);
  const lines = useHistoryLines(detail, registry, room);
  const shown = lines.filter((l) => filter === "all" || (filter === "anchors" ? l.icon === "anchor" : l.filter === filter));
  const count = (f: HistoryFilter) => f === "all" ? lines.length : lines.filter((l) => f === "anchors" ? l.icon === "anchor" : l.filter === f).length;
  const filters: [HistoryFilter, string][] = [["all", "All"], ["steers", "Steers"], ["anchors", "Re-anchors"], ["decided", "Decided"], ["reports", "Reports"], ["asks", "Asks"]];
  const seg = <SegFilter label="Filter history" value={filter} onChange={setFilter} options={filters.filter(([f]) => f === "all" || count(f)).map(([f, label]) => ({ id: f, label, count: count(f) }))} />;
  const body = <>
    <EventList lines={more ? shown : shown.slice(0, 10)} registry={registry} />
    {shown.length > 10 && <button type="button" className="tv-fold act" aria-expanded={more} onClick={() => setMore(!more)}><ExpandsMark open={more} />{more ? "Show fewer" : plural(shown.length - 10, "earlier event")}</button>}
    {!shown.length && <p className="tv-empty" data-empty>No events in this view.</p>}
  </>;
  if (bare) return <><div className="tv-rec-tools">{seg}</div>{body}</>;
  return <Section title="History" count={plural(lines.length, "event")} action={seg}>{body}</Section>;
}

/** One report as a line: who, its id-free headline (or its status alone), and "View ›" opening the member's reports at this one in the side panel. */
export function ReportItem({ report, registry, detail }: { report: Report; registry: Registry; detail: BoardQuestDetail }) {
  const members = detail.quest.members;
  const member = members.find((m) => m.threadId === report.memberThreadId);
  const openReports = useOpenReports();
  const [inline, setInline] = useState(false);
  const headline = member ? taleHeadline(report, memberReportNames(detail, member, registry)) : null;
  const name = member ? characterName(registry, member) : "A member";
  const tone = report.status === "blocked" ? "bad" : report.status === "needs-decision" ? "you" : "done";
  return <li className={`tv-item ${tone === "done" ? "" : tone}`} data-stuck={tone === "bad" || undefined}>
    {member ? <CrestOf member={member} registry={registry} size={16} /> : <PageGlyph name="done" />}
    <span className="tv-item-t" data-content title={headline ?? undefined}><b>{name}{headline ? ": " : ""}</b>{headline}</span>
    <Ago at={report.createdAt} />
    <span className="tv-item-s">{member && <><CheckIndependence member={member} /><GuardPosture member={member} /></>}<StateMark tone={tone}>{report.status === "needs-decision" ? "needs a decision" : report.status}</StateMark><MemberEstimate confidence={report.confidence} />
      {member && (inline
        ? <button type="button" className="lnk-btn act" aria-expanded onClick={() => setInline(false)}><span>Hide</span><ExpandsMark open /></button>
        : <button type="button" className="lnk-btn act" title={`Opens ${name}'s report in the side panel`} onClick={() => { if (!openReports({ questId: detail.quest.id, memberThreadId: member.threadId, reportId: report.id }, reportsTitle(name, detail.quest.short))) setInline(true); }}><span>View</span><OpensMark /></button>)}
    </span>
    {inline && member && <div className="tv-item-x"><ReportView report={report} names={memberReportNames(detail, member, registry)} member={member} voice={voiceShown(registry)} /></div>}
  </li>;
}

const MODE_WORDS = { enforce: "enforce", watch: "watch: recorded only", off: "off" } as const;
/** Each member's scope (mode, preset, problems) and the rules it tripped; watch mode records without stopping. */
export function Guardrails({ detail, registry, members, bare = false, compact = false, recheck }: { detail: BoardQuestDetail; registry: Registry; members: Map<string, Member>; bare?: boolean; compact?: boolean; recheck?: () => unknown }) {
  return <ScopeRecords scopes={detail.scopes} observations={detail.violations} keeperThreadId={detail.quest.keeperThreadId} registry={registry}
    members={members} ended={isFinished(detail.quest.phase)} bare={bare} compact={compact} recheck={recheck} />;
}

export function ScopeRecords({ scopes: input = [], observations = [], keeperThreadId, registry, members, ended = false, bare = false, compact = false, recheck }: {
  scopes?: BoardQuestDetail["scopes"]; observations?: BoardQuestDetail["violations"]; keeperThreadId: string;
  registry: Registry; members: Map<string, Member>; ended?: boolean; bare?: boolean; compact?: boolean; recheck?: () => unknown;
}) {
  const scopes = [...new Map(input.map(scope => [scope.threadId, scope])).values()].filter(scope => {
    if (ended) return true;
    const member = members.get(scope.threadId);
    return scope.live !== false && member?.engagement !== "released" && member?.engagement !== "archived" && member?.engagement !== "stopped";
  });
  const violations = [...observations].sort((a, b) => b.at - a.at);
  const day = useToday();
  const [showEach, setShowEach] = usePanelState("quest.guards.members", false);
  if (!scopes.length && !violations.length) return null;
  const name = (id: string) => { const m = members.get(id); return m ? characterName(registry, m) : "A member"; };
  const alerts = ended ? [] : scopes.filter(scope => guardAlerts(scope).length > 0);
  const shown = compact && !showEach ? alerts : scopes;
  const body = <>
    {compact && <p className="tv-guard-summary">{plural(scopes.length, "member")} · {alerts.length ? `${alerts.length} need attention` : "no current alerts"} · {plural(violations.length, "violation")}</p>}
    {shown.length > 0 && <ul className="tv-card tv-rows tv-guardrows">{shown.map((sc) => {
      const m = members.get(sc.threadId);
      const mode = sc.mode ?? sc.scope?.mode ?? "enforce";
      const record = ended ? guardRecordWords(sc, violations, { now: day }) : null;
      return <li key={sc.threadId} className={`tv-guard m-${mode} ${record ? "ended" : ""}`}>
        {m ? <CrestOf member={m} registry={registry} size={16} /> : <PageGlyph name="shield" />}
        <span className="tv-guard-t"><b>{name(sc.threadId)}{m && <> <CheckIndependence member={m} /> <GuardPosture member={m} finished={ended} /></>}</b><span className="m">{record ? record.declared : sc.scope ? `${sc.scope.preset} · writes ${sc.scope.writes.mode} · network ${sc.scope.network} · GitHub ${sc.scope.github}` : "no scope recorded"}</span>
          {record && <span className="tv-guard-ev"><StateMark tone={record.evidence.tone} title={record.evidence.title}>{record.evidence.text}</StateMark>{record.now && <span className="m">{record.now}</span>}</span>}</span>
        {!record && <span className={`tag tv-mode m-${mode}`} title={mode === "watch" ? "Violations are recorded, not stopped" : mode === "off" ? "No guardrail for this member" : "Violations stop the turn"}>{MODE_WORDS[mode]}</span>}
        {!record && guardAlerts(sc).length > 0 && <span className="tv-guard-p"><GuardAlerts scope={sc} name={name(sc.threadId)} keeperThreadId={keeperThreadId} recheck={recheck} /></span>}
      </li>;
    })}</ul>}
    {compact && scopes.length > 0 && <button type="button" className="tv-fold act" aria-expanded={showEach} onClick={() => setShowEach(!showEach)}><ExpandsMark open={showEach} />{showEach ? "Show summary" : "Show each member"}</button>}
    {violations.length > 0 && <ol className="tv-evs tv-viol">{violations.slice(0, 8).map((v) => <li key={`${v.eventId}-${v.seq}`} className={`tv-ev ${v.mode === "watch" ? "t-plain" : v.stopped ? "t-bad" : "t-warn"}`}>
      <PageGlyph name={v.mode === "watch" ? "eye" : v.stopped ? "stop" : "fail"} size={13} className="tv-ev-g" />
      <span className="tv-ev-b"><span className="tv-ev-h"><b>{name(v.threadId)}</b> <span>{v.mode === "watch" ? "tripped a rule · recorded, not stopped" : v.prevented ? "had a call blocked before it ran" : v.stopped ? `was stopped in ${v.latencyMs} ms` : `tripped a rule; the stop failed${v.stopError ? `: ${v.stopError}` : ""}`}</span></span><span className="tv-ev-d" title={`${v.ruleId}: ${v.reason}`}><code>{v.ruleId}</code> {v.reason}</span></span>
      <Ago at={v.at} />
    </li>)}</ol>}
  </>;
  if (bare) return <div className="tv-guards">{body}</div>;
  return <Section title="Guardrails" count={plural(violations.length, "violation")} level={2} className="tv-guards">{body}</Section>;
}

