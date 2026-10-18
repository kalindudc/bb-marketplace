import type { CollectDeps, RepoPlan, Touched } from "./collect";
import type {
  Commit, CommitFilesInput, CommitFilesOutput, FileChange, GitFile, HostOutput, HostTarget, PatchInput, PatchOutput, RepoRef, Scope, Worktree,
} from "./contract";

export type LiveFiles = { files: FileChange[]; branch: string | null; base: string | null; aheadCount: number | null; truncated: boolean };

type WorkspaceRef = Extract<RepoRef, { kind: "workspace" }>;
type BranchRef = Extract<RepoRef, { kind: "branch" }>;
type StatusFile = { path: string; status: string; insertions: number | null; deletions: number | null };
// What git and bb report about a worktree; a cached entry holds only this, never who works in it.
export type WorktreeStatus = Omit<Worktree, "key" | "ref" | "label" | "projectId" | "hostId" | "hostName" | "root" | "kind" | "threadIds">;
type HostUnavailableResult = Extract<HostOutput<"repoFiles">, { outcome: "unavailable" }>;
type DiffTarget = { type: "uncommitted" } | { type: "all"; mergeBaseBranch: string };
type PatchTarget = DiffTarget | { type: "branch_committed"; mergeBaseBranch: string } | { type: "commit"; sha: string };
type DiffFilesResult = Awaited<ReturnType<CollectDeps["sdk"]["environments"]["diffFiles"]>>;
type WorkspaceDiffFile = Extract<DiffFilesResult, { outcome: "available" }>["files"][number];

const BINARY_PATCH = /^Binary files .* differ$/m;
export const MAX_FILES = 500;
export const MAX_COMMITS = 100;
const MAX_MESSAGE = 1000;
const SECONDS_BELOW = 1e12;
// A branch that is gone does not come back, so that answer is kept far longer than the default.
const MISSING_REF_TTL_MS = 10 * 60_000;

const STATUS_BY_LETTER: Record<string, FileChange["status"]> = {
  A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", U: "unmerged", "?": "untracked", "??": "untracked",
};

export function hostMessage(result: HostUnavailableResult): string {
  return result.reason === "not-a-repo" ? "This folder is no longer a git repository" : result.message;
}

export function gitFileChange(file: GitFile): FileChange {
  return { ...file, untracked: file.status === "untracked", tooLarge: false, edits: null };
}

export function fileFromStatus(file: StatusFile): FileChange {
  const status = STATUS_BY_LETTER[file.status] ?? "modified";
  return {
    path: file.path, previousPath: null, status, additions: file.insertions, deletions: file.deletions,
    binary: file.insertions === null && file.deletions === null, untracked: status === "untracked", tooLarge: false, edits: null,
  };
}

// bb does not say whether `authoredAt` is seconds or milliseconds.
const toMilliseconds = (value: number): number => (value < SECONDS_BELOW ? value * 1000 : value);

export function unavailableStatus(message: string, branch: string | null, base: string | null): WorktreeStatus {
  return {
    branch, base, state: "unavailable", message: message.slice(0, MAX_MESSAGE),
    aheadCount: null, behindCount: null, uncommitted: [], committed: [], commits: [],
  };
}

// A load that several callers share must not die with one caller's abort signal, so a cached load ignores it.
async function shared<T>(
  deps: CollectDeps, key: string, environmentId: string | null, threadIds: readonly string[],
  read: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal, ttlFor?: (value: T) => number | undefined,
): Promise<T> {
  if (deps.cache === undefined) return read(signal);
  return deps.cache.get(key, { threadIds, environmentId }, () => read(), ttlFor);
}

async function readWorkspaceStatus(deps: CollectDeps, ref: WorkspaceRef, signal?: AbortSignal): Promise<WorktreeStatus> {
  const result = await deps.sdk.environments.status({
    environmentId: ref.environmentId, ...(ref.base === null ? {} : { mergeBaseBranch: ref.base }), signal,
  });
  if (result.outcome === "not_applicable") return unavailableStatus(result.message, null, ref.base);
  if (result.outcome === "unavailable") return unavailableStatus(result.failure.message, null, ref.base);
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
    // The worktree list cuts this at MAX_FILES; the repository view counts the whole list to tell whether it was cut.
    uncommitted: workingTree.files.map(fileFromStatus),
    committed: (mergeBase?.files ?? []).slice(0, MAX_FILES).map(fileFromStatus),
    commits,
  };
}

export function loadWorkspaceStatus(
  deps: CollectDeps, ref: WorkspaceRef, threadIds: readonly string[], signal?: AbortSignal,
): Promise<WorktreeStatus> {
  return shared(deps, `ws\0${ref.environmentId}\0${ref.base ?? ""}`, ref.environmentId, threadIds, (own) => readWorkspaceStatus(deps, ref, own), signal);
}

export function loadBranchRange(
  deps: CollectDeps, ref: BranchRef, threadIds: readonly string[], signal?: AbortSignal,
): Promise<HostOutput<"repoFiles">> {
  const read = (own?: AbortSignal) => deps.host(
    "repoFiles", { root: ref.root, target: { type: "range", base: ref.base, head: ref.head } }, { hostId: ref.hostId, signal: own },
  );
  return shared(
    deps, `br\0${ref.hostId}\0${ref.root}\0${ref.head}\0${ref.base ?? ""}`, null, threadIds, read, signal,
    (result) => (result.outcome === "unavailable" && result.reason === "missing-ref" ? MISSING_REF_TTL_MS : undefined),
  );
}

function workspaceTarget(ref: WorkspaceRef, scope: Scope): DiffTarget {
  return scope === "branch" && ref.base !== null ? { type: "all", mergeBaseBranch: ref.base } : { type: "uncommitted" };
}

function hostTarget(ref: Exclude<RepoRef, { kind: "workspace" | "recorded" }>, scope: Scope): HostTarget {
  if (ref.kind === "branch") return { type: "range", base: ref.base, head: ref.head };
  return scope === "branch" ? { type: "merge-base", base: ref.base } : { type: "uncommitted" };
}

function workspaceFile(file: WorkspaceDiffFile): FileChange {
  return {
    path: file.path,
    previousPath: file.previousPath,
    status: file.origin === "untracked" ? "untracked" : file.changeKind === "type_changed" ? "type-changed" : file.changeKind,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    untracked: file.origin === "untracked",
    tooLarge: file.loadMode === "too_large",
    edits: null,
  };
}

export function recordedFile(path: string, touched: Touched): FileChange {
  const records = touched.records;
  const first = records[0];
  const last = records.at(-1);
  const moved = records.find((record) => record.movePath !== null);
  const status: FileChange["status"] =
    last?.kind === "delete" ? "deleted" : first?.kind === "add" ? "added" : moved !== undefined ? "renamed" : "modified";
  return {
    path, previousPath: status === "renamed" ? (moved?.path ?? null) : null, status,
    additions: records.reduce((sum, record) => sum + record.added, 0),
    deletions: records.reduce((sum, record) => sum + record.removed, 0),
    binary: false, untracked: false, tooLarge: false,
    edits: { threadIds: [...touched.threadIds], rawPaths: [...touched.rawPaths], count: records.length },
  };
}

export function recordedLiveFiles(plan: RepoPlan): LiveFiles {
  const files = [...plan.touched].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, touched]) => recordedFile(path, touched));
  return { files, branch: null, base: null, aheadCount: null, truncated: false };
}

export function loadWorkspaceDiff(
  deps: CollectDeps, ref: WorkspaceRef & { base: string }, threadIds: readonly string[], signal?: AbortSignal,
): Promise<LiveFiles | { unavailable: string }> {
  const read = async (own?: AbortSignal): Promise<LiveFiles | { unavailable: string }> => {
    const result = await deps.sdk.environments.diffFiles({ environmentId: ref.environmentId, target: "all", mergeBaseBranch: ref.base, signal: own });
    if (result.outcome === "not_applicable") return { unavailable: result.message };
    if (result.outcome === "unavailable") return { unavailable: result.failure.message };
    return { files: result.files.map(workspaceFile), branch: null, base: ref.base, aheadCount: null, truncated: result.truncated };
  };
  return shared(deps, `df\0${ref.environmentId}\0${ref.base}`, ref.environmentId, threadIds, read, signal);
}

export async function loadRepoFiles(
  deps: CollectDeps, plan: RepoPlan, scope: Scope, signal?: AbortSignal,
): Promise<LiveFiles | { unavailable: string } | { missingRef: true }> {
  const { ref } = plan;
  if (ref.kind === "recorded") return recordedLiveFiles(plan);
  if (ref.kind === "workspace") {
    if (scope === "branch" && ref.base !== null) return loadWorkspaceDiff(deps, { ...ref, base: ref.base }, plan.threadIds, signal);
    const status = await loadWorkspaceStatus(deps, ref, plan.threadIds, signal);
    if (status.state === "unavailable") return { unavailable: status.message ?? "bb could not read this workspace" };
    return { files: status.uncommitted, branch: null, base: null, aheadCount: null, truncated: false };
  }
  const result = ref.kind === "branch"
    ? await loadBranchRange(deps, ref, plan.threadIds, signal)
    : await deps.host("repoFiles", { root: ref.root, target: hostTarget(ref, scope) }, { hostId: ref.hostId, signal });
  if (result.outcome === "unavailable") {
    return ref.kind === "branch" && result.reason === "missing-ref" ? { missingRef: true } : { unavailable: hostMessage(result) };
  }
  return {
    files: result.files.map(gitFileChange), branch: result.branch, base: result.base,
    aheadCount: result.aheadCount, truncated: result.truncated,
  };
}

function workspacePatchTarget(ref: WorkspaceRef, input: PatchInput): PatchTarget {
  if (input.sha !== null) return { type: "commit", sha: input.sha };
  if (input.scope !== "committed") return workspaceTarget(ref, input.scope);
  if (ref.base === null) throw new Error("This worktree has no base branch, so there are no committed changes to show");
  return { type: "branch_committed", mergeBaseBranch: ref.base };
}

function hostPatchTarget(ref: Exclude<RepoRef, { kind: "workspace" | "recorded" }>, input: PatchInput): HostTarget {
  if (input.sha === null && input.scope !== "committed") return hostTarget(ref, input.scope);
  if (ref.kind !== "branch") throw new Error("Committed changes and commits are not available for a checkout");
  return input.sha === null ? hostTarget(ref, "branch") : { type: "commit", sha: input.sha };
}

export async function loadPatch(deps: CollectDeps, input: PatchInput, signal?: AbortSignal): Promise<PatchOutput> {
  const { ref, path } = input;
  if (ref.kind === "recorded") throw new Error("Use recordedEdits");
  if (ref.kind === "workspace") {
    const result = await deps.sdk.environments.diffPatch({
      environmentId: ref.environmentId, paths: [path], target: workspacePatchTarget(ref, input), signal,
    });
    if (result.outcome === "not_applicable") throw new Error(result.message);
    if (result.outcome === "unavailable") throw new Error(result.failure.message);
    const first = result.patches[0];
    return first === undefined
      ? { patch: "", truncated: false, binary: false }
      : { patch: first.patch, truncated: first.truncated, binary: BINARY_PATCH.test(first.patch) };
  }
  const result = await deps.host("repoPatch", {
    root: ref.root, path, previousPath: input.previousPath, untracked: input.untracked, target: hostPatchTarget(ref, input),
  }, { hostId: ref.hostId, signal });
  if (result.outcome === "unavailable") throw new Error(hostMessage(result));
  return { patch: result.patch, truncated: result.truncated, binary: result.binary };
}

export async function loadCommitFiles(deps: CollectDeps, input: CommitFilesInput, signal?: AbortSignal): Promise<CommitFilesOutput> {
  const { ref, sha } = input;
  if (ref.kind === "workspace") {
    const result = await deps.sdk.environments.diffFiles({ environmentId: ref.environmentId, target: "commit", sha, signal });
    if (result.outcome === "not_applicable") throw new Error(result.message);
    if (result.outcome === "unavailable") throw new Error(result.failure.message);
    return { files: result.files.map(workspaceFile) };
  }
  if (ref.kind === "branch") {
    const result = await deps.host("repoFiles", { root: ref.root, target: { type: "commit", sha } }, { hostId: ref.hostId, signal });
    if (result.outcome === "unavailable") throw new Error(hostMessage(result));
    return { files: result.files.map(gitFileChange) };
  }
  throw new Error("Commits are not available for this repository");
}
