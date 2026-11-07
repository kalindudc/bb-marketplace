import type { CollectDeps, RepoPlan, Touched } from "./collect";
import type {
  CommitFilesInput, CommitFilesOutput, FileChange, FileSidesOutput, GitFile, HostOutput, HostTarget, ImageOutput, PatchInput, PatchOutput, RepoRef, Scope, Worktree,
} from "./contract";

export type LiveFiles = { files: FileChange[]; branch: string | null; base: string | null; aheadCount: number | null; truncated: boolean };

type WorkspaceRef = Extract<RepoRef, { kind: "workspace" }>;
type BranchRef = Extract<RepoRef, { kind: "branch" }>;
type CheckoutRef = Extract<RepoRef, { kind: "checkout" }>;
/** Where a repository is read with git: its root and machine. */
export type GitAt = { hostId: string; root: string };
// What git reports about a worktree; a cached entry holds only this, never who works in it or what they committed.
export type WorktreeStatus = Omit<
  Worktree, "key" | "ref" | "label" | "projectId" | "hostId" | "hostName" | "root" | "kind" | "threadIds" | "onBase" | "threadCommits" | "leftOut" | "whole"
>;
type HostUnavailableResult = Extract<HostOutput<"repoFiles">, { outcome: "unavailable" }>;

export const MAX_FILES = 500;
export const MAX_COMMITS = 100;
const MAX_MESSAGE = 1000;
// A branch that is gone does not come back, so that answer is kept far longer than the default.
const MISSING_REF_TTL_MS = 10 * 60_000;

/** How Vantage decides what a thread changed; the settings of the same names. */
export interface Counting { pick: boolean; folderLimit: number; historyThreshold: number; historyShare: number }
export const DEFAULT_COUNTING: Counting = { pick: true, folderLimit: 200, historyThreshold: 50, historyShare: 10 };
const countingOf = (deps: CollectDeps): Counting => deps.counting ?? DEFAULT_COUNTING;

// Whether a worktree compares with the closest base: the setting, unless the user asked to see that worktree whole.
export const picksBase = (deps: Pick<CollectDeps, "counting" | "whole">, key: string): boolean =>
  (deps.counting?.pick ?? true) && deps.whole?.has(key) !== true;

export function hostMessage(result: HostUnavailableResult): string {
  return result.reason === "not-a-repo" ? "This folder is no longer a git repository" : result.message;
}

export function gitFileChange(file: GitFile): FileChange {
  return { ...file, untracked: file.status === "untracked", tooLarge: false, edits: null };
}

export function unavailableStatus(message: string, branch: string | null, base: string | null): WorktreeStatus {
  return {
    branch, base, state: "unavailable", message: message.slice(0, MAX_MESSAGE),
    aheadCount: null, behindCount: null, uncommitted: [], committed: [], commits: [], skippedBase: null,
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

// Every workspace is read with git at its repository root, on its machine, like a checkout; its environment's events clear the entry.
export function loadWorkspaceStatus(
  deps: CollectDeps, ref: WorkspaceRef, threadIds: readonly string[], signal?: AbortSignal, pick?: boolean,
): Promise<WorktreeStatus> {
  return loadCheckoutStatus(deps, atRoot(ref), threadIds, signal, ref.environmentId, pick).then((result) => checkoutWorktreeStatus(result, ref.base));
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

// One read serves a worktree row and its uncommitted files in the repository view. A workspace passes its environment, so
// bb's workspace events clear the entry. `pick` defaults to the setting.
export function loadCheckoutStatus(
  deps: CollectDeps, ref: CheckoutRef, threadIds: readonly string[], signal?: AbortSignal, environmentId: string | null = null, pick?: boolean,
): Promise<HostOutput<"checkoutStatus">> {
  const counting = countingOf(deps);
  const picking = pick ?? counting.pick;
  const input = { root: ref.root, base: ref.base, pick: picking, folderLimit: counting.folderLimit };
  const read = (own?: AbortSignal) => deps.host("checkoutStatus", input, { hostId: ref.hostId, signal: own });
  return shared(deps, `co\0${ref.hostId}\0${ref.root}\0${ref.base ?? ""}\0${picking ? "pick" : "as-is"}\0${counting.folderLimit}`, environmentId, threadIds, read, signal);
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
    skippedBase: result.skippedBase,
    head: result.head,
  };
}

function hostTarget(ref: Exclude<RepoRef, { kind: "workspace" | "recorded" }>, scope: Scope): HostTarget {
  if (ref.kind === "branch") return { type: "range", base: ref.base, head: ref.head };
  return scope === "branch" ? { type: "merge-base", base: ref.base } : { type: "uncommitted" };
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

async function loadGitBranchFiles(deps: CollectDeps, checkout: CheckoutRef, signal?: AbortSignal): Promise<LiveFiles | { unavailable: string }> {
  const input = { root: checkout.root, target: hostTarget(checkout, "branch"), folderLimit: countingOf(deps).folderLimit };
  const result = await deps.host("repoFiles", input, { hostId: checkout.hostId, signal });
  if (result.outcome === "unavailable") return { unavailable: hostMessage(result) };
  return { files: result.files.map(gitFileChange), branch: null, base: result.base, aheadCount: result.aheadCount, truncated: result.truncated };
}

// `pick`: whether the worktree row of this repository picked its base; its uncommitted files come from the same read.
export async function loadRepoFiles(
  deps: CollectDeps, plan: RepoPlan, scope: Scope, signal?: AbortSignal, pick?: boolean,
): Promise<LiveFiles | { unavailable: string } | { missingRef: true }> {
  const { ref } = plan;
  if (ref.kind === "recorded") return recordedLiveFiles(plan);
  if (ref.kind === "workspace") {
    const checkout = atRoot(ref);
    if (scope === "uncommitted") {
      const status = await loadCheckoutStatus(deps, checkout, plan.threadIds, signal, ref.environmentId, pick);
      if (status.outcome === "unavailable") return { unavailable: hostMessage(status) };
      return { files: status.uncommitted.map(gitFileChange), branch: null, base: null, aheadCount: null, truncated: status.truncated };
    }
    return loadGitBranchFiles(deps, checkout, signal);
  }
  if (ref.kind === "checkout" && ref.worked === true && scope === "uncommitted") {
    const status = await loadCheckoutStatus(deps, ref, plan.threadIds, signal, null, pick);
    if (status.outcome === "unavailable") return { unavailable: hostMessage(status) };
    return { files: status.uncommitted.map(gitFileChange), branch: status.branch, base: null, aheadCount: null, truncated: status.truncated };
  }
  const folderLimit = countingOf(deps).folderLimit;
  const result = ref.kind === "branch"
    ? await loadBranchRange(deps, ref, plan.threadIds, signal)
    : await deps.host("repoFiles", { root: ref.root, target: hostTarget(ref, scope), folderLimit }, { hostId: ref.hostId, signal });
  if (result.outcome === "unavailable") {
    return ref.kind === "branch" && result.reason === "missing-ref" ? { missingRef: true } : { unavailable: hostMessage(result) };
  }
  return {
    files: result.files.map(gitFileChange), branch: result.branch, base: result.base,
    aheadCount: result.aheadCount, truncated: result.truncated,
  };
}

const gitCheckout = (at: GitAt, base: string | null): CheckoutRef => ({ kind: "checkout", hostId: at.hostId, root: at.root, base });

// A workspace is read like a checkout at its repository root. A ref from Vantage 0.8 or earlier has no root; reloading gives one.
export function atRoot(ref: WorkspaceRef): CheckoutRef {
  if (ref.root === undefined || ref.hostId === undefined) throw new Error("This worktree's location is not known yet; refresh Vantage");
  return gitCheckout({ hostId: ref.hostId, root: ref.root }, ref.base);
}

function hostPatchTarget(ref: Exclude<RepoRef, { kind: "workspace" | "recorded" }>, input: PatchInput): HostTarget {
  if (input.sha !== null) return { type: "commit", sha: input.sha };
  if (input.scope !== "committed") return hostTarget(ref, input.scope);
  return ref.kind === "branch" ? hostTarget(ref, "branch") : { type: "committed", base: ref.base };
}

const asGit = (ref: Exclude<RepoRef, { kind: "recorded" }>): Exclude<RepoRef, { kind: "workspace" | "recorded" }> =>
  ref.kind === "workspace" ? atRoot(ref) : ref;

export async function loadPatch(deps: CollectDeps, input: PatchInput, signal?: AbortSignal): Promise<PatchOutput> {
  if (input.ref.kind === "recorded") throw new Error("Use recordedEdits");
  const ref = asGit(input.ref);
  const result = await deps.host("repoPatch", {
    root: ref.root, path: input.path, previousPath: input.previousPath, untracked: input.untracked, target: hostPatchTarget(ref, input),
  }, { hostId: ref.hostId, signal });
  if (result.outcome === "unavailable") throw new Error(hostMessage(result));
  return { patch: result.patch, truncated: result.truncated, binary: result.binary };
}

export async function loadImages(deps: CollectDeps, input: PatchInput, signal?: AbortSignal): Promise<ImageOutput> {
  if (input.ref.kind === "recorded") return { old: null, new: null, truncated: false };
  const ref = asGit(input.ref);
  const result = await deps.host("imageSides", {
    root: ref.root, path: input.path, previousPath: input.previousPath, untracked: input.untracked, target: hostPatchTarget(ref, input),
  }, { hostId: ref.hostId, signal });
  if (result.outcome === "unavailable") throw new Error(hostMessage(result));
  return { old: result.old, new: result.new, truncated: result.truncated };
}

export async function loadCommitFiles(deps: CollectDeps, input: CommitFilesInput, signal?: AbortSignal): Promise<CommitFilesOutput> {
  if (input.ref.kind === "recorded") throw new Error("Commits are not available for this repository");
  const ref = asGit(input.ref);
  const result = await deps.host("repoFiles", { root: ref.root, target: { type: "commit", sha: input.sha } }, { hostId: ref.hostId, signal });
  if (result.outcome === "unavailable") throw new Error(hostMessage(result));
  return { files: result.files.map(gitFileChange) };
}

export async function loadFileSides(deps: CollectDeps, input: PatchInput, signal?: AbortSignal): Promise<FileSidesOutput> {
  if (input.ref.kind === "recorded") return { old: null, new: null };
  const ref = asGit(input.ref);
  const result = await deps.host("fileSides", {
    root: ref.root, path: input.path, previousPath: input.previousPath, untracked: input.untracked, target: hostPatchTarget(ref, input),
  }, { hostId: ref.hostId, signal });
  if (result.outcome === "unavailable") throw new Error(hostMessage(result));
  return { old: result.old, new: result.new };
}
