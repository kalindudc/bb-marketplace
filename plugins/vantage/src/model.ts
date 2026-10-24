import type { FileChange, Overview, Repo, ReviewMarks, ThreadSummary, Worktree } from "./contract";
import { isArchivedOnly } from "./archived";
import { filterWorktrees } from "./filters";
import { isWorking, needsYou, resolveLive, type LiveThread, type SidebarIndex } from "./live";
import { progress, worktreeParts } from "./reviewed";
import { primaryThreadId } from "./worktrees";

export type Bucket = "needs" | "working" | "review" | "reviewed" | "unavailable" | "archived";
export type Chip = "needs" | "working" | "review" | "overlaps";
export type GroupBy = "status" | "project";

export interface Overlap { path: string; otherKeys: string[] }

export interface Row {
  worktree: Worktree;
  threadId: string;
  live: LiveThread;
  title: string;
  bucket: Bucket;
  // Null until the worktree's files are read.
  progress: { reviewed: number; total: number } | null;
  overlaps: Overlap[];
  additions: number;
  deletions: number;
}

export interface Outside { key: string; kind: "repo" | "otherFiles"; title: string; detail: string; repo: Repo | null; files: number; additions: number; deletions: number }

export interface Group { id: string; label: string; rows: Row[] }

export interface RowsInput {
  overview: Overview;
  live: SidebarIndex;
  marks: Readonly<Record<string, ReviewMarks>>;
  currentThreadId: string | null;
  text: string;
}

export const STATUS_GROUPS: ReadonlyArray<{ id: Bucket; label: string }> = [
  { id: "needs", label: "Needs you" },
  { id: "review", label: "To review" },
  { id: "working", label: "Working" },
  { id: "reviewed", label: "Reviewed" },
  { id: "unavailable", label: "Unavailable" },
  { id: "archived", label: "Archived" },
];
const ORDER: Record<Bucket, number> = { needs: 0, review: 1, working: 2, reviewed: 3, unavailable: 4, archived: 5 };

const sum = (files: readonly FileChange[], field: "additions" | "deletions"): number => files.reduce((total, file) => total + (file[field] ?? 0), 0);
export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function lineCounts(worktree: Pick<Worktree, "uncommitted" | "committed">): { additions: number; deletions: number } {
  return {
    additions: sum(worktree.uncommitted, "additions") + sum(worktree.committed, "additions"),
    deletions: sum(worktree.uncommitted, "deletions") + sum(worktree.committed, "deletions"),
  };
}

function overlapsByWorktree(overview: Overview): Map<string, Overlap[]> {
  const out = new Map<string, Overlap[]>();
  // The files two worktrees share are only known once every worktree's files are.
  if (overview.partial) return out;
  for (const file of overview.sharedFiles) {
    for (const key of file.worktreeKeys) {
      const list = out.get(key) ?? [];
      list.push({ path: file.path, otherKeys: file.worktreeKeys.filter((other) => other !== key) });
      out.set(key, list);
    }
  }
  return out;
}

export function bucketOf(input: { archived: boolean; unavailable: boolean; live: LiveThread; done: boolean }): Bucket {
  if (input.archived) return "archived";
  if (needsYou(input.live)) return "needs";
  if (isWorking(input.live)) return "working";
  // A worktree that cannot be read has nothing to review and never becomes reviewed.
  if (input.unavailable) return "unavailable";
  return input.done ? "reviewed" : "review";
}

export function rowOf(worktree: Worktree, input: Omit<RowsInput, "text">, context: { threads: ReadonlyMap<string, ThreadSummary>; overlaps: ReadonlyMap<string, Overlap[]> }): Row {
  const threadId = primaryThreadId(worktree, input.currentThreadId);
  const thread = resolveLive(input.live.get(threadId) ?? null, context.threads.get(threadId), threadId);
  const counted = worktree.state === "ready" ? progress(input.marks[worktree.key], worktreeParts(worktree)) : null;
  const archived = isArchivedOnly(worktree, context.threads) || thread.archived;
  const { additions, deletions } = lineCounts(worktree);
  return {
    worktree, threadId, live: thread, additions, deletions,
    title: threadId === input.currentThreadId ? "This thread" : thread.title,
    progress: counted,
    overlaps: context.overlaps.get(worktree.key) ?? [],
    bucket: bucketOf({ archived, unavailable: worktree.state === "unavailable", live: thread, done: counted !== null && counted.total > 0 && counted.reviewed === counted.total }),
  };
}

// Review progress shows once a file of the worktree is ticked, so a worktree nobody reviews carries no "0 of 5".
export const reviewStarted = (row: Pick<Row, "progress">): boolean => row.progress !== null && row.progress.reviewed > 0;

export function rowContext(overview: Overview) {
  return { threads: new Map<string, ThreadSummary>(overview.threads.map((thread) => [thread.id, thread])), overlaps: overlapsByWorktree(overview) };
}

export function buildRows(input: RowsInput): Row[] {
  const context = rowContext(input.overview);
  return filterWorktrees(input.overview, { text: input.text, projectId: null, changedOnly: true }).map((worktree) => rowOf(worktree, input, context));
}

export const matchesChip = (row: Row, chip: Chip | null): boolean =>
  chip === null || (chip === "overlaps" ? row.overlaps.length > 0 && row.bucket !== "archived" : row.bucket === chip);

export function chipCounts(rows: readonly Row[]): Record<Chip, number> {
  return {
    needs: rows.filter((row) => row.bucket === "needs").length,
    working: rows.filter((row) => row.bucket === "working").length,
    review: rows.filter((row) => row.bucket === "review").length,
    overlaps: rows.filter((row) => matchesChip(row, "overlaps")).length,
  };
}

export function groupRows(rows: readonly Row[], by: GroupBy): Group[] {
  if (by === "status") {
    return STATUS_GROUPS.map((group) => ({ id: group.id, label: group.label, rows: rows.filter((row) => row.bucket === group.id) }))
      .filter((group) => group.rows.length > 0);
  }
  const groups: Group[] = [];
  for (const row of rows) {
    if (row.bucket === "archived") continue;
    const id = `project\0${row.worktree.label}\0${row.worktree.hostName}`;
    let group = groups.find((entry) => entry.id === id);
    if (group === undefined) groups.push(group = { id, label: row.worktree.label, rows: [] });
    group.rows.push(row);
  }
  for (const group of groups) group.rows.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket]);
  const archived = rows.filter((row) => row.bucket === "archived");
  return archived.length > 0 ? [...groups, { id: "archived", label: "Archived", rows: archived }] : groups;
}

// Repositories agents edited by path, and files outside any repository: these open in All changes.
export function outsideEntries(overview: Overview, text: string): Outside[] {
  const query = text.trim().toLowerCase();
  const matches = (...values: string[]) => query === "" || values.some((value) => value.toLowerCase().includes(query));
  const entries: Outside[] = overview.repos
    .filter((repo) => repo.ref.kind === "checkout" && repo.ref.worked !== true)
    .filter((repo) => repo.totals.files > 0 || repo.state === "unavailable")
    .filter((repo) => matches(repo.label, repo.root ?? "", ...repo.files.map((file) => file.path)))
    .map((repo) => ({
      key: repo.key, kind: "repo", title: repo.label, detail: "edited by path", repo,
      files: repo.totals.files, additions: repo.totals.additions, deletions: repo.totals.deletions,
    }));
  const other = overview.otherFiles.filter((file) => matches(file.path));
  if (other.length > 0) {
    entries.push({
      key: "other-files", kind: "otherFiles", title: "Other files", detail: "not in a repository", repo: null,
      files: other.length, additions: sum(other, "additions"), deletions: sum(other, "deletions"),
    });
  }
  return entries;
}

// How many worktrees the list leaves out because nothing changed in them.
export function hiddenCount(overview: Overview, text: string): number {
  if (text.trim() !== "") return 0;
  return overview.worktrees.length - filterWorktrees(overview, { text: "", projectId: null, changedOnly: true }).length;
}
