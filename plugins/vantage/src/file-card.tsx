import { memo, useEffect, useRef, useState, type RefObject } from "react";
import {
  experimental_Diff as Diff, experimental_FileLink as FileLink, experimental_Icon as Icon, type ExperimentalLiveFileTarget,
} from "@get-bb/plugin-sdk/app";
import type {
  FileChange, FileSidesOutput, PatchOutput, PatchRequest, PatchScope, RecordedEditsInput, RecordedEditsOutput, Repo, ThreadSummary,
} from "./contract";
import type { Comment } from "./comments";
import { useLoaded } from "./loaded";

export interface FileLoaders {
  patch(input: PatchRequest): Promise<PatchOutput>;
  fileSides(input: PatchRequest): Promise<FileSidesOutput>;
  recordedEdits(input: RecordedEditsInput): Promise<RecordedEditsOutput>;
}

// A repository section or a worktree: all a card needs is where its files live.
export type FileRepo = Pick<Repo, "key" | "ref">;
export type DiffView = "unified" | "split";

export interface Composing { path: string; part: string; quote: string; text: string; editing: string | null }

export interface CardComments {
  list: readonly Comment[];
  composing: Composing | null;
  placeholder: string;
  onStart(quote: string): void;
  onSave(text: string): void;
  onCancel(): void;
  onEdit(comment: Comment): void;
  onRemove(id: string): void;
}

export interface FileCardProps {
  repo: FileRepo | null;
  file: FileChange;
  scope: PatchScope;
  sha?: string | null;
  cardKey: string;
  note?: string | null;
  folded: boolean;
  onFold(key: string): void;
  view: DiffView;
  focused?: boolean;
  compact?: boolean;
  overlap?: { title: string; onCompare(): void } | null;
  review?: { reviewed: boolean; stale: boolean; onToggle(): void } | null;
  comments?: CardComments | null;
  threads: ReadonlyMap<string, ThreadSummary>;
  loaders: FileLoaders;
}

export const STATUS_LETTER: Record<FileChange["status"], string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", "type-changed": "T", unmerged: "U", untracked: "U", clean: "·",
};
const STATUS_TITLE: Record<FileChange["status"], string> = {
  added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", copied: "Copied", "type-changed": "Type changed",
  unmerged: "Unmerged", untracked: "New, not tracked by git yet", clean: "Edited by an agent, no change now",
};
export const STATUS_TONE: Record<FileChange["status"], string> = {
  added: "text-diff-added", untracked: "text-diff-added", deleted: "text-diff-removed", clean: "text-muted-foreground",
  modified: "text-warning-text", renamed: "text-warning-text", copied: "text-warning-text", "type-changed": "text-warning-text",
  unmerged: "text-destructive-text",
};

export const ICON_BUTTON = "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";
const SMALL_BUTTON = "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function fileTarget(repo: FileRepo | null, file: FileChange): ExperimentalLiveFileTarget | null {
  if (repo === null || file.status === "deleted") return null;
  const { ref } = repo;
  // A workspace read with git lists paths from its repository root, which bb would join to a folder below the root.
  if (ref.kind === "workspace" && ref.root !== undefined && ref.hostId !== undefined) return { kind: "host", hostId: ref.hostId, path: `${ref.root}/${file.path}` };
  if (ref.kind === "workspace") return { kind: "workspace", environmentId: ref.environmentId, path: file.path };
  if (ref.kind === "checkout") return { kind: "host", hostId: ref.hostId, path: `${ref.root}/${file.path}` };
  return null;
}

// A changed count or a new edit changes this, so an open card loads a fresh diff instead of showing a stale one.
const signatureOf = (file: FileChange): string => [file.status, file.additions, file.deletions, file.previousPath, file.edits?.count].join(":");

// jsdom and old engines have no IntersectionObserver; there every card loads at once.
function useNearViewport(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !enabled || ref.current === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: "600px 0px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near, enabled, ref]);
  return near;
}

function Note({ children, tone = "text-muted-foreground" }: { children: string; tone?: string }) {
  return <p className={`px-3 py-2 text-xs ${tone}`}>{children}</p>;
}

function Failure({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <p role="alert" className="px-3 py-2 text-xs text-destructive-text">
      Could not load this diff: {message}
      <button type="button" className="ml-2 cursor-pointer underline" onClick={onRetry}>Retry</button>
    </p>
  );
}

export function patchRequest(repo: FileRepo, file: FileChange, scope: PatchScope, sha: string | null): PatchRequest {
  return { ref: repo.ref, path: file.path, previousPath: file.previousPath, untracked: file.untracked, scope, ...(sha ? { sha } : {}) };
}

// The key every reader of one patch shares, so a card and the overlaps page load it once.
export const patchKey = (repo: FileRepo, file: FileChange, scope: PatchScope, sha: string | null): string =>
  `${repo.key}\0${file.path}\0${scope}\0${sha ?? ""}\0${signatureOf(file)}`;

function PatchBody({ repo, file, scope, sha, view, loaders, visible }: {
  repo: FileRepo; file: FileChange; scope: PatchScope; sha: string | null; view: DiffView; loaders: FileLoaders; visible: boolean;
}) {
  const skipped = file.tooLarge || file.binary;
  const request = patchRequest(repo, file, scope, sha);
  const base = patchKey(repo, file, scope, sha);
  const [state, retry] = useLoaded(`patch\0${base}`, visible && !skipped, () => loaders.patch(request));
  const hasHunks = state.status === "ready" && state.value.patch !== "" && !state.value.binary && !state.value.truncated;
  const [sides] = useLoaded(`sides\0${base}`, visible && hasHunks, () => loaders.fileSides(request));
  if (file.tooLarge) return <Note>Too large to show here</Note>;
  if (file.binary) return <Note>Binary file</Note>;
  if (state.status === "idle" || state.status === "loading") return <Note>Loading diff…</Note>;
  if (state.status === "error") return <Failure message={state.message} onRetry={retry} />;
  const { patch, truncated, binary } = state.value;
  if (binary) return <Note>Binary file</Note>;
  if (patch === "") return <Note>No diff to show</Note>;
  const full = sides.status === "ready" && sides.value.old !== null && sides.value.new !== null
    ? { old: { path: file.previousPath ?? file.path, content: sides.value.old }, new: { path: file.path, content: sides.value.new } }
    : undefined;
  return (
    <>
      <Diff patch={patch} path={file.path} view={view} {...(full === undefined ? {} : { experimental_fullFileContents: full })} />
      {truncated && <Note>The diff was cut because it is very long.</Note>}
    </>
  );
}

const formatTime = (at: number): string => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function EditsBody({ file, threads, loaders, view, visible }: { file: FileChange; threads: ReadonlyMap<string, ThreadSummary>; loaders: FileLoaders; view: DiffView; visible: boolean }) {
  const edits = file.edits;
  const key = `edits\0${edits?.threadIds.join(",")}\0${edits?.rawPaths.join(",")}\0${edits?.count}`;
  const [state, retry] = useLoaded(key, visible && edits !== null, () => loaders.recordedEdits({
    threadIds: edits!.threadIds.slice(0, 200), rawPaths: edits!.rawPaths.slice(0, 20),
  }));
  if (edits === null) return <Note>No recorded edits for this file.</Note>;
  if (state.status === "idle" || state.status === "loading") return <Note>Loading the agents' edits…</Note>;
  if (state.status === "error") return <Failure message={state.message} onRetry={retry} />;
  if (state.value.edits.length === 0) return <Note>No diff was recorded for this file.</Note>;
  return (
    <>
      {state.value.edits.map((edit, index) => (
        <div key={`${edit.threadId}:${edit.at}:${index}`}>
          <p className="px-3 pt-2 text-xs text-muted-foreground">{threads.get(edit.threadId)?.title ?? edit.threadId} · {formatTime(edit.at)}</p>
          {edit.diff === null ? <Note>No diff recorded for this edit.</Note> : <Diff patch={edit.diff} path={file.path} view={view} />}
          {edit.truncated && <Note>The diff was cut because it is very long.</Note>}
        </div>
      ))}
    </>
  );
}

export function Counts({ file }: { file: FileChange }) {
  if (file.status === "clean") return <span className="shrink-0 text-xs text-muted-foreground">unchanged</span>;
  if (file.tooLarge) return <span className="shrink-0 text-xs text-muted-foreground">too large</span>;
  if (file.binary) return <span className="shrink-0 text-xs text-muted-foreground">binary</span>;
  if (file.additions === null && file.deletions === null) return null;
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-xs">
      <span className="text-diff-added">+{file.additions ?? 0}</span> <span className="text-diff-removed">−{file.deletions ?? 0}</span>
    </span>
  );
}

export function StatusLetter({ file }: { file: FileChange }) {
  return <span title={STATUS_TITLE[file.status]} className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${STATUS_TONE[file.status]}`}>{STATUS_LETTER[file.status]}</span>;
}

// bb's diff draws its lines inside a shadow root, and `contains` does not look past one.
export function containsAcrossShadow(root: Node, node: Node | null): boolean {
  for (let current: Node | null = node; current !== null; current = current instanceof ShadowRoot ? current.host : current.parentNode) {
    if (current === root) return true;
  }
  return false;
}

function quoteFrom(card: HTMLElement | null): string {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (card === null || selection === null || selection.isCollapsed || !containsAcrossShadow(card, selection.anchorNode)) return "";
  return selection.toString().replace(/\n+$/, "").split("\n").slice(0, 12).join("\n");
}

function CommentBox({ composing, placeholder, onSave, onCancel }: { composing: Composing; placeholder: string; onSave(text: string): void; onCancel(): void }) {
  const [text, setText] = useState(composing.text);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const save = () => { if (text.trim() !== "") onSave(text.trim()); };
  return (
    <div data-comment-box className="mx-3 mb-3 mt-2 rounded-lg border border-ring bg-card">
      {composing.quote !== "" && (
        <pre className="mx-2.5 mt-2 overflow-hidden whitespace-pre-wrap rounded-r border-l-2 border-ring bg-surface-recessed px-2 py-1 font-mono text-[11px] text-muted-foreground">{composing.quote}</pre>
      )}
      <textarea ref={ref} aria-label="Comment" value={text} placeholder={placeholder} rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
        }}
        className="block w-full resize-none bg-transparent px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-subtle-foreground" />
      <div className="flex items-center gap-1.5 px-2 pb-2 text-[11px] text-subtle-foreground">
        <span className="min-w-0 flex-1 truncate">{composing.quote === "" ? "Select lines in the diff first to quote them" : "Quoting your selection"}</span>
        <button type="button" onClick={onCancel} className={`${SMALL_BUTTON} text-muted-foreground hover:bg-state-hover`}>Cancel</button>
        <button type="button" disabled={text.trim() === ""} onClick={save}
          className={`${SMALL_BUTTON} bg-primary text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-50`}>
          {composing.editing === null ? "Add comment" : "Save"}
        </button>
      </div>
    </div>
  );
}

function FileCardView(props: FileCardProps) {
  const { repo, file, scope, sha = null, cardKey, note, folded, onFold, view, focused = false, compact = false, overlap, review, comments, threads, loaders } = props;
  const ref = useRef<HTMLElement | null>(null);
  const visible = useNearViewport(ref, !folded);
  const slash = file.path.lastIndexOf("/");
  const target = fileTarget(repo, file);
  const recordedOnly = repo === null || repo.ref.kind === "recorded" || file.status === "clean";
  const editors = file.edits?.threadIds.map((id) => threads.get(id)?.title ?? id).join(", ");
  const composing = comments?.composing ?? null;
  return (
    <section ref={ref} data-file-card={file.path} data-card-key={cardKey} aria-label={file.path}
      className={`mb-3 rounded-lg border bg-card ${focused ? "border-ring" : "border-border-seam"}`}>
      <header className={`sticky top-0 z-[1] flex h-9 items-center gap-1.5 rounded-t-lg bg-card pl-1.5 pr-1.5 ${folded ? "rounded-b-lg" : "border-b border-border-seam"}`}>
        <button type="button" aria-expanded={!folded} aria-label={folded ? `Show ${file.path}` : `Hide ${file.path}`} onClick={() => onFold(cardKey)} className={ICON_BUTTON}>
          <Icon name={folded ? "ChevronRight" : "ChevronDown"} className="size-3.5" aria-hidden />
        </button>
        <StatusLetter file={file} />
        <button type="button" onClick={() => onFold(cardKey)} title={file.previousPath === null ? file.path : `Renamed from ${file.previousPath}`}
          className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-xs">
          <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
          <span className="text-foreground">{file.path.slice(slash + 1)}</span>
        </button>
        {note != null && !compact && <span className="shrink-0 whitespace-nowrap text-[11px] text-subtle-foreground">{note}</span>}
        {editors !== undefined && (
          <span title={`Edited by ${editors}`} className="shrink-0 text-subtle-foreground"><Icon name="EditFile" className="size-3.5" aria-hidden /></span>
        )}
        {overlap != null && (
          <button type="button" onClick={overlap.onCompare} title={`Also changed in ${overlap.title}; the branches may conflict when merged`}
            className={`${SMALL_BUTTON} max-w-40 bg-warning/10 text-warning-text hover:bg-warning/20`}>
            <Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />
            {!compact && <span className="truncate">Also in {overlap.title}</span>}
          </button>
        )}
        <Counts file={file} />
        {comments != null && (
          <button type="button" aria-label={`Comment on ${file.path}`} title="Comment on this file (C). Select lines first to quote them."
            onMouseDown={(event) => event.preventDefault()} onClick={() => comments.onStart(quoteFrom(ref.current))} className={ICON_BUTTON}>
            <Icon name="MessageSquarePlus" fallback="SideChat" className="size-3.5" aria-hidden />
          </button>
        )}
        {target !== null && !compact && (
          <FileLink target={target} title="Open the file" aria-label={`Open ${file.path}`} className={ICON_BUTTON}>
            <Icon name="ExternalLink" className="size-3.5" aria-hidden />
          </FileLink>
        )}
        {review != null && (
          <button type="button" aria-pressed={review.reviewed} onClick={review.onToggle}
            title={review.stale ? "Changed since you reviewed it" : review.reviewed ? "Reviewed (V)" : "Mark as reviewed (V)"}
            className={`${SMALL_BUTTON} border ${review.reviewed ? "border-transparent bg-success/15 text-success" : review.stale ? "border-warning/40 text-warning-text hover:bg-state-hover" : "border-border-seam text-muted-foreground hover:bg-state-hover"}`}>
            <Icon name={review.reviewed ? "Check" : "Square"} className="size-3.5" aria-hidden />
            {!compact && (review.stale ? "Changed" : "Reviewed")}
          </button>
        )}
      </header>
      {!folded && (
        <div className="overflow-hidden rounded-b-lg">
          {recordedOnly || repo === null
            ? <EditsBody file={file} threads={threads} loaders={loaders} view={view} visible={visible} />
            : <PatchBody repo={repo} file={file} scope={scope} sha={sha} view={view} loaders={loaders} visible={visible} />}
        </div>
      )}
      {comments?.list.filter((comment) => comment.id !== composing?.editing).map((comment) => (
        <div key={comment.id} data-comment className="mx-3 my-2 rounded-lg border-l-[3px] border-ring bg-surface-recessed px-2.5 py-2 text-sm">
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Icon name="MessageSquare" fallback="SideChat" className="size-3" aria-hidden />
            <b className="font-semibold text-foreground">You</b> · draft, not sent
            <span className="flex-1" />
            <button type="button" aria-label="Edit comment" onClick={() => comments.onEdit(comment)} className={ICON_BUTTON}><Icon name="Edit" fallback="EditFile" className="size-3" aria-hidden /></button>
            <button type="button" aria-label="Remove comment" onClick={() => comments.onRemove(comment.id)} className={ICON_BUTTON}><Icon name="Trash2" fallback="X" className="size-3" aria-hidden /></button>
          </div>
          <p className="whitespace-pre-wrap text-foreground">{comment.text}</p>
          {comment.quote !== "" && <pre className="mt-1.5 whitespace-pre-wrap border-l-2 border-border-seam pl-2 font-mono text-[11px] text-muted-foreground">{comment.quote}</pre>}
        </div>
      ))}
      {comments != null && composing !== null && (
        <CommentBox key={composing.editing ?? "new"} composing={composing} placeholder={comments.placeholder} onSave={comments.onSave} onCancel={comments.onCancel} />
      )}
    </section>
  );
}

export const FileCard = memo(FileCardView);
