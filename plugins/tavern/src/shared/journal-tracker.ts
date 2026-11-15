import type { JournalEntry } from "./schema";

/** A delegate's report gets this long to be looked at before the reminder names it and the panel's currency says so. */
export const REPORT_GRACE_MS = 10 * 60_000;

const closed = (e: Pick<JournalEntry, "status">) => e.status === "done" || e.status === "verified";
/** Another thread's work this thread waits on; a member's own linked waypoint is its own work. */
export const delegated = (e: Pick<JournalEntry, "owner" | "threadId">) => e.owner !== null && e.owner !== e.threadId;

function inOrder(entries: readonly JournalEntry[]): JournalEntry[] {
  const sorted = [...entries].sort((a, b) => a.order - b.order);
  return sorted.filter(e => e.parentId === null).flatMap(e => [e, ...sorted.filter(s => s.parentId === e.id)]);
}

export type TrackerGroupId = "reported" | "working" | "blocked";
export const TRACKER_GROUPS: Record<TrackerGroupId, { label: string; hint: string }> = {
  reported: { label: "Reported", hint: "The delegate reported or went idle, and you haven't looked yet" },
  working: { label: "Working", hint: "Handed over and under way, with nothing reported yet" },
  blocked: { label: "Blocked", hint: "The delegate is blocked; it needs you or something outside" },
};
const groupOf = (e: JournalEntry): TrackerGroupId => e.report ? "reported" : e.status === "blocked" || e.status === "rejected" ? "blocked" : "working";

/** Open entries owned by another thread, grouped Reported, Working, Blocked, each in journal order; empty groups are left out. */
export function trackerGroups(entries: readonly JournalEntry[]): { id: TrackerGroupId; entries: JournalEntry[] }[] {
  const open = inOrder(entries).filter(e => !closed(e) && delegated(e));
  return (Object.keys(TRACKER_GROUPS) as TrackerGroupId[]).map(id => ({ id, entries: open.filter(e => groupOf(e) === id) })).filter(g => g.entries.length > 0);
}

export type Currency = { lastDoneAt: number | null; oldestOpenAt: number | null; reported: number; delegated: number; stale: boolean };
/** How current the journal is: the last close, the oldest open entry (board mirrors aside), and delegates' reports not yet looked at. */
export function currency(entries: readonly JournalEntry[], now: number): Currency {
  const done = entries.filter(closed).map(e => e.doneAt ?? e.updatedAt);
  const open = entries.filter(e => !closed(e));
  const own = open.filter(e => !e.boardQuestId).map(e => e.createdAt);
  const waiting = open.filter(e => e.report);
  return {
    lastDoneAt: done.length ? Math.max(...done) : null,
    oldestOpenAt: own.length ? Math.min(...own) : null,
    reported: waiting.length,
    delegated: open.filter(delegated).length,
    stale: waiting.some(e => now - e.report!.at >= REPORT_GRACE_MS),
  };
}
