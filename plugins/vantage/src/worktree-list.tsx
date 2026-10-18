import { createContext, memo, useContext, useMemo, useState, type ReactNode } from "react";
import {
  experimental_Icon as Icon, experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useSidebarThreadPullRequest, experimental_useSidebarThreads,
  type PluginSidebarThread, type PluginSidebarThreadIndicator,
} from "@get-bb/plugin-sdk/app";
import type { Overview, SharedFile, ThreadSummary, Worktree } from "./contract";
import { ArchivedSkeleton, EditsSkeleton, Skeleton } from "./skeleton";
import { countArchived, isArchivedOnly } from "./archived";
import { primaryThreadId } from "./worktrees";

export { primaryThreadId };

export interface WorktreeListProps {
  overview: Overview;
  // The side panel's own thread; null on the full-screen page, which belongs to no thread.
  currentThreadId: string | null;
  selectedKey?: string | null;
  // The rows to show (filtered by the page); every worktree of the overview by default.
  worktrees?: readonly Worktree[];
  showSummary?: boolean;
  onOpen(key: string): void;
  onShowRepositories(): void;
}

export interface LiveThread {
  title: string;
  indicator: PluginSidebarThreadIndicator;
  archived: boolean;
  label: string;
  sidebar: PluginSidebarThread | null;
}

const LIFECYCLES = ["active", "archived"] as const;
const INDICATOR_LABEL: Partial<Record<PluginSidebarThreadIndicator, string>> = {
  runtime: "Running", "waiting-for-input": "Needs you", "unread-error": "Failed", "unread-success": "Finished",
};

type SidebarIndex = ReadonlyMap<string, PluginSidebarThread>;
const LiveThreadsContext = createContext<SidebarIndex | null>(null);

// One shared subscription to bb's sidebar data, so every row reads the same snapshot.
export function LiveThreadsProvider({ children }: { children: ReactNode }) {
  const { threads } = experimental_useSidebarThreads({ experimental_lifecycles: LIFECYCLES });
  const index = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  return <LiveThreadsContext.Provider value={index}>{children}</LiveThreadsContext.Provider>;
}

const RUNNING_STATUSES = new Set(["active", "starting", "pending"]);

function resolveLive(sidebar: PluginSidebarThread | null, fallback: ThreadSummary | undefined, threadId: string): LiveThread {
  // bb's sidebar leaves out hidden threads, such as a study's workers; the overview still knows when one is running.
  const indicator = sidebar?.indicator ?? (fallback !== undefined && RUNNING_STATUSES.has(fallback.status) ? "runtime" : "none");
  const archived = sidebar?.isArchived ?? fallback?.archived ?? false;
  return {
    title: sidebar?.displayTitle ?? fallback?.title ?? threadId,
    indicator,
    archived,
    label: archived ? "Archived" : (INDICATOR_LABEL[indicator] ?? "Idle"),
    sidebar,
  };
}

export function useLiveThread(threadId: string, fallback: ThreadSummary | undefined): LiveThread {
  const sidebar = useContext(LiveThreadsContext)?.get(threadId) ?? null;
  return resolveLive(sidebar, fallback, threadId);
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
const sum = (files: Worktree["uncommitted"], field: "additions" | "deletions"): number => files.reduce((total, file) => total + (file[field] ?? 0), 0);

export function lineCounts(worktree: Worktree): { additions: number; deletions: number } {
  return {
    additions: sum(worktree.uncommitted, "additions") + sum(worktree.committed, "additions"),
    deletions: sum(worktree.uncommitted, "deletions") + sum(worktree.committed, "deletions"),
  };
}

const PR_TONE: Record<string, string> = {
  ready_to_merge: "text-success", merged: "text-success",
  checks_failed: "text-destructive-text", conflicts: "text-destructive-text", changes_requested: "text-destructive-text",
};

export function PullRequestBadge({ threadId }: { threadId: string }) {
  const { pullRequest } = experimental_useSidebarThreadPullRequest(threadId);
  if (pullRequest === null) return null;
  return (
    <span title={pullRequest.title}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-border-seam px-1.5 text-[10.5px] leading-4 ${PR_TONE[pullRequest.attention] ?? "text-muted-foreground"}`}>
      #{pullRequest.number} {pullRequest.state}
    </span>
  );
}

// Each worktree's display title, keyed by worktree: the panel's own reads "This thread".
export function useWorktreeTitles(overview: Pick<Overview, "worktrees" | "threads">, currentThreadId: string | null): ReadonlyMap<string, string> {
  const live = useContext(LiveThreadsContext);
  return useMemo(() => {
    const summaries = new Map(overview.threads.map((thread) => [thread.id, thread]));
    return new Map(overview.worktrees.map((worktree) => {
      const id = primaryThreadId(worktree, currentThreadId);
      return [worktree.key, id === currentThreadId ? "This thread" : resolveLive(live?.get(id) ?? null, summaries.get(id), id).title];
    }));
  }, [live, overview.worktrees, overview.threads, currentThreadId]);
}

interface RowProps {
  worktree: Worktree;
  currentThreadId: string | null;
  fallback: ThreadSummary | undefined;
  sharedCount: number;
  selected: boolean;
  underTitle: string | null;
  onOpen(key: string): void;
}

function WorktreeRowView({ worktree, currentThreadId, fallback, sharedCount, selected, underTitle, onOpen }: RowProps) {
  const id = primaryThreadId(worktree, currentThreadId);
  const live = useLiveThread(id, fallback);
  const unavailable = worktree.state === "unavailable";
  const loading = worktree.state === "loading";
  const { additions, deletions } = lineCounts(worktree);
  return (
    <button type="button" data-worktree-row={worktree.key} aria-current={selected ? "true" : undefined} onClick={() => onOpen(worktree.key)}
      className={`mx-1 grid w-[calc(100%-0.5rem)] cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto_0.875rem] items-center gap-x-2 gap-y-0.5 rounded-md py-1.5 pl-3 pr-2.5 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${selected ? "bg-surface-selected" : ""}`}>
      <span title={live.label} className="col-start-1 row-span-2 row-start-1 flex size-4 items-center justify-center">
        {!unavailable && <ThreadStatusGlyph indicator={live.indicator} archived={live.archived} size="compact" />}
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
        <span title={live.title} className="min-w-0 truncate text-sm font-medium text-foreground">
          {id === currentThreadId ? "This thread" : live.title}
        </span>
        {!unavailable && live.indicator === "waiting-for-input" && !live.archived && (
          <span className="shrink-0 rounded-full bg-surface-attention px-1.5 text-[10.5px] leading-4 text-foreground">Needs you</span>
        )}
        {!unavailable && live.indicator === "unread-error" && !live.archived && (
          <span className="shrink-0 rounded-full border border-border-seam px-1.5 text-[10.5px] leading-4 text-destructive-text">Failed</span>
        )}
        {sharedCount > 0 && (
          <span title="Files also changed in another worktree"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border-seam px-1.5 text-[10.5px] leading-4 text-warning-text">
            <Icon name="AlertTriangle" className="size-3" aria-hidden />
            {sharedCount} shared
          </span>
        )}
        <PullRequestBadge threadId={id} />
      </span>
      <span className="col-start-3 row-start-1 whitespace-nowrap text-right font-mono">
        {loading
          ? <Skeleton className="h-3 w-14 align-middle" />
          : unavailable
            ? <span className="text-destructive-text" title={worktree.message ?? undefined}>unavailable</span>
            : <><span className="text-diff-added">+{additions}</span> <span className="text-diff-removed">−{deletions}</span></>}
      </span>
      <Icon name="ChevronRight" className="col-start-4 row-span-2 row-start-1 size-3.5 text-subtle-foreground" aria-hidden />
      <span className="col-start-2 row-start-2 flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
        {worktree.branch !== null && <Icon name="GitBranch" className="size-3 shrink-0" aria-hidden />}
        <span title={worktree.branch ?? undefined} className="truncate">{worktree.branch}</span>
        {underTitle !== null && <span title={underTitle} className="min-w-0 shrink truncate font-sans text-subtle-foreground">· under {underTitle}</span>}
        {worktree.threadIds.length > 1 && id !== currentThreadId && (
          <span className="shrink-0 font-sans text-subtle-foreground">· +{worktree.threadIds.length - 1} {worktree.threadIds.length === 2 ? "thread" : "threads"}</span>
        )}
      </span>
      {loading && (
        <span className="col-start-3 row-start-2 flex justify-end"><Skeleton className="h-2.5 w-20" /></span>
      )}
      {!unavailable && !loading && (
        <span className="col-start-3 row-start-2 flex justify-end gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
          {worktree.aheadCount !== null && worktree.behindCount !== null && (
            <span className="font-mono" title={`Commits ahead of and behind ${worktree.base ?? "the base branch"}`}>↑{worktree.aheadCount} ↓{worktree.behindCount}</span>
          )}
          {worktree.uncommitted.length > 0 ? <span>{worktree.uncommitted.length} uncommitted</span> : <span className="text-subtle-foreground">clean</span>}
        </span>
      )}
    </button>
  );
}

const WorktreeRow = memo(WorktreeRowView);

function SharedBanner({ files, titles }: { files: readonly SharedFile[]; titles: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  const heading = `${files.length} ${files.length === 1 ? "file is" : "files are"} changed in more than one worktree`;
  return (
    <div className="mx-3 mb-0.5 mt-2.5 rounded-lg bg-warning/10 px-2.5 py-2 text-xs">
      <button type="button" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}
        className="flex w-full cursor-pointer items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
        <b className="font-semibold text-foreground">{heading}</b>
        <span className="min-w-0 truncate text-muted-foreground">Merging these branches may conflict.</span>
      </button>
      {open && (
        <ul className="ml-5 mt-1.5 space-y-0.5">
          {files.map((file) => (
            <li key={`${file.projectId}\0${file.path}`} className="text-muted-foreground">
              <code className="font-mono text-[11.5px] text-foreground">{file.path}</code> ·{" "}
              {file.worktreeKeys.map((key) => titles.get(key) ?? key).join(", ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GroupHeading({ group, children, icon }: { group?: string; children: string; icon: "FolderGit" | "Folder" | "Archive" }) {
  return (
    <h3 data-worktree-group={group} className="flex items-center gap-1.5 px-3 pb-1 pt-3.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">
      <Icon name={icon} className="size-3" aria-hidden />
      {children}
    </h3>
  );
}

function OutsideRow({ icon, children, detail, onClick }: { icon: "Folder" | "EditFile"; children: ReactNode; detail: ReactNode; onClick(): void }) {
  return (
    <button type="button" onClick={onClick}
      className="mx-1 flex w-[calc(100%-0.5rem)] cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="text-sm text-foreground">{children}</span>
        <span className="block truncate text-muted-foreground">{detail}</span>
      </span>
      <Icon name="ChevronRight" className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
    </button>
  );
}

export interface WorktreeTally { running: number; needs: number; failed: number }

// What bb says each shown thread is doing; archived and unreadable worktrees count as none of these.
export function useWorktreeTally(
  overview: Pick<Overview, "threads">, worktrees: readonly Worktree[], currentThreadId: string | null,
): WorktreeTally {
  const live = useContext(LiveThreadsContext);
  return useMemo(() => {
    const threads = new Map(overview.threads.map((thread) => [thread.id, thread]));
    const tally = { running: 0, needs: 0, failed: 0 };
    for (const worktree of worktrees) {
      const id = primaryThreadId(worktree, currentThreadId);
      const { indicator, archived } = resolveLive(live?.get(id) ?? null, threads.get(id), id);
      if (archived || worktree.state === "unavailable") continue;
      if (indicator === "runtime") tally.running++;
      else if (indicator === "waiting-for-input") tally.needs++;
      else if (indicator === "unread-error") tally.failed++;
    }
    return tally;
  }, [live, overview.threads, worktrees, currentThreadId]);
}

export function WorktreeList({
  overview, currentThreadId, selectedKey = null, worktrees = overview.worktrees, showSummary = true, onOpen, onShowRepositories,
}: WorktreeListProps) {
  const live = useContext(LiveThreadsContext);
  const threads = useMemo(() => new Map(overview.threads.map((thread) => [thread.id, thread])), [overview.threads]);
  const titles = useWorktreeTitles(overview, currentThreadId);
  const tally = useWorktreeTally(overview, worktrees, currentThreadId);
  const sharedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of overview.sharedFiles) for (const key of file.worktreeKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, [overview.sharedFiles]);
  const archived = countArchived(worktrees, overview.threads);
  const shownKeys = new Set(worktrees.map((worktree) => worktree.key));
  // The files two worktrees share are only known once every worktree's files are.
  const sharedFiles = overview.partial ? [] : overview.sharedFiles.filter((file) => file.worktreeKeys.some((key) => shownKeys.has(key)));
  const titleOf = (id: string): string => resolveLive(live?.get(id) ?? null, threads.get(id), id).title;
  // On the page a child's row says which thread it belongs to; the side panel already is that thread's.
  const underTitleOf = (worktree: Worktree): string | null => {
    const summary = threads.get(primaryThreadId(worktree, currentThreadId));
    if (currentThreadId !== null || summary === undefined || summary.parentThreadId === null || !threads.has(summary.parentThreadId)) return null;
    return titleOf(summary.rootThreadId);
  };

  // Archived rows get their own groups after every active group, so including them never moves an active row.
  const groups: Array<{ label: string; hostName: string; archived: boolean; items: Worktree[] }> = [];
  for (const worktree of worktrees) {
    const archivedRow = isArchivedOnly(worktree, threads);
    let group = groups.find((entry) => entry.label === worktree.label && entry.hostName === worktree.hostName && entry.archived === archivedRow);
    if (group === undefined) groups.push(group = { label: worktree.label, hostName: worktree.hostName, archived: archivedRow, items: [] });
    group.items.push(worktree);
  }
  groups.sort((a, b) => Number(a.archived) - Number(b.archived));
  // Rows added by "Include archived" that are still loading and were held back by "With changes only".
  const archivedPending = !overview.partial && overview.worktrees.some((worktree) =>
    worktree.state === "loading" && !shownKeys.has(worktree.key) && isArchivedOnly(worktree, threads));
  const severalMachines = new Set(worktrees.map((worktree) => worktree.hostId)).size > 1;
  const checkouts = overview.repos.filter((repo) => repo.ref.kind === "checkout");
  const outside = overview.partial || checkouts.length > 0 || overview.otherFiles.length > 0;

  return (
    <div data-worktree-list className="pb-3">
      {overview.worktrees.length === 0
        ? <p className="px-3.5 pt-3.5 text-sm text-muted-foreground">No worktrees in this thread or its child threads yet.</p>
        : worktrees.length === 0
          ? <p className="px-3.5 pt-3.5 text-sm text-muted-foreground">No worktrees match the filters.</p>
          : showSummary && (
            <p className="px-3.5 pt-2.5 text-xs text-muted-foreground">
              {plural(worktrees.length, "workspace")} · {tally.running} running · {tally.needs} {tally.needs === 1 ? "needs" : "need"} you · {tally.failed} failed
              {archived > 0 && ` · ${archived} archived`}
            </p>
          )}
      {sharedFiles.length > 0 && (
        <SharedBanner files={sharedFiles} titles={titles} />
      )}
      {groups.map((group) => {
        const first = group.items[0]!;
        const noun = group.items.length === 1 ? (first.kind === "branch" ? "archived branch" : "worktree") : "workspaces";
        return (
          <section key={`${group.archived ? "archived" : "active"}\0${group.label}\0${group.hostName}`}>
            <GroupHeading group={group.label} icon={group.archived ? "Archive" : "FolderGit"}>
              {`${group.archived ? "Archived · " : ""}${group.label} · ${group.items.length} ${noun}${severalMachines ? ` · ${group.hostName}` : ""}`}
            </GroupHeading>
            {group.items.map((worktree) => (
              <WorktreeRow key={worktree.key} worktree={worktree} currentThreadId={currentThreadId} selected={worktree.key === selectedKey}
                underTitle={underTitleOf(worktree)}
                fallback={threads.get(primaryThreadId(worktree, currentThreadId))} sharedCount={sharedCounts.get(worktree.key) ?? 0} onOpen={onOpen} />
            ))}
          </section>
        );
      })}
      {archivedPending && (
        <section>
          {!groups.some((group) => group.archived) && <GroupHeading icon="Archive">Archived</GroupHeading>}
          <ArchivedSkeleton />
        </section>
      )}
      {outside && (
        <section>
          <GroupHeading icon="Folder">Changed outside worktrees</GroupHeading>
          {overview.partial && <EditsSkeleton />}
          {checkouts.map((repo) => (
            <OutsideRow key={repo.key} icon="Folder" onClick={onShowRepositories}
              detail={<>{plural(repo.totals.files, "file")} · <span className="text-diff-added">+{repo.totals.additions}</span> <span className="text-diff-removed">−{repo.totals.deletions}</span></>}>
              {repo.label} <span className="text-muted-foreground">· edited by path</span>
            </OutsideRow>
          ))}
          {overview.otherFiles.length > 0 && (
            <OutsideRow icon="EditFile" onClick={onShowRepositories} detail={`${plural(overview.otherFiles.length, "file")} · recorded edits only`}>
              Other files <span className="text-muted-foreground">· not in a repository</span>
            </OutsideRow>
          )}
        </section>
      )}
    </div>
  );
}
