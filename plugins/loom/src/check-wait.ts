// Which of a pull request's pending checks hold back a fix round for the failed ones. A check still queued some minutes
// after Loom first saw it stops holding, and so does a running check that is not yet near done; a check Loom cannot
// measure, such as a commit status, holds until the settle time after the push, as every check did before.
import type { HostOutput } from "./host-contract";
import type { Spec } from "./spec";

type Feedback = Extract<HostOutput<"prFeedback">, { outcome: "ok" }>;
export type Check = Feedback["checks"][number];

export const CHECKS_QUEUED_MINUTES = 5;
export const CHECKS_NEAR_DONE_PERCENT = 75;
/** A running check past this many times its usual duration stops holding the round: it may be stuck. */
export const OVERRUN = 2;
/** Passed runs of one check, newest first, whose median is its usual duration. */
export const USUAL_RUNS = 5;

export interface CheckWait {
  settleMs: number;
  /** 0: a queued check holds as long as a running one. */
  queuedMs: number;
  /** 0: every running check holds. */
  nearDone: number;
}

/** The spec's keys first, then Loom's settings, then the defaults. */
export function checkWaitOf(spec: Spec, settings: { settleMs: number; queuedMinutes?: number; nearDonePercent?: number }): CheckWait {
  const queued = spec.merge.checks_queued_minutes ?? settings.queuedMinutes ?? CHECKS_QUEUED_MINUTES;
  return { settleMs: settings.settleMs, queuedMs: queued * 60_000, nearDone: spec.merge.checks_near_done_percent ?? settings.nearDonePercent ?? CHECKS_NEAR_DONE_PERCENT };
}

export interface Progress {
  percent: number;
  from: "forge" | "history" | "steps";
}

/** How far a running check got: the forge's own number, else its time so far against its usual duration, else a GitHub Actions job's steps. */
export function progressOf(check: Check, usualMs: number | undefined, now: number): Progress | null {
  if (check.progress != null) return { percent: check.progress, from: "forge" };
  if (usualMs !== undefined && usualMs > 0 && check.startedAt != null) return { percent: (Math.max(0, now - check.startedAt) / usualMs) * 100, from: "history" };
  if (check.steps != null && check.steps.total > 0) return { percent: (check.steps.done / check.steps.total) * 100, from: "steps" };
  return null;
}

/**
 * When Loom first saw each queued check on this head. On the first reading of the head Loom pushed, a queued check
 * has waited since the push; one that appears on a later reading has waited since that reading.
 */
export function queuedSince(checks: readonly Check[], previous: { head: string | null; queued?: Record<string, number> } | null, a: { head: string; pushedSha: string | null; pushedAt: number | null; now: number }): Record<string, number> {
  const known = previous !== null && previous.head === a.head ? (previous.queued ?? {}) : null;
  const fresh = known === null && a.head === a.pushedSha && a.pushedAt !== null ? a.pushedAt : a.now;
  const queued: Record<string, number> = {};
  for (const check of checks) if (check.state === "pending" && check.started === false) queued[check.key] = known?.[check.key] ?? fresh;
  return queued;
}

/** A pending check the fix round did not wait for, and why. */
export type Skipped = { name: string; url: string | null } & ({ why: "queued"; minutes: number } | { why: "running"; percent: number } | { why: "overrun"; percent: number } | { why: "settled"; minutes: number });

export interface Hold {
  /** Every pending check stopped holding, or the settle time after the push ran out. */
  settled: boolean;
  /** Pending checks a fix round sent now would not wait for. */
  skipped: Skipped[];
}

export function holdOf(checks: readonly Check[], a: { queued: Record<string, number>; usual: ReadonlyMap<string, number>; now: number; pushedAt: number | null; wait: CheckWait }): Hold {
  const { now, wait } = a;
  const minutes = (since: number) => Math.floor((now - since) / 60_000);
  const skipped: Skipped[] = [];
  const holding: Check[] = [];
  for (const check of checks) {
    if (check.state !== "pending") continue;
    const at = { name: check.name, url: check.url };
    if (check.started === false) {
      const since = a.queued[check.key] ?? now;
      if (wait.queuedMs > 0 && now - since >= wait.queuedMs) skipped.push({ ...at, why: "queued", minutes: minutes(since) });
      else holding.push(check);
      continue;
    }
    const progress = wait.nearDone === 0 ? null : progressOf(check, a.usual.get(check.name), now);
    if (progress === null || (progress.percent >= wait.nearDone && (progress.from !== "history" || progress.percent <= OVERRUN * 100))) holding.push(check);
    else skipped.push({ ...at, why: progress.percent > 100 ? "overrun" : "running", percent: Math.round(progress.percent) });
  }
  if (holding.length === 0) return { settled: true, skipped };
  if (a.pushedAt !== null && now - a.pushedAt >= wait.settleMs) return { settled: true, skipped: [...skipped, ...holding.map((check): Skipped => ({ name: check.name, url: check.url, why: "settled", minutes: minutes(a.pushedAt!) }))] };
  return { settled: false, skipped: [] };
}

/** The median of a check's recent passed runs. */
export function median(durations: readonly number[]): number | undefined {
  if (durations.length === 0) return undefined;
  const sorted = [...durations].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Where a check's past durations are kept: the repository on the forge, so projects on the same repository share them. */
export function durationsKey(prUrl: string | null, projectId: number, repo: string | null): string {
  const match = prUrl === null ? null : /^(https?:\/\/.+?)\/(?:-\/)?(?:pull|pulls|pull-requests|merge_requests)\/\d+/u.exec(prUrl);
  return match !== null ? match[1]! : `project:${projectId}:${repo ?? ""}`;
}
