import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract, type GitFile, type HostInput, type HostOutput, type HostTarget, type HostUnavailable } from "./src/contract";
import {
  EMPTY_TREE, FILE_LIMIT, LOG_FORMAT, REFLOG_FORMAT, closestBase, commitsInWindows, foldUntracked, isSafeRef, isSafeRelativePath, isSafeSha,
  parseLog, parseNameStatusZ, parseNumstatZ, parseReflog, parseStatusZ, splitToplevel, statusFromCode, truncatePatch, type GitEntry,
  type NumstatEntry, type UntrackedFolder,
} from "./src/git";
import { limitGit } from "./src/git-exec";
import { mapLimit } from "./src/limit";

const execFileAsync = promisify(execFile);
const execGit = limitGit((args: string[], options: ExecFileOptionsWithStringEncoding) => execFileAsync("git", args, options));
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const UNTRACKED_COUNT_LIMIT = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const COMMIT_LIMIT = 100;
const SIDE_LIMIT = 1024 * 1024;
const REFLOG_LIMIT = 5000;
const DEFAULT_FOLDER_LIMIT = 200;
// A branch with one of these names is a base itself, so its own upstream is a base to compare it with.
const BASE_NAMES = new Set(["main", "master", "trunk", "develop"]);

class Unavailable extends Error {
  constructor(readonly reason: HostUnavailable["reason"], message: string) {
    super(message);
  }
}

interface GitResult { code: number; stdout: string; stderr: string }

async function runGit(root: string, args: readonly string[], signal?: AbortSignal): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execGit(["-C", root, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      signal,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string | null; stdout?: string; stderr?: string; killed?: boolean; name?: string };
    if (failure.code === "ENOENT") throw new Unavailable("git-failed", "git was not found on this machine");
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Unavailable("git-failed", "The output is too large to show");
    if (failure.name === "AbortError") throw new Unavailable("git-failed", "The request was cancelled");
    if (failure.killed === true) throw new Unavailable("git-failed", "git took too long to answer");
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function mustGit(root: string, args: readonly string[], signal?: AbortSignal, okCodes: readonly number[] = [0]): Promise<string> {
  const result = await runGit(root, args, signal);
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
    return { outcome: "unavailable", reason: "git-failed", message: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyRoot(root: string, signal?: AbortSignal): Promise<void> {
  if (!isAbsolute(root)) throw new Unavailable("invalid-input", "The repository root must be an absolute path");
  let real: string;
  try {
    real = await realpath(root);
  } catch {
    throw new Unavailable("not-a-repo", "This folder does not exist");
  }
  const top = await runGit(real, ["rev-parse", "--show-toplevel"], signal);
  if (top.code !== 0) throw new Unavailable("not-a-repo", "This folder is not a git repository");
  const toplevel = await realpath(top.stdout.trim()).catch(() => null);
  if (toplevel !== real) throw new Unavailable("invalid-input", "The folder is not the top of a repository");
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

async function hasCommit(root: string, ref: string, signal?: AbortSignal): Promise<boolean> {
  return (await runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal)).code === 0;
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

async function upstreamOf(root: string, signal?: AbortSignal): Promise<string | null> {
  const result = await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], signal);
  const name = result.stdout.trim();
  return result.code === 0 && isSafeRef(name) ? name : null;
}

// The bases a checkout may have been started from: the one asked for and its copy on origin, origin's default branch,
// origin/main and origin/master, and for a branch that is a base itself, its upstream.
async function baseCandidates(root: string, requested: string | null, branch: string | null, signal?: AbortSignal): Promise<string[]> {
  const names: string[] = [];
  const add = (name: string | null) => { if (name !== null && isSafeRef(name) && !names.includes(name)) names.push(name); };
  add(requested);
  if (requested !== null && !requested.startsWith("origin/")) add(`origin/${requested}`);
  add(await defaultBase(root, signal));
  add("origin/main");
  add("origin/master");
  const short = (name: string) => name.replace(/^origin\//, "");
  if (branch !== null && (BASE_NAMES.has(branch) || names.some((name) => short(name) === branch))) {
    add(await upstreamOf(root, signal));
    add(`origin/${branch}`);
  }
  return names;
}

interface ChosenBase { base: string; commit: string; skipped: { name: string; aheadCount: number } | null }

// With `pick`, the candidate the fewest commits on HEAD are ahead of, so a stale or local base branch does not count
// every commit made upstream since then as this checkout's work. A base that does not resolve is never picked.
async function chooseBase(root: string, requested: string | null, pick: boolean, branch: string | null, signal?: AbortSignal): Promise<ChosenBase | null> {
  if (!pick) {
    const found = await optionalMergeBase(root, requested, signal);
    return found === null ? null : { ...found, skipped: null };
  }
  if (requested !== null) checkRef(requested);
  const names = await baseCandidates(root, requested, branch, signal);
  const measured = await Promise.all(names.map(async (name) => {
    if (!(await hasCommit(root, name, signal))) return null;
    const count = await runGit(root, ["rev-list", "--count", `${name}..HEAD`], signal);
    const ahead = Number(count.stdout.trim());
    return count.code === 0 && Number.isInteger(ahead) ? { name, ahead } : null;
  }));
  const usable = measured.filter((entry) => entry !== null);
  const best = closestBase(usable);
  if (best === null) return null;
  const mergeBase = await runGit(root, ["merge-base", "HEAD", best.name], signal);
  const commit = mergeBase.stdout.trim();
  if (mergeBase.code !== 0 || commit === "") return null;
  const asked = requested === null ? undefined : usable.find((entry) => entry.name === requested);
  const skipped = asked !== undefined && asked.name !== best.name && asked.ahead > best.ahead ? { name: asked.name, aheadCount: asked.ahead } : null;
  return { base: best.name, commit, skipped };
}

async function headTree(root: string, signal?: AbortSignal): Promise<string> {
  return (await hasCommit(root, "HEAD", signal)) ? "HEAD" : EMPTY_TREE;
}

// The merge base of HEAD and the base; a checkout with no base to compare with has none.
async function optionalMergeBase(root: string, requested: string | null, signal?: AbortSignal): Promise<{ base: string; commit: string } | null> {
  try {
    return await resolveMergeBase(root, requested, signal);
  } catch (error) {
    if (error instanceof Unavailable && error.reason === "missing-ref") return null;
    throw error;
  }
}

async function resolveMergeBase(root: string, requested: string | null, signal?: AbortSignal): Promise<{ base: string; commit: string } | null> {
  const base = requested ?? (await defaultBase(root, signal));
  if (base === null) return null;
  checkRef(base);
  const result = await runGit(root, ["merge-base", "HEAD", base], signal);
  const commit = result.stdout.trim();
  if (result.code !== 0 || commit === "") throw new Unavailable("missing-ref", `Could not compare with ${base}`);
  return { base, commit };
}

async function resolveRange(root: string, requested: string | null, head: string, signal?: AbortSignal): Promise<{ base: string; head: string }> {
  checkRef(head);
  const base = requested ?? (await defaultBase(root, signal));
  if (base === null) throw new Unavailable("missing-ref", "There is no base branch to compare with");
  checkRef(base);
  const headRef = `refs/heads/${head}`;
  if (!(await hasCommit(root, headRef, signal))) throw new Unavailable("missing-ref", `The branch ${head} no longer exists`);
  if (!(await hasCommit(root, base, signal))) throw new Unavailable("missing-ref", `The base ${base} was not found`);
  return { base, head: headRef };
}

// The commit and its first parent; the empty tree stands in for the parent of a root commit.
async function resolveCommit(root: string, sha: string, signal?: AbortSignal): Promise<string[]> {
  checkSha(sha);
  if (!(await hasCommit(root, sha, signal))) throw new Unavailable("git-failed", `The commit ${sha.slice(0, 12)} was not found`);
  const parent = await runGit(root, ["rev-parse", "--verify", "--quiet", `${sha}^`], signal);
  return [parent.code === 0 ? `${sha}^` : EMPTY_TREE, sha];
}

async function countUntracked(root: string, path: string): Promise<Pick<GitFile, "additions" | "deletions" | "binary">> {
  const unknown = { additions: null, deletions: null, binary: false };
  try {
    const full = join(root, path);
    const info = await lstat(full);
    if (!info.isFile()) return unknown;
    if (info.size > UNTRACKED_COUNT_LIMIT) {
      const handle = await open(full, "r");
      try {
        const head = Buffer.alloc(BINARY_SNIFF_BYTES);
        const { bytesRead } = await handle.read(head, 0, BINARY_SNIFF_BYTES, 0);
        return { additions: null, deletions: null, binary: head.subarray(0, bytesRead).includes(0) };
      } finally {
        await handle.close();
      }
    }
    const content = await readFile(full);
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { additions: null, deletions: null, binary: true };
    const text = content.toString("utf8");
    const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { additions: lines, deletions: 0, binary: false };
  } catch {
    return unknown;
  }
}

async function toGitFiles(root: string, entries: readonly GitEntry[], stats: ReadonlyMap<string, NumstatEntry>): Promise<GitFile[]> {
  return mapLimit(entries, 8, async (entry): Promise<GitFile> => {
    const status = statusFromCode(entry.code);
    const previousPath = entry.previousPath ?? stats.get(entry.path)?.previousPath ?? null;
    if (status === "untracked") return { path: entry.path, previousPath, status, ...(await countUntracked(root, entry.path)) };
    const stat = stats.get(entry.path);
    return {
      path: entry.path, previousPath, status,
      additions: stat?.additions ?? null, deletions: stat?.deletions ?? null,
      binary: stat !== undefined && stat.additions === null,
    };
  });
}

const byPath = (a: GitEntry, b: GitEntry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

async function capped(root: string, entries: GitEntry[], stats: ReadonlyMap<string, NumstatEntry>): Promise<{ files: GitFile[]; truncated: boolean }> {
  const sorted = [...entries].sort(byPath);
  return { files: await toGitFiles(root, sorted.slice(0, FILE_LIMIT), stats), truncated: sorted.length > FILE_LIMIT };
}

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"] as const;

const folderFile = (folder: UntrackedFolder): GitFile => ({
  path: folder.path, previousPath: null, status: "untracked", additions: null, deletions: null, binary: false,
  folder: { files: folder.files, repository: folder.repository, sample: folder.sample },
});

// Untracked folders too big to read file by file, or holding a repository of their own, become one entry each.
async function withFolders(
  root: string, entries: GitEntry[], limit: number, signal?: AbortSignal,
): Promise<{ entries: GitEntry[]; folders: GitFile[] }> {
  if (!entries.some((entry) => entry.code === "??")) return { entries, folders: [] };
  const listing = await mustGit(root, ["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z"], signal);
  const folded = foldUntracked(entries, listing.split("\0").filter((path) => path.endsWith("/")), limit);
  return { entries: folded.entries, folders: folded.folders.map(folderFile) };
}

async function cappedWithFolders(
  root: string, entries: GitEntry[], stats: ReadonlyMap<string, NumstatEntry>, limit: number, signal?: AbortSignal,
): Promise<{ files: GitFile[]; truncated: boolean }> {
  const folded = await withFolders(root, entries, limit, signal);
  const { files, truncated } = await capped(root, folded.entries, stats);
  return { files: [...files, ...folded.folders].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), truncated };
}

async function uncommittedFiles(root: string, limit: number, signal?: AbortSignal): Promise<{ files: GitFile[]; truncated: boolean }> {
  const tree = await headTree(root, signal);
  const [status, numstat] = await Promise.all([
    mustGit(root, STATUS_ARGS, signal),
    mustGit(root, ["diff", "--numstat", "-z", "-M", tree], signal),
  ]);
  return cappedWithFolders(root, parseStatusZ(status), parseNumstatZ(numstat), limit, signal);
}

async function committedFiles(
  root: string, revisions: readonly string[], untracked: boolean, signal?: AbortSignal, limit = DEFAULT_FOLDER_LIMIT,
): Promise<{ files: GitFile[]; truncated: boolean }> {
  const [nameStatus, numstat, status] = await Promise.all([
    mustGit(root, ["diff", "--name-status", "-z", "-M", ...revisions], signal),
    mustGit(root, ["diff", "--numstat", "-z", "-M", ...revisions], signal),
    untracked ? mustGit(root, STATUS_ARGS, signal) : Promise.resolve(""),
  ]);
  const entries = [...parseNameStatusZ(nameStatus), ...parseStatusZ(status).filter((entry) => entry.code === "??")];
  return untracked ? cappedWithFolders(root, entries, parseNumstatZ(numstat), limit, signal) : capped(root, entries, parseNumstatZ(numstat));
}

async function repoFiles(input: HostInput<"repoFiles">, signal: AbortSignal): Promise<HostOutput<"repoFiles">> {
  return guard(async () => {
    const { root, target } = input;
    const limit = input.folderLimit ?? DEFAULT_FOLDER_LIMIT;
    await verifyRoot(root, signal);
    if (target.type === "range") {
      const range = await resolveRange(root, target.base, target.head, signal);
      const [{ files, truncated }, ahead, behind, log] = await Promise.all([
        committedFiles(root, [`${range.base}...${range.head}`], false, signal),
        mustGit(root, ["rev-list", "--count", `${range.base}..${range.head}`], signal),
        mustGit(root, ["rev-list", "--count", `${range.head}..${range.base}`], signal),
        mustGit(root, ["log", "-n", String(COMMIT_LIMIT), `--format=${LOG_FORMAT}`, `${range.base}..${range.head}`], signal),
      ]);
      return {
        outcome: "available" as const, branch: target.head, base: range.base, aheadCount: Number(ahead.trim()),
        behindCount: Number(behind.trim()), commits: parseLog(log), files, truncated,
      };
    }
    if (target.type === "commit") {
      const { files, truncated } = await committedFiles(root, await resolveCommit(root, target.sha, signal), false, signal);
      return { outcome: "available" as const, branch: null, base: null, aheadCount: null, behindCount: null, commits: [], files, truncated };
    }
    if (target.type === "committed") {
      const [branch, mergeBase] = await Promise.all([currentBranch(root, signal), resolveMergeBase(root, target.base, signal)]);
      if (mergeBase === null) throw new Unavailable("missing-ref", "There is no base branch to compare with");
      const { files, truncated } = await committedFiles(root, [mergeBase.commit, "HEAD"], false, signal);
      return { outcome: "available" as const, branch, base: mergeBase.base, aheadCount: null, behindCount: null, commits: [], files, truncated };
    }
    const branch = await currentBranch(root, signal);
    const mergeBase = target.type === "merge-base" ? await resolveMergeBase(root, target.base, signal) : null;
    if (mergeBase === null) {
      const { files, truncated } = await uncommittedFiles(root, limit, signal);
      return { outcome: "available" as const, branch, base: null, aheadCount: null, behindCount: null, commits: [], files, truncated };
    }
    const [{ files, truncated }, ahead] = await Promise.all([
      committedFiles(root, [mergeBase.commit], true, signal, limit),
      mustGit(root, ["rev-list", "--count", `${mergeBase.commit}..HEAD`], signal),
    ]);
    return {
      outcome: "available" as const, branch, base: mergeBase.base, aheadCount: Number(ahead.trim()), behindCount: null, commits: [], files, truncated,
    };
  });
}

// Everything a worktree row shows for a checkout bb does not manage, in one call that both views share.
async function checkoutStatus(input: HostInput<"checkoutStatus">, signal: AbortSignal): Promise<HostOutput<"checkoutStatus">> {
  return guard(async () => {
    const { root } = input;
    await verifyRoot(root, signal);
    const branch = await currentBranch(root, signal);
    const [head, uncommitted, mergeBase] = await Promise.all([
      headSha(root, signal), uncommittedFiles(root, input.folderLimit ?? DEFAULT_FOLDER_LIMIT, signal),
      chooseBase(root, input.base, input.pick === true, branch, signal),
    ]);
    if (mergeBase === null) {
      return {
        outcome: "available" as const, branch, head, base: null, skippedBase: null, aheadCount: null, behindCount: null, commits: [],
        uncommitted: uncommitted.files, committed: [], truncated: uncommitted.truncated,
      };
    }
    const [committed, counts, log] = await Promise.all([
      committedFiles(root, [mergeBase.commit, "HEAD"], false, signal),
      mustGit(root, ["rev-list", "--left-right", "--count", `${mergeBase.base}...HEAD`], signal),
      mustGit(root, ["log", "-n", String(COMMIT_LIMIT), `--format=${LOG_FORMAT}`, `${mergeBase.commit}..HEAD`], signal),
    ]);
    const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
    return {
      outcome: "available" as const, branch, head, base: mergeBase.base, skippedBase: mergeBase.skipped, aheadCount: ahead ?? null, behindCount: behind ?? null,
      commits: parseLog(log), uncommitted: uncommitted.files, committed: committed.files, truncated: uncommitted.truncated || committed.truncated,
    };
  });
}

// The commit just before the oldest of these: the parent of their common ancestor when it is one of them, the ancestor
// itself when it is not. Null for a root commit, which has nothing before it, and when a merge lies between it and HEAD:
// a diff from there would bring in everything the merge did, so those threads' work cannot be shown on its own.
async function sinceCommit(root: string, shas: readonly string[], signal: AbortSignal): Promise<string | null> {
  const common = shas.length === 1 ? shas[0]! : (await runGit(root, ["merge-base", "--octopus", ...shas], signal)).stdout.trim();
  if (!isSafeSha(common)) return null;
  let since = common;
  if (shas.includes(common)) {
    const parent = await runGit(root, ["rev-parse", "--verify", "--quiet", `${common}^`], signal);
    since = parent.stdout.trim();
    if (parent.code !== 0 || !isSafeSha(since)) return null;
  }
  const merges = await runGit(root, ["rev-list", "--merges", "--count", `${since}..HEAD`], signal);
  return merges.code === 0 && merges.stdout.trim() === "0" ? since : null;
}

// A checkout with no reflog, such as one with no commits yet, has no commits to find.
async function threadCommits(input: HostInput<"threadCommits">, signal: AbortSignal): Promise<HostOutput<"threadCommits">> {
  return guard(async () => {
    const { root, windows } = input;
    await verifyRoot(root, signal);
    const reflog = await runGit(root, ["log", "-g", "--date=unix", `--format=${REFLOG_FORMAT}`, "-n", String(REFLOG_LIMIT), "HEAD"], signal);
    if (reflog.code !== 0) return { outcome: "available" as const, commits: [], total: 0, since: null };
    const candidates = commitsInWindows(parseReflog(reflog.stdout), windows);
    // An amended, reset or rebased commit is no longer on the branch, and one made on another branch never was.
    const onHead = await mapLimit(candidates, 8, async (sha) => (await runGit(root, ["merge-base", "--is-ancestor", sha, "HEAD"], signal)).code === 0);
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

async function patchArgs(root: string, target: HostTarget, signal: AbortSignal): Promise<string[]> {
  if (target.type === "range") {
    const range = await resolveRange(root, target.base, target.head, signal);
    return [`${range.base}...${range.head}`];
  }
  if (target.type === "commit") return resolveCommit(root, target.sha, signal);
  if (target.type === "committed") {
    const committed = await resolveMergeBase(root, target.base, signal);
    if (committed === null) throw new Unavailable("missing-ref", "There is no base branch to compare with");
    return [committed.commit, "HEAD"];
  }
  const mergeBase = target.type === "merge-base" ? await resolveMergeBase(root, target.base, signal) : null;
  return [mergeBase?.commit ?? (await headTree(root, signal))];
}

async function repoPatch(input: HostInput<"repoPatch">, signal: AbortSignal): Promise<HostOutput<"repoPatch">> {
  return guard(async () => {
    const { root, path, previousPath, untracked, target } = input;
    await verifyRoot(root, signal);
    checkPaths(path, previousPath);
    const diff = ["diff", "--no-color", "--no-ext-diff"];
    if (untracked && (await insideRoot(root, path)) === null) throw new Unavailable("invalid-input", `Not inside the repository: ${path}`);
    const output = untracked
      ? await mustGit(root, [...diff, "--no-index", "--", "/dev/null", path], signal, [0, 1])
      : await mustGit(root, [
        ...diff, "-M", ...(await patchArgs(root, target, signal)), "--",
        `:(literal)${path}`, ...(previousPath === null ? [] : [`:(literal)${previousPath}`]),
      ], signal);
    const { patch, truncated } = truncatePatch(output);
    return { outcome: "available" as const, patch, truncated, binary: /^Binary files .* differ$/m.test(patch) };
  });
}

// The revision each side of a target's diff reads from; `null` for the new side is the working tree.
async function sideRevisions(root: string, target: HostTarget, signal: AbortSignal): Promise<{ old: string | null; new: string | null }> {
  if (target.type === "range") {
    const range = await resolveRange(root, target.base, target.head, signal);
    const base = (await mustGit(root, ["merge-base", range.base, range.head], signal)).trim();
    return { old: base, new: range.head };
  }
  if (target.type === "commit") {
    const [parent, sha] = await resolveCommit(root, target.sha, signal);
    return { old: parent === EMPTY_TREE ? null : parent!, new: sha! };
  }
  if (target.type === "committed") {
    const committed = await resolveMergeBase(root, target.base, signal);
    if (committed === null) throw new Unavailable("missing-ref", "There is no base branch to compare with");
    return { old: committed.commit, new: "HEAD" };
  }
  const mergeBase = target.type === "merge-base" ? await resolveMergeBase(root, target.base, signal) : null;
  const old = mergeBase?.commit ?? (await headTree(root, signal));
  return { old: old === EMPTY_TREE ? null : old, new: null };
}

const isText = (content: Buffer): boolean => !content.subarray(0, BINARY_SNIFF_BYTES).includes(0);

// Only a regular file's blob: a symlink stored in git is its target's name, and a tree is not a file.
async function blobAt(root: string, revision: string, path: string, signal: AbortSignal): Promise<string | null> {
  const listing = await runGit(root, ["ls-tree", "-l", "-z", revision, "--", `:(literal)${path}`], signal);
  if (listing.code !== 0) return null;
  const entry = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t([^\0]*)\0/.exec(listing.stdout);
  if (entry === null || entry[5] !== path || entry[2] !== "blob" || (entry[1] !== "100644" && entry[1] !== "100755")) return null;
  if (Number(entry[4]) > SIDE_LIMIT) return null;
  const content = await mustGit(root, ["cat-file", "blob", entry[3]!], signal);
  return content.includes("\0") ? null : content;
}

// The file's own folder, with every symlink in it resolved, must still be inside the repository; checkPaths only looks at
// the text of the path, and a symlinked folder could point anywhere.
async function insideRoot(root: string, path: string): Promise<string | null> {
  const full = join(root, path);
  try {
    const [realRoot, folder] = await Promise.all([realpath(root), realpath(dirname(full))]);
    if (folder !== realRoot && !folder.startsWith(realRoot + sep)) return null;
    return join(folder, basename(full));
  } catch {
    return null;
  }
}

// Opened once, without following a symlink, and read with a bound, so a file swapped or grown after the check is not read.
async function workingFile(root: string, path: string): Promise<string | null> {
  const full = await insideRoot(root, path);
  if (full === null) return null;
  let handle;
  try {
    handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > SIDE_LIMIT) return null;
    const buffer = Buffer.alloc(SIDE_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, SIDE_LIMIT + 1, 0);
    if (bytesRead > SIDE_LIMIT) return null;
    const content = buffer.subarray(0, bytesRead);
    return isText(content) ? content.toString("utf8") : null;
  } finally {
    await handle.close();
  }
}

async function fileSides(input: HostInput<"fileSides">, signal: AbortSignal): Promise<HostOutput<"fileSides">> {
  return guard(async () => {
    const { root, path, previousPath, untracked, target } = input;
    await verifyRoot(root, signal);
    checkPaths(path, previousPath);
    const revisions = untracked ? { old: null, new: null } : await sideRevisions(root, target, signal);
    const [old, next] = await Promise.all([
      revisions.old === null ? null : blobAt(root, revisions.old, previousPath ?? path, signal),
      revisions.new === null ? workingFile(root, path) : blobAt(root, revisions.new, path, signal),
    ]);
    return { outcome: "available" as const, old, new: next };
  });
}

async function nearestDirectory(path: string): Promise<{ dir: string; rest: string[] }> {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    const info = await stat(current).catch(() => null);
    const parent = dirname(current);
    if (info?.isDirectory() === true || parent === current) return { dir: current, rest };
    rest.unshift(basename(current));
    current = parent;
  }
}

const expandHome = (path: string): string => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

async function resolveRoots(input: HostInput<"resolveRoots">, signal: AbortSignal): Promise<HostOutput<"resolveRoots">> {
  const located = await mapLimit(input.paths, 8, async (path) => ({ path, ...(await nearestDirectory(expandHome(path))) }));
  const tops = new Map<string, Promise<{ root: string; prefix: string } | null>>();
  const topOf = (dir: string) => {
    let top = tops.get(dir);
    if (top === undefined) {
      top = runGit(dir, ["rev-parse", "--show-toplevel", "--show-prefix"], signal)
        .then((result) => (result.code === 0 ? splitToplevel(result.stdout) : null))
        .catch(() => null);
      tops.set(dir, top);
    }
    return top;
  };
  const results = await mapLimit(located, 8, async ({ path, dir, rest }) => {
    const top = await topOf(dir);
    if (top === null) return { path, root: null, relative: null };
    return { path, root: top.root, relative: `${top.prefix}${rest.join("/")}`.replace(/\/$/, "") };
  });
  return { results };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    resolveRoots: (input, { signal }) => resolveRoots(input, signal),
    repoFiles: (input, { signal }) => repoFiles(input, signal),
    checkoutStatus: (input, { signal }) => checkoutStatus(input, signal),
    repoPatch: (input, { signal }) => repoPatch(input, signal),
    fileSides: (input, { signal }) => fileSides(input, signal),
    threadCommits: (input, { signal }) => threadCommits(input, signal),
  },
});
