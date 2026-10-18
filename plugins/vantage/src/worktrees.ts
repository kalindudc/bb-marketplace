import type { CollectDeps, Environment, RepoPlan } from "./collect";
import type { RepoRef, SharedFile, Worktree } from "./contract";
import { mapLimit } from "./limit";
import {
  gitFileChange, hostMessage, loadBranchRange, loadWorkspaceStatus, MAX_COMMITS, MAX_FILES, unavailableStatus, type WorktreeStatus,
} from "./sources";

const STATUS_CONCURRENCY = 8;
const MAX_SHARED_FILES = 200;
const MAX_MESSAGE = 1000;

type WorktreeRef = Extract<RepoRef, { kind: "workspace" | "branch" }>;
type WorktreePlan = RepoPlan & { ref: WorktreeRef };
type Identity = Pick<Worktree, "key" | "ref" | "label" | "projectId" | "hostId" | "hostName" | "root" | "kind" | "threadIds">;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE);
const isWorktreePlan = (plan: RepoPlan): plan is WorktreePlan => plan.ref.kind === "workspace" || plan.ref.kind === "branch";

function identify(plan: WorktreePlan, environments: ReadonlyMap<string, Environment>, hostNames: ReadonlyMap<string, string>): Identity {
  const { ref } = plan;
  const hostId = plan.hostId ?? (ref.kind === "workspace" ? (environments.get(ref.environmentId)?.hostId ?? "") : ref.hostId);
  const environment = ref.kind === "workspace"
    ? environments.get(ref.environmentId)
    : [...environments.values()].find((entry) => entry.hostId === ref.hostId && entry.branchName === ref.head);
  return {
    key: plan.key, ref, label: plan.label, projectId: environment?.projectId ?? "", hostId, hostName: hostNames.get(hostId) ?? hostId,
    root: plan.root ?? environment?.path ?? "", kind: ref.kind, threadIds: [...plan.threadIds],
  };
}

// A branch the host no longer has is not a worktree: plan 01 shows it as recorded edits instead.
async function loadBranch(
  deps: CollectDeps, ref: Extract<RepoRef, { kind: "branch" }>, threadIds: readonly string[], signal?: AbortSignal,
): Promise<WorktreeStatus | null> {
  const result = await loadBranchRange(deps, ref, threadIds, signal);
  if (result.outcome === "unavailable") {
    return result.reason === "missing-ref" ? null : unavailableStatus(hostMessage(result), ref.head, ref.base);
  }
  return {
    branch: ref.head, base: result.base, state: "ready", message: null,
    aheadCount: result.aheadCount, behindCount: result.behindCount,
    uncommitted: [], committed: result.files.slice(0, MAX_FILES).map(gitFileChange), commits: result.commits.slice(0, MAX_COMMITS),
  };
}

export async function loadWorktrees(
  deps: CollectDeps, repos: readonly RepoPlan[], environments: ReadonlyMap<string, Environment>,
  hostNames: ReadonlyMap<string, string>, signal?: AbortSignal,
): Promise<Worktree[]> {
  const loaded = await mapLimit(repos.filter(isWorktreePlan), STATUS_CONCURRENCY, async (plan): Promise<Worktree | null> => {
    const identity = identify(plan, environments, hostNames);
    const { ref } = plan;
    const branch = ref.kind === "branch" ? ref.head : (environments.get(ref.environmentId)?.branchName ?? null);
    try {
      if (ref.kind === "branch") {
        const status = await loadBranch(deps, ref, plan.threadIds, signal);
        return status === null ? null : { ...identity, ...status };
      }
      const status = await loadWorkspaceStatus(deps, ref, plan.threadIds, signal);
      return {
        ...identity, ...status, branch: status.branch ?? (status.state === "unavailable" ? branch : null),
        uncommitted: status.uncommitted.slice(0, MAX_FILES),
      };
    } catch (error) {
      return { ...identity, ...unavailableStatus(errorMessage(error), branch, ref.base) };
    }
  });
  return loaded.filter((worktree) => worktree !== null);
}

// The rows the instant outline shows: who, where and on which branch are known; every number waits for git.
export function loadingWorktrees(
  repos: readonly RepoPlan[], environments: ReadonlyMap<string, Environment>, hostNames: ReadonlyMap<string, string>,
): Worktree[] {
  return repos.filter(isWorktreePlan).map((plan) => ({
    ...identify(plan, environments, hostNames),
    branch: plan.ref.kind === "branch" ? plan.ref.head : (environments.get(plan.ref.environmentId)?.branchName ?? null),
    base: plan.ref.base,
    state: "loading",
    message: null,
    aheadCount: null,
    behindCount: null,
    uncommitted: [],
    committed: [],
    commits: [],
  }));
}

export function findSharedFiles(worktrees: readonly Worktree[]): SharedFile[] {
  const byProject = new Map<string, Map<string, Set<string>>>();
  for (const worktree of worktrees) {
    if (worktree.state !== "ready") continue;
    const paths = byProject.get(worktree.projectId) ?? new Map<string, Set<string>>();
    byProject.set(worktree.projectId, paths);
    for (const file of [...worktree.uncommitted, ...worktree.committed]) {
      const keys = paths.get(file.path) ?? new Set<string>();
      keys.add(worktree.key);
      paths.set(file.path, keys);
    }
  }
  const shared: SharedFile[] = [];
  for (const [projectId, paths] of byProject) {
    for (const [path, keys] of paths) {
      if (keys.size >= 2) shared.push({ projectId, path, worktreeKeys: [...keys] });
    }
  }
  const order = (a: SharedFile, b: SharedFile): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
  return shared.sort(order).slice(0, MAX_SHARED_FILES);
}

// The thread a worktree row speaks for: the panel's own thread when it is in the worktree, else the first thread in it.
export function primaryThreadId(worktree: Pick<Worktree, "threadIds">, currentThreadId: string | null): string {
  if (currentThreadId !== null && worktree.threadIds.includes(currentThreadId)) return currentThreadId;
  return worktree.threadIds[0] ?? currentThreadId ?? "";
}
