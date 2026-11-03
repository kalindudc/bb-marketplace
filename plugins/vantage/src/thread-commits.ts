import type { CollectDeps } from "./collect";
import type { Worktree } from "./contract";
import type { ThreadEdits } from "./edits";
import type { TimeWindow } from "./git";
import { mapLimit } from "./limit";
import { checkoutWorktreeStatus, DEFAULT_COUNTING, hostMessage, loadCheckoutStatus, loadThreadCommits } from "./sources";

export const MAX_WINDOWS = 200;
const CONCURRENCY = 8;
const MAX_MESSAGE = 1000;

export interface Attribution { edits: ReadonlyMap<string, ThreadEdits>; running: ReadonlySet<string>; now: number }

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE);

// A command still going lasts until now in a running thread; in one that stopped, until the last event it sent.
export function commitWindows(
  threadIds: readonly string[], edits: ReadonlyMap<string, ThreadEdits>, running: ReadonlySet<string>, now: number,
): TimeWindow[] {
  const windows = threadIds.flatMap((threadId) => {
    const found = edits.get(threadId);
    if (found === undefined) return [];
    return found.commitRuns.map((run) => ({
      start: run.startedAt,
      end: run.endedAt ?? (running.has(threadId) ? now : Math.max(run.startedAt, found.lastEventAt ?? run.startedAt)),
    }));
  });
  return windows.sort((a, b) => a.start - b.start).slice(-MAX_WINDOWS);
}

// `main` on `main`, or on `origin/main`: the base a checkout outside bb is compared with is its remote branch.
export function isOnBase(branch: string | null, base: string | null): boolean {
  if (branch === null || base === null) return false;
  return base === branch || base.endsWith(`/${branch}`) && base.split("/").length === branch.split("/").length + 1;
}

// Commits ahead of the base already show; with none ahead, the commits a worktree's threads made show nowhere else.
const wantsThreadCommits = (worktree: Worktree): boolean =>
  worktree.state === "ready" && worktree.kind !== "branch" && worktree.commits.length === 0;

export async function attachThreadCommits(
  deps: CollectDeps, worktrees: readonly Worktree[], attribution: Attribution, signal?: AbortSignal,
): Promise<{ worktrees: Worktree[]; warnings: string[] }> {
  const warnings: string[] = [];
  const attached = await mapLimit(worktrees, CONCURRENCY, async (worktree): Promise<Worktree> => {
    if (!wantsThreadCommits(worktree)) return worktree;
    const windows = commitWindows(worktree.threadIds, attribution.edits, attribution.running, attribution.now);
    if (windows.length === 0) return worktree;
    const environmentId = worktree.ref.kind === "workspace" ? worktree.ref.environmentId : null;
    const failed = (message: string): Worktree => {
      warnings.push(`Could not read the commits its threads made in ${worktree.root}: ${message}`);
      return worktree;
    };
    try {
      const result = await loadThreadCommits(deps, { hostId: worktree.hostId, root: worktree.root }, windows, worktree.threadIds, environmentId, signal);
      return result.outcome === "available" ? { ...worktree, threadCommits: result.commits } : failed(hostMessage(result));
    } catch (error) {
      return failed(errorMessage(error));
    }
  });
  return { worktrees: attached, warnings };
}

// A worktree whose branch is far ahead of its base, where its threads made only a small share of those commits, such as
// a long-lived branch an agent checked out to change a few files.
export function wantsHistoryLeftOut(
  worktree: Pick<Worktree, "state" | "kind" | "aheadCount" | "whole">, threshold: number,
): boolean {
  return threshold > 0 && worktree.state === "ready" && worktree.kind !== "branch" && worktree.whole !== true
    && worktree.aheadCount !== null && worktree.aheadCount > threshold;
}

export const fewEnough = (kept: number, ahead: number, sharePercent: number): boolean => kept * 100 < ahead * sharePercent;

// Reads such a worktree again against the commit before its threads' first one, so only their commits and its uncommitted
// files show and count. With no commits of theirs, that is HEAD itself.
export async function leaveOutHistory(
  deps: CollectDeps, worktrees: readonly Worktree[], attribution: Attribution, signal?: AbortSignal,
): Promise<{ worktrees: Worktree[]; warnings: string[] }> {
  const { historyThreshold, historyShare } = deps.counting ?? DEFAULT_COUNTING;
  const warnings: string[] = [];
  const result = await mapLimit(worktrees, CONCURRENCY, async (worktree): Promise<Worktree> => {
    if (!wantsHistoryLeftOut(worktree, historyThreshold) || worktree.ref.kind === "branch") return worktree;
    const ahead = worktree.aheadCount!;
    const environmentId = worktree.ref.kind === "workspace" ? worktree.ref.environmentId : null;
    const at = { hostId: worktree.hostId, root: worktree.root };
    try {
      // Without every thread's events, a commit of theirs could go unseen and be left out with the rest.
      if (worktree.threadIds.some((threadId) => !attribution.edits.has(threadId))) return worktree;
      const windows = commitWindows(worktree.threadIds, attribution.edits, attribution.running, attribution.now);
      const made = windows.length === 0
        ? { outcome: "available" as const, commits: [], total: 0, since: null }
        : await loadThreadCommits(deps, at, windows, worktree.threadIds, environmentId, signal);
      if (made.outcome === "unavailable") throw new Error(hostMessage(made));
      const kept = made.total;
      if (!fewEnough(kept, ahead, historyShare)) return worktree;
      const since = kept === 0 ? (worktree.head ?? null) : made.since;
      if (since === null) return worktree;
      const trimmed = checkoutWorktreeStatus(
        await loadCheckoutStatus(deps, { kind: "checkout", ...at, base: since }, worktree.threadIds, signal, environmentId, false), since,
      );
      if (trimmed.state !== "ready") return worktree;
      return {
        ...worktree, committed: trimmed.committed, commits: trimmed.commits, uncommitted: trimmed.uncommitted, aheadCount: trimmed.aheadCount,
        ref: { ...worktree.ref, base: since }, leftOut: { aheadCount: ahead, kept },
      };
    } catch (error) {
      warnings.push(`Could not tell which commits in ${worktree.root} its threads made: ${errorMessage(error)}`);
      return worktree;
    }
  });
  return { worktrees: result, warnings };
}
