import { experimental_useAppPanel, experimental_useRpcQuery, type JsonValue, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef } from "react";
import { rpcContract } from "../../shared/contract";
import { MemberReports, plural, rememberCount, useRegistry, useRememberedView } from "../kit";
import { PageLoad, ReportsSkeleton, SKEL } from "./skeletons";
import { REPORTS_TAB } from "./panels";

export type ReportsParams = { questId: string; memberThreadId: string; reportId?: string };

export function readReportsParams(params: JsonValue | null): ReportsParams | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const { questId, memberThreadId, reportId } = params as Record<string, unknown>;
  if (typeof questId !== "string" || typeof memberThreadId !== "string") return null;
  return typeof reportId === "string" ? { questId, memberThreadId, reportId } : { questId, memberThreadId };
}

/** The tab strip's label: whose reports, on which quest. Also how the page finds its own report tabs again. */
export const reportsTitle = (name: string, questShort: string) => `${name}’s reports · ${questShort}`;
const OURS = /’s reports · /;

/**
 * Opens one member's reports in bb's side panel, as the one reports tab: the report tabs open before are closed once the new
 * one is in, unless bb reused one of them (same params). False when bb declines, so the caller shows the reports in place.
 */
export function useOpenReports() {
  const panel = experimental_useAppPanel();
  return (p: ReportsParams, title: string) => {
    const before = (panel.getTabs?.().tabs ?? []).filter((t) => OURS.test(t.title)).map((t) => t.key);
    if (!panel.openTab({ tab: REPORTS_TAB, params: p, title })) return false;
    // bb selects the new tab on its own schedule, so the old keys are closed a moment later, and never the selected one.
    if (before.length) setTimeout(() => { const now = panel.getTabs(); for (const key of before) if (key !== now.selectedKey && now.tabs.some((t) => t.key === key)) panel.closeTab(key); }, 120);
    return true;
  };
}

/** The page's side-panel tab: the kit's MemberReports in its own scroll container, remembering its place per member, replaced when another member's reports open. */
export function ReportsTab({ params }: PluginNavPanelProps & { params: JsonValue | null }) {
  const p = readReportsParams(params);
  const registry = useRegistry();
  const detail = experimental_useRpcQuery({ contract: rpcContract, method: "boardQuest", input: { id: p?.questId ?? "" }, enabled: !!p });
  const root = useRef<HTMLDivElement>(null);
  const member = p && detail.data ? detail.data.quest.members.find((m) => m.threadId === p.memberThreadId) ?? null : null;
  useRememberedView(root, `tavern:view:reports:${p?.questId}:${p?.memberThreadId}`, !!member && !p?.reportId);
  const filed = member && detail.data ? detail.data.reports.filter((r) => r.memberThreadId === member.threadId).length : undefined;
  useEffect(() => { if (filed !== undefined) rememberCount(SKEL.reports, filed); }, [filed]);
  return <div ref={root} className="tavern tv-page tv-paneltab tv-reptab">
    {!p ? <p className="tv-empty" data-empty>No report chosen.</p>
      : detail.data && registry.data ? member ? <MemberReports key={`${p.questId}:${p.memberThreadId}`} detail={detail.data} member={member} registry={registry.data} reportId={p.reportId} /> : <p className="tv-empty" data-empty>This member is no longer on the quest.</p>
        : <PageLoad error={detail.error ?? registry.error} retry={() => { void detail.refetch(); void registry.refetch(); }} skeleton={<ReportsSkeleton />} label="the reports" />}
  </div>;
}

/** "View report ›" or "View 3 reports ›": opens the tab, or the reports in place when bb declines the panel. */
export function viewReportsLabel(count: number) { return count > 1 ? `View ${plural(count, "report")}` : "View report"; }
