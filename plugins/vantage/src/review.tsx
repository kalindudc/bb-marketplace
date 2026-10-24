import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  experimental_Icon as Icon, experimental_ThreadActionsMenu as ThreadActionsMenu, experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_copyToClipboard, useBbNavigate, useSdk, type PluginSidebarThread, type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Commit, CommitFilesInput, CommitFilesOutput, FileChange, Overview, PatchScope, ReviewMarks, ThreadSummary, Worktree } from "./contract";
import { composeReview, useComments, type Comment, type CommentStore } from "./comments";
import { FileCard, ICON_BUTTON, StatusLetter, Counts, type Composing, type FileLoaders } from "./file-card";
import { isWorking, needsYou, quietIndicator, usePullRequest } from "./live";
import { useLoaded } from "./loaded";
import { plural, type Row } from "./model";
import { isReviewed, isStale, markId, type FilePart, type Part, type SetReviewed } from "./reviewed";
import { SkeletonRows } from "./skeleton";
import { openEnvironmentTerminal, openHostTerminal, openWorktreeTerminal } from "./terminal";
import { diffView, fileTree, hideReviewed } from "./ui-prefs";
import { useShared } from "./session";

// Keys are the user's while they type: in a field, an editor or anything that says it is a text box.
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox']") !== null;
}

export type ReviewLoaders = FileLoaders & { commitFiles(input: CommitFilesInput): Promise<CommitFilesOutput> };
export type ChangeScope = "all" | "uncommitted" | "committed" | `commit:${string}`;

export interface ReviewProps {
  overview: Overview;
  row: Row;
  index: number;
  total: number;
  compact?: boolean;
  // The side panel's own thread; null on the full-screen page, which belongs to no thread.
  currentThreadId: string | null;
  currentHostId: string | null;
  // "thread": a terminal of the panel's thread, on that thread's machine. "environment": one of the worktree's own, wherever it is.
  terminal: "thread" | "environment";
  marks: ReviewMarks | undefined;
  titleOf(worktreeKey: string): string;
  branchOf(worktreeKey: string): string | null;
  comments: CommentStore;
  loaders: ReviewLoaders;
  setReviewed: SetReviewed;
  onToggleReviews(): void;
  onStep(delta: -1 | 1): void;
  onMessage(): void;
  onCompare(path: string): void;
  onSent(): void;
  // The thread tab puts its own Changes and Chat switch here.
  toolbar?: ReactNode;
}

const BUTTON = "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border-seam bg-card px-2.5 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-45 disabled:hover:bg-card";
const PRIMARY = "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function threadTarget(sidebar: PluginSidebarThread): PluginThreadActionTarget {
  return {
    id: sidebar.id, projectId: sidebar.projectId, parentThreadId: sidebar.parentThreadId, archivedAt: sidebar.archivedAt,
    pinnedAt: sidebar.pinnedAt, sectionId: sidebar.sectionId, isUnread: sidebar.isUnread, status: sidebar.status,
    environment: sidebar.environment?.id ? { id: sidebar.environment.id, path: sidebar.environment.path } : null,
  };
}

function terminalBlock(worktree: Worktree, currentHostId: string | null, terminal: "thread" | "environment"): string | null {
  if (worktree.kind === "branch") return "The worktree was removed, so there is no folder to open";
  if (worktree.state === "unavailable") return "This worktree cannot be read, so there is no folder to open";
  if (terminal === "thread" && currentHostId !== worktree.hostId) return "The worktree is on another machine than this thread, so its terminal cannot be shown here";
  return null;
}

export function StatusGlyph({ row }: { row: Pick<Row, "live" | "watched" | "worktree"> }) {
  if (row.worktree.state === "unavailable") return <Icon name="AlertTriangle" className="size-3.5 text-destructive-text" aria-label="Unavailable" />;
  return <ThreadStatusGlyph indicator={quietIndicator(row.live.indicator, row.watched)} archived={row.live.archived} size="compact" />;
}

export function statusLabel(row: Row): string {
  if (row.worktree.state === "unavailable") return "Unavailable";
  if (row.live.archived) return "Archived";
  if (row.watched && row.live.indicator === "waiting-for-input") return "Needs you";
  if (row.watched && row.live.indicator === "unread-error") return "Failed";
  if (isWorking(row.live)) return "Working";
  if (row.bucket === "reviewed") return "Reviewed";
  return "Idle";
}

const PILL_TONE: Record<string, string> = {
  "Needs you": "bg-surface-attention text-foreground", Failed: "bg-surface-destructive text-destructive-text",
  Working: "bg-state-hover text-foreground", Reviewed: "bg-success/15 text-success", Unavailable: "bg-surface-destructive text-destructive-text",
};

export function PullRequestChip({ environmentId }: { environmentId: string | null }) {
  const pr = usePullRequest(environmentId);
  if (pr === null) return null;
  const tone = pr.state === "merged" ? "text-success" : pr.checks === "failing" ? "text-destructive-text" : "text-muted-foreground";
  return (
    <span title={pr.title} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs ${tone}`}>
      <Icon name={pr.state === "merged" ? "GitMerge" : pr.state === "draft" ? "GitPullRequestDraft" : "GitPullRequest"} fallback="GitPullRequest" className="size-3" aria-hidden />
      #{pr.number} {pr.state}{pr.state === "merged" || pr.checks === "no_checks" || pr.checks === "unknown" ? "" : ` · checks ${pr.checks}`}
    </span>
  );
}

function Strip({ tone, icon, children, actions }: { tone: "attention" | "destructive" | "warning" | "info"; icon: string; children: ReactNode; actions?: ReactNode }) {
  const toneClass = {
    attention: "bg-surface-attention", destructive: "bg-surface-destructive", warning: "bg-warning/10", info: "bg-surface-recessed",
  }[tone];
  const iconTone = { attention: "text-foreground", destructive: "text-destructive-text", warning: "text-warning-text", info: "text-muted-foreground" }[tone];
  return (
    <div role="status" data-strip={tone} className={`flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg px-3 py-2 text-xs ${toneClass}`}>
      <Icon name={icon} className={`size-3.5 shrink-0 ${iconTone}`} aria-hidden />
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
      {actions}
    </div>
  );
}

export function FoldAllButton({ allFolded, compact = false, onToggle }: { allFolded: boolean; compact?: boolean; onToggle(): void }) {
  return (
    <button type="button" onClick={onToggle} aria-label={allFolded ? "Expand all diffs" : "Collapse all diffs"}
      title={`${allFolded ? "Expand" : "Collapse"} every file (X)`}
      className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      <Icon name={allFolded ? "ChevronsDown" : "ChevronsUp"} fallback={allFolded ? "ChevronDown" : "ChevronUp"} className="size-3.5" aria-hidden />
      {!compact && (allFolded ? "Expand all" : "Collapse all")}
    </button>
  );
}

function partsFor(worktree: Worktree, scope: ChangeScope, commitFiles: readonly FileChange[] | null): FilePart[] {
  const uncommitted = worktree.uncommitted.map((file) => ({ part: "uncommitted" as Part, file }));
  const committed = worktree.committed.map((file) => ({ part: "committed" as Part, file }));
  if (scope === "uncommitted") return uncommitted;
  if (scope === "committed") return committed;
  if (scope === "all") return [...uncommitted, ...committed];
  return (commitFiles ?? []).map((file) => ({ part: scope as Part, file }));
}

const patchScopeOf = (part: Part): PatchScope => (part === "uncommitted" ? "uncommitted" : "committed");
const shaOf = (part: Part): string | null => (part.startsWith("commit:") ? part.slice(7) : null);
const noteOf = (part: Part): string => (part === "uncommitted" ? "not committed" : part === "committed" ? "committed" : "");

function FileTree({ parts, cardKey, focused, row, marks, commentCounts, overlapPaths, onJump, onReview }: {
  parts: readonly FilePart[]; cardKey(part: FilePart): string; focused: string | null; row: Row; marks: ReviewMarks | undefined;
  commentCounts: ReadonlyMap<string, number>; overlapPaths: ReadonlySet<string>; onJump(key: string): void; onReview(part: FilePart): void;
}) {
  const byDir = new Map<string, FilePart[]>();
  for (const part of parts) {
    const slash = part.file.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : part.file.path.slice(0, slash);
    byDir.set(dir, [...(byDir.get(dir) ?? []), part]);
  }
  const dirs = [...byDir.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  return (
    <nav aria-label="Files" data-file-tree className="min-h-0 overflow-y-auto border-r border-border-seam px-1.5 py-2 text-xs">
      {dirs.map((dir) => (
        <div key={dir}>
          {dir !== "" && (
            <div className="flex items-center gap-1 px-1.5 py-1 text-muted-foreground">
              <Icon name="Folder" className="size-3 shrink-0" aria-hidden />
              <span className="truncate font-mono text-[11px]" title={dir}>{dir}</span>
            </div>
          )}
          {byDir.get(dir)!.map((part) => {
            const key = cardKey(part);
            const reviewed = row.reviewing && isReviewed(marks, part);
            const comments = commentCounts.get(markId(part.part, part.file.path)) ?? 0;
            return (
              <div key={key} className={`flex items-center rounded-md ${focused === key ? "bg-surface-selected" : "hover:bg-state-hover"} ${dir === "" ? "" : "pl-3"}`}>
                <button type="button" onClick={() => onJump(key)} title={part.file.path}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 pl-1.5 text-left">
                  <StatusLetter file={part.file} />
                  <span className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${reviewed ? "text-subtle-foreground" : "text-foreground"}`}>{part.file.path.slice(part.file.path.lastIndexOf("/") + 1)}</span>
                  {overlapPaths.has(part.file.path) && <Icon name="AlertTriangle" className="size-3 shrink-0 text-warning-text" aria-label="Also changed in another worktree" />}
                  {comments > 0 && <span className="shrink-0 text-[10.5px] text-muted-foreground" title={plural(comments, "comment")}>{comments}</span>}
                  <Counts file={part.file} />
                </button>
                {row.reviewing && (
                  <button type="button" aria-label={reviewed ? `Mark ${part.file.path} as not reviewed` : `Mark ${part.file.path} as reviewed`} aria-pressed={reviewed}
                    onClick={() => onReview(part)} className={`${ICON_BUTTON} ml-0.5 ${reviewed ? "text-success" : ""}`}>
                    <Icon name={reviewed ? "Check" : "Square"} className="size-3.5" aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function CommitsMenu({ commits, heading, value, onPick }: { commits: readonly Commit[]; heading: string; value: string | null; onPick(sha: string): void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const picked = commits.find((commit) => commit.sha === value);
  return (
    <div ref={wrap} className="relative"
      onKeyDown={(event) => { if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-pressed={picked !== undefined} onClick={() => setOpen((shown) => !shown)}
        className={`inline-flex h-7 max-w-56 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs ${picked ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
        <Icon name="GitCommit" fallback="GitBranch" className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{picked ? `${picked.shortSha} ${picked.subject}` : `Commits ${commits.length}`}</span>
        <Icon name="ChevronDown" className="size-3 shrink-0" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-8 z-20 w-80 rounded-lg border border-border-seam bg-card p-1 shadow-lg">
          <p className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">{heading}</p>
          {commits.map((commit) => (
            <button key={commit.sha} type="button" role="menuitemradio" aria-checked={commit.sha === value}
              onClick={() => { onPick(commit.sha); setOpen(false); }}
              className={`flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover ${commit.sha === value ? "bg-surface-selected" : ""}`}>
              <span className="mt-px shrink-0 font-mono text-[11px] text-muted-foreground">{commit.shortSha}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground">{commit.subject}</span>
                <span className="block text-[11px] text-muted-foreground">{commit.authorName}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SendBar({ row, comments, compact, root, onDiscard, onDone, onSent, sendRef }: {
  row: Row; comments: readonly Comment[]; compact: boolean; root: string | null; onDiscard(): void; onDone(sent: readonly Comment[]): void; onSent(): void;
  sendRef: { current: (() => void) | null };
}) {
  const sdk = useSdk();
  const [menu, setMenu] = useState(false);
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const message = composeReview(comments, root);
  const working = isWorking(row.live);
  const archived = row.live.archived;
  const agent = row.title === "This thread" ? "this thread" : row.title;
  const send = (mode: "steer-if-active" | "queue-if-active") => {
    setMenu(false);
    setSending(true);
    // The comments as this message has them; any added or edited while it is on its way stay as drafts.
    const sent = comments;
    sdk.threads.send({ threadId: row.threadId, input: [{ type: "text", text: message, mentions: [] }], mode }).then(
      (result) => {
        setSending(false);
        toast(result.delivery === "queued" ? `Queued ${plural(comments.length, "comment")}: the agent reads them after its current turn` : `Sent ${plural(comments.length, "comment")} to the agent`);
        onDone(sent);
        onSent();
      },
      (error: unknown) => {
        setSending(false);
        toast.error(`Could not send your comments: ${errorMessage(error)}`);
      },
    );
  };
  useEffect(() => {
    sendRef.current = sending || archived ? null : () => send(working ? "queue-if-active" : "steer-if-active");
    return () => { sendRef.current = null; };
  });
  const copy = () => {
    setMenu(false);
    experimental_copyToClipboard({ text: message })
      .then((copied) => { if (copied) toast("Copied as Markdown"); else toast.error("Could not copy"); })
      .catch(() => toast.error("Could not copy"));
  };
  const files = [...new Set(comments.map((comment) => comment.path))];
  return (
    <div data-send-bar className="pointer-events-none sticky bottom-0 z-10 px-1 pb-3 pt-1">
      {preview && (
        <div className="pointer-events-auto mb-2 max-h-72 overflow-auto rounded-xl border border-border-seam bg-card p-3 shadow-lg">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Icon name="Sent" fallback="SideChat" className="size-3" aria-hidden />Message to {agent}
          </p>
          <pre data-review-preview className="whitespace-pre-wrap font-sans text-xs text-foreground">{message}</pre>
        </div>
      )}
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-border-seam bg-card px-3 py-2 shadow-lg">
        <Icon name="MessageSquare" fallback="SideChat" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-foreground">{plural(comments.length, "comment")} for {agent}</span>
          {!compact && <span className="block truncate text-[11px] text-muted-foreground">{files.join(" · ")}</span>}
        </span>
        <button type="button" onClick={onDiscard} className="h-7 cursor-pointer rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover">Discard</button>
        <button type="button" aria-pressed={preview} onClick={() => setPreview((shown) => !shown)} className={BUTTON}>Preview</button>
        <div className="relative flex">
          <button type="button" disabled={sending || archived} title={archived ? "This thread is archived" : undefined}
            onClick={() => send(working ? "queue-if-active" : "steer-if-active")} className={`${PRIMARY} rounded-r-none`}>
            <Icon name="Sent" fallback="SideChat" className="size-3.5" aria-hidden />
            {working ? "Queue for agent" : "Send to agent"}
          </button>
          <button type="button" aria-label="More ways to send" aria-expanded={menu} disabled={sending || archived} onClick={() => setMenu((shown) => !shown)}
            className={`${PRIMARY} rounded-l-none border-l border-primary-foreground/25 px-1.5`}>
            <Icon name="ChevronDown" className="size-3.5" aria-hidden />
          </button>
          {menu && (
            <div role="menu" className="absolute bottom-9 right-0 z-20 w-72 rounded-lg border border-border-seam bg-card p-1 shadow-lg">
              <button type="button" role="menuitem" onClick={() => send("steer-if-active")} className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover">
                <span className="block text-foreground">Send now</span>
                <span className="block text-[11px] text-muted-foreground">{working ? "Adds your notes to the turn it is running." : "Starts a turn with your notes."}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => send("queue-if-active")} className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover">
                <span className="block text-foreground">Queue after its current turn</span>
                <span className="block text-[11px] text-muted-foreground">Waits until the agent finishes what it is doing.</span>
              </button>
              <button type="button" role="menuitem" onClick={copy} className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover">
                <span className="block text-foreground">Copy as Markdown</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Review(props: ReviewProps) {
  const {
    overview, row, index, total, compact = false, currentThreadId, currentHostId, terminal, marks, titleOf, branchOf, comments: commentStore,
    loaders, setReviewed, onToggleReviews, onStep, onMessage, onCompare, onSent, toolbar,
  } = props;
  const { worktree } = row;
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const view = useShared(diffView);
  const hide = useShared(hideReviewed);
  const treeOn = useShared(fileTree);
  const [scope, setScope] = useState<ChangeScope>("all");
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [focused, setFocused] = useState<string | null>(null);
  const [composing, setComposing] = useState<Composing | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const sendRef = useRef<(() => void) | null>(null);
  const drafts = useComments(commentStore, worktree.key);
  const threads = useMemo(() => new Map<string, ThreadSummary>(overview.threads.map((thread) => [thread.id, thread])), [overview.threads]);
  const own = currentThreadId !== null && row.threadId === currentThreadId;
  const loading = worktree.state === "loading";
  const unavailable = worktree.state === "unavailable";

  const commitSha = scope.startsWith("commit:") ? scope.slice(7) : null;
  const [commitState, retryCommit] = useLoaded<CommitFilesOutput>(`commitFiles\0${worktree.key}\0${commitSha ?? ""}`, commitSha !== null,
    () => loaders.commitFiles({ ref: worktree.ref, sha: commitSha! }));
  const parts = partsFor(worktree, scope, commitState.status === "ready" ? commitState.value.files : null);
  const cardKey = useCallback((part: FilePart) => `${worktree.key}\0${part.part}\0${part.file.path}`, [worktree.key]);
  const reviewedPart = (part: FilePart) => row.reviewing && isReviewed(marks, part);
  const shown = row.reviewing && hide ? parts.filter((part) => !reviewedPart(part)) : parts;
  const isFolded = (part: FilePart) => folds.get(cardKey(part)) ?? reviewedPart(part);
  const allFolded = parts.length > 0 && parts.every(isFolded);
  // An explicit fold for every file, so Expand all also opens the ones reviews fold by default.
  const foldAll = (folded: boolean) => setFolds(new Map(parts.map((part) => [cardKey(part), folded])));
  const reviewedCount = parts.filter(reviewedPart).length;
  const overlapPaths = useMemo(() => new Set(row.overlaps.map((overlap) => overlap.path)), [row.overlaps]);
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of drafts) counts.set(markId(comment.part, comment.path), (counts.get(markId(comment.part, comment.path)) ?? 0) + 1);
    return counts;
  }, [drafts]);
  const commitList = worktree.commits.length > 0 ? worktree.commits : worktree.threadCommits;
  const commitHeading = worktree.commits.length > 0 ? `Commits ahead of ${worktree.base ?? "the base branch"}` : `Commits its threads made on ${worktree.branch ?? "its branch"}`;

  const toggleFold = useCallback((key: string) => setFolds((current) => {
    const part = parts.find((entry) => cardKey(entry) === key);
    const next = new Map(current);
    next.set(key, !(current.get(key) ?? (part !== undefined && reviewedPart(part))));
    return next;
  }), [parts, cardKey, marks, row.reviewing]);
  const toggleReviewed = (part: FilePart) => {
    const reviewed = !reviewedPart(part);
    setFolds((current) => { const next = new Map(current); next.delete(cardKey(part)); return next; });
    setReviewed(worktree.key, [part], reviewed).catch((error: unknown) => toast.error(`Could not save: ${errorMessage(error)}`));
  };
  const jump = (key: string) => {
    setFocused(key);
    setFolds((current) => { const next = new Map(current); next.set(key, false); return next; });
    requestAnimationFrame(() => {
      const cards = streamRef.current?.querySelectorAll<HTMLElement>("[data-card-key]") ?? [];
      [...cards].find((card) => card.dataset.cardKey === key)?.scrollIntoView?.({ block: "start" });
    });
  };
  const step = (delta: 1 | -1) => {
    if (shown.length === 0) return;
    const at = shown.findIndex((part) => cardKey(part) === focused);
    const next = shown[at === -1 ? (delta > 0 ? 0 : shown.length - 1) : Math.min(shown.length - 1, Math.max(0, at + delta))]!;
    jump(cardKey(next));
  };
  const startComment = (part: FilePart, quote: string) => {
    setFocused(cardKey(part));
    setFolds((current) => { const next = new Map(current); next.set(cardKey(part), false); return next; });
    setComposing({ path: part.file.path, part: part.part, quote, text: "", editing: null });
  };
  const saveComment = (text: string) => {
    if (composing === null) return;
    if (composing.editing !== null) commentStore.update(worktree.key, composing.editing, text);
    else commentStore.add(worktree.key, { path: composing.path, part: composing.part as Part, quote: composing.quote, text });
    setComposing(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.defaultPrevented || isTyping(event.target)) return;
    const current = parts.find((part) => cardKey(part) === focused);
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      if (sendRef.current === null) return;
      sendRef.current();
    } else if (event.metaKey || event.ctrlKey) return;
    else if (event.key === "j") step(1);
    else if (event.key === "k") step(-1);
    else if (event.key === "v" && current !== undefined && row.reviewing) { toggleReviewed(current); if (!reviewedPart(current)) step(1); }
    else if (event.key === "c" && current !== undefined) startComment(current, "");
    else if (event.key === "x" && parts.length > 0) foldAll(!allFolded);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const blocked = terminalBlock(worktree, currentHostId, terminal);
  const startTerminal = () => {
    const title = `${row.live.title} · ${worktree.branch ?? "worktree"}`;
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
  const copy = (text: string) => {
    experimental_copyToClipboard({ text }).then((copied) => { if (copied) toast("Copied"); else toast.error("Could not copy"); }).catch(() => toast.error("Could not copy"));
  };
  const retry = () => {
    sdk.threads.retry({ threadId: row.threadId }).then(() => toast("Retrying the failed turn"), (error: unknown) => toast.error(`Could not retry: ${errorMessage(error)}`));
  };
  const askRebase = (path: string, otherKey: string) => {
    const other = titleOf(otherKey);
    const branch = branchOf(otherKey);
    commentStore.add(worktree.key, {
      path, part: worktree.uncommitted.some((file) => file.path === path) ? "uncommitted" : "committed", quote: "",
      text: `This file is also changed in "${other}"${branch === null ? "" : ` on ${branch}`}. Commit your work, rebase onto ${branch ?? "that branch"} and resolve the conflict in ${path}, keeping both changes.`,
    });
  };

  const status = statusLabel(row);
  const answer = row.watched && row.live.indicator === "waiting-for-input" && !row.live.archived;
  const wide = !compact && treeOn;
  const strips: ReactNode[] = [];
  if (row.watched && needsYou(row.live)) {
    strips.push(row.live.indicator === "waiting-for-input"
      ? <Strip key="needs" tone="attention" icon="SideChat" actions={<button type="button" className={PRIMARY} onClick={onMessage}>Answer</button>}>
        <b className="font-semibold">{row.live.sidebar?.indicatorLabel ?? "The agent is waiting for you"}.</b>
      </Strip>
      : <Strip key="failed" tone="destructive" icon="AlertTriangle"
        actions={<><button type="button" className={BUTTON} onClick={retry}>Retry</button><button type="button" className={BUTTON} onClick={onMessage}>Message agent</button></>}>
        <b className="font-semibold">{row.live.sidebar?.indicatorLabel ?? "The last turn failed"}.</b>
      </Strip>);
  }
  if (unavailable) strips.push(<Strip key="unavailable" tone="destructive" icon="AlertTriangle">{worktree.message ?? "This worktree is unavailable."}</Strip>);
  if (row.live.archived || worktree.kind === "branch") {
    strips.push(<Strip key="archived" tone="info" icon="Archive"><b className="font-semibold">Archived.</b> Its worktree was removed, so only the committed work on its kept branch is shown.</Strip>);
  } else if (isWorking(row.live)) {
    strips.push(<Strip key="working" tone="info" icon="Clock"><b className="font-semibold">Still working.</b> These diffs update as the agent edits.</Strip>);
  }
  if (!row.live.archived) {
    for (const overlap of row.overlaps) {
      for (const otherKey of overlap.otherKeys) {
        strips.push(
          <Strip key={`overlap\0${overlap.path}\0${otherKey}`} tone="warning" icon="AlertTriangle"
            actions={<>
              <button type="button" className={BUTTON} onClick={() => onCompare(overlap.path)}>Compare</button>
              {worktree.kind !== "branch" && !compact && (
                <button type="button" className={BUTTON} onClick={() => askRebase(overlap.path, otherKey)}>Ask to rebase onto {titleOf(otherKey)}</button>
              )}
            </>}>
            <b className="font-semibold font-mono">{overlap.path}</b> is also changed in <b className="font-semibold">{titleOf(otherKey)}</b>, so merging both branches may conflict.
          </Strip>,
        );
      }
    }
  }

  const empty = scope === "uncommitted"
    ? (worktree.kind === "branch" ? "The worktree was removed, so only committed work remains." : "Nothing uncommitted.")
    : scope === "committed"
      ? (worktree.onBase ? `Works on ${worktree.base}, its base branch, so nothing counts as committed ahead. Its commits are in the Commits menu.` : `No commits ahead of ${worktree.base ?? "the base branch"} yet.`)
      : "No changes in this worktree.";

  const header = (
    <div data-review-header className={`shrink-0 border-b border-border-seam ${compact ? "px-3 pb-2.5 pt-2" : "px-5 pb-3 pt-3.5"}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center"><StatusGlyph row={row} /></span>
        <h2 className={`min-w-0 truncate font-semibold text-foreground ${compact ? "text-sm" : "text-base"}`} title={row.live.title}>{own ? `This thread · ${row.live.title}` : row.live.title}</h2>
        {status !== "Idle" && <span className={`shrink-0 rounded-full px-2 py-px text-[11px] ${PILL_TONE[status] ?? "bg-state-hover text-muted-foreground"}`}>{status}</span>}
        <span className="flex-1" />
        {!compact && (
          <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
            <button type="button" aria-label="Previous worktree" title="Previous worktree ([)" disabled={index <= 0} onClick={() => onStep(-1)} className={ICON_BUTTON}>
              <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
            </button>
            {index >= 0 && <span>{index + 1} of {total}</span>}
            <button type="button" aria-label="Next worktree" title="Next worktree (])" disabled={index < 0 || index >= total - 1} onClick={() => onStep(1)} className={ICON_BUTTON}>
              <Icon name="ChevronRight" className="size-3.5" aria-hidden />
            </button>
          </span>
        )}
      </div>
      <div className={`mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground ${compact ? "" : "ml-6"}`}>
        <span className="inline-flex items-center gap-1"><Icon name="Folder" className="size-3" aria-hidden />{worktree.label}</span>
        {worktree.branch !== null && (
          <span className="inline-flex min-w-0 items-center gap-1" title={worktree.branch}>
            <Icon name="GitBranch" className="size-3 shrink-0" aria-hidden />
            <span className="max-w-64 truncate font-mono text-[11px] text-foreground">{worktree.branch}</span>
            <button type="button" aria-label="Copy the branch name" onClick={() => copy(worktree.branch!)} className={ICON_BUTTON}><Icon name="Copy" className="size-3" aria-hidden /></button>
          </span>
        )}
        {worktree.onBase
          ? <span>on {worktree.base}, its base branch</span>
          : worktree.behindCount !== null && worktree.behindCount > 0
            ? <span className="text-warning-text">{plural(worktree.behindCount, "commit")} behind {worktree.base}</span>
            : worktree.base !== null && worktree.behindCount === 0 && <span>Up to date with {worktree.base}</span>}
        {worktree.aheadCount !== null && worktree.aheadCount > 0 && <span>{worktree.aheadCount} ahead</span>}
        <PullRequestChip environmentId={worktree.ref.kind === "workspace" ? worktree.ref.environmentId : null} />
        {!compact && <span className="inline-flex items-center gap-1"><Icon name="Laptop" fallback="Folder" className="size-3" aria-hidden />{worktree.hostName}</span>}
        {worktree.kind === "checkout" && <span title={worktree.root} className="truncate font-mono text-[11px] text-subtle-foreground">in {worktree.root}</span>}
      </div>
      <div className={`mt-2.5 flex flex-wrap items-center gap-1.5 ${compact ? "" : "ml-6"}`}>
        {!row.live.archived && !own && (
          <button type="button" className={answer ? PRIMARY : BUTTON} onClick={onMessage}>
            <Icon name="SideChat" className="size-3.5" aria-hidden />{answer ? "Answer" : "Message agent"}
          </button>
        )}
        {!own && (
          <button type="button" className={BUTTON} onClick={() => (currentThreadId === null ? navigate.toThread(row.threadId) : navigate.toThread(row.threadId, { split: true }))}>
            <Icon name="PanelRight" className="size-3.5" aria-hidden />Open thread
          </button>
        )}
        <button type="button" className={BUTTON} disabled={blocked !== null} title={blocked ?? "Open a shell in this worktree"} onClick={startTerminal}>
          <Icon name="Terminal" className="size-3.5" aria-hidden />Terminal
        </button>
        <button type="button" className={BUTTON} onClick={() => copy(worktree.root)} title={worktree.root}>
          <Icon name="Copy" className="size-3.5" aria-hidden />Copy path
        </button>
        {!own && row.live.sidebar !== null && (
          <ThreadActionsMenu thread={threadTarget(row.live.sidebar)} align="end"
            trigger={(triggerProps) => (
              <button {...triggerProps} aria-label="Thread actions" title="bb's thread menu: stop, archive and more" className={`${triggerProps.className ?? ""} ${BUTTON} px-1.5`}>
                <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
              </button>
            )} />
        )}
      </div>
    </div>
  );

  const bar = (
    <div data-review-bar className={`flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border-seam ${compact ? "px-3 py-2" : "px-5 py-2"}`}>
      {toolbar}
      {!compact && (
        <button type="button" aria-label={treeOn ? "Hide the file tree" : "Show the file tree"} aria-pressed={treeOn} onClick={() => fileTree.set(!treeOn)}
          className={`${ICON_BUTTON} size-7 ${treeOn ? "bg-surface-selected text-foreground" : ""}`}>
          <Icon name="ListView" fallback="Rows2" className="size-3.5" aria-hidden />
        </button>
      )}
      <div role="group" aria-label="Which changes" className="inline-flex rounded-md bg-surface-recessed p-0.5">
        {([["all", "All changes", worktree.uncommitted.length + worktree.committed.length], ["uncommitted", "Not committed", worktree.uncommitted.length], ["committed", "Committed", worktree.committed.length]] as const)
          .filter(([id]) => !(id === "uncommitted" && worktree.kind === "branch"))
          .map(([id, label, count]) => (
            <button key={id} type="button" aria-pressed={scope === id} onClick={() => setScope(id)}
              className={`inline-flex h-6 cursor-pointer items-center gap-1 rounded px-2 text-xs ${scope === id ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {label}<span className="text-[10.5px] text-subtle-foreground">{loading ? "" : count}</span>
            </button>
          ))}
      </div>
      {commitList.length > 0 && <CommitsMenu commits={commitList} heading={commitHeading} value={commitSha} onPick={(sha) => setScope(`commit:${sha}`)} />}
      <span className="flex-1" />
      {row.reviewing ? (
        <>
          <span data-review-progress className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-recessed">
              <span className="block h-full rounded-full bg-success" style={{ width: `${parts.length === 0 ? 0 : Math.round((reviewedCount / parts.length) * 100)}%` }} />
            </span>
            {reviewedCount} of {parts.length} reviewed
          </span>
          <button type="button" aria-pressed={hide} onClick={() => hideReviewed.set(!hide)}
            className={`h-7 cursor-pointer rounded-md px-2 text-xs ${hide ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
            Hide reviewed
          </button>
        </>
      ) : null}
      <button type="button" aria-pressed={row.reviewing} onClick={onToggleReviews}
        title={row.reviewing ? "Stop tracking reviews in this tree" : "Tick files as you review them, in this tree"}
        className={`inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs ${row.reviewing ? "text-muted-foreground hover:bg-state-hover" : "border border-border-seam text-foreground hover:bg-state-hover"}`}>
        <Icon name="Check" className="size-3.5" aria-hidden />{row.reviewing ? "Reviews on" : "Track reviews"}
      </button>
      {parts.length > 0 && <FoldAllButton allFolded={allFolded} compact={compact} onToggle={() => foldAll(!allFolded)} />}
      {!compact && (
        <div role="group" aria-label="Diff layout" className="inline-flex rounded-md bg-surface-recessed p-0.5">
          {(["unified", "split"] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={view === mode} aria-label={mode === "unified" ? "Unified diff" : "Side by side diff"} onClick={() => diffView.set(mode)}
              className={`inline-flex size-6 cursor-pointer items-center justify-center rounded ${view === mode ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              <Icon name={mode === "unified" ? "Rows2" : "Columns2"} className="size-3.5" aria-hidden />
            </button>
          ))}
        </div>
      )}
    </div>
  );

  let content: ReactNode;
  if (loading) content = <SkeletonRows count={3} label="Reading this worktree's git status…" />;
  else if (commitSha !== null && commitState.status === "error") {
    content = (
      <p role="alert" className="p-4 text-xs text-destructive-text">
        Could not load the files of this commit: {commitState.message}
        <button type="button" className="ml-2 cursor-pointer underline" onClick={retryCommit}>Retry</button>
      </p>
    );
  } else if (commitSha !== null && commitState.status !== "ready") content = <SkeletonRows count={2} label="Loading the files of this commit…" />;
  else if (parts.length === 0) content = <p className="p-4 text-sm text-muted-foreground">{empty}</p>;
  else {
    content = (
      <>
        {shown.map((part) => {
          const key = cardKey(part);
          const mark = markId(part.part, part.file.path);
          const overlap = row.overlaps.find((entry) => entry.path === part.file.path);
          return (
            <FileCard key={key} cardKey={key} repo={worktree} file={part.file} scope={patchScopeOf(part.part)} sha={shaOf(part.part)}
              note={scope === "all" && worktree.uncommitted.length > 0 && worktree.committed.length > 0 ? noteOf(part.part) : null}
              folded={isFolded(part)} onFold={toggleFold} view={compact ? "unified" : view} focused={focused === key} compact={compact} threads={threads} loaders={loaders}
              overlap={overlap === undefined ? null : { title: titleOf(overlap.otherKeys[0]!), onCompare: () => onCompare(part.file.path) }}
              review={row.reviewing ? { reviewed: reviewedPart(part), stale: isStale(marks, part), onToggle: () => toggleReviewed(part) } : null}
              comments={{
                list: drafts.filter((comment) => markId(comment.part, comment.path) === mark),
                composing: composing !== null && markId(composing.part as Part, composing.path) === mark ? composing : null,
                placeholder: `What should ${own ? "this thread" : "the agent"} change in ${part.file.path.slice(part.file.path.lastIndexOf("/") + 1)}?`,
                onStart: (quote) => startComment(part, quote),
                onSave: saveComment,
                onCancel: () => setComposing(null),
                onEdit: (comment) => setComposing({ path: comment.path, part: comment.part, quote: comment.quote, text: comment.text, editing: comment.id }),
                onRemove: (id) => commentStore.remove(worktree.key, id),
              }} />
          );
        })}
        {shown.length < parts.length && (
          <p className="px-1 pb-3 text-xs text-muted-foreground">
            {plural(parts.length - shown.length, "reviewed file")} hidden.{" "}
            <button type="button" className="cursor-pointer underline" onClick={() => hideReviewed.set(false)}>Show {parts.length - shown.length === 1 ? "it" : "them"}</button>
          </p>
        )}
        {shown.length === 0 && parts.length > 0 && <p className="px-1 pb-3 text-sm text-muted-foreground">Every file here is reviewed.</p>}
      </>
    );
  }

  const stream = (
    <div ref={streamRef} data-diff-stream className={compact ? "px-3 pt-3" : "min-h-0 overflow-y-auto px-5 pt-3"}>
      {content}
      {drafts.length > 0 && <SendBar row={row} comments={drafts} compact={compact} root={worktree.root || null} onDiscard={() => commentStore.clear(worktree.key)} onDone={(sent) => commentStore.removeSent(worktree.key, sent)} onSent={onSent} sendRef={sendRef} />}
      {drafts.length === 0 && <div className="h-4" />}
    </div>
  );

  return (
    // Focusable, so a click anywhere in the review gives its keys to it rather than to the page around it.
    <section data-review={worktree.key} tabIndex={-1} onKeyDown={onKeyDown} className={`outline-none ${compact ? "" : "flex h-full min-h-0 flex-col"}`}>
      {header}
      {strips.length > 0 && <div className={`flex shrink-0 flex-col gap-1.5 ${compact ? "px-3 pt-2.5" : "px-5 pt-3"}`}>{strips}</div>}
      {bar}
      {compact
        ? stream
        : (
          <div className={`grid min-h-0 flex-1 ${wide && parts.length > 0 ? "grid-cols-[15rem_minmax(0,1fr)]" : "grid-cols-1"}`}>
            {wide && parts.length > 0 && (
              <FileTree parts={shown} cardKey={cardKey} focused={focused} row={row} marks={marks} commentCounts={commentCounts} overlapPaths={overlapPaths}
                onJump={jump} onReview={toggleReviewed} />
            )}
            {stream}
          </div>
        )}
    </section>
  );
}
