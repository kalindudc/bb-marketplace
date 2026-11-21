import { archivedLast } from "./archived";
import { incompleteWarning } from "./incomplete";
import { posix, win32 } from "node:path";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { EditIndex, EditRecord, ThreadEdits } from "./edits";
import {
  collectAll,
  FETCH_CONCURRENCY,
  loadEnvironments,
  RUNNING,
  summarizeThread,
  type AllOptions,
  type Collected,
} from "./collect-all";
import { MAX_ROOT_PATHS } from "./contract";
import type {
  FileChange,
  HostInput,
  HostMethod,
  HostOutput,
  Overview,
  OverviewTarget,
  Repo,
  RepoRef,
  Scope,
  ShellInput,
  ThreadSummary,
} from "./contract";
import { mapLimit } from "./limit";
import { createRepoCache, planCached, type RepoCache } from "./repo-cache";
import { createRootCache, type RootCache, type RootEntry } from "./root-cache";
import {
  loadRepoFiles,
  loadWorkspaceStatus,
  picksBase,
  readOverviewHost,
  recordedFile,
  recordedLiveFiles,
  type Counting,
  type LiveFiles,
} from "./sources";
import { attachThreadCommits, leaveOutHistory } from "./thread-commits";
import { findSharedFiles, loadingWorktrees, loadWorktrees } from "./worktrees";
import { atOrBelow, EXCLUDED_UNAVAILABLE, isExcludedProvider } from "./exclusion-gate";

export type Environment = Awaited<ReturnType<PluginBbSdk["environments"]["get"]>>;
export type HostCall = <M extends HostMethod>(
  method: M,
  input: HostInput<M>,
  options: { hostId: string; signal?: AbortSignal },
) => Promise<HostOutput<M>>;
/** `counting`: the counting settings, the defaults when left out. `whole`: worktrees the user asked to see whole, by key. */
export interface CollectDeps {
  sdk: PluginBbSdk;
  host: HostCall;
  edits: EditIndex;
  allOptions?: Omit<AllOptions, "now">;
  cache?: RepoCache;
  roots?: RootCache;
  counting?: Counting;
  whole?: ReadonlySet<string>;
  runtimeSignal?: AbortSignal;
  excludedProviders?: ReadonlySet<string>;
  rememberExcludedEnvironment?: (env: Environment) => void;
  deferHostRead?: <T>(hostId: string, read: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}

export interface Touched {
  threadIds: Set<string>;
  rawPaths: Set<string>;
  records: EditRecord[];
}
export interface RepoPlan {
  blocked?: string;
  key: string;
  ref: RepoRef;
  label: string;
  projectId: string | null;
  root: string | null;
  hostId: string | null;
  threadIds: string[];
  touched: Map<string, Touched>;
}
export interface ProjectInfo {
  id: string;
  name: string;
  sources: readonly { hostId: string; path: string; isDefault: boolean }[];
}
export interface HostInfo {
  id: string;
  name: string;
}
export type ResolvedRoots = ReadonlyMap<string, ReadonlyMap<string, RootEntry>>;

const MAX_THREADS = 200;
const MAX_FILES = 500;
const MAX_OTHER_FILES = 200;
// Leave room in the host's background deadline for every directory to require Git.
const ROOT_BATCH_SIZE = Math.min(128, MAX_ROOT_PATHS);
const MAX_PATH_LENGTH = 4096;
const MAX_MESSAGE = 1000;

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE);
const isAbsolute = (path: string): boolean => /^([/\\]|[A-Za-z]:[\\/])/.test(path);
const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

type LiveEnvironment = Environment & { path: string };
// bb keeps an archived thread's worktree on disk for a while ("retiring") before it destroys it.
const isLive = (env: Environment): env is LiveEnvironment =>
  env.status === "ready" &&
  (env.lifecycle.phase === "active" || env.lifecycle.phase === "retiring") &&
  env.isGitRepo &&
  env.path !== null;
const isDestroyed = (env: Environment): boolean =>
  env.status === "destroyed" || env.lifecycle.phase === "destroyed" || env.path === null;
const baseOf = (env: Environment): string | null => env.mergeBaseBranch ?? env.defaultBranch ?? null;
// Vantage reads every workspace with git at its repository root, on its machine. A folder below the root is read there too,
// so its paths are the repository's.
function workspaceRef(
  env: LiveEnvironment,
  found: RootEntry | null | undefined,
): { ref: Extract<RepoRef, { kind: "workspace" }>; root: string; below: boolean } {
  const root = found?.root ?? env.path;
  const below = found != null && found.root !== null && found.relative !== null && found.relative !== "";
  return {
    ref: { kind: "workspace", environmentId: env.id, base: baseOf(env), root, hostId: env.hostId },
    root,
    below,
  };
}

// A worktree's own thread speaks for it: the one nearest the tree's root, such as the parent reviewers ran beside.
function ownerFirst<T extends { threadIds: string[] }>(
  worktrees: readonly T[],
  threads: readonly ThreadSummary[],
): T[] {
  const depth = new Map(threads.map((thread) => [thread.id, thread.depth]));
  return worktrees.map((worktree) => ({
    ...worktree,
    threadIds: [...worktree.threadIds].sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0)),
  }));
}

export async function collectTree(
  deps: CollectDeps,
  threadId: string,
  includeArchived: boolean,
  signal?: AbortSignal,
): Promise<Collected> {
  const { sdk } = deps;
  const root = await sdk.threads.get({ threadId, signal });
  // Archived descendants are always listed: only threads.get tells which ones they are, and dropping them there keeps the count.
  const listed = await sdk.threads.experimental_listDescendants({
    threadIds: [threadId],
    includeArchived: true,
    includeHidden: true,
    signal,
  });
  const descendantIds = listed.threads.find((entry) => entry.threadId === threadId)?.descendantIds ?? [];
  const wanted = descendantIds.slice(0, MAX_THREADS - 1);
  const fetched = await mapLimit(wanted, FETCH_CONCURRENCY, (id) =>
    sdk.threads.get({ threadId: id, signal }).catch(() => null),
  );
  const responses = [root, ...fetched.filter((thread) => thread !== null)];

  const depths = new Map<string, number>();
  const summaries = responses.map((thread): ThreadSummary => {
    const parentDepth = thread.parentThreadId === null ? undefined : depths.get(thread.parentThreadId);
    const depth = thread.id === threadId ? 0 : (parentDepth ?? 0) + 1;
    depths.set(thread.id, depth);
    return summarizeThread(thread, depth, threadId);
  });
  const hidden = includeArchived
    ? new Set<string>()
    : new Set(summaries.filter((thread) => thread.archived && thread.id !== threadId).map((thread) => thread.id));
  const threads = summaries.filter((thread) => !hidden.has(thread.id));
  const environments = await loadEnvironments(sdk, threads, signal);
  return { threads, environments, truncated: descendantIds.length > MAX_THREADS - 1, archivedHidden: hidden.size };
}

type Location =
  | { kind: "resolve"; hostId: string; path: string }
  | { kind: "environment"; environmentId: string; relative: string }
  | { kind: "other" };

function locate(env: Environment | undefined, edits: ThreadEdits | undefined, raw: string, excluded = false): Location {
  if (env === undefined) return { kind: "other" };
  if (excluded) {
    const root = env.path ?? edits?.primaryCwd;
    const style = pathStyle(root ?? raw);
    const relative = isAbsolute(raw) ? (root == null ? null : style.relative(root, raw)) : style.normalize(raw);
    if (relative === null || style.isAbsolute(relative) || relative.split(style.sep)[0] === "..")
      return { kind: "other" };
    return { kind: "environment", environmentId: env.id, relative: relative.split(style.sep).join("/") };
  }
  if (!isDestroyed(env)) {
    const path = isAbsolute(raw) ? posix.normalize(raw) : posix.join(env.path!, raw);
    return { kind: "resolve", hostId: env.hostId, path };
  }
  if (!isAbsolute(raw)) return { kind: "environment", environmentId: env.id, relative: posix.normalize(raw) };
  const cwd = edits?.primaryCwd ?? null;
  const normalized = posix.normalize(raw);
  if (cwd !== null && normalized.startsWith(`${posix.normalize(cwd).replace(/\/$/, "")}/`)) {
    return { kind: "environment", environmentId: env.id, relative: posix.relative(cwd, normalized) };
  }
  return { kind: "resolve", hostId: env.hostId, path: normalized };
}

const inside = (parent: string, path: string): boolean => {
  const base = parent.replace(/\/$/, "");
  return path === base || path.startsWith(`${base}/`);
};

// Only a thread that edited files outside its own environment can be working in another checkout, so only its folders are looked up.
function editsOutside(env: Environment, edits: ThreadEdits): boolean {
  return edits.records.some((record) => {
    const location = locate(env, edits, record.movePath ?? record.path);
    return location.kind === "resolve" && (env.path === null || !inside(env.path, location.path));
  });
}

function sourceFor(projects: readonly ProjectInfo[], env: Environment): string | null {
  const sources =
    projects
      .find((project) => project.id === env.projectId)
      ?.sources.filter((source) => source.hostId === env.hostId) ?? [];
  return (sources.find((source) => source.isDefault) ?? sources[0])?.path ?? null;
}

type RootRequests = ReadonlyMap<string, ReadonlyMap<string, string>>;

const pathStyle = (path: string) => (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? win32 : posix);

export function pathsToResolve(input: {
  threads: readonly ThreadSummary[];
  environments: ReadonlyMap<string, Environment>;
  edits: ReadonlyMap<string, ThreadEdits>;
  projects: readonly ProjectInfo[];
  known?: (hostId: string, path: string) => RootEntry | undefined;
  excludedProviders?: ReadonlySet<string>;
}): RootRequests {
  const wanted = new Map<string, Map<string, string>>();
  const add = (hostId: string, path: string, directory = path) => {
    if (path.length > MAX_PATH_LENGTH) return;
    const paths = wanted.get(hostId) ?? new Map<string, string>();
    if (paths.get(path) !== path) paths.set(path, directory);
    wanted.set(hostId, paths);
  };
  for (const thread of input.threads) {
    const env = thread.environmentId === null ? undefined : input.environments.get(thread.environmentId);
    if (env === undefined || isExcludedProvider(env.environmentProviderId, input.excludedProviders)) continue;
    const source = isDestroyed(env) && env.branchName !== null ? sourceFor(input.projects, env) : null;
    if (!isDestroyed(env)) add(env.hostId, env.path!);
    else if (source !== null) add(env.hostId, source);
    const edits = input.edits.get(thread.id);
    // Where the thread ran stands in for a project folder that is not a repository; one that is needs no second look.
    const cwd = edits?.primaryCwd ?? null;
    if (
      isDestroyed(env) &&
      env.branchName !== null &&
      cwd !== null &&
      isAbsolute(cwd) &&
      !(source !== null && input.known?.(env.hostId, source)?.root)
    )
      add(env.hostId, posix.normalize(cwd));
    for (const record of edits?.records ?? []) {
      const location = locate(env, edits, record.movePath ?? record.path);
      if (location.kind === "resolve") {
        const path = location.path;
        add(location.hostId, path, path.endsWith("/") ? path : pathStyle(path).dirname(path));
      }
    }
    if (edits !== undefined && edits.workDirs.length > 0 && editsOutside(env, edits)) {
      for (const dir of edits.workDirs) add(env.hostId, dir);
    }
  }
  for (const [hostId] of wanted) {
    for (const project of input.projects) {
      for (const source of project.sources) if (source.hostId === hostId) add(hostId, source.path);
    }
  }
  return wanted;
}

function rootOfPath(entry: RootEntry, path: string, directory: string): RootEntry {
  if (entry.relative === null || path === directory) return entry;
  const file = pathStyle(path).basename(path);
  return { root: entry.root, relative: entry.relative === "" ? file : `${entry.relative}/${file}` };
}

export function planRepos(input: {
  threads: readonly ThreadSummary[];
  environments: ReadonlyMap<string, Environment>;
  edits: ReadonlyMap<string, ThreadEdits>;
  roots: ResolvedRoots;
  projects: readonly ProjectInfo[];
  hosts: readonly HostInfo[];
  excludedProviders?: ReadonlySet<string>;
}): { plans: RepoPlan[]; otherFiles: RepoPlan["touched"] } {
  const { threads, environments, edits, roots, projects } = input;
  const plans = new Map<string, RepoPlan>();
  const planOfEnvironment = new Map<string, RepoPlan>();
  const otherFiles: RepoPlan["touched"] = new Map();
  const resolved = (hostId: string, path: string) => roots.get(hostId)?.get(path) ?? null;
  const projectName = (env: Environment) => projects.find((project) => project.id === env.projectId)?.name ?? null;

  // A kept branch is read in the project's checkout. When the project's folder is not a repository, or the project has
  // none, it is read where the thread ran: some environment providers leave that folder, and the branch, in place
  // when the environment is removed. A folder no one has looked up yet is taken as the root, as before.
  const keptRoot = (env: Environment, source: string | null, cwd: string | null): string | null => {
    const found = source === null ? null : resolved(env.hostId, source);
    if (found?.root) return found.root;
    const ran = cwd === null || !isAbsolute(cwd) ? null : (resolved(env.hostId, posix.normalize(cwd))?.root ?? null);
    if (ran !== null) return ran;
    return source !== null && found === null ? source : null;
  };
  // The repository path of the folder a removed environment's thread ran in, when its branch is read from there.
  const ranPrefix = (env: Environment | undefined, cwd: string | null, root: string | null): string => {
    if (env === undefined || cwd === null || root === null || !isAbsolute(cwd)) return "";
    const found = resolved(env.hostId, posix.normalize(cwd));
    return found?.root === root ? (found.relative ?? "") : "";
  };

  const join = (plan: RepoPlan, threadId: string): RepoPlan => {
    if (!plan.threadIds.includes(threadId)) plan.threadIds.push(threadId);
    return plan;
  };
  const open = (key: string, create: () => RepoPlan, threadId: string): RepoPlan => {
    let plan = plans.get(key);
    if (plan === undefined) {
      plan = create();
      plans.set(key, plan);
    }
    return join(plan, threadId);
  };

  for (const thread of threads) {
    const env = thread.environmentId === null ? undefined : environments.get(thread.environmentId);
    if (env === undefined) continue;
    const base = baseOf(env);
    if (
      isExcludedProvider(env.environmentProviderId, input.excludedProviders) ||
      (env.path !== null && resolved(env.hostId, env.path)?.excluded === true)
    ) {
      const key = `excluded:${env.id}`;
      const plan = open(
        key,
        () => ({
          key,
          ref:
            env.path === null
              ? { kind: "recorded" }
              : { kind: "workspace", environmentId: env.id, root: env.path, hostId: env.hostId, base },
          label: projectName(env) ?? env.name ?? "Excluded checkout",
          projectId: env.projectId,
          root: env.path,
          hostId: env.hostId,
          threadIds: [],
          touched: new Map(),
          blocked: EXCLUDED_UNAVAILABLE,
        }),
        thread.id,
      );
      planOfEnvironment.set(env.id, plan);
      continue;
    }
    if (isLive(env)) {
      const { ref, root, below } = workspaceRef(env, resolved(env.hostId, env.path));
      const key = `${env.hostId}:${root}`;
      const shared = plans.get(key);
      // When an environment below the repository root and one at the root share a repository, the root one speaks for it.
      if (shared !== undefined && shared.ref.kind === "workspace" && !below) shared.ref = ref;
      const plan = open(
        key,
        () => ({
          key,
          ref,
          label: projectName(env) ?? posix.basename(root),
          projectId: env.projectId,
          root,
          hostId: env.hostId,
          threadIds: [],
          touched: new Map(),
        }),
        thread.id,
      );
      planOfEnvironment.set(env.id, plan);
    } else if (isDestroyed(env)) {
      const source = env.branchName === null ? null : sourceFor(projects, env);
      const root = env.branchName === null ? null : keptRoot(env, source, edits.get(thread.id)?.primaryCwd ?? null);
      const label = projectName(env) ?? env.branchName ?? env.name ?? "Removed workspace";
      const plan =
        env.branchName !== null && root !== null
          ? open(
              `${env.hostId}:${root}@${env.branchName}`,
              () => ({
                key: `${env.hostId}:${root}@${env.branchName}`,
                ref: { kind: "branch", hostId: env.hostId, root, base, head: env.branchName! },
                label,
                projectId: env.projectId,
                root,
                hostId: env.hostId,
                threadIds: [],
                touched: new Map(),
              }),
              thread.id,
            )
          : open(
              `recorded:${env.id}`,
              () => ({
                key: `recorded:${env.id}`,
                ref: { kind: "recorded" },
                label,
                projectId: env.projectId,
                root: null,
                hostId: env.hostId,
                threadIds: [],
                touched: new Map(),
              }),
              thread.id,
            );
      planOfEnvironment.set(env.id, plan);
    }
  }

  const checkoutProject = (hostId: string, root: string): ProjectInfo | undefined =>
    projects.find((project) =>
      project.sources.some((source) => source.hostId === hostId && resolved(hostId, source.path)?.root === root),
    );
  // The repository roots of the folders a thread's commands changed into.
  const workRootsOf = new Map<string, ReadonlySet<string>>();
  const workRoots = (threadId: string, hostId: string): ReadonlySet<string> => {
    let found = workRootsOf.get(threadId);
    if (found === undefined) {
      const dirs = edits.get(threadId)?.workDirs ?? [];
      found = new Set(dirs.flatMap((dir) => resolved(hostId, dir)?.root ?? []));
      workRootsOf.set(threadId, found);
    }
    return found;
  };
  // A checkout a thread both edited and ran commands in, and the first such thread.
  const worked = new Map<RepoPlan, Environment | undefined>();

  for (const thread of threads) {
    const env = thread.environmentId === null ? undefined : environments.get(thread.environmentId);
    const threadEdits = edits.get(thread.id);
    for (const record of threadEdits?.records ?? []) {
      const target = record.movePath ?? record.path;
      const raw = record.movePath === null ? [record.path] : [record.path, record.movePath];
      const excluded = env !== undefined && planOfEnvironment.get(env.id)?.blocked !== undefined;
      const location = locate(env, threadEdits, target, excluded);
      let destination = { touched: otherFiles, key: target };
      if (location.kind === "environment") {
        const plan = planOfEnvironment.get(location.environmentId);
        const prefix = ranPrefix(env, threadEdits?.primaryCwd ?? null, plan?.root ?? null);
        if (plan !== undefined)
          destination = {
            touched: join(plan, thread.id).touched,
            key: prefix === "" ? location.relative : posix.join(prefix, location.relative),
          };
      } else if (location.kind === "resolve") {
        const found = resolved(location.hostId, location.path);
        if (found !== null && found.root !== null && found.relative !== null && found.relative !== "") {
          const root = found.root;
          const plan = open(
            `${location.hostId}:${root}`,
            () => ({
              key: `${location.hostId}:${root}`,
              ref: { kind: "checkout", hostId: location.hostId, root, base: null },
              label: checkoutProject(location.hostId, root)?.name ?? posix.basename(root),
              projectId: checkoutProject(location.hostId, root)?.id ?? null,
              root,
              hostId: location.hostId,
              threadIds: [],
              touched: new Map(),
            }),
            thread.id,
          );
          destination = { touched: plan.touched, key: found.relative };
          if (plan.ref.kind === "checkout" && !worked.has(plan) && workRoots(thread.id, location.hostId).has(root))
            worked.set(plan, env);
        }
      }
      const { touched, key } = destination;
      const entry = touched.get(key) ?? { threadIds: new Set<string>(), rawPaths: new Set<string>(), records: [] };
      entry.threadIds.add(thread.id);
      for (const path of raw) entry.rawPaths.add(path);
      entry.records.push(record);
      touched.set(key, entry);
    }
  }

  for (const [plan, env] of worked) {
    if (plan.ref.kind !== "checkout") continue;
    plan.ref = { ...plan.ref, worked: true };
    // A checkout outside every project, such as a tree an agent made itself, belongs with the work of the thread that made it.
    if (plan.projectId === null && env !== undefined) {
      plan.projectId = env.projectId;
      plan.label = projectName(env) ?? plan.label;
    }
  }

  const rank = (plan: RepoPlan) => (plan.ref.kind === "workspace" ? 0 : plan.ref.kind === "checkout" ? 1 : 2);
  const ordered = [...plans.values()].sort(
    (a, b) => rank(a) - rank(b) || (rank(a) === 1 ? a.label.localeCompare(b.label) || (a.key < b.key ? -1 : 1) : 0),
  );
  return { plans: ordered, otherFiles };
}

function editsFor(
  touched: ReadonlyMap<string, Touched>,
  file: { path: string; previousPath: string | null },
  matched: Set<string>,
): FileChange["edits"] {
  const keys = [file.path, ...(file.previousPath === null ? [] : [file.previousPath])].filter((key) =>
    touched.has(key),
  );
  if (keys.length === 0) return null;
  const threadIds = new Set<string>();
  const rawPaths = new Set<string>();
  let count = 0;
  for (const key of keys) {
    matched.add(key);
    const entry = touched.get(key)!;
    for (const id of entry.threadIds) threadIds.add(id);
    for (const raw of entry.rawPaths) rawPaths.add(raw);
    count += entry.records.length;
  }
  return { threadIds: [...threadIds], rawPaths: [...rawPaths], count };
}

function cleanFile(path: string, edits: NonNullable<FileChange["edits"]>): FileChange {
  return {
    path,
    previousPath: null,
    status: "clean",
    additions: null,
    deletions: null,
    binary: false,
    untracked: false,
    tooLarge: false,
    edits,
  };
}

function toRepo(
  plan: RepoPlan,
  loaded: LiveFiles | { unavailable: string },
  hostName: string | null,
  branchFallback: string | null,
): Repo {
  const base = {
    key: plan.key,
    ref: plan.ref,
    label: plan.label,
    projectId: plan.projectId,
    root: plan.root,
    hostId: plan.hostId,
    hostName,
    threadIds: plan.threadIds,
  };
  if ("unavailable" in loaded) {
    return {
      ...base,
      branch: null,
      base: null,
      aheadCount: null,
      state: "unavailable",
      message: loaded.unavailable.slice(0, MAX_MESSAGE),
      files: plan.blocked === undefined ? [] : recordedLiveFiles(plan).files.slice(0, MAX_FILES),
      otherFiles: [],
      truncated: false,
      totals: { files: 0, additions: 0, deletions: 0 },
      threadCommits: [],
    };
  }
  let files: FileChange[];
  let others: FileChange[] = [];
  if (plan.ref.kind === "recorded") {
    files = loaded.files;
  } else {
    const matched = new Set<string>();
    const attached = loaded.files.map((file) => ({ ...file, edits: editsFor(plan.touched, file, matched) }));
    // In a checkout only edited by path, the other changes are someone else's; in one a thread works in, they are its own.
    const byPathOnly = plan.ref.kind === "checkout" && plan.ref.worked !== true;
    files = byPathOnly ? attached.filter((file) => file.edits !== null) : attached;
    others = byPathOnly ? attached.filter((file) => file.edits === null) : [];
    for (const [path, entry] of plan.touched) {
      if (matched.has(path)) continue;
      files.push(
        cleanFile(path, {
          threadIds: [...entry.threadIds],
          rawPaths: [...entry.rawPaths],
          count: entry.records.length,
        }),
      );
    }
  }
  files.sort(byPath);
  others.sort(byPath);
  // An agent's recorded edit with no change now, and a folded untracked folder, are listed but not counted.
  const totals = files.reduce(
    (sum, file) =>
      file.status === "clean" || file.folder !== undefined
        ? sum
        : {
            files: sum.files + 1,
            additions: sum.additions + (file.additions ?? 0),
            deletions: sum.deletions + (file.deletions ?? 0),
          },
    { files: 0, additions: 0, deletions: 0 },
  );
  return {
    ...base,
    branch: loaded.branch ?? branchFallback,
    base: loaded.base,
    aheadCount: loaded.aheadCount,
    state: "ready",
    message: null,
    files: files.slice(0, MAX_FILES),
    otherFiles: others.slice(0, MAX_FILES),
    truncated: loaded.truncated || files.length > MAX_FILES,
    totals,
    threadCommits: [],
  };
}

function loadingRepo(plan: RepoPlan, environments: ReadonlyMap<string, Environment>, hostName: string | null): Repo {
  const branch =
    plan.ref.kind === "branch"
      ? plan.ref.head
      : plan.ref.kind === "workspace"
        ? (environments.get(plan.ref.environmentId)?.branchName ?? null)
        : null;
  return {
    key: plan.key,
    ref: plan.ref,
    label: plan.label,
    projectId: plan.projectId,
    root: plan.root,
    hostId: plan.hostId,
    hostName,
    branch,
    base: null,
    aheadCount: null,
    threadIds: plan.threadIds,
    state: "loading",
    message: null,
    files: [],
    otherFiles: [],
    truncated: false,
    totals: { files: 0, additions: 0, deletions: 0 },
    threadCommits: [],
  };
}

async function collectTarget(
  deps: CollectDeps,
  target: OverviewTarget,
  includeArchived: boolean,
  signal?: AbortSignal,
): Promise<Collected> {
  if (target.kind === "tree") return collectTree(deps, target.threadId, includeArchived, signal);
  if (deps.allOptions === undefined) throw new Error("An all-threads overview needs the time window and thread limit");
  return collectAll(deps, { ...deps.allOptions, includeArchived }, signal);
}

type Listed = { projects: ProjectInfo[]; hosts: HostInfo[] };

function listProjectsAndHosts(sdk: PluginBbSdk, warnings: string[], signal?: AbortSignal): Promise<Listed> {
  return Promise.all([
    sdk.projects.list({ includePersonal: true, signal }).catch((error: unknown) => {
      warnings.push(`Could not list projects: ${errorMessage(error)}`);
      return [];
    }),
    sdk.hosts.list({ signal }).catch((error: unknown) => {
      warnings.push(`Could not list machines: ${errorMessage(error)}`);
      return [];
    }),
  ]).then(([projects, hosts]) => ({ projects, hosts }));
}

async function resolveDirectories(
  deps: CollectDeps & { roots: RootCache },
  wanted: RootRequests,
  failed: Set<string>,
  hostName: (hostId: string) => string,
  warnings: string[],
  refreshing: boolean,
  seen: Map<string, Set<string>> | undefined,
  timing: OverviewTiming | undefined,
  signal?: AbortSignal,
): Promise<void> {
  await mapLimit([...wanted], 4, async ([hostId, paths]) => {
    if (failed.has(hostId)) return;
    const directories = new Set(paths.values());
    if (seen !== undefined && timing !== undefined) {
      const counted = seen.get(hostId) ?? new Set<string>();
      const before = counted.size;
      for (const directory of directories) counted.add(directory);
      timing.rootDirectories += counted.size - before;
      seen.set(hostId, counted);
    }
    const known = new Map<string, string>();
    const missing: string[] = [];
    for (const directory of directories) {
      const entry = deps.roots.peek(hostId, directory);
      if (entry === undefined || (refreshing && entry.root === null)) missing.push(directory);
      else if (refreshing && entry.root !== null) known.set(directory, entry.root);
    }
    let warned = false;
    const batches = async (paths: readonly string[], run: (batch: string[]) => Promise<void>) => {
      const chunks: string[][] = [];
      for (let start = 0; start < paths.length; start += ROOT_BATCH_SIZE)
        chunks.push(paths.slice(start, start + ROOT_BATCH_SIZE));
      await mapLimit(chunks, 2, async (chunk) => {
        if (failed.has(hostId)) return;
        try {
          signal?.throwIfAborted();
          await readOverviewHost(deps, hostId, () => run(chunk), signal);
        } catch (error) {
          if (!warned) warnings.push(`Could not read Git roots on ${hostName(hostId)}: ${errorMessage(error)}`);
          warned = true;
          if (!refreshing) failed.add(hostId);
        }
      });
    };
    if (refreshing) {
      const invalid = new Set<string>();
      let oldHost = false;
      await batches([...new Set(known.values())], async (roots) => {
        if (oldHost) return;
        if (timing !== undefined) {
          timing.rootHostCalls++;
          timing.rootRevalidated += roots.length;
        }
        try {
          const result = await deps.host("verifyRoots", { roots }, { hostId, signal });
          for (const root of result.invalidRoots) invalid.add(root);
        } catch (error) {
          const message = errorMessage(error);
          const missingMethod =
            /\b(?:unknown|unsupported) host (?:rpc )?method\s*:?\s*["']?verifyRoots\b/i.test(message) ||
            /\bhost (?:rpc )?method\s+(["']?)verifyRoots\1 (?:is not registered|not found)\b/i.test(message);
          if (!missingMethod) throw error;
          oldHost = true;
        }
      });
      deps.roots.dropRoots(hostId, invalid);
      for (const [directory, root] of known) if (oldHost || invalid.has(root)) missing.push(directory);
    }
    await batches(missing, async (paths) => {
      if (timing !== undefined) timing.rootHostCalls++;
      const { results } = await deps.host("resolveRoots", { paths }, { hostId, signal });
      signal?.throwIfAborted();
      for (const { path, ...entry } of results) deps.roots.store(hostId, path, entry);
    });
  });
}

// Starts the git reads every live workspace needs, so they run while the edit index and the root lookups do.
// Later phases ask the cache for the same loads and share these promises. A folder below its repository root is only
// known as one once its root is cached; until then this read is of the folder and is not shared.
function startWorkspaceLoads(
  deps: CollectDeps,
  threads: readonly ThreadSummary[],
  environments: ReadonlyMap<string, Environment>,
  signal?: AbortSignal,
): Promise<unknown> {
  return mapLimit([...environments.values()].filter(isLive), FETCH_CONCURRENCY, async (env) => {
    if (signal?.aborted || isExcludedProvider(env.environmentProviderId, deps.excludedProviders)) return;
    const known = deps.roots?.peek(env.hostId, env.path);
    if (known === undefined || known.excluded === true) return;
    const { ref, root } = workspaceRef(env, known);
    const threadIds = threads.filter((thread) => thread.environmentId === env.id).map((thread) => thread.id);
    // A failed read is not cached, so the phase that needs it asks again and reports the failure itself.
    await loadWorkspaceStatus(deps, ref, threadIds, signal, picksBase(deps, `${env.hostId}:${root}`)).catch(
      () => undefined,
    );
  });
}

export interface OverviewTiming {
  threadListingMs: number;
  editIndexMs: number;
  editPages: number;
  rootResolutionMs: number;
  rootDirectories: number;
  rootHostCalls: number;
  rootRevalidated: number;
  hostReadsMs: number;
  hostReads: number;
}

export async function buildOverview(
  deps: CollectDeps,
  input: { target: OverviewTarget; scope: Scope; includeArchived: boolean; refresh?: boolean },
  signal?: AbortSignal,
  timing?: OverviewTiming,
): Promise<Overview> {
  const { target } = input;
  // A build with no shared cache still shares reads between its own phases.
  const scoped = { ...deps, cache: deps.cache ?? createRepoCache(), roots: deps.roots ?? createRootCache() };
  const { sdk, edits } = scoped;
  const warnings: string[] = [];
  const measure = async <T>(phase: "threadListingMs" | "editIndexMs" | "rootResolutionMs", run: () => Promise<T>) => {
    if (timing === undefined) return run();
    const started = performance.now();
    try {
      return await run();
    } finally {
      timing[phase] += performance.now() - started;
    }
  };
  const [{ projects, hosts }, tree] = await measure("threadListingMs", () =>
    Promise.all([
      listProjectsAndHosts(sdk, warnings, signal),
      collectTarget(scoped, target, input.includeArchived, signal),
    ]),
  );
  const refreshing = input.refresh === true;
  const rootInputs = {
    threads: tree.threads,
    environments: tree.environments,
    projects,
    excludedProviders: scoped.excludedProviders,
  };
  const countedDirectories = timing === undefined ? undefined : new Map<string, Set<string>>();
  if (refreshing) {
    signal?.throwIfAborted();
    scoped.cache.invalidateThreads(tree.threads.map((thread) => thread.id));
  }
  const hostName = (hostId: string) => hosts.find((entry) => entry.id === hostId)?.name ?? hostId;
  const failedHosts = new Set<string>();
  const exclusions = new Map<string, string[]>();
  for (const env of tree.environments.values()) {
    if (!isExcludedProvider(env.environmentProviderId, scoped.excludedProviders) || env.path === null) continue;
    scoped.rememberExcludedEnvironment?.(env);
    const paths = exclusions.get(env.hostId) ?? [];
    paths.push(env.path);
    exclusions.set(env.hostId, paths);
  }

  scoped.host = (method, input, options) => {
    if (timing !== undefined && method !== "resolveRoots" && method !== "verifyRoots") timing.hostReads++;
    const excludedRoots = exclusions.get(options.hostId);
    return deps.host(method, excludedRoots === undefined ? input : { ...input, excludedRoots }, options);
  };
  if (!refreshing && scoped.deferHostRead === undefined)
    void startWorkspaceLoads(scoped, tree.threads, tree.environments, signal);
  const editCutoff = Date.now() - 5 * 60_000;
  const onPageRead =
    timing === undefined
      ? undefined
      : () => {
          timing.editPages++;
        };
  const resolve = (paths: RootRequests) =>
    measure("rootResolutionMs", () =>
      resolveDirectories(
        scoped,
        paths,
        failedHosts,
        hostName,
        warnings,
        refreshing,
        countedDirectories,
        timing,
        signal,
      ),
    );
  const [editList] = await Promise.all([
    measure("editIndexMs", () =>
      mapLimit(tree.threads, FETCH_CONCURRENCY, async (thread) => {
        try {
          if (target.kind === "all")
            return await edits.get(thread.id, signal, { settled: thread.archived, bounded: true, onPageRead });
          if (thread.archived)
            return await edits.get(thread.id, signal, { settled: true, ...(refreshing ? { refresh: true } : {}) });
          const readAt = refreshing ? edits.lastReadAt(thread.id) : undefined;
          return await edits.get(thread.id, signal, {
            settled: false,
            ...(readAt !== undefined && readAt < editCutoff ? { recheck: true } : {}),
          });
        } catch (error) {
          warnings.push(`Could not read the edits of ${thread.title}: ${errorMessage(error)}`);
          return undefined;
        }
      }),
    ),
    // Trees can start their small environment pass early. All threads batch it with the edit directories.
    target.kind === "tree" && !refreshing ? resolve(pathsToResolve({ ...rootInputs, edits: new Map() })) : undefined,
  ]);
  const editMap = new Map<string, ThreadEdits>();
  const incompleteArchives = new Set<string>();
  tree.threads.forEach((thread, index) => {
    const found = editList[index];
    if (found === undefined) return;
    editMap.set(thread.id, found);
    if (thread.archived && found.archiveIncomplete === true) incompleteArchives.add(thread.id);
  });
  if (incompleteArchives.size > 0) warnings.push(incompleteWarning(incompleteArchives.size, target.kind));

  const wanted = pathsToResolve({
    ...rootInputs,
    edits: editMap,
    ...(refreshing ? {} : { known: (hostId, path) => scoped.roots.peek(hostId, path) }),
  });
  await resolve(wanted);
  signal?.throwIfAborted();
  const roots = new Map<string, Map<string, RootEntry>>();
  for (const [hostId, paths] of wanted) {
    if (failedHosts.has(hostId)) continue;
    const resolved = new Map<string, RootEntry>();
    const blockedRoots = exclusions.get(hostId);
    const known = new Map<string, RootEntry | undefined>();
    for (const directory of new Set(paths.values())) {
      const entry = scoped.roots.peek(hostId, directory);
      known.set(
        directory,
        entry?.root != null && blockedRoots?.some((root) => atOrBelow(root, entry.root!)) ? undefined : entry,
      );
    }
    for (const [path, directory] of paths) {
      const entry = known.get(directory);
      if (entry !== undefined && !blockedRoots?.some((root) => atOrBelow(root, path)))
        resolved.set(path, rootOfPath(entry, path, directory));
    }
    roots.set(hostId, resolved);
  }

  const { plans, otherFiles } = planRepos({
    threads: tree.threads,
    environments: tree.environments,
    edits: editMap,
    roots,
    projects,
    hosts,
    excludedProviders: scoped.excludedProviders,
  });
  const hostReadsStarted = timing === undefined ? 0 : performance.now();
  // The worktrees go first: each decides the base its repository's committed changes are read against.
  const loadedWorktrees = await loadWorktrees(
    scoped,
    plans,
    tree.environments,
    new Map(hosts.map((host) => [host.id, host.name])),
    signal,
  );
  const running = new Set(tree.threads.filter((thread) => RUNNING.has(thread.status)).map((thread) => thread.id));
  const attribution = { edits: editMap, running, now: Date.now() };
  const trimmed = await leaveOutHistory(scoped, loadedWorktrees, attribution, signal);
  const attributed = await attachThreadCommits(scoped, trimmed.worktrees, attribution, signal);
  warnings.push(...trimmed.warnings, ...attributed.warnings);
  const worktrees = ownerFirst(attributed.worktrees, tree.threads);
  const madeIn = new Map(worktrees.map((worktree) => [worktree.key, worktree.threadCommits]));
  const effectiveBase = new Map(worktrees.map((worktree) => [worktree.key, worktree.ref.base]));
  // A repository's uncommitted files come from its worktree row's own read; its committed ones from the base that row chose.
  const withBase = (plan: RepoPlan): RepoPlan =>
    plan.ref.kind === "recorded" || !effectiveBase.has(plan.key)
      ? plan
      : { ...plan, ref: { ...plan.ref, base: effectiveBase.get(plan.key)! } };
  const settled = await mapLimit(plans, FETCH_CONCURRENCY, async (plan) => {
    if (plan.blocked !== undefined) return { unavailable: plan.blocked };
    const read = input.scope === "branch" ? withBase(plan) : plan;
    const variant = `${input.scope}\0${read.ref.kind === "recorded" ? "" : (read.ref.base ?? "")}\0${picksBase(scoped, plan.key)}`;
    try {
      signal?.throwIfAborted();
      return await readOverviewHost(
        scoped,
        plan.hostId,
        () =>
          planCached(scoped.cache, read, variant, () =>
            loadRepoFiles(scoped, read, input.scope, signal, picksBase(scoped, plan.key)),
          ),
        signal,
      );
    } catch (error) {
      return { unavailable: errorMessage(error) };
    }
  });
  if (timing !== undefined) timing.hostReadsMs = performance.now() - hostReadsStarted;
  signal?.throwIfAborted();
  const repos = plans.map((original, index): Repo => {
    const plan = withBase(original);
    const outcome = settled[index]!;
    const name = plan.hostId === null ? null : hostName(plan.hostId);
    if ("missingRef" in outcome) {
      const recorded: RepoPlan = { ...plan, ref: { kind: "recorded" } };
      return toRepo(recorded, recordedLiveFiles(recorded), name, plan.ref.kind === "branch" ? plan.ref.head : null);
    }
    const environment = plan.ref.kind === "workspace" ? tree.environments.get(plan.ref.environmentId) : undefined;
    return {
      ...toRepo(plan, outcome, name, environment?.branchName ?? null),
      threadCommits: madeIn.get(plan.key) ?? [],
    };
  });

  return {
    threadId: target.kind === "tree" ? target.threadId : "",
    target,
    windowHours: target.kind === "all" ? deps.allOptions!.windowHours : null,
    scope: input.scope,
    threads: tree.threads.map((thread) =>
      incompleteArchives.has(thread.id) ? { ...thread, recordsIncomplete: true as const } : thread,
    ),
    repos: archivedLast(repos, tree.threads),
    worktrees: archivedLast(worktrees, tree.threads),
    sharedFiles: findSharedFiles(worktrees),
    otherFiles: [...otherFiles]
      .map(([path, entry]) => recordedFile(path, entry))
      .sort(byPath)
      .slice(0, MAX_OTHER_FILES),
    environmentIds: [...tree.environments.keys()],
    warnings,
    truncatedThreads: tree.truncated,
    partial: false,
    archivedHidden: tree.archivedHidden,
    generatedAt: Date.now(),
  };
}

// The outline of an overview: every row and header, none of the numbers. It makes no git, status, diff or event call.
export async function buildShell(deps: CollectDeps, input: ShellInput, signal?: AbortSignal): Promise<Overview> {
  const { target } = input;
  const [tree, { projects, hosts }] = await Promise.all([
    collectTarget(deps, target, input.includeArchived, signal),
    listProjectsAndHosts(deps.sdk, [], signal),
  ]);
  // Edits and roots an earlier build already read put a worked checkout's row in the outline too.
  const edits = new Map(
    tree.threads.flatMap((thread) => {
      const known = deps.edits.peek(thread.id);
      return known === undefined ? [] : [[thread.id, known] as const];
    }),
  );
  const wanted = pathsToResolve({
    threads: tree.threads,
    environments: tree.environments,
    edits,
    projects,
    excludedProviders: deps.excludedProviders,
  });
  const roots: ResolvedRoots = new Map(
    [...wanted].map(([hostId, paths]) => [
      hostId,
      new Map(
        [...paths].map(([path, directory]) => {
          const entry = deps.roots?.peek(hostId, directory);
          return [path, entry === undefined ? { root: path, relative: "" } : rootOfPath(entry, path, directory)];
        }),
      ),
    ]),
  );
  const planned = planRepos({
    threads: tree.threads,
    environments: tree.environments,
    edits,
    roots,
    projects,
    hosts,
    excludedProviders: deps.excludedProviders,
  }).plans;
  const plans = planned.filter((plan) => plan.ref.kind !== "checkout" || plan.ref.worked === true);
  const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
  return {
    threadId: target.kind === "tree" ? target.threadId : "",
    target,
    windowHours: target.kind === "all" ? deps.allOptions!.windowHours : null,
    scope: "uncommitted",
    threads: tree.threads,
    repos: archivedLast(
      plans.map((plan) =>
        loadingRepo(plan, tree.environments, plan.hostId === null ? null : (hostNames.get(plan.hostId) ?? plan.hostId)),
      ),
      tree.threads,
    ),
    worktrees: archivedLast(
      ownerFirst(loadingWorktrees(plans, tree.environments, hostNames), tree.threads),
      tree.threads,
    ),
    sharedFiles: [],
    otherFiles: [],
    environmentIds: [...tree.environments.keys()],
    warnings: [],
    truncatedThreads: tree.truncated,
    partial: true,
    archivedHidden: tree.archivedHidden,
    generatedAt: Date.now(),
  };
}
