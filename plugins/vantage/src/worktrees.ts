import type { CollectDeps, Environment, RepoPlan } from "./collect";
import type { Commit, FileChange, RepoRef, SharedFile, Worktree } from "./contract";
import { mapLimit } from "./limit";
import { planCached } from "./repo-cache";
import { gitFileChange, hostMessage } from "./sources";

const STATUS_CONCURRENCY = 8;
const MAX_FILES = 500;
const MAX_COMMITS = 100;
const MAX_SHARED_FILES = 200;
const MAX_MESSAGE = 1000;
const SECONDS_BELOW = 1e12;

type WorktreeRef = Extract<RepoRef, { kind: "workspace" | "branch" }>;
type WorktreePlan = RepoPlan & { ref: WorktreeRef };
type StatusFile = { path: string; status: string; insertions: number | null; deletions: number | null };
type Identity = Pick<Worktree, "key" | "ref" | "label" | "projectId" | "hostId" | "hostName" | "root" | "kind" | "threadIds">;
// What git and bb report about a worktree; an entry in the repository cache holds only this, never who works in it.
type Status = Omit<Worktree, keyof Identity>;

const STATUS_BY_LETTER: Record<string, FileChange["status"]> = {
  A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", U: "unmerged", "?": "untracked", "??": "untracked",
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE);
const isWorktreePlan = (plan: RepoPlan): plan is WorktreePlan => plan.ref.kind === "workspace" || plan.ref.kind === "branch";

export function fileFromStatus(file: StatusFile): FileChange {
  const status = STATUS_BY_LETTER[file.status] ?? "modified";
  return {
    path: file.path, previousPath: null, status, additions: file.insertions, deletions: file.deletions,
    binary: file.insertions === null && file.deletions === null, untracked: status === "untracked", tooLarge: false, edits: null,
  };
}

// bb does not say whether `authoredAt` is seconds or milliseconds.
const toMilliseconds = (value: number): number => (value < SECONDS_BELOW ? value * 1000 : value);

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

function unavailable(message: string, branch: string | null, base: string | null): Status {
  return {
    branch, base, state: "unavailable", message: message.slice(0, MAX_MESSAGE),
    aheadCount: null, behindCount: null, uncommitted: [], committed: [], commits: [],
  };
}

async function loadWorkspace(
  deps: CollectDeps, ref: Extract<RepoRef, { kind: "workspace" }>, fallbackBranch: string | null, signal?: AbortSignal,
): Promise<Status> {
  const result = await deps.sdk.environments.status({
    environmentId: ref.environmentId, ...(ref.base === null ? {} : { mergeBaseBranch: ref.base }), signal,
  });
  if (result.outcome === "not_applicable") return unavailable(result.message, fallbackBranch, ref.base);
  if (result.outcome === "unavailable") return unavailable(result.failure.message, fallbackBranch, ref.base);
  const { checkout, mergeBase, workingTree } = result.workspace;
  const commits = (mergeBase?.commits ?? []).slice(0, MAX_COMMITS).map((commit): Commit => ({
    sha: commit.sha, shortSha: commit.shortSha, subject: commit.subject, authorName: commit.authorName,
    authoredAt: toMilliseconds(commit.authoredAt),
  }));
  return {
    branch: "branchName" in checkout ? checkout.branchName : null,
    base: mergeBase?.mergeBaseBranch ?? null,
    state: "ready",
    message: null,
    aheadCount: mergeBase?.aheadCount ?? null,
    behindCount: mergeBase?.behindCount ?? null,
    uncommitted: workingTree.files.slice(0, MAX_FILES).map(fileFromStatus),
    committed: (mergeBase?.files ?? []).slice(0, MAX_FILES).map(fileFromStatus),
    commits,
  };
}

// A branch the host no longer has is not a worktree: plan 01 shows it as recorded edits instead.
async function loadBranch(
  deps: CollectDeps, ref: Extract<RepoRef, { kind: "branch" }>, signal?: AbortSignal,
): Promise<Status | null> {
  const result = await deps.host(
    "repoFiles", { root: ref.root, target: { type: "range", base: ref.base, head: ref.head } }, { hostId: ref.hostId, signal },
  );
  if (result.outcome === "unavailable") {
    return result.reason === "missing-ref" ? null : unavailable(hostMessage(result), ref.head, ref.base);
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
    try {
      const status = await planCached(deps.cache, plan, "worktree", () => (ref.kind === "workspace"
        ? loadWorkspace(deps, ref, environments.get(ref.environmentId)?.branchName ?? null, signal)
        : loadBranch(deps, ref, signal)));
      return status === null ? null : { ...identity, ...status };
    } catch (error) {
      const branch = ref.kind === "branch" ? ref.head : (environments.get(ref.environmentId)?.branchName ?? null);
      return { ...identity, ...unavailable(errorMessage(error), branch, ref.base) };
    }
  });
  return loaded.filter((worktree) => worktree !== null);
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
