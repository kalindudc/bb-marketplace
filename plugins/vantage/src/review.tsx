import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  experimental_Icon as Icon,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_copyToClipboard,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type {
  Commit,
  CommitFilesInput,
  CommitFilesOutput,
  FileChange,
  Overview,
  PatchScope,
  ReviewMarks,
  ThreadSummary,
  Worktree,
} from "./contract";
import { composeReview, reviewDraftKey, useComments, type Comment, type CommentStore } from "./comments";
import { DraftInspection } from "./draft-inspection";
import { countedFiles, isFolder } from "./counted";
import {
  FileCard,
  ICON_BUTTON,
  hasPatch,
  prefetchPatch,
  type Composing,
  type FileCardProps,
  type FileLoaders,
} from "./file-card";
import { useCardBodies } from "./card-bodies";
import { isImagePath } from "./images";
import { FileTree } from "./file-tree-view";
import { isWorking, needsYou, usePullRequest } from "./live";
import { useLoaded } from "./loaded";
import { plural, reviewStarted, type Row } from "./model";
import { isReviewed, isStale, markId, type FilePart, type Part, type SetReviewed } from "./reviewed";
import { SkeletonRows } from "./skeleton";
import { openEnvironmentTerminal, openHostTerminal, openWorktreeTerminal } from "./terminal";
import { diffView, diffWrap, fileFolds, foldAll, hideReviewed, reviewScopes, setFoldAll } from "./ui-prefs";
import { useRemembered } from "./remember";
import { useShared } from "./session";
import { readingKey, type Reading, type Subject } from "./reading-state";
import { returnToFiles, useReadingStream } from "./reading-stream";
import { usePanelNav, Popover, type PanelLayout } from "./navigator";
import { CHIP, FLAT_CHIP, IncompleteChip, NotReadChip, WARN_CHIP, terminalBlock, threadTarget } from "./panel-head";

// Keys are the user's while they type: in a field, an editor or anything that says it is a text box.
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox']",
    ) !== null
  );
}

export type ReviewLoaders = FileLoaders & { commitFiles(input: CommitFilesInput): Promise<CommitFilesOutput> };
export type ChangeScope = "all" | "uncommitted" | "committed" | `commit:${string}`;

export interface ReviewProps {
  overview: Overview;
  row: Row;
  index: number;
  total: number;
  compact?: boolean;
  visible?: boolean;
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
  onStep(delta: -1 | 1): void;
  onMessage(): void;
  onCompare(path: string): void;
  onSent(): void;
  // Shows the whole branch against the base bb records, or goes back to counting only its threads' work.
  onWhole?(whole: boolean): unknown;
  // The thread tab puts its own Changes and Chat switch here.
  toolbar?: ReactNode;
  // The side panel's source switch, each source labelled with who owns it, for when its navigator is hidden.
  panelSources?: ReactNode;
  // Shows the thread's own recorded edits instead of a shared checkout's Git changes.
  onRecorded?(): void;
  reader: { surface: string; keyScope?: string; subject: Subject; initial?: Reading; onArrival?(): void };
}

const BUTTON =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border-seam bg-card px-2.5 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-45 disabled:hover:bg-card";
const PRIMARY =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function StatusGlyph({ row }: { row: Pick<Row, "live" | "worktree"> }) {
  if (row.worktree.state === "unavailable")
    return <Icon name="AlertTriangle" className="size-3.5 text-destructive-text" aria-label="Unavailable" />;
  return <ThreadStatusGlyph indicator={row.live.indicator} archived={row.live.archived} size="compact" />;
}

export function statusLabel(row: Row): string {
  if (row.worktree.state === "unavailable") return "Unavailable";
  if (row.live.archived) return "Archived";
  if (row.live.indicator === "waiting-for-input") return "Waiting on you";
  if (row.live.indicator === "unread-error") return "Failed";
  if (isWorking(row.live)) return "Still working";
  if (row.bucket === "reviewed") return "Done";
  return "Idle";
}

const PILL_TONE: Record<string, string> = {
  "Waiting on you": "bg-surface-attention text-foreground",
  Failed: "bg-surface-destructive text-destructive-text",
  "Still working": "bg-state-hover text-foreground",
  Done: "bg-success/15 text-success",
  Unavailable: "bg-surface-destructive text-destructive-text",
};

export function PullRequestChip({ environmentId }: { environmentId: string | null }) {
  const pr = usePullRequest(environmentId);
  if (pr === null) return null;
  const tone =
    pr.state === "merged"
      ? "text-success"
      : pr.checks === "failing"
        ? "text-destructive-text"
        : "text-muted-foreground";
  return (
    <span title={pr.title} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs ${tone}`}>
      <Icon
        name={pr.state === "merged" ? "GitMerge" : pr.state === "draft" ? "GitPullRequestDraft" : "GitPullRequest"}
        fallback="GitPullRequest"
        className="size-3"
        aria-hidden
      />
      #{pr.number} {pr.state}
      {pr.state === "merged" || pr.checks === "no_checks" || pr.checks === "unknown" ? "" : ` · checks ${pr.checks}`}
    </span>
  );
}

// Waits for the server before it can be clicked again, and says so when the choice could not be saved.
function WholeButton({ whole, label, onWhole }: { whole: boolean; label: string; onWhole(whole: boolean): unknown }) {
  const [pending, setPending] = useState(false);
  const click = () => {
    setPending(true);
    Promise.resolve(onWhole(whole)).then(
      () => setPending(false),
      (error: unknown) => {
        setPending(false);
        toast.error(`Could not change what this worktree counts: ${errorMessage(error)}`);
      },
    );
  };
  // A base can be a long branch name, so the label is cut short and the tooltip has all of it.
  return (
    <button type="button" className={`${BUTTON} min-w-0 max-w-full`} title={label} disabled={pending} onClick={click}>
      <span className="truncate">{label}</span>
    </button>
  );
}

function Strip({
  tone,
  icon,
  children,
  actions,
}: {
  tone: "attention" | "destructive" | "warning" | "info";
  icon: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const toneClass = {
    attention: "bg-surface-attention",
    destructive: "bg-surface-destructive",
    warning: "bg-warning/10",
    info: "bg-surface-recessed",
  }[tone];
  const iconTone = {
    attention: "text-foreground",
    destructive: "text-destructive-text",
    warning: "text-warning-text",
    info: "text-muted-foreground",
  }[tone];
  return (
    <div
      role="status"
      data-strip={tone}
      className={`flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg px-3 py-2 text-xs ${toneClass}`}
    >
      <Icon name={icon} className={`size-3.5 shrink-0 ${iconTone}`} aria-hidden />
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
      {actions}
    </div>
  );
}

export function FoldAllButton({
  allFolded,
  compact = false,
  onToggle,
}: {
  allFolded: boolean;
  compact?: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={allFolded ? "Expand all diffs" : "Collapse all diffs"}
      title={`${allFolded ? "Expand" : "Collapse"} every file (X)`}
      className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon
        name={allFolded ? "ChevronsDown" : "ChevronsUp"}
        fallback={allFolded ? "ChevronDown" : "ChevronUp"}
        className="size-3.5"
        aria-hidden
      />
      {/* Collapse all is remembered on this device, so a compact bar names the folded state it leaves behind. */}
      {(!compact || allFolded) && (allFolded ? "Expand all" : "Collapse all")}
    </button>
  );
}

export function WrapButton() {
  const wrap = useShared(diffWrap);
  return (
    <button
      type="button"
      aria-pressed={wrap}
      aria-label="Wrap long lines"
      title={`${wrap ? "Stop wrapping" : "Wrap"} long lines (W)`}
      onClick={() => diffWrap.set(!wrap)}
      className={`${ICON_BUTTON} size-7 ${wrap ? "bg-surface-selected text-foreground" : ""}`}
    >
      <Icon name="TextWrap" fallback="AlignLeft" className="size-3.5" aria-hidden />
    </button>
  );
}

export function ReviewBar({
  stream,
  children,
  className,
  panel,
}: {
  stream: Pick<
    ReturnType<typeof useReadingStream>,
    "treeOn" | "toggleRef" | "toggleTree" | "focusMode" | "focusRef" | "toggleFocus"
  >;
  children: ReactNode;
  className: string;
  // In the side panel the toggle shows or hides the whole navigator, and Focus is an icon at the end of the bar.
  panel?: PanelLayout;
}) {
  const { treeOn, toggleRef, toggleTree, focusMode, focusRef, toggleFocus } = stream;
  const label = focusMode ? "Exit focus" : "Focus on diffs";
  const iconOnly = panel !== undefined && !focusMode;
  const focusButton = (
    <button
      ref={focusRef}
      type="button"
      aria-label={label}
      aria-pressed={focusMode}
      aria-keyshortcuts="F"
      title={`${label} (F)`}
      onClick={() => toggleFocus("button")}
      className={
        iconOnly
          ? `${ICON_BUTTON} size-7`
          : `${ICON_BUTTON} h-7 w-auto gap-1.5 whitespace-nowrap px-2 text-xs ${focusMode ? "bg-surface-selected text-foreground" : ""}`
      }
    >
      <Icon name={focusMode ? "X" : "Maximize2"} className="size-3.5" aria-hidden />
      {!iconOnly && label}
    </button>
  );
  const navigatorLabel = treeOn ? "Hide the trail and file tree" : "Show the trail and file tree";
  return (
    <div
      data-review-bar
      className={`flex min-w-0 shrink-0 items-center gap-x-2 gap-y-1.5 border-b border-border-seam ${focusMode ? "py-1" : panel !== undefined ? "flex-wrap py-1.5" : "flex-wrap py-2"} ${className}`}
    >
      {!focusMode && panel === undefined && (
        <button
          ref={toggleRef}
          type="button"
          aria-label={treeOn ? "Hide the file tree" : "Show the file tree"}
          aria-pressed={treeOn}
          onClick={toggleTree}
          className={`${ICON_BUTTON} size-7 ${treeOn ? "bg-surface-selected text-foreground" : ""}`}
        >
          <Icon name="ListView" fallback="Rows2" className="size-3.5" aria-hidden />
        </button>
      )}
      {!focusMode && panel === "columns" && (
        <button
          ref={toggleRef}
          type="button"
          aria-label={navigatorLabel}
          title={navigatorLabel}
          aria-pressed={treeOn}
          onClick={toggleTree}
          className={`${ICON_BUTTON} size-7 ${treeOn ? "bg-surface-selected text-foreground" : ""}`}
        >
          <Icon name="PanelLeft" fallback="Rows2" className="size-3.5" aria-hidden />
        </button>
      )}
      {panel === undefined && focusButton}
      <div
        className={
          focusMode
            ? "flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap p-0.5 [&>*]:shrink-0"
            : "contents"
        }
      >
        {children}
      </div>
      {/* One element in and out of focus mode, so the focus it is given on exit stays on it. */}
      {panel !== undefined && focusButton}
    </div>
  );
}

export function FocusSummary({ title, files }: { title: string; files: number }) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border-seam px-3 py-1 text-xs">
      <h2 className="min-w-0 flex-1 truncate font-semibold" title={title}>
        {title}
      </h2>
      <span className="shrink-0 text-muted-foreground">{plural(files, "file")}</span>
    </div>
  );
}

export function DiffLayout({ view }: { view: "unified" | "split" }) {
  return (
    <div role="group" aria-label="Diff layout" className="inline-flex rounded-md bg-surface-recessed p-0.5">
      {(["unified", "split"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={view === mode}
          aria-label={mode === "unified" ? "Unified diff" : "Side by side diff"}
          className={`inline-flex size-6 cursor-pointer items-center justify-center rounded focus-visible:ring-1 focus-visible:ring-ring ${view === mode ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => diffView.set(mode)}
        >
          <Icon name={mode === "unified" ? "Rows2" : "Columns2"} className="size-3.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}

// A scope remembered for a worktree, while it still applies: a commit can be rewritten away, and a removed worktree has nothing
// uncommitted. One restored from an earlier visit also gives way when it is empty and the rest is not, such as Not committed
// after the agent committed everything; one picked during this visit stays, so its button does not ignore the click.
export function scopeFrom(
  stored: string | undefined,
  worktree: Pick<Worktree, "kind" | "uncommitted" | "committed">,
  commits: readonly Commit[],
  restored: boolean,
): ChangeScope {
  const emptyBesideOthers = (mine: readonly unknown[], others: readonly unknown[]) =>
    restored && mine.length === 0 && others.length > 0;
  if (stored === "uncommitted")
    return worktree.kind === "branch" || emptyBesideOthers(worktree.uncommitted, worktree.committed)
      ? "all"
      : "uncommitted";
  if (stored === "committed") return emptyBesideOthers(worktree.committed, worktree.uncommitted) ? "all" : "committed";
  if (stored?.startsWith("commit:") && commits.some((commit) => commit.sha === stored.slice(7)))
    return stored as ChangeScope;
  return "all";
}

const countFiles = (files: readonly FileChange[]): number => countedFiles(files).length;

function FolderRow({ file }: { file: FileChange }) {
  const [open, setOpen] = useState(false);
  const folder = file.folder!;
  const what = folder.repository
    ? "a git repository of its own"
    : folder.partial
      ? "scan limit reached"
      : plural(folder.files, "file");
  return (
    <div data-folder={file.path} className="mb-2 rounded-lg border border-border-seam bg-card text-xs">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Icon name="Folder" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-mono text-[11px] text-foreground">{file.path}</span>
        <span className="min-w-0 flex-1 text-muted-foreground">untracked · {what} · not counted</span>
        {folder.sample.length > 0 && (
          <button type="button" aria-expanded={open} onClick={() => setOpen((shown) => !shown)} className={BUTTON}>
            {open ? "Hide files" : folder.partial ? "Show sample" : "Show files"}
          </button>
        )}
      </div>
      {open && (
        <ul className="border-t border-border-seam px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {folder.sample.map((path) => (
            <li key={path} className="truncate">
              {path}
            </li>
          ))}
          {folder.files > folder.sample.length && (
            <li>and {plural(folder.files - folder.sample.length, "more file")}</li>
          )}
        </ul>
      )}
    </div>
  );
}

// The line under the branch: what the worktree is compared with, and how far ahead and behind it is.
export function baseLine(
  worktree: Pick<Worktree, "base" | "onBase" | "aheadCount" | "behindCount" | "leftOut">,
): string | null {
  if (worktree.base === null) return null;
  if (worktree.onBase) return `on ${worktree.base}, its base branch`;
  const ahead = worktree.leftOut != null ? worktree.leftOut.aheadCount : worktree.aheadCount;
  const parts = [`vs ${worktree.base}`];
  if (ahead !== null) parts.push(`${ahead} ahead`);
  if (worktree.behindCount !== null) parts.push(`${worktree.behindCount} behind`);
  return parts.join(" · ");
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
const noteOf = (part: Part): string =>
  part === "uncommitted" ? "not committed" : part === "committed" ? "committed" : "";

function CommitsMenu({
  commits,
  heading,
  value,
  onPick,
}: {
  commits: readonly Commit[];
  heading: string;
  value: string | null;
  onPick(sha: string): void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const picked = commits.find((commit) => commit.sha === value);
  return (
    <div
      ref={wrap}
      className="relative"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={picked !== undefined}
        onClick={() => setOpen((shown) => !shown)}
        className={`inline-flex h-7 max-w-56 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs ${picked ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}
      >
        <Icon name="GitCommit" fallback="GitBranch" className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          {picked ? `${picked.shortSha} ${picked.subject}` : `Commits ${commits.length}`}
        </span>
        <Icon name="ChevronDown" className="size-3 shrink-0" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-8 z-20 w-80 rounded-lg border border-border-seam bg-card p-1 shadow-lg"
        >
          <p className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">
            {heading}
          </p>
          {commits.map((commit) => (
            <button
              key={commit.sha}
              type="button"
              role="menuitemradio"
              aria-checked={commit.sha === value}
              onClick={() => {
                onPick(commit.sha);
                setOpen(false);
              }}
              className={`flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover ${commit.sha === value ? "bg-surface-selected" : ""}`}
            >
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

function SendBar({
  row,
  comments,
  compact,
  root,
  onDiscard,
  onDone,
  onSent,
  sendRef,
  panel,
}: {
  row: Row;
  comments: readonly Comment[];
  compact: boolean;
  root: string | null;
  onDiscard(): void;
  onDone(sent: readonly Comment[]): void;
  onSent(): void;
  sendRef: { current: (() => void) | null };
  // The side panel names the recipient on the button, and a narrow panel keeps Preview in the menu.
  panel?: { recipient: string; narrow: boolean };
}) {
  const sdk = useSdk();
  const [menu, setMenu] = useState(false);
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const message = composeReview(comments, root);
  const working = isWorking(row.live);
  const archived = row.live.archived;
  const agent = row.live.title;
  const send = (mode: "steer-if-active" | "queue-if-active") => {
    if (archived || sending) return;
    setMenu(false);
    setSending(true);
    // The comments as this message has them; any added or edited while it is on its way stay as drafts.
    const sent = comments;
    sdk.threads.send({ threadId: row.threadId, input: [{ type: "text", text: message, mentions: [] }], mode }).then(
      (result) => {
        setSending(false);
        toast(
          result.delivery === "queued"
            ? `Queued ${plural(comments.length, "comment")}: the agent reads them after its current turn`
            : `Sent ${plural(comments.length, "comment")} to the agent`,
        );
        onDone(sent);
        onSent();
      },
      (error: unknown) => {
        setSending(false);
        toast.error(`Could not send your comments: ${errorMessage(error)}`);
      },
    );
  };
  useLayoutEffect(() => {
    sendRef.current = sending || archived ? null : () => send(working ? "queue-if-active" : "steer-if-active");
    return () => {
      sendRef.current = null;
    };
  });
  const copy = () => {
    setMenu(false);
    experimental_copyToClipboard({ text: message })
      .then((copied) => {
        if (copied) toast("Copied as Markdown");
        else toast.error("Could not copy");
      })
      .catch(() => toast.error("Could not copy"));
  };
  const files = [...new Set(comments.map((comment) => comment.path))];
  if (panel !== undefined)
    return (
      <PanelSendBar
        panel={panel}
        agent={agent}
        comments={comments}
        files={files}
        message={message}
        working={working}
        archived={archived}
        sending={sending}
        menu={menu}
        setMenu={setMenu}
        preview={preview}
        setPreview={setPreview}
        send={send}
        copy={copy}
        onDiscard={onDiscard}
      />
    );
  return (
    <div data-send-bar className="pointer-events-none sticky bottom-0 z-10 px-1 pb-3 pt-1">
      {preview && (
        <div className="pointer-events-auto mb-2 max-h-72 overflow-auto rounded-xl border border-border-seam bg-card p-3 shadow-lg">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Icon name="Sent" fallback="SideChat" className="size-3" aria-hidden />
            Message to {agent}
          </p>
          <pre data-review-preview className="whitespace-pre-wrap font-sans text-xs text-foreground">
            {message}
          </pre>
        </div>
      )}
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-border-seam bg-card px-3 py-2 shadow-lg">
        <Icon name="MessageSquare" fallback="SideChat" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-foreground">
            {plural(comments.length, "comment")} for {agent}
          </span>
          {!compact && <span className="block truncate text-[11px] text-muted-foreground">{files.join(" · ")}</span>}
        </span>
        <button
          type="button"
          onClick={onDiscard}
          className="h-7 cursor-pointer rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover"
        >
          Discard
        </button>
        <button type="button" aria-pressed={preview} onClick={() => setPreview((shown) => !shown)} className={BUTTON}>
          Preview
        </button>
        <div className="relative flex">
          <button
            type="button"
            disabled={sending || archived}
            title={archived ? "This thread is archived" : undefined}
            onClick={() => send(working ? "queue-if-active" : "steer-if-active")}
            className={`${PRIMARY} rounded-r-none`}
          >
            <Icon name="Sent" fallback="SideChat" className="size-3.5" aria-hidden />
            {working ? "Queue for agent" : "Send to agent"}
          </button>
          <button
            type="button"
            aria-label={archived ? "More ways to use this draft" : "More ways to send"}
            aria-expanded={menu}
            disabled={sending}
            onClick={() => setMenu((shown) => !shown)}
            className={`${PRIMARY} rounded-l-none border-l border-primary-foreground/25 px-1.5`}
          >
            <Icon name="ChevronDown" className="size-3.5" aria-hidden />
          </button>
          {menu && (
            <div
              role="menu"
              className="absolute bottom-9 right-0 z-20 w-72 rounded-lg border border-border-seam bg-card p-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                disabled={archived}
                onClick={() => send("steer-if-active")}
                className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover"
              >
                <span className="block text-foreground">Send now</span>
                <span className="block text-[11px] text-muted-foreground">
                  {working ? "Adds your notes to the turn it is running." : "Starts a turn with your notes."}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={archived}
                onClick={() => send("queue-if-active")}
                className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover"
              >
                <span className="block text-foreground">Queue after its current turn</span>
                <span className="block text-[11px] text-muted-foreground">
                  Waits until the agent finishes what it is doing.
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={copy}
                className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover"
              >
                <span className="block text-foreground">Copy as Markdown</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const MENU_ITEM =
  "block w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:bg-state-hover disabled:cursor-default disabled:opacity-50";

// The panel's send bar: the button names the recipient, an archived thread says why it refuses and offers Copy instead,
// and a narrow panel moves Preview into the menu. The menu moves with the arrow keys and Esc hands focus back to its caret.
function PanelSendBar({
  panel,
  agent,
  comments,
  files,
  message,
  working,
  archived,
  sending,
  menu,
  setMenu,
  preview,
  setPreview,
  send,
  copy,
  onDiscard,
}: {
  panel: { recipient: string; narrow: boolean };
  agent: string;
  comments: readonly Comment[];
  files: readonly string[];
  message: string;
  working: boolean;
  archived: boolean;
  sending: boolean;
  menu: boolean;
  setMenu(open: boolean): void;
  preview: boolean;
  setPreview(update: (shown: boolean) => boolean): void;
  send(mode: "steer-if-active" | "queue-if-active"): void;
  copy(): void;
  onDiscard(): void;
}) {
  const caretRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [menu]);
  const togglePreview = () => {
    setMenu(false);
    setPreview((shown) => !shown);
  };
  const items: Array<{ label: string; detail?: string; run(): void }> = archived
    ? [
        { label: "Preview", run: togglePreview },
        { label: "Copy as Markdown", run: copy },
      ]
    : [
        {
          label: "Send now",
          detail: working ? "Adds your notes to the turn it is running." : "Starts a turn with your notes.",
          run: () => send("steer-if-active"),
        },
        {
          label: "Queue after its current turn",
          detail: "Waits until the agent finishes what it is doing.",
          run: () => send("queue-if-active"),
        },
        ...(panel.narrow ? [{ label: "Preview", run: togglePreview }] : []),
        { label: "Copy as Markdown", run: copy },
      ];
  const primaryLabel = working ? `Queue for ${panel.recipient}` : `Send to ${panel.recipient}`;
  return (
    <div data-send-bar className="pointer-events-none sticky bottom-0 z-10 px-1 pb-3 pt-1">
      {preview && (
        <div
          role="region"
          aria-label={`Message to ${panel.recipient}`}
          className="pointer-events-auto mb-2 max-h-72 overflow-auto rounded-xl border border-border-seam bg-card p-3 shadow-lg"
        >
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Icon name="Sent" fallback="SideChat" className="size-3" aria-hidden />
            Message to {agent}
          </p>
          <pre data-review-preview className="whitespace-pre-wrap font-sans text-xs text-foreground">
            {message}
          </pre>
        </div>
      )}
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-border-seam bg-card px-3 py-2 shadow-lg">
        <Icon name="MessageSquare" fallback="SideChat" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 basis-32">
          <span className="block text-xs font-semibold text-foreground">
            {plural(comments.length, "comment")} for {agent}
          </span>
          {archived ? (
            <span role="note" className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Icon name="Archive" className="size-3 shrink-0" aria-hidden />
              Archived threads can't receive comments
            </span>
          ) : (
            !panel.narrow && (
              <span className="block truncate text-[11px] text-muted-foreground">{files.join(" · ")}</span>
            )
          )}
        </span>
        <button
          type="button"
          onClick={onDiscard}
          className="h-7 cursor-pointer rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Discard
        </button>
        {!panel.narrow && !archived && (
          <button type="button" aria-pressed={preview} onClick={togglePreview} className={BUTTON}>
            Preview
          </button>
        )}
        <div
          className="relative flex min-w-0"
          onKeyDown={(event) => {
            if (!menu) return;
            const entries = [
              ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []),
            ];
            const at = entries.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "Escape") {
              setMenu(false);
              caretRef.current?.focus();
            } else if (event.key === "ArrowDown") entries[(at + 1) % entries.length]?.focus();
            else if (event.key === "ArrowUp") entries[(at - 1 + entries.length) % entries.length]?.focus();
            else return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {archived ? (
            <button type="button" onClick={copy} className={`${PRIMARY} rounded-r-none`}>
              Copy as Markdown
            </button>
          ) : (
            <button
              type="button"
              disabled={sending}
              title={primaryLabel}
              onClick={() => send(working ? "queue-if-active" : "steer-if-active")}
              className={`${PRIMARY} min-w-0 max-w-[15rem] rounded-r-none`}
            >
              <Icon name="Sent" fallback="SideChat" className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{primaryLabel}</span>
            </button>
          )}
          <button
            ref={caretRef}
            type="button"
            aria-label={archived ? "More ways to use this draft" : "More ways to send"}
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={sending}
            onClick={() => setMenu(!menu)}
            className={`${PRIMARY} rounded-l-none border-l border-primary-foreground/25 px-1.5`}
          >
            <Icon name="ChevronDown" className="size-3.5" aria-hidden />
          </button>
          {menu && (
            <div
              ref={menuRef}
              role="menu"
              aria-label={archived ? "More ways to use this draft" : "More ways to send"}
              className="absolute bottom-9 right-0 z-20 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border-seam bg-card p-1 shadow-lg"
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={item.run}
                  className={MENU_ITEM}
                >
                  <span className="block text-foreground">{item.label}</span>
                  {item.detail !== undefined && (
                    <span className="block text-[11px] text-muted-foreground">{item.detail}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const FIRST_PATCHES = 2;
const FIRST_PAINT_CARDS = 6;
const NO_DRAFTS: readonly Comment[] = [];

interface CardActions {
  toggleFold(key: string): void;
  toggleReviewed(part: FilePart): void;
  startComment(part: FilePart, quote: string): void;
  saveComment(text: string): void;
  setComposing(value: Composing | null): void;
  removeComment(id: string): void;
  onCompare(path: string): void;
}

const ReviewFileCard = memo(function ReviewFileCard({
  actions,
  part,
  reviewState,
  stale,
  drafts,
  composing,
  own,
  overlapTitle,
  ...card
}: Omit<FileCardProps, "file" | "scope" | "sha" | "readingPart" | "onFold" | "review" | "comments" | "overlap"> & {
  actions: { current: CardActions };
  part: FilePart;
  reviewState: boolean;
  stale: boolean;
  drafts: readonly Comment[];
  composing: Composing | null;
  own: boolean;
  overlapTitle: string | null;
}) {
  const { file } = part;
  return (
    <FileCard
      {...card}
      file={file}
      readingPart={part.part}
      scope={patchScopeOf(part.part)}
      sha={shaOf(part.part)}
      onFold={(key) => actions.current.toggleFold(key)}
      overlap={
        overlapTitle === null ? null : { title: overlapTitle, onCompare: () => actions.current.onCompare(file.path) }
      }
      review={{ reviewed: reviewState, stale, onToggle: () => actions.current.toggleReviewed(part) }}
      comments={{
        list: drafts,
        composing,
        placeholder: `What should ${own ? "this thread" : "the agent"} change in ${file.path.slice(file.path.lastIndexOf("/") + 1)}?`,
        onStart: (quote) => actions.current.startComment(part, quote),
        onSave: (text) => actions.current.saveComment(text),
        onCancel: () => actions.current.setComposing(null),
        onEdit: (comment) =>
          actions.current.setComposing({
            path: comment.path,
            part: comment.part,
            quote: comment.quote,
            text: comment.text,
            editing: comment.id,
          }),
        onRemove: (id) => actions.current.removeComment(id),
      }}
    />
  );
});

export function Review(props: ReviewProps) {
  const {
    overview,
    row,
    index,
    total,
    compact = false,
    visible = true,
    currentThreadId,
    currentHostId,
    terminal,
    marks,
    titleOf,
    branchOf,
    comments: commentStore,
    loaders,
    setReviewed,
    onStep,
    onMessage,
    onCompare,
    onSent,
    onWhole,
    toolbar,
    panelSources,
    onRecorded,
    reader,
  } = props;
  const { worktree } = row;
  const nav = usePanelNav();
  const sharedId = useId();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const view = useShared(diffView);
  const wrap = useShared(diffWrap);
  const hide = useShared(hideReviewed);
  const foldedByDefault = useShared(foldAll);
  const folds = useRemembered(fileFolds);
  const scopes = useRemembered(reviewScopes);
  const [composing, setComposing] = useState<Composing | null>(null);
  const reviewRef = useRef<HTMLElement | null>(null);
  const sendRef = useRef<(() => void) | null>(null);
  const draftKey = reviewDraftKey(worktree.key, row.threadId);
  const drafts = useComments(commentStore, draftKey);
  const threads = useMemo(
    () => new Map<string, ThreadSummary>(overview.threads.map((thread) => [thread.id, thread])),
    [overview.threads],
  );
  const own = currentThreadId !== null && row.threadId === currentThreadId;
  const loading = worktree.state === "loading";
  const unavailable = worktree.state === "unavailable";
  const commitList = worktree.commits.length > 0 ? worktree.commits : worktree.threadCommits;
  const commitHeading =
    worktree.commits.length > 0
      ? `Commits ahead of ${worktree.base ?? "the base branch"}`
      : `Commits its threads made on ${worktree.branch ?? "its branch"}`;
  const [pickedHere, setPickedHere] = useState(false);
  const savedScope = scopeFrom(scopes.get(worktree.key), worktree, commitList, true);
  const streamState = useReadingStream({
    ...reader,
    key: readingKey(reader.keyScope ?? reader.surface, reader.subject),
    fallback: { scope: savedScope },
    ready: !overview.partial && !loading,
  });
  const { reading, streamRef, toggleRef, treeOn, focusMode, toggleFocus, select, updateAnchor } = streamState;
  const scope = scopeFrom(reading.scope, worktree, commitList, !(pickedHere || reading.file !== undefined));
  const setScope = (next: ChangeScope) => {
    setPickedHere(true);
    streamState.setScope(next);
  };

  const commitSha = scope.startsWith("commit:") ? scope.slice(7) : null;
  const [commitState, retryCommit] = useLoaded<CommitFilesOutput>(
    `commitFiles\0${worktree.key}\0${commitSha ?? ""}`,
    commitSha !== null && pickedHere && !loading && !unavailable,
    () => loaders.commitFiles({ ref: worktree.ref, sha: commitSha! }),
  );
  const commitFiles = commitState.status === "ready" ? commitState.value.files : null;
  const allParts = useMemo(
    () => (unavailable ? [] : partsFor(worktree, scope, commitFiles)),
    [unavailable, worktree, scope, commitFiles],
  );
  const { parts, folders } = useMemo(
    () => ({
      parts: allParts.filter((part) => !isFolder(part.file)),
      folders: allParts.filter((part) => isFolder(part.file)),
    }),
    [allParts],
  );
  const cardKey = useCallback((part: FilePart) => `${worktree.key}\0${part.part}\0${part.file.path}`, [worktree.key]);
  const selected = parts.find((part) => part.file.path === reading.file && part.part === reading.part);
  const arrivalReady =
    !overview.partial &&
    !loading &&
    (selected !== undefined || commitSha === null || !pickedHere || commitState.status === "ready");
  const { onArrival } = reader;
  useEffect(() => {
    if (arrivalReady) onArrival?.();
  }, [arrivalReady, onArrival]);
  const focused = selected === undefined ? null : cardKey(selected);
  const reviewedPart = (part: FilePart) => isReviewed(marks, part);
  const shown = useMemo(
    () => (hide ? parts.filter((part) => cardKey(part) === focused || !isReviewed(marks, part)) : parts),
    [cardKey, focused, hide, marks, parts],
  );
  const foldKey = useCallback((part: FilePart) => `review\0${cardKey(part)}`, [cardKey]);
  // Reviewed files fold on their own, and after Collapse all so does every file nobody opened by hand.
  const foldsByDefault = (part: FilePart) => reviewedPart(part) || foldedByDefault;
  const isFolded = useCallback(
    (part: FilePart) => folds.get(foldKey(part)) ?? (isReviewed(marks, part) || foldedByDefault),
    [folds, foldKey, marks, foldedByDefault],
  );
  const resumeAt = reading.anchor ?? (reading.file === undefined ? undefined : reading);
  const resumeIndex =
    resumeAt === undefined
      ? -1
      : shown.findIndex(({ file, part }) => file.path === resumeAt.file && part === resumeAt.part);
  const firstPatches = useMemo(() => {
    const first: FilePart[] = [];
    if (loading) return first;
    for (let i = Math.max(0, resumeIndex); i < shown.length && first.length < FIRST_PATCHES; i++) {
      const part = shown[i]!;
      const { file } = part;
      if (!isFolded(part) && file.status !== "clean" && !file.binary && !file.tooLarge && !isImagePath(file.path))
        first.push(part);
    }
    return first;
  }, [loading, resumeIndex, shown, isFolded]);
  const [prepared, setPrepared] = useState(false);
  const cardsReady =
    prepared || firstPatches.every(({ part, file }) => hasPatch(worktree, file, patchScopeOf(part), shaOf(part)));
  useLayoutEffect(() => {
    if (!visible) return;
    for (const { part, file } of firstPatches) prefetchPatch(worktree, file, patchScopeOf(part), shaOf(part), loaders);
  }, [visible, firstPatches, worktree, loaders]);
  useLayoutEffect(() => {
    if (!visible || cardsReady) return;
    let current = true;
    // The priority queue drains in a microtask. Let it start the reads before the first card can subscribe.
    queueMicrotask(() => {
      if (current) setPrepared(true);
    });
    return () => {
      current = false;
    };
  }, [visible, cardsReady]);
  const [mountRemainingCards, setMountRemainingCards] = useState(false);
  useEffect(() => {
    if (!visible || !cardsReady || mountRemainingCards || shown.length <= FIRST_PAINT_CARDS) return;
    const frame = requestAnimationFrame(() => startTransition(() => setMountRemainingCards(true)));
    return () => cancelAnimationFrame(frame);
  }, [visible, cardsReady, mountRemainingCards, shown.length]);
  const composingMark = composing === null ? null : markId(composing.part as Part, composing.path);
  const forced = useMemo(() => {
    const keys = new Set<string>();
    const anchor = shown[resumeIndex];
    if (anchor !== undefined && !isFolded(anchor)) keys.add(cardKey(anchor));
    if (focusMode && selected !== undefined && !isFolded(selected)) keys.add(cardKey(selected));
    if (composingMark !== null) {
      const composingPart = shown.find(({ part, file }) => markId(part, file.path) === composingMark);
      if (composingPart !== undefined) keys.add(cardKey(composingPart));
    }
    return keys;
  }, [cardKey, composingMark, focusMode, isFolded, resumeIndex, selected, shown]);
  const preferred = useMemo(() => firstPatches.map(cardKey), [firstPatches, cardKey]);
  const lastPatch = firstPatches.at(-1);
  const initialCount = Math.max(
    FIRST_PAINT_CARDS,
    resumeIndex + 1,
    focusMode && selected !== undefined ? shown.indexOf(selected) + 1 : 0,
    lastPatch === undefined ? 0 : shown.indexOf(lastPatch) + 1,
  );
  const mounted = useMemo(
    () =>
      !cardsReady ? [] : mountRemainingCards || shown.length <= initialCount ? shown : shown.slice(0, initialCount),
    [cardsReady, mountRemainingCards, shown, initialCount],
  );
  const cardKeys = useMemo(() => mounted.map(cardKey), [mounted, cardKey]);
  const hasMountedCards = !loading && mounted.length > 0;
  useLayoutEffect(() => {
    if (!prepared && hasMountedCards) setPrepared(true);
  }, [prepared, hasMountedCards]);
  const { admitted, eager, onDiffCommit } = useCardBodies(streamRef, cardKeys, forced, preferred, visible);
  const allFolded = parts.length > 0 && parts.every(isFolded);
  const setFold = (part: FilePart, folded: boolean) =>
    fileFolds.set(foldKey(part), folded === foldsByDefault(part) ? undefined : folded);
  // Kept for the next worktree too. Reviewed files fold on their own, so opening every file here opens them by hand.
  const foldEvery = (folded: boolean) => setFoldAll(folded, folded ? [] : parts.filter(reviewedPart).map(foldKey));
  const reviewedCount = parts.filter(reviewedPart).length;
  const { overlapsByPath, overlapPaths } = useMemo(() => {
    const overlapsByPath = new Map(row.overlaps.map((overlap) => [overlap.path, overlap]));
    return { overlapsByPath, overlapPaths: new Set(overlapsByPath.keys()) };
  }, [row.overlaps]);
  const { draftsByPart, commentCounts } = useMemo(() => {
    const grouped = new Map<string, Comment[]>();
    for (const comment of drafts) {
      const mark = markId(comment.part, comment.path);
      const list = grouped.get(mark);
      if (list === undefined) grouped.set(mark, [comment]);
      else list.push(comment);
    }
    return { draftsByPart: grouped, commentCounts: new Map([...grouped].map(([mark, list]) => [mark, list.length])) };
  }, [drafts]);
  // A path listed twice, uncommitted and committed, says which is which in the tree.
  const pathCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { file } of shown) counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
    return counts;
  }, [shown]);

  const partFor = (key: string) => parts.find((entry) => cardKey(entry) === key);
  const toggleFold = (key: string) => {
    const part = partFor(key);
    if (part !== undefined) setFold(part, !isFolded(part));
  };
  const toggleReviewed = (part: FilePart) => {
    const reviewed = !reviewedPart(part);
    // A ticked file folds away; an unticked one opens, because it needs another look.
    fileFolds.set(foldKey(part), !reviewed && foldedByDefault ? false : undefined);
    setReviewed(worktree.key, [part], reviewed).catch((error: unknown) =>
      toast.error(`Could not save: ${errorMessage(error)}`),
    );
  };
  const jump = (key: string) => {
    const part = partFor(key);
    if (part === undefined) return;
    setFold(part, false);
    select(part.file.path, part.part, true);
  };
  const step = (delta: 1 | -1) => {
    if (shown.length === 0) return;
    const at = shown.findIndex((part) => cardKey(part) === focused);
    const next =
      shown[at === -1 ? (delta > 0 ? 0 : shown.length - 1) : Math.min(shown.length - 1, Math.max(0, at + delta))]!;
    jump(cardKey(next));
  };
  const startComment = (part: FilePart, quote: string) => {
    select(part.file.path, part.part, false);
    setFold(part, false);
    setComposing({ path: part.file.path, part: part.part, quote, text: "", editing: null });
  };
  const saveComment = (text: string) => {
    if (composing === null) return;
    if (composing.editing !== null) commentStore.update(draftKey, composing.editing, text);
    else
      commentStore.add(draftKey, {
        path: composing.path,
        part: composing.part as Part,
        quote: composing.quote,
        text,
      });
    setComposing(null);
  };

  const cardActions: CardActions = {
    toggleFold,
    toggleReviewed,
    startComment,
    saveComment,
    setComposing,
    onCompare,
    removeComment: (id) => commentStore.remove(draftKey, id),
  };
  const actions = useRef(cardActions);
  actions.current = cardActions;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.defaultPrevented || isTyping(event.target)) return;
    const current = parts.find((part) => cardKey(part) === focused);
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      if (event.nativeEvent.isComposing || sendRef.current === null) return;
      sendRef.current();
    } else if (event.metaKey || event.ctrlKey) return;
    else if (event.key === "f" || (event.key === "Escape" && focusMode)) {
      if (event.nativeEvent.isComposing) return;
      if (!event.repeat) toggleFocus("stream");
    } else if (
      event.key === "Escape" &&
      returnToFiles(nav?.treeSlot ?? reviewRef.current, focused, toggleRef.current, event.target)
    ) {
      // Focus returned to the navigator or its toggle.
    } else if (event.key === "j") step(1);
    else if (event.key === "k") step(-1);
    else if (event.key === "v" && current !== undefined) {
      toggleReviewed(current);
      if (!reviewedPart(current)) step(1);
    } else if (event.key === "c" && current !== undefined) startComment(current, "");
    else if (event.key === "x" && parts.length > 0) foldEvery(!allFolded);
    else if (event.key === "w") diffWrap.set(!wrap);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const blocked = terminalBlock(worktree, currentHostId, terminal);
  const startTerminal = () => {
    const title = `${row.live.title} · ${worktree.branch ?? "worktree"}`;
    const { ref } = worktree;
    const opening =
      terminal === "environment" && ref.kind === "workspace"
        ? openEnvironmentTerminal(sdk, navigate, { environmentId: ref.environmentId, title })
        : terminal === "environment" && ref.kind === "checkout"
          ? openHostTerminal(sdk, navigate, { hostId: ref.hostId, path: worktree.root, title })
          : openWorktreeTerminal(sdk, navigate, { threadId: currentThreadId!, path: worktree.root, title });
    opening.then(
      (opened) => {
        if (!opened) toast.error("bb could not show the terminal");
      },
      (error: unknown) => {
        toast.error(`Could not start a terminal: ${errorMessage(error)}`);
      },
    );
  };
  const copy = (text: string) => {
    experimental_copyToClipboard({ text })
      .then((copied) => {
        if (copied) toast("Copied");
        else toast.error("Could not copy");
      })
      .catch(() => toast.error("Could not copy"));
  };
  const retry = () => {
    sdk.threads.retry({ threadId: row.threadId }).then(
      () => toast("Retrying the failed turn"),
      (error: unknown) => toast.error(`Could not retry: ${errorMessage(error)}`),
    );
  };
  const askRebase = (paths: readonly string[], otherKey: string) => {
    const other = titleOf(otherKey);
    const branch = branchOf(otherKey);
    const path = paths[0]!;
    const files =
      paths.length === 1
        ? path
        : `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` and ${plural(paths.length - 5, "more file")}` : ""}`;
    commentStore.add(draftKey, {
      path,
      part: worktree.uncommitted.some((file) => file.path === path) ? "uncommitted" : "committed",
      quote: "",
      text: `${paths.length === 1 ? "This file is" : "These files are"} also changed in "${other}"${branch === null ? "" : ` on ${branch}`}. Commit your work, rebase onto ${branch ?? "that branch"} and resolve the conflicts in ${files}, keeping both changes.`,
    });
  };

  // The checkout can include read-only reviewers as well as contributing threads.
  const alsoHere = worktree.threadIds.filter((id) => id !== row.threadId).map((id) => threads.get(id)?.title ?? id);
  const status = statusLabel(row);
  const answer = row.live.indicator === "waiting-for-input" && !row.live.archived;
  // The side panel draws the file tree in its navigator, under the selected source.
  const hasTree = nav === null && treeOn && !focusMode && parts.length > 0;
  const navTree =
    nav !== null && nav.treeSlot !== null && !focusMode && parts.length > 0 ? (
      <FileTree
        parts={shown}
        worktreeKey={worktree.key}
        cardKey={cardKey}
        noteOf={(part) => ((pathCounts.get(part.file.path) ?? 0) > 1 ? noteOf(part.part) : null)}
        focused={focused}
        marks={marks}
        commentCounts={commentCounts}
        overlapPaths={overlapPaths}
        onJump={(key) => {
          jump(key);
          nav.onFilePicked();
        }}
        onReview={toggleReviewed}
        navigator={{
          tabStop: nav.filesTabStop,
          onFocusItem: nav.onFilesFocus,
          onPresence: nav.onFilesPresent,
          files: nav.files,
        }}
      />
    ) : null;
  const title = own ? `This thread · ${row.live.title}` : row.live.title;
  const strips: ReactNode[] = [];
  if (needsYou(row.live)) {
    strips.push(
      row.live.indicator === "waiting-for-input" ? (
        <Strip
          key="needs"
          tone="attention"
          icon="SideChat"
          actions={
            <button type="button" className={PRIMARY} onClick={onMessage}>
              Answer
            </button>
          }
        >
          <b className="font-semibold">{row.live.sidebar?.indicatorLabel ?? "The agent is waiting for you"}.</b>
        </Strip>
      ) : (
        <Strip
          key="failed"
          tone="destructive"
          icon="AlertTriangle"
          actions={
            <>
              <button type="button" className={BUTTON} onClick={retry}>
                Retry
              </button>
              <button type="button" className={BUTTON} onClick={onMessage}>
                Message agent
              </button>
            </>
          }
        >
          <b className="font-semibold">{row.live.sidebar?.indicatorLabel ?? "The last turn failed"}.</b>
        </Strip>
      ),
    );
  }
  if (unavailable)
    strips.push(
      <Strip key="unavailable" tone="destructive" icon="AlertTriangle">
        {worktree.message ?? "This worktree is unavailable."}
      </Strip>,
    );
  if (worktree.kind === "branch" || row.live.archived) {
    strips.push(
      <Strip key="archived" tone="info" icon="Archive">
        {row.live.archived && <b className="font-semibold">Archived. </b>}
        {worktree.kind === "branch"
          ? "Only committed changes on the kept branch are shown."
          : unavailable
            ? "Checkout evidence is unavailable."
            : "Checkout evidence as of the overview."}
      </Strip>,
    );
  } else if (isWorking(row.live)) {
    strips.push(
      <Strip key="working" tone="info" icon="Clock">
        <b className="font-semibold">Still working.</b> These diffs update as the agent edits.
      </Strip>,
    );
  }
  if (!row.live.archived && row.overlaps.length > 0) {
    // One line for every file it shares, however many: each file also carries a mark in the tree and on its card.
    const byOther = new Map<string, string[]>();
    for (const overlap of row.overlaps)
      for (const otherKey of overlap.otherKeys) byOther.set(otherKey, [...(byOther.get(otherKey) ?? []), overlap.path]);
    const others = [...byOther].sort((a, b) => b[1].length - a[1].length);
    const sentence = others.map(([otherKey, paths], at) =>
      at === 0
        ? `${plural(paths.length, "file")} also changed in ${titleOf(otherKey)}`
        : `${paths.length} in ${titleOf(otherKey)}`,
    );
    const [firstKey, firstPaths] = others[0]!;
    strips.push(
      <Strip
        key="overlaps"
        tone="warning"
        icon="AlertTriangle"
        actions={
          <>
            <button type="button" className={BUTTON} onClick={() => onCompare(row.overlaps[0]!.path)}>
              Compare
            </button>
            {worktree.kind !== "branch" && !compact && (
              <button type="button" className={BUTTON} onClick={() => askRebase(firstPaths, firstKey)}>
                Ask to rebase onto {titleOf(firstKey)}
              </button>
            )}
          </>
        }
      >
        <span title={row.overlaps.map((overlap) => overlap.path).join("\n")}>
          {sentence.join(", and ")}, so merging may conflict.
        </span>
      </Strip>,
    );
  }
  if (worktree.whole === true) {
    strips.push(
      <Strip
        key="whole"
        tone="info"
        icon="GitBranch"
        actions={onWhole && <WholeButton whole={false} label="Count only its work" onWhole={onWhole} />}
      >
        Showing the whole branch against <b className="font-semibold">{worktree.base ?? "its base"}</b>, as you asked.
      </Strip>,
    );
  } else if (worktree.leftOut != null) {
    const { aheadCount, kept } = worktree.leftOut;
    strips.push(
      <Strip
        key="left-out"
        tone="warning"
        icon="GitBranch"
        actions={onWhole && <WholeButton whole label={`Show all ${aheadCount}`} onWhole={onWhole} />}
      >
        This branch is {plural(aheadCount, "commit")} ahead of <b className="font-semibold">{worktree.base}</b>, and{" "}
        {kept === 0 ? "Vantage found none of them made by its threads." : `its threads made ${kept} of them.`}
        {kept === 0
          ? " Showing only the uncommitted files."
          : ` Showing ${kept === 1 ? "that commit" : `those ${kept}`} and the uncommitted files.`}
      </Strip>,
    );
  } else if (worktree.skippedBase != null) {
    const skipped = worktree.skippedBase;
    strips.push(
      <Strip
        key="base"
        tone="info"
        icon="Info"
        actions={onWhole && <WholeButton whole label={`Use ${skipped.name}`} onWhole={onWhole} />}
      >
        Compared with <b className="font-semibold">{worktree.base}</b>, not{" "}
        <b className="font-semibold">{skipped.name}</b>, which would count {plural(skipped.aheadCount, "commit")} this
        branch did not add.
      </Strip>,
    );
  }

  const empty =
    scope === "uncommitted"
      ? worktree.kind === "branch"
        ? "The worktree was removed, so only committed work remains."
        : "Nothing uncommitted."
      : scope === "committed"
        ? worktree.onBase
          ? `Works on ${worktree.base}, its base branch, so nothing counts as committed ahead. Its commits are in the Commits menu.`
          : `No commits ahead of ${worktree.base ?? "the base branch"} yet.`
        : "No changes in this worktree.";

  const header = (
    <div
      data-review-header
      className={`shrink-0 border-b border-border-seam ${compact ? "px-3 pb-2.5 pt-2" : "px-5 pb-3 pt-3.5"}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <StatusGlyph row={row} />
        </span>
        <h2
          className={`min-w-0 truncate font-semibold text-foreground ${compact ? "text-sm" : "text-base"}`}
          title={row.live.title}
        >
          {title}
        </h2>
        {status !== "Idle" && (
          <span
            className={`shrink-0 rounded-full px-2 py-px text-[11px] ${PILL_TONE[status] ?? "bg-state-hover text-muted-foreground"}`}
          >
            {status}
          </span>
        )}
        <span className="flex-1" />
        {!compact && (
          <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
            <button
              type="button"
              aria-label="Previous worktree"
              title="Previous worktree ([)"
              disabled={index <= 0}
              onClick={() => onStep(-1)}
              className={ICON_BUTTON}
            >
              <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
            </button>
            {index >= 0 && (
              <span>
                {index + 1} of {total}
              </span>
            )}
            <button
              type="button"
              aria-label="Next worktree"
              title="Next worktree (])"
              disabled={index < 0 || index >= total - 1}
              onClick={() => onStep(1)}
              className={ICON_BUTTON}
            >
              <Icon name="ChevronRight" className="size-3.5" aria-hidden />
            </button>
          </span>
        )}
      </div>
      <div
        className={`mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground ${compact ? "" : "ml-6"}`}
      >
        <span className="inline-flex items-center gap-1">
          <Icon name="Folder" className="size-3" aria-hidden />
          {worktree.label}
        </span>
        {worktree.branch !== null && (
          <span className="inline-flex min-w-0 items-center gap-1" title={worktree.branch}>
            <Icon name="GitBranch" className="size-3 shrink-0" aria-hidden />
            <span className="max-w-64 truncate font-mono text-[11px] text-foreground">{worktree.branch}</span>
            <button
              type="button"
              aria-label="Copy the branch name"
              onClick={() => copy(worktree.branch!)}
              className={ICON_BUTTON}
            >
              <Icon name="Copy" className="size-3" aria-hidden />
            </button>
          </span>
        )}
        {baseLine(worktree) !== null && (
          <span
            data-base-line
            className={`inline-flex items-center gap-1 ${!worktree.onBase && (worktree.behindCount ?? 0) > 0 ? "text-warning-text" : ""}`}
          >
            <Icon name="GitMerge" className="size-3 shrink-0" aria-hidden />
            {baseLine(worktree)}
          </span>
        )}
        {alsoHere.length > 0 && (
          <span title={alsoHere.join("\n")}>
            also here: {alsoHere.length === 1 ? alsoHere[0] : plural(alsoHere.length, "other thread")}
          </span>
        )}
        <PullRequestChip environmentId={worktree.ref.kind === "workspace" ? worktree.ref.environmentId : null} />
        {worktree.threadIds.length > 1 && <span>Shared checkout · Git changes belong to the checkout</span>}
        {!compact && (
          <span className="inline-flex items-center gap-1">
            <Icon name="Laptop" fallback="Folder" className="size-3" aria-hidden />
            {worktree.hostName}
          </span>
        )}
        {worktree.kind === "checkout" && (
          <span title={worktree.root} className="truncate font-mono text-[11px] text-subtle-foreground">
            in {worktree.root}
          </span>
        )}
      </div>
      <div className={`mt-2.5 flex flex-wrap items-center gap-1.5 ${compact ? "" : "ml-6"}`}>
        {!row.live.archived && !own && (
          <button type="button" className={answer ? PRIMARY : BUTTON} onClick={onMessage}>
            <Icon name="SideChat" className="size-3.5" aria-hidden />
            {answer ? "Answer" : "Message agent"}
          </button>
        )}
        {!own && (
          <button
            type="button"
            className={BUTTON}
            onClick={() =>
              currentThreadId === null
                ? navigate.toThread(row.threadId)
                : navigate.toThread(row.threadId, { split: true })
            }
          >
            <Icon name="PanelRight" className="size-3.5" aria-hidden />
            Open thread
          </button>
        )}
        <button
          type="button"
          className={BUTTON}
          disabled={blocked !== null}
          title={blocked ?? "Open a shell in this worktree"}
          onClick={startTerminal}
        >
          <Icon name="Terminal" className="size-3.5" aria-hidden />
          Terminal
        </button>
        <button type="button" className={BUTTON} onClick={() => copy(worktree.root)} title={worktree.root}>
          <Icon name="Copy" className="size-3.5" aria-hidden />
          Copy path
        </button>
        {!own && row.live.sidebar !== null && (
          <ThreadActionsMenu
            thread={threadTarget(row.live.sidebar)}
            align="end"
            trigger={(triggerProps) => (
              <button
                {...triggerProps}
                aria-label="Thread actions"
                title="bb's thread menu: stop, archive and more"
                className={`${triggerProps.className ?? ""} ${BUTTON} px-1.5`}
              >
                <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
              </button>
            )}
          />
        )}
      </div>
    </div>
  );

  const progress = (reviewedCount > 0 || reviewStarted(row)) && (
    <span
      data-review-progress
      className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground"
    >
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-recessed">
        <span
          className="block h-full rounded-full bg-success"
          style={{ width: `${parts.length === 0 ? 0 : Math.round((reviewedCount / parts.length) * 100)}%` }}
        />
      </span>
      {reviewedCount} of {parts.length} reviewed
    </span>
  );

  let panelChips: ReactNode = null;
  if (nav !== null) {
    const short = nav.sourcesShown;
    const who = own ? "this thread" : row.live.title;
    const Who = own ? "This thread" : row.live.title;
    const byOther = new Map<string, string[]>();
    for (const overlap of row.overlaps)
      for (const otherKey of overlap.otherKeys) byOther.set(otherKey, [...(byOther.get(otherKey) ?? []), overlap.path]);
    const others = [...byOther].sort((a, b) => b[1].length - a[1].length);
    const overlapLabel = `Overlaps · ${plural(row.overlaps.length, "file")} · ${plural(others.length, "thread")}`;
    const inTree = worktree.threadIds.filter((id) => threads.has(id) && !nav.isHelper(id));
    const helperCount = worktree.threadIds.filter((id) => nav.isHelper(id)).length;
    const outside = worktree.threadIds.filter((id) => !threads.has(id)).length;
    const recordedCount = nav.recordedOf(row.threadId) ?? 0;
    const ahead = worktree.leftOut != null ? worktree.leftOut.aheadCount : worktree.aheadCount;
    const behind = worktree.behindCount ?? 0;
    const basis =
      worktree.whole === true
        ? "whole branch"
        : worktree.leftOut != null
          ? `${worktree.leftOut.kept} of ${worktree.leftOut.aheadCount} commits`
          : worktree.skippedBase != null
            ? `vs ${worktree.base}`
            : null;
    const fact = (label: string, value: ReactNode) => (
      <div className="flex min-w-0 items-start gap-2 py-0.5">
        <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
        <dd className="flex min-w-0 flex-1 items-center gap-1">{value}</dd>
      </div>
    );
    panelChips = (
      <div data-thread-chips className="relative flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 px-3 pb-1.5 pt-1">
        {unavailable ? (
          <NotReadChip message={worktree.message} />
        ) : (
          <Popover
            label="Checkout"
            trigger={(triggerProps) => (
              <button type="button" {...triggerProps} className={CHIP} title={worktree.branch ?? worktree.label}>
                <Icon name="GitBranch" className="size-3.5 shrink-0" aria-hidden />
                {/* Beside the navigator or in the narrow panel the chips share one line; the full name is in the title. */}
                <span data-branch-label className={`${short ? "max-w-24" : "max-w-40"} truncate font-mono text-[11px]`}>
                  {worktree.branch ?? worktree.label}
                </span>
                {!worktree.onBase && ahead !== null && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    ↑{ahead} <span className={behind > 0 ? "text-warning-text" : ""}>↓{behind}</span>
                  </span>
                )}
                {basis !== null && <span className="shrink-0 text-muted-foreground">· {basis}</span>}
              </button>
            )}
          >
            <dl className="mb-2">
              {fact("Repository", worktree.label)}
              {worktree.branch !== null &&
                fact(
                  "Branch",
                  <>
                    <span className="min-w-0 truncate font-mono text-[11px]" title={worktree.branch}>
                      {worktree.branch}
                    </span>
                    <button
                      type="button"
                      aria-label="Copy the branch name"
                      onClick={() => copy(worktree.branch!)}
                      className={ICON_BUTTON}
                    >
                      <Icon name="Copy" className="size-3" aria-hidden />
                    </button>
                  </>,
                )}
              {baseLine(worktree) !== null &&
                fact(
                  "Base",
                  <span className={!worktree.onBase && behind > 0 ? "text-warning-text" : ""}>
                    {baseLine(worktree)}
                  </span>,
                )}
              {worktree.kind === "branch"
                ? fact("Checkout", "Removed · kept branch, committed work only")
                : fact(
                    "Path",
                    <span className="min-w-0 truncate font-mono text-[11px]" title={worktree.root}>
                      {worktree.root}
                    </span>,
                  )}
              {fact("Machine", worktree.hostName)}
            </dl>
            {worktree.whole === true && (
              <p className="mb-2">
                Showing the whole branch against <b className="font-semibold">{worktree.base ?? "its base"}</b>, as you
                asked. {onWhole && <WholeButton whole={false} label="Count only its work" onWhole={onWhole} />}
              </p>
            )}
            {worktree.whole !== true && worktree.leftOut != null && (
              <p className="mb-2">
                This branch is {plural(worktree.leftOut.aheadCount, "commit")} ahead of{" "}
                <b className="font-semibold">{worktree.base}</b>, and{" "}
                {worktree.leftOut.kept === 0
                  ? "Vantage found none of them made by its threads. Showing only the uncommitted files."
                  : `its threads made ${worktree.leftOut.kept} of them. Showing ${worktree.leftOut.kept === 1 ? "that commit" : `those ${worktree.leftOut.kept}`} and the uncommitted files.`}{" "}
                {onWhole && <WholeButton whole label={`Show all ${worktree.leftOut.aheadCount}`} onWhole={onWhole} />}
              </p>
            )}
            {worktree.whole !== true && worktree.leftOut == null && worktree.skippedBase != null && (
              <p className="mb-2">
                Compared with <b className="font-semibold">{worktree.base}</b>, not{" "}
                <b className="font-semibold">{worktree.skippedBase.name}</b>, which would count{" "}
                {plural(worktree.skippedBase.aheadCount, "commit")} this branch did not add.{" "}
                {onWhole && <WholeButton whole label={`Use ${worktree.skippedBase.name}`} onWhole={onWhole} />}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className={BUTTON}
                disabled={blocked !== null}
                title={blocked ?? "Open a shell in this worktree"}
                onClick={startTerminal}
              >
                <Icon name="Terminal" className="size-3.5" aria-hidden />
                Terminal
              </button>
              {worktree.kind !== "branch" && (
                <button type="button" className={BUTTON} onClick={() => copy(worktree.root)}>
                  <Icon name="Copy" className="size-3.5" aria-hidden />
                  Copy path
                </button>
              )}
              <PullRequestChip environmentId={worktree.ref.kind === "workspace" ? worktree.ref.environmentId : null} />
            </div>
            {blocked !== null && <p className="mt-1.5 text-muted-foreground">{blocked}.</p>}
          </Popover>
        )}
        {worktree.kind === "branch" && (
          <span className={FLAT_CHIP}>
            <Icon name="Archive" className="size-3.5 shrink-0" aria-hidden />
            Kept branch · committed only
          </span>
        )}
        {!row.live.archived && others.length > 0 && (
          <Popover
            label={overlapLabel}
            trigger={(triggerProps) => (
              <button type="button" {...triggerProps} className={WARN_CHIP} title={overlapLabel}>
                <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
                <span className="truncate">
                  {short ? `Overlaps · ${plural(others.length, "thread")}` : overlapLabel}
                </span>
              </button>
            )}
          >
            {(close) => (
              <>
                <p className="mb-2 text-muted-foreground">
                  Merging may conflict. Each file also carries a mark in the tree and on its card. Rebase requests are
                  on the full page.
                </p>
                <ul aria-label="Threads that changed the same files" className="space-y-0.5">
                  {others.map(([otherKey, paths]) => (
                    <li key={otherKey} className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate" title={paths.join("\n")}>
                        {titleOf(otherKey)}
                      </span>
                      <span
                        className="shrink-0 tabular-nums text-muted-foreground"
                        title={plural(paths.length, "file")}
                      >
                        {paths.length}
                      </span>
                      <button
                        type="button"
                        className={BUTTON}
                        onClick={() => {
                          close();
                          onCompare(paths[0]!);
                        }}
                      >
                        Compare
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Popover>
        )}
        {worktree.threadIds.length > 1 && (
          <Popover
            label={`Shared checkout · ${plural(worktree.threadIds.length, "thread")}`}
            trigger={(triggerProps) => (
              <button
                type="button"
                {...triggerProps}
                aria-label={`Shared checkout: ${plural(worktree.threadIds.length, "thread")}`}
                className={CHIP}
              >
                <Icon name="Users" className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">
                  {short
                    ? `Shared · ${worktree.threadIds.length}`
                    : `Shared checkout · ${plural(worktree.threadIds.length, "thread")}`}
                </span>
              </button>
            )}
          >
            {(close) => (
              <>
                <p className="mb-2 text-muted-foreground">
                  Checkout Git shows every change in this checkout, not only {who}'s. {Who}'s own work is its recorded
                  edits.
                </p>
                {onRecorded !== undefined && recordedCount > 0 && (
                  <button
                    type="button"
                    className={`${BUTTON} mb-2`}
                    onClick={() => {
                      close();
                      onRecorded();
                    }}
                  >
                    <Icon name="Pencil" className="size-3.5" aria-hidden />
                    Recorded edits · only {who} <span className="text-muted-foreground">{recordedCount}</span>
                  </button>
                )}
                {inTree.length > 0 && (
                  <>
                    <h4 className="text-[11px] font-semibold text-muted-foreground">In this tree</h4>
                    <ul className="mb-2">
                      {inTree.map((id) => (
                        <li key={id} className="flex min-w-0 items-center gap-2 py-0.5">
                          <span className="min-w-0 flex-1 truncate">
                            {id === currentThreadId ? "This thread" : threads.get(id)!.title}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground" title="Recorded paths">
                            {nav.recordedOf(id) ?? 0}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {(helperCount > 0 || outside > 0) && (
                  <ul className="mb-2 text-muted-foreground">
                    {helperCount > 0 && <li>{plural(helperCount, "Flare helper")} · no edits</li>}
                    {outside > 0 && <li>{plural(outside, "other thread")} outside this tree use this checkout</li>}
                  </ul>
                )}
                <p id={`${sharedId}-handoff`} className="mb-1.5 text-muted-foreground">
                  The full page opens {who}'s review, not a list of the threads using this checkout.
                </p>
                <button
                  type="button"
                  className={BUTTON}
                  aria-describedby={`${sharedId}-handoff`}
                  onClick={() => {
                    close();
                    nav.openFullScreen();
                  }}
                >
                  Open this review on the full page
                </button>
              </>
            )}
          </Popover>
        )}
        {threads.get(row.threadId)?.recordsIncomplete === true && <IncompleteChip onOpen={nav.showIncomplete} />}
        {!nav.sourcesShown && !focusMode && panelSources}
        {progress}
      </div>
    );
  }

  const uncommittedCount = countFiles(worktree.uncommitted);
  const committedCount = countFiles(worktree.committed);
  const scopeChoices = (
    [
      [
        "all",
        worktree.kind === "branch" ? "Kept branch changes" : "Checkout changes",
        uncommittedCount + committedCount,
      ],
      ["uncommitted", "Not committed", uncommittedCount],
      ["committed", "Committed", committedCount],
    ] as const
  ).filter(([id]) => !(id === "uncommitted" && worktree.kind === "branch"));
  // One select for the scope and its commits, as the design's narrow column needs; the page keeps its tabs outside focus.
  const scopeSelect = (width: string) => (
    <select
      aria-label="Which changes"
      value={scope}
      onChange={(event) => {
        const next = event.currentTarget.value;
        const standard = scopeChoices.find(([id]) => id === next);
        const commit = commitList.find(({ sha }) => `commit:${sha}` === next);
        if (standard !== undefined) setScope(standard[0]);
        else if (commit !== undefined) setScope(`commit:${commit.sha}`);
      }}
      className={`h-7 cursor-pointer truncate rounded-md border border-border-seam bg-card px-1 text-xs focus-visible:ring-1 focus-visible:ring-ring ${width}`}
    >
      {scopeChoices.map(([id, label, count]) => (
        <option key={id} value={id}>
          {loading ? label : `${label} (${count})`}
        </option>
      ))}
      {commitList.length > 0 && (
        <optgroup label={commitHeading}>
          {commitList.map((commit) => (
            <option key={commit.sha} value={`commit:${commit.sha}`}>
              {commit.shortSha} {commit.subject} · {commit.authorName}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
  const bar =
    nav !== null && !focusMode ? (
      <ReviewBar stream={streamState} className="px-3" panel={nav.layout}>
        {scopeSelect("min-w-0 max-w-[min(18rem,100%)]")}
        <span className="flex-1" />
        {(reviewedCount > 0 || reviewStarted(row)) && (
          <button
            type="button"
            aria-label="Hide reviewed files"
            title="Hide reviewed files"
            aria-pressed={hide}
            onClick={() => hideReviewed.set(!hide)}
            className={`${ICON_BUTTON} size-7 ${hide ? "bg-surface-selected text-foreground" : ""}`}
          >
            <Icon name="EyeOff" fallback="Eye" className="size-3.5" aria-hidden />
          </button>
        )}
        <WrapButton />
        {parts.length > 0 && <FoldAllButton allFolded={allFolded} compact onToggle={() => foldEvery(!allFolded)} />}
      </ReviewBar>
    ) : (
      <ReviewBar stream={streamState} className={compact ? "px-3" : "px-5"} panel={nav?.layout}>
        {toolbar}
        {focusMode ? (
          scopeSelect("max-w-36")
        ) : (
          <>
            <div role="group" aria-label="Which changes" className="inline-flex rounded-md bg-surface-recessed p-0.5">
              {scopeChoices.map(([id, label, count]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={scope === id}
                  onClick={() => setScope(id)}
                  className={`inline-flex h-6 cursor-pointer items-center gap-1 rounded px-2 text-xs ${scope === id ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {label}
                  <span className="text-[10.5px] text-subtle-foreground">{loading ? "" : count}</span>
                </button>
              ))}
            </div>
            {commitList.length > 0 && (
              <CommitsMenu
                commits={commitList}
                heading={commitHeading}
                value={commitSha}
                onPick={(sha) => setScope(`commit:${sha}`)}
              />
            )}
          </>
        )}
        <span className="flex-1" />
        {(reviewedCount > 0 || reviewStarted(row)) && (
          <>
            <span
              data-review-progress
              className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground"
            >
              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-recessed">
                <span
                  className="block h-full rounded-full bg-success"
                  style={{ width: `${parts.length === 0 ? 0 : Math.round((reviewedCount / parts.length) * 100)}%` }}
                />
              </span>
              {reviewedCount} of {parts.length} reviewed
            </span>
            <button
              type="button"
              aria-pressed={hide}
              onClick={() => hideReviewed.set(!hide)}
              className={`h-7 cursor-pointer rounded-md px-2 text-xs ${hide ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}
            >
              Hide reviewed
            </button>
          </>
        )}
        <WrapButton />
        {parts.length > 0 && (
          <FoldAllButton allFolded={allFolded} compact={compact} onToggle={() => foldEvery(!allFolded)} />
        )}
        {/* The layout preference is shared with the page, so the narrow panel only follows it in focus mode. */}
        {(currentThreadId === null || focusMode) && <DiffLayout view={view} />}
      </ReviewBar>
    );

  let content: ReactNode;
  if (loading) content = <SkeletonRows count={3} label="Reading this worktree's git status…" />;
  else if (unavailable)
    content = <p className="p-4 text-sm text-muted-foreground">No readable Git changes from this checkout.</p>;
  else if (commitSha !== null && commitState.status === "error") {
    content = (
      <p role="alert" className="p-4 text-xs text-destructive-text">
        Could not load the files of this commit: {commitState.message}
        <button type="button" className="ml-2 cursor-pointer underline" onClick={retryCommit}>
          Retry
        </button>
      </p>
    );
  } else if (commitSha !== null && commitState.status !== "ready")
    content = pickedHere ? (
      <SkeletonRows count={2} label="Loading the files of this commit…" />
    ) : (
      <p className="p-4 text-sm text-muted-foreground">
        The previous scope was this commit. Its files have not been read in this session.{" "}
        <button type="button" className="underline" onClick={() => setPickedHere(true)}>
          Load this commit’s files
        </button>
      </p>
    );
  else if (parts.length === 0 && folders.length === 0)
    content = <p className="p-4 text-sm text-muted-foreground">{empty}</p>;
  else {
    content = (
      <>
        {mounted.map((part, index) => {
          const key = cardKey(part);
          const { file } = part;
          const mark = markId(part.part, file.path);
          const otherKey = overlapsByPath.get(file.path)?.otherKeys[0];
          const folded = isFolded(part);
          const deferBody = !eager.has(key) && !admitted.has(key);
          const prefetch = firstPatches.includes(part) || index === resumeIndex || (focusMode && key === focused);
          return (
            <ReviewFileCard
              key={key}
              cardKey={key}
              repo={worktree}
              part={part}
              actions={actions}
              note={
                scope === "all" && worktree.uncommitted.length > 0 && worktree.committed.length > 0
                  ? noteOf(part.part)
                  : null
              }
              folded={folded}
              prefetch={prefetch}
              deferBody={deferBody}
              onDiffCommit={onDiffCommit}
              readerVisible={visible}
              view={currentThreadId !== null && !focusMode ? "unified" : view}
              wrap={wrap}
              focused={focused === key}
              compact={compact}
              threads={threads}
              loaders={loaders}
              overlapTitle={otherKey === undefined ? null : titleOf(otherKey)}
              reviewState={reviewedPart(part)}
              stale={isStale(marks, part)}
              drafts={draftsByPart.get(mark) ?? NO_DRAFTS}
              composing={composingMark === mark ? composing : null}
              own={own}
            />
          );
        })}
        {shown.length < parts.length && (
          <p className="px-1 pb-3 text-xs text-muted-foreground">
            {plural(parts.length - shown.length, "reviewed file")} hidden.{" "}
            <button type="button" className="cursor-pointer underline" onClick={() => hideReviewed.set(false)}>
              Show {parts.length - shown.length === 1 ? "it" : "them"}
            </button>
          </p>
        )}
        {shown.length === 0 && parts.length > 0 && (
          <p className="px-1 pb-3 text-sm text-muted-foreground">Every file here is reviewed.</p>
        )}
        {folders.map((part) => (
          <FolderRow key={cardKey(part)} file={part.file} />
        ))}
      </>
    );
  }

  const stream = (
    <div
      ref={streamRef}
      data-diff-stream
      tabIndex={-1}
      onScroll={updateAnchor}
      className={`min-h-0 min-w-0 overflow-y-auto pt-3 ${compact ? "px-3" : "px-5"}`}
    >
      {!loading &&
        !overview.partial &&
        reading.file !== undefined &&
        reading.part !== undefined &&
        selected === undefined &&
        (commitSha === null || commitState.status === "ready" || unavailable || !pickedHere) && (
          <section
            data-file-card={reading.file}
            data-reading-part={reading.part}
            data-reading-selected
            data-reading-unavailable={reading.file}
            className="mb-3 rounded-lg border border-border-seam bg-card p-3 text-sm"
          >
            <h3 className="break-all font-mono">{reading.file}</h3>
            <p className="text-muted-foreground">This file is not available from this source in the selected scope.</p>
            <button type="button" onClick={() => streamState.save({ scope })} className="mt-1 underline">
              Clear file selection
            </button>
          </section>
        )}
      {!loading && scope !== reading.scope && (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          The previous scope is no longer available. Choose a scope above to continue.
        </p>
      )}
      {content}
      <DraftInspection store={commentStore} draftKey={worktree.key} root={worktree.root || null} />
      {drafts.length > 0 && (
        <SendBar
          row={row}
          comments={drafts}
          compact={compact}
          root={worktree.root || null}
          onDiscard={() => commentStore.clear(draftKey)}
          onDone={(sent) => commentStore.removeSent(draftKey, sent)}
          onSent={onSent}
          sendRef={sendRef}
          panel={
            nav === null
              ? undefined
              : { recipient: own ? "this thread" : row.live.title, narrow: nav.layout === "sheet" }
          }
        />
      )}
      {drafts.length === 0 && <div className="h-4" />}
    </div>
  );

  return (
    // Focusable, so a click anywhere in the review gives its keys to it rather than to the page around it.
    <section
      ref={reviewRef}
      data-review={worktree.key}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 min-w-0 flex-col outline-none"
    >
      {nav !== null ? (
        !focusMode && panelChips
      ) : (
        // In a narrow review the title and notices scroll in their own band, so a long notice cannot push the diffs to zero height.
        <div
          hidden={focusMode}
          className={focusMode ? undefined : compact ? "max-h-[35%] shrink-0 overflow-y-auto" : "contents"}
        >
          {header}
          {!focusMode && strips.length > 0 && (
            <div className={`flex shrink-0 flex-col gap-1.5 ${compact ? "px-3 pt-2.5" : "px-5 pt-3"}`}>{strips}</div>
          )}
        </div>
      )}
      {focusMode && currentThreadId !== null && <FocusSummary title={title} files={parts.length} />}
      {bar}
      {navTree !== null && createPortal(navTree, nav!.treeSlot!)}
      <div
        className={`grid min-h-0 min-w-0 flex-1 ${hasTree && compact ? "grid-rows-[minmax(0,auto)_minmax(8rem,1fr)]" : hasTree ? "grid-cols-[clamp(10rem,24%,16rem)_minmax(0,1fr)]" : "grid-cols-1"}`}
      >
        {hasTree && (
          <FileTree
            parts={shown}
            stacked={compact}
            worktreeKey={worktree.key}
            cardKey={cardKey}
            noteOf={(part) => ((pathCounts.get(part.file.path) ?? 0) > 1 ? noteOf(part.part) : null)}
            focused={focused}
            marks={marks}
            commentCounts={commentCounts}
            overlapPaths={overlapPaths}
            onJump={jump}
            onReview={toggleReviewed}
          />
        )}
        {stream}
      </div>
    </section>
  );
}
