import { useCallback, useMemo } from "react";
import type { Overview, ReviewMarks } from "./contract";
import type { SidebarIndex } from "./live";
import { useLiveIndex } from "./live";
import { buildRows, chipCounts, groupRows, hiddenCount, matchesChip, outsideEntries, rowContext, rowOf, type Chip, type Group, type GroupBy, type Outside, type Row } from "./model";
import { useReviewMarks } from "./reviewed";

export interface RowsData {
  rows: Row[];
  groups: Group[];
  order: Row[];
  outside: Outside[];
  counts: Record<Chip, number>;
  hidden: number;
  marks: Readonly<Record<string, ReviewMarks>>;
  live: SidebarIndex;
  titleOf(key: string): string;
  // A worktree's row even when the list leaves it out, such as one with no changes that was linked to.
  rowFor(key: string): Row | null;
  branchOf(key: string): string | null;
}

const NO_ROWS: Row[] = [];
// The reviewed RPC takes at most 2,000 keys; a page holds at most 500 threads.
const MAX_MARK_KEYS = 500;

// Needs a LiveThreadsProvider above it.
export function useRows(overview: Overview | null, options: { currentThreadId: string | null; text: string; chip: Chip | null; groupBy: GroupBy }): RowsData {
  const { currentThreadId, text, chip, groupBy } = options;
  const live = useLiveIndex();
  const reviewKeys = useMemo(() => (overview?.worktrees ?? [])
    .filter((worktree) => worktree.uncommitted.length + worktree.committed.length > 0)
    .map((worktree) => worktree.key)
    .slice(0, MAX_MARK_KEYS), [overview?.worktrees]);
  const marks = useReviewMarks(reviewKeys);
  const rows = useMemo(() => (overview === null ? NO_ROWS : buildRows({ overview, live, marks, currentThreadId, text })),
    [overview, live, marks, currentThreadId, text]);
  const groups = useMemo(() => groupRows(rows.filter((row) => matchesChip(row, chip)), groupBy), [rows, chip, groupBy]);
  const order = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const outside = useMemo(() => (overview === null || chip !== null ? [] : outsideEntries(overview, text)), [overview, chip, text]);
  const counts = useMemo(() => chipCounts(rows), [rows]);
  const hidden = overview === null ? 0 : hiddenCount(overview, text);
  const byKey = useMemo(() => new Map(rows.map((row) => [row.worktree.key, row])), [rows]);
  const titleOf = useCallback((key: string) => byKey.get(key)?.title ?? overview?.worktrees.find((worktree) => worktree.key === key)?.label ?? key, [byKey, overview]);
  const branchOf = useCallback((key: string) => overview?.worktrees.find((worktree) => worktree.key === key)?.branch ?? null, [overview]);
  const rowFor = useCallback((key: string): Row | null => {
    const found = byKey.get(key);
    if (found !== undefined) return found;
    const worktree = overview?.worktrees.find((entry) => entry.key === key);
    if (overview === null || worktree === undefined) return null;
    return rowOf(worktree, { overview, live, marks, currentThreadId }, rowContext(overview));
  }, [byKey, overview, live, marks, currentThreadId]);
  return { rows, groups, order, outside, counts, hidden, marks, live, titleOf, rowFor, branchOf };
}
