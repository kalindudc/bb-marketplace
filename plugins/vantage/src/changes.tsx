import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { FileChange, Overview, Repo, Scope, ThreadSummary } from "./contract";
import { isArchivedOnly } from "./archived";
import { FileCard, type FileLoaders } from "./file-card";
import { filterRepos, focusRepos, type RepoFocus } from "./filters";
import { plural } from "./model";
import { FoldAllButton, isTyping } from "./review";
import { EditsSkeleton, Skeleton, SkeletonRows } from "./skeleton";
import { useShared } from "./session";
import { diffView } from "./ui-prefs";

export interface AllChangesProps {
  overview: Overview;
  scope: Scope;
  onScope(scope: Scope): void;
  focus: RepoFocus | null;
  onClearFocus(): void;
  text: string;
  compact?: boolean;
  loaders: FileLoaders;
  onOpenThread(threadId: string): void;
}

const KIND_ICON = { workspace: "FolderGit", checkout: "Folder", branch: "Archive", recorded: "EditFile" } as const;

function caption(repo: Repo): string {
  switch (repo.ref.kind) {
    case "workspace": return "Thread workspace";
    case "checkout": return repo.ref.worked === true ? "Thread checkout" : "Edited by path";
    case "branch": return repo.aheadCount === null ? "Archived branch" : `Archived branch · ${plural(repo.aheadCount, "commit")}`;
    case "recorded": return "Recorded edits only";
  }
}

function RepoBlock({ repo, scope, threads, folds, onFold, compact, loaders, onOpenThread }: {
  repo: Repo; scope: Scope; threads: ReadonlyMap<string, ThreadSummary>; folds: ReadonlyMap<string, boolean>; onFold(key: string): void;
  compact: boolean; loaders: FileLoaders; onOpenThread(threadId: string): void;
}) {
  const [showOthers, setShowOthers] = useState(false);
  const view = useShared(diffView);
  const card = (file: FileChange) => {
    const key = `${repo.key}\0${scope}\0${file.path}`;
    return (
      <FileCard key={key} cardKey={key} repo={repo} file={file} scope={scope} folded={folds.get(key) ?? false} onFold={onFold}
        view={compact ? "unified" : view} compact={compact} threads={threads} loaders={loaders} />
    );
  };
  return (
    <section data-repo={repo.key} className="mb-4">
      <div className="flex min-w-0 items-center gap-1.5 pb-1">
        <Icon name={KIND_ICON[repo.ref.kind]} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="whitespace-nowrap text-sm font-semibold text-foreground">{repo.label}</span>
        {repo.branch !== null && (
          <span className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground">
            <Icon name="GitBranch" className="size-3 shrink-0" aria-hidden /><span className="truncate">{repo.branch}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 gap-2 whitespace-nowrap pl-2 font-mono text-xs">
          {repo.state === "loading"
            ? <Skeleton className="h-3 w-20" />
            : <><span className="text-muted-foreground">{plural(repo.totals.files, "file")}</span><span className="text-diff-added">+{repo.totals.additions}</span><span className="text-diff-removed">−{repo.totals.deletions}</span></>}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{caption(repo)}</span>
        {repo.threadCommits.length > 0 && (
          <span title={repo.threadCommits.map((commit) => `${commit.shortSha} ${commit.subject}`).join("\n")}>
            {plural(repo.threadCommits.length, "commit")} by its threads{repo.branch === null ? "" : ` on ${repo.branch}`}
          </span>
        )}
        {repo.threadIds.map((id) => {
          const thread = threads.get(id);
          return (
            <button key={id} type="button" title={`Open ${thread?.title ?? id}`} onClick={() => onOpenThread(id)}
              className="inline-flex max-w-56 cursor-pointer items-center gap-1 rounded-full border border-border-seam px-2 py-px text-xs hover:border-ring hover:text-foreground">
              {thread?.archived === true && <Icon name="Archive" className="size-3 shrink-0" aria-label="Archived" />}
              <span className="truncate">{thread?.title ?? id}</span>
            </button>
          );
        })}
      </div>
      {repo.state === "unavailable" && <p role="alert" className="rounded-lg bg-surface-recessed px-3 py-2 text-xs text-destructive-text">{repo.message ?? "This repository is unavailable."}</p>}
      {repo.state === "loading" && <SkeletonRows count={2} label="Reading this repository's changes…" />}
      {repo.state === "ready" && (
        <>
          {repo.files.length === 0 && repo.otherFiles.length === 0 && <p className="py-1 text-xs text-muted-foreground">No changes right now.</p>}
          {repo.files.map(card)}
          {repo.truncated && <p className="py-1 text-xs text-muted-foreground">Showing the first {repo.files.length} files</p>}
          {repo.otherFiles.length > 0 && (
            <>
              <button type="button" aria-expanded={showOthers} onClick={() => setShowOthers(!showOthers)}
                className="mb-2 inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <Icon name={showOthers ? "ChevronDown" : "ChevronRight"} className="size-3" aria-hidden />
                {plural(repo.otherFiles.length, "other change")} in this repository, not made by these agents
              </button>
              {showOthers && repo.otherFiles.map(card)}
            </>
          )}
        </>
      )}
    </section>
  );
}

export function AllChanges({ overview, scope, onScope, focus, onClearFocus, text, compact = false, loaders, onOpenThread }: AllChangesProps) {
  const threads = useMemo(() => new Map(overview.threads.map((thread) => [thread.id, thread])), [overview.threads]);
  const filtered = useMemo(() => filterRepos(overview, { text, projectId: null, changedOnly: true }), [overview, text]);
  const shown = useMemo(() => focusRepos(filtered, focus), [filtered, focus]);
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const onFold = useCallback((key: string) => setFolds((current) => new Map(current).set(key, !(current.get(key) ?? false))), []);
  const allKeys = [
    ...shown.repos.flatMap((repo) => repo.files.map((file) => `${repo.key}\0${scope}\0${file.path}`)),
    ...shown.otherFiles.map((file) => `other\0${scope}\0${file.path}`),
  ];
  const allFolded = allKeys.length > 0 && allKeys.every((key) => folds.get(key) === true);
  const foldAll = () => setFolds(new Map(allKeys.map((key) => [key, !allFolded])));
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "x" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || isTyping(event.target) || allKeys.length === 0) return;
    event.preventDefault();
    foldAll();
  };
  const active = shown.repos.filter((repo) => !isArchivedOnly(repo, threads));
  const archived = shown.repos.filter((repo) => isArchivedOnly(repo, threads));
  const files = shown.repos.reduce((total, repo) => total + repo.totals.files, 0) + shown.otherFiles.length;
  const label = focus === null ? null : focus.kind === "otherFiles" ? "Other files" : overview.repos.find((repo) => repo.key === focus.key)?.label ?? "one repository";
  const view = useShared(diffView);
  return (
    <section data-all-changes tabIndex={-1} onKeyDown={onKeyDown} className={`outline-none ${compact ? "px-3 pb-4" : "mx-auto w-full max-w-5xl px-5 pb-6"}`}>
      <div className="sticky top-0 z-[2] -mx-1 mb-3 flex flex-wrap items-center gap-2 bg-surface-recessed px-1 py-2">
        <div role="group" aria-label="Which changes" className="inline-flex rounded-md bg-card p-0.5">
          {([["uncommitted", "Not committed"], ["branch", "Since the base branch"]] as const).map(([id, name]) => (
            <button key={id} type="button" aria-pressed={scope === id} onClick={() => onScope(id)}
              className={`h-6 cursor-pointer rounded px-2 text-xs ${scope === id ? "bg-surface-selected font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{name}</button>
          ))}
        </div>
        {label !== null && (
          <span data-repo-focus className="inline-flex items-center gap-1 rounded-full border border-border-seam py-px pl-2 pr-0.5 text-xs text-foreground">
            Only {label}
            <button type="button" aria-label="Show every repository" onClick={onClearFocus} className="inline-flex size-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-state-hover">
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          </span>
        )}
        <span className="text-xs text-muted-foreground">{overview.partial ? "" : `${plural(shown.repos.length, "repository")} · ${plural(files, "file")}`}</span>
        <span className="flex-1" />
        {allKeys.length > 0 && <FoldAllButton allFolded={allFolded} compact={compact} onToggle={foldAll} />}
      </div>
      {shown.repos.length === 0 && shown.otherFiles.length === 0 && !overview.partial && (
        <p className="py-2 text-sm text-muted-foreground">{text.trim() === "" ? "No changes in these threads yet." : "No changes match the filter."}</p>
      )}
      {active.map((repo) => (
        <RepoBlock key={repo.key} repo={repo} scope={scope} threads={threads} folds={folds} onFold={onFold} compact={compact} loaders={loaders} onOpenThread={onOpenThread} />
      ))}
      {archived.length > 0 && <h3 className="pb-2 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">Archived</h3>}
      {archived.map((repo) => (
        <RepoBlock key={repo.key} repo={repo} scope={scope} threads={threads} folds={folds} onFold={onFold} compact={compact} loaders={loaders} onOpenThread={onOpenThread} />
      ))}
      {overview.partial && <EditsSkeleton />}
      {shown.otherFiles.length > 0 && (
        <section data-other-files>
          <h3 className="pb-1 text-sm font-semibold text-foreground">Other files</h3>
          <p className="pb-2 text-xs text-muted-foreground">Edits outside any repository, from the agents' recorded edits.</p>
          {shown.otherFiles.map((file) => {
            const key = `other\0${scope}\0${file.path}`;
            return (
              <FileCard key={key} cardKey={key} repo={null} file={file} scope={scope} folded={folds.get(key) ?? false} onFold={onFold}
                view={compact ? "unified" : view} compact={compact} threads={threads} loaders={loaders} />
            );
          })}
        </section>
      )}
    </section>
  );
}
