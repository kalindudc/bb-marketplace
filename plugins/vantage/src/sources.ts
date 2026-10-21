import type { CollectDeps, RepoPlan, Touched } from "./collect";
import type {
  Commit, CommitFilesInput, CommitFilesOutput, FileChange, GitFile, HostOutput, HostTarget, PatchInput, PatchOutput, RepoRef, Scope, Worktree,
} from "./contract";

export type LiveFiles = { files: FileChange[]; branch: string | null; base: string | null; aheadCount: number | null; truncated: boolean };

type WorkspaceRef = Extract<RepoRef, { kind: "workspace" }>;
type BranchRef = Extract<RepoRef, { kind: "branch" }>;
type CheckoutRef = Extract<RepoRef, { kind: "checkout" }>;
/** Where a workspace is read with git when bb does not answer in time: its repository root and machine. */
export type GitAt = { hostId: string; root: string };
type StatusFile = { path: string; status: string; insertions: number | null; deletions: number | null };
// What git and bb report about a worktree; a cached entry holds only this, never who works in it or what they committed.
export type WorktreeStatus = Omit<
  Worktree, "key" | "ref" | "label" | "projectId" | "hostId" | "hostName" | "root" | "kind" | "threadIds" | "onBase" | "threadCommits"
>;
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
// bb's status and diff calls have taken more than 30 seconds on a repository far behind its base branch. After this long
// Vantage stops waiting and reads the workspace with git on its machine, and keeps doing so: git gives the same numbers.
export const BB_DEADLINE_MS = 10_000;

class TooSlow extends Error {
  constructor() {
    super("bb took too long to read this workspace");
  }
}

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

async function beforeDeadline<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TooSlow());
      controller.abort();
    }, BB_DEADLINE_MS);
  });
  try {
    return await Promise.race([read(controller.signal), late]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

// Asks bb first; when bb misses the deadline and the workspace's root is known, remembers it and asks git instead.
async function bbOrGit<T>(
  deps: CollectDeps, environmentId: string, at: GitAt | undefined, fromBb: (signal: AbortSignal) => Promise<T>,
  fromGit: (at: GitAt, signal?: AbortSignal) => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  try {
    return await beforeDeadline(fromBb, signal);
  } catch (error) {
    if (!(error instanceof TooSlow) || at === undefined) throw error;
    deps.slowWorkspaces?.add(environmentId);
    return fromGit(at, signal);
  }
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

// `at`: where to read the workspace with git if bb does not answer in time.
export function loadWorkspaceStatus(
  deps: CollectDeps, ref: WorkspaceRef, threadIds: readonly string[], signal?: AbortSignal, at?: GitAt,
): Promise<WorktreeStatus> {
  const checkout = atRoot(ref) ?? (at !== undefined && deps.slowWorkspaces?.has(ref.environmentId) === true ? gitCheckout(at, ref.base) : null);
  if (checkout !== null) {
    return loadCheckoutStatus(deps, checkout, threadIds, signal, ref.environmentId).then((result) => checkoutWorktreeStatus(result, ref.base));
  }
  const read = (own?: AbortSignal) => bbOrGit(
    deps, ref.environmentId, at, (bounded) => readWorkspaceStatus(deps, ref, bounded),
    async (git, gitSignal) => checkoutWorktreeStatus(
      await deps.host("checkoutStatus", { root: git.root, base: ref.base }, { hostId: git.hostId, signal: gitSignal }), ref.base,
    ),
    own,
  );
  return shared(deps, `ws\0${ref.environmentId}\0${ref.base ?? ""}`, ref.environmentId, threadIds, read, signal);
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

// One read serves a worked checkout's worktree row and its uncommitted files in the repository view. A workspace read
// this way passes its environment, so bb's workspace events clear the entry.
export function loadCheckoutStatus(
  deps: CollectDeps, ref: CheckoutRef, threadIds: readonly string[], signal?: AbortSignal, environmentId: string | null = null,
): Promise<HostOutput<"checkoutStatus">> {
  const read = (own?: AbortSignal) => deps.host("checkoutStatus", { root: ref.root, base: ref.base }, { hostId: ref.hostId, signal: own });
  return shared(deps, `co\0${ref.hostId}\0${ref.root}\0${ref.base ?? ""}`, environmentId, threadIds, read, signal);
}

// The windows are part of the key: a commit command that starts, or one that is still running, asks git again.
export function loadThreadCommits(
  deps: CollectDeps, at: GitAt, windows: readonly { start: number; end: number }[], threadIds: readonly string[],
  environmentId: string | null, signal?: AbortSignal,
): Promise<HostOutput<"threadCommits">> {
  const key = `tc\0${at.hostId}\0${at.root}\0${windows.map((window) => `${window.start}-${window.end}`).join(",")}`;
  const read = (own?: AbortSignal) => deps.host("threadCommits", { root: at.root, windows: [...windows] }, { hostId: at.hostId, signal: own });
  return shared(deps, key, environmentId, threadIds, read, signal);
}

export function checkoutWorktreeStatus(result: HostOutput<"checkoutStatus">, base: string | null): WorktreeStatus {
  if (result.outcome === "unavailable") return unavailableStatus(hostMessage(result), null, base);
  return {
    branch: result.branch, base: result.base, state: "ready", message: null,
    aheadCount: result.aheadCount, behindCount: result.behindCount,
    uncommitted: result.uncommitted.slice(0, MAX_FILES).map(gitFileChange),
    committed: result.committed.slice(0, MAX_FILES).map(gitFileChange),
    commits: result.commits.slice(0, MAX_COMMITS),
  };
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
  deps: CollectDeps, ref: WorkspaceRef & { base: string }, threadIds: readonly string[], signal?: AbortSignal, at?: GitAt,
): Promise<LiveFiles | { unavailable: string }> {
  const fromBb = async (bounded: AbortSignal): Promise<LiveFiles | { unavailable: string }> => {
    const result = await deps.sdk.environments.diffFiles({ environmentId: ref.environmentId, target: "all", mergeBaseBranch: ref.base, signal: bounded });
    if (result.outcome === "not_applicable") return { unavailable: result.message };
    if (result.outcome === "unavailable") return { unavailable: result.failure.message };
    return { files: result.files.map(workspaceFile), branch: null, base: ref.base, aheadCount: null, truncated: result.truncated };
  };
  const fromGit = (git: GitAt, gitSignal?: AbortSignal) => loadGitBranchFiles(deps, gitCheckout(git, ref.base), gitSignal);
  const read = (own?: AbortSignal) => bbOrGit(deps, ref.environmentId, at, fromBb, fromGit, own);
  return shared(deps, `df\0${ref.environmentId}\0${ref.base}`, ref.environmentId, threadIds, read, signal);
}

async function loadGitBranchFiles(deps: CollectDeps, checkout: CheckoutRef, signal?: AbortSignal): Promise<LiveFiles | { unavailable: string }> {
  const result = await deps.host("repoFiles", { root: checkout.root, target: hostTarget(checkout, "branch") }, { hostId: checkout.hostId, signal });
  if (result.outcome === "unavailable") return { unavailable: hostMessage(result) };
  return { files: result.files.map(gitFileChange), branch: null, base: result.base, aheadCount: result.aheadCount, truncated: result.truncated };
}

export async function loadRepoFiles(
  deps: CollectDeps, plan: RepoPlan, scope: Scope, signal?: AbortSignal,
): Promise<LiveFiles | { unavailable: string } | { missingRef: true }> {
  const { ref } = plan;
  if (ref.kind === "recorded") return recordedLiveFiles(plan);
  if (ref.kind === "workspace" && atRoot(ref) !== null) {
    const checkout = atRoot(ref)!;
    if (scope === "uncommitted") {
      const status = await loadCheckoutStatus(deps, checkout, plan.threadIds, signal, ref.environmentId);
      if (status.outcome === "unavailable") return { unavailable: hostMessage(status) };
      return { files: status.uncommitted.map(gitFileChange), branch: null, base: null, aheadCount: null, truncated: status.truncated };
    }
    return loadGitBranchFiles(deps, checkout, signal);
  }
  if (ref.kind === "workspace") {
    const at = plan.root === null || plan.hostId === null ? undefined : { hostId: plan.hostId, root: plan.root };
    if (scope === "branch" && ref.base !== null) return loadWorkspaceDiff(deps, { ...ref, base: ref.base }, plan.threadIds, signal, at);
    const status = await loadWorkspaceStatus(deps, ref, plan.threadIds, signal, at);
    if (status.state === "unavailable") return { unavailable: status.message ?? "bb could not read this workspace" };
    return { files: status.uncommitted, branch: null, base: null, aheadCount: null, truncated: false };
  }
  if (ref.kind === "checkout" && ref.worked === true && scope === "uncommitted") {
    const status = await loadCheckoutStatus(deps, ref, plan.threadIds, signal);
    if (status.outcome === "unavailable") return { unavailable: hostMessage(status) };
    return { files: status.uncommitted.map(gitFileChange), branch: status.branch, base: null, aheadCount: null, truncated: status.truncated };
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

const gitCheckout = (at: GitAt, base: string | null): CheckoutRef => ({ kind: "checkout", hostId: at.hostId, root: at.root, base });

// A workspace Vantage reads with git is read like a checkout at its repository root.
export function atRoot(ref: WorkspaceRef): CheckoutRef | null {
  return ref.root === undefined || ref.hostId === undefined ? null : gitCheckout({ hostId: ref.hostId, root: ref.root }, ref.base);
}

function workspacePatchTarget(ref: WorkspaceRef, input: PatchInput): PatchTarget {
  if (input.sha !== null) return { type: "commit", sha: input.sha };
  if (input.scope !== "committed") return workspaceTarget(ref, input.scope);
  if (ref.base === null) throw new Error("This worktree has no base branch, so there are no committed changes to show");
  return { type: "branch_committed", mergeBaseBranch: ref.base };
}

function hostPatchTarget(ref: Exclude<RepoRef, { kind: "workspace" | "recorded" }>, input: PatchInput): HostTarget {
  if (input.sha !== null) return { type: "commit", sha: input.sha };
  if (input.scope !== "committed") return hostTarget(ref, input.scope);
  return ref.kind === "branch" ? hostTarget(ref, "branch") : { type: "committed", base: ref.base };
}

export async function loadPatch(deps: CollectDeps, input: PatchInput, signal?: AbortSignal): Promise<PatchOutput> {
  const { path } = input;
  const ref = input.ref.kind === "workspace" ? (atRoot(input.ref) ?? input.ref) : input.ref;
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
  const { sha } = input;
  const ref = input.ref.kind === "workspace" ? (atRoot(input.ref) ?? input.ref) : input.ref;
  if (ref.kind === "workspace") {
    const result = await deps.sdk.environments.diffFiles({ environmentId: ref.environmentId, target: "commit", sha, signal });
    if (result.outcome === "not_applicable") throw new Error(result.message);
    if (result.outcome === "unavailable") throw new Error(result.failure.message);
    return { files: result.files.map(workspaceFile) };
  }
  if (ref.kind === "branch" || ref.kind === "checkout") {
    const result = await deps.host("repoFiles", { root: ref.root, target: { type: "commit", sha } }, { hostId: ref.hostId, signal });
    if (result.outcome === "unavailable") throw new Error(hostMessage(result));
    return { files: result.files.map(gitFileChange) };
  }
  throw new Error("Commits are not available for this repository");
}
