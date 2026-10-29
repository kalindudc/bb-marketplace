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
  if (row.bucket === "needs") return row.live.indicator === "unread-error" ? (row.live.sidebar?.indicatorLabel ?? "The last turn failed") : "Asked you a question";
  if (row.bucket === "unavailable") return "Cannot be read";
  const overlap = row.overlaps[0];
  if (overlap !== undefined) return `Shares ${overlap.path.slice(overlap.path.lastIndexOf("/") + 1)} with ${data.titleOf(overlap.otherKeys[0]!)}`;
  if (reviewStarted(row) && row.progress !== null) return `${row.progress.reviewed} of ${row.progress.total} checked`;
  return row.bucket === "working" ? "Still working" : `${plural(row.worktree.uncommitted.length + row.worktree.committed.length, "file")} to read`;
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
  const shared = new Set(rows.flatMap((row) => row.overlaps.map((overlap) => overlap.path))).size;
  return (
    <button type="button" aria-expanded={isExpanded} onClick={onToggle} data-vantage-segment
      title={isExpanded ? "Hide the worktrees" : "Show the worktrees of this thread's child threads"}
      className="inline-flex h-6 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
      <Icon name="FolderGit" className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        <span className="font-medium text-foreground">{loading ? "Child worktrees" : plural(rows.length, "child worktree")}</span>
        {needs > 0 && <> · <span className="text-foreground">{needs} waiting on you</span></>}
        {shared > 0 && <> · <span className="text-warning-text">{plural(shared, "shared file")}</span></>}
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
  // Only what needs a person; the rest are one click away in the panel, not a second list here.
  const urgent = rows.filter((row) => row.bucket === "needs" || row.overlaps.length > 0);
  const rest = rows.length - urgent.length;
  if (!isExpanded) return null;
  return (
    <div data-vantage-segment-details className="max-h-64 overflow-y-auto py-1 text-xs">
      {loading && <p className="px-2 py-1 text-muted-foreground">Loading worktrees…</p>}
      {!loading && rows.length === 0 && <p className="px-2 py-1 text-muted-foreground">No child thread has changes yet.</p>}
      {urgent.map((row) => (
        <button key={row.worktree.key} type="button" onClick={() => open(threadId, row.worktree.key)}
          className="grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-state-hover">
          <StatusGlyph row={row} />
          <span className="min-w-0 truncate"><span className="text-foreground">{row.title}</span> <span className="text-muted-foreground">· {why(row, data)}</span></span>
          <span className="whitespace-nowrap font-mono text-[11px]"><span className="text-diff-added">+{row.additions}</span> <span className="text-diff-removed">−{row.deletions}</span></span>
        </button>
      ))}
      {!loading && rows.length > 0 && (
        <button type="button" onClick={() => open(threadId)}
          className="mt-0.5 flex w-full cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-state-hover hover:text-foreground">
          <Icon name="FolderGit" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{rest > 0 ? `${plural(rest, "more child worktree")}` : "All child worktrees"}</span>
          <span className="shrink-0 text-brand">Open the panel</span>
          <Icon name="ChevronRight" className="size-3 shrink-0" aria-hidden />
        </button>
      )}
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
  const waiting = rows.filter((row) => row.bucket === "needs");
  const ready = rows.filter((row) => row.bucket === "review");
  const shared = new Set(rows.flatMap((row) => row.overlaps.map((overlap) => overlap.path))).size;
  // Facts, not a second copy of the panel's list. Each row opens the worktree it counts, not just the tab.
  const items = [
    { key: "waiting", icon: "SideChat" as const, name: "Waiting on you", value: waiting.length, target: waiting[0]?.worktree.key },
    { key: "ready", icon: "Eye" as const, name: "Ready to review", value: ready.length, target: ready[0]?.worktree.key },
    { key: "shared", icon: "AlertTriangle" as const, name: "Shared files", value: shared, target: rows.find((row) => row.overlaps.length > 0)?.worktree.key },
  ];
  return (
    <InfoSection label="Worktrees" trailing={waiting.length > 0 ? <span className="text-xs text-muted-foreground">{waiting.length} waiting on you</span> : undefined}>
      <InfoList items={items} getKey={(item) => item.key} limit={3}
        renderItem={(item) => (
          <InfoListRow leading={<Icon name={item.icon} className="size-3.5" aria-hidden />} name={item.name}
            trailing={<span className="whitespace-nowrap text-xs text-foreground">{item.value}</span>}
            onSelect={() => open(threadId, item.target)} />
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
