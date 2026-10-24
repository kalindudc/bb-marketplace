import { useMemo, useSyncExternalStore } from "react";
import {
  experimental_Icon as Icon, experimental_InfoList as InfoList, experimental_InfoListRow as InfoListRow, experimental_InfoSection as InfoSection,
  useBbNavigate, type ExperimentalThreadContextSegmentInput, type ExperimentalThreadContextSegmentProps, type ExperimentalThreadInfoProps,
  type PluginThreadActionRegistration, type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { createArchivedPreference } from "./archived-preference";
import { PANEL_ACTION_ID } from "./commands";
import { Hint } from "./hint";
import { LiveThreadsProvider, useSidebarIndex, type SidebarIndex } from "./live";
import { plural, reviewStarted, type Row } from "./model";
import { panelSelection } from "./panel";
import { StatusGlyph } from "./review";
import { useSession } from "./session";
import { useRows, type RowsData } from "./use-rows";

const archivedPreference = createArchivedPreference(window, "panel");

export const hasChildren = (live: SidebarIndex, threadId: string): boolean => {
  for (const thread of live.values()) if (thread.parentThreadId === threadId) return true;
  return false;
};

export function useHasChildren({ threadId }: Pick<ExperimentalThreadContextSegmentInput, "threadId">): boolean {
  return hasChildren(useSidebarIndex(), threadId);
}

// Above the composer only once a child thread has changed something, so it never spends a line saying there is nothing.
export function useSegmentVisible(input: Pick<ExperimentalThreadContextSegmentInput, "threadId">): boolean {
  const children = useHasChildren(input);
  const { data } = useTree(children ? input.threadId : null);
  return children && childRows(data, input.threadId).length > 0;
}

function useTree(threadId: string | null): { data: RowsData; loading: boolean } {
  const includeArchived = useSyncExternalStore(archivedPreference.subscribe, archivedPreference.get, archivedPreference.get);
  const target = useMemo(() => (threadId === null ? null : { kind: "tree" as const, threadId }), [threadId]);
  const { snapshot } = useSession("thread", target, includeArchived);
  const data = useRows(snapshot.overview, { currentThreadId: threadId, text: "", chip: null, groupBy: "status" });
  return { data, loading: snapshot.overview === null };
}

// Its child threads' worktrees, not the thread's own checkout: that one is what bb's changes segment already shows.
const childRows = (data: RowsData, threadId: string): Row[] => data.rows.filter((row) => row.threadId !== threadId && row.bucket !== "archived");

function useOpenTab() {
  const navigate = useBbNavigate();
  return (threadId: string, key?: string) => {
    if (key !== undefined) panelSelection.set({ threadId, key, at: Date.now() });
    if (!navigate.openThreadPanel({ actionId: PANEL_ACTION_ID })) toast.error("bb could not open the Vantage tab");
  };
}

function why(row: Row, data: RowsData): string {
  if (row.bucket === "needs") return row.live.sidebar?.indicatorLabel ?? "Needs you";
  if (row.bucket === "unavailable") return "Cannot be read";
  const overlap = row.overlaps[0];
  if (overlap !== undefined) return `Overlaps with ${data.titleOf(overlap.otherKeys[0]!)} in ${overlap.path.slice(overlap.path.lastIndexOf("/") + 1)}`;
  if (reviewStarted(row) && row.progress !== null) return `${row.progress.reviewed} of ${row.progress.total} reviewed`;
  return row.bucket === "working" ? "Working" : plural(row.worktree.uncommitted.length + row.worktree.committed.length, "file");
}

export function VantageHeaderButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const open = useOpenTab();
  // A phone header has no room to spare, and the panel launcher already lists the tab.
  if (isCompactViewport) return null;
  return (
    <Hint label="Vantage: what this thread and its child threads changed">
      <button type="button" aria-label="Open Vantage" onClick={() => open(threadId)}
        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Icon name="FolderGit" className="size-4" aria-hidden />
      </button>
    </Hint>
  );
}

function SegmentSummaryView({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const { data, loading } = useTree(threadId);
  const rows = childRows(data, threadId);
  const needs = rows.filter((row) => row.bucket === "needs").length;
  const overlaps = rows.filter((row) => row.overlaps.length > 0).length;
  return (
    <button type="button" aria-expanded={isExpanded} onClick={onToggle} data-vantage-segment
      title={isExpanded ? "Hide the worktrees" : "Show the worktrees of this thread's child threads"}
      className="inline-flex h-6 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
      <Icon name="FolderGit" className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        <span className="font-medium text-foreground">{loading ? "Worktrees" : plural(rows.length, "worktree")}</span>
        {needs > 0 && <> · <span className="text-foreground">{needs} {needs === 1 ? "needs" : "need"} you</span></>}
        {overlaps > 0 && <> · <span className="text-warning-text">{plural(overlaps, "overlap")}</span></>}
      </span>
      <Icon name={isExpanded ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0" aria-hidden />
    </button>
  );
}

export function SegmentSummary(props: ExperimentalThreadContextSegmentProps) {
  return <LiveThreadsProvider><SegmentSummaryView {...props} /></LiveThreadsProvider>;
}

function SegmentDetailsView({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { data, loading } = useTree(threadId);
  const open = useOpenTab();
  const rows = childRows(data, threadId);
  if (!isExpanded) return null;
  return (
    <div data-vantage-segment-details className="max-h-64 overflow-y-auto py-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5">
        <span className="flex-1" />
        <button type="button" onClick={() => open(threadId)} className="h-6 cursor-pointer rounded-md px-2 text-muted-foreground hover:bg-state-hover hover:text-foreground">Open Vantage</button>
      </div>
      {loading && <p className="px-2 py-1 text-muted-foreground">Loading worktrees…</p>}
      {!loading && rows.length === 0 && <p className="px-2 py-1 text-muted-foreground">No child thread has changes yet.</p>}
      {rows.map((row) => (
        <button key={row.worktree.key} type="button" onClick={() => open(threadId, row.worktree.key)}
          className="grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-state-hover">
          <StatusGlyph row={row} />
          <span className="min-w-0 truncate"><span className="text-foreground">{row.title}</span> <span className="text-muted-foreground">· {why(row, data)}</span></span>
          <span className="whitespace-nowrap font-mono text-[11px]"><span className="text-diff-added">+{row.additions}</span> <span className="text-diff-removed">−{row.deletions}</span></span>
        </button>
      ))}
    </div>
  );
}

export function SegmentDetails(props: ExperimentalThreadContextSegmentProps) {
  return <LiveThreadsProvider><SegmentDetailsView {...props} /></LiveThreadsProvider>;
}

function InfoView({ threadId }: ExperimentalThreadInfoProps) {
  const { data } = useTree(threadId);
  const open = useOpenTab();
  const rows = childRows(data, threadId);
  if (rows.length === 0) return null;
  const needs = rows.filter((row) => row.bucket === "needs").length;
  return (
    <InfoSection label="Worktrees" count={rows.length} trailing={needs > 0 ? <span className="text-xs text-muted-foreground">{needs} {needs === 1 ? "needs" : "need"} you</span> : undefined}>
      <InfoList items={rows} getKey={(row) => row.worktree.key} limit={3}
        renderItem={(row) => (
          <InfoListRow leading={<StatusGlyph row={row} />} name={row.title} title={row.live.title} context={why(row, data)}
            trailing={<span className="whitespace-nowrap font-mono text-[11px]"><span className="text-diff-added">+{row.additions}</span> <span className="text-diff-removed">−{row.deletions}</span></span>}
            onSelect={() => open(threadId, row.worktree.key)} />
        )} />
    </InfoSection>
  );
}

export function VantageInfoSection(props: ExperimentalThreadInfoProps) {
  return <LiveThreadsProvider><InfoView {...props} /></LiveThreadsProvider>;
}

export const openAction: PluginThreadActionRegistration = {
  id: "review",
  title: "Review changes in Vantage",
  icon: "FolderGit",
  group: "1_open",
  order: 90,
  item: ({ thread, navigate }) => ({
    label: "Review changes in Vantage",
    icon: "FolderGit",
    run: () => { navigate.toPluginPanel("vantage", { subPath: `tree/${thread.id}` }); },
  }),
};
