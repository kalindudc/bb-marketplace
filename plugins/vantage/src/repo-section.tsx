import { memo, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Repo, Scope, ThreadSummary } from "./contract";
import { FileRow, fileKey, type FileLoaders } from "./file-row";
import { Skeleton, SkeletonRows } from "./skeleton";

export interface RepoSectionProps {
  repo: Repo;
  scope: Scope;
  threads: ReadonlyMap<string, ThreadSummary>;
  expanded: boolean;
  expandedFiles: ReadonlySet<string>;
  onToggleRepo(key: string): void;
  onToggleFile(key: string): void;
  onOpenThread(threadId: string): void;
  loaders: FileLoaders;
  showHost?: boolean;
}

const KIND_ICON = { workspace: "FolderGit", checkout: "Folder", branch: "Archive", recorded: "EditFile" } as const;

function caption(repo: Repo): string {
  switch (repo.ref.kind) {
    case "workspace": return "Thread workspace";
    case "checkout": return "Edited by path";
    case "branch": return repo.aheadCount === null ? "Archived branch" : `Archived branch · ${repo.aheadCount} ${repo.aheadCount === 1 ? "commit" : "commits"}`;
    case "recorded": return "Recorded edits only";
  }
}

function RepoSectionView({
  repo, scope, threads, expanded, expandedFiles, onToggleRepo, onToggleFile, onOpenThread, loaders, showHost = false,
}: RepoSectionProps) {
  const [showOthers, setShowOthers] = useState(false);
  const { totals } = repo;
  return (
    <section data-repo={repo.key} className="border-b border-border-seam">
      <button type="button" aria-expanded={expanded} onClick={() => onToggleRepo(repo.key)} title={repo.root ?? undefined}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 py-2 pl-3.5 pr-3 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
        <Icon name={KIND_ICON[repo.ref.kind]} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="whitespace-nowrap text-sm font-semibold text-foreground">{repo.label}</span>
        {repo.branch !== null && (
          <span className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground">
            <Icon name="GitBranch" className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{repo.branch}</span>
          </span>
        )}
        {repo.state === "loading" && (
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-14" />
          </span>
        )}
        {repo.state === "ready" && (
          <span className="ml-auto flex shrink-0 gap-2 whitespace-nowrap pl-2 font-mono text-xs">
            <span className="text-muted-foreground">{totals.files} {totals.files === 1 ? "file" : "files"}</span>
            <span className="text-diff-added">+{totals.additions}</span>
            <span className="text-diff-removed">−{totals.deletions}</span>
          </span>
        )}
      </button>
      <div className="mb-1 ml-8 mr-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="text-foreground/85">{caption(repo)}</span>
        {showHost && repo.hostName !== null && <span>{repo.hostName}</span>}
        {repo.threadIds.map((id) => {
          const thread = threads.get(id);
          return (
            <button key={id} type="button" title={`Open ${thread?.title ?? id}`} onClick={() => onOpenThread(id)}
              className={`inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border border-border-seam px-2 py-px text-xs hover:border-ring hover:text-foreground ${thread?.archived === true ? "opacity-75" : ""}`}>
              {thread?.archived === true && <Icon name="Archive" className="size-3 shrink-0" aria-label="Archived" />}
              <span className="truncate">{thread?.title ?? id}</span>
            </button>
          );
        })}
      </div>
      {expanded && repo.state === "unavailable" && (
        <p role="alert" className="mb-2 ml-8 mr-3 rounded bg-surface-recessed px-2 py-2 text-xs text-destructive-text">
          {repo.message ?? "This repository is unavailable."}
        </p>
      )}
      {expanded && repo.state === "loading" && <SkeletonRows count={3} label="Reading this repository's changes…" />}
      {expanded && repo.state === "ready" && (
        <div className="pb-1">
          {repo.files.length === 0 && repo.otherFiles.length === 0 && (
            <p className="ml-8 py-1 text-xs text-muted-foreground">No changes right now.</p>
          )}
          {repo.files.map((file) => (
            <FileRow key={file.path} repo={repo} file={file} scope={scope} threads={threads}
              expanded={expandedFiles.has(fileKey(repo, file.path, scope))} onToggle={onToggleFile} loaders={loaders} />
          ))}
          {repo.truncated && <p className="ml-8 py-1 text-xs text-muted-foreground">Showing the first {repo.files.length} files</p>}
          {repo.otherFiles.length > 0 && (
            <>
              <button type="button" aria-expanded={showOthers} onClick={() => setShowOthers((shown) => !shown)}
                className="flex w-full cursor-pointer items-center gap-1.5 py-1 pl-8 pr-3 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
                <Icon name={showOthers ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0" aria-hidden />
                {repo.otherFiles.length} other {repo.otherFiles.length === 1 ? "change" : "changes"} in this repo
              </button>
              {showOthers && (
                <div className="pl-4 opacity-90">
                  {repo.otherFiles.map((file) => (
                    <FileRow key={file.path} repo={repo} file={file} scope={scope} threads={threads}
                      expanded={expandedFiles.has(fileKey(repo, file.path, scope))} onToggle={onToggleFile} loaders={loaders} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export const RepoSection = memo(RepoSectionView);
