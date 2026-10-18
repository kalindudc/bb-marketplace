import type { PluginSidebarThread, PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import type { Environment } from "../src/collect";
import type { Commit, FileChange, Overview, Repo, SharedFile, ThreadSummary, Worktree } from "../src/contract";

export function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    baseBranch: null,
    branchName: "feature/work",
    createdAt: 1,
    defaultBranch: "main",
    environmentProviderId: null,
    environmentProviderInstanceKey: null,
    environmentProviderSelection: null,
    hostId: "host_1",
    hostLifecycle: "active",
    id: "env_1",
    isGitRepo: true,
    isWorktree: true,
    lifecycle: { phase: "active", retireAt: null, teardown: null },
    managed: true,
    mergeBaseBranch: "origin/main",
    name: null,
    path: "/work/one",
    projectId: "proj_1",
    status: "ready",
    updatedAt: 1,
    workspaceProvisionType: "managed-worktree",
    ...overrides,
  };
}

export function destroyedEnvironment(overrides: Partial<Environment> = {}): Environment {
  return environment({
    status: "destroyed",
    lifecycle: { phase: "destroyed", retireAt: null, teardown: null },
    path: null,
    ...overrides,
  });
}

export function threadSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id: "thr_1", title: "Parent thread", parentThreadId: null, archived: false, depth: 0, environmentId: "env_1", status: "idle", rootThreadId: "thr_1", ...overrides };
}

export function fileChange(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: "src/a.ts", previousPath: null, status: "modified", additions: 2, deletions: 1, binary: false,
    untracked: false, tooLarge: false, edits: null, ...overrides,
  };
}

const repoBase: Repo = {
  key: "host_1:/work/one",
  ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" },
  label: "Project",
  projectId: "proj_1",
  root: "/work/one",
  hostId: "host_1",
  hostName: "Laptop",
  branch: "feature/work",
  base: null,
  aheadCount: null,
  threadIds: ["thr_1"],
  state: "ready",
  message: null,
  files: [],
  otherFiles: [],
  truncated: false,
  totals: { files: 0, additions: 0, deletions: 0 },
};

export function repo(overrides: Partial<Repo> = {}): Repo {
  const files = overrides.files ?? [];
  const totals = overrides.totals ?? {
    files: files.filter((file) => file.status !== "clean").length,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
  return { ...repoBase, ...overrides, files, totals };
}

export function checkoutRepo(overrides: Partial<Repo> = {}): Repo {
  return repo({
    key: "host_1:/code/cortex", ref: { kind: "checkout", hostId: "host_1", root: "/code/cortex", base: null },
    label: "cortex", root: "/code/cortex", branch: "main", ...overrides,
  });
}

export function branchRepo(overrides: Partial<Repo> = {}): Repo {
  return repo({
    key: "host_1:/code/proj@feature/old",
    ref: { kind: "branch", hostId: "host_1", root: "/code/proj", base: "origin/main", head: "feature/old" },
    label: "Project", root: "/code/proj", branch: "feature/old", base: "origin/main", aheadCount: 3, threadIds: ["thr_2"], ...overrides,
  });
}

export function recordedRepo(overrides: Partial<Repo> = {}): Repo {
  return repo({
    key: "recorded:env_9", ref: { kind: "recorded" }, label: "Removed workspace", root: null, hostId: "host_1",
    branch: null, threadIds: ["thr_3"], ...overrides,
  });
}

export function commit(overrides: Partial<Commit> = {}): Commit {
  return { sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", shortSha: "a1b2c3d", subject: "Add the thing", authorName: "Ada", authoredAt: 1_700_000_000_000, ...overrides };
}

const worktreeBase: Worktree = {
  key: "host_1:/work/one",
  ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" },
  label: "Project",
  projectId: "proj_1",
  hostId: "host_1",
  hostName: "Laptop",
  root: "/work/one",
  branch: "feature/work",
  base: "origin/main",
  kind: "workspace",
  threadIds: ["thr_1"],
  state: "ready",
  message: null,
  aheadCount: 0,
  behindCount: 0,
  uncommitted: [],
  committed: [],
  commits: [],
};

export function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return { ...worktreeBase, ...overrides };
}

export function branchWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return worktree({
    key: "host_1:/code/proj@feature/old",
    ref: { kind: "branch", hostId: "host_1", root: "/code/proj", base: "origin/main", head: "feature/old" },
    kind: "branch", root: "/code/proj", branch: "feature/old", threadIds: ["thr_2"], aheadCount: 1, ...overrides,
  });
}

export function sharedFile(overrides: Partial<SharedFile> = {}): SharedFile {
  return { projectId: "proj_1", path: "README.md", worktreeKeys: ["host_1:/work/one", "host_1:/work/two"], ...overrides };
}

export function overview(overrides: Partial<Overview> = {}): Overview {
  return {
    threadId: "thr_1",
    target: { kind: "tree", threadId: "thr_1" },
    windowHours: null,
    scope: "uncommitted",
    threads: [threadSummary()],
    repos: [],
    worktrees: [],
    sharedFiles: [],
    otherFiles: [],
    environmentIds: ["env_1"],
    warnings: [],
    truncatedThreads: false,
    generatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** An all-threads overview over two projects: Shop (a parent, its child and an idle worktree) and Docs site (one worktree). */
export function allOverview(overrides: Partial<Overview> = {}): Overview {
  const threads = [
    threadSummary({ id: "thr_root", title: "Parent thread", environmentId: "env_1", rootThreadId: "thr_root", status: "active" }),
    threadSummary({ id: "thr_child", title: "Child worker", parentThreadId: "thr_root", depth: 1, environmentId: "env_2", rootThreadId: "thr_root" }),
    threadSummary({ id: "thr_docs", title: "Docs thread", environmentId: "env_3", rootThreadId: "thr_docs" }),
    threadSummary({ id: "thr_idle", title: "Idle thread", environmentId: "env_4", rootThreadId: "thr_idle" }),
  ];
  const parent = worktree({
    key: "k_parent", label: "Shop", projectId: "proj_shop", root: "/work/shop", branch: "feature/main", threadIds: ["thr_root"],
    ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" }, uncommitted: [fileChange({ path: "src/app.ts", additions: 4, deletions: 1 })],
  });
  const child = worktree({
    key: "k_child", label: "Shop", projectId: "proj_shop", root: "/work/shop-child", branch: "agent/child", threadIds: ["thr_child"],
    ref: { kind: "workspace", environmentId: "env_2", base: "origin/main" }, aheadCount: 1,
    uncommitted: [fileChange({ path: "src/child.ts", additions: 2, deletions: 0 }), fileChange({ path: "README.md", additions: 1, deletions: 1 })],
    committed: [fileChange({ path: "lib/done.ts", additions: 9, deletions: 0 })],
    commits: [commit({ subject: "Finish the lib" })],
  });
  const docs = worktree({
    key: "k_docs", label: "Docs site", projectId: "proj_docs", root: "/work/docs", branch: "agent/docs", threadIds: ["thr_docs"],
    ref: { kind: "workspace", environmentId: "env_3", base: "origin/main" }, aheadCount: 2, committed: [fileChange({ path: "guide.md", additions: 7, deletions: 2 })],
  });
  const idle = worktree({
    key: "k_idle", label: "Shop", projectId: "proj_shop", root: "/work/shop-idle", branch: "agent/idle", threadIds: ["thr_idle"],
    ref: { kind: "workspace", environmentId: "env_4", base: "origin/main" },
  });
  const worktrees = [parent, child, docs, idle];
  const repos = worktrees.map((entry) => repo({
    key: entry.key, label: entry.label, projectId: entry.projectId, root: entry.root, branch: entry.branch, threadIds: entry.threadIds,
    ref: entry.ref as Repo["ref"], files: [...entry.uncommitted, ...entry.committed],
  }));
  return overview({
    threadId: "", target: { kind: "all" }, windowHours: 24, threads, worktrees, repos,
    environmentIds: ["env_1", "env_2", "env_3", "env_4"], ...overrides,
  });
}

export function sidebarThread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  const id = overrides.id ?? "thr_1";
  return {
    id,
    projectId: "proj_1",
    title: "Parent thread",
    titleFallback: null,
    displayTitle: "Parent thread",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "pi",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: `/projects/proj_1/threads/${id}`,
    isHidden: false,
    environment: { id: "env_1", name: null, branchName: "feature/work", path: "/work/one", isWorktree: true, providerId: null, workspaceDisplayKind: null },
    host: { id: "host_1", name: "Laptop" },
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 1,
    ...overrides,
  };
}

export function sidebarPullRequest(overrides: Partial<PluginSidebarPullRequest> = {}): PluginSidebarPullRequest {
  return {
    experimental_autoMerge: false, experimental_inMergeQueue: null,
    experimental_checks: { state: "passing" }, experimental_review: { state: "none" }, experimental_mergeability: { state: "mergeable" },
    number: 42, title: "Add the thing", url: "https://example.com/pull/42", state: "open", attention: "none", ...overrides,
  };
}
