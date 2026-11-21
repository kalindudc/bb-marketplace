import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  experimental_Diff as Diff,
  experimental_FileLink as FileLink,
  experimental_Icon as Icon,
  experimental_copyToClipboard,
  experimental_ImageLightbox as ImageLightbox,
  type CodeOverflowMode,
  type ExperimentalLiveFileTarget,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ReadingPart } from "./reading-state";
import type {
  FileChange,
  FileSidesOutput,
  ImageOutput,
  PatchOutput,
  PatchRequest,
  PatchScope,
  RecordedEditsInput,
  RecordedEditsOutput,
  Repo,
  ThreadSummary,
} from "./contract";
import type { Comment } from "./comments";
import { dataUrlOf, isImagePath } from "./images";
import { hasLoaded, prefetchLoaded, useLoaded } from "./loaded";
import { useReaderPatchPending } from "./session";

export interface FileLoaders {
  patch(input: PatchRequest, key?: string): Promise<PatchOutput>;
  prioritizePatch?(key: string): () => void;
  fileSides(input: PatchRequest): Promise<FileSidesOutput>;
  image(input: PatchRequest): Promise<ImageOutput>;
  recordedEdits(input: RecordedEditsInput): Promise<RecordedEditsOutput>;
}

// A repository section or a worktree: all a card needs is where its files live.
export type FileRepo = Pick<Repo, "key" | "ref">;
export type DiffView = "unified" | "split";

export interface Composing {
  path: string;
  part: string;
  quote: string;
  text: string;
  editing: string | null;
}

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
  readingPart?: ReadingPart;
  note?: string | null;
  folded: boolean;
  prefetch?: boolean;
  deferBody?: boolean;
  onDiffCommit?(): void;
  readerVisible?: boolean;
  onFold(key: string): void;
  view: DiffView;
  // Long lines wrap instead of scrolling sideways.
  wrap?: boolean;
  focused?: boolean;
  compact?: boolean;
  overlap?: { title: string; onCompare(): void } | null;
  review?: { reviewed: boolean; stale: boolean; onToggle(): void } | null;
  comments?: CardComments | null;
  threads: ReadonlyMap<string, ThreadSummary>;
  loaders: FileLoaders;
}

export const STATUS_LETTER: Record<FileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
  unmerged: "U",
  untracked: "U",
  clean: "·",
};
const STATUS_TITLE: Record<FileChange["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  "type-changed": "Type changed",
  unmerged: "Unmerged",
  untracked: "New, not tracked by git yet",
  clean: "Edited by an agent, no change now",
};
export const STATUS_TONE: Record<FileChange["status"], string> = {
  added: "text-diff-added",
  untracked: "text-diff-added",
  deleted: "text-diff-removed",
  clean: "text-muted-foreground",
  modified: "text-warning-text",
  renamed: "text-warning-text",
  copied: "text-warning-text",
  "type-changed": "text-warning-text",
  unmerged: "text-destructive-text",
};

export const ICON_BUTTON =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";
const SMALL_BUTTON =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function fileTarget(repo: FileRepo | null, file: FileChange): ExperimentalLiveFileTarget | null {
  if (repo === null || file.status === "deleted") return null;
  const { ref } = repo;
  // A workspace read with git lists paths from its repository root, which bb would join to a folder below the root.
  if (ref.kind === "workspace" && ref.root !== undefined && ref.hostId !== undefined)
    return { kind: "host", hostId: ref.hostId, path: `${ref.root}/${file.path}` };
  if (ref.kind === "workspace") return { kind: "workspace", environmentId: ref.environmentId, path: file.path };
  if (ref.kind === "checkout") return { kind: "host", hostId: ref.hostId, path: `${ref.root}/${file.path}` };
  return null;
}

// A changed count or a new edit changes this, so an open card loads a fresh diff instead of showing a stale one.
const signatureOf = (file: FileChange): string =>
  [file.status, file.additions, file.deletions, file.previousPath, file.edits?.count].join(":");

function observeCards(rootMargin: string) {
  const roots = new Map<
    Element | null,
    {
      observer: IntersectionObserver;
      listeners: Map<Element, (intersecting: boolean) => void>;
    }
  >();
  return (node: Element, listener: (intersecting: boolean) => void) => {
    const root = node.closest("[data-diff-stream]");
    let group = roots.get(root);
    if (group === undefined) {
      const listeners = new Map<Element, (intersecting: boolean) => void>();
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
        },
        { root, rootMargin },
      );
      group = { observer, listeners };
      roots.set(root, group);
    }
    const { observer, listeners } = group;
    listeners.set(node, listener);
    observer.observe(node);
    return () => {
      listeners.delete(node);
      if (listeners.size === 0) {
        observer.disconnect();
        roots.delete(root);
      } else observer.unobserve(node);
    };
  };
}

const observeNear = observeCards("600px 0px");
const observeOnScreen = observeCards("0px");

function useCardViewport(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [onScreen, setOnScreen] = useState<boolean | undefined>(() =>
    typeof IntersectionObserver === "undefined" ? true : undefined,
  );
  useEffect(() => {
    if (!enabled || ref.current === null || typeof IntersectionObserver === "undefined") return;
    return observeOnScreen(ref.current, (intersecting) => {
      setOnScreen(intersecting);
      if (intersecting) setNear(true);
    });
  }, [enabled, ref]);
  useEffect(() => {
    if (near || !enabled || ref.current === null) return;
    return observeNear(ref.current, (intersecting) => {
      if (intersecting) setNear(true);
    });
  }, [near, enabled, ref]);
  return { near, onScreen };
}

function Note({
  children,
  tone = "text-muted-foreground",
  loading = false,
}: {
  children: string;
  tone?: string;
  // The reader keeps restoring a saved place until the card it anchors on has its diff.
  loading?: boolean;
}) {
  return (
    <p data-diff-loading={loading || undefined} className={`px-3 py-2 text-xs ${tone}`}>
      {children}
    </p>
  );
}

function Failure({ message, onRetry, recorded = false }: { message: string; onRetry(): void; recorded?: boolean }) {
  return (
    <p role="alert" className="px-3 py-2 text-xs text-destructive-text">
      {recorded ? "Could not load recorded edits" : "Could not load this diff"}: {message}
      <button type="button" className="ml-2 cursor-pointer underline" onClick={onRetry}>
        {recorded ? "Retry recorded edits" : "Retry"}
      </button>
    </p>
  );
}

export function patchRequest(repo: FileRepo, file: FileChange, scope: PatchScope, sha: string | null): PatchRequest {
  return {
    ref: repo.ref,
    path: file.path,
    previousPath: file.previousPath,
    untracked: file.untracked,
    scope,
    ...(sha ? { sha } : {}),
  };
}

// The key every reader of one patch shares, so a card and the overlaps page load it once.
export const patchKey = (repo: FileRepo, file: FileChange, scope: PatchScope, sha: string | null): string =>
  `${repo.key}\0${JSON.stringify(repo.ref)}\0${file.path}\0${scope}\0${sha ?? ""}\0${signatureOf(file)}`;

export const hasPatch = (repo: FileRepo, file: FileChange, scope: PatchScope, sha: string | null): boolean =>
  hasLoaded(`patch\0${patchKey(repo, file, scope, sha)}`);

export function prefetchPatch(
  repo: FileRepo,
  file: FileChange,
  scope: PatchScope,
  sha: string | null,
  loaders: FileLoaders,
) {
  if (repo.ref.kind === "recorded") return;
  const base = patchKey(repo, file, scope, sha);
  prefetchLoaded(`patch\0${base}`, () => {
    const release = loaders.prioritizePatch?.(base);
    return loaders.patch(patchRequest(repo, file, scope, sha), base).finally(release);
  });
}

const LARGE_PATCH_LINES = 2_000;
const LARGE_PATCH_BYTES = 48 * 1024;
const utf8 = new TextEncoder();

function isLargePatch(patch: string): boolean {
  if (
    patch.length > LARGE_PATCH_BYTES ||
    (patch.length * 3 > LARGE_PATCH_BYTES && utf8.encode(patch).length > LARGE_PATCH_BYTES)
  )
    return true;
  let last = -1;
  for (let line = 0; line < LARGE_PATCH_LINES; line++) {
    last = patch.indexOf("\n", last + 1);
    if (last < 0) return false;
  }
  return last < patch.length - 1;
}

function PatchBody({
  repo,
  file,
  scope,
  sha,
  view,
  overflow,
  loaders,
  visible,
  onScreen,
  prefetch,
  onDiffCommit,
}: {
  repo: FileRepo;
  file: FileChange;
  scope: PatchScope;
  sha: string | null;
  view: DiffView;
  overflow: CodeOverflowMode;
  loaders: FileLoaders;
  visible: boolean;
  onScreen: boolean | undefined;
  prefetch: boolean;
  onDiffCommit?: () => void;
}) {
  const image = isImagePath(file.path);
  const skipped = image || file.tooLarge || file.binary;
  const request = patchRequest(repo, file, scope, sha);
  const base = patchKey(repo, file, scope, sha);
  const [state, retry] = useLoaded(`patch\0${base}`, visible && !skipped, () => loaders.patch(request, base));
  const pending = !skipped && (state.status === "idle" || state.status === "loading");
  useReaderPatchPending(prefetch && pending);
  const [showLarge, setShowLarge] = useState<string | null>(null);
  const patch = state.status === "ready" ? state.value.patch : "";
  const large = useMemo(() => isLargePatch(patch), [patch]);
  const show = !large || showLarge === base;
  const hasHunks = state.status === "ready" && !state.value.binary && !state.value.truncated && /^@@ /m.test(patch);
  const largeSides = state.status === "ready" && state.value.largeSides === true;
  const [sides, retrySides] = useLoaded(`sides\0${base}`, show && hasHunks && onScreen === true && !largeSides, () =>
    loaders.fileSides(request),
  );
  const drawsDiff = state.status === "ready" && !skipped && !state.value.binary && patch !== "" && show;
  useEffect(() => {
    if (drawsDiff && (onScreen === true || (onScreen === undefined && prefetch))) onDiffCommit?.();
  }, [drawsDiff, onScreen, prefetch, onDiffCommit]);
  const leadingPatch = pending && (onScreen === true || prefetch);
  useEffect(() => {
    if (leadingPatch) return loaders.prioritizePatch?.(base);
  }, [base, leadingPatch, loaders]);
  const withoutContext = largeSides || (sides.status === "ready" && sides.value.largeSides === true);
  const texts = sides.status === "ready" ? sides.value : null;
  const expectsBothSides = file.status !== "added" && file.status !== "untracked" && file.status !== "deleted";
  // BB's Diff renders hunk expanders only after both complete sides are supplied. It has no load-on-expand callback.
  const full = useMemo(
    () =>
      texts !== null && texts.old !== null && texts.new !== null
        ? {
            old: { path: file.previousPath ?? file.path, content: texts.old },
            new: { path: file.path, content: texts.new },
          }
        : undefined,
    [texts, file.path, file.previousPath],
  );
  if (file.tooLarge) return <Note>Too large to show here</Note>;
  if (image) return <ImageBody repo={repo} file={file} scope={scope} sha={sha} loaders={loaders} visible={visible} />;
  if (file.binary) return <Note>Binary file</Note>;
  if (state.status === "idle" || state.status === "loading") return <Note loading>Loading diff…</Note>;
  if (state.status === "error") return <Failure message={state.message} onRetry={retry} />;
  const { truncated, binary } = state.value;
  if (binary) return <Note>Binary file</Note>;
  if (patch === "") return <Note>No diff to show</Note>;
  if (!show)
    return (
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
        <span className="text-muted-foreground">Large diff. Open it when you’re ready to read it.</span>
        <button
          type="button"
          className={`${SMALL_BUTTON} border border-border-seam hover:bg-state-hover`}
          onClick={() => setShowLarge(base)}
        >
          Show diff
        </button>
      </div>
    );
  return (
    <>
      {hasHunks && withoutContext && <Note>{"Unchanged lines aren't available for large files"}</Note>}
      {hasHunks &&
        !withoutContext &&
        full === undefined &&
        (sides.status === "error" || (sides.status === "ready" && expectsBothSides)) && (
          <div className="px-3 py-1 text-xs text-muted-foreground">
            {sides.status === "error" ? (
              <span role="status">
                Could not load unchanged lines: {sides.message}{" "}
                <button type="button" className="underline" onClick={retrySides}>
                  Retry
                </button>
              </span>
            ) : sides.status === "ready" ? (
              <span role="status">Unchanged lines aren’t available for this diff.</span>
            ) : null}
          </div>
        )}
      <Diff
        patch={patch}
        path={file.path}
        view={view}
        overflow={overflow}
        {...(!hasHunks || withoutContext || full === undefined ? {} : { experimental_fullFileContents: full })}
      />
      {truncated && <Note>The diff was cut because it is very long.</Note>}
    </>
  );
}

function ImageSide({
  label,
  src,
  alt,
  title,
  onOpen,
}: {
  label?: string;
  src: string;
  alt: string;
  title: string;
  onOpen(src: string): void;
}) {
  return (
    <figure className="flex min-w-0 flex-col items-center gap-1">
      {label !== undefined && <figcaption className="text-[11px] text-muted-foreground">{label}</figcaption>}
      <button
        type="button"
        title={title}
        onClick={() => onOpen(src)}
        className="cursor-zoom-in rounded p-1 hover:bg-state-hover"
      >
        <img src={src} alt={alt} className="max-h-96 max-w-full object-contain" loading="lazy" />
      </button>
    </figure>
  );
}

function ImageBody({
  repo,
  file,
  scope,
  sha,
  loaders,
  visible,
}: {
  repo: FileRepo;
  file: FileChange;
  scope: PatchScope;
  sha: string | null;
  loaders: FileLoaders;
  visible: boolean;
}) {
  const base = patchKey(repo, file, scope, sha);
  const [state, retry] = useLoaded(`image\0${base}`, visible, () =>
    loaders.image(patchRequest(repo, file, scope, sha)),
  );
  const [open, setOpen] = useState<string | null>(null);
  if (state.status === "idle" || state.status === "loading") return <Note>Loading image…</Note>;
  if (state.status === "error") return <Failure message={state.message} onRetry={retry} />;
  const { old, new: next, truncated } = state.value;
  const before = old === null ? null : dataUrlOf(file.previousPath ?? file.path, old);
  const after = next === null ? null : dataUrlOf(file.path, next);
  if (before === null && after === null) {
    return <Note>{truncated ? "The image is too large to show here." : "The image is not available."}</Note>;
  }
  const both = before !== null && after !== null;
  return (
    <div data-image-card className="flex flex-wrap items-start justify-center gap-2 p-3">
      {before !== null && (
        <ImageSide
          label={both ? "Before" : undefined}
          src={before}
          alt={`Old ${file.path}`}
          title="View the image full size"
          onOpen={setOpen}
        />
      )}
      {after !== null && (
        <ImageSide
          label={both ? "After" : undefined}
          src={after}
          alt={`New ${file.path}`}
          title="View the image full size"
          onOpen={setOpen}
        />
      )}
      {truncated && (
        <p className="w-full text-center text-[11px] text-subtle-foreground">A side was too large to send.</p>
      )}
      {open !== null && (
        <ImageLightbox imageAlt={file.path} imageSrc={open} isOpen title={file.path} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

const formatTime = (at: number): string =>
  new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function EditsBody({
  file,
  threads,
  loaders,
  view,
  overflow,
  visible,
}: {
  file: FileChange;
  threads: ReadonlyMap<string, ThreadSummary>;
  loaders: FileLoaders;
  view: DiffView;
  overflow: CodeOverflowMode;
  visible: boolean;
}) {
  const edits = file.edits;
  const key = `edits\0${JSON.stringify([edits?.threadIds, edits?.rawPaths, edits?.count])}`;
  const [state, retry] = useLoaded(key, visible && edits !== null, () =>
    loaders.recordedEdits({
      threadIds: edits!.threadIds.slice(0, 200),
      rawPaths: edits!.rawPaths.slice(0, 20),
    }),
  );
  if (edits === null) return <Note>No recorded edits for this file.</Note>;
  if (state.status === "idle" || state.status === "loading") return <Note loading>Loading the agents' edits…</Note>;
  if (state.status === "error") return <Failure message={state.message} onRetry={retry} recorded />;
  if (state.value.edits.length === 0) return <Note>No diff was recorded for this file.</Note>;
  return (
    <>
      {state.value.edits.map((edit, index) => (
        <div key={`${edit.threadId}:${edit.at}:${index}`}>
          <p className="px-3 pt-2 text-xs text-muted-foreground">
            {threads.get(edit.threadId)?.title ?? edit.threadId} · {formatTime(edit.at)}
          </p>
          {edit.diff === null ? (
            <Note>No diff recorded for this edit.</Note>
          ) : (
            <Diff patch={edit.diff} path={file.path} view={view} overflow={overflow} />
          )}
          {edit.truncated && <Note>The diff was cut because it is very long.</Note>}
        </div>
      ))}
    </>
  );
}

// The navigator lifts the diff colours toward the foreground, so the counts read on its tinted rows in every theme.
const NAVIGATOR_TONES = {
  added: "text-[color:var(--vantage-nav-added)]",
  removed: "text-[color:var(--vantage-nav-removed)]",
  warning: "text-[color:var(--vantage-nav-warning)]",
  destructive: "text-[color:var(--vantage-nav-destructive)]",
  muted: "text-[color:var(--vantage-nav-muted)]",
};
const NAVIGATOR_STATUS_TONE: Record<FileChange["status"], string> = {
  added: NAVIGATOR_TONES.added,
  untracked: NAVIGATOR_TONES.added,
  deleted: NAVIGATOR_TONES.removed,
  clean: NAVIGATOR_TONES.muted,
  modified: NAVIGATOR_TONES.warning,
  renamed: NAVIGATOR_TONES.warning,
  copied: NAVIGATOR_TONES.warning,
  "type-changed": NAVIGATOR_TONES.warning,
  unmerged: NAVIGATOR_TONES.destructive,
};

export function Counts({ file, navigator = false }: { file: FileChange; navigator?: boolean }) {
  if (file.status === "clean") return <span className="shrink-0 text-xs text-muted-foreground">unchanged</span>;
  if (file.tooLarge) return <span className="shrink-0 text-xs text-muted-foreground">too large</span>;
  if (file.binary)
    return (
      <span className="shrink-0 text-xs text-muted-foreground">{isImagePath(file.path) ? "image" : "binary"}</span>
    );
  if (file.additions === null && file.deletions === null)
    return <span className="shrink-0 text-xs text-muted-foreground">line count unavailable</span>;
  if (navigator)
    return (
      <span data-counts className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums">
        <span className={NAVIGATOR_TONES.added}>+{file.additions ?? 0}</span>{" "}
        <span className={NAVIGATOR_TONES.removed}>−{file.deletions ?? 0}</span>
      </span>
    );
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-xs">
      <span className="text-diff-added">+{file.additions ?? 0}</span>{" "}
      <span className="text-diff-removed">−{file.deletions ?? 0}</span>
    </span>
  );
}

export function StatusLetter({ file, navigator = false }: { file: FileChange; navigator?: boolean }) {
  return (
    <span
      title={STATUS_TITLE[file.status]}
      className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${(navigator ? NAVIGATOR_STATUS_TONE : STATUS_TONE)[file.status]}`}
    >
      {STATUS_LETTER[file.status]}
    </span>
  );
}

// bb's diff draws its lines inside a shadow root, and `contains` does not look past one.
export function containsAcrossShadow(root: Node, node: Node | null): boolean {
  for (
    let current: Node | null = node;
    current !== null;
    current = current instanceof ShadowRoot ? current.host : current.parentNode
  ) {
    if (current === root) return true;
  }
  return false;
}

function quoteFrom(card: HTMLElement | null): string {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (card === null || selection === null || selection.isCollapsed || !containsAcrossShadow(card, selection.anchorNode))
    return "";
  return selection.toString().replace(/\n+$/, "").split("\n").slice(0, 12).join("\n");
}

function CommentBox({
  composing,
  placeholder,
  onSave,
  onCancel,
}: {
  composing: Composing;
  placeholder: string;
  onSave(text: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState(composing.text);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const save = () => {
    if (text.trim() !== "") onSave(text.trim());
  };
  return (
    <div data-comment-box className="mx-3 mb-3 mt-2 rounded-lg border border-ring bg-card">
      {composing.quote !== "" && (
        <pre className="mx-2.5 mt-2 overflow-hidden whitespace-pre-wrap rounded-r border-l-2 border-ring bg-surface-recessed px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {composing.quote}
        </pre>
      )}
      <textarea
        ref={ref}
        aria-label="Comment"
        value={text}
        placeholder={placeholder}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        className="block w-full resize-none bg-transparent px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-subtle-foreground"
      />
      <div className="flex items-center gap-1.5 px-2 pb-2 text-[11px] text-subtle-foreground">
        <span className="min-w-0 flex-1 truncate">
          {composing.quote === "" ? "Select lines in the diff first to quote them" : "Quoting your selection"}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className={`${SMALL_BUTTON} text-muted-foreground hover:bg-state-hover`}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={text.trim() === ""}
          onClick={save}
          className={`${SMALL_BUTTON} bg-primary text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-50`}
        >
          {composing.editing === null ? "Add comment" : "Save"}
        </button>
      </div>
    </div>
  );
}

export function CopyPath({ path }: { path: string }) {
  return (
    <button
      type="button"
      aria-label="Copy path"
      title="Copy path"
      className={ICON_BUTTON}
      onClick={() => {
        void experimental_copyToClipboard({ text: path }).then(
          (ok) => (ok ? toast("Copied path") : toast.error("Could not copy path")),
          () => toast.error("Could not copy path"),
        );
      }}
    >
      <Icon name="Copy" className="size-3.5" aria-hidden />
    </button>
  );
}

function FileCardView(props: FileCardProps) {
  const {
    repo,
    file,
    scope,
    sha = null,
    cardKey,
    readingPart,
    note,
    folded,
    onFold,
    view,
    wrap = false,
    focused = false,
    compact = false,
    overlap,
    review,
    comments,
    threads,
    loaders,
  } = props;
  const overflow: CodeOverflowMode = wrap ? "wrap" : "scroll";
  const ref = useRef<HTMLElement | null>(null);
  const readerVisible = props.readerVisible !== false;
  const composing = comments?.composing ?? null;
  const bodyMounted = props.deferBody !== true || composing !== null;
  const { near, onScreen } = useCardViewport(ref, readerVisible && !folded && bodyMounted);
  const prefetch = readerVisible && props.prefetch === true;
  // Let the viewport observer classify nearby patches before they can join the queue.
  const visible = prefetch || (readerVisible && near && onScreen !== undefined);
  const slash = file.path.lastIndexOf("/");
  const target = fileTarget(repo, file);
  const recordedOnly = repo === null || repo.ref.kind === "recorded" || file.status === "clean";
  const editors = file.edits?.threadIds.map((id) => threads.get(id)?.title ?? id).join(", ");
  return (
    <section
      ref={ref}
      data-file-card={file.path}
      data-card-key={cardKey}
      data-body-deferred={!folded && !bodyMounted ? "" : undefined}
      data-reading-part={readingPart}
      data-reading-selected={focused || undefined}
      aria-label={file.path}
      style={{
        contentVisibility: "auto",
        containIntrinsicBlockSize: folded ? "auto 36px" : "auto 68px",
        minBlockSize: !folded && !bodyMounted ? 68 : undefined,
      }}
      className={`mb-3 rounded-lg border bg-card ${focused ? "border-ring" : "border-border-seam"}`}
    >
      <header
        className={`sticky top-0 z-[1] flex h-9 items-center gap-1.5 rounded-t-lg bg-card pl-1.5 pr-1.5 ${folded ? "rounded-b-lg" : "border-b border-border-seam"}`}
      >
        <button
          type="button"
          aria-expanded={!folded}
          aria-label={folded ? `Show ${file.path}` : `Hide ${file.path}`}
          onClick={() => onFold(cardKey)}
          className={ICON_BUTTON}
        >
          <Icon name={folded ? "ChevronRight" : "ChevronDown"} className="size-3.5" aria-hidden />
        </button>
        {readingPart !== "recorded" && <StatusLetter file={file} />}
        <button
          type="button"
          onClick={() => onFold(cardKey)}
          title={
            readingPart === "recorded" || file.previousPath === null ? file.path : `Renamed from ${file.previousPath}`
          }
          className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-xs"
        >
          <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
          <span className="text-foreground">{file.path.slice(slash + 1)}</span>
        </button>
        {note != null && !compact && (
          <span className="shrink-0 whitespace-nowrap text-[11px] text-subtle-foreground">{note}</span>
        )}
        {editors !== undefined && (
          <span title={`Edited by ${editors}`} className="shrink-0 text-subtle-foreground">
            <Icon name="EditFile" className="size-3.5" aria-hidden />
          </span>
        )}
        {overlap != null && (
          <button
            type="button"
            onClick={overlap.onCompare}
            title={`Also changed in ${overlap.title}; the branches may conflict when merged`}
            className={`${SMALL_BUTTON} max-w-40 bg-warning/10 text-warning-text hover:bg-warning/20`}
          >
            <Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />
            {!compact && <span className="truncate">Also in {overlap.title}</span>}
          </button>
        )}
        {readingPart === "recorded" ? <CopyPath path={file.path} /> : <Counts file={file} />}
        {comments != null && (
          <button
            type="button"
            aria-label={`Comment on ${file.path}`}
            title="Comment on this file (C). Select lines first to quote them."
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => comments.onStart(quoteFrom(ref.current))}
            className={ICON_BUTTON}
          >
            <Icon name="MessageSquarePlus" fallback="SideChat" className="size-3.5" aria-hidden />
          </button>
        )}
        {target !== null && !compact && (
          <FileLink target={target} title="Open the file" aria-label={`Open ${file.path}`} className={ICON_BUTTON}>
            <Icon name="ExternalLink" className="size-3.5" aria-hidden />
          </FileLink>
        )}
        {review != null && (
          <button
            type="button"
            aria-pressed={review.reviewed}
            onClick={review.onToggle}
            title={
              review.stale ? "Changed since you reviewed it" : review.reviewed ? "Reviewed (V)" : "Mark as reviewed (V)"
            }
            className={`${SMALL_BUTTON} border ${review.reviewed ? "border-transparent bg-success/15 text-success" : review.stale ? "border-warning/40 text-warning-text hover:bg-state-hover" : "border-border-seam text-muted-foreground hover:bg-state-hover"}`}
          >
            <Icon name={review.reviewed ? "Check" : "Square"} className="size-3.5" aria-hidden />
            {!compact && (review.stale ? "Changed" : "Reviewed")}
          </button>
        )}
      </header>
      {!folded && bodyMounted && (
        <div className="overflow-hidden rounded-b-lg" data-card-body>
          {recordedOnly || repo === null ? (
            <EditsBody
              file={file}
              threads={threads}
              loaders={loaders}
              view={view}
              overflow={overflow}
              visible={visible}
            />
          ) : (
            <PatchBody
              repo={repo}
              file={file}
              scope={scope}
              sha={sha}
              view={view}
              overflow={overflow}
              loaders={loaders}
              visible={visible}
              onScreen={readerVisible ? onScreen : false}
              prefetch={prefetch}
              {...(props.onDiffCommit === undefined ? {} : { onDiffCommit: props.onDiffCommit })}
            />
          )}
        </div>
      )}
      {comments?.list
        .filter((comment) => comment.id !== composing?.editing)
        .map((comment) => (
          <div
            key={comment.id}
            data-comment
            className="mx-3 my-2 rounded-lg border-l-[3px] border-ring bg-surface-recessed px-2.5 py-2 text-sm"
          >
            <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Icon name="MessageSquare" fallback="SideChat" className="size-3" aria-hidden />
              <b className="font-semibold text-foreground">You</b> · draft, not sent
              <span className="flex-1" />
              <button
                type="button"
                aria-label="Edit comment"
                onClick={() => comments.onEdit(comment)}
                className={ICON_BUTTON}
              >
                <Icon name="Edit" fallback="EditFile" className="size-3" aria-hidden />
              </button>
              <button
                type="button"
                aria-label="Remove comment"
                onClick={() => comments.onRemove(comment.id)}
                className={ICON_BUTTON}
              >
                <Icon name="Trash2" fallback="X" className="size-3" aria-hidden />
              </button>
            </div>
            <p className="whitespace-pre-wrap text-foreground">{comment.text}</p>
            {comment.quote !== "" && (
              <pre className="mt-1.5 whitespace-pre-wrap border-l-2 border-border-seam pl-2 font-mono text-[11px] text-muted-foreground">
                {comment.quote}
              </pre>
            )}
          </div>
        ))}
      {comments != null && composing !== null && (
        <CommentBox
          key={composing.editing ?? "new"}
          composing={composing}
          placeholder={comments.placeholder}
          onSave={comments.onSave}
          onCancel={comments.onCancel}
        />
      )}
    </section>
  );
}

export const FileCard = memo(FileCardView);
