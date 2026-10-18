import type { FileChange, Overview, Repo, Worktree } from "./contract";

export interface PageFilter { text: string; projectId: string | null; changedOnly: boolean }
export const DEFAULT_FILTER: PageFilter = { text: "", projectId: null, changedOnly: true };

const paths = (files: readonly FileChange[]): string[] => files.map((file) => file.path);

// An empty query matches everything; otherwise a case-insensitive substring of any value.
function matcher(text: string): (values: readonly string[]) => boolean {
  const query = text.trim().toLowerCase();
  return (values) => query === "" || values.some((value) => value.toLowerCase().includes(query));
}

export function filterWorktrees(overview: Overview, filter: PageFilter): Worktree[] {
  const matches = matcher(filter.text);
  const titles = new Map(overview.threads.map((thread) => [thread.id, thread.title]));
  return overview.worktrees.filter((worktree) => {
    if (filter.projectId !== null && worktree.projectId !== filter.projectId) return false;
    const changed = worktree.uncommitted.length + worktree.committed.length > 0 || worktree.state === "unavailable";
    if (filter.changedOnly && !changed) return false;
    return matches([
      ...worktree.threadIds.map((id) => titles.get(id) ?? ""),
      worktree.label, worktree.branch ?? "", worktree.root, ...paths(worktree.uncommitted), ...paths(worktree.committed),
    ]);
  });
}

export function filterRepos(overview: Overview, filter: PageFilter): { repos: Repo[]; otherFiles: FileChange[] } {
  const matches = matcher(filter.text);
  const repos = overview.repos.filter((repo) => {
    if (filter.projectId !== null && repo.projectId !== filter.projectId) return false;
    // A "clean" row is a file an agent edited that has no change now, so it is not a change.
    const changed = repo.files.some((file) => file.status !== "clean") || repo.otherFiles.length > 0 || repo.state === "unavailable";
    if (filter.changedOnly && !changed) return false;
    return matches([repo.label, repo.root ?? "", ...paths(repo.files), ...paths(repo.otherFiles)]);
  });
  // Recorded edits outside any repository belong to no project.
  const otherFiles = filter.projectId === null ? overview.otherFiles.filter((file) => matches([file.path])) : [];
  return { repos, otherFiles };
}

export function projectOptions(overview: Overview): { id: string; name: string }[] {
  const names = new Map<string, string>();
  for (const item of [...overview.worktrees, ...overview.repos]) {
    if (item.projectId !== null && item.projectId !== "" && !names.has(item.projectId)) names.set(item.projectId, item.label);
  }
  return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}
