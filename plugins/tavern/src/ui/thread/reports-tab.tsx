import { experimental_useRpcQuery, useBbNavigate, type ExperimentalTabReference, type ExperimentalThreadTabProps, type JsonValue } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import type { Report } from "../../shared/schema";
import { voiceShown, Crest, MemberReports, OpensMark, QueryState, ReportView, SkCrest, SkLine, SkReport, StatusPill, TimeAgo, memberIdentity, plural, reportLabels, summaryNames, useRegistry, useSkeletonCount } from "../kit";

export const REPORTS_TAB: ExperimentalTabReference & { availability: "action"; context: { kind: "thread" } } = { id: "reports", context: { kind: "thread" }, availability: "action" };
export type ReportsTabParams = { memberThreadId: string; questId: string | null; reportId?: string };
const STATUS_WORD: Record<Report["status"], string> = { done: "done", "needs-decision": "needs your decision", blocked: "blocked", checkpoint: "checkpoint" };

export function readReportsTabParams(params: JsonValue | null): ReportsTabParams | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const { memberThreadId, questId, reportId } = params as Record<string, unknown>;
  if (typeof memberThreadId !== "string" || (questId !== null && typeof questId !== "string")) return null;
  return { memberThreadId, questId, ...(typeof reportId === "string" ? { reportId } : {}) };
}

/**
 * The chat card's "View report ›": one member's reports in full. A board quest's reports are the kit's MemberReports, the same
 * body as the Tavern page's tab; an errand has no quest, so its results are listed here.
 */
export function ReportsTab({ params }: ExperimentalThreadTabProps & { params: JsonValue | null }) {
  const p = readReportsTabParams(params);
  const registry = useRegistry();
  const detail = experimental_useRpcQuery({ contract: rpcContract, method: "boardQuest", input: { id: p?.questId ?? "" }, enabled: !!p?.questId });
  const memberReports = detail.data && p ? detail.data.reports.filter(r => r.memberThreadId === p.memberThreadId).length : undefined;
  const rows = useSkeletonCount(reportsKey(p?.memberThreadId ?? "none", p?.questId ?? null), memberReports, 1);
  if (!p) return <div className="tavern tv-reports"><p className="m">This report link is incomplete. Open it again from the report card.</p></div>;
  if (p.questId === null) return <ErrandReports memberThreadId={p.memberThreadId} />;
  const member = detail.data?.quest.members.find(m => m.threadId === p.memberThreadId) ?? null;
  return <div className="tavern tv-reports">
    <QueryState error={detail.error ?? registry.error} loading={detail.isLoading || registry.isLoading} retry={() => { void detail.refetch(); void registry.refetch(); }} label="the reports" skeleton={<SkReports rows={rows} />} />
    {detail.data && registry.data && (member
      ? <MemberReports detail={detail.data} member={member} registry={registry.data} {...(p.reportId ? { reportId: p.reportId } : {})} />
      : <p className="m">This member is no longer in the party of {detail.data.quest.short || detail.data.quest.title}.</p>)}
  </div>;
}

const reportsKey = (memberThreadId: string, questId: string | null) => `skel:thread:reports:${memberThreadId}:${questId ?? "errand"}`;
/** A member's reports while they load: the header `MemberReports` draws, then a report per one this device last saw, in their own classes. */
function SkReports({ rows }: { rows: number }) {
  return <div className="rv-reps">
    <header className="rv-reps-h"><SkCrest size={28} /><div className="rv-reps-who"><b><SkLine w="8ch" /></b><span className="m"><SkLine w="24ch" /></span></div><span className="lnk-btn"><SkLine w="10ch" /></span></header>
    {Array.from({ length: rows }, (_, i) => <SkReport key={i} section />)}
  </div>;
}

function ErrandReports({ memberThreadId }: { memberThreadId: string }) {
  const reports = experimental_useRpcQuery({ contract: rpcContract, method: "reports", input: { ids: [], memberThreadId } });
  const crests = experimental_useRpcQuery({ contract: rpcContract, method: "crests", input: { threadIds: [memberThreadId] } });
  const registry = useRegistry();
  const navigate = useBbNavigate();
  const list = (reports.data?.reports ?? []).filter(r => r.boardQuestId === null).sort((a, b) => b.createdAt - a.createdAt);
  const rows = useSkeletonCount(reportsKey(memberThreadId, null), reports.data ? list.length : undefined, 1);
  const crest = crests.data?.crests.find(c => c.threadId === memberThreadId);
  const who = registry.data && crest ? memberIdentity(registry.data, crest) : null;
  const name = who?.character.name ?? "A member";
  const names = { ...(registry.data ? summaryNames({ threadId: memberThreadId }, [], registry.data, []) : {}), reportNames: reportLabels(list, new Map(who ? [[memberThreadId, name]] : [])) };
  return <div className="tavern tv-reports"><div className="rv-reps">
    <header className="rv-reps-h">
      {who ? <Crest {...who} size={28} /> : <span />}
      <div className="rv-reps-who"><b>{name}</b><span className="m">{who && <>{who.cls.label} <span className="anc">{who.cls.plain}</span> · </>}{["Side quest (errand)", reports.data ? plural(list.length, "report") : null].filter(Boolean).join(" · ")}</span></div>
      <button type="button" className="lnk-btn act" title={`Open ${name}’s thread`} onClick={() => navigate.toThread(memberThreadId)}><span>Open thread</span><OpensMark /></button>
    </header>
    <QueryState error={reports.error} loading={reports.isLoading} retry={() => void reports.refetch()} label="the reports" skeleton={<>{Array.from({ length: rows }, (_, i) => <SkReport key={i} section />)}</>} />
    {reports.data && list.length === 0 && <p className="m">0 reports from {name} yet.</p>}
    {list.map(r => <section key={r.id} className="rv-rep" aria-label={`Report, ${STATUS_WORD[r.status]}`}>
      <header className="rv-rep-h"><StatusPill status={r.status}>{STATUS_WORD[r.status]}</StatusPill><TimeAgo at={r.createdAt} /></header>
      <ReportView report={r} pullRequests={reports.data?.pullRequests} names={names} voice={voiceShown(registry.data)} />
    </section>)}
  </div></div>;
}
