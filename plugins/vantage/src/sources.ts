import type { CollectDeps, RepoPlan, Touched } from "./collect";
import type { CommitFilesInput, CommitFilesOutput, FileChange, GitFile, HostOutput, HostTarget, PatchInput, PatchOutput, RepoRef, Scope } from "./contract";

export type LiveFiles = { files: FileChange[]; branch: string | null; base: string | null; aheadCount: number | null; truncated: boolean };

type WorkspaceRef = Extract<RepoRef, { kind: "workspace" }>;
type HostUnavailableResult = Extract<HostOutput<"repoFiles">, { outcome: "unavailable" }>;
type DiffTarget = { type: "uncommitted" } | { type: "all"; mergeBaseBranch: string };
type PatchTarget = DiffTarget | { type: "branch_committed"; mergeBaseBranch: string } | { type: "commit"; sha: string };
type DiffFilesResult = Awaited<ReturnType<CollectDeps["sdk"]["environments"]["diffFiles"]>>;
type WorkspaceDiffFile = Extract<DiffFilesResult, { outcome: "available" }>["files"][number];

const BINARY_PATCH = /^Binary files .* differ$/m;

export function hostMessage(result: HostUnavailableResult): string {
  return result.reason === "not-a-repo" ? "This folder is no longer a git repository" : result.message;
}

export function gitFileChange(file: GitFile): FileChange {
  return { ...file, untracked: file.status === "untracked", tooLarge: false, edits: null };
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

export async function loadRepoFiles(
  deps: CollectDeps, plan: RepoPlan, scope: Scope, signal?: AbortSignal,
): Promise<LiveFiles | { unavailable: string } | { missingRef: true }> {
  const { ref } = plan;
  if (ref.kind === "recorded") return recordedLiveFiles(plan);
  if (ref.kind === "workspace") {
    const target = workspaceTarget(ref, scope);
    const result = await deps.sdk.environments.diffFiles(
      target.type === "all"
        ? { environmentId: ref.environmentId, target: "all", mergeBaseBranch: target.mergeBaseBranch, signal }
        : { environmentId: ref.environmentId, target: "uncommitted", signal },
    );
    if (result.outcome === "not_applicable") return { unavailable: result.message };
    if (result.outcome === "unavailable") return { unavailable: result.failure.message };
    return { files: result.files.map(workspaceFile), branch: null, base: target.type === "all" ? target.mergeBaseBranch : null, aheadCount: null, truncated: result.truncated };
  }
  const result = await deps.host("repoFiles", { root: ref.root, target: hostTarget(ref, scope) }, { hostId: ref.hostId, signal });
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
