import type { Overview, ThreadSummary } from "./contract";

// A row with no threads, or with a thread the overview does not know, counts as active, so it is never hidden or demoted by mistake.
export function isArchivedOnly(row: { threadIds: readonly string[] }, threads: ReadonlyMap<string, ThreadSummary>): boolean {
  return row.threadIds.length > 0 && row.threadIds.every((id) => threads.get(id)?.archived === true);
}

// Archived rows go after the active ones, so including them adds rows below and never moves an active row.
export function archivedLast<T extends { threadIds: readonly string[] }>(rows: readonly T[], threads: readonly ThreadSummary[]): T[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const active = rows.filter((row) => !isArchivedOnly(row, byId));
  return [...active, ...rows.filter((row) => isArchivedOnly(row, byId))];
}

export function countArchived(rows: readonly { threadIds: readonly string[] }[], threads: readonly ThreadSummary[]): number {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return rows.filter((row) => isArchivedOnly(row, byId)).length;
}

// Ticked, the count is the archived threads in view; unticked, the archived threads left out.
export function includeArchivedLabel(overview: Pick<Overview, "threads" | "archivedHidden"> | null, included: boolean): string {
  const count = overview === null ? 0 : included ? overview.threads.filter((thread) => thread.archived).length : overview.archivedHidden;
  return count > 0 ? `Include archived (${count})` : "Include archived";
}
