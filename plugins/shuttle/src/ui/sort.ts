import type { PrView } from "../contract";
import { age, ago } from "./format";

export const SORT_LABELS = {
  updated: "Recently updated",
  newest: "Newest first",
  oldest: "Oldest first",
  closed: "Recently merged",
  repo: "Repository",
  size: "Largest first",
} as const;
export type SortKey = keyof typeof SORT_LABELS;

/** The first of each is the list's default; for open PRs it is the order the server sends. */
export const MINE_SORTS: readonly SortKey[] = ["updated", "newest", "oldest", "repo", "size"];
export const DONE_SORTS: readonly SortKey[] = ["closed", "newest", "oldest", "repo", "size"];

const lines = (pr: PrView) => (pr.additions === null || pr.deletions === null ? null : pr.additions + pr.deletions);
// A missing time or size goes last in either direction.
const desc = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a);
const asc = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);

const COMPARE: Record<SortKey, (a: PrView, b: PrView) => number> = {
  updated: (a, b) => desc(a.updatedAt, b.updatedAt),
  newest: (a, b) => desc(a.createdAt, b.createdAt),
  oldest: (a, b) => asc(a.createdAt, b.createdAt),
  closed: (a, b) => desc(a.closedAt, b.closedAt),
  repo: (a, b) => a.repo.localeCompare(b.repo, undefined, { sensitivity: "base" }) || a.server.localeCompare(b.server) || b.number - a.number,
  size: (a, b) => desc(lines(a), lines(b)),
};

/** A sorted copy. Ties go to the most recently updated, then the key, so rows never swap places between syncs. */
export function sortPrs(prs: readonly PrView[], key: SortKey): PrView[] {
  return [...prs].sort((a, b) => COMPARE[key](a, b) || desc(a.updatedAt, b.updatedAt) || a.key.localeCompare(b.key));
}

/** The time a row shows: the one its list is sorted by, else when it last changed. */
export function rowTime(pr: PrView, key: SortKey): string | null {
  if (key === "newest" || key === "oldest") return pr.createdAt === null ? null : `opened ${ago(pr.createdAt)}`;
  if (key === "closed") return pr.closedAt === null ? null : `${pr.state === "merged" ? "merged" : "closed"} ${ago(pr.closedAt)}`;
  return pr.updatedAt === null ? null : age(pr.updatedAt);
}
