import type { FileChange, Worktree } from "./contract";

// An untracked folder Vantage folded into one entry: listed, but never ticked, diffed or counted.
export const isFolder = (file: Pick<FileChange, "folder">): boolean => file.folder !== undefined;

export const countedFiles = <F extends Pick<FileChange, "folder">>(files: readonly F[]): F[] => files.filter((file) => !isFolder(file));

export const fileCount = (worktree: Pick<Worktree, "uncommitted" | "committed">): number =>
  countedFiles(worktree.uncommitted).length + countedFiles(worktree.committed).length;
