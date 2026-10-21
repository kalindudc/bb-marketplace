import type { CollectDeps } from "./collect";
import type { Worktree } from "./contract";
import type { ThreadEdits } from "./edits";
import type { TimeWindow } from "./git";
import { mapLimit } from "./limit";
import { hostMessage, loadThreadCommits } from "./sources";

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
