import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { Overview, Prefs, ReviewMarks } from "./contract";
import type { SidebarIndex } from "./live";
import { useLiveIndex } from "./live";
import { buildRows, chipCounts, groupRows, hiddenCount, matchesChip, outsideEntries, rowContext, rowOf, type Chip, type Group, type GroupBy, type Outside, type Row } from "./model";
import { parentLookup, resolvePref, toggleInput, usePrefs, useSetPref, useTreePrefs, type ParentOf, type PrefField } from "./prefs";
import { useReviewMarks } from "./reviewed";
import { primaryThreadId } from "./worktrees";

export interface RowsData {
  rows: Row[];
  groups: Group[];
  order: Row[];
  outside: Outside[];
  counts: Record<Chip, number>;
  hidden: number;
  marks: Readonly<Record<string, ReviewMarks>>;
  prefs: Prefs;
  parentOf: ParentOf;
  live: SidebarIndex;
  titleOf(key: string): string;
  // A worktree's row even when the list leaves it out, such as one with no changes that was linked to.
  rowFor(key: string): Row | null;
  branchOf(key: string): string | null;
  toggle(field: PrefField, threadId: string): void;
  // Turns the choice that applies to `threadId` on or off where it is made: at the thread or ancestor that chose, else at `fallback`.
  toggleFor(field: PrefField, threadId: string, fallback: string): void;
  watched(threadId: string): boolean;
  reviewing(threadId: string): boolean;
}

const NO_ROWS: Row[] = [];

// Needs a LiveThreadsProvider above it.
export function useRows(overview: Overview | null, options: { currentThreadId: string | null; text: string; chip: Chip | null; groupBy: GroupBy }): RowsData {
  const { currentThreadId, text, chip, groupBy } = options;
  const live = useLiveIndex();
  const prefs = usePrefs();
  const setPref = useSetPref();
  const parentOf = useMemo(() => parentLookup(overview?.threads ?? [], live.values()), [overview?.threads, live]);
  const tree = useTreePrefs(prefs, parentOf);
  const reviewKeys = useMemo(() => (overview?.worktrees ?? [])
    .filter((worktree) => tree.reviewing(primaryThreadId(worktree, currentThreadId)))
    .map((worktree) => worktree.key)
    .slice(0, 500), [overview?.worktrees, tree, currentThreadId]);
  const marks = useReviewMarks(reviewKeys);
  const rows = useMemo(() => (overview === null ? NO_ROWS : buildRows({
    overview, live, watched: tree.watched, reviewing: tree.reviewing, marks, currentThreadId, text,
  })), [overview, live, tree, marks, currentThreadId, text]);
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
    return rowOf(worktree, { overview, live, watched: tree.watched, reviewing: tree.reviewing, marks, currentThreadId }, rowContext(overview));
  }, [byKey, overview, live, tree, marks, currentThreadId]);
  const toggle = useCallback((field: PrefField, threadId: string) => {
    setPref(toggleInput(prefs, field, threadId, parentOf)).catch((error: unknown) => {
      toast.error(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [setPref, prefs, parentOf]);
  const toggleFor = useCallback((field: PrefField, threadId: string, fallback: string) => {
    toggle(field, resolvePref(prefs, field, threadId, parentOf).threadId ?? fallback);
  }, [toggle, prefs, parentOf]);
  return {
    rows, groups, order, outside, counts, hidden, marks, prefs, parentOf, live, titleOf, rowFor, branchOf, toggle, toggleFor,
    watched: tree.watched, reviewing: tree.reviewing,
  };
}
