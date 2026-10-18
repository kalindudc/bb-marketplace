import { archivedLast } from "./archived";
import { posix } from "node:path";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { EditIndex, EditRecord, ThreadEdits } from "./edits";
import { collectAll, FETCH_CONCURRENCY, loadEnvironments, summarizeThread, type AllOptions, type Collected } from "./collect-all";
import type { FileChange, HostInput, HostMethod, HostOutput, Overview, OverviewTarget, Repo, RepoRef, Scope, ShellInput, ThreadSummary } from "./contract";
import { mapLimit } from "./limit";
import { createRepoCache, planCached, type RepoCache } from "./repo-cache";
import { createRootCache, type RootCache, type RootEntry } from "./root-cache";
import { loadRepoFiles, loadWorkspaceDiff, loadWorkspaceStatus, recordedFile, recordedLiveFiles, type LiveFiles } from "./sources";
import { findSharedFiles, loadingWorktrees, loadWorktrees } from "./worktrees";

export type Environment = Awaited<ReturnType<PluginBbSdk["environments"]["get"]>>;
export type HostCall = <M extends HostMethod>(
  method: M, input: HostInput<M>, options: { hostId: string; signal?: AbortSignal },
) => Promise<HostOutput<M>>;
export interface CollectDeps {
  sdk: PluginBbSdk; host: HostCall; edits: EditIndex; allOptions?: Omit<AllOptions, "now">; cache?: RepoCache; roots?: RootCache;
}

export interface Touched { threadIds: Set<string>; rawPaths: Set<string>; records: EditRecord[] }
export interface RepoPlan {
  key: string; ref: RepoRef; label: string; projectId: string | null; root: string | null; hostId: string | null;
  threadIds: string[]; touched: Map<string, Touched>;
}
export interface ProjectInfo { id: string; name: string; sources: readonly { hostId: string; path: string; isDefault: boolean }[] }
export interface HostInfo { id: string; name: string }
export type ResolvedRoots = ReadonlyMap<string, ReadonlyMap<string, RootEntry>>;

const MAX_THREADS = 200;
const MAX_FILES = 500;
const MAX_OTHER_FILES = 200;
const RESOLVE_CHUNK = 2000;
const MAX_PATH_LENGTH = 4096;
const MAX_MESSAGE = 1000;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE);
const isAbsolute = (path: string): boolean => /^([/\\]|[A-Za-z]:[\\/])/.test(path);
const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

type LiveEnvironment = Environment & { path: string };
// bb keeps an archived thread's worktree on disk for a while ("retiring") before it destroys it.
const isLive = (env: Environment): env is LiveEnvironment =>
  env.status === "ready" && (env.lifecycle.phase === "active" || env.lifecycle.phase === "retiring") && env.isGitRepo && env.path !== null;
const isDestroyed = (env: Environment): boolean =>
  env.status === "destroyed" || env.lifecycle.phase === "destroyed" || env.path === null;
const baseOf = (env: Environment): string | null => env.mergeBaseBranch ?? env.defaultBranch ?? null;

export async function collectTree(
  deps: CollectDeps, threadId: string, includeArchived: boolean, signal?: AbortSignal,
): Promise<Collected> {
  const { sdk } = deps;
  const root = await sdk.threads.get({ threadId, signal });
  // Archived descendants are always listed: only threads.get tells which ones they are, and dropping them there keeps the count.
  const listed = await sdk.threads.experimental_listDescendants({
    threadIds: [threadId], includeArchived: true, includeHidden: true, signal,
  });
  const descendantIds = listed.threads.find((entry) => entry.threadId === threadId)?.descendantIds ?? [];
  const wanted = descendantIds.slice(0, MAX_THREADS - 1);
  const fetched = await mapLimit(wanted, FETCH_CONCURRENCY, (id) => sdk.threads.get({ threadId: id, signal }).catch(() => null));
  const responses = [root, ...fetched.filter((thread) => thread !== null)];

  const depths = new Map<string, number>();
  const summaries = responses.map((thread): ThreadSummary => {
    const parentDepth = thread.parentThreadId === null ? undefined : depths.get(thread.parentThreadId);
    const depth = thread.id === threadId ? 0 : (parentDepth ?? 0) + 1;
    depths.set(thread.id, depth);
    return summarizeThread(thread, depth, threadId);
  });
  const hidden = includeArchived ? new Set<string>() : new Set(summaries.filter((thread) => thread.archived && thread.id !== threadId).map((thread) => thread.id));
  const threads = summaries.filter((thread) => !hidden.has(thread.id));
  const environments = await loadEnvironments(sdk, threads, signal);
  return { threads, environments, truncated: descendantIds.length > MAX_THREADS - 1, archivedHidden: hidden.size };
}

type Location =
  | { kind: "resolve"; hostId: string; path: string }
  | { kind: "environment"; environmentId: string; relative: string }
  | { kind: "other" };

function locate(env: Environment | undefined, edits: ThreadEdits | undefined, raw: string): Location {
  if (env === undefined) return { kind: "other" };
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

function sourceFor(projects: readonly ProjectInfo[], env: Environment): string | null {
  const sources = projects.find((project) => project.id === env.projectId)?.sources.filter((source) => source.hostId === env.hostId) ?? [];
  return (sources.find((source) => source.isDefault) ?? sources[0])?.path ?? null;
}

export function pathsToResolve(input: {
  threads: readonly ThreadSummary[]; environments: ReadonlyMap<string, Environment>;
  edits: ReadonlyMap<string, ThreadEdits>; projects: readonly ProjectInfo[];
}): Map<string, string[]> {
  const wanted = new Map<string, Set<string>>();
  const add = (hostId: string, path: string) => {
    if (path.length > MAX_PATH_LENGTH) return;
    const paths = wanted.get(hostId) ?? new Set<string>();
    paths.add(path);
    wanted.set(hostId, paths);
  };
  for (const thread of input.threads) {
    const env = thread.environmentId === null ? undefined : input.environments.get(thread.environmentId);
    if (env === undefined) continue;
    const source = isDestroyed(env) && env.branchName !== null ? sourceFor(input.projects, env) : null;
    if (!isDestroyed(env)) add(env.hostId, env.path!);
    else if (source !== null) add(env.hostId, source);
    const edits = input.edits.get(thread.id);
    for (const record of edits?.records ?? []) {
      const location = locate(env, edits, record.movePath ?? record.path);
      if (location.kind === "resolve") add(location.hostId, location.path);
    }
  }
  for (const [hostId, paths] of wanted) {
    for (const project of input.projects) {
      for (const source of project.sources) if (source.hostId === hostId) paths.add(source.path);
    }
  }
  return new Map([...wanted].map(([hostId, paths]) => [hostId, [...paths]]));
}

export function planRepos(input: {
  threads: readonly ThreadSummary[]; environments: ReadonlyMap<string, Environment>;
  edits: ReadonlyMap<string, ThreadEdits>; roots: ResolvedRoots;
  projects: readonly ProjectInfo[]; hosts: readonly HostInfo[];
}): { plans: RepoPlan[]; otherFiles: RepoPlan["touched"] } {
  const { threads, environments, edits, roots, projects } = input;
  const plans = new Map<string, RepoPlan>();
  const planOfEnvironment = new Map<string, RepoPlan>();
  const otherFiles: RepoPlan["touched"] = new Map();
  const resolved = (hostId: string, path: string) => roots.get(hostId)?.get(path) ?? null;
  const projectName = (env: Environment) => projects.find((project) => project.id === env.projectId)?.name ?? null;

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
    if (isLive(env)) {
      const root = resolved(env.hostId, env.path)?.root ?? env.path;
      const plan = open(`${env.hostId}:${root}`, () => ({
        key: `${env.hostId}:${root}`, ref: { kind: "workspace", environmentId: env.id, base },
        label: projectName(env) ?? posix.basename(root), projectId: env.projectId, root, hostId: env.hostId, threadIds: [], touched: new Map(),
      }), thread.id);
      planOfEnvironment.set(env.id, plan);
    } else if (isDestroyed(env)) {
      const source = env.branchName === null ? null : sourceFor(projects, env);
      const root = source === null ? null : (resolved(env.hostId, source)?.root ?? source);
      const label = projectName(env) ?? env.branchName ?? env.name ?? "Removed workspace";
      const plan = env.branchName !== null && root !== null
        ? open(`${env.hostId}:${root}@${env.branchName}`, () => ({
          key: `${env.hostId}:${root}@${env.branchName}`, ref: { kind: "branch", hostId: env.hostId, root, base, head: env.branchName! },
          label, projectId: env.projectId, root, hostId: env.hostId, threadIds: [], touched: new Map(),
        }), thread.id)
        : open(`recorded:${env.id}`, () => ({
          key: `recorded:${env.id}`, ref: { kind: "recorded" }, label, projectId: env.projectId, root: null, hostId: env.hostId, threadIds: [], touched: new Map(),
        }), thread.id);
      planOfEnvironment.set(env.id, plan);
    }
  }

  const checkoutProject = (hostId: string, root: string): ProjectInfo | undefined =>
    projects.find((project) => project.sources.some((source) => source.hostId === hostId && resolved(hostId, source.path)?.root === root));

  for (const thread of threads) {
    const env = thread.environmentId === null ? undefined : environments.get(thread.environmentId);
    const threadEdits = edits.get(thread.id);
    for (const record of threadEdits?.records ?? []) {
      const target = record.movePath ?? record.path;
      const raw = record.movePath === null ? [record.path] : [record.path, record.movePath];
      const location = locate(env, threadEdits, target);
      let destination = { touched: otherFiles, key: target };
      if (location.kind === "environment") {
        const plan = planOfEnvironment.get(location.environmentId);
        if (plan !== undefined) destination = { touched: join(plan, thread.id).touched, key: location.relative };
      } else if (location.kind === "resolve") {
        const found = resolved(location.hostId, location.path);
        if (found !== null && found.root !== null && found.relative !== null && found.relative !== "") {
          const root = found.root;
          const plan = open(`${location.hostId}:${root}`, () => ({
            key: `${location.hostId}:${root}`, ref: { kind: "checkout", hostId: location.hostId, root, base: null },
            label: checkoutProject(location.hostId, root)?.name ?? posix.basename(root), projectId: checkoutProject(location.hostId, root)?.id ?? null,
            root, hostId: location.hostId, threadIds: [], touched: new Map(),
          }), thread.id);
          destination = { touched: plan.touched, key: found.relative };
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

  const rank = (plan: RepoPlan) => (plan.ref.kind === "workspace" ? 0 : plan.ref.kind === "checkout" ? 1 : 2);
  const ordered = [...plans.values()].sort((a, b) =>
    rank(a) - rank(b) || (rank(a) === 1 ? a.label.localeCompare(b.label) || (a.key < b.key ? -1 : 1) : 0));
  return { plans: ordered, otherFiles };
}

function editsFor(touched: ReadonlyMap<string, Touched>, file: { path: string; previousPath: string | null }, matched: Set<string>): FileChange["edits"] {
  const keys = [file.path, ...(file.previousPath === null ? [] : [file.previousPath])].filter((key) => touched.has(key));
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
  return { path, previousPath: null, status: "clean", additions: null, deletions: null, binary: false, untracked: false, tooLarge: false, edits };
}

function toRepo(plan: RepoPlan, loaded: LiveFiles | { unavailable: string }, hostName: string | null, branchFallback: string | null): Repo {
  const base = { key: plan.key, ref: plan.ref, label: plan.label, projectId: plan.projectId, root: plan.root, hostId: plan.hostId, hostName, threadIds: plan.threadIds };
  if ("unavailable" in loaded) {
    return {
      ...base, branch: null, base: null, aheadCount: null, state: "unavailable", message: loaded.unavailable.slice(0, MAX_MESSAGE),
      files: [], otherFiles: [], truncated: false, totals: { files: 0, additions: 0, deletions: 0 },
    };
  }
  let files: FileChange[];
  let others: FileChange[] = [];
  if (plan.ref.kind === "recorded") {
    files = loaded.files;
  } else {
    const matched = new Set<string>();
    const attached = loaded.files.map((file) => ({ ...file, edits: editsFor(plan.touched, file, matched) }));
    files = plan.ref.kind === "checkout" ? attached.filter((file) => file.edits !== null) : attached;
    others = plan.ref.kind === "checkout" ? attached.filter((file) => file.edits === null) : [];
    for (const [path, entry] of plan.touched) {
      if (matched.has(path)) continue;
      files.push(cleanFile(path, { threadIds: [...entry.threadIds], rawPaths: [...entry.rawPaths], count: entry.records.length }));
    }
  }
  files.sort(byPath);
  others.sort(byPath);
  const totals = files.reduce((sum, file) => (file.status === "clean" ? sum : {
    files: sum.files + 1, additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0),
  }), { files: 0, additions: 0, deletions: 0 });
  return {
    ...base, branch: loaded.branch ?? branchFallback, base: loaded.base, aheadCount: loaded.aheadCount, state: "ready", message: null,
    files: files.slice(0, MAX_FILES), otherFiles: others.slice(0, MAX_FILES), truncated: loaded.truncated || files.length > MAX_FILES,
    totals,
  };
}

function loadingRepo(plan: RepoPlan, environments: ReadonlyMap<string, Environment>, hostName: string | null): Repo {
  const branch = plan.ref.kind === "branch" ? plan.ref.head : plan.ref.kind === "workspace" ? (environments.get(plan.ref.environmentId)?.branchName ?? null) : null;
  return {
    key: plan.key, ref: plan.ref, label: plan.label, projectId: plan.projectId, root: plan.root, hostId: plan.hostId, hostName,
    branch, base: null, aheadCount: null, threadIds: plan.threadIds, state: "loading", message: null,
    files: [], otherFiles: [], truncated: false, totals: { files: 0, additions: 0, deletions: 0 },
  };
}

async function collectTarget(
  deps: CollectDeps, target: OverviewTarget, includeArchived: boolean, signal?: AbortSignal,
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

// Asks each machine only for the paths the cache does not know, and remembers what it answers.
async function resolveMissing(
  deps: CollectDeps & { roots: RootCache }, wanted: ReadonlyMap<string, readonly string[]>, failed: Set<string>,
  hostName: (hostId: string) => string, warnings: string[], signal?: AbortSignal,
): Promise<void> {
  await Promise.all([...wanted].map(async ([hostId, paths]) => {
    const missing = deps.roots.missing(hostId, paths);
    if (failed.has(hostId) || missing.length === 0) return;
    try {
      for (let start = 0; start < missing.length; start += RESOLVE_CHUNK) {
        const { results } = await deps.host("resolveRoots", { paths: missing.slice(start, start + RESOLVE_CHUNK) }, { hostId, signal });
        for (const result of results) deps.roots.store(hostId, result.path, { root: result.root, relative: result.relative });
      }
    } catch (error) {
      failed.add(hostId);
      warnings.push(`Could not reach ${hostName(hostId)}: ${errorMessage(error)}`);
    }
  }));
}

// Starts the git reads every live workspace needs, so they run while the edit index and the root lookups do.
// Later phases ask the cache for the same loads and share these promises.
function startWorkspaceLoads(
  deps: CollectDeps, threads: readonly ThreadSummary[], environments: ReadonlyMap<string, Environment>, scope: Scope, signal?: AbortSignal,
): Promise<unknown> {
  return mapLimit([...environments.values()].filter(isLive), FETCH_CONCURRENCY, async (env) => {
    const ref = { kind: "workspace", environmentId: env.id, base: baseOf(env) } as const;
    const threadIds = threads.filter((thread) => thread.environmentId === env.id).map((thread) => thread.id);
    // A failed read is not cached, so the phase that needs it asks again and reports the failure itself.
    await Promise.all([
      loadWorkspaceStatus(deps, ref, threadIds, signal),
      scope === "branch" && ref.base !== null ? loadWorkspaceDiff(deps, { ...ref, base: ref.base }, threadIds, signal) : undefined,
    ]).catch(() => undefined);
  });
}

export async function buildOverview(
  deps: CollectDeps, input: { target: OverviewTarget; scope: Scope; includeArchived: boolean; refresh?: boolean }, signal?: AbortSignal,
): Promise<Overview> {
  const { target } = input;
  // A build with no shared cache still shares reads between its own phases.
  const scoped = { ...deps, cache: deps.cache ?? createRepoCache(), roots: deps.roots ?? createRootCache() };
  const { sdk, edits } = scoped;
  const warnings: string[] = [];
  const listed = listProjectsAndHosts(sdk, warnings, signal);
  const tree = await collectTarget(scoped, target, input.includeArchived, signal);
  if (input.refresh === true) {
    scoped.roots.clear();
    if (target.kind === "tree") {
      const ids = tree.threads.map((thread) => thread.id);
      edits.forget(ids);
      scoped.cache.invalidateThreads(ids);
    } else {
      scoped.cache.clear();
    }
  }
  const { projects, hosts } = await listed;
  const hostName = (hostId: string) => hosts.find((entry) => entry.id === hostId)?.name ?? hostId;
  const failedHosts = new Set<string>();

  void startWorkspaceLoads(scoped, tree.threads, tree.environments, input.scope, signal);
  const noEdits = new Map<string, ThreadEdits>();
  const [editList] = await Promise.all([
    mapLimit(tree.threads, FETCH_CONCURRENCY, async (thread) => {
      try {
        return await edits.get(thread.id, signal, { settled: thread.archived });
      } catch (error) {
        warnings.push(`Could not read the edits of ${thread.title}: ${errorMessage(error)}`);
        return undefined;
      }
    }),
    resolveMissing(scoped, pathsToResolve({ threads: tree.threads, environments: tree.environments, edits: noEdits, projects }), failedHosts, hostName, warnings, signal),
  ]);
  const editMap = new Map<string, ThreadEdits>();
  tree.threads.forEach((thread, index) => {
    const found = editList[index];
    if (found !== undefined) editMap.set(thread.id, found);
  });

  const wanted = pathsToResolve({ threads: tree.threads, environments: tree.environments, edits: editMap, projects });
  await resolveMissing(scoped, wanted, failedHosts, hostName, warnings, signal);
  const roots = new Map<string, Map<string, RootEntry>>();
  for (const [hostId, paths] of wanted) {
    if (failedHosts.has(hostId)) continue;
    roots.set(hostId, new Map(paths.flatMap((path) => {
      const found = scoped.roots.peek(hostId, path);
      return found === undefined ? [] : [[path, found] as const];
    })));
  }

  const { plans, otherFiles } = planRepos({
    threads: tree.threads, environments: tree.environments, edits: editMap, roots, projects, hosts,
  });
  const [settled, worktrees] = await Promise.all([
    Promise.allSettled(plans.map((plan) => planCached(scoped.cache, plan, input.scope, () => loadRepoFiles(scoped, plan, input.scope, signal)))),
    loadWorktrees(scoped, plans, tree.environments, new Map(hosts.map((host) => [host.id, host.name])), signal),
  ]);
  const repos = plans.map((plan, index): Repo => {
    const outcome = settled[index]!;
    const name = plan.hostId === null ? null : hostName(plan.hostId);
    if (outcome.status === "rejected") return toRepo(plan, { unavailable: errorMessage(outcome.reason) }, name, null);
    if ("missingRef" in outcome.value) {
      const recorded: RepoPlan = { ...plan, ref: { kind: "recorded" } };
      return toRepo(recorded, recordedLiveFiles(recorded), name, plan.ref.kind === "branch" ? plan.ref.head : null);
    }
    const environment = plan.ref.kind === "workspace" ? tree.environments.get(plan.ref.environmentId) : undefined;
    return toRepo(plan, outcome.value, name, environment?.branchName ?? null);
  });

  return {
    threadId: target.kind === "tree" ? target.threadId : "",
    target,
    windowHours: target.kind === "all" ? deps.allOptions!.windowHours : null,
    scope: input.scope,
    threads: tree.threads,
    repos: archivedLast(repos, tree.threads),
    worktrees: archivedLast(worktrees, tree.threads),
    sharedFiles: findSharedFiles(worktrees),
    otherFiles: [...otherFiles].map(([path, entry]) => recordedFile(path, entry)).sort(byPath).slice(0, MAX_OTHER_FILES),
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
  const wanted = pathsToResolve({ threads: tree.threads, environments: tree.environments, edits: new Map(), projects });
  const roots: ResolvedRoots = new Map([...wanted].map(([hostId, paths]) => [
    hostId, new Map(paths.map((path) => [path, deps.roots?.peek(hostId, path) ?? { root: path, relative: "" }])),
  ]));
  const { plans } = planRepos({ threads: tree.threads, environments: tree.environments, edits: new Map(), roots, projects, hosts });
  const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
  return {
    threadId: target.kind === "tree" ? target.threadId : "",
    target,
    windowHours: target.kind === "all" ? deps.allOptions!.windowHours : null,
    scope: "uncommitted",
    threads: tree.threads,
    repos: archivedLast(plans.map((plan) => loadingRepo(plan, tree.environments, plan.hostId === null ? null : (hostNames.get(plan.hostId) ?? plan.hostId))), tree.threads),
    worktrees: archivedLast(loadingWorktrees(plans, tree.environments, hostNames), tree.threads),
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
