import { useCallback, useMemo, useState } from "react";
import {
  ThreadChat, experimental_Icon as Icon, experimental_ThreadActionsMenu as ThreadActionsMenu, experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_copyToClipboard, useBbNavigate, useSdk, type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Commit, CommitFilesInput, CommitFilesOutput, FileChange, Overview, ThreadSummary, Worktree } from "./contract";
import { FileRow, fileKey, useLoaded, type FileLoaders } from "./file-row";
import { Skeleton, SkeletonRows } from "./skeleton";
import { openEnvironmentTerminal, openHostTerminal, openWorktreeTerminal } from "./terminal";
import { PullRequestBadge, lineCounts, primaryThreadId, useLiveThread, useWorktreeTitles } from "./worktree-list";

export interface WorktreeDetailProps {
  overview: Overview;
  worktreeKey: string;
  tab: "changes" | "commits" | "chat";
  // The side panel's own thread; null on the full-screen page, which belongs to no thread.
  currentThreadId: string | null;
  currentHostId: string | null;
  // "thread": a terminal of the panel's thread, on that thread's machine. "environment": one of the worktree's own, wherever it is.
  terminal?: "thread" | "environment";
  // The sequence [ and ] step through, such as the rows the page's filters leave; every worktree of the overview by default.
  worktrees?: readonly Worktree[];
  onTab(tab: WorktreeDetailProps["tab"]): void;
  onStep(delta: -1 | 1): void;
  onBack(): void;
  loaders: FileLoaders & { commitFiles(input: CommitFilesInput): Promise<CommitFilesOutput> };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(at: number, now: number = Date.now()): string {
  const age = now - at;
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 30 * DAY) return `${Math.floor(age / DAY)} d ago`;
  return new Date(at).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const ACTION_BUTTON = "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border-seam px-2.5 py-1 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent";
const ICON_BUTTON = "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";

function terminalBlock(worktree: Worktree, currentHostId: string | null, terminal: "thread" | "environment"): string | null {
  if (worktree.kind === "branch") return "The worktree was removed, so there is no folder to open";
  if (worktree.state === "unavailable") return "This worktree cannot be read, so there is no folder to open";
  if (terminal === "thread" && currentHostId !== worktree.hostId) return "The worktree is on another machine than this thread, so its terminal cannot be shown here";
  return null;
}

function threadTarget(sidebar: NonNullable<ReturnType<typeof useLiveThread>["sidebar"]>): PluginThreadActionTarget {
  return {
    id: sidebar.id, projectId: sidebar.projectId, parentThreadId: sidebar.parentThreadId, archivedAt: sidebar.archivedAt,
    pinnedAt: sidebar.pinnedAt, sectionId: sidebar.sectionId, isUnread: sidebar.isUnread, status: sidebar.status,
    environment: sidebar.environment?.id ? { id: sidebar.environment.id, path: sidebar.environment.path } : null,
  };
}

function ThreadChip({ threadId, fallback, selected, onSelect }: { threadId: string; fallback: ThreadSummary | undefined; selected: boolean; onSelect(): void }) {
  const live = useLiveThread(threadId, fallback);
  return (
    <button type="button" aria-pressed={selected} onClick={onSelect}
      className={`max-w-48 cursor-pointer truncate rounded-full border px-2 py-px text-xs ${selected ? "border-ring text-foreground" : "border-border-seam text-muted-foreground hover:text-foreground"}`}>
      {live.title}
    </button>
  );
}

function Section({ title, files, children }: { title: string; files: readonly FileChange[]; children: React.ReactNode }) {
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return (
    <>
      <h3 className="flex items-center gap-2 px-3.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">
        <span>{`${title} · ${plural(files.length, "file")} · `}<span className="text-diff-added">+{additions}</span>{" "}<span className="text-diff-removed">−{deletions}</span></span>
      </h3>
      {children}
    </>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="px-3.5 py-1 text-xs text-muted-foreground">{children}</p>;
}

interface BodyProps extends WorktreeDetailProps {
  worktree: Worktree;
  sequence: readonly Worktree[];
  index: number;
}

function CommitFiles({ worktree, commit, sharedWith, expandedFiles, onToggleFile, threads, loaders }: {
  worktree: Worktree; commit: Commit; sharedWith: ReadonlyMap<string, string[]>; expandedFiles: ReadonlySet<string>; onToggleFile(key: string): void;
  threads: ReadonlyMap<string, ThreadSummary>; loaders: BodyProps["loaders"];
}) {
  const [state, retry] = useLoaded(`commitFiles\0${worktree.key}\0${commit.sha}`, true, () => loaders.commitFiles({ ref: worktree.ref, sha: commit.sha }));
  if (state.status === "loading") return <p className="py-1 pl-8 text-xs text-muted-foreground">Loading the files of this commit…</p>;
  if (state.status === "error") {
    return (
      <p role="alert" className="py-1 pl-8 pr-3 text-xs text-destructive-text">
        Could not load the files of this commit: {state.message}
        <button type="button" className="ml-2 underline" onClick={retry}>Retry</button>
      </p>
    );
  }
  return (
    <>
      {state.value.files.map((file) => (
        <FileRow key={file.path} repo={worktree} file={file} scope="uncommitted" patchScope="committed" sha={commit.sha} sharedWith={sharedWith.get(file.path)}
          threads={threads} expanded={expandedFiles.has(fileKey(worktree, file.path, "committed", commit.sha))} onToggle={onToggleFile} loaders={loaders} />
      ))}
    </>
  );
}

function WorktreeDetailBody(props: BodyProps) {
  const { overview, worktree, sequence, index, tab, currentThreadId, currentHostId, terminal = "thread", onTab, onStep, onBack, loaders } = props;
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const threads = useMemo(() => new Map(overview.threads.map((thread) => [thread.id, thread])), [overview.threads]);
  const titles = useWorktreeTitles(overview, currentThreadId);
  const primary = primaryThreadId(worktree, currentThreadId);
  const own = currentThreadId !== null && primary === currentThreadId;
  const live = useLiveThread(primary, threads.get(primary));
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [openCommits, setOpenCommits] = useState<ReadonlySet<string>>(() => new Set());
  const [chatThreadId, setChatThreadId] = useState(primary);
  const toggle = useCallback((key: string) => setExpandedFiles((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  const toggleCommit = (sha: string) => setOpenCommits((current) => {
    const next = new Set(current);
    if (!next.delete(sha)) next.add(sha);
    return next;
  });

  const sharedWith = useMemo(() => {
    const byPath = new Map<string, string[]>();
    for (const shared of overview.sharedFiles) {
      if (shared.projectId !== worktree.projectId || !shared.worktreeKeys.includes(worktree.key)) continue;
      byPath.set(shared.path, shared.worktreeKeys.filter((key) => key !== worktree.key).map((key) => titles.get(key) ?? key));
    }
    return byPath;
  }, [overview.sharedFiles, worktree.key, worktree.projectId, titles]);

  const unavailable = worktree.state === "unavailable";
  const loading = worktree.state === "loading";
  const blocked = terminalBlock(worktree, currentHostId, terminal);
  const needsAttention = !live.archived && (live.indicator === "waiting-for-input" || live.indicator === "unread-error");
  const { additions, deletions } = lineCounts(worktree);
  const changeCount = worktree.uncommitted.length + worktree.committed.length;
  const tabs: Array<{ id: WorktreeDetailProps["tab"]; label: string; count: number | null }> = [
    { id: "changes", label: "Changes", count: loading ? null : changeCount },
    { id: "commits", label: "Commits", count: loading ? null : worktree.commits.length + worktree.threadCommits.length },
    ...(own ? [] : [{ id: "chat" as const, label: "Chat", count: null }]),
  ];
  const shown = tab === "chat" && own ? "changes" : tab;

  const startTerminal = () => {
    const title = `${live.title} · ${worktree.branch ?? "worktree"}`;
    const { ref } = worktree;
    const opening = terminal === "environment" && ref.kind === "workspace"
      ? openEnvironmentTerminal(sdk, navigate, { environmentId: ref.environmentId, title })
      : terminal === "environment" && ref.kind === "checkout"
        ? openHostTerminal(sdk, navigate, { hostId: ref.hostId, path: worktree.root, title })
        : openWorktreeTerminal(sdk, navigate, { threadId: currentThreadId!, path: worktree.root, title });
    opening.then(
      (opened) => { if (!opened) toast.error("bb could not show the terminal"); },
      (error: unknown) => { toast.error(`Could not start a terminal: ${errorMessage(error)}`); },
    );
  };
  const copyPath = () => {
    experimental_copyToClipboard({ text: worktree.root })
      .then((copied) => { if (copied) toast("Copied"); else toast.error("Could not copy"); })
      .catch(() => toast.error("Could not copy"));
  };

  const made = worktree.threadCommits.length;
  const onBaseNote = `Works on ${worktree.base}, its base branch, so nothing counts as committed ahead.${made === 0 ? "" : ` Its threads made ${plural(made, "commit")}, listed under Commits.`}`;
  const changes = (
    <>
      <Section title="Uncommitted" files={worktree.uncommitted}>
        {worktree.uncommitted.length === 0
          ? <Empty>{worktree.kind === "branch" ? "The worktree was removed, so only committed work remains." : "Nothing uncommitted."}</Empty>
          : worktree.uncommitted.map((file) => (
            <FileRow key={file.path} repo={worktree} file={file} scope="uncommitted" patchScope="uncommitted" sharedWith={sharedWith.get(file.path)}
              threads={threads} expanded={expandedFiles.has(fileKey(worktree, file.path, "uncommitted"))} onToggle={toggle} loaders={loaders} />
          ))}
      </Section>
      {!(own && worktree.committed.length === 0) && (
        <Section title={worktree.kind === "branch" ? "Committed on the kept branch" : "Committed on this branch"} files={worktree.committed}>
          {worktree.committed.length === 0
            ? <Empty>{worktree.onBase ? onBaseNote : `No commits ahead of ${worktree.base ?? "the base branch"} yet.`}</Empty>
            : worktree.committed.map((file) => (
              <FileRow key={file.path} repo={worktree} file={file} scope="uncommitted" patchScope="committed" sharedWith={sharedWith.get(file.path)}
                threads={threads} expanded={expandedFiles.has(fileKey(worktree, file.path, "committed"))} onToggle={toggle} loaders={loaders} />
            ))}
        </Section>
      )}
    </>
  );

  const commitList = (heading: string, list: readonly Commit[]) => (
    <>
      <h3 className="px-3.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">{heading}</h3>
      {list.map((commit) => {
        const open = openCommits.has(commit.sha);
        return (
          <div key={commit.sha}>
            <button type="button" aria-expanded={open} onClick={() => toggleCommit(commit.sha)}
              className="flex w-full min-w-0 cursor-pointer items-center gap-2 py-1 pl-3.5 pr-3 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0 text-subtle-foreground" aria-hidden />
              <span className="shrink-0 font-mono text-ring">{commit.shortSha}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{commit.subject}</span>
              <span className="shrink-0 text-muted-foreground">{commit.authorName} · {relativeTime(commit.authoredAt)}</span>
            </button>
            {open && (
              <CommitFiles worktree={worktree} commit={commit} sharedWith={sharedWith} expandedFiles={expandedFiles} onToggleFile={toggle}
                threads={threads} loaders={loaders} />
            )}
          </div>
        );
      })}
    </>
  );
  const madeWhere = worktree.onBase ? ` on ${worktree.branch}` : worktree.base === null ? "" : `, already on ${worktree.base}`;
  const commits = worktree.commits.length > 0
    ? commitList(`${plural(worktree.aheadCount ?? worktree.commits.length, "commit")} ahead of ${worktree.base ?? "the base branch"}`, worktree.commits)
    : made > 0
      ? commitList(`${plural(made, "commit")} its threads made${madeWhere}`, worktree.threadCommits)
      : (
        <p className="px-3.5 pt-3 text-xs text-muted-foreground">
          {worktree.onBase
            ? `Works on ${worktree.base}, its base branch, so nothing counts as ahead. No commits its threads made were found.`
            : `No commits ahead of ${worktree.base ?? "the base branch"}.`}
        </p>
      );

  const others = worktree.threadIds.filter((id) => id !== currentThreadId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div data-worktree-header className="shrink-0 border-b border-border-seam px-3 pt-2.5">
        <div className="-ml-1.5 mb-2 flex items-center gap-1 text-xs text-muted-foreground">
          <button type="button" onClick={onBack}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <Icon name="ArrowLeft" className="size-3.5" aria-hidden />
            All worktrees
          </button>
          <span className="flex-1" />
          <button type="button" aria-label="Previous worktree" title="Previous worktree ([)" disabled={index <= 0} onClick={() => onStep(-1)} className={ICON_BUTTON}>
            <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
          </button>
          {index !== -1 && <span>{index + 1} of {sequence.length}</span>}
          <button type="button" aria-label="Next worktree" title="Next worktree (])" disabled={index === -1 || index === sequence.length - 1} onClick={() => onStep(1)} className={ICON_BUTTON}>
            <Icon name="ChevronRight" className="size-3.5" aria-hidden />
          </button>
        </div>
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="flex size-4 shrink-0 items-center justify-center">
            {!unavailable && <ThreadStatusGlyph indicator={live.indicator} archived={live.archived} size="compact" />}
          </span>
          <span className="min-w-0 truncate">{own ? `This thread · ${live.title}` : live.title}</span>
        </div>
        <div className="ml-6 mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted-foreground">
          {worktree.branch !== null && (
            <span title={worktree.branch} className="inline-flex max-w-full items-center gap-1 font-mono text-[11px] text-foreground">
              <Icon name="GitBranch" className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{worktree.branch}</span>
            </span>
          )}
          {worktree.onBase
            ? <span>on <span className="font-mono text-[11px]">{worktree.base}</span>, its base branch</span>
            : worktree.aheadCount !== null && worktree.behindCount !== null && (
              <span className="font-mono text-[11px]">↑{worktree.aheadCount} ↓{worktree.behindCount}{worktree.base === null ? "" : ` on ${worktree.base}`}</span>
            )}
          <span>{unavailable ? "Unavailable" : live.label}</span>
          <span>{worktree.hostName}</span>
          <PullRequestBadge threadId={primary} />
          <span title={worktree.root} className="max-w-full truncate font-mono text-[11px] text-subtle-foreground">
            {worktree.kind === "branch" ? `kept in ${worktree.root}` : worktree.root}
          </span>
        </div>
        {needsAttention && live.sidebar?.indicatorLabel != null && (
          <p role="status" className={`ml-6 mt-2 rounded-md px-2 py-1.5 text-xs ${live.indicator === "unread-error" ? "bg-surface-destructive" : "bg-surface-attention"}`}>
            {live.sidebar.indicatorLabel}
          </p>
        )}
        <div className="ml-6 mt-2.5 flex flex-wrap items-center gap-1.5">
          {!own && (
            <button type="button" className={ACTION_BUTTON} onClick={() => (currentThreadId === null ? navigate.toThread(primary) : navigate.toThread(primary, { split: true }))}>
              <Icon name="PanelRight" className="size-3.5" aria-hidden />
              Open thread
            </button>
          )}
          <button type="button" className={ACTION_BUTTON} disabled={blocked !== null} title={blocked ?? "Open a shell in this worktree in the terminal panel"} onClick={startTerminal}>
            <Icon name="Terminal" className="size-3.5" aria-hidden />
            Terminal here
          </button>
          <button type="button" className={ACTION_BUTTON} onClick={copyPath}>
            <Icon name="Copy" className="size-3.5" aria-hidden />
            Copy path
          </button>
          {!own && live.sidebar !== null && (
            <ThreadActionsMenu thread={threadTarget(live.sidebar)} align="end"
              trigger={(triggerProps) => (
                <button {...triggerProps} aria-label="Thread actions" title="bb's thread menu"
                  className={`${triggerProps.className ?? ""} ${ACTION_BUTTON}`}>
                  <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
                </button>
              )} />
          )}
        </div>
        <div role="tablist" aria-label="Worktree" className="mt-2.5 flex gap-0.5">
          {tabs.map(({ id, label, count }) => (
            <button key={id} type="button" role="tab" aria-selected={shown === id} onClick={() => onTab(id)}
              className={`inline-flex cursor-pointer items-center gap-1.5 border-b-2 px-2.5 pb-2 pt-1.5 text-[12.5px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${shown === id ? "border-ring text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              {label}
              {count !== null && <span className="text-[11px] text-subtle-foreground">{count}</span>}
            </button>
          ))}
          <span className="ml-auto self-center whitespace-nowrap pb-1 font-mono text-[11px] text-muted-foreground">
            {loading && <Skeleton className="h-3 w-14 align-middle" />}
            {!unavailable && !loading && <><span className="text-diff-added">+{additions}</span> <span className="text-diff-removed">−{deletions}</span></>}
          </span>
        </div>
      </div>
      {shown === "chat"
        ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {others.length > 1 && (
              <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border-seam px-3 py-1.5">
                {others.map((id) => (
                  <ThreadChip key={id} threadId={id} fallback={threads.get(id)} selected={id === chatThreadId} onSelect={() => setChatThreadId(id)} />
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1">
              <ThreadChat threadId={chatThreadId} variant="compact" layout="contained" permissionPolicy="inherit" />
            </div>
          </div>
        )
        : (
          <div className="min-h-0 flex-1 overflow-y-auto pb-3">
            {unavailable
              ? <p role="alert" className="mx-3.5 mt-3 rounded bg-surface-recessed px-2 py-2 text-xs text-destructive-text">{worktree.message ?? "This worktree is unavailable."}</p>
              : loading ? <SkeletonRows count={3} label="Reading this worktree's git status…" />
                : shown === "changes" ? changes : commits}
          </div>
        )}
    </div>
  );
}

export function WorktreeDetail(props: WorktreeDetailProps) {
  const worktree = props.overview.worktrees.find((entry) => entry.key === props.worktreeKey);
  if (worktree === undefined) return null;
  const sequence = props.worktrees ?? props.overview.worktrees;
  const index = sequence.findIndex((entry) => entry.key === worktree.key);
  return <WorktreeDetailBody key={worktree.key} {...props} worktree={worktree} sequence={sequence} index={index} />;
}
