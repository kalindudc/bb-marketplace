import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER, filterRepos, filterWorktrees, projectOptions, type PageFilter } from "../src/filters";
import {
  branchWorktree, checkoutRepo, fileChange, overview as makeOverview, repo, threadSummary, worktree,
} from "./fixtures";

const filter = (overrides: Partial<PageFilter> = {}): PageFilter => ({ ...DEFAULT_FILTER, ...overrides });
const everything = filter({ changedOnly: false });

const sample = makeOverview({
  target: { kind: "all" },
  threads: [
    threadSummary({ id: "thr_1", title: "Fix the login bug" }),
    threadSummary({ id: "thr_2", title: "Write the Docs", environmentId: "env_2" }),
    threadSummary({ id: "thr_3", title: "Idle helper", environmentId: "env_3" }),
    threadSummary({ id: "thr_4", title: "Gone thread", archived: true, environmentId: "env_4" }),
    threadSummary({ id: "thr_5", title: "Broken thread", environmentId: "env_5" }),
  ],
  worktrees: [
    worktree({ key: "wt1", threadIds: ["thr_1"], label: "Shop", projectId: "proj_shop", root: "/work/shop-1", branch: "agent/login", uncommitted: [fileChange({ path: "src/auth/login.ts" })] }),
    worktree({ key: "wt2", threadIds: ["thr_2"], label: "Docs site", projectId: "proj_docs", root: "/work/docs", branch: "agent/docs", committed: [fileChange({ path: "README.md" })] }),
    worktree({ key: "wt3", threadIds: ["thr_3"], label: "Shop", projectId: "proj_shop", root: "/work/shop-2", branch: "agent/idle" }),
    branchWorktree({ key: "wt4", threadIds: ["thr_4"], label: "Shop", projectId: "proj_shop", root: "/code/shop", branch: "agent/old" }),
    worktree({ key: "wt5", threadIds: ["thr_5"], label: "Docs site", projectId: "proj_docs", root: "/work/docs-2", branch: null, state: "unavailable", message: "Folder is gone" }),
  ],
  repos: [
    repo({ key: "r1", label: "Shop", projectId: "proj_shop", root: "/work/shop-1", files: [fileChange({ path: "src/auth/login.ts" })] }),
    repo({ key: "r2", label: "Docs site", projectId: "proj_docs", root: "/work/docs", files: [fileChange({ path: "README.md" })] }),
    repo({ key: "r3", label: "Shop", projectId: "proj_shop", root: "/work/shop-2", files: [] }),
    checkoutRepo({ key: "r4", label: "cortex", projectId: "proj_cortex", root: "/code/cortex", files: [], otherFiles: [fileChange({ path: "tasks/todo.md" })] }),
    checkoutRepo({ key: "r5", label: "scripts", projectId: null, root: "/code/scripts", files: [fileChange({ path: "run.sh" })] }),
    repo({ key: "r6", label: "Docs site", projectId: "proj_docs", root: "/work/docs-2", state: "unavailable", message: "Folder is gone", files: [] }),
    repo({ key: "r7", label: "Shop", projectId: "proj_shop", root: "/work/shop-3", files: [fileChange({ path: "done.ts", status: "clean", additions: null, deletions: null })] }),
  ],
  otherFiles: [fileChange({ path: "/tmp/notes.txt" })],
});

const keys = (items: Array<{ key: string }>) => items.map((item) => item.key);

describe("DEFAULT_FILTER", () => {
  it("shows every project and hides what has no changes", () => {
    expect(DEFAULT_FILTER).toEqual({ text: "", projectId: null, changedOnly: true });
  });
});

describe("filterWorktrees", () => {
  it("shows everything when only changed worktrees are not asked for", () => {
    expect(keys(filterWorktrees(sample, everything))).toEqual(["wt1", "wt2", "wt3", "wt4", "wt5"]);
  });

  it("with changes only, hides a worktree with no uncommitted or committed files, and keeps an unavailable one", () => {
    expect(keys(filterWorktrees(sample, filter()))).toEqual(["wt1", "wt2", "wt5"]);
  });

  it("keeps a worktree with only committed files", () => {
    expect(keys(filterWorktrees(sample, filter({ text: "docs site" })))).toContain("wt2");
  });

  it("filters by project id", () => {
    expect(keys(filterWorktrees(sample, filter({ projectId: "proj_shop", changedOnly: false })))).toEqual(["wt1", "wt3", "wt4"]);
    expect(keys(filterWorktrees(sample, filter({ projectId: "proj_shop" })))).toEqual(["wt1"]);
    expect(filterWorktrees(sample, filter({ projectId: "proj_missing" }))).toEqual([]);
  });

  it.each([
    ["a thread title, ignoring case", "FIX THE LOGIN", ["wt1"]],
    ["the label", "docs site", ["wt2", "wt5"]],
    ["the branch", "agent/docs", ["wt2"]],
    ["the root", "shop-2", ["wt3"]],
    ["an uncommitted file path", "auth/login", ["wt1"]],
    ["a committed file path", "readme", ["wt2"]],
    ["nothing", "no such thing", []],
  ])("matches text against %s", (_name, text, expected) => {
    expect(keys(filterWorktrees(sample, filter({ text, changedOnly: false })))).toEqual(expected);
  });

  it("trims the text and treats a blank one as no filter", () => {
    expect(keys(filterWorktrees(sample, filter({ text: "   ", changedOnly: false })))).toHaveLength(5);
    expect(keys(filterWorktrees(sample, filter({ text: "  agent/docs  ", changedOnly: false })))).toEqual(["wt2"]);
  });

  it("applies the project, the text and the changed-only filters together", () => {
    expect(keys(filterWorktrees(sample, filter({ projectId: "proj_docs", text: "docs", changedOnly: true })))).toEqual(["wt2", "wt5"]);
    expect(keys(filterWorktrees(sample, filter({ projectId: "proj_shop", text: "docs" })))).toEqual([]);
  });
});

describe("loading rows with changes only", () => {
  const loadingWorktree = branchWorktree({ key: "wt9", threadIds: ["thr_4"], state: "loading", committed: [] });
  const loadingRepo = repo({ key: "r9", threadIds: ["thr_4"], state: "loading", files: [] });

  it("keeps them in the first outline, which has no numbers yet for any row", () => {
    const partial = makeOverview({ partial: true, threads: sample.threads, worktrees: [loadingWorktree], repos: [loadingRepo] });
    expect(keys(filterWorktrees(partial, filter()))).toEqual(["wt9"]);
    expect(keys(filterRepos(partial, filter()).repos)).toEqual(["r9"]);
  });

  it("holds them back once the other rows have numbers, until their own changes are known", () => {
    const merged = makeOverview({ threads: sample.threads, worktrees: [...sample.worktrees, loadingWorktree], repos: [...sample.repos, loadingRepo] });
    expect(keys(filterWorktrees(merged, filter()))).not.toContain("wt9");
    expect(keys(filterRepos(merged, filter()).repos)).not.toContain("r9");
    expect(keys(filterWorktrees(merged, everything))).toContain("wt9");
  });
});

describe("filterRepos", () => {
  it("shows every repository and the other files when nothing is filtered", () => {
    const shown = filterRepos(sample, everything);
    expect(keys(shown.repos)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    expect(shown.otherFiles.map((file) => file.path)).toEqual(["/tmp/notes.txt"]);
  });

  it("with changes only, hides a repository with no files and no other files, but keeps one that could not be read", () => {
    expect(keys(filterRepos(sample, filter()).repos)).toEqual(["r1", "r2", "r4", "r5", "r6"]);
  });

  it("with changes only, hides a repository whose edited files have no change now, since those rows are only 'clean'", () => {
    expect(keys(filterRepos(sample, filter()).repos)).not.toContain("r7");
    expect(keys(filterRepos(sample, filter({ text: "done.ts", changedOnly: false })).repos)).toEqual(["r7"]);
  });

  it("filters by the project of each repository, a checkout's coming from its source", () => {
    expect(keys(filterRepos(sample, filter({ projectId: "proj_cortex" })).repos)).toEqual(["r4"]);
    expect(keys(filterRepos(sample, filter({ projectId: "proj_shop", changedOnly: false })).repos)).toEqual(["r1", "r3", "r7"]);
  });

  it("leaves a checkout that no project owns out of every project", () => {
    expect(keys(filterRepos(sample, filter({ projectId: "proj_docs" })).repos)).not.toContain("r5");
  });

  it("drops the other files, which belong to no project, when a project is chosen", () => {
    expect(filterRepos(sample, filter({ projectId: "proj_shop" })).otherFiles).toEqual([]);
  });

  it.each([
    ["the label, ignoring case", "DOCS SITE", ["r2", "r6"]],
    ["the root", "/code/scripts", ["r5"]],
    ["a file path", "auth/login", ["r1"]],
    ["the path of a file the threads did not edit", "tasks/todo", ["r4"]],
  ])("matches text against %s", (_name, text, expected) => {
    expect(keys(filterRepos(sample, filter({ text, changedOnly: false })).repos)).toEqual(expected);
  });

  it("matches text against the paths of the other files", () => {
    const shown = filterRepos(sample, filter({ text: "notes" }));
    expect(shown.otherFiles.map((file) => file.path)).toEqual(["/tmp/notes.txt"]);
    expect(shown.repos).toEqual([]);
    expect(filterRepos(sample, filter({ text: "login" })).otherFiles).toEqual([]);
  });
});

describe("projectOptions", () => {
  it("lists each project once, named after its repositories and worktrees and sorted by name", () => {
    expect(projectOptions(sample)).toEqual([
      { id: "proj_cortex", name: "cortex" },
      { id: "proj_docs", name: "Docs site" },
      { id: "proj_shop", name: "Shop" },
    ]);
  });

  it("leaves out a worktree or repository that has no project", () => {
    const bare = makeOverview({ worktrees: [worktree({ projectId: "" })], repos: [checkoutRepo({ projectId: null })] });
    expect(projectOptions(bare)).toEqual([]);
  });
});

describe("filters on the instant outline", () => {
  const outline = makeOverview({
    target: { kind: "all" },
    worktrees: [
      worktree({ key: "wl1", state: "loading", aheadCount: null, behindCount: null, branch: "agent/loading" }),
      worktree({ key: "wl2", state: "ready", branch: "agent/idle" }),
    ],
    repos: [repo({ key: "rl1", state: "loading" }), repo({ key: "rl2", state: "ready" })],
    partial: true,
  });

  it("keeps a worktree or repository that is still loading under 'With changes only', since its changes are not known yet", () => {
    expect(keys(filterWorktrees(outline, DEFAULT_FILTER))).toEqual(["wl1"]);
    expect(keys(filterRepos(outline, DEFAULT_FILTER).repos)).toEqual(["rl1"]);
  });

  it("still applies the text and project filters to loading rows", () => {
    expect(keys(filterWorktrees(outline, filter({ text: "agent/loading" })))).toEqual(["wl1"]);
    expect(keys(filterWorktrees(outline, filter({ text: "nothing like this" })))).toEqual([]);
    expect(keys(filterWorktrees(outline, filter({ projectId: "proj_other" })))).toEqual([]);
  });
});
