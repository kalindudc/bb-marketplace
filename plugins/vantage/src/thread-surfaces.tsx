import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  experimental_Icon as Icon, experimental_InfoList as InfoList, experimental_InfoListRow as InfoListRow, experimental_InfoSection as InfoSection,
  experimental_ThreadContextCardRow as CardRow, experimental_useAppPanel, experimental_usePanelTabs, experimental_useThreadContextKind, useBbNavigate,
  type ExperimentalThreadContextCardProps, type ExperimentalThreadContextSegmentInput, type ExperimentalThreadContextSegmentProps,
  type ExperimentalThreadInfoProps, type ExperimentalThreadRowMetadataDataInput, type ExperimentalThreadRowMetadataProps,
  type PluginThreadActionRegistration, useRealtime,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { createArchivedPreference } from "./archived-preference";
import { Hint } from "./hint";
import { PANEL_ACTION_ID } from "./commands";
import type { Overview } from "./contract";
import { fileCount } from "./counted";
import { LiveThreadsProvider, useSidebarIndex, type SidebarIndex } from "./live";
import { lineCounts, plural, reviewStarted, urgentFirst, type Row } from "./model";
import { panelSelection } from "./panel";
import { StatusGlyph } from "./review";
import { formatRoute } from "./route";
import { useSession } from "./session";
import { useRows, type RowsData } from "./use-rows";

const archivedPreference = createArchivedPreference(window, "panel");
// Vantage's own icon, declared in package.json, so bb draws it on its rail, tab strip and menus even while the app loads.
export const VANTAGE_ICON = "vantage/vantage";
// The most child worktrees the composer's list and the thread context card show; the tab has the rest.
const SHOWN = 3;

export const hasChildren = (live: SidebarIndex, threadId: string): boolean => {
  for (const thread of live.values()) if (thread.parentThreadId === threadId) return true;
  return false;
};

export function useHasChildren({ threadId }: Pick<ExperimentalThreadContextSegmentInput, "threadId">): boolean {
  return hasChildren(useSidebarIndex(), threadId);
}

function useTree(threadId: string | null): { data: RowsData; loading: boolean } {
  const includeArchived = useSyncExternalStore(archivedPreference.subscribe, archivedPreference.get, archivedPreference.get);
  const target = useMemo(() => (threadId === null ? null : { kind: "tree" as const, threadId }), [threadId]);
  const { store, snapshot } = useSession("thread", target, includeArchived);
  // A changed setting or a whole-branch choice made elsewhere changes the numbers here too.
  useRealtime("vantage:settings", () => { store?.refresh(); });
  const data = useRows(snapshot.overview, { currentThreadId: threadId, text: "", chip: null, groupBy: "status" });
  return { data, loading: snapshot.overview === null };
}

// Its child threads' worktrees, not the thread's own checkout: that one is what bb's changes segment already shows.
const childRows = (data: RowsData, threadId: string): Row[] => data.rows.filter((row) => row.threadId !== threadId && row.bucket !== "archived");

const sharedPaths = (rows: readonly Row[]): string[] => [...new Set(rows.flatMap((row) => row.overlaps.map((overlap) => overlap.path)))];

// Above the composer only while bb shows thread context there, and once a child thread has changed something, so it never
// spends a line saying there is nothing. With the thread context card, its section shows the same worktrees.
export function useSegmentVisible(input: Pick<ExperimentalThreadContextSegmentInput, "threadId">): boolean {
  const banner = experimental_useThreadContextKind() === "banner";
  const children = useHasChildren(input);
  const { data } = useTree(banner && children ? input.threadId : null);
  return banner && children && childRows(data, input.threadId).length > 0;
}

function useOpenTab() {
  const panel = experimental_useAppPanel();
  return (threadId: string, key?: string) => {
    // Set first, so a tab that mounts on this call finds it; cleared when bb declines, so a later visit does not jump to it.
    if (key !== undefined) panelSelection.set({ threadId, key, at: Date.now() });
    if (!panel.openTab({ tab: { id: PANEL_ACTION_ID, context: { kind: "thread" }, availability: "action" } })) {
      if (key !== undefined) panelSelection.set(null);
      toast.error("bb could not open the Vantage tab");
    }
  };
}

function useCompare(threadId: string) {
  const navigate = useBbNavigate();
  return () => navigate.toPluginPanel("vantage", {
    subPath: formatRoute({ target: { kind: "tree", threadId }, view: "overlaps", selectedKey: null, focus: null }),
  });
}

export function why(row: Row, data: RowsData): string {
  if (row.bucket === "needs") return row.live.indicator === "unread-error" ? (row.live.sidebar?.indicatorLabel ?? "The last turn failed") : "Asked you a question";
  if (row.bucket === "unavailable") return "Cannot be read";
  const overlap = row.overlaps[0];
  if (overlap !== undefined) return `Shares ${overlap.path.slice(overlap.path.lastIndexOf("/") + 1)} with ${data.titleOf(overlap.otherKeys[0]!)}`;
  if (reviewStarted(row) && row.progress !== null) return `${row.progress.reviewed} of ${row.progress.total} checked`;
  const files = plural(fileCount(row.worktree), "file");
  return row.bucket === "working" ? `Still working · ${files}` : `Ready to review · ${files}`;
}

function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="whitespace-nowrap font-mono text-[11px] tabular-nums"><span className="text-diff-added">+{additions}</span> <span className="text-diff-removed">−{deletions}</span></span>;
}

// Words that take only the row's spare room and give it back first, as bb's own segments' labels do; a narrow composer hides them.
function Words({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span data-promptbox-hide-compact="" className="grid min-w-0 grid-cols-[minmax(0,max-content)]">
      <span className={`truncate ${className}`}>{children}</span>
    </span>
  );
}

export function segmentSentence(count: number, needs: number, shared: number): string {
  return [plural(count, "child worktree"), needs > 0 ? `${needs} waiting on you` : null, shared > 0 ? plural(shared, "shared file") : null]
    .filter((part) => part !== null).join(" · ");
}

function SegmentSummaryView({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const { data, loading } = useTree(threadId);
  const rows = childRows(data, threadId);
  const needs = rows.filter((row) => row.bucket === "needs").length;
  const shared = sharedPaths(rows).length;
  const sentence = loading ? "Child worktrees" : segmentSentence(rows.length, needs, shared);
  // The numbers always show; the words grow into the row's spare room, so the segment is about 60px when the row is full.
  return (
    <button type="button" aria-expanded={isExpanded} onClick={onToggle} data-vantage-segment aria-label={`Worktrees: ${sentence}`}
      title={isExpanded ? "Hide the worktrees" : sentence}
      className="flex h-6 min-w-min max-w-max flex-1 cursor-pointer items-center gap-1 overflow-hidden rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
      <Icon name={VANTAGE_ICON} className="size-3.5 shrink-0" aria-hidden />
      {loading
        ? <Words>Child worktrees</Words>
        : (
          <>
            <span className="shrink-0 tabular-nums text-foreground">{rows.length}</span>
            <Words>{rows.length === 1 ? "child worktree" : "child worktrees"}</Words>
            {needs > 0 && (
              <>
                <Icon name="SideChat" className="ml-0.5 size-3 shrink-0 text-foreground" aria-hidden />
                <span className="shrink-0 tabular-nums text-foreground">{needs}</span>
                <Words className="text-foreground">waiting on you</Words>
              </>
            )}
            {shared > 0 && (
              <>
                <Icon name="AlertTriangle" className="ml-0.5 size-3 shrink-0 text-warning-text" aria-hidden />
                <span className="shrink-0 tabular-nums text-warning-text">{shared}</span>
                <Words className="text-warning-text">{shared === 1 ? "shared file" : "shared files"}</Words>
              </>
            )}
          </>
        )}
      <Icon name={isExpanded ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0" aria-hidden />
    </button>
  );
}

export function SegmentSummary(props: ExperimentalThreadContextSegmentProps) {
  return <LiveThreadsProvider><SegmentSummaryView {...props} /></LiveThreadsProvider>;
}

const DETAIL_ROW = "grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-state-hover";

function SegmentDetailsView({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { data, loading } = useTree(threadId);
  const open = useOpenTab();
  const compare = useCompare(threadId);
  if (!isExpanded) return null;
  const rows = urgentFirst(childRows(data, threadId));
  const shared = sharedPaths(rows);
  // At most three lines, and a fourth only when something is left out: the composer moves up by about 80px, not 256.
  const room = SHOWN - (shared.length > 0 ? 1 : 0);
  const shown = rows.slice(0, room);
  const rest = rows.length - shown.length;
  return (
    <div data-vantage-segment-details className="py-1 text-xs">
      {loading && <p className="px-2 py-1 text-muted-foreground">Loading worktrees…</p>}
      {shown.map((row) => (
        <button key={row.worktree.key} type="button" onClick={() => open(threadId, row.worktree.key)} className={DETAIL_ROW}>
          {/* An idle thread's glyph draws nothing, so the cell keeps the grid's first column. */}
          <span className="flex size-4 items-center justify-center"><StatusGlyph row={row} /></span>
          <span className="min-w-0 truncate"><span className="text-foreground">{row.title}</span> <span className="text-muted-foreground">· {why(row, data)}</span></span>
          <LineCounts additions={row.additions} deletions={row.deletions} />
        </button>
      ))}
      {shared.length > 0 && (
        <button type="button" onClick={compare} className={`${DETAIL_ROW} text-warning-text`} title={shared.slice(0, 10).join("\n")}>
          <Icon name="AlertTriangle" className="size-3.5" aria-hidden />
          <span className="min-w-0 truncate">{plural(shared.length, "file")} changed in more than one worktree</span>
          <span className="whitespace-nowrap">Compare ›</span>
        </button>
      )}
      {rest > 0 && (
        <button type="button" onClick={() => open(threadId)} className={`${DETAIL_ROW} text-muted-foreground hover:text-foreground`}>
          <Icon name={VANTAGE_ICON} className="size-3.5" aria-hidden />
          <span className="min-w-0 truncate">{plural(rest, "more child worktree")}</span>
          <span className="whitespace-nowrap text-brand">Open the tab ›</span>
        </button>
      )}
    </div>
  );
}

export function SegmentDetails(props: ExperimentalThreadContextSegmentProps) {
  return <LiveThreadsProvider><SegmentDetailsView {...props} /></LiveThreadsProvider>;
}

// The card's counterpart of the segment: the same child worktrees, most urgent first, beside bb's own rows.
function CardSectionView({ threadId }: Pick<ExperimentalThreadContextCardProps, "threadId">) {
  const { data, loading } = useTree(threadId);
  const open = useOpenTab();
  const compare = useCompare(threadId);
  const rows = urgentFirst(childRows(data, threadId));
  // bb leaves the section out while it renders nothing.
  if (loading || rows.length === 0) return null;
  const shared = sharedPaths(rows);
  const shown = rows.slice(0, SHOWN);
  const rest = rows.length - shown.length;
  return (
    <>
      {shown.map((row) => (
        <CardRow key={row.worktree.key} leading={<StatusGlyph row={row} />} label={row.title} title={`${row.live.title} · ${why(row, data)}`}
          trailing={<LineCounts additions={row.additions} deletions={row.deletions} />} onClick={() => open(threadId, row.worktree.key)} />
      ))}
      {rest > 0 && <CardRow icon={VANTAGE_ICON} label={plural(rest, "more child worktree")} onClick={() => open(threadId)} />}
      {shared.length > 0 && (
        <CardRow icon="AlertTriangle" label={<span className="text-warning-text">{plural(shared.length, "shared file")}</span>}
          title={shared.slice(0, 10).join("\n")} trailing={<span className="text-warning-text">Compare</span>} onClick={compare} />
      )}
    </>
  );
}

export function VantageCardSection(props: ExperimentalThreadContextCardProps) {
  return <LiveThreadsProvider><CardSectionView threadId={props.threadId} /></LiveThreadsProvider>;
}

function InfoView({ threadId }: ExperimentalThreadInfoProps) {
  const { data } = useTree(threadId);
  const open = useOpenTab();
  const rows = childRows(data, threadId);
  if (rows.length === 0) return null;
  const waiting = rows.filter((row) => row.bucket === "needs");
  const ready = rows.filter((row) => row.bucket === "review");
  const shared = sharedPaths(rows).length;
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

export interface RowLine { additions: number; deletions: number; shared: number }
export type RowLines = ReadonlyMap<string, RowLine>;
const NO_LINES: RowLines = new Map();
const ALL = { kind: "all" } as const;

// Each worktree's numbers go to its own thread only, the one nearest the tree's root, so a reviewer beside it shows none.
// A thread that owns more than one worktree, such as its workspace and a checkout it works in, shows their sum.
export function rowLines(overview: Overview | null): RowLines {
  if (overview === null || overview.partial) return NO_LINES;
  const shared = new Map<string, number>();
  for (const file of overview.sharedFiles) for (const key of file.worktreeKeys) shared.set(key, (shared.get(key) ?? 0) + 1);
  const lines = new Map<string, RowLine>();
  for (const worktree of overview.worktrees) {
    const owner = worktree.threadIds[0];
    if (owner === undefined || worktree.state !== "ready") continue;
    const { additions, deletions } = lineCounts(worktree);
    const sum = lines.get(owner) ?? { additions: 0, deletions: 0, shared: 0 };
    lines.set(owner, { additions: sum.additions + additions, deletions: sum.deletions + deletions, shared: sum.shared + (shared.get(worktree.key) ?? 0) });
  }
  for (const [owner, line] of lines) if (line.additions + line.deletions + line.shared === 0) lines.delete(owner);
  return lines;
}

// bb calls this once for the whole sidebar: one overview of every recent thread serves every row.
export function useRowLines(_input: ExperimentalThreadRowMetadataDataInput): RowLines {
  const { store, snapshot } = useSession("sidebar", ALL, false);
  useRealtime("vantage:settings", () => { store?.refresh(); });
  return useMemo(() => rowLines(snapshot.overview), [snapshot.overview]);
}

const compact = (value: number): string => (value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));

export function RowLineItem({ thread, data }: ExperimentalThreadRowMetadataProps<RowLines>) {
  const line = data.get(thread.id);
  if (line === undefined) return null;
  const words = [`+${line.additions} −${line.deletions} in its worktree`, line.shared > 0 ? plural(line.shared, "file") + " also changed in another worktree" : null]
    .filter((part) => part !== null).join(", ");
  return (
    <span role="img" title={words} aria-label={words} className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-[10.5px] tabular-nums">
      <span className="text-diff-added">+{compact(line.additions)}</span>
      <span className="text-diff-removed">−{compact(line.deletions)}</span>
      {line.shared > 0 && <span className="inline-flex items-center gap-0.5 text-warning-text"><Icon name="AlertTriangle" className="size-2.5" aria-hidden />{line.shared}</span>}
    </span>
  );
}

const VANTAGE_TAB = { id: PANEL_ACTION_ID, context: { kind: "thread" as const }, availability: "action" as const };

// bb's labelled header button, for a bb that no longer draws plugin components in the thread header.
export const headerAction: PluginThreadActionRegistration = {
  id: "open",
  title: "Vantage",
  icon: VANTAGE_ICON,
  group: "1_open",
  order: 90,
  placement: "header",
  item: ({ experimental_panel }) => ({
    label: "Vantage",
    icon: VANTAGE_ICON,
    run: () => {
      if (!experimental_panel.openTab({ tab: VANTAGE_TAB })) toast.error("bb could not open the Vantage tab");
    },
  }),
};

interface HeaderButtonProps { threadId: string; projectId: string; isCompactViewport: boolean }

// Opens the thread's Vantage tab, or closes the side panel while that tab is the one showing.
export function VantageHeaderButton({ isCompactViewport }: HeaderButtonProps) {
  const panel = experimental_useAppPanel();
  const tabs = experimental_usePanelTabs();
  const selected = tabs.tabs.find((tab) => tab.key === tabs.selectedKey);
  const showing = tabs.open && selected?.detail.kind === "plugin" && selected.detail.tab.id === PANEL_ACTION_ID;
  // A phone header has no room to spare, and the panel launcher already lists the tab.
  if (isCompactViewport) return null;
  const toggle = () => {
    if (showing) panel.close();
    else if (!panel.openTab({ tab: VANTAGE_TAB })) toast.error("bb could not open the Vantage tab");
  };
  return (
    <Hint label={showing ? "Hide Vantage" : "Vantage: what this thread and its child threads changed"}>
      <button type="button" aria-label={showing ? "Hide Vantage" : "Open Vantage"} aria-pressed={showing} onClick={toggle}
        className={`inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${showing ? "text-foreground" : "text-muted-foreground"}`}>
        <Icon name={VANTAGE_ICON} className="size-4" aria-hidden />
      </button>
    </Hint>
  );
}

export const openAction: PluginThreadActionRegistration = {
  id: "review",
  title: "Review changes in Vantage",
  icon: VANTAGE_ICON,
  group: "1_open",
  order: 90,
  item: ({ thread, navigate }) => ({
    label: "Review changes in Vantage",
    icon: VANTAGE_ICON,
    run: () => { navigate.toPluginPanel("vantage", { subPath: `tree/${thread.id}` }); },
  }),
};
