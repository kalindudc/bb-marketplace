import { describe, expect, it, vi } from "vitest";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { CollectDeps, HostCall, RepoPlan, Touched } from "../src/collect";
import type { PatchInput, RepoRef } from "../src/contract";
import type { EditRecord } from "../src/edits";
import { loadCommitFiles, loadPatch, loadRepoFiles, recordedFile } from "../src/sources";

const AVAILABLE = { outcome: "available", initialPatches: [], mergeBaseRef: null, shortstat: "", truncated: false };
const diffFile = (overrides: object = {}) => ({
  path: "src/a.ts", previousPath: null, changeKind: "modified", additions: 2, deletions: 1, binary: false, origin: "tracked", loadMode: "auto",
  ...overrides,
});

const emptyStatus = (files: object[] = []) => ({
  outcome: "available",
  workspace: {
    branch: { currentBranch: "feature/work", defaultBranch: "main" },
    checkout: { kind: "branch", branchName: "feature/work", headSha: "abc" },
    mergeBase: null,
    workingTree: { files, fileCount: files.length, insertions: 0, deletions: 0, hasUncommittedChanges: files.length > 0, lineStatsComplete: true, state: "clean" },
  },
});

function deps(overrides: { diffFiles?: unknown; diffPatch?: unknown; host?: unknown; status?: unknown } = {}) {
  const status = vi.fn(async (..._args: unknown[]) => overrides.status ?? emptyStatus());
  const diffFiles = vi.fn(async (..._args: unknown[]) => overrides.diffFiles ?? { ...AVAILABLE, files: [] });
  const diffPatch = vi.fn(async (..._args: unknown[]) => overrides.diffPatch ?? { outcome: "available", patches: [] });
  const host = vi.fn(async (..._args: unknown[]) => overrides.host ?? {
    outcome: "available", branch: null, base: null, aheadCount: null, behindCount: null, commits: [], files: [], truncated: false,
  });
  return {
    deps: { sdk: { environments: { diffFiles, diffPatch, status } } as unknown as PluginBbSdk, host: host as unknown as HostCall, edits: {} as CollectDeps["edits"] },
    diffFiles, diffPatch, host, status,
  };
}

const planOf = (ref: RepoRef, touched: Map<string, Touched> = new Map()): RepoPlan => ({
  key: "k", ref, label: "L", projectId: "proj_1", root: "/repo", hostId: "host_1", threadIds: ["thr_1"], touched,
});
const workspace = (base: string | null): RepoRef => ({ kind: "workspace", environmentId: "env_1", base });
const checkout: RepoRef = { kind: "checkout", hostId: "host_1", root: "/repo", base: null };
const branch: RepoRef = { kind: "branch", hostId: "host_1", root: "/repo", base: "origin/main", head: "feature/old" };

const record = (overrides: Partial<EditRecord> = {}): EditRecord => ({
  threadId: "thr_1", path: "a.ts", movePath: null, kind: "update", added: 1, removed: 0, at: 1, ...overrides,
});
const touched = (records: EditRecord[], threadIds = ["thr_1"], rawPaths = ["a.ts"]): Touched => ({
  threadIds: new Set(threadIds), rawPaths: new Set(rawPaths), records,
});

describe("loadRepoFiles targets", () => {
  it("reads a workspace's uncommitted changes from its status and, for the branch scope, diffs everything since its base", async () => {
    const { deps: d, diffFiles, status } = deps();
    await loadRepoFiles(d, planOf(workspace("origin/main")), "uncommitted");
    expect(status.mock.calls).toEqual([[{ environmentId: "env_1", mergeBaseBranch: "origin/main", signal: undefined }]]);
    expect(diffFiles).not.toHaveBeenCalled();
    await loadRepoFiles(d, planOf(workspace("origin/main")), "branch");
    expect(diffFiles.mock.calls).toEqual([[{ environmentId: "env_1", target: "all", mergeBaseBranch: "origin/main", signal: undefined }]]);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("reads the uncommitted changes from the status for the branch scope too when there is no base", async () => {
    const { deps: d, diffFiles, status } = deps();
    const result = await loadRepoFiles(d, planOf(workspace(null)), "branch");
    expect(diffFiles).not.toHaveBeenCalled();
    expect(status.mock.calls[0]?.[0]).not.toHaveProperty("mergeBaseBranch");
    expect(result).toMatchObject({ base: null });
  });

  it("reports the base a workspace was compared with", async () => {
    const { deps: d } = deps();
    expect(await loadRepoFiles(d, planOf(workspace("origin/main")), "branch")).toMatchObject({ base: "origin/main" });
    expect(await loadRepoFiles(d, planOf(workspace("origin/main")), "uncommitted")).toMatchObject({ base: null });
  });

  it("asks the host for a checkout's uncommitted changes or its changes since the merge base", async () => {
    const { deps: d, host } = deps();
    await loadRepoFiles(d, planOf(checkout), "uncommitted");
    await loadRepoFiles(d, planOf(checkout), "branch");
    expect(host.mock.calls).toEqual([
      ["repoFiles", { root: "/repo", target: { type: "uncommitted" } }, { hostId: "host_1", signal: undefined }],
      ["repoFiles", { root: "/repo", target: { type: "merge-base", base: null } }, { hostId: "host_1", signal: undefined }],
    ]);
  });

  it("asks the host for the branch's range in either scope", async () => {
    const { deps: d, host } = deps();
    await loadRepoFiles(d, planOf(branch), "uncommitted");
    await loadRepoFiles(d, planOf(branch), "branch");
    const target = { type: "range", base: "origin/main", head: "feature/old" };
    expect(host.mock.calls.map((call) => (call as unknown[])[1])).toEqual([{ root: "/repo", target }, { root: "/repo", target }]);
  });
});

describe("loadRepoFiles results", () => {
  it("maps a workspace's files, including untracked, too large, renamed and type-changed ones", async () => {
    const { deps: d } = deps({
      diffFiles: {
        ...AVAILABLE, truncated: true,
        files: [
          diffFile({ path: "new.txt", changeKind: "added", origin: "untracked", additions: 3, deletions: 0 }),
          diffFile({ path: "huge.json", loadMode: "too_large", additions: 90_000 }),
          diffFile({ path: "b.ts", previousPath: "a.ts", changeKind: "renamed" }),
          diffFile({ path: "link", changeKind: "type_changed" }),
          diffFile({ path: "pic.png", binary: true, additions: 0, deletions: 0, changeKind: "added" }),
        ],
      },
    });
    const result = await loadRepoFiles(d, planOf(workspace("origin/main")), "branch");
    if (!("files" in result)) throw new Error("expected files");
    expect(result.truncated).toBe(true);
    expect(result.files).toEqual([
      { path: "new.txt", previousPath: null, status: "untracked", additions: 3, deletions: 0, binary: false, untracked: true, tooLarge: false, edits: null },
      { path: "huge.json", previousPath: null, status: "modified", additions: 90_000, deletions: 1, binary: false, untracked: false, tooLarge: true, edits: null },
      { path: "b.ts", previousPath: "a.ts", status: "renamed", additions: 2, deletions: 1, binary: false, untracked: false, tooLarge: false, edits: null },
      { path: "link", previousPath: null, status: "type-changed", additions: 2, deletions: 1, binary: false, untracked: false, tooLarge: false, edits: null },
      { path: "pic.png", previousPath: null, status: "added", additions: 0, deletions: 0, binary: true, untracked: false, tooLarge: false, edits: null },
    ]);
  });

  it("maps a workspace's uncommitted files from its status, with the counts bb reports", async () => {
    const { deps: d } = deps({
      status: emptyStatus([
        { path: "a.ts", status: "M", insertions: 2, deletions: 1 },
        { path: "new.txt", status: "??", insertions: 3, deletions: 0 },
        { path: "pic.png", status: "A", insertions: null, deletions: null },
      ]),
    });
    const result = await loadRepoFiles(d, planOf(workspace("origin/main")), "uncommitted");
    expect(result).toEqual({
      branch: null, base: null, aheadCount: null, truncated: false,
      files: [
        { path: "a.ts", previousPath: null, status: "modified", additions: 2, deletions: 1, binary: false, untracked: false, tooLarge: false, edits: null },
        { path: "new.txt", previousPath: null, status: "untracked", additions: 3, deletions: 0, binary: false, untracked: true, tooLarge: false, edits: null },
        { path: "pic.png", previousPath: null, status: "added", additions: null, deletions: null, binary: true, untracked: false, tooLarge: false, edits: null },
      ],
    });
  });

  it("makes a workspace unavailable with bb's message", async () => {
    const notApplicable = { outcome: "not_applicable", reason: "non_git_environment", message: "Not a git workspace" };
    const failed = { outcome: "unavailable", failure: { code: "path_not_found", message: "Folder is gone", workspacePath: "/x" } };
    expect(await loadRepoFiles(deps({ status: notApplicable }).deps, planOf(workspace(null)), "uncommitted")).toEqual({ unavailable: "Not a git workspace" });
    expect(await loadRepoFiles(deps({ status: failed }).deps, planOf(workspace(null)), "uncommitted")).toEqual({ unavailable: "Folder is gone" });
    expect(await loadRepoFiles(deps({ diffFiles: notApplicable }).deps, planOf(workspace("origin/main")), "branch")).toEqual({ unavailable: "Not a git workspace" });
    expect(await loadRepoFiles(deps({ diffFiles: failed }).deps, planOf(workspace("origin/main")), "branch")).toEqual({ unavailable: "Folder is gone" });
  });

  it("returns a checkout's host files with branch, base and counts", async () => {
    const { deps: d } = deps({
      host: {
        outcome: "available", branch: "main", base: "origin/main", aheadCount: 2, truncated: false,
        files: [
          { path: "a.ts", previousPath: null, status: "modified", additions: 1, deletions: 1, binary: false },
          { path: "n.ts", previousPath: null, status: "untracked", additions: 5, deletions: 0, binary: false },
        ],
      },
    });
    const result = await loadRepoFiles(d, planOf(checkout), "branch");
    expect(result).toMatchObject({ branch: "main", base: "origin/main", aheadCount: 2, truncated: false });
    if (!("files" in result)) throw new Error("expected files");
    expect(result.files.map((file) => [file.path, file.status, file.untracked, file.edits])).toEqual([
      ["a.ts", "modified", false, null], ["n.ts", "untracked", true, null],
    ]);
  });

  it("explains a folder that is no longer a repository and passes other host messages through", async () => {
    const gone = deps({ host: { outcome: "unavailable", reason: "not-a-repo", message: "raw" } });
    expect(await loadRepoFiles(gone.deps, planOf(checkout), "uncommitted")).toEqual({ unavailable: "This folder is no longer a git repository" });
    const failed = deps({ host: { outcome: "unavailable", reason: "git-failed", message: "fatal: bad object" } });
    expect(await loadRepoFiles(failed.deps, planOf(checkout), "uncommitted")).toEqual({ unavailable: "fatal: bad object" });
    const invalid = deps({ host: { outcome: "unavailable", reason: "invalid-input", message: "Unsafe ref" } });
    expect(await loadRepoFiles(invalid.deps, planOf(checkout), "uncommitted")).toEqual({ unavailable: "Unsafe ref" });
  });

  it("passes a missing ref through for a branch, but not for a checkout", async () => {
    const missing = { outcome: "unavailable", reason: "missing-ref", message: "The branch no longer exists" };
    expect(await loadRepoFiles(deps({ host: missing }).deps, planOf(branch), "uncommitted")).toEqual({ missingRef: true });
    expect(await loadRepoFiles(deps({ host: missing }).deps, planOf(checkout), "uncommitted")).toEqual({ unavailable: "The branch no longer exists" });
  });

  it("lets a failing host call reject", async () => {
    const d = deps();
    d.host.mockRejectedValueOnce(new Error("host disconnected"));
    await expect(loadRepoFiles(d.deps, planOf(checkout), "uncommitted")).rejects.toThrow("host disconnected");
  });
});

describe("recorded files", () => {
  it("merges several edits to one file into one row with summed counts", async () => {
    const plan = planOf({ kind: "recorded" }, new Map([
      ["a.ts", touched([record({ added: 2, removed: 1 }), record({ added: 3, removed: 0, threadId: "thr_2" })], ["thr_1", "thr_2"], ["a.ts", "/abs/a.ts"])],
      ["z.ts", touched([record({ path: "z.ts", kind: "add", added: 4 })], ["thr_1"], ["z.ts"])],
    ]));
    const result = await loadRepoFiles(deps().deps, plan, "uncommitted");
    if (!("files" in result)) throw new Error("expected files");
    expect(result).toMatchObject({ branch: null, base: null, aheadCount: null, truncated: false });
    expect(result.files).toEqual([
      {
        path: "a.ts", previousPath: null, status: "modified", additions: 5, deletions: 1, binary: false, untracked: false, tooLarge: false,
        edits: { threadIds: ["thr_1", "thr_2"], rawPaths: ["a.ts", "/abs/a.ts"], count: 2 },
      },
      {
        path: "z.ts", previousPath: null, status: "added", additions: 4, deletions: 0, binary: false, untracked: false, tooLarge: false,
        edits: { threadIds: ["thr_1"], rawPaths: ["z.ts"], count: 1 },
      },
    ]);
  });

  it("reads add as added, delete as deleted and a move as renamed", () => {
    expect(recordedFile("a", touched([record({ kind: "add" }), record({ kind: "update" })])).status).toBe("added");
    expect(recordedFile("a", touched([record({ kind: "update" }), record({ kind: "delete" })])).status).toBe("deleted");
    const moved = recordedFile("new.ts", touched([record({ path: "old.ts", movePath: "new.ts" })], ["thr_1"], ["old.ts", "new.ts"]));
    expect(moved).toMatchObject({ status: "renamed", path: "new.ts", previousPath: "old.ts" });
    expect(recordedFile("a", touched([record({ kind: "update" })])).status).toBe("modified");
  });
});

describe("loadPatch", () => {
  const input = (ref: RepoRef, overrides: Partial<PatchInput> = {}): PatchInput => ({
    ref, path: "src/a.ts", previousPath: null, untracked: false, scope: "uncommitted", sha: null, ...overrides,
  });

  it("returns the first patch bb's diffPatch gives for a workspace, with the scope's target", async () => {
    const { deps: d, diffPatch } = deps({
      diffPatch: { outcome: "available", patches: [{ path: "src/a.ts", patch: "--- a\n+++ b\n+x", truncated: true }, { path: "other", patch: "no", truncated: false }] },
    });
    expect(await loadPatch(d, input(workspace("origin/main")))).toEqual({ patch: "--- a\n+++ b\n+x", truncated: true, binary: false });
    await loadPatch(d, input(workspace("origin/main"), { scope: "branch" }));
    await loadPatch(d, input(workspace(null), { scope: "branch" }));
    expect(diffPatch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      { environmentId: "env_1", paths: ["src/a.ts"], target: { type: "uncommitted" }, signal: undefined },
      { environmentId: "env_1", paths: ["src/a.ts"], target: { type: "all", mergeBaseBranch: "origin/main" }, signal: undefined },
      { environmentId: "env_1", paths: ["src/a.ts"], target: { type: "uncommitted" }, signal: undefined },
    ]);
  });

  it("flags a binary patch and tolerates a missing one", async () => {
    const binary = deps({ diffPatch: { outcome: "available", patches: [{ path: "p.png", patch: "Binary files a/p.png and b/p.png differ\n", truncated: false }] } });
    expect(await loadPatch(binary.deps, input(workspace(null)))).toMatchObject({ binary: true });
    const empty = deps({ diffPatch: { outcome: "available", patches: [] } });
    expect(await loadPatch(empty.deps, input(workspace(null)))).toEqual({ patch: "", truncated: false, binary: false });
  });

  it("raises bb's message when a workspace patch is unavailable", async () => {
    const failed = deps({ diffPatch: { outcome: "unavailable", failure: { code: "unknown", message: "Cannot diff", workspacePath: "/x" } } });
    await expect(loadPatch(failed.deps, input(workspace(null)))).rejects.toThrow("Cannot diff");
    const na = deps({ diffPatch: { outcome: "not_applicable", reason: "non_git_environment", message: "Not git" } });
    await expect(loadPatch(na.deps, input(workspace(null)))).rejects.toThrow("Not git");
  });

  it("asks the host for a checkout's patch, with the untracked flag and rename source", async () => {
    const { deps: d, host } = deps({ host: { outcome: "available", patch: "+hello", truncated: false, binary: false } });
    const result = await loadPatch(d, input(checkout, { path: "new.md", previousPath: "old.md", untracked: true, scope: "branch" }));
    expect(result).toEqual({ patch: "+hello", truncated: false, binary: false });
    expect(host.mock.calls[0]).toEqual([
      "repoPatch",
      { root: "/repo", path: "new.md", previousPath: "old.md", untracked: true, target: { type: "merge-base", base: null } },
      { hostId: "host_1", signal: undefined },
    ]);
  });

  it("asks the host for a branch's patch over its range", async () => {
    const { deps: d, host } = deps({ host: { outcome: "available", patch: "+x", truncated: false, binary: false } });
    await loadPatch(d, input(branch));
    expect((host.mock.calls[0] as unknown[])[1]).toMatchObject({ target: { type: "range", base: "origin/main", head: "feature/old" } });
  });

  it("raises the host's reason, with a clearer message for a folder that is not a repository", async () => {
    const gone = deps({ host: { outcome: "unavailable", reason: "not-a-repo", message: "raw" } });
    await expect(loadPatch(gone.deps, input(checkout))).rejects.toThrow("This folder is no longer a git repository");
    const failed = deps({ host: { outcome: "unavailable", reason: "git-failed", message: "fatal: nope" } });
    await expect(loadPatch(failed.deps, input(checkout))).rejects.toThrow("fatal: nope");
  });

  it("refuses a recorded repository", async () => {
    await expect(loadPatch(deps().deps, input({ kind: "recorded" }))).rejects.toThrow("Use recordedEdits");
  });
});

describe("loadPatch committed and per-commit", () => {
  const SHA = "abc1234def";
  const input = (ref: RepoRef, overrides: Partial<PatchInput> = {}): PatchInput => ({
    ref, path: "src/a.ts", previousPath: null, untracked: false, scope: "committed", sha: null, ...overrides,
  });
  const patchCall = (call: unknown) => (call as unknown[])[0];

  it("asks bb for a workspace's committed changes against its base", async () => {
    const { deps: d, diffPatch } = deps({ diffPatch: { outcome: "available", patches: [{ path: "src/a.ts", patch: "+c", truncated: false }] } });
    expect(await loadPatch(d, input(workspace("origin/main")))).toEqual({ patch: "+c", truncated: false, binary: false });
    expect(patchCall(diffPatch.mock.calls[0])).toEqual({
      environmentId: "env_1", paths: ["src/a.ts"], target: { type: "branch_committed", mergeBaseBranch: "origin/main" }, signal: undefined,
    });
  });

  it("cannot show committed changes of a workspace that has no base", async () => {
    await expect(loadPatch(deps().deps, input(workspace(null)))).rejects.toThrow("no base");
  });

  it("asks bb for one commit's patch, whatever the scope", async () => {
    const { deps: d, diffPatch } = deps();
    await loadPatch(d, input(workspace("origin/main"), { sha: SHA }));
    await loadPatch(d, input(workspace(null), { sha: SHA, scope: "uncommitted" }));
    expect(diffPatch.mock.calls.map((call) => (patchCall(call) as { target: unknown }).target)).toEqual([
      { type: "commit", sha: SHA }, { type: "commit", sha: SHA },
    ]);
  });

  it("asks the host for a branch's committed range or for one of its commits", async () => {
    const { deps: d, host } = deps({ host: { outcome: "available", patch: "+x", truncated: false, binary: false } });
    await loadPatch(d, input(branch));
    await loadPatch(d, input(branch, { sha: SHA }));
    expect(host.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { root: "/repo", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "range", base: "origin/main", head: "feature/old" } },
      { root: "/repo", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "commit", sha: SHA } },
    ]);
  });

  it("rejects committed and sha for a checkout", async () => {
    await expect(loadPatch(deps().deps, input(checkout))).rejects.toThrow("not available");
    await expect(loadPatch(deps().deps, input(checkout, { scope: "uncommitted", sha: SHA }))).rejects.toThrow("not available");
  });
});

describe("loadCommitFiles", () => {
  const SHA = "abc1234def";

  it("maps the files bb lists for a workspace's commit like a workspace diff", async () => {
    const { deps: d, diffFiles } = deps({
      diffFiles: {
        ...AVAILABLE,
        files: [diffFile({ path: "b.ts", previousPath: "a.ts", changeKind: "renamed" }), diffFile({ path: "link", changeKind: "type_changed" })],
      },
    });
    const result = await loadCommitFiles(d, { ref: workspace("origin/main"), sha: SHA });
    expect(diffFiles.mock.calls[0]?.[0]).toEqual({ environmentId: "env_1", target: "commit", sha: SHA, signal: undefined });
    expect(result.files.map((file) => [file.path, file.previousPath, file.status, file.edits])).toEqual([
      ["b.ts", "a.ts", "renamed", null], ["link", null, "type-changed", null],
    ]);
  });

  it("raises bb's message when a workspace's commit cannot be listed", async () => {
    const failed = deps({ diffFiles: { outcome: "unavailable", failure: { code: "unknown", message: "No such commit", workspacePath: "/x" } } });
    await expect(loadCommitFiles(failed.deps, { ref: workspace(null), sha: SHA })).rejects.toThrow("No such commit");
    const na = deps({ diffFiles: { outcome: "not_applicable", reason: "non_git_environment", message: "Not git" } });
    await expect(loadCommitFiles(na.deps, { ref: workspace(null), sha: SHA })).rejects.toThrow("Not git");
  });

  it("asks the host for a branch's commit", async () => {
    const { deps: d, host } = deps({
      host: {
        outcome: "available", branch: null, base: null, aheadCount: null, behindCount: null, commits: [], truncated: false,
        files: [{ path: "a.ts", previousPath: null, status: "added", additions: 2, deletions: 0, binary: false }],
      },
    });
    const result = await loadCommitFiles(d, { ref: branch, sha: SHA });
    expect(host.mock.calls[0]).toEqual(["repoFiles", { root: "/repo", target: { type: "commit", sha: SHA } }, { hostId: "host_1", signal: undefined }]);
    expect(result.files).toEqual([
      { path: "a.ts", previousPath: null, status: "added", additions: 2, deletions: 0, binary: false, untracked: false, tooLarge: false, edits: null },
    ]);
    const failed = deps({ host: { outcome: "unavailable", reason: "git-failed", message: "The commit was not found" } });
    await expect(loadCommitFiles(failed.deps, { ref: branch, sha: SHA })).rejects.toThrow("The commit was not found");
  });

  it("rejects a checkout and a recorded repository", async () => {
    await expect(loadCommitFiles(deps().deps, { ref: checkout, sha: SHA })).rejects.toThrow("not available");
    await expect(loadCommitFiles(deps().deps, { ref: { kind: "recorded" }, sha: SHA })).rejects.toThrow("not available");
  });
});
