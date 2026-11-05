import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { KickResult } from "./contract";
import type { Failure } from "./failure";

export interface Row {
  thread: PluginSidebarThread;
  /** Undefined while the server reads it. */
  failure: Failure | undefined;
  /** What the last Resume did to this thread, while that is still news. */
  result: KickResult | undefined;
}

export interface KickRecord {
  result: KickResult;
  at: number;
}

export function isFailed(thread: PluginSidebarThread): boolean {
  return thread.status === "error" && !thread.isArchived && !thread.isHidden;
}

export function buildRows(
  threads: readonly PluginSidebarThread[],
  failures: Readonly<Record<string, Failure>> | undefined,
  kicks: ReadonlyMap<string, KickRecord>,
): Row[] {
  return threads
    .filter(isFailed)
    .map((thread) => {
      const failure = failures?.[thread.id];
      const kick = kicks.get(thread.id);
      // A thread that failed again after its resume shows its new error, not the old outcome.
      const stale = kick !== undefined && failure?.failedAt != null && failure.failedAt > kick.at;
      return { thread, failure, result: stale ? undefined : kick?.result };
    })
    .sort((a, b) => failedAt(b) - failedAt(a));
}

export function failedAt(row: Row): number {
  return row.failure?.failedAt ?? row.thread.updatedAt;
}

/** Network failures start ticked; anything a retry is unlikely to fix, or that already has a message waiting, starts unticked. */
export function startsSelected(row: Row): boolean {
  return row.failure?.network === true && row.thread.queuedWork === "none";
}

export function ago(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function summarize(results: readonly KickResult[]): { text: string; failed: boolean } {
  const sent = results.filter((result) => result.outcome === "sent").length;
  const queued = results.filter((result) => result.outcome === "queued").length;
  const failed = results.filter((result) => result.outcome === "failed").length;
  const parts = [
    sent > 0 ? `Resumed ${plural(sent, "thread")}` : null,
    queued > 0 ? `${queued} queued` : null,
    failed > 0 ? `${failed} could not be resumed` : null,
  ].filter((part) => part !== null);
  return { text: parts.join(", "), failed: failed > 0 };
}
