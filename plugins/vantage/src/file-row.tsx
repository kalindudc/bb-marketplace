import { memo, useEffect, useState } from "react";
import {
  experimental_Diff as Diff, experimental_FileLink as FileLink, experimental_Icon as Icon,
  type ExperimentalLiveFileTarget,
} from "@get-bb/plugin-sdk/app";
import type {
  FileChange, PatchOutput, PatchRequest, PatchScope, RecordedEditsInput, RecordedEditsOutput, Repo, Scope, ThreadSummary,
} from "./contract";

export interface FileLoaders {
  patch(input: PatchRequest): Promise<PatchOutput>;
  recordedEdits(input: RecordedEditsInput): Promise<RecordedEditsOutput>;
}

// A repository section or a worktree: all a row needs is where its files live.
export type FileRepo = Pick<Repo, "key" | "ref">;

export interface FileRowProps {
  repo: FileRepo | null;
  file: FileChange;
  scope: Scope;
  /** Which patch to load when it is not the row's `scope`: a worktree's committed files, or one commit's. */
  patchScope?: PatchScope;
  sha?: string | null;
  /** Titles of the other threads whose worktrees also changed this file. */
  sharedWith?: readonly string[] | null;
  threads: ReadonlyMap<string, ThreadSummary>;
  expanded: boolean;
  onToggle(key: string): void;
  loaders: FileLoaders;
}

const MAX_CACHED = 100;
const resolved = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

export function clearFileCache(): void {
  resolved.clear();
  inflight.clear();
}

function load<T>(key: string, run: () => Promise<T>): Promise<T> {
  let pending = inflight.get(key) as Promise<T> | undefined;
  if (pending === undefined) {
    pending = run().then((value) => {
      resolved.set(key, value);
      if (resolved.size > MAX_CACHED) resolved.delete(resolved.keys().next().value!);
      return value;
    }).finally(() => { inflight.delete(key); });
    inflight.set(key, pending);
  }
  return pending;
}

type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: T };

export function useLoaded<T>(key: string, enabled: boolean, run: () => Promise<T>): [Loaded<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Loaded<T>>(() => resolved.has(key) ? { status: "ready", value: resolved.get(key) as T } : { status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    if (resolved.has(key)) {
      setState({ status: "ready", value: resolved.get(key) as T });
      return;
    }
    let current = true;
    setState({ status: "loading" });
    load(key, run).then(
      (value) => { if (current) setState({ status: "ready", value }); },
      (error: unknown) => { if (current) setState({ status: "error", message: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { current = false; };
    // `run` only closes over what `key` already describes.
  }, [key, enabled, attempt]);
  return [state, () => setAttempt((count) => count + 1)];
}

export function fileKey(repo: FileRepo | null, path: string, scope: PatchScope, sha?: string | null): string {
  return `${repo?.key ?? ""}\0${path}\0${scope}${sha ? `\0${sha}` : ""}`;
}

export function fileTarget(repo: FileRepo | null, file: FileChange): ExperimentalLiveFileTarget | null {
  if (repo === null || file.status === "deleted") return null;
  const { ref } = repo;
  if (ref.kind === "workspace") return { kind: "workspace", environmentId: ref.environmentId, path: file.path };
  if (ref.kind === "checkout") return { kind: "host", hostId: ref.hostId, path: `${ref.root}/${file.path}` };
  return null;
}

const LETTER: Record<FileChange["status"], string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", "type-changed": "T", unmerged: "U", untracked: "?", clean: "·",
};
const TITLE: Record<FileChange["status"], string> = {
  added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", copied: "Copied", "type-changed": "Type changed",
  unmerged: "Unmerged", untracked: "Untracked", clean: "Edited by an agent, no change now",
};
const TONE: Record<FileChange["status"], string> = {
  added: "text-diff-added", untracked: "text-diff-added", deleted: "text-diff-removed", clean: "text-muted-foreground",
  modified: "text-warning-text", renamed: "text-warning-text", copied: "text-warning-text", "type-changed": "text-warning-text",
  unmerged: "text-warning-text",
};

const formatTime = (at: number): string =>
  new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Note({ children, tone = "text-muted-foreground" }: { children: string; tone?: string }) {
  return <p className={`px-2 py-2 text-xs ${tone}`}>{children}</p>;
}

function Failure({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <p role="alert" className="px-2 py-2 text-xs text-destructive-text">
      Could not load this diff: {message}
      <button type="button" className="ml-2 underline" onClick={onRetry}>Retry</button>
    </p>
  );
}

// A changed count or a new edit changes this, so an open row loads a fresh diff instead of showing a stale one.
const signature = (file: FileChange): string =>
  [file.status, file.additions, file.deletions, file.previousPath, file.edits?.count].join(":");

function PatchBody({ repo, file, scope, sha, loaders }: Pick<FileRowProps, "file" | "sha" | "loaders"> & { repo: FileRepo; scope: PatchScope }) {
  const skipped = file.tooLarge || file.binary;
  const key = `patch\0${fileKey(repo, file.path, scope, sha)}\0${signature(file)}`;
  const [state, retry] = useLoaded(key, !skipped, () => loaders.patch({
    ref: repo.ref, path: file.path, previousPath: file.previousPath, untracked: file.untracked, scope, ...(sha ? { sha } : {}),
  }));
  if (file.tooLarge) return <Note>Too large to show here</Note>;
  if (file.binary) return <Note>Binary file</Note>;
  if (state.status === "loading") return <Note>Loading diff…</Note>;
  if (state.status === "error") return <Failure message={state.message} onRetry={retry} />;
  const { patch, truncated, binary } = state.value;
  if (binary) return <Note>Binary file</Note>;
  if (patch === "") return <Note>No diff to show</Note>;
  return (
    <>
      <Diff patch={patch} path={file.path} />
      {truncated && <Note>The diff was cut because it is very long.</Note>}
    </>
  );
}

function EditsBody({ file, threads, loaders }: Pick<FileRowProps, "file" | "threads" | "loaders">) {
  const edits = file.edits;
  const key = `edits\0${edits?.threadIds.join(",")}\0${edits?.rawPaths.join(",")}\0${edits?.count}`;
  const [state, retry] = useLoaded(key, edits !== null, () => loaders.recordedEdits({
    threadIds: edits!.threadIds.slice(0, 200), rawPaths: edits!.rawPaths.slice(0, 20),
  }));
  if (edits === null) return <Note>No recorded edits for this file.</Note>;
  if (state.status === "loading") return <Note>Loading the agents' edits…</Note>;
  if (state.status === "error") return <Failure message={state.message} onRetry={retry} />;
  if (state.value.edits.length === 0) return <Note>No diff was recorded for this file.</Note>;
  return (
    <>
      {state.value.edits.map((edit, index) => (
        <div key={`${edit.threadId}:${edit.at}:${index}`}>
          <p className="px-2 pt-2 text-xs text-muted-foreground">
            {threads.get(edit.threadId)?.title ?? edit.threadId} · {formatTime(edit.at)}
          </p>
          {edit.diff === null ? <Note>No diff recorded for this edit.</Note> : <Diff patch={edit.diff} path={file.path} />}
          {edit.truncated && <Note>The diff was cut because it is very long.</Note>}
        </div>
      ))}
    </>
  );
}

function Counts({ file }: { file: FileChange }) {
  if (file.status === "clean") return <span className="shrink-0 text-xs text-muted-foreground">unchanged</span>;
  if (file.tooLarge) return <span className="shrink-0 text-xs text-muted-foreground">too large</span>;
  if (file.binary) return <span className="shrink-0 text-xs text-muted-foreground">binary</span>;
  if (file.additions === null && file.deletions === null) return null;
  return (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-diff-added">+{file.additions ?? 0}</span>{" "}
      <span className="text-diff-removed">−{file.deletions ?? 0}</span>
    </span>
  );
}

function SharedBadge({ titles }: { titles: readonly string[] }) {
  const text = `also in ${titles.join(", ")}`;
  return (
    <span title={`Also changed in ${titles.join(", ")}; the branches may conflict when merged`}
      className="inline-flex min-w-0 max-w-40 shrink items-center gap-1 text-xs text-warning-text">
      <Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  );
}

function FileRowView({ repo, file, scope, patchScope, sha, sharedWith, threads, expanded, onToggle, loaders }: FileRowProps) {
  const effectiveScope = patchScope ?? scope;
  const key = fileKey(repo, file.path, effectiveScope, sha);
  const slash = file.path.lastIndexOf("/");
  const directory = file.path.slice(0, slash + 1);
  const name = file.path.slice(slash + 1);
  const target = fileTarget(repo, file);
  const editors = file.edits?.threadIds.map((id) => threads.get(id)?.title ?? id).join(", ");
  const recordedOnly = repo === null || repo.ref.kind === "recorded" || file.status === "clean";
  return (
    <div data-file-row={file.path}>
      <div className="flex items-center gap-1 pr-3 hover:bg-state-hover">
        <button type="button" aria-expanded={expanded} onClick={() => onToggle(key)}
          title={file.previousPath === null ? file.path : `Renamed from ${file.previousPath}`}
          className="flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 py-0.5 pl-8 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <span title={TITLE[file.status]} className={`w-3 shrink-0 text-center font-mono font-bold ${TONE[file.status]}`}>{LETTER[file.status]}</span>
          <span className="min-w-0 flex-1 truncate font-mono">
            <span className="text-muted-foreground">{directory}</span>
            <span className="text-foreground">{name}</span>
          </span>
          {editors !== undefined && (
            <span title={`Edited by ${editors}`} className="shrink-0 text-subtle-foreground">
              <Icon name="EditFile" className="size-3.5" aria-hidden />
            </span>
          )}
          {sharedWith != null && sharedWith.length > 0 && <SharedBadge titles={sharedWith} />}
          <Counts file={file} />
        </button>
        {target !== null && (
          <FileLink target={target} title="Open file" aria-label={`Open ${file.path}`}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-subtle-foreground hover:bg-state-hover hover:text-foreground">
            ↗
          </FileLink>
        )}
      </div>
      {expanded && (
        <div className="mb-2 ml-8 mr-3 overflow-auto rounded border border-border-seam bg-surface-recessed">
          {recordedOnly || repo === null
            ? <EditsBody file={file} threads={threads} loaders={loaders} />
            : <PatchBody repo={repo} file={file} scope={effectiveScope} sha={sha} loaders={loaders} />}
        </div>
      )}
    </div>
  );
}

export const FileRow = memo(FileRowView);
