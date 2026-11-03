import { describe, expect, it, vi } from "vitest";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { CollectDeps, HostCall, RepoPlan, Touched } from "../src/collect";
import type { GitFile, HostOutput, PatchInput, RepoRef } from "../src/contract";
import type { EditRecord } from "../src/edits";
import { loadCommitFiles, loadFileSides, loadPatch, loadRepoFiles, loadWorkspaceStatus, recordedFile } from "../src/sources";

const gitFile = (overrides: Partial<GitFile> = {}): GitFile => ({
  path: "src/a.ts", previousPath: null, status: "modified", additions: 2, deletions: 1, binary: false, ...overrides,
});

const checkoutStatus = (overrides: Partial<Extract<HostOutput<"checkoutStatus">, { outcome: "available" }>> = {}): HostOutput<"checkoutStatus"> => ({
  outcome: "available", branch: "feature/work", head: "f".repeat(40), base: "origin/main", skippedBase: null, aheadCount: 0, behindCount: 0,
  commits: [], uncommitted: [], committed: [], truncated: false, ...overrides,
});

// `status` answers checkoutStatus; `host` answers every other host method.
function deps(overrides: { host?: unknown; status?: unknown } = {}) {
  const host = vi.fn(async (method: string, ..._args: unknown[]) => (method === "checkoutStatus" ? (overrides.status ?? checkoutStatus()) : (overrides.host ?? {
    outcome: "available", branch: null, base: null, aheadCount: null, behindCount: null, commits: [], files: [], truncated: false,
  })));
  return { deps: { sdk: {} as PluginBbSdk, host: host as unknown as HostCall, edits: {} as CollectDeps["edits"] }, host };
}

const planOf = (ref: RepoRef, touched: Map<string, Touched> = new Map()): RepoPlan => ({
  key: "k", ref, label: "L", projectId: "proj_1", root: "/repo", hostId: "host_1", threadIds: ["thr_1"], touched,
});
const workspace = (base: string | null): RepoRef => ({ kind: "workspace", environmentId: "env_1", base, root: "/repos/mono", hostId: "host_1" });
const gitWorkspace: RepoRef = { kind: "workspace", environmentId: "env_1", base: "origin/main", root: "/repos/mono", hostId: "host_1" };
const checkout: RepoRef = { kind: "checkout", hostId: "host_1", root: "/repo", base: null };
const branch: RepoRef = { kind: "branch", hostId: "host_1", root: "/repo", base: "origin/main", head: "feature/old" };

const record = (overrides: Partial<EditRecord> = {}): EditRecord => ({
  threadId: "thr_1", path: "a.ts", movePath: null, kind: "update", added: 1, removed: 0, at: 1, ...overrides,
});
const touched = (records: EditRecord[], threadIds = ["thr_1"], rawPaths = ["a.ts"]): Touched => ({
  threadIds: new Set(threadIds), rawPaths: new Set(rawPaths), records,
});

describe("loadWorkspaceStatus", () => {
  it("reads a workspace with git at its repository root, like a checkout, with the counting settings", async () => {
    const { deps: d, host } = deps({ status: checkoutStatus({ base: "origin/feature/work", skippedBase: { name: "origin/main", aheadCount: 9 } }) });
    const status = await loadWorkspaceStatus(d, workspace("origin/main") as Extract<RepoRef, { kind: "workspace" }>, ["thr_1"]);
    expect(host.mock.calls).toEqual([[
      "checkoutStatus", { root: "/repos/mono", base: "origin/main", pick: true, folderLimit: 200 }, { hostId: "host_1", signal: undefined },
    ]]);
    expect(status).toMatchObject({ state: "ready", branch: "feature/work", base: "origin/feature/work", skippedBase: { name: "origin/main", aheadCount: 9 } });
    const counted = { ...d, counting: { pick: true, folderLimit: 30, historyThreshold: 50, historyShare: 10 } };
    await loadWorkspaceStatus(counted, workspace(null) as Extract<RepoRef, { kind: "workspace" }>, ["thr_1"], undefined, false);
    expect(host.mock.calls[1]?.[1]).toEqual({ root: "/repos/mono", base: null, pick: false, folderLimit: 30 });
  });

  it("refuses a workspace ref that does not say where its repository is", async () => {
    const { deps: d, host } = deps();
    expect(() => loadWorkspaceStatus(d, { kind: "workspace", environmentId: "env_1", base: null }, ["thr_1"])).toThrow("refresh Vantage");
    expect(host).not.toHaveBeenCalled();
  });
});

describe("loadRepoFiles targets", () => {
  it("reads a workspace's uncommitted changes from its status and, for the branch scope, diffs everything since its merge base", async () => {
    const { deps: d, host } = deps();
    await loadRepoFiles(d, planOf(workspace("origin/main")), "uncommitted");
    await loadRepoFiles(d, planOf(workspace("origin/main")), "branch");
    expect(host.mock.calls).toEqual([
      ["checkoutStatus", { root: "/repos/mono", base: "origin/main", pick: true, folderLimit: 200 }, { hostId: "host_1", signal: undefined }],
      ["repoFiles", { root: "/repos/mono", target: { type: "merge-base", base: "origin/main" }, folderLimit: 200 }, { hostId: "host_1", signal: undefined }],
    ]);
  });

  it("reports the base a workspace was compared with", async () => {
    const { deps: d } = deps({ host: { outcome: "available", branch: null, base: "origin/main", aheadCount: 1, behindCount: 0, commits: [], files: [], truncated: false } });
    expect(await loadRepoFiles(d, planOf(workspace("origin/main")), "branch")).toMatchObject({ base: "origin/main", aheadCount: 1 });
    expect(await loadRepoFiles(d, planOf(workspace("origin/main")), "uncommitted")).toMatchObject({ base: null, aheadCount: null });
  });

  it("asks the host for a checkout's uncommitted changes or its changes since the merge base", async () => {
    const { deps: d, host } = deps();
    await loadRepoFiles(d, planOf(checkout), "uncommitted");
    await loadRepoFiles(d, planOf(checkout), "branch");
    expect(host.mock.calls).toEqual([
      ["repoFiles", { root: "/repo", target: { type: "uncommitted" }, folderLimit: 200 }, { hostId: "host_1", signal: undefined }],
      ["repoFiles", { root: "/repo", target: { type: "merge-base", base: null }, folderLimit: 200 }, { hostId: "host_1", signal: undefined }],
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
  it("maps a workspace's files, including untracked, renamed, type-changed, binary and folded ones", async () => {
    const folder = { files: 900, repository: false, sample: ["vendor/a.js"] };
    const { deps: d } = deps({
      host: {
        outcome: "available", branch: null, base: "origin/main", aheadCount: 1, behindCount: 0, commits: [], truncated: true,
        files: [
          gitFile({ path: "new.txt", status: "untracked", additions: 3, deletions: 0 }),
          gitFile({ path: "b.ts", previousPath: "a.ts", status: "renamed" }),
          gitFile({ path: "link", status: "type-changed" }),
          gitFile({ path: "pic.png", status: "added", binary: true, additions: null, deletions: null }),
          gitFile({ path: "vendor/", status: "untracked", additions: null, deletions: null, folder }),
        ],
      },
    });
    const result = await loadRepoFiles(d, planOf(workspace("origin/main")), "branch");
    if (!("files" in result)) throw new Error("expected files");
    expect(result.truncated).toBe(true);
    expect(result.files).toEqual([
      { path: "new.txt", previousPath: null, status: "untracked", additions: 3, deletions: 0, binary: false, untracked: true, tooLarge: false, edits: null },
      { path: "b.ts", previousPath: "a.ts", status: "renamed", additions: 2, deletions: 1, binary: false, untracked: false, tooLarge: false, edits: null },
      { path: "link", previousPath: null, status: "type-changed", additions: 2, deletions: 1, binary: false, untracked: false, tooLarge: false, edits: null },
      { path: "pic.png", previousPath: null, status: "added", additions: null, deletions: null, binary: true, untracked: false, tooLarge: false, edits: null },
      { path: "vendor/", previousPath: null, status: "untracked", additions: null, deletions: null, binary: false, untracked: true, tooLarge: false, edits: null, folder },
    ]);
  });

  it("maps a workspace's uncommitted files from its status, with the counts git reports", async () => {
    const { deps: d } = deps({
      status: checkoutStatus({
        truncated: true,
        uncommitted: [
          gitFile({ path: "a.ts" }),
          gitFile({ path: "new.txt", status: "untracked", additions: 3, deletions: 0 }),
          gitFile({ path: "pic.png", status: "added", additions: null, deletions: null, binary: true }),
        ],
        committed: [gitFile({ path: "committed.ts" })],
      }),
    });
    const result = await loadRepoFiles(d, planOf(workspace("origin/main")), "uncommitted");
    expect(result).toEqual({
      branch: null, base: null, aheadCount: null, truncated: true,
      files: [
        { path: "a.ts", previousPath: null, status: "modified", additions: 2, deletions: 1, binary: false, untracked: false, tooLarge: false, edits: null },
        { path: "new.txt", previousPath: null, status: "untracked", additions: 3, deletions: 0, binary: false, untracked: true, tooLarge: false, edits: null },
        { path: "pic.png", previousPath: null, status: "added", additions: null, deletions: null, binary: true, untracked: false, tooLarge: false, edits: null },
      ],
    });
  });

  it("makes a workspace unavailable with the host's message", async () => {
    const gone = { outcome: "unavailable", reason: "not-a-repo", message: "raw" };
    const failed = { outcome: "unavailable", reason: "git-failed", message: "Folder is gone" };
    expect(await loadRepoFiles(deps({ status: gone }).deps, planOf(workspace(null)), "uncommitted")).toEqual({ unavailable: "This folder is no longer a git repository" });
    expect(await loadRepoFiles(deps({ status: failed }).deps, planOf(workspace(null)), "uncommitted")).toEqual({ unavailable: "Folder is gone" });
    expect(await loadRepoFiles(deps({ host: failed }).deps, planOf(workspace("origin/main")), "branch")).toEqual({ unavailable: "Folder is gone" });
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

  it("raises the host's message when a workspace patch is unavailable", async () => {
    const failed = deps({ host: { outcome: "unavailable", reason: "git-failed", message: "Cannot diff" } });
    await expect(loadPatch(failed.deps, input(workspace(null)))).rejects.toThrow("Cannot diff");
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

  it("asks the host for a branch's committed range or for one of its commits", async () => {
    const { deps: d, host } = deps({ host: { outcome: "available", patch: "+x", truncated: false, binary: false } });
    await loadPatch(d, input(branch));
    await loadPatch(d, input(branch, { sha: SHA }));
    expect(host.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { root: "/repo", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "range", base: "origin/main", head: "feature/old" } },
      { root: "/repo", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "commit", sha: SHA } },
    ]);
  });

  it("asks the host at the repository root for every patch of a workspace", async () => {
    const { deps: d, host } = deps({ host: { outcome: "available", patch: "+x", truncated: false, binary: false } });
    await loadPatch(d, input(gitWorkspace, { scope: "uncommitted" }));
    await loadPatch(d, input(gitWorkspace, { scope: "branch" }));
    await loadPatch(d, input(gitWorkspace));
    await loadPatch(d, input(gitWorkspace, { sha: SHA }));
    expect(host.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { root: "/repos/mono", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "uncommitted" } },
      { root: "/repos/mono", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "merge-base", base: "origin/main" } },
      { root: "/repos/mono", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "committed", base: "origin/main" } },
      { root: "/repos/mono", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "commit", sha: SHA } },
    ]);
  });

  it("asks the host for a checkout's commits since its merge base, or for one of its commits", async () => {
    const { deps: d, host } = deps({ host: { outcome: "available", patch: "+x", truncated: false, binary: false } });
    await loadPatch(d, input(checkout));
    await loadPatch(d, input(checkout, { scope: "uncommitted", sha: SHA }));
    expect(host.mock.calls.map((call) => ((call as unknown[])[1] as { target: unknown }).target)).toEqual([
      { type: "committed", base: null }, { type: "commit", sha: SHA },
    ]);
  });
});

describe("loadCommitFiles", () => {
  const SHA = "abc1234def";

  it("raises the host's message when a workspace's commit cannot be listed", async () => {
    const failed = deps({ host: { outcome: "unavailable", reason: "git-failed", message: "No such commit" } });
    await expect(loadCommitFiles(failed.deps, { ref: workspace(null), sha: SHA })).rejects.toThrow("No such commit");
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

  it("asks the host at the repository root for the commit of a workspace", async () => {
    const { deps: d, host } = deps({
      host: { outcome: "available", branch: null, base: null, aheadCount: null, behindCount: null, commits: [], truncated: false, files: [] },
    });
    await loadCommitFiles(d, { ref: gitWorkspace, sha: SHA });
    expect(host.mock.calls[0]).toEqual(["repoFiles", { root: "/repos/mono", target: { type: "commit", sha: SHA } }, { hostId: "host_1", signal: undefined }]);
  });

  it("asks the host for a checkout's commit", async () => {
    const { deps: d, host } = deps({
      host: { outcome: "available", branch: null, base: null, aheadCount: null, behindCount: null, commits: [], truncated: false, files: [] },
    });
    await loadCommitFiles(d, { ref: checkout, sha: SHA });
    expect(host.mock.calls[0]?.[1]).toEqual({ root: checkout.root, target: { type: "commit", sha: SHA } });
  });

  it("rejects a recorded repository", async () => {
    await expect(loadCommitFiles(deps().deps, { ref: { kind: "recorded" }, sha: SHA })).rejects.toThrow("not available");
  });
});

describe("loadFileSides", () => {
  const input = (scope: PatchInput["scope"], extra: Partial<PatchInput> = {}): PatchInput => ({
    ref: workspace("origin/main"), path: "src/a.ts", previousPath: null, untracked: false, scope, sha: null, ...extra,
  });

  it("asks the host at a workspace's repository root for both sides, with each scope's target", async () => {
    const { deps: d, host } = deps({ host: { outcome: "available", old: "old", new: "new" } });
    expect(await loadFileSides(d, input("committed"))).toEqual({ old: "old", new: "new" });
    await loadFileSides(d, input("branch"));
    await loadFileSides(d, input("uncommitted", { previousPath: "src/old.ts", untracked: true }));
    await loadFileSides(d, input("committed", { sha: "c".repeat(40) }));
    expect(host.mock.calls).toEqual([
      ["fileSides", { root: "/repos/mono", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "committed", base: "origin/main" } }, { hostId: "host_1", signal: undefined }],
      ["fileSides", { root: "/repos/mono", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "merge-base", base: "origin/main" } }, { hostId: "host_1", signal: undefined }],
      ["fileSides", { root: "/repos/mono", path: "src/a.ts", previousPath: "src/old.ts", untracked: true, target: { type: "uncommitted" } }, { hostId: "host_1", signal: undefined }],
      ["fileSides", { root: "/repos/mono", path: "src/a.ts", previousPath: null, untracked: false, target: { type: "commit", sha: "c".repeat(40) } }, { hostId: "host_1", signal: undefined }],
    ]);
  });

  it("raises the host's message, and answers a recorded repository with no sides", async () => {
    const failed = deps({ host: { outcome: "unavailable", reason: "git-failed", message: "host offline" } });
    await expect(loadFileSides(failed.deps, input("uncommitted"))).rejects.toThrow("host offline");
    expect(await loadFileSides(failed.deps, input("uncommitted", { ref: { kind: "recorded" } }))).toEqual({ old: null, new: null });
    expect(failed.host).toHaveBeenCalledTimes(1);
  });
});
