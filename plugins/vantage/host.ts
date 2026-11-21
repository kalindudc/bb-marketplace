import { AsyncLocalStorage } from "node:async_hooks";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import {
  hostContract,
  type GitFile,
  type HostInput,
  type HostOutput,
  type HostTarget,
  type HostUnavailable,
} from "./src/contract";
import {
  EMPTY_TREE,
  FILE_LIMIT,
  LOG_FORMAT,
  REFLOG_FORMAT,
  closestBase,
  commitsInWindows,
  isSafeRef,
  isSafeRelativePath,
  isSafeSha,
  parseLog,
  parseNumstatZ,
  parseReflog,
  splitToplevel,
  statusFromCode,
  truncatePatch,
  FOLDER_SAMPLE,
  type NumstatEntry,
} from "./src/git";
import { createGitRunner, type GitLane } from "./src/git-process";
import {
  COUNT_BYTES,
  COUNT_PATHS,
  DIFF_FLAGS,
  FOLDER_SCAN_LIMIT,
  SIDE_LIMIT,
  UnsafeWorkingPath,
  isText,
  literal,
  parseCheckoutStatus,
  parseRaw,
  readWorkingFile,
  regularMode,
  scanFolder,
  workingSize,
  type RawChange,
} from "./src/git-workload";
import { IMAGE_LIMIT } from "./src/images";
import { mapLimit } from "./src/limit";

import { EXCLUDED_UNAVAILABLE, exclusionGate, expandHome } from "./src/exclusion-gate";

const git = createGitRunner();
const lane = new AsyncLocalStorage<GitLane>();
const gitLane = (): GitLane => lane.getStore() ?? "interactive";
const COMMIT_LIMIT = 100;
const REFLOG_LIMIT = 5000;
const ANCESTOR_LIMIT = 100;
const ROOT_PROBE_LIMIT = 16;
const DEFAULT_FOLDER_LIMIT = 200;
const UNTRACKED_OUTPUT_LIMIT = 256 * 1024;
const FULL_SIDE_LIMIT_BYTES = 512 * 1024;
const BASE_CACHE_TTL_MS = 5 * 60_000;
const BASE_CACHE_ENTRIES = 32;
const BASE_CACHE_VALUE_LIMIT = 128 * 1024;
const DIFF_CACHE_TTL_MS = 3_000;
const DIFF_CACHE_ENTRIES = 256;
const DIFF = ["-c", "diff.autoRefreshIndex=false", "diff", ...DIFF_FLAGS] as const;
// A branch with one of these names is a base itself, so its own upstream is a base to compare it with.
const BASE_NAMES = new Set(["main", "master", "trunk", "develop"]);

class Unavailable extends Error {
  constructor(
    readonly reason: HostUnavailable["reason"],
    message: string,
  ) {
    super(message);
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(root: string, args: readonly string[], signal?: AbortSignal, stdin?: string): Promise<GitResult> {
  const { code, stdout, stderr } = await git.run(root, args, { lane: gitLane(), signal, stdin });
  return { code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
}

async function mustGit(
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
  okCodes: readonly number[] = [0],
  stdin?: string,
): Promise<string> {
  const result = await runGit(root, args, signal, stdin);
  if (!okCodes.includes(result.code)) {
    throw new Unavailable("git-failed", result.stderr.trim().split("\n")[0] || `git ${args[0]} failed`);
  }
  return result.stdout;
}

async function guard<T extends object>(run: () => Promise<T>): Promise<T | HostUnavailable> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Unavailable) return { outcome: "unavailable", reason: error.reason, message: error.message };
    return {
      outcome: "unavailable",
      reason: "git-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function rootRealPath(path: string, definitive: boolean): Promise<string | null> {
  return realpath(path).catch((error: unknown) => {
    if (
      !definitive ||
      (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))
    )
      return null;
    throw error;
  });
}

async function permittedRoot(root: string, excludedRoots?: readonly string[], definitive = false): Promise<string> {
  if (!isAbsolute(root)) throw new Unavailable("invalid-input", "The repository root must be an absolute path");
  const exclusions = exclusionGate(excludedRoots);
  if (exclusions.blocksPath(root)) throw new Unavailable("git-failed", EXCLUDED_UNAVAILABLE);
  const real = await rootRealPath(root, definitive);
  if (real === null) throw new Unavailable("not-a-repo", "This folder does not exist");
  if (await exclusions.blocksRealPath(real)) throw new Unavailable("git-failed", EXCLUDED_UNAVAILABLE);
  return real;
}

async function checkTop(real: string, top: string, definitive = false): Promise<void> {
  if (top === "") throw new Unavailable("not-a-repo", "This folder is not a git repository");
  if (top !== real && (await rootRealPath(top, definitive)) !== real)
    throw new Unavailable("invalid-input", "The folder is not the top of a repository");
}

async function verifyRoot(
  root: string,
  signal: AbortSignal,
  excludedRoots?: readonly string[],
  definitive = false,
): Promise<string> {
  const real = await permittedRoot(root, excludedRoots, definitive);
  const top = await runGit(real, ["rev-parse", "--show-toplevel"], signal);
  if (top.code !== 0) {
    const message = top.stderr.trim().split("\n")[0];
    if (
      definitive &&
      !/^fatal: (?:not a git repository\b|this operation must be run in a work tree\b)/.test(message ?? "")
    )
      throw new Unavailable("git-failed", message || "Git could not verify the repository root");
    throw new Unavailable("not-a-repo", "This folder is not a git repository");
  }
  await checkTop(real, top.stdout.trim(), definitive);
  return real;
}

async function checkoutIdentity(root: string, signal: AbortSignal, excludedRoots?: readonly string[]) {
  const real = await permittedRoot(root, excludedRoots);
  const result = await runGit(
    real,
    ["rev-parse", "--show-toplevel", "--is-shallow-repository", "HEAD^{commit}", "--abbrev-ref", "HEAD"],
    signal,
  );
  const rows = result.stdout.startsWith(`${real}\n`)
    ? [real, ...result.stdout.slice(real.length + 1).split("\n")]
    : result.stdout.split("\n");
  const [top = "", shallow = "", sha = "", name = ""] = rows;
  await checkTop(real, top);
  return {
    root: real,
    shallow: shallow !== "false",
    head: result.code === 0 && isSafeSha(sha) ? sha : null,
    branch: result.code === 0 && name !== "" && name !== "HEAD" ? name : null,
  };
}

function shortCache<T>(capacity: number, ttl: number) {
  const entries = new Map<string, { value: T; expires: number }>();
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      if (entry.expires <= Date.now()) return undefined;
      entries.set(key, entry);
      return entry.value;
    },
    set(key: string, value: T) {
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + ttl });
      if (entries.size > capacity) entries.delete(entries.keys().next().value!);
    },
    clear: () => entries.clear(),
  };
}

function checkPaths(...paths: Array<string | null>): void {
  for (const path of paths) {
    if (path !== null && !isSafeRelativePath(path)) throw new Unavailable("invalid-input", `Unsafe path: ${path}`);
  }
}

function checkRef(ref: string): void {
  if (!isSafeRef(ref)) throw new Unavailable("invalid-input", `Unsafe ref: ${ref}`);
}

function checkSha(sha: string): void {
  if (!isSafeSha(sha)) throw new Unavailable("invalid-input", `Unsafe commit id: ${sha}`);
}

async function defaultBase(root: string, signal?: AbortSignal): Promise<string | null> {
  const result = await runGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], signal);
  const name = result.stdout.trim();
  return result.code === 0 && isSafeRef(name) ? name : null;
}

async function commitId(root: string, ref: string, signal?: AbortSignal): Promise<string | null> {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal);
  const sha = result.stdout.trim();
  return result.code === 0 && isSafeSha(sha) ? sha : null;
}

async function hasCommit(root: string, ref: string, signal?: AbortSignal): Promise<boolean> {
  return (await commitId(root, ref, signal)) !== null;
}

async function currentBranch(root: string, signal?: AbortSignal): Promise<string | null> {
  const result = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], signal);
  const name = result.stdout.trim();
  return result.code === 0 && name !== "" && name !== "HEAD" ? name : null;
}

async function headSha(root: string, signal?: AbortSignal): Promise<string | null> {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], signal);
  const sha = result.stdout.trim();
  return result.code === 0 && isSafeSha(sha) ? sha : null;
}

const ORIGIN_HEAD = "refs/remotes/origin/HEAD";
// Match rev-parse's short-name precedence. SHAs and pseudo-refs are resolved separately.
const refPaths = (name: string): string[] => [
  ...(name.startsWith("refs/") ? [name] : []),
  `refs/${name}`,
  `refs/tags/${name}`,
  `refs/heads/${name}`,
  `refs/remotes/${name}`,
  `refs/remotes/${name}/HEAD`,
];
const shortRef = (name: string) => name.replace(/^refs\/(?:heads|remotes|tags)\//, "");

async function checkoutBases(
  root: string,
  requested: string | null,
  pick: boolean,
  branch: string | null,
  signal: AbortSignal,
) {
  if (requested !== null) checkRef(requested);
  const names = [
    requested,
    ...(pick
      ? [
          requested !== null && !requested.startsWith("origin/") ? `origin/${requested}` : null,
          "origin/main",
          "origin/master",
          branch === null ? null : `origin/${branch}`,
        ]
      : []),
  ].filter((name) => name !== null);
  const candidates = new Set([ORIGIN_HEAD, ...names.flatMap(refPaths)]);
  if (pick && branch !== null && isSafeRef(branch)) candidates.add(`refs/heads/${branch}`);
  const refs = new Map<string, { oid: string | null; named: string; upstream: string; isTag: boolean }>();
  const format =
    "%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(symref)%00%(upstream)";
  for (const line of (await mustGit(root, ["for-each-ref", `--format=${format}`, "--", ...candidates], signal)).split(
    "\n",
  )) {
    const [ref = "", type, sha = "", peeledType, peeled = "", named = "", upstream = ""] = line.split("\0");
    if (!candidates.has(ref)) continue;
    const oid = type === "commit" ? sha : peeledType === "commit" ? peeled : "";
    refs.set(ref, { oid: isSafeSha(oid) ? oid : null, named, upstream, isTag: type === "tag" });
  }
  const origin = refs.get(ORIGIN_HEAD);
  const defaultName = origin?.named ? shortRef(origin.named) : null;
  const ordered = [requested];
  if (pick && requested !== null && !requested.startsWith("origin/")) ordered.push(`origin/${requested}`);
  if (pick || requested === null) ordered.push(defaultName);
  if (pick) ordered.push("origin/main", "origin/master");
  const upstream = branch === null ? undefined : refs.get(`refs/heads/${branch}`)?.upstream;
  if (
    pick &&
    branch !== null &&
    (BASE_NAMES.has(branch) || ordered.some((name) => name?.replace(/^origin\//, "") === branch))
  ) {
    if (upstream) ordered.push(shortRef(upstream));
    ordered.push(`origin/${branch}`);
  }
  const found: Array<{ name: string; oid: string }> = [];
  for (const name of new Set(ordered)) {
    if (name === null || !isSafeRef(name)) continue;
    const info =
      refPaths(name)
        .map((path) => refs.get(path))
        .find((ref) => ref !== undefined) ?? (name === defaultName ? origin : undefined);
    const oid =
      info?.oid ??
      (info?.isTag === true ||
      (name === requested && (/^[A-Z_]+$/.test(name) || name === "@" || /^[0-9a-fA-F]{4,64}$/.test(name))) ||
      (upstream !== undefined && name === shortRef(upstream))
        ? await commitId(root, name, signal)
        : null);
    if (oid !== null) found.push({ name, oid });
  }
  return found;
}

async function resolveMergeBase(
  root: string,
  requested: string | null,
  signal?: AbortSignal,
): Promise<{ base: string; commit: string } | null> {
  const base = requested ?? (await defaultBase(root, signal));
  if (base === null) return null;
  checkRef(base);
  const result = await runGit(root, ["merge-base", "HEAD", base], signal);
  const commit = result.stdout.trim();
  if (result.code !== 0 || commit === "") throw new Unavailable("missing-ref", `Could not compare with ${base}`);
  return { base, commit };
}

async function resolveRange(
  root: string,
  requested: string | null,
  head: string,
  signal?: AbortSignal,
): Promise<{ base: string; head: string }> {
  checkRef(head);
  const base = requested ?? (await defaultBase(root, signal));
  if (base === null) throw new Unavailable("missing-ref", "There is no base branch to compare with");
  checkRef(base);
  const headRef = await commitId(root, `refs/heads/${head}`, signal);
  if (headRef === null) throw new Unavailable("missing-ref", `The branch ${head} no longer exists`);
  if (!(await hasCommit(root, base, signal))) throw new Unavailable("missing-ref", `The base ${base} was not found`);
  return { base, head: headRef };
}

// The commit and its first parent; the empty tree stands in for the parent of a root commit.
// The raw diff gives path, mode and object ids without computing binary flags or line counts.
async function resolveCommit(root: string, sha: string, signal?: AbortSignal): Promise<string[]> {
  checkSha(sha);
  const object = await runGit(root, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], signal);
  if (object.code !== 0 || !isSafeSha(object.stdout.trim()))
    throw new Unavailable("git-failed", `The commit ${sha.slice(0, 12)} was not found`);
  const commit = object.stdout.trim();
  const parent = await runGit(root, ["rev-parse", "--verify", "--quiet", `${commit}^`], signal);
  return [parent.code === 0 ? parent.stdout.trim() : EMPTY_TREE, commit];
}

async function blobSizes(
  root: string,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, number> | null> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Map();
  const output = await mustGit(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    signal,
    [0],
    distinct.join("\n") + "\n",
  );
  const sizes = new Map<string, number>();
  const wanted = new Set(distinct);
  for (const line of output.trim().split("\n")) {
    const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(line);
    if (match === null || !wanted.has(match[1]!)) return null;
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > SIDE_LIMIT) return null;
    sizes.set(match[1]!, size);
  }
  return sizes.size === wanted.size ? sizes : null;
}

async function indexBlobs(
  root: string,
  paths: readonly string[],
  signal?: AbortSignal,
  pathspec = paths.map(literal),
): Promise<string[] | null> {
  if (paths.length === 0) return [];
  const output = await mustGit(root, ["ls-files", "--stage", "-z", "--", ...pathspec], signal);
  const ids: string[] = [];
  const wanted = new Set(paths);
  for (const row of output.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) [0-3]\t([^\0]+)$/.exec(row);
    if (match === null || !regularMode(match[1]!) || !wanted.has(match[3]!)) return null;
    ids.push(match[2]!);
  }
  return ids;
}

const countablePath = (path: string): boolean => isSafeRelativePath(path) && !path.includes("\uFFFD");

async function trackedCounts(
  root: string,
  revisions: readonly string[],
  changes: readonly RawChange[],
  loose: readonly string[],
  signal: AbortSignal,
  statusIndexIds?: readonly string[],
): Promise<{ stats: Map<string, NumstatEntry>; looseStats: Map<string, NumstatEntry> }> {
  const stats = new Map<string, NumstatEntry>();
  const looseStats = new Map<string, NumstatEntry>();
  const none = { stats, looseStats };
  if (changes.length + loose.length > COUNT_PATHS) return none;
  if (
    changes.some(
      ({ code, oldMode, newMode, path }) =>
        code === "U" ||
        ![oldMode, newMode].every((mode) => mode === "000000" || regularMode(mode)) ||
        !countablePath(path),
    )
  )
    return none;
  if (loose.some((path) => !countablePath(path))) return none;
  const working = revisions.length === 1;
  const changedPaths = [...new Set(changes.map(({ path }) => path))];
  const index = working ? (statusIndexIds ?? (await indexBlobs(root, changedPaths, signal))) : [];
  if (index === null) return none;
  const ids = [
    ...changes.flatMap(({ oldOid, newOid }) => [oldOid, newOid]).filter((oid) => !/^0+$/.test(oid)),
    ...index,
  ];
  const sizes = await blobSizes(root, ids, signal);
  if (sizes === null) return none;
  let total = ids.reduce((sum, oid) => sum + sizes.get(oid)!, 0);
  if (total > COUNT_BYTES) return none;
  const workPaths = [...new Set([...(working ? changedPaths : []), ...loose])];
  const workSizes = await mapLimit(workPaths, 4, async (path) => {
    signal.throwIfAborted();
    return workingSize(root, path).catch(() => undefined);
  });
  for (let i = 0; i < workSizes.length; i++) {
    const size = workSizes[i];
    if (size === undefined || (size === null && loose.includes(workPaths[i]!)) || (size ?? 0) > SIDE_LIMIT) return none;
    total += size ?? 0;
    if (total > COUNT_BYTES) return none;
  }
  if (changedPaths.length > 0) {
    for (const [path, value] of parseNumstatZ(
      await mustGit(root, [...DIFF, "--numstat", "-z", ...revisions, "--", ...changedPaths.map(literal)], signal),
    )) {
      stats.set(path, value);
    }
  }
  for (const path of loose) {
    const expected = workSizes[workPaths.indexOf(path)];
    if (expected == null) continue;
    const content = await readWorkingFile(root, path, expected, signal).catch(() => null);
    signal.throwIfAborted();
    if (content?.bytes == null) continue;
    const { bytes } = content;
    const binary = !isText(bytes);
    let lines = bytes.length > 0 && bytes.at(-1) !== 10 ? 1 : 0;
    for (let i = 0; !binary && i < bytes.length; i++) if (bytes[i] === 10) lines++;
    looseStats.set(path, { additions: binary ? null : lines, deletions: binary ? null : 0, previousPath: null });
  }
  return none;
}

async function untrackedFiles(
  root: string,
  folderLimit: number,
  signal: AbortSignal,
): Promise<{ loose: string[]; folders: GitFile[] }> {
  const result = await git.run(
    root,
    ["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z"],
    { lane: gitLane(), signal, outputLimit: UNTRACKED_OUTPUT_LIMIT },
  );
  if (result.code !== 0) throw new Unavailable("git-failed", "Could not list untracked files");
  return expandUntracked(root, result.stdout.toString("utf8").split("\0").filter(Boolean), folderLimit, signal);
}

async function expandUntracked(root: string, paths: readonly string[], folderLimit: number, signal: AbortSignal) {
  const loose: string[] = [];
  const scans: Array<{ path: string; candidates: string[]; partial: boolean; repository: boolean }> = [];
  let remaining = FOLDER_SCAN_LIMIT;
  const limit = Math.min(folderLimit, FOLDER_SCAN_LIMIT);
  for (const path of paths) {
    if (!path.endsWith("/")) {
      loose.push(path);
      continue;
    }
    if (!countablePath(path.slice(0, -1))) continue;
    const budget = Math.min(Math.max(FOLDER_SAMPLE + 1, limit + 1), remaining);
    const scan = await scanFolder(root, path, budget, signal).catch(() => ({
      visits: budget,
      paths: [],
      partial: true,
      repository: false,
    }));
    signal.throwIfAborted();
    remaining -= scan.visits;
    scans.push({
      path,
      candidates: scan.paths.filter(countablePath),
      partial: scan.partial,
      repository: scan.repository,
    });
  }
  const ignored = new Set<string>();
  const check = async (stdin: string) => {
    if (stdin === "") return;
    const output = await mustGit(root, ["check-ignore", "--stdin", "-z"], signal, [0, 1], stdin);
    for (const path of output.split("\0")) if (path !== "") ignored.add(path.slice(2));
  };
  let batch = "";
  let bytes = 0;
  for (const { candidates, repository } of scans) {
    if (repository) continue;
    for (const path of candidates) {
      const size = Buffer.byteLength(path) + 3;
      if (bytes + size > 1024 * 1024) {
        await check(batch);
        batch = "";
        bytes = 0;
      }
      batch += `./${path}\0`;
      bytes += size;
    }
  }
  await check(batch);
  const folders: GitFile[] = [];
  for (const { path, candidates, partial, repository } of scans) {
    const files = candidates.filter((candidate) => !ignored.has(candidate));
    if (!partial && !repository && files.length <= limit) {
      loose.push(...files);
      continue;
    }
    folders.push({
      path,
      previousPath: null,
      status: "untracked",
      additions: null,
      deletions: null,
      binary: false,
      folder: {
        files: files.length,
        repository,
        sample: files.slice(0, FOLDER_SAMPLE),
        ...(partial && !repository ? { partial: true } : {}),
      },
    });
  }
  return { loose, folders };
}

async function committedFiles(
  root: string,
  revisions: readonly string[],
  untracked: boolean,
  signal: AbortSignal,
  limit = DEFAULT_FOLDER_LIMIT,
): Promise<{ files: GitFile[]; truncated: boolean }> {
  const changes = parseRaw(await mustGit(root, [...DIFF, "--raw", "--no-abbrev", "-z", ...revisions, "--"], signal));
  const { loose, folders } = untracked ? await untrackedFiles(root, limit, signal) : { loose: [], folders: [] };
  return filesForChanges(root, revisions, changes, loose, folders, signal);
}

async function filesForChanges(
  root: string,
  revisions: readonly string[],
  changes: readonly RawChange[],
  loose: readonly string[],
  folders: readonly GitFile[],
  signal: AbortSignal,
  indexIds?: readonly string[],
) {
  const { stats, looseStats } = await trackedCounts(root, revisions, changes, loose, signal, indexIds);
  const files = new Map<string, GitFile>();
  const toFile = (path: string, code: string, stat: NumstatEntry | undefined): GitFile => ({
    path,
    previousPath: null,
    status: statusFromCode(code),
    additions: stat?.additions ?? null,
    deletions: stat?.deletions ?? null,
    binary: stat !== undefined && stat.additions === null,
  });
  for (const { path, code } of changes) {
    if (files.get(path)?.status !== "unmerged") files.set(path, toFile(path, code, stats.get(path)));
  }
  for (const path of loose) if (!files.has(path)) files.set(path, toFile(path, "??", looseStats.get(path)));
  const sorted = [...files.values(), ...folders].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: sorted.slice(0, FILE_LIMIT), truncated: sorted.length > FILE_LIMIT };
}

async function uncommittedFiles(root: string, head: string | null, limit: number, signal: AbortSignal) {
  const output = await mustGit(
    root,
    [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--no-ahead-behind",
      "--no-renames",
      "--untracked-files=normal",
      "--ignore-submodules=all",
    ],
    signal,
  );
  const status = parseCheckoutStatus(output);
  if (status.head !== head) throw new Unavailable("git-failed", "HEAD changed while reading checkout status");
  if (status.untracked.reduce((bytes, path) => bytes + Buffer.byteLength(path) + 1, 0) > UNTRACKED_OUTPUT_LIMIT)
    throw new Unavailable("git-failed", "Untracked Git paths exceed 256 KiB");
  const revisions = [head ?? EMPTY_TREE];
  const changes = status.needsRawDiff
    ? parseRaw(await mustGit(root, [...DIFF, "--raw", "--no-abbrev", "-z", ...revisions, "--"], signal))
    : status.tracked;
  const { loose, folders } = await expandUntracked(root, status.untracked, limit, signal);
  return filesForChanges(
    root,
    revisions,
    changes,
    loose,
    folders,
    signal,
    status.needsRawDiff ? undefined : status.indexIds,
  );
}

async function repoFiles(input: HostInput<"repoFiles">, signal: AbortSignal): Promise<HostOutput<"repoFiles">> {
  return guard(async () => {
    const { target } = input;
    const limit = input.folderLimit ?? DEFAULT_FOLDER_LIMIT;
    if (target.type === "committed") {
      const { root, head, branch, shallow } = await checkoutIdentity(input.root, signal, input.excludedRoots);
      const history =
        head === null ? null : await checkoutHistory(root, head, target.base, false, branch, shallow, signal);
      if (history === null) throw new Unavailable("missing-ref", "There is no base branch to compare with");
      const { base, aheadCount, behindCount, commits, files, truncated } = history;
      return { outcome: "available" as const, branch, base, aheadCount, behindCount, commits, files, truncated };
    }
    const root = await verifyRoot(input.root, signal, input.excludedRoots);
    if (target.type === "range") {
      const range = await resolveRange(root, target.base, target.head, signal);
      const mergeBase = (await mustGit(root, ["merge-base", range.base, range.head], signal)).trim();
      checkSha(mergeBase);
      const [{ files, truncated }, ahead, behind, log] = await Promise.all([
        committedFiles(root, [mergeBase, range.head], false, signal),
        mustGit(root, ["rev-list", "--count", `${range.base}..${range.head}`], signal),
        mustGit(root, ["rev-list", "--count", `${range.head}..${range.base}`], signal),
        mustGit(
          root,
          ["log", "-n", String(COMMIT_LIMIT), `--format=${LOG_FORMAT}`, `${range.base}..${range.head}`],
          signal,
        ),
      ]);
      return {
        outcome: "available" as const,
        branch: target.head,
        base: range.base,
        aheadCount: Number(ahead.trim()),
        behindCount: Number(behind.trim()),
        commits: parseLog(log),
        files,
        truncated,
      };
    }
    if (target.type === "commit") {
      const { files, truncated } = await committedFiles(
        root,
        await resolveCommit(root, target.sha, signal),
        false,
        signal,
      );
      return {
        outcome: "available" as const,
        branch: null,
        base: null,
        aheadCount: null,
        behindCount: null,
        commits: [],
        files,
        truncated,
      };
    }
    const branch = await currentBranch(root, signal);
    const mergeBase = target.type === "merge-base" ? await resolveMergeBase(root, target.base, signal) : null;
    if (mergeBase === null) {
      const { files, truncated } = await uncommittedFiles(root, await headSha(root, signal), limit, signal);
      return {
        outcome: "available" as const,
        branch,
        base: null,
        aheadCount: null,
        behindCount: null,
        commits: [],
        files,
        truncated,
      };
    }
    const [{ files, truncated }, ahead] = await Promise.all([
      committedFiles(root, [mergeBase.commit], true, signal, limit),
      mustGit(root, ["rev-list", "--count", `${mergeBase.commit}..HEAD`], signal),
    ]);
    return {
      outcome: "available" as const,
      branch,
      base: mergeBase.base,
      aheadCount: Number(ahead.trim()),
      behindCount: null,
      commits: [],
      files,
      truncated,
    };
  });
}

interface CheckoutHistory {
  base: string;
  skippedBase: { name: string; aheadCount: number } | null;
  aheadCount: number;
  behindCount: number;
  commits: ReturnType<typeof parseLog>;
  files: GitFile[];
  truncated: boolean;
}
const baseCache = shortCache<CheckoutHistory | null>(BASE_CACHE_ENTRIES, BASE_CACHE_TTL_MS);

async function checkoutHistory(
  root: string,
  head: string,
  requested: string | null,
  pick: boolean,
  branch: string | null,
  shallow: boolean,
  signal: AbortSignal,
): Promise<CheckoutHistory | null> {
  const bases = await checkoutBases(root, requested, pick, branch, signal);
  const key = JSON.stringify([root, head, requested, bases]);
  const cached = shallow ? undefined : baseCache.get(key);
  if (cached !== undefined) return cached;
  const counts = new Map<string, { ahead: number; behind: number }>([[head, { ahead: 0, behind: 0 }]]);
  const usable: Array<{ name: string; oid: string; ahead: number; behind: number }> = [];
  for (const base of bases) {
    let count = counts.get(base.oid);
    if (count === undefined) {
      const measured = await runGit(root, ["rev-list", "--left-right", "--count", `${base.oid}...${head}`], signal);
      const [behind, ahead] = measured.stdout.trim().split(/\s+/).map(Number);
      if (
        measured.code !== 0 ||
        behind === undefined ||
        ahead === undefined ||
        !Number.isSafeInteger(behind) ||
        !Number.isSafeInteger(ahead)
      )
        continue;
      count = { ahead, behind };
      counts.set(base.oid, count);
    }
    usable.push({ ...base, ...count });
  }
  const picked = closestBase(usable);
  const best = picked === null ? undefined : usable.find((entry) => entry.name === picked.name);
  if (best === undefined) {
    if (!shallow) baseCache.set(key, null);
    return null;
  }
  const common = best.ahead === 0 ? head : (await runGit(root, ["merge-base", head, best.oid], signal)).stdout.trim();
  if (!isSafeSha(common)) {
    if (!shallow) baseCache.set(key, null);
    return null;
  }
  const asked = usable.find((entry) => entry.name === requested);
  const skippedBase =
    asked !== undefined && asked.ahead > best.ahead ? { name: asked.name, aheadCount: asked.ahead } : null;
  const [committed, commits]: [Awaited<ReturnType<typeof committedFiles>>, CheckoutHistory["commits"]] =
    common === head
      ? [{ files: [], truncated: false }, []]
      : await Promise.all([
          committedFiles(root, [common, head], false, signal),
          mustGit(
            root,
            ["log", "-n", String(COMMIT_LIMIT), `--format=${LOG_FORMAT}`, `${common}..${head}`],
            signal,
          ).then(parseLog),
        ]);
  const history: CheckoutHistory = {
    ...committed,
    commits,
    base: best.name,
    skippedBase,
    aheadCount: best.ahead,
    behindCount: best.behind,
  };
  if (!shallow && Buffer.byteLength(JSON.stringify(history)) <= BASE_CACHE_VALUE_LIMIT) baseCache.set(key, history);
  return history;
}

// The worktree row and repository view share this read; only the working half changes on an unstaged edit.
async function checkoutStatus(
  input: HostInput<"checkoutStatus">,
  signal: AbortSignal,
): Promise<HostOutput<"checkoutStatus">> {
  return guard(async () => {
    const { root, branch, head, shallow } = await checkoutIdentity(input.root, signal, input.excludedRoots);
    if (input.base !== null) checkRef(input.base);
    const [uncommitted, history] = await Promise.all([
      uncommittedFiles(root, head, input.folderLimit ?? DEFAULT_FOLDER_LIMIT, signal),
      head === null ? null : checkoutHistory(root, head, input.base, input.pick === true, branch, shallow, signal),
    ]);
    return {
      outcome: "available" as const,
      branch,
      head,
      base: history?.base ?? null,
      skippedBase: history?.skippedBase ?? null,
      aheadCount: history?.aheadCount ?? null,
      behindCount: history?.behindCount ?? null,
      commits: history?.commits ?? [],
      uncommitted: uncommitted.files,
      committed: history?.files ?? [],
      truncated: uncommitted.truncated || history?.truncated === true,
    };
  });
}

// A diff can show only the attributed commits if they form a linear suffix of HEAD with a parent to compare against.
async function sinceCommit(root: string, shas: readonly string[], signal: AbortSignal): Promise<string | null> {
  const common =
    shas.length === 1 ? shas[0]! : (await runGit(root, ["merge-base", "--octopus", ...shas], signal)).stdout.trim();
  if (!isSafeSha(common)) return null;
  let since = common;
  if (shas.includes(common)) {
    const parent = await runGit(root, ["rev-parse", "--verify", "--quiet", `${common}^`], signal);
    since = parent.stdout.trim();
    if (parent.code !== 0 || !isSafeSha(since)) return null;
  }
  const range = await runGit(
    root,
    ["rev-list", "--parents", `--max-count=${shas.length + 1}`, `${since}..HEAD`],
    signal,
  );
  if (range.code !== 0) return null;
  const remaining = new Set(shas);
  for (const line of range.stdout.trim().split("\n")) {
    const [sha, ...parents] = line.split(" ");
    if (!remaining.delete(sha!) || parents.length > 1) return null;
  }
  return remaining.size === 0 ? since : null;
}

// A checkout with no reflog, such as one with no commits yet, has no commits to find.
async function threadCommits(
  input: HostInput<"threadCommits">,
  signal: AbortSignal,
): Promise<HostOutput<"threadCommits">> {
  return guard(async () => {
    const { windows } = input;
    const root = await verifyRoot(input.root, signal, input.excludedRoots);
    const reflog = await runGit(
      root,
      ["log", "-g", "--date=unix", `--format=${REFLOG_FORMAT}`, "-n", String(REFLOG_LIMIT), "HEAD"],
      signal,
    );
    if (reflog.code !== 0) return { outcome: "available" as const, commits: [], total: 0, since: null };
    const candidates = commitsInWindows(parseReflog(reflog.stdout), windows);
    if (candidates.length > ANCESTOR_LIMIT)
      throw new Unavailable("git-failed", "Too many recorded commits to check safely");
    // An amended, reset or rebased commit is no longer on the branch, and one made on another branch never was.
    const onHead = await mapLimit(
      candidates,
      8,
      async (sha) => (await runGit(root, ["merge-base", "--is-ancestor", sha, "HEAD"], signal)).code === 0,
    );
    const all = candidates.filter((_, index) => onHead[index]);
    if (all.length === 0) return { outcome: "available" as const, commits: [], total: 0, since: null };
    // Only the newest are listed; the count and the starting commit cover every one of them.
    const [log, since] = await Promise.all([
      mustGit(root, ["log", "--no-walk=unsorted", `--format=${LOG_FORMAT}`, ...all.slice(0, COMMIT_LIMIT)], signal),
      sinceCommit(root, all, signal),
    ]);
    return { outcome: "available" as const, commits: parseLog(log), total: all.length, since };
  });
}

function patchOldPath(path: string, previousPath: string | null): string {
  // If a legacy previous path overlaps this subtree, diff only the selected path.
  return previousPath !== null && !path.startsWith(`${previousPath}/`) && !previousPath.startsWith(`${path}/`)
    ? previousPath
    : path;
}

async function repoPatch(input: HostInput<"repoPatch">, signal: AbortSignal): Promise<HostOutput<"repoPatch">> {
  return guard(async () => {
    const { path, previousPath, untracked, target } = input;
    const { root, head } = await checkoutIdentity(input.root, signal, input.excludedRoots);
    checkPaths(path, previousPath);
    const oldPath = patchOldPath(path, previousPath);
    const paths = oldPath === path ? [path] : [path, oldPath];
    // Literal pathspecs recurse; a bare trailing slash can also match the gitlink itself in ls-files.
    const pathspec = [...paths.map(literal), ...paths.map((p) => `:(exclude,glob)${p.replace(/[\\*?[]/g, "\\$&")}/**`)];
    const refs = untracked ? { old: null, new: null } : await sideRevisions(root, head, target, signal);
    let largeSides = false;
    for (const p of paths) {
      if (refs.old !== null) {
        const size = await checkPatchBlob(root, refs.old, p, signal);
        if (p === oldPath && size > FULL_SIDE_LIMIT_BYTES) largeSides = true;
      }
      if (refs.new !== null) {
        const size = await checkPatchBlob(root, refs.new, p, signal);
        if (p === path && size > FULL_SIDE_LIMIT_BYTES) largeSides = true;
      } else {
        const size = await workingSize(root, p).catch((error: unknown) => {
          if (error instanceof UnsafeWorkingPath) throw new Unavailable("invalid-input", error.message);
          throw error;
        });
        if (size === null && untracked) throw new Unavailable("git-failed", "The untracked file could not be opened");
        if (size !== null && size > SIDE_LIMIT)
          throw new Unavailable("git-failed", "The file is too large to diff (1 MiB per side)");
        if (p === path && size !== null && size > FULL_SIDE_LIMIT_BYTES) largeSides = true;
      }
    }
    if (!untracked && refs.new === null) {
      const index = await indexBlobs(root, paths, signal, pathspec);
      if (index === null || (await blobSizes(root, index, signal)) === null)
        throw new Unavailable("git-failed", "A staged file is too large or unavailable");
    }
    const output = untracked
      ? await mustGit(root, [...DIFF, "--no-index", "--", "/dev/null", path], signal, [0, 1])
      : await mustGit(
          root,
          [...DIFF, refs.old ?? EMPTY_TREE, ...(refs.new === null ? [] : [refs.new]), "--", ...pathspec],
          signal,
        );
    const { patch, truncated } = truncatePatch(output);
    return {
      outcome: "available" as const,
      patch,
      truncated,
      binary: /^Binary files .* differ$/m.test(patch),
      ...(largeSides ? { largeSides: true as const } : {}),
    };
  });
}

type SideRevisions = { old: string | null; new: string | null };
const revisionCache = shortCache<SideRevisions>(DIFF_CACHE_ENTRIES, DIFF_CACHE_TTL_MS);

async function sideRevisions(
  root: string,
  head: string | null,
  target: HostTarget,
  signal: AbortSignal,
): Promise<SideRevisions> {
  const key = JSON.stringify([root, head, target]);
  const cached = revisionCache.get(key);
  if (cached !== undefined) return cached;
  const value = await resolveSideRevisions(root, head, target, signal);
  signal.throwIfAborted();
  revisionCache.set(key, value);
  return value;
}

// `null` for the new side is the working tree, which is always read live.
async function resolveSideRevisions(
  root: string,
  head: string | null,
  target: HostTarget,
  signal: AbortSignal,
): Promise<SideRevisions> {
  if (target.type === "range") {
    const range = await resolveRange(root, target.base, target.head, signal);
    const base = (await mustGit(root, ["merge-base", range.base, range.head], signal)).trim();
    checkSha(base);
    return { old: base, new: range.head };
  }
  if (target.type === "commit") {
    const [parent, sha] = await resolveCommit(root, target.sha, signal);
    return { old: parent === EMPTY_TREE ? null : parent!, new: sha! };
  }
  if (target.type === "committed") {
    const committed = await resolveMergeBase(root, target.base, signal);
    if (committed === null) throw new Unavailable("missing-ref", "There is no base branch to compare with");
    return { old: committed.commit, new: head ?? EMPTY_TREE };
  }
  const mergeBase = target.type === "merge-base" ? await resolveMergeBase(root, target.base, signal) : null;
  const old = mergeBase?.commit ?? head ?? EMPTY_TREE;
  return { old: old === EMPTY_TREE ? null : old, new: null };
}

type BlobEntry = { sha: string; size: number } | "non-file" | null;
const blobCache = shortCache<BlobEntry>(DIFF_CACHE_ENTRIES, DIFF_CACHE_TTL_MS);

async function blobEntry(root: string, revision: string, path: string, signal: AbortSignal): Promise<BlobEntry> {
  const key = JSON.stringify([root, revision, path]);
  const cached = blobCache.get(key);
  if (cached !== undefined) return cached;
  const listing = await mustGit(root, ["ls-tree", "-l", "-z", revision, "--", literal(path)], signal);
  const value = parseBlobEntry(listing, path);
  signal.throwIfAborted();
  blobCache.set(key, value);
  return value;
}

function parseBlobEntry(listing: string, path: string): BlobEntry {
  if (listing === "") return null;
  const entry = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t([^\0]*)\0$/.exec(listing);
  if (entry === null || entry[5] !== path) return "non-file";
  if (entry[1] === "040000" && entry[2] === "tree") return null;
  if (entry[2] !== "blob" || !regularMode(entry[1])) return "non-file";
  const size = Number(entry[4]);
  if (!Number.isSafeInteger(size)) throw new Unavailable("git-failed", "The Git blob is not available");
  return { sha: entry[3]!, size };
}

async function checkPatchBlob(root: string, revision: string, path: string, signal: AbortSignal): Promise<number> {
  const blob = await blobEntry(root, revision, path, signal);
  if (blob === "non-file") throw new Unavailable("git-failed", "Only regular files can be diffed");
  if (blob !== null && blob.size > SIDE_LIMIT)
    throw new Unavailable("git-failed", "The file is too large to diff (1 MiB per side)");
  return blob?.size ?? 0;
}

async function blobBytesAt(
  root: string,
  revision: string,
  path: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer | null; tooLarge: boolean }> {
  const blob = await blobEntry(root, revision, path, signal);
  if (blob === null || blob === "non-file") return { bytes: null, tooLarge: false };
  if (blob.size > limit) return { bytes: null, tooLarge: true };
  const result = await git.run(root, ["cat-file", "blob", blob.sha], { lane: gitLane(), signal, outputLimit: limit });
  if (result.code !== 0 || result.stdout.length !== blob.size)
    throw new Unavailable("git-failed", "The Git blob could not be read");
  return { bytes: result.stdout, tooLarge: false };
}

async function fileSides(input: HostInput<"fileSides">, signal: AbortSignal): Promise<HostOutput<"fileSides">> {
  return guard(async () => {
    const { path, previousPath, untracked, target } = input;
    const { root, head } = await checkoutIdentity(input.root, signal, input.excludedRoots);
    checkPaths(path, previousPath);
    const revisions = untracked ? { old: null, new: null } : await sideRevisions(root, head, target, signal);
    const [old, next] = await Promise.all([
      revisions.old === null
        ? null
        : blobBytesAt(root, revisions.old, patchOldPath(path, previousPath), FULL_SIDE_LIMIT_BYTES, signal),
      revisions.new === null
        ? readWorkingFile(root, path, FULL_SIDE_LIMIT_BYTES, signal).catch((error: unknown) => {
            if (error instanceof UnsafeWorkingPath) return null;
            throw error;
          })
        : blobBytesAt(root, revisions.new, path, FULL_SIDE_LIMIT_BYTES, signal),
    ]);
    if (old?.tooLarge === true || next?.tooLarge === true)
      return { outcome: "available" as const, old: null, new: null, largeSides: true as const };
    const text = (bytes: Buffer | null | undefined) => (bytes != null && isText(bytes) ? bytes.toString("utf8") : null);
    return { outcome: "available" as const, old: text(old?.bytes), new: text(next?.bytes) };
  });
}

async function imageSides(input: HostInput<"imageSides">, signal: AbortSignal): Promise<HostOutput<"imageSides">> {
  return guard(async () => {
    const { path, previousPath, untracked, target } = input;
    const { root, head } = await checkoutIdentity(input.root, signal, input.excludedRoots);
    checkPaths(path, previousPath);
    const revisions = untracked ? { old: null, new: null } : await sideRevisions(root, head, target, signal);
    const [old, next] = await Promise.all([
      revisions.old === null
        ? { bytes: null, tooLarge: false }
        : blobBytesAt(root, revisions.old, patchOldPath(path, previousPath), IMAGE_LIMIT, signal),
      revisions.new === null
        ? readWorkingFile(root, path, IMAGE_LIMIT, signal)
        : blobBytesAt(root, revisions.new, path, IMAGE_LIMIT, signal),
    ]);
    return {
      outcome: "available" as const,
      old: old.bytes?.toString("base64") ?? null,
      new: next.bytes?.toString("base64") ?? null,
      truncated: old.tooLarge || next.tooLarge,
    };
  });
}

async function resolveRoots(
  input: HostInput<"resolveRoots">,
  signal: AbortSignal,
): Promise<HostOutput<"resolveRoots">> {
  const exclusions = exclusionGate(input.excludedRoots);
  const tops = new Map<string, Promise<{ root: string; prefix: string } | null>>();
  const topOf = (dir: string) => {
    let top = tops.get(dir);
    if (top === undefined) {
      top = runGit(dir, ["rev-parse", "--show-toplevel", "--show-prefix"], signal).then((result) =>
        result.code === 0 ? splitToplevel(result.stdout) : null,
      );
      tops.set(dir, top);
    }
    return top;
  };
  type Found = { root: string; relative: string } | { excluded: true };
  type Probe = Found | { parent: string } | null;
  const excluded = { excluded: true } as const;
  const probes = new Map<string, Promise<Probe>>();
  const inspect = (current: string): Promise<Probe> => {
    const known = probes.get(current);
    if (known !== undefined) return known;
    const probe = (async () => {
      signal.throwIfAborted();
      if (exclusions.blocksPath(current)) return excluded;
      const real = await realpath(current).catch(() => null);
      if (real !== null && (await exclusions.blocksRealPath(real))) return excluded;
      if (real !== null && (await stat(real).catch(() => null))?.isDirectory() === true) {
        // An existing directory must speak for itself: it can contain a nested repo or a submodule's .git file.
        const top = await topOf(real);
        if (top === null) return null;
        if (await exclusions.blocksRealPath(top.root)) return excluded;
        return { root: top.root, relative: top.prefix.replace(/\/$/, "") };
      }
      const parent = dirname(current);
      return parent === current ? null : { parent };
    })();
    probes.set(current, probe);
    return probe;
  };
  const walks = new Map<string, Promise<Found | null>>();
  const walk = (current: string, remaining: number): Promise<Found | null> => {
    signal.throwIfAborted();
    if (remaining === 0) return Promise.resolve(null);
    const key = `${remaining}\0${current}`;
    const known = walks.get(key);
    if (known !== undefined) return known;
    const answer = inspect(current).then(async (step) => {
      if (step === null || !("parent" in step)) return step;
      const above = await walk(step.parent, remaining - 1);
      if (above === null || "excluded" in above) return above;
      const name = basename(current);
      return { root: above.root, relative: above.relative === "" ? name : `${above.relative}/${name}` };
    });
    walks.set(key, answer);
    return answer;
  };
  const results = await mapLimit(input.paths, 4, async (path) => {
    const found = await walk(resolve(expandHome(path)), ROOT_PROBE_LIMIT);
    if (found === null) return { path, root: null, relative: null };
    if ("excluded" in found) return { path, root: null, relative: null, excluded: true as const };
    return { path, ...found };
  });
  return { results };
}

async function verifyRoots(input: HostInput<"verifyRoots">, signal: AbortSignal): Promise<HostOutput<"verifyRoots">> {
  const invalid = await mapLimit([...new Set(input.roots)], 4, async (root) => {
    signal.throwIfAborted();
    try {
      await verifyRoot(root, signal, input.excludedRoots, true);
      signal.throwIfAborted();
      return null;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Unavailable && (error.reason === "not-a-repo" || error.reason === "invalid-input"))
        return root;
      throw error;
    }
  });
  return { invalidRoots: invalid.filter((root) => root !== null) };
}

const bounded = (signal: AbortSignal): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
const background = <T>(read: () => Promise<T>): Promise<T> => lane.run("background", read);

export default experimental_defineHostEntry({
  contract: hostContract,
  dispose: () => {
    baseCache.clear();
    revisionCache.clear();
    blobCache.clear();
    return git.dispose();
  },
  handlers: {
    resolveRoots: (input, { signal }) => background(() => resolveRoots(input, bounded(signal))),
    verifyRoots: (input, { signal }) => background(() => verifyRoots(input, bounded(signal))),
    repoFiles: (input, { signal }) => background(() => repoFiles(input, bounded(signal))),
    checkoutStatus: (input, { signal }) => background(() => checkoutStatus(input, bounded(signal))),
    repoPatch: (input, { signal }) => repoPatch(input, bounded(signal)),
    fileSides: (input, { signal }) => fileSides(input, bounded(signal)),
    imageSides: (input, { signal }) => imageSides(input, bounded(signal)),
    threadCommits: (input, { signal }) => background(() => threadCommits(input, bounded(signal))),
  },
});
