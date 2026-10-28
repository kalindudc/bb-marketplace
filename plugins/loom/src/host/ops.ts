// What the host entry runs on the machine that owns the checkout: git through argv, never a shell, and check
// commands in their own process group. host.ts wires these to RPC handlers; tests call them directly.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { experimental_runVcsProcess, type ExperimentalVcsProcessPriority } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { GIT_NETWORK_TIMEOUT_MS } from "../git-network";
import { BLOB_MAX_BYTES, githubPull, prNumber, REPLY_MARK, RETARGET_COMMAND_MS, REVIEW_DECISIONS, type HostInput, type HostOutput } from "../host-contract";

const GIT_TIMEOUT_MS = 30_000;
// gh calls, the first checkout of the integration worktree and merge-tree can take a while on a slow link or a large
// repository. A git fetch, ls-remote or push gets the call's networkTimeoutMs, from the repo's git_network_timeout_seconds,
// else GIT_NETWORK_TIMEOUT_MS.
const NETWORK_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const FORGE_COMMAND_MS = 120_000;
const OUTPUT_HEAD_BYTES = 16 * 1024;
const OUTPUT_TAIL_BYTES = 48 * 1024;

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

// git and gh wait for a turn in bb's VCS scheduler, which caps how many run at once in this process. Loom's engine work is
// background; the Changes tab's reads, which a person waits on, are interactive.
type Priority = ExperimentalVcsProcessPriority;
const INTERACTIVE: Priority = "interactive";

type GitEnv = Record<string, string>;

function run(cwd: string, args: readonly string[], signal?: AbortSignal, timeout = GIT_TIMEOUT_MS, priority: Priority = "background", env: GitEnv = {}): Promise<GitRun> {
  const argv = ["-C", cwd, ...args];
  return experimental_runVcsProcess(
    "git",
    argv,
    () =>
      new Promise<GitRun>((resolve, reject) => {
        execFile(
          "git",
          argv,
          { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env }, maxBuffer: GIT_MAX_BUFFER, timeout, signal, encoding: "utf8" },
          (error, stdout, stderr) => {
            if (error === null) return resolve({ code: 0, stdout, stderr });
            const failure = error as NodeJS.ErrnoException & { killed?: boolean };
            if (typeof failure.code === "number") return resolve({ code: failure.code, stdout, stderr });
            if (failure.killed === true && failure.name !== "AbortError") return reject(new GitTimedOut(`git ${args[0]} took too long`));
            reject(new Error(`git ${args[0]}: ${failure.message}`));
          },
        );
      }),
    { priority, signal },
  );
}

class GitTimedOut extends Error {}

// A fetch, a push or an ls-remote that runs out of its time comes back as a failed run that says so, which remoteFailed reads
// as worth waiting out, as a server that does not answer.
async function runRemote(cwd: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<GitRun> {
  try {
    return await run(cwd, args, signal, timeoutMs);
  } catch (error) {
    if (error instanceof GitTimedOut) return { code: -1, stdout: "", stderr: `git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} seconds` };
    throw error;
  }
}

/** How long each git network step of a host call may take: its networkTimeoutMs, else GIT_NETWORK_TIMEOUT_MS. */
const networkTimeout = (input: { networkTimeoutMs?: number }) => input.networkTimeoutMs ?? GIT_NETWORK_TIMEOUT_MS;

function failure(args: readonly string[], result: GitRun): Error {
  return new Error(`git ${args.join(" ")} failed (${result.code}): ${(result.stderr.trim() || result.stdout.trim()).slice(-2000)}`);
}

/** Runs git in `cwd` and returns stdout; trimmed unless `raw` (NUL-separated listings). Throws when git exits non-zero. */
export async function git(cwd: string, args: readonly string[], opts: { raw?: boolean; signal?: AbortSignal; priority?: Priority; env?: GitEnv } = {}): Promise<string> {
  const result = await run(cwd, args, opts.signal, GIT_TIMEOUT_MS, opts.priority, opts.env);
  if (result.code !== 0) throw failure(args, result);
  return opts.raw === true ? result.stdout : result.stdout.trim();
}

async function tryGit(cwd: string, args: readonly string[], signal?: AbortSignal, priority?: Priority): Promise<string | null> {
  const result = await run(cwd, args, signal, GIT_TIMEOUT_MS, priority);
  return result.code === 0 ? result.stdout.trim() : null;
}

// A bb project's checkout can be a subdirectory of its repository. The paths Loom passes on are relative to the top level,
// as git diff names them and the carry writes them, so a git command that names paths from where it runs, such as
// merge-tree, ls-files or a pathspec, runs there.
const topLevel = (cwd: string, signal?: AbortSignal, priority?: Priority) => git(cwd, ["rev-parse", "--show-toplevel"], { signal, priority });

export async function ensureBranch(input: HostInput<"ensureBranch">, signal?: AbortSignal): Promise<HostOutput<"ensureBranch">> {
  const { repo, branch, from } = input;
  const existing = await tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], signal);
  if (existing !== null) return { sha: existing, created: false };
  const sha = await git(repo, ["rev-parse", "--verify", `${from}^{commit}`], { signal });
  await git(repo, ["branch", "--no-track", branch, sha], { signal });
  return { sha, created: true };
}

export async function worktreeState(input: HostInput<"worktreeState">, signal?: AbortSignal): Promise<HostOutput<"worktreeState">> {
  const { worktree, base, trackedOnly, baseTree } = input;
  const [top = worktree, mergeHead = "", head = "", tree = ""] = (await git(worktree, ["rev-parse", "--show-toplevel", "--git-path", "MERGE_HEAD", "HEAD", "HEAD^{tree}"], { signal })).split("\n");
  const branch = (await tryGit(worktree, ["symbolic-ref", "--short", "-q", "HEAD"], signal)) || null;
  const dirty = (await git(worktree, ["status", "--porcelain", ...(trackedOnly === true ? ["--untracked-files=no"] : [])], { signal })) !== "";
  const onBase = baseTree === undefined ? null : await firstParentWithTree(worktree, head, baseTree, signal);
  const mergeBase = onBase ?? (await git(worktree, ["merge-base", base, "HEAD"], { signal }));
  const tracked = await git(worktree, ["diff", "--name-only", "-z", "--no-renames", mergeBase], { raw: true, signal });
  const untracked = await git(top, ["ls-files", "--others", "--exclude-standard", "-z"], { raw: true, signal });
  const changed = [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter((path) => path !== ""))].sort();
  return { branch, head, tree, dirty, changed, unfinishedMerge: existsSync(resolve(worktree, mergeHead)), ...(baseTree === undefined ? {} : { onBase: onBase !== null }) };
}

const FIRST_PARENT_LIMIT = 200;

/** The newest commit from `head` down its first parents, at most FIRST_PARENT_LIMIT of them, whose tree is `tree`; read with cat-file, which a machine's git has. */
async function firstParentWithTree(worktree: string, head: string, tree: string, signal?: AbortSignal): Promise<string | null> {
  let sha: string | undefined = head;
  for (let step = 0; sha !== undefined && step < FIRST_PARENT_LIMIT; step += 1) {
    const raw = await git(worktree, ["cat-file", "commit", sha], { raw: true, signal });
    const headers = raw.slice(0, raw.indexOf("\n\n") === -1 ? raw.length : raw.indexOf("\n\n"));
    if (/^tree ([0-9a-f]+)$/mu.exec(headers)?.[1] === tree) return sha;
    sha = /^parent ([0-9a-f]+)$/mu.exec(headers)?.[1];
  }
  return null;
}

// Commits and merges need an author; the Loom identity is used only when git has none.
async function identityArgs(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const email = await tryGit(cwd, ["config", "--get", "user.email"], signal);
  return email ? [] : ["-c", "user.name=Loom", "-c", "user.email=loom@localhost"];
}

export async function commitAll(input: HostInput<"commitAll">, signal?: AbortSignal): Promise<HostOutput<"commitAll">> {
  const { worktree, message } = input;
  await git(worktree, ["add", "-A"], { signal });
  const staged = await run(worktree, ["diff", "--cached", "--quiet"], signal);
  if (staged.code !== 0 && staged.code !== 1) throw failure(["diff", "--cached", "--quiet"], staged);
  const committed = staged.code === 1;
  if (committed) {
    await git(worktree, [...(await identityArgs(worktree, signal)), "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", message], { signal });
  }
  return { sha: await git(worktree, ["rev-parse", "HEAD"], { signal }), committed };
}

const tail = (text: string, max = 2000) => text.trim().slice(-max);

// ---------------------------------------------------------------- review and merge

export async function diff(input: HostInput<"diff">, signal?: AbortSignal): Promise<HostOutput<"diff">> {
  const { repo, base, head, maxBytes } = input;
  const range = `${base}...${head}`;
  const stat = await git(repo, ["diff", "--stat", "--no-color", range, "--"], { signal, priority: INTERACTIVE });
  const patch = Buffer.from(await git(repo, ["diff", "--no-color", range, "--"], { raw: true, signal, priority: INTERACTIVE }));
  const truncated = patch.length > maxBytes;
  return { stat, patch: patch.subarray(0, maxBytes).toString("utf8"), truncated };
}

// ---------------------------------------------------------------- the Changes tab

// Between two commits, so the user's diff drivers, text conversions and rename detection do not change what the page shows.
const PLAIN_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"] as const;
const NO_BLOB = /^0+$/u;
type ChangedFile = Extract<HostOutput<"changedFiles">, { outcome: "ok" }>["files"][number];
const STATUS_OF: Record<string, ChangedFile["status"]> = { A: "added", D: "deleted", T: "type_changed" };

const commitOf = (repo: string, ref: string, signal?: AbortSignal, priority?: Priority) => tryGit(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal, priority);
const missing = (message: string) => ({ outcome: "missing" as const, message });

/** With `landed`, a head that base already contains is compared with base as it was before the merge that brought it in, on base's first-parent line. */
async function compareFrom(repo: string, target: string, head: string, landed: boolean, signal?: AbortSignal, priority?: Priority): Promise<string | null> {
  const base = await tryGit(repo, ["merge-base", target, head], signal, priority);
  if (base === null || !landed || base !== head) return base;
  const merge = (await git(repo, ["rev-list", "--first-parent", "--ancestry-path", `${head}..${target}`], { signal, priority })).split("\n").filter((line) => line !== "").at(-1);
  const before = merge === undefined ? null : await commitOf(repo, `${merge}^1`, signal, priority);
  return (before === null ? null : await tryGit(repo, ["merge-base", before, head], signal, priority)) ?? base;
}

export async function changedFiles(input: HostInput<"changedFiles">, signal?: AbortSignal): Promise<HostOutput<"changedFiles">> {
  const { repo, maxFiles } = input;
  const head = await commitOf(repo, input.head, signal, INTERACTIVE);
  if (head === null) return missing(`${input.head} is not in the repository.`);
  const target = await commitOf(repo, input.base, signal, INTERACTIVE);
  if (target === null) return missing(`${input.base} is not in the repository.`);
  const base = input.mergeBase ? await compareFrom(repo, target, head, input.landed === true, signal, INTERACTIVE) : target;
  if (base === null) return missing(`${input.head} and ${input.base} share no history.`);

  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const entry of (await git(repo, ["diff", "--numstat", "-z", ...PLAIN_DIFF, base, head, "--"], { raw: true, signal, priority: INTERACTIVE })).split("\0")) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/su.exec(entry);
    if (match === null) continue;
    const binary = match[1] === "-";
    counts.set(match[3]!, { additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary });
  }
  const parts = (await git(repo, ["diff", "--raw", "-z", "--no-abbrev", ...PLAIN_DIFF, base, head, "--"], { raw: true, signal, priority: INTERACTIVE })).split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = parts[index]!;
    const path = parts[index + 1]!;
    if (!meta.startsWith(":")) continue;
    const [, , , blob = "", letter = "M"] = meta.slice(1).split(" ");
    const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
    files.push({ path, status: STATUS_OF[letter[0]!] ?? "modified", ...count, blob: NO_BLOB.test(blob) ? null : blob });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { outcome: "ok", base, head, files: files.slice(0, maxFiles), truncated: files.length > maxFiles };
}

export async function filePatch(input: HostInput<"filePatch">, signal?: AbortSignal): Promise<HostOutput<"filePatch">> {
  const { repo, base, head, path, maxBytes } = input;
  for (const ref of [base, head]) if ((await commitOf(repo, ref, signal, INTERACTIVE)) === null) return missing(`${ref} is not in the repository.`);
  const args = ["--literal-pathspecs", "diff", ...PLAIN_DIFF, "--src-prefix=a/", "--dst-prefix=b/", base, head, "--", path];
  const patch = Buffer.from(await git(await topLevel(repo, signal, INTERACTIVE), args, { raw: true, signal, priority: INTERACTIVE }));
  return { outcome: "ok", patch: patch.subarray(0, maxBytes).toString("utf8"), truncated: patch.length > maxBytes };
}

const checkedOutElsewhere = /is already (?:used by worktree|checked out) at/u;

// The repository a checkout or a linked worktree belongs to: the same for the main checkout and every worktree of it.
async function commonDir(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const dir = await tryGit(cwd, ["rev-parse", "--git-common-dir"], signal);
  return dir === null ? null : realpathSync(resolve(cwd, dir));
}

/**
 * The plugin's own worktree of the integration branch, under the plugin's data directory. An existing one is checked first
 * (it must be a worktree of this repository, on this branch) and refused untouched when it is not; only then is a half-done
 * merge aborted and stray files cleaned.
 */
export async function ensureWorktree(input: HostInput<"ensureWorktree">, dataDir: string, signal?: AbortSignal): Promise<HostOutput<"ensureWorktree">> {
  const { repo, key, branch } = input;
  // A provisioned path comes from the spec's worktree command: Loom uses it as it is and may switch its branch.
  const provisioned = input.path !== undefined;
  const path = input.path ?? join(dataDir, "worktrees", key);
  const unavailable = (reason: "branch_checked_out" | "git", message: string): HostOutput<"ensureWorktree"> => ({ outcome: "unavailable", reason, message });

  if (!existsSync(path)) {
    if (provisioned) return unavailable("git", `The integration worktree command printed ${path}, which does not exist.`);
    await git(repo, ["worktree", "prune"], { signal });
    mkdirSync(dirname(path), { recursive: true });
    const added = await run(repo, ["worktree", "add", path, branch], signal, NETWORK_TIMEOUT_MS);
    if (added.code === 0) return { outcome: "ok", path };
    const message = tail(added.stderr || added.stdout);
    return unavailable(checkedOutElsewhere.test(message) ? "branch_checked_out" : "git", message);
  }

  const top = await tryGit(path, ["rev-parse", "--show-toplevel"], signal);
  if (top === null || realpathSync(top) !== realpathSync(path)) return unavailable("git", `The Loom worktree path ${path} exists but is not a git worktree; move it away.`);
  const owner = await commonDir(path, signal);
  const expected = await commonDir(repo, signal);
  if (owner === null || owner !== expected) return unavailable("git", `The Loom worktree at ${path} belongs to the repository ${owner ?? "(unknown)"}, not ${expected ?? repo}; move it away.`);
  const current = (await tryGit(path, ["symbolic-ref", "--short", "-q", "HEAD"], signal)) || null;
  if (current !== branch) {
    if (!provisioned) return unavailable("git", `The Loom worktree at ${path} is on ${current ?? "a detached HEAD"}, not ${branch}.`);
    if ((await git(path, ["status", "--porcelain", "--untracked-files=no"], { signal })) !== "") {
      return unavailable("git", `The integration worktree at ${path} is on ${current ?? "a detached HEAD"} with uncommitted changes, so Loom cannot switch it to ${branch}. Commit or discard them, or make the worktree command prepare a clean checkout.`);
    }
    const switched = await run(path, ["switch", branch], signal);
    if (switched.code !== 0) {
      const message = tail(switched.stderr || switched.stdout);
      return unavailable(checkedOutElsewhere.test(message) ? "branch_checked_out" : "git", message);
    }
  }

  if ((await tryGit(path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], signal)) !== null) await run(path, ["merge", "--abort"], signal);
  await git(path, ["reset", "--hard", "HEAD"], { signal });
  await git(path, ["clean", "-fd"], { signal });
  return { outcome: "ok", path };
}

/**
 * Merges exactly `ref` with a merge commit. A rerun after the commit exists reports `already`; the history cannot say whose
 * merge that was, so the rollback point is the one the caller persisted before the first run, or HEAD when it has none. A
 * worktree with a merge its worker began and did not finish is `unfinished`, untouched: aborting it would lose their resolution.
 */
export async function merge(input: HostInput<"merge">, signal?: AbortSignal): Promise<HostOutput<"merge">> {
  const { worktree, message } = input;
  if ((await tryGit(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], signal)) !== null) return { outcome: "unfinished" };
  const target = await git(worktree, ["rev-parse", "--verify", `${input.ref}^{commit}`], { signal });
  const head = await git(worktree, ["rev-parse", "HEAD"], { signal });
  const ancestry = await run(worktree, ["merge-base", "--is-ancestor", target, "HEAD"], signal);
  if (ancestry.code === 0) {
    const before = input.before === undefined ? head : await git(worktree, ["rev-parse", "--verify", `${input.before}^{commit}`], { signal });
    return { outcome: "merged", sha: head, before, already: true };
  }
  if (ancestry.code !== 1) throw failure(["merge-base", "--is-ancestor"], ancestry);

  const merged = await run(worktree, [...(await identityArgs(worktree, signal)), "merge", "--no-ff", "--no-edit", "-m", message, target], signal);
  if (merged.code === 0) return { outcome: "merged", sha: await git(worktree, ["rev-parse", "HEAD"], { signal }), before: head, already: false };
  const files = (await git(worktree, ["diff", "--name-only", "--diff-filter=U", "-z"], { raw: true, signal })).split("\0").filter((file) => file !== "");
  await run(worktree, ["merge", "--abort"], signal);
  if (files.length === 0) throw failure(["merge", target], merged);
  return { outcome: "conflict", files };
}

export async function resetHard(input: HostInput<"resetHard">, signal?: AbortSignal): Promise<HostOutput<"resetHard">> {
  await git(input.worktree, ["reset", "--hard", input.sha], { signal });
  return { sha: await git(input.worktree, ["rev-parse", "HEAD"], { signal }) };
}

export async function push(input: HostInput<"push">, signal?: AbortSignal): Promise<HostOutput<"push">> {
  const { repo, remote, src, branch } = input;
  const pushed = await runRemote(repo, ["push", remote, `${src}:refs/heads/${branch}`], networkTimeout(input), signal);
  return pushed.code === 0 ? { outcome: "ok" } : remoteFailed(`git push to ${remote}`, pushed);
}

const isAncestor = async (repo: string, ancestor: string, of: string, signal?: AbortSignal): Promise<boolean> => {
  const checked = await run(repo, ["merge-base", "--is-ancestor", ancestor, of], signal);
  if (checked.code === 0 || checked.code === 1) return checked.code === 0;
  throw failure(["merge-base", "--is-ancestor", ancestor, of], checked);
};

/** A branch's tip where `git push` sends it, which a remote that fetches from elsewhere does not show; null when the branch is not there. */
async function listedTip(repo: string, remote: string, branch: string, timeoutMs: number, signal?: AbortSignal): Promise<{ tip: string | null; target: string } | UnavailableAnswer> {
  const pushUrls = (await tryGit(repo, ["remote", "get-url", "--push", "--all", remote], signal))?.split("\n").filter((line) => line !== "");
  if (pushUrls === undefined || pushUrls.length === 0) return { outcome: "unavailable", message: `The git remote "${remote}" does not exist in ${repo}.` };
  if (pushUrls.length > 1) return { outcome: "unavailable", message: `The remote "${remote}" has ${pushUrls.length} push URLs, so Loom cannot tell which one holds the pull request's branch. Leave one with \`git remote set-url --push ${remote} <url>\`.` };
  const target = pushUrls[0]!;
  const listed = await runRemote(repo, ["ls-remote", target, `refs/heads/${branch}`], timeoutMs, signal);
  if (listed.code !== 0) return remoteFailed(`git ls-remote ${remote}`, listed);
  return { tip: listed.stdout.trim().split(/\s+/u)[0] || null, target };
}

/** A pull request branch's tip where `git push` sends it, with its commits fetched; null when the branch is not there. */
async function pushedTip(repo: string, remote: string, branch: string, timeoutMs: number, signal?: AbortSignal): Promise<{ tip: string | null } | UnavailableAnswer> {
  const read = await listedTip(repo, remote, branch, timeoutMs, signal);
  if ("outcome" in read) return read;
  const { tip, target } = read;
  if (tip !== null && (await tryGit(repo, ["cat-file", "-e", `${tip}^{commit}`], signal)) === null) {
    const fetched = await runRemote(repo, ["fetch", "--no-tags", "--no-write-fetch-head", target, `refs/heads/${branch}`], timeoutMs, signal);
    if (fetched.code !== 0) return remoteFailed(`git fetch from ${remote}`, fetched);
  }
  return { tip };
}

/**
 * The one commit Loom pushes for a ticket's pull request: head's tree on the remote branch's tip, or, when the branch is not
 * there yet, on head's merge base with `base`. When head also contains a newer base than the tip does, that base is a second
 * parent, so the pull request's diff stays the ticket's own; that holds even when head's tree is the tip's, as after
 * merging base commits that changed nothing in the end, so the branch has the base in its history. A tip with head's tree
 * that has the base already is reported as nothing new. It signs as the user's git config says.
 */
export async function prCommit(input: HostInput<"prCommit">, signal?: AbortSignal): Promise<HostOutput<"prCommit">> {
  const { repo, remote, branch, base, head, message, pushed } = input;
  const read = await pushedTip(repo, remote, branch, networkTimeout(input), signal);
  if ("outcome" in read) return read;
  const { tip } = read;
  const tree = await git(repo, ["rev-parse", "--verify", `${head}^{tree}`], { signal });
  const mergeBase = await git(repo, ["merge-base", head, base], { signal });
  const parents: string[] = [];
  if (tip !== null) {
    const hasBase = await isAncestor(repo, mergeBase, tip, signal);
    if (hasBase && (await git(repo, ["rev-parse", "--verify", `${tip}^{tree}`], { signal })) === tree) return { outcome: "ok", sha: tip, created: false };
    if (tip !== pushed && !(await isAncestor(repo, tip, head, signal))) return { outcome: "diverged", tip };
    parents.push(tip);
    if (!hasBase) parents.push(mergeBase);
  } else {
    parents.push(mergeBase);
  }
  return { outcome: "ok", sha: await commitTree(repo, tree, parents, message, signal), created: true };
}

/** Runs git with `input` on stdin, which execFile cannot give, so through spawn; returns stdout trimmed. Throws when git exits non-zero. */
function gitInput(cwd: string, args: readonly string[], input: string, opts: { signal?: AbortSignal; env?: GitEnv; what?: string } = {}): Promise<string> {
  const argv = ["-C", cwd, ...args];
  return experimental_runVcsProcess(
    "git",
    argv,
    () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn("git", argv, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...opts.env }, signal: opts.signal, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), NETWORK_TIMEOUT_MS);
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(`git ${opts.what ?? args[0]} failed (${code ?? "killed"}): ${tail(stderr || stdout)}`));
        });
      }),
    { priority: "background", signal: opts.signal },
  );
}

const SHA = /^[0-9a-f]{40,64}$/u;

async function commitTree(repo: string, tree: string, parents: readonly string[], message: string, signal?: AbortSignal): Promise<string> {
  const identity = await identityArgs(repo, signal);
  const sha = await gitInput(repo, [...identity, "commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-F", "-"], message.endsWith("\n") ? message : `${message}\n`, { signal, what: "commit-tree" });
  if (!SHA.test(sha)) throw new Error(`git commit-tree failed (0): ${tail(sha)}`);
  return sha;
}

/**
 * The commit a stacked ticket starts from or merges in. `base` fetches the remote base branch into its remote-tracking ref,
 * as `git fetch` does, and adds its tip. Commits another one contains are left out; the rest are merged one by one with
 * merge-tree, which touches no worktree. Only a clean result moves `branch`, which no worktree may have checked out.
 */
export async function stackBase(input: HostInput<"stackBase">, signal?: AbortSignal): Promise<HostOutput<"stackBase">> {
  const { repo, branch, message } = input;
  const commits: string[] = [];
  for (const commit of input.commits) commits.push(await git(repo, ["rev-parse", "--verify", `${commit}^{commit}`], { signal }));
  let tip: string | null = null;
  if (input.base !== undefined) {
    const { remote, branch: base } = input.base;
    const tracking = `refs/remotes/${remote}/${base}`;
    const fetched = await runRemote(repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${base}:${tracking}`], networkTimeout(input), signal);
    if (fetched.code !== 0) return remoteFailed(`git fetch from ${remote}`, fetched);
    tip = await git(repo, ["rev-parse", "--verify", `${tracking}^{commit}`], { signal });
    commits.push(tip);
  }
  const unique = [...new Set(commits)];
  if (unique.length === 0) throw new Error("stackBase needs at least one commit or the base branch.");
  const kept: string[] = [];
  for (const commit of unique) {
    let contained = false;
    for (const other of unique) {
      if (other !== commit && (await isAncestor(repo, commit, other, signal))) {
        contained = true;
        break;
      }
    }
    if (!contained) kept.push(commit);
  }
  let sha = kept[0]!;
  const top = kept.length > 1 ? await topLevel(repo, signal) : repo;
  for (const next of kept.slice(1)) {
    const merged = await run(top, ["merge-tree", "--write-tree", "--name-only", "--no-messages", sha, next], signal, NETWORK_TIMEOUT_MS);
    const lines = merged.stdout.split("\n").filter((line) => line !== "");
    if (merged.code === 1) return { outcome: "conflict", files: [...new Set(lines.slice(1))].sort() };
    if (merged.code !== 0 || lines[0] === undefined) throw failure(["merge-tree", "--write-tree", sha, next], merged);
    sha = await commitTree(repo, lines[0], [sha, next], message, signal);
  }
  const worktrees = await git(repo, ["worktree", "list", "--porcelain"], { signal });
  if (worktrees.split("\n").includes(`branch refs/heads/${branch}`)) {
    return { outcome: "unavailable", message: `The branch ${branch} is checked out in a worktree, so Loom cannot move it to the stacked commit. Switch that worktree to another branch.` };
  }
  await git(repo, ["update-ref", `refs/heads/${branch}`, sha], { signal });
  return { outcome: "ok", sha, tip, tree: await git(repo, ["rev-parse", `${sha}^{tree}`], { signal }) };
}

/** The tip of a ticket's pull request branch on `ref`, for a merge on the checkout, and the newest base commit it has. */
export async function fetchTip(input: HostInput<"fetchTip">, signal?: AbortSignal): Promise<HostOutput<"fetchTip">> {
  const { repo, remote, branch, base } = input;
  const read = await pushedTip(repo, remote, branch, networkTimeout(input), signal);
  if ("outcome" in read) return read;
  if (read.tip === null) return { outcome: "missing" };
  const tip = await git(repo, ["rev-parse", "--verify", `${read.tip}^{commit}`], { signal });
  await git(repo, ["update-ref", input.ref, tip], { signal });
  const tracking = `refs/remotes/${remote}/${base}`;
  const fetched = await runRemote(repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${base}:${tracking}`], networkTimeout(input), signal);
  if (fetched.code !== 0) return remoteFailed(`git fetch from ${remote}`, fetched);
  const mainBase = await tryGit(repo, ["merge-base", tip, tracking], signal);
  return { outcome: "ok", sha: tip, tree: await git(repo, ["rev-parse", `${tip}^{tree}`], { signal }), mainBase: mainBase === null || mainBase === "" ? null : mainBase };
}

export async function remoteBranch(input: HostInput<"remoteBranch">, signal?: AbortSignal): Promise<HostOutput<"remoteBranch">> {
  const read = await listedTip(input.repo, input.remote, input.branch, networkTimeout(input), signal);
  return "outcome" in read ? read : { outcome: "ok", sha: read.tip };
}

export async function behindBase(input: HostInput<"behindBase">, signal?: AbortSignal): Promise<HostOutput<"behindBase">> {
  const { repo, remote, base } = input;
  const tracking = `refs/remotes/${remote}/${base}`;
  if (input.fetch) {
    const fetched = await runRemote(repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${base}:${tracking}`], networkTimeout(input), signal);
    if (fetched.code !== 0) return remoteFailed(`git fetch from ${remote}`, fetched);
  }
  const tip = await commitOf(repo, tracking, signal);
  if (tip === null) return { outcome: "unavailable", message: `${repo} has no ${remote}/${base} to count against; fetch it first.` };
  const behind: Extract<HostOutput<"behindBase">, { outcome: "ok" }>["behind"] = [];
  for (const sha of new Set(input.shas)) {
    const counted = (await commitOf(repo, sha, signal)) === null ? null : await tryGit(repo, ["rev-list", "--count", `${sha}..${tip}`], signal);
    behind.push({ sha, commits: counted === null ? null : Number(counted) });
  }
  return { outcome: "ok", tip, behind };
}

export async function pointRefs(input: HostInput<"pointRefs">, signal?: AbortSignal): Promise<HostOutput<"pointRefs">> {
  const sha = await git(input.repo, ["rev-parse", "--verify", `${input.sha}^{commit}`], { signal });
  for (const name of input.refs) await git(input.repo, ["update-ref", name, sha], { signal });
  return {};
}

export async function mergeOnto(input: HostInput<"mergeOnto">, signal?: AbortSignal): Promise<HostOutput<"mergeOnto">> {
  const { repo, message, refs } = input;
  const head = await git(repo, ["rev-parse", "--verify", `${input.head}^{commit}`], { signal });
  const ref = await git(repo, ["rev-parse", "--verify", `${input.ref}^{commit}`], { signal });
  if (await isAncestor(repo, ref, head, signal)) return { outcome: "merged", sha: head, tree: await git(repo, ["rev-parse", `${head}^{tree}`], { signal }), already: true };
  const base = input.base === undefined ? null : await git(repo, ["rev-parse", "--verify", `${input.base}^{commit}`], { signal });
  const explicit = base !== null && (await isAncestor(repo, base, ref, signal)) ? [`--merge-base=${base}`] : [];
  const merged = await run(await topLevel(repo, signal), ["merge-tree", "--write-tree", "--name-only", "--no-messages", ...explicit, head, ref], signal, NETWORK_TIMEOUT_MS);
  const lines = merged.stdout.split("\n").filter((line) => line !== "");
  if ((merged.code !== 0 && merged.code !== 1) || lines[0] === undefined) throw failure(["merge-tree", "--write-tree", head, ref], merged);
  const tree = lines[0];
  const sha = await commitTree(repo, tree, [head, ref], message, signal);
  for (const name of refs) await git(repo, ["update-ref", name, sha], { signal });
  return merged.code === 0 ? { outcome: "merged", sha, tree, already: false } : { outcome: "conflict", files: [...new Set(lines.slice(1))].sort(), sha, tree };
}

export async function fetchBranch(input: HostInput<"fetchBranch">, signal?: AbortSignal): Promise<HostOutput<"fetchBranch">> {
  const { worktree, remote, branch } = input;
  const fetched = await runRemote(worktree, ["fetch", "--no-tags", remote, `refs/heads/${branch}`], networkTimeout(input), signal);
  if (fetched.code !== 0) return remoteFailed(`git fetch from ${remote}`, fetched);
  return { outcome: "ok", sha: await git(worktree, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { signal }) };
}

// ---------------------------------------------------------------- carrying a commit between machines
// The machine a thread runs on may share no git objects with the project's checkout, and a git there may refuse much
// (a temporary index, diff-tree), so a commit moves as its changed files: read with diff, ls-tree and cat-file where it
// was made, rebuilt here with a temporary index on the same base, and checked by its tree.

type Author = HostOutput<"exportChanges">["author"];
type Change = HostOutput<"exportChanges">["changes"][number];
const PATH_BATCH = 500;

const hasCommit = async (repo: string, sha: string, signal?: AbortSignal) => (await tryGit(repo, ["cat-file", "-e", `${sha}^{commit}`], signal)) !== null;

/** The author line and the message of a raw commit object, as `git cat-file commit` prints it. */
function parseCommit(raw: string): { author: Author; message: string } {
  const split = raw.indexOf("\n\n");
  const headers = split === -1 ? raw : raw.slice(0, split);
  const match = /^author (.*) <([^>]*)> (\d+ [+-]\d{4})$/mu.exec(headers);
  if (match === null) throw new Error("the commit has no author line git can read");
  return { author: { name: match[1]!, email: match[2]!, date: match[3]! }, message: split === -1 ? "" : raw.slice(split + 2) };
}

const authorEnv = (author: Author): GitEnv => ({
  GIT_AUTHOR_NAME: author.name,
  GIT_AUTHOR_EMAIL: author.email,
  GIT_AUTHOR_DATE: author.date,
});

export async function exportChanges(input: HostInput<"exportChanges">, signal?: AbortSignal): Promise<HostOutput<"exportChanges">> {
  const { worktree } = input;
  const head = await git(worktree, ["rev-parse", "--verify", `${input.head ?? "HEAD"}^{commit}`], { signal });
  const base = await git(worktree, ["merge-base", input.base, head], { signal });
  const tree = await git(worktree, ["rev-parse", `${head}^{tree}`], { signal });
  const { author, message } = parseCommit(await git(worktree, ["cat-file", "commit", head], { raw: true, signal }));
  const listed = (await git(worktree, ["diff", "--name-status", "--no-renames", "-z", base, head, "--"], { raw: true, signal })).split("\0");
  const changes: Change[] = [];
  for (let index = 0; index + 1 < listed.length; index += 2) {
    const letter = listed[index]![0];
    if (letter === "A" || letter === "M" || letter === "T" || letter === "D") changes.push({ status: letter, path: listed[index + 1]! });
  }
  const kept = changes.filter((change) => change.status !== "D");
  const entries = new Map<string, { mode: string; type: string; blob: string }>();
  for (let at = 0; at < kept.length; at += PATH_BATCH) {
    const batch = kept.slice(at, at + PATH_BATCH).map((change) => change.path);
    for (const line of (await git(worktree, ["ls-tree", "-z", "--full-tree", head, "--", ...batch], { raw: true, signal })).split("\0")) {
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/su.exec(line);
      if (match !== null) entries.set(match[4]!, { mode: match[1]!, type: match[2]!, blob: match[3]! });
    }
  }
  for (const change of kept) {
    const entry = entries.get(change.path);
    if (entry === undefined) throw new Error(`git ls-tree did not list ${change.path} in ${head}`);
    if (entry.type !== "blob") throw new Error(`${change.path} is a submodule, which Loom cannot move between machines`);
    change.mode = entry.mode as Change["mode"];
    change.blob = entry.blob;
  }
  const sizes = new Map<string, number>();
  const blobs = [...new Set(kept.map((change) => change.blob!))];
  if (blobs.length > 0) {
    for (const line of (await gitInput(worktree, ["cat-file", "--batch-check"], `${blobs.join("\n")}\n`, { signal })).split("\n")) {
      const [blob = "", type, size] = line.split(" ");
      if (type === "blob") sizes.set(blob, Number(size));
    }
  }
  for (const change of kept) {
    const size = sizes.get(change.blob!);
    if (size === undefined) throw new Error(`git cat-file --batch-check did not size ${change.path} (${change.blob!.slice(0, 12)})`);
    change.size = size;
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { base, head, tree, message, author, changes };
}

/** The bytes of a blob from offset, length of them at most, read as cat-file streams them; the rest is never read. */
function blobRange(repo: string, sha: string, offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
  const argv = ["-C", repo, "cat-file", "blob", sha];
  return experimental_runVcsProcess(
    "git",
    argv,
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const child = spawn("git", argv, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, signal, stdio: ["ignore", "pipe", "pipe"] });
        const parts: Buffer[] = [];
        let seen = 0;
        let kept = 0;
        let stderr = "";
        let done = false;
        const finish = () => {
          done = true;
          child.kill("SIGKILL");
          resolve(Buffer.concat(parts, kept));
        };
        const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
        child.stdout.on("data", (chunk: Buffer) => {
          if (done) return;
          const from = Math.max(0, offset - seen);
          const to = Math.min(chunk.length, offset + length - seen);
          seen += chunk.length;
          if (to > from) {
            parts.push(chunk.subarray(from, to));
            kept += to - from;
          }
          if (kept >= length) finish();
        });
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("error", (error) => {
          clearTimeout(timer);
          if (!done) reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (done) return;
          if (code === 0) resolve(Buffer.concat(parts, kept));
          else reject(new Error(`git cat-file blob ${sha} failed (${code ?? "killed"}): ${tail(stderr)}`));
        });
      }),
    { priority: "background", signal },
  );
}

export async function readBlob(input: HostInput<"readBlob">, signal?: AbortSignal): Promise<HostOutput<"readBlob">> {
  const { repo, sha, offset, length } = input;
  const size = Number(await git(repo, ["cat-file", "-s", sha], { signal }));
  if (size > BLOB_MAX_BYTES) throw new Error(`the file ${sha.slice(0, 12)} is ${Math.ceil(size / 1024 / 1024)} MiB, and files over ${BLOB_MAX_BYTES / 1024 / 1024} MiB can't move between machines`);
  if (length === 0) return { data: "" };
  return { data: (await blobRange(repo, sha, offset, length, signal)).toString("base64") };
}

const uploadPath = (dataDir: string, upload: string) => join(dataDir, "imports", upload);

export async function importChunk(input: HostInput<"importChunk">, dataDir: string): Promise<HostOutput<"importChunk">> {
  const { upload, offset } = input;
  const path = uploadPath(dataDir, upload);
  const bytes = Buffer.from(input.data, "base64");
  mkdirSync(dirname(path), { recursive: true });
  if (offset === 0) writeFileSync(path, bytes);
  else {
    const size = existsSync(path) ? statSync(path).size : 0;
    if (size !== offset) throw new Error(`the upload ${upload} has ${size} bytes, not ${offset}, so this range is out of order; send the file again from offset 0`);
    appendFileSync(path, bytes);
  }
  return { size: offset + bytes.length };
}

export async function dropUploads(input: HostInput<"dropUploads">, dataDir: string): Promise<HostOutput<"dropUploads">> {
  for (const upload of input.uploads) rmSync(uploadPath(dataDir, upload), { force: true });
  return {};
}

/** Fetches what the remote has of `branch` into its remote-tracking ref, then `base` itself when the branch did not bring it. Null once the base is here, else why not. */
async function fetchBase(repo: string, remote: string, branch: string, base: string, timeoutMs: number, signal?: AbortSignal): Promise<UnavailableAnswer | null> {
  const fetched = await runRemote(repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], timeoutMs, signal);
  if (await hasCommit(repo, base, signal)) return null;
  const bySha = await runRemote(repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, base], timeoutMs, signal);
  if (await hasCommit(repo, base, signal)) return null;
  const failed = bySha.stderr || fetched.stderr ? bySha : fetched;
  return { outcome: "unavailable", message: `The base commit ${base.slice(0, 12)} is not in ${repo}, and git fetch from ${remote} did not bring it: ${tail(bySha.stderr || fetched.stderr || bySha.stdout)}`, ...ghTransient(failed) };
}

export async function importCommit(input: HostInput<"importCommit">, dataDir: string, signal?: AbortSignal): Promise<HostOutput<"importCommit">> {
  const { repo, remote, baseBranch, tree, message, author, entries, refs } = input;
  const index = join(dataDir, "imports", `index-${randomBytes(6).toString("hex")}`);
  const uploads = entries.flatMap((entry) => ("upload" in entry ? [uploadPath(dataDir, entry.upload)] : []));
  try {
    const missing = await fetchBase(repo, remote, baseBranch, input.base, networkTimeout(input), signal);
    if (missing !== null) return missing;
    const base = await git(repo, ["rev-parse", "--verify", `${input.base}^{commit}`], { signal });
    mkdirSync(dirname(index), { recursive: true });
    const env = { GIT_INDEX_FILE: index };
    await git(repo, ["read-tree", base], { signal, env });
    const hashed = new Map<string, string>();
    const files = [...new Set(entries.flatMap((entry) => ("upload" in entry ? [entry.upload] : [])))];
    if (files.length > 0) {
      const shas = (await gitInput(repo, ["hash-object", "-w", "--no-filters", "--stdin-paths"], `${files.map((upload) => uploadPath(dataDir, upload)).join("\n")}\n`, { signal })).split("\n");
      files.forEach((upload, at) => hashed.set(upload, shas[at]!));
    }
    const records: string[] = [];
    for (const entry of entries) {
      if ("upload" in entry) records.push(`${entry.mode} ${hashed.get(entry.upload)!}\t${entry.path}`);
      else records.push(`0 ${"0".repeat(base.length)}\t${entry.path}`);
    }
    if (records.length > 0) await gitInput(repo, ["update-index", "-z", "--index-info"], `${records.join("\0")}\0`, { signal, env });
    const written = await git(repo, ["write-tree"], { signal, env });
    if (written !== tree) return { outcome: "mismatch", tree: written };
    const committer = { GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email, GIT_COMMITTER_DATE: author.date };
    const parent = input.parent === undefined ? base : await git(repo, ["rev-parse", "--verify", `${input.parent}^{commit}`], { signal });
    const sha = await gitInput(repo, ["commit-tree", written, "-p", parent, "--no-gpg-sign", "-F", "-"], message, { signal, env: { ...authorEnv(author), ...committer }, what: "commit-tree" });
    for (const name of refs) await git(repo, ["update-ref", name, sha], { signal });
    return { outcome: "ok", sha };
  } finally {
    for (const path of [index, ...uploads]) rmSync(path, { force: true });
  }
}

export async function refTip(input: HostInput<"refTip">, signal?: AbortSignal): Promise<HostOutput<"refTip">> {
  const sha = await commitOf(input.repo, input.ref, signal);
  if (sha === null) return missing(`${input.ref} is not in the repository.`);
  const tree = await git(input.repo, ["rev-parse", `${sha}^{tree}`], { signal });
  if (input.contains === undefined) return { outcome: "ok", sha, tree };
  const args = ["merge-base", "--is-ancestor", input.contains, sha];
  const ancestor = await run(input.repo, args, signal);
  if (ancestor.code !== 0 && ancestor.code !== 1) throw failure(args, ancestor);
  return { outcome: "ok", sha, tree, contains: ancestor.code === 0 };
}

export async function detach(input: HostInput<"detach">, signal?: AbortSignal): Promise<HostOutput<"detach">> {
  await git(input.worktree, ["checkout", "-q", "--detach", input.sha], { signal });
  return { tree: await git(input.worktree, ["rev-parse", "HEAD^{tree}"], { signal }) };
}

/** `path` in the worktree, once no symlink on the way leads out of it; with `create`, its directory is made. */
function insideWorktree(worktree: string, path: string, create: boolean): string {
  const root = realpathSync(worktree);
  const file = join(root, path);
  let existing = dirname(file);
  while (!existsSync(existing)) existing = dirname(existing);
  const real = realpathSync(existing);
  if (real !== root && !real.startsWith(`${root}/`)) throw new Error(`${path} leads out of the worktree ${worktree}`);
  if (create) mkdirSync(dirname(file), { recursive: true });
  return file;
}

// Where a carry marks the worktree from the moment it resets it to the base until the tree it carries is in: that base,
// that tree, and the commits it has made on the way, as a stacked ticket's carry makes two. What is uncommitted then, and
// those commits, are the carry's own, so a carry that starts again after one was cut short, as by a host call that got no
// answer, may reset them. In the worktree's git directory, which no commit reaches.
interface CarryMark {
  base: string;
  tree: string;
  heads: string[];
}
const carryMarkOf = async (worktree: string, signal?: AbortSignal) => resolve(worktree, await git(worktree, ["rev-parse", "--git-path", "loom-carry"], { signal }));
const readCarryMark = (path: string): CarryMark | null => (existsSync(path) ? parseJson<CarryMark>(readFileSync(path, "utf8")) : null);

export async function carryStart(input: HostInput<"carryStart">, signal?: AbortSignal): Promise<HostOutput<"carryStart">> {
  const { worktree, remote, baseBranch, base } = input;
  const [mergeHead = "", head = "", tree = ""] = (await git(worktree, ["rev-parse", "--git-path", "MERGE_HEAD", "HEAD", "HEAD^{tree}"], { signal })).split("\n");
  const mark = await carryMarkOf(worktree, signal);
  if (tree === input.tree) {
    rmSync(mark, { force: true });
    return { outcome: "ok", present: true };
  }
  if (existsSync(resolve(worktree, mergeHead))) {
    return { outcome: "unavailable", message: `The worktree ${worktree} has a merge that is not finished, so Loom left it as it is. Finish it with git commit, or abort it with git merge --abort, then try again` };
  }
  const dirty = (await git(worktree, ["status", "--porcelain"], { signal })).split("\n").filter((line) => line !== "");
  const carried = readCarryMark(mark);
  const cutShort = carried !== null && (carried.base === head || carried.heads.includes(head));
  if (dirty.length > 0 && !cutShort) {
    const files = dirty.map((line) => line.slice(3)).slice(0, 10);
    return { outcome: "unavailable", message: `The worktree ${worktree} has uncommitted changes, so Loom cannot put the work in it: ${files.join(", ")}${dirty.length > files.length ? ", …" : ""}. Stash or discard them, then try again` };
  }
  // merge-base rather than --is-ancestor, which a machine's git may not have.
  const tracking = `refs/remotes/${remote}/${baseBranch}`;
  if (!cutShort && head !== base && tree !== input.replaces && (await tryGit(worktree, ["merge-base", head, tracking], signal)) !== head) {
    return { outcome: "unavailable", message: `The worktree ${worktree} has commits that are not on ${remote}/${baseBranch}, so putting the work in would drop them: ${head.slice(0, 12)}. Stash them or move them to another branch, then try again` };
  }
  // The base is a commit of the remote's base branch. One that branch lacks here, as after the pull request's branch took
  // a newer base, moves it up, so the worker's changes are measured from that base and not from an older one.
  if ((await tryGit(worktree, ["merge-base", base, tracking], signal)) !== base) await runRemote(worktree, ["fetch", "--no-tags", remote, baseBranch], networkTimeout(input), signal);
  if (!(await hasCommit(worktree, base, signal))) {
    const fetched = await runRemote(worktree, ["fetch", "--no-tags", remote, base], networkTimeout(input), signal);
    if (!(await hasCommit(worktree, base, signal))) {
      return { outcome: "unavailable", message: `The base commit ${base.slice(0, 12)} is not on this machine, and git fetch ${remote} ${base.slice(0, 12)} did not bring it: ${tail(fetched.stderr || fetched.stdout)}`, ...ghTransient(fetched) };
    }
  }
  await git(worktree, ["reset", "-q", "--hard", base], { signal });
  if (cutShort) await git(await topLevel(worktree, signal), ["clean", "-fdq"], { signal });
  writeFileSync(mark, JSON.stringify({ base, tree: input.tree, heads: [] } satisfies CarryMark));
  return { outcome: "ok", present: false };
}

// The carry's paths are relative to the repository's top level, which a thread's worktree path may be a subdirectory of.
export async function carryWrite(input: HostInput<"carryWrite">): Promise<HostOutput<"carryWrite">> {
  const { path, mode, offset } = input;
  const file = insideWorktree(await topLevel(input.worktree), path, true);
  const bytes = Buffer.from(input.data, "base64");
  if (mode === "120000") {
    rmSync(file, { force: true });
    symlinkSync(bytes.toString("utf8"), file);
    return { size: bytes.length };
  }
  if (offset === 0) {
    rmSync(file, { force: true });
    writeFileSync(file, bytes);
  } else {
    const size = statSync(file).size;
    if (size !== offset) throw new Error(`${path} has ${size} bytes, not ${offset}, so this range is out of order; send the file again from offset 0`);
    appendFileSync(file, bytes);
  }
  chmodSync(file, mode === "100755" ? 0o755 : 0o644);
  return { size: offset + bytes.length };
}

const MARKER = /^(?:<{7}|>{7})(?: |$)/mu;

export async function repoPrefix(input: HostInput<"repoPrefix">, signal?: AbortSignal): Promise<HostOutput<"repoPrefix">> {
  return { prefix: await git(input.repo, ["rev-parse", "--show-prefix"], { signal }) };
}

export async function conflictMarkers(input: HostInput<"conflictMarkers">): Promise<HostOutput<"conflictMarkers">> {
  const files: string[] = [];
  const top = await topLevel(input.worktree);
  for (const path of input.paths) {
    const file = insideWorktree(top, path, false);
    if (existsSync(file) && statSync(file).isFile() && MARKER.test(readFileSync(file, "utf8"))) files.push(path);
  }
  return { files };
}

/** Deletes each path, and each directory that leaves empty, so a file may take a deleted directory's place. */
export async function carryDelete(input: HostInput<"carryDelete">): Promise<HostOutput<"carryDelete">> {
  const top = await topLevel(input.worktree);
  const root = realpathSync(top);
  for (const path of input.paths) {
    const file = insideWorktree(top, path, false);
    rmSync(file, { force: true });
    for (let dir = dirname(file); dir !== root && existsSync(dir) && readdirSync(dir).length === 0; dir = dirname(dir)) rmdirSync(dir);
  }
  return {};
}

// Untracked files go too, but not ignored ones: carryStart found the worktree clean, so all of them are the carry's.
async function resetCarry(worktree: string, base: string, signal?: AbortSignal): Promise<void> {
  await git(worktree, ["reset", "-q", "--hard", base], { signal });
  await git(await topLevel(worktree, signal), ["clean", "-fdq"], { signal });
  rmSync(await carryMarkOf(worktree, signal), { force: true });
}

export async function carryAbort(input: HostInput<"carryAbort">, signal?: AbortSignal): Promise<HostOutput<"carryAbort">> {
  await resetCarry(input.worktree, input.base, signal);
  return {};
}

export async function carryFinish(input: HostInput<"carryFinish">, signal?: AbortSignal): Promise<HostOutput<"carryFinish">> {
  const { worktree, base, message, author, tree, paths } = input;
  const top = await topLevel(worktree, signal);
  await git(top, ["add", "-A"], { signal });
  // As arguments: some machines' git has no --pathspec-from-file.
  for (let at = 0; at < paths.length; at += PATH_BATCH) {
    await git(top, ["add", "-f", "--", ...paths.slice(at, at + PATH_BATCH)], { signal, env: { GIT_LITERAL_PATHSPECS: "1" } });
  }
  const staged = await run(worktree, ["diff", "--cached", "--quiet"], signal);
  if (staged.code !== 0 && staged.code !== 1) throw failure(["diff", "--cached", "--quiet"], staged);
  if (staged.code === 1) await git(worktree, [...(await identityArgs(worktree, signal)), "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", message], { signal, env: authorEnv(author) });
  const [head = "", written = ""] = (await git(worktree, ["rev-parse", "HEAD", "HEAD^{tree}"], { signal })).split("\n");
  if (written === tree) {
    // The mark ends with the tree the carry started for; a commit on the way to it, as a stacked ticket's first, joins it.
    const mark = await carryMarkOf(worktree, signal);
    const carried = readCarryMark(mark);
    if (carried === null || carried.tree === written) rmSync(mark, { force: true });
    else writeFileSync(mark, JSON.stringify({ ...carried, heads: [...carried.heads, head] } satisfies CarryMark));
    return { outcome: "ok", head, tree: written };
  }
  await resetCarry(worktree, base, signal);
  return { outcome: "mismatch", tree: written };
}

/** `host/owner/repo` from an https, scp-style ssh or ssh:// remote URL, else null. */
export function parseRemoteUrl(url: string): string | null {
  const match =
    /^https:\/\/(?:[^@/\s]+@)?([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(url) ??
    /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(url) ??
    /^[^@:/\s]+@([^:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(url);
  return match === null ? null : `${match[1]}/${match[2]}/${match[3]}`;
}

type GhRun = GitRun | "missing";

class GhTimedOut extends Error {}

// gh never prompts: GH_PROMPT_DISABLED turns its prompts into errors.
function gh(cwd: string, args: readonly string[], opts: { stdin?: string; signal?: AbortSignal } = {}): Promise<GhRun> {
  return experimental_runVcsProcess(
    "gh",
    args,
    () =>
      new Promise<GhRun>((resolve, reject) => {
        const child = execFile(
          "gh",
          [...args],
          { cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: GIT_MAX_BUFFER, timeout: NETWORK_TIMEOUT_MS, signal: opts.signal, encoding: "utf8" },
          (error, stdout, stderr) => {
            if (error === null) return resolve({ code: 0, stdout, stderr });
            const failed = error as NodeJS.ErrnoException & { killed?: boolean };
            if (failed.code === "ENOENT") return resolve("missing");
            if (typeof failed.code === "number") return resolve({ code: failed.code, stdout, stderr });
            if (failed.killed === true && failed.name !== "AbortError") return reject(new GhTimedOut(`gh ${args[0]} took too long`));
            reject(new Error(`gh ${args[0]}: ${failed.message}`));
          },
        );
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(opts.stdin ?? "");
      }),
    { priority: "background", signal: opts.signal },
  );
}

const GH_MISSING = "The gh CLI is not installed on this machine, or it is not on PATH.";
const ghFailed = (what: string, run: GitRun) => `${what} failed: ${tail(run.stderr || run.stdout)}`;
const withoutCredentials = (url: string) => url.replace(/\/\/[^@/\s]+@/u, "//");

// ---------------------------------------------------------------- failed pull request reads

type UnavailableAnswer = Extract<HostOutput<"prFeedback">, { outcome: "unavailable" }>;
type Transient = Pick<UnavailableAnswer, "transient" | "retryAfterMs">;

/** One gh call to GitHub. A timeout comes back as a failed run, so it is classified like GitHub's own failures; nothing here runs gh again. */
async function ghCall(cwd: string, args: readonly string[], opts: { stdin?: string; signal?: AbortSignal } = {}): Promise<GhRun> {
  try {
    return await gh(cwd, args, opts);
  } catch (error) {
    if (error instanceof GhTimedOut) return { code: -1, stdout: "", stderr: `gh timed out after ${NETWORK_TIMEOUT_MS / 60_000} minutes` };
    throw error;
  }
}

const GH_AUTH_EXIT = 4;
// gh's "HTTP 502", git's "returned error: 502", and a forge CLI's "Error: 429: …" or "503: …" at the start of a line.
const HTTP_STATUS = /\bHTTP (\d{3})\b|\breturned error: (\d{3})\b|^[ \t]*(?:error:[ \t]*)?(\d{3}):/imu;
const RATE_LIMITED = /rate[-_ ]limit|abuse detection|too many requests/iu;
const SERVER_TROUBLE = /\bserver error\b|bad gateway|service unavailable|gateway time-?out|\btime(?:d[- ]?|[- ]?)out|deadline exceeded|connection (?:reset|refused)|\bEOF\b|TLS handshake|something went wrong|remote end hung up unexpectedly/iu;
// The read never reached the forge: its name did not resolve or no connection opened. That is this machine's resolver or
// network, not one pull request, so it is tested before SERVER_TROUBLE, whose timeouts would also match a connect timeout.
const NETWORK_TROUBLE =
  /could not resolve host|dns error|failed to lookup address|nodename nor servname|no such host|temporary failure in name resolution|getaddrinfo|name or service not known|error connecting to|client error \(connect\)|network is unreachable|host is unreachable|no route to host|connection timed out|i\/o timeout|check your internet connection|couldn't connect to server|failed to connect to/iu;
const RETRY_AFTER_SECONDS = /retry[- ]after:?\s*(\d{1,6})\b/iu;
const RATE_LIMIT_RESET = /x-ratelimit-reset:?\s*(\d{10})\b/iu;
const TRY_AGAIN_IN = /(?:try again|retry) in (\d{1,4}) (second|minute|hour)s?\b/iu;
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000 };
const LONGEST_RETRY_AFTER_MS = 24 * 3_600_000;

/** The error fields of a JSON answer, null when `text` is not JSON. The rest of an answer can hold a pull request's own text. */
function errorFields(text: string): string[] | null {
  const body = parseJson<{ message?: unknown; errors?: unknown }>(text);
  if (body === null || typeof body !== "object") return null;
  const errors = Array.isArray(body.errors) ? (body.errors as Array<{ type?: unknown; message?: unknown } | null>) : [];
  return [body.message, ...errors.flatMap((error) => [error?.type, error?.message])].filter((field): field is string => typeof field === "string");
}

/**
 * Output to read a failure from. A JSON answer, or a JSON line among other output, counts only for its error fields, since
 * the rest can hold a pull request's own text; a line that starts as JSON and does not parse, as a body cut short, counts
 * for nothing. Whole lines are parsed before any of it is clipped.
 */
function errorText(output: string): string {
  const whole = errorFields(output);
  if (whole !== null) return whole.join("\n");
  return output
    .split("\n")
    .map((line) => errorFields(line.trim())?.join("\n") ?? (/^[{[]/u.test(line.trim()) ? "" : line))
    .join("\n");
}

// A failed read's stdout is the response body, which can hold the pull request's own text.
const ghErrorText = (run: GitRun): string => `${run.stderr}\n${errorText(run.stdout).slice(0, 2000)}`;

function retryAfterMs(text: string): number | null {
  const seconds = RETRY_AFTER_SECONDS.exec(text);
  const reset = RATE_LIMIT_RESET.exec(text);
  const later = TRY_AGAIN_IN.exec(text);
  const ms = seconds !== null ? Number(seconds[1]) * 1000 : reset !== null ? Number(reset[1]) * 1000 - Date.now() : later !== null ? Number(later[1]) * UNIT_MS[later[2]!.toLowerCase()]! : null;
  return ms === null ? null : Math.min(LONGEST_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}

/**
 * Whether a failed gh call is worth waiting out: `rate_limit` when GitHub says it rate-limited the call (HTTP 429, a 403 or
 * GraphQL's RATE_LIMITED that says so), `server` for its 500, 502, 503 and 504 answers, timeouts and dropped connections,
 * and `network` when the call never reached it, such as a name lookup that failed. Null for the rest, such as a missing
 * login, a 404 or a bad URL. A forge command's failure and a git fetch or push are classified by the same rules.
 */
export function ghTransient(run: GitRun): Transient | null {
  if (run.code === GH_AUTH_EXIT) return null;
  const text = ghErrorText(run);
  const found = HTTP_STATUS.exec(text);
  const status = found?.[1] ?? found?.[2] ?? found?.[3];
  if (status === "429" || (RATE_LIMITED.test(text) && (status === undefined || status === "403"))) {
    const wait = retryAfterMs(text);
    return wait === null ? { transient: "rate_limit" } : { transient: "rate_limit", retryAfterMs: wait };
  }
  if (status !== undefined) return /^50[0234]$/u.test(status) ? { transient: "server" } : null;
  if (NETWORK_TROUBLE.test(text)) return { transient: "network" };
  return SERVER_TROUBLE.test(text) ? { transient: "server" } : null;
}

function readFailed(what: string, run: GitRun): UnavailableAnswer {
  return { outcome: "unavailable", message: ghFailed(what, run), ...ghTransient(run) };
}

/** A git call to a remote that failed, with `transient` when its output reads as a failure worth waiting out. */
function remoteFailed(what: string, run: GitRun): UnavailableAnswer {
  return { outcome: "unavailable", message: `${what} failed: ${tail(run.stderr || run.stdout)}`, ...ghTransient(run) };
}

export async function prCreate(input: HostInput<"prCreate">, signal?: AbortSignal): Promise<HostOutput<"prCreate">> {
  if (input.forge.kind === "command") return openWithCommand(input, input.forge.open, signal);
  const { repo, remote, base, head, title, body, draft } = input;
  const unavailable = (message: string): HostOutput<"prCreate"> => ({ outcome: "unavailable", message });
  // The push URL, not the fetch URL: the branch goes where `git push` sends it, and the pull request must be opened there.
  const pushUrls = (await tryGit(repo, ["remote", "get-url", "--push", "--all", remote], signal))?.split("\n").filter((line) => line !== "");
  if (pushUrls === undefined || pushUrls.length === 0) return unavailable(`The git remote "${remote}" does not exist in ${repo}.`);
  if (pushUrls.length > 1) return unavailable(`The remote "${remote}" has ${pushUrls.length} push URLs, so Loom cannot tell which repository the pull request belongs in. Leave one with \`git remote set-url --push ${remote} <url>\`.`);
  const remoteUrl = pushUrls[0]!;
  const github = parseRemoteUrl(remoteUrl);
  if (github === null) return unavailable(`The remote "${remote}" is ${withoutCredentials(remoteUrl)}, which is not a GitHub repository URL. Use an https://<host>/<owner>/<repo> or git@<host>:<owner>/<repo> remote.`);

  const created = await ghCall(repo, ["pr", "create", "--repo", github, "--base", base, "--head", head, "--title", title, "--body-file", "-", ...(draft ? ["--draft"] : [])], { stdin: body, signal });
  if (created === "missing") return unavailable(GH_MISSING);
  if (created.code === 0) {
    const url = created.stdout.trim().split("\n").pop() ?? "";
    return /^https?:\/\/\S+$/u.test(url) ? { outcome: "ok", url } : unavailable(`gh pr create printed no pull request URL: ${tail(created.stdout)}`);
  }
  if (!/already exists/iu.test(`${created.stderr}\n${created.stdout}`)) return readFailed("gh pr create", created);

  const viewed = await ghCall(repo, ["pr", "view", head, "--repo", github, "--json", "url"], { signal });
  if (viewed === "missing") return unavailable(GH_MISSING);
  if (viewed.code !== 0) return readFailed("gh pr view", viewed);
  const url = parseJson<{ url?: unknown }>(viewed.stdout)?.url;
  return typeof url === "string" ? { outcome: "ok", url } : unavailable(`gh pr view printed no URL: ${tail(viewed.stdout)}`);
}

export async function prRetarget(input: HostInput<"prRetarget">, signal?: AbortSignal): Promise<HostOutput<"prRetarget">> {
  if (input.forge?.kind === "command") return retargetWithCommand(input, input.forge.retarget, signal);
  const edited = await ghCall(input.repo, ["pr", "edit", input.url, "--base", input.base], { signal });
  if (edited === "missing") return { outcome: "unavailable", message: GH_MISSING };
  if (edited.code !== 0) return readFailed("gh pr edit", edited);
  return { outcome: "ok" };
}

export async function prState(input: HostInput<"prState">, signal?: AbortSignal): Promise<HostOutput<"prState">> {
  if (input.forge.kind === "command") return stateWithCommand(input, input.forge.state, signal);
  const viewed = await ghCall(input.repo, ["pr", "view", input.url, "--json", "state"], { signal });
  if (viewed === "missing") return { outcome: "unavailable", message: GH_MISSING };
  if (viewed.code !== 0) return readFailed("gh pr view", viewed);
  const state = parseJson<{ state?: unknown }>(viewed.stdout)?.state;
  if (state === "OPEN" || state === "MERGED" || state === "CLOSED") return { outcome: "ok", state };
  return { outcome: "unavailable", message: `gh pr view returned an unknown state: ${tail(viewed.stdout)}` };
}

// ---------------------------------------------------------------- pull request feedback

type Feedback = Extract<HostOutput<"prFeedback">, { outcome: "ok" }>;
type FeedbackItem = Feedback["items"][number];
type FeedbackCheck = Feedback["checks"][number];

// Every item comes back, so none is lost before Loom filters out the seen and ignored ones; the bodies are clipped instead.
const BODY_MAX = 2000;
const digest = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);
// A body that ends with Loom's reply mark keeps it, so a reply Loom posted is still the worker's own when its thread is long.
const clipBody = (text: string) => {
  if (text.length <= BODY_MAX) return text;
  if (!text.trimEnd().endsWith(REPLY_MARK)) return `${text.slice(0, BODY_MAX - 1)}…`;
  return `${text.slice(0, BODY_MAX - REPLY_MARK.length - 2)}…\n${REPLY_MARK}`;
};

// What Loom reads of every pull request, and with the feedback the rest of what prFeedback answers. It asks for no check
// run's steps, which made one pull request's read slow enough to time out at GitHub; runningSteps reads them when needed.
const META_FIELDS = "number state isDraft reviewDecision baseRefName mergeable title body";
const LIGHT_FRAGMENT = `fragment F on PullRequest { ${META_FIELDS} }`;
const FEEDBACK_FRAGMENT = `fragment F on PullRequest {
  ${META_FIELDS} headRefOid author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename
    ... on CheckRun { id databaseId name status conclusion detailsUrl startedAt completedAt }
    ... on StatusContext { context state targetUrl } } } } } } }
  reviews(last: 50) { nodes { databaseId author { __typename login } state body url } }
  reviewThreads(last: 100) { nodes { id isResolved path line comments(last: 20) { nodes { databaseId author { __typename login } body url } } } }
  comments(last: 50) { nodes { databaseId author { __typename login } body url } }
}`;

const FEEDBACK_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ...F } }
}
${FEEDBACK_FRAGMENT}`;

/** One query for many pull requests of a repository: an aliased pullRequest field per number over the fragment F. The numbers are integers, so they go in the text. */
export function batchQuery(numbers: readonly number[], feedback: boolean): string {
  const fields = numbers.map((number, index) => `    p${index}: pullRequest(number: ${Math.trunc(number)}) { ...F }`).join("\n");
  return `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n${fields}\n  }\n}\n${feedback ? FEEDBACK_FRAGMENT : LIGHT_FRAGMENT}`;
}

type GhAuthor = { __typename?: string; login?: string } | null;
type GhSteps = { totalCount?: number; nodes?: Array<{ status?: string }> };
interface GhMeta {
  number?: number;
  state: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  baseRefName?: string;
  title?: string | null;
  body?: string | null;
  mergeable?: string;
}
interface GhPull extends GhMeta {
  headRefOid: string;
  author: GhAuthor;
  commits: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: Array<Record<string, unknown>> } } | null } }> };
  reviews: { nodes: Array<{ databaseId: number; author: GhAuthor; state: string; body: string; url: string }> };
  reviewThreads: { nodes: Array<{ id: string; isResolved: boolean; path: string | null; line: number | null; comments: { nodes: Array<{ databaseId: number; author: GhAuthor; body: string; url: string }> } }> };
  comments: { nodes: Array<{ databaseId: number; author: GhAuthor; body: string; url: string }> };
}

const stateOf = (state: string): Feedback["state"] => (state === "MERGED" || state === "CLOSED" ? state : "OPEN");
type Review = NonNullable<Feedback["review"]>;
const reviewOf = (decision: unknown): Review | null => REVIEW_DECISIONS.find((each) => each === decision) ?? null;

/** The draft flag, review decision, base branch and mergeability GitHub reports; null for one the answer leaves out, and for UNKNOWN. */
function ghMeta(pull: GhMeta): { draft: boolean | null; review: Review | null; base: string | null; mergeable: boolean | null } {
  return {
    draft: typeof pull.isDraft === "boolean" ? pull.isDraft : null,
    review: reviewOf(pull.reviewDecision),
    base: typeof pull.baseRefName === "string" ? pull.baseRefName : null,
    mergeable: pull.mergeable === "MERGEABLE" ? true : pull.mergeable === "CONFLICTING" ? false : null,
  };
}

/** The title and description GitHub reports, for Loom's own sections in it; null for one the answer leaves out. */
const ghText = (pull: GhMeta): { title: string | null; body: string | null } => ({ title: typeof pull.title === "string" ? pull.title : null, body: typeof pull.body === "string" ? pull.body : null });

const loginOf = (author: GhAuthor) => author?.login ?? "ghost";
const isBot = (author: GhAuthor) => author?.__typename === "Bot";

function checkState(node: Record<string, unknown>): FeedbackCheck["state"] {
  if (node.__typename === "StatusContext") {
    const state = String(node.state);
    return state === "SUCCESS" ? "passed" : state === "FAILURE" || state === "ERROR" ? "failed" : "pending";
  }
  if (node.status !== "COMPLETED") return "pending";
  const conclusion = String(node.conclusion);
  if (conclusion === "SUCCESS") return "passed";
  return ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(conclusion) ? "failed" : "neutral";
}

const timeOf = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null);

/** When and how far a check run got. A commit status says only pending, so Loom counts it as running and gets no times. */
function checkTiming(node: Record<string, unknown>, steps: GhSteps | undefined): Pick<FeedbackCheck, "started" | "startedAt" | "completedAt" | "steps"> {
  if (node.__typename === "StatusContext") return { started: null, startedAt: null, completedAt: null, steps: null };
  const status = String(node.status);
  const total = steps?.totalCount ?? 0;
  return {
    started: status === "IN_PROGRESS" || status === "COMPLETED",
    startedAt: timeOf(node.startedAt),
    completedAt: timeOf(node.completedAt),
    steps: total === 0 ? null : { done: (steps?.nodes ?? []).filter((step) => step.status === "COMPLETED").length, total },
  };
}

// Keys change when what the worker should read changes: a rerun check, an edited review or comment, a new reply in a thread.
function ghFeedback(pull: GhPull, steps: ReadonlyMap<string, GhSteps>): Feedback {
  const head = pull.headRefOid;
  const checks = contextsOf(pull).map((node): FeedbackCheck => {
    const status = node.__typename === "StatusContext";
    const name = String(status ? node.context : node.name);
    const state = checkState(node);
    const timing = checkTiming(node, typeof node.id === "string" ? steps.get(node.id) : undefined);
    return { key: status ? `status:${name}:${String(node.state)}:${head}` : `check:${String(node.databaseId)}`, name, state, url: (status ? (node.targetUrl as string | null) : (node.detailsUrl as string | null)) ?? null, ...timing };
  });
  const items: FeedbackItem[] = [];
  for (const review of pull.reviews.nodes) {
    items.push({ key: `review:${review.databaseId}:${digest(review.state + review.body)}`, kind: "review", author: loginOf(review.author), bot: isBot(review.author), body: clipBody(review.body), url: review.url, state: review.state.toLowerCase(), path: null, line: null });
  }
  for (const thread of pull.reviewThreads.nodes) {
    const comments = thread.comments.nodes;
    const last = comments.at(-1);
    if (thread.isResolved || last === undefined) continue;
    const body = comments.map((comment) => `${loginOf(comment.author)}: ${comment.body}`).join("\n\n");
    items.push({ key: `thread:${thread.id}:${last.databaseId}:${digest(body)}`, kind: "thread", author: loginOf(last.author), bot: isBot(last.author), body: clipBody(body), url: last.url, state: null, path: thread.path, line: thread.line });
  }
  for (const comment of pull.comments.nodes) {
    items.push({ key: `comment:${comment.databaseId}:${digest(comment.body)}`, kind: "comment", author: loginOf(comment.author), bot: isBot(comment.author), body: clipBody(comment.body), url: comment.url, state: null, path: null, line: null });
  }
  return { outcome: "ok", state: stateOf(pull.state), head, author: loginOf(pull.author), ...ghMeta(pull), checks, items };
}

const contextsOf = (pull: GhPull) => pull.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];

const STEPS_RUNS_MAX = 20;
const NODE_ID = /^[A-Za-z0-9_=+/-]{1,200}$/u;

/**
 * The steps of the check runs in progress, by node id. check-wait reads steps only to tell how far a running check got
 * while a failed check waits for it, so they are asked for only then, for at most STEPS_RUNS_MAX runs, in a second small
 * query: asking for every run's steps made the main query slow enough to time out at GitHub. A failed answer leaves the
 * steps out and the read stands; it is not asked again.
 */
async function runningSteps(repo: string, host: string, pull: GhPull, signal?: AbortSignal): Promise<Map<string, GhSteps>> {
  const nodes = contextsOf(pull);
  if (!nodes.some((node) => checkState(node) === "failed")) return new Map();
  const ids = nodes
    .filter((node) => node.__typename === "CheckRun" && node.status === "IN_PROGRESS" && typeof node.id === "string" && NODE_ID.test(node.id))
    .map((node) => node.id as string)
    .slice(0, STEPS_RUNS_MAX);
  if (ids.length === 0) return new Map();
  // The ids are checked against NODE_ID, so JSON's quoting is GraphQL's too; inline, they need no gh array syntax.
  const query = `query { nodes(ids: ${JSON.stringify(ids)}) { ... on CheckRun { id steps(first: 100) { totalCount nodes { status } } } } }`;
  const asked = await ghCall(repo, ["api", "graphql", "--hostname", host, "-f", `query=${query}`], { signal }).catch(() => null);
  if (asked === null || asked === "missing" || asked.code !== 0) return new Map();
  const found = parseJson<{ data?: { nodes?: Array<{ id?: unknown; steps?: GhSteps | null } | null> } }>(asked.stdout)?.data?.nodes ?? [];
  return new Map(found.flatMap((node): Array<[string, GhSteps]> => (node != null && typeof node.id === "string" && node.steps != null ? [[node.id, node.steps]] : [])));
}

// The feedback command's last line, as the spec reference documents it; fields a forge does not know may be left out.
const commandFeedbackSchema = z.object({
  state: z.string().transform((state) => state.toUpperCase()).pipe(z.enum(["OPEN", "MERGED", "CLOSED"])),
  head: z.string().min(1).max(64),
  author: z.string().max(200).default(""),
  draft: z.boolean().nullish(),
  review: z.string().transform((review) => review.toUpperCase()).pipe(z.enum(REVIEW_DECISIONS)).nullish(),
  base: z.string().min(1).max(200).nullish(),
  title: z.string().max(256).nullish(),
  body: z.string().max(65_536).nullish(),
  mergeable: z.boolean().nullish(),
  checks: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]),
        name: z.string().max(500),
        state: z.enum(["pending", "passed", "failed", "neutral"]),
        url: z.string().max(2000).nullish(),
        started: z.boolean().nullish(),
        started_at: z.iso.datetime({ offset: true }).nullish(),
        completed_at: z.iso.datetime({ offset: true }).nullish(),
        progress: z.number().min(0).max(100).nullish(),
      }),
    )
    .max(200)
    .default([]),
  items: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]),
        kind: z.enum(["review", "thread", "comment"]),
        author: z.string().max(200),
        bot: z.boolean().default(false),
        body: z.string(),
        url: z.string().max(2000).nullish(),
        state: z.string().max(100).nullish(),
        path: z.string().max(4096).nullish(),
        line: z.number().int().nullish(),
      }),
    )
    .max(500)
    .default([]),
});

async function feedbackWithCommand(input: HostInput<"prFeedback">, command: string, signal?: AbortSignal): Promise<HostOutput<"prFeedback">> {
  const result = await spawnCommand({ cwd: input.repo, command, timeoutMs: FORGE_COMMAND_MS, env: { LOOM_URL: input.url, LOOM_PR_NUMBER: prNumber(input.url) } }, signal);
  const failed = commandReadFailed("feedback", result);
  if (failed !== null) return failed;
  const line = result.output.trim().split("\n").at(-1) ?? "";
  const parsed = commandFeedbackSchema.safeParse(parseJson(line));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { outcome: "unavailable", message: `The forge's feedback command must print a JSON object on its last line${issue === undefined ? "" : `; ${issue.path.join(".") || "it"}: ${issue.message}`}: ${tail(line, 300)}` };
  }
  const data = parsed.data;
  return {
    outcome: "ok",
    state: data.state,
    head: data.head,
    author: data.author,
    draft: data.draft ?? null,
    review: data.review ?? null,
    base: data.base ?? null,
    title: data.title ?? null,
    body: data.body ?? null,
    mergeable: data.mergeable ?? null,
    checks: data.checks.map((check) => ({
      key: `check:${check.id}`,
      name: check.name,
      state: check.state,
      url: check.url ?? null,
      started: check.started ?? null,
      startedAt: timeOf(check.started_at),
      completedAt: timeOf(check.completed_at),
      progress: check.progress ?? null,
      steps: null,
    })),
    items: data.items.map((item) => ({ key: `${item.kind}:${item.id}`, kind: item.kind, author: item.author, bot: item.bot, body: clipBody(item.body), url: item.url ?? null, state: item.state ?? null, path: item.path ?? null, line: item.line ?? null })),
  };
}

export async function prFeedback(input: HostInput<"prFeedback">, signal?: AbortSignal): Promise<HostOutput<"prFeedback">> {
  if (input.forge.kind === "command") return feedbackWithCommand(input, input.forge.feedback, signal);
  const pr = githubPull(input.url);
  if (pr === null) return { outcome: "unavailable", message: `${input.url} is not a GitHub pull request URL.` };
  const { host, owner, name, number } = pr;
  const asked = await ghCall(input.repo, ["api", "graphql", "--hostname", host, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`, "-f", `query=${FEEDBACK_QUERY}`], { signal });
  if (asked === "missing") return { outcome: "unavailable", message: GH_MISSING };
  if (asked.code !== 0) return readFailed("gh api graphql", asked);
  const pull = parseJson<{ data?: { repository?: { pullRequest?: GhPull | null } | null } }>(asked.stdout)?.data?.repository?.pullRequest;
  if (pull == null) return { outcome: "unavailable", message: `gh found no pull request at ${input.url}: ${tail(asked.stdout, 300)}` };
  return { ...ghFeedback(pull, await runningSteps(input.repo, host, pull, signal)), ...ghText(pull) };
}

type GhAnswer = { data?: { repository?: Record<string, GhPull | null> | null } | null; errors?: Array<{ message?: string; path?: unknown[] }> };

/**
 * Reads up to PR_BATCH_MAX pull requests of one repository in one `gh api graphql` call. gh exits non-zero when GitHub
 * answers with errors, as it does for a number with no pull request, so an answer that still has the repository counts,
 * and each pull request it leaves out is missing with GitHub's message for it.
 */
export async function prBatch(input: HostInput<"prBatch">, signal?: AbortSignal): Promise<HostOutput<"prBatch">> {
  const { repo, host, owner, name, feedback } = input;
  const numbers = [...new Set(input.numbers)];
  const asked = await ghCall(repo, ["api", "graphql", "--hostname", host, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${batchQuery(numbers, feedback)}`], { signal });
  if (asked === "missing") return { outcome: "unavailable", message: GH_MISSING };
  const answer = parseJson<GhAnswer>(asked.stdout);
  const found = answer?.data?.repository;
  if (found == null) {
    if (asked.code !== 0) return readFailed("gh api graphql", asked);
    return { outcome: "unavailable", message: `gh found no repository ${owner}/${name} on ${host}: ${tail(asked.stdout, 300)}` };
  }
  const errorOf = (alias: string) => answer?.errors?.find((error) => Array.isArray(error.path) && error.path[1] === alias)?.message;
  // A pull request GitHub failed to answer for, in an answer that still has the others, fails as a whole read would: a server
  // error or a rate limit is worth waiting out, and only an error such as "Could not resolve to a PullRequest" means it is gone.
  const transientOf = (alias: string) => {
    const message = errorOf(alias);
    if (message !== undefined) return ghTransient({ code: 1, stdout: "", stderr: message });
    return asked.code === 0 ? null : ghTransient(asked);
  };
  const pulls: Extract<HostOutput<"prBatch">, { outcome: "ok" }>["pulls"] = [];
  const missing: Extract<HostOutput<"prBatch">, { outcome: "ok" }>["missing"] = [];
  const miss = (number: number, alias: string, a: { answered: boolean; broken?: string }) => {
    const transient = transientOf(alias);
    const message = errorOf(alias) ?? a.broken ?? (asked.code === 0 ? undefined : tail(asked.stderr || asked.stdout));
    const what = transient === null && !a.answered ? `gh found no pull request #${number} in ${owner}/${name}` : `GitHub did not answer for pull request #${number} in ${owner}/${name}`;
    missing.push({ number, message: `${what}${message === undefined ? "" : `: ${message}`}`, ...transient });
  };
  for (const [index, number] of numbers.entries()) {
    const alias = `p${index}`;
    const pull = found[alias];
    if (pull == null || typeof pull.state !== "string") {
      miss(number, alias, { answered: false });
      continue;
    }
    // Any error under the alias fails its read, as gh fails a one-pull-request read: a field GitHub could not fill may come
    // back null, such as a check rollup that would otherwise read as no checks at all.
    if (errorOf(alias) !== undefined) {
      miss(number, alias, { answered: true });
      continue;
    }
    let read: Feedback | null = null;
    if (feedback) {
      // GitHub can answer the state and fail a field inside, such as `reviews: null` beside a server error; that read failed too.
      try {
        // runningSteps asks GitHub again only for a pull request with a failed check and others still running, as prFeedback does.
        read = ghFeedback(pull, await runningSteps(repo, host, pull, signal));
      } catch (error) {
        miss(number, alias, { answered: true, broken: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    pulls.push({ number, state: stateOf(pull.state), ...ghMeta(pull), ...ghText(pull), feedback: read });
  }
  return { outcome: "ok", pulls, missing };
}

// GitHub re-requests a review from someone who already reviewed when they are requested again, as its Re-request button does.
export async function prRequestReview(input: HostInput<"prRequestReview">, signal?: AbortSignal): Promise<HostOutput<"prRequestReview">> {
  const pr = githubPull(input.url);
  if (pr === null) return { outcome: "unavailable", message: `${input.url} is not a GitHub pull request URL.` };
  const { host, owner, name, number } = pr;
  const requested: string[] = [];
  const failed: Array<{ login: string; message: string }> = [];
  for (const login of input.reviewers) {
    const asked = await ghCall(input.repo, ["api", "--hostname", host, "--method", "POST", `repos/${owner}/${name}/pulls/${number}/requested_reviewers`, "--input", "-", "--silent"], { stdin: JSON.stringify({ reviewers: [login] }), signal });
    if (asked === "missing") return { outcome: "unavailable", message: GH_MISSING };
    if (asked.code === 0) requested.push(login);
    else failed.push({ login, message: tail(asked.stderr || asked.stdout, 500) });
  }
  return { outcome: "ok", requested, failed };
}

export async function prEdit(input: HostInput<"prEdit">, signal?: AbortSignal): Promise<HostOutput<"prEdit">> {
  if (input.forge.kind === "command") return editWithCommand(input, input.forge.edit, signal);
  const edited = await ghCall(input.repo, ["pr", "edit", input.url, "--title", input.title, "--body-file", "-"], { stdin: input.body, signal });
  if (edited === "missing") return { outcome: "unavailable", message: GH_MISSING };
  if (edited.code !== 0) return readFailed("gh pr edit", edited);
  return { outcome: "ok" };
}

const REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { url } }
}`;
const RESOLVE_MUTATION = `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }`;

/**
 * gh: a reply in the review thread whose node id a thread key holds, then its resolution when asked; a review or a comment
 * gets a comment on the pull request. A reply that went out but whose thread did not resolve is still ok, with why.
 */
export async function prReply(input: HostInput<"prReply">, signal?: AbortSignal): Promise<HostOutput<"prReply">> {
  if (input.forge.kind === "command") return replyWithCommand(input, input.forge.reply, signal);
  const { repo, url, key, kind, body, resolve: close } = input;
  if (kind !== "thread") {
    const commented = await ghCall(repo, ["pr", "comment", url, "--body-file", "-"], { stdin: body, signal });
    if (commented === "missing") return { outcome: "unavailable", message: GH_MISSING };
    if (commented.code !== 0) return readFailed("gh pr comment", commented);
    return { outcome: "ok", url: [...commented.stdout.matchAll(URL_IN_OUTPUT)].at(-1)?.[0] ?? null, resolved: false };
  }
  const pr = githubPull(url);
  if (pr === null) return { outcome: "unavailable", message: `${url} is not a GitHub pull request URL.` };
  const thread = key.split(":")[1] ?? "";
  if (!NODE_ID.test(thread)) return { outcome: "unavailable", message: `${key} names no review thread Loom can reply in.` };
  const replied = await ghCall(repo, ["api", "graphql", "--hostname", pr.host, "-f", `query=${REPLY_MUTATION}`, "-f", `thread=${thread}`, "-f", `body=${body}`], { signal });
  if (replied === "missing") return { outcome: "unavailable", message: GH_MISSING };
  if (replied.code !== 0) return readFailed("gh api graphql", replied);
  const answer = parseJson<{ data?: { addPullRequestReviewThreadReply?: { comment?: { url?: unknown } | null } | null }; errors?: Array<{ message?: string }> }>(replied.stdout);
  const comment = answer?.data?.addPullRequestReviewThreadReply?.comment;
  if (comment == null) return { outcome: "unavailable", message: `GitHub did not add the reply: ${answer?.errors?.[0]?.message ?? tail(replied.stdout, 300)}` };
  const posted = typeof comment.url === "string" ? comment.url : null;
  if (!close) return { outcome: "ok", url: posted, resolved: false };
  const resolved = await ghCall(repo, ["api", "graphql", "--hostname", pr.host, "-f", `query=${RESOLVE_MUTATION}`, "-f", `thread=${thread}`], { signal });
  if (resolved === "missing") return { outcome: "ok", url: posted, resolved: false, message: GH_MISSING };
  if (resolved.code !== 0) return { outcome: "ok", url: posted, resolved: false, message: ghFailed("gh api graphql", resolved) };
  return { outcome: "ok", url: posted, resolved: true };
}

// ---------------------------------------------------------------- the spec's forge commands

const URL_IN_OUTPUT = /https?:\/\/\S+/gu;

function commandFailure(what: string, result: HostOutput<"exec">, limitMs = FORGE_COMMAND_MS): string | null {
  if (result.timedOut) return `The forge's ${what} command took longer than ${limitMs / 60_000} minutes: ${tail(result.output)}`;
  if (result.exitCode !== 0) return `The forge's ${what} command failed (exit ${result.exitCode}): ${tail(result.output)}`;
  return null;
}

// The output mixes the command's stdout and stderr, and a JSON line can carry the pull request's own text. The tail read is
// about as long as the tail the message shows.
const commandErrorText = (output: string) => tail(errorText(output));

/**
 * Why one of the forge's commands failed, with `transient` when its output reads as a failure worth waiting
 * out by ghTransient's rules; a command that timed out always is. A state or feedback command that ran but printed the
 * wrong thing is not: that is the command's own bug. Nothing here runs the command again.
 */
function commandReadFailed(what: string, result: HostOutput<"exec">, limitMs = FORGE_COMMAND_MS): UnavailableAnswer | null {
  const message = commandFailure(what, result, limitMs);
  if (message === null) return null;
  const transient = commandTransient(result) ?? (result.timedOut ? { transient: "server" as const } : null);
  return { outcome: "unavailable", message, ...transient };
}

const commandTransient = (result: HostOutput<"exec">) => ghTransient({ code: result.exitCode ?? -1, stdout: "", stderr: commandErrorText(result.output) });

// The spec asks an open command to print the pull request already open for the branch, so running it again is safe. One
// that printed an error worth waiting out instead of a URL, as a CLI that exits 0 on a refused request does, waits too.
async function openWithCommand(input: HostInput<"prCreate">, command: string, signal?: AbortSignal): Promise<HostOutput<"prCreate">> {
  const { repo, remote, base, head, title, body, draft } = input;
  const env = { LOOM_REMOTE: remote, LOOM_BASE: base, LOOM_HEAD: head, LOOM_TITLE: title, LOOM_DRAFT: draft ? "1" : "0" };
  const result = await spawnCommand({ cwd: repo, command, timeoutMs: FORGE_COMMAND_MS, stdin: body, env }, signal);
  const failed = commandReadFailed("open", result);
  if (failed !== null) return failed;
  const url = [...result.output.matchAll(URL_IN_OUTPUT)].at(-1)?.[0].replace(/[.,;:)\]'"]+$/u, "");
  return url === undefined ? { outcome: "unavailable", message: `The forge's open command printed no pull request URL: ${tail(result.output)}`, ...commandTransient(result) } : { outcome: "ok", url };
}

async function editWithCommand(input: HostInput<"prEdit">, command: string, signal?: AbortSignal): Promise<HostOutput<"prEdit">> {
  const env = { LOOM_URL: input.url, LOOM_PR_NUMBER: prNumber(input.url), LOOM_TITLE: input.title };
  const result = await spawnCommand({ cwd: input.repo, command, timeoutMs: FORGE_COMMAND_MS, stdin: input.body, env }, signal);
  return commandReadFailed("edit", result) ?? { outcome: "ok" };
}

async function retargetWithCommand(input: HostInput<"prRetarget">, command: string, signal?: AbortSignal): Promise<HostOutput<"prRetarget">> {
  const env = { LOOM_URL: input.url, LOOM_PR_NUMBER: prNumber(input.url), LOOM_BASE: input.base };
  const result = await spawnCommand({ cwd: input.repo, command, timeoutMs: RETARGET_COMMAND_MS, env }, signal);
  return commandReadFailed("retarget", result, RETARGET_COMMAND_MS) ?? { outcome: "ok" };
}

// The command is trusted to resolve the thread when LOOM_RESOLVE is 1; a URL it prints is the reply's.
async function replyWithCommand(input: HostInput<"prReply">, command: string, signal?: AbortSignal): Promise<HostOutput<"prReply">> {
  const env = { LOOM_URL: input.url, LOOM_PR_NUMBER: prNumber(input.url), LOOM_ITEM: input.key, LOOM_ITEM_KIND: input.kind, LOOM_RESOLVE: input.resolve ? "1" : "0" };
  const result = await spawnCommand({ cwd: input.repo, command, timeoutMs: FORGE_COMMAND_MS, stdin: input.body, env }, signal);
  const failed = commandReadFailed("reply", result);
  if (failed !== null) return failed;
  const url = [...result.output.matchAll(URL_IN_OUTPUT)].at(-1)?.[0].replace(/[.,;:)\]'"]+$/u, "") ?? null;
  return { outcome: "ok", url, resolved: input.resolve && input.kind === "thread" };
}

// The last non-empty line decides, so a warning a CLI prints first does not hide the state.
async function stateWithCommand(input: HostInput<"prState">, command: string, signal?: AbortSignal): Promise<HostOutput<"prState">> {
  const result = await spawnCommand({ cwd: input.repo, command, timeoutMs: FORGE_COMMAND_MS, env: { LOOM_URL: input.url, LOOM_PR_NUMBER: prNumber(input.url) } }, signal);
  const failed = commandReadFailed("state", result);
  if (failed !== null) return failed;
  const line = result.output.trim().split("\n").at(-1) ?? "";
  const word = line.trim().split(/\s+/u)[0]?.toUpperCase();
  if (word === "OPEN" || word === "MERGED" || word === "CLOSED") return { outcome: "ok", state: word };
  return { outcome: "unavailable", message: `The forge's state command printed "${tail(line, 200)}", not open, merged or closed.` };
}

// ---------------------------------------------------------------- discovery and the push-only forge

export async function remotes(input: HostInput<"remotes">, signal?: AbortSignal): Promise<HostOutput<"remotes">> {
  const names = (await git(input.repo, ["remote"], { signal })).split("\n").filter((name) => name !== "");
  const listed: HostOutput<"remotes">["remotes"] = [];
  for (const name of names) {
    const urls = (await tryGit(input.repo, ["remote", "get-url", "--push", "--all", name], signal)) ?? "";
    listed.push({ name, pushUrls: urls.split("\n").filter((url) => url !== "").map(withoutCredentials) });
  }
  return { remotes: listed };
}

export async function ghStatus(input: HostInput<"ghStatus">, signal?: AbortSignal): Promise<HostOutput<"ghStatus">> {
  const host = parseRemoteUrl(input.pushUrl)?.split("/")[0] ?? null;
  if (host === null) return { status: "not_a_url", host: null };
  const checked = await gh(input.repo, ["auth", "status", "--hostname", host], { signal });
  if (checked === "missing") return { status: "missing", host };
  return { status: checked.code === 0 ? "ready" : "signed_out", host };
}

/** Adds a worktree with no checkout under the data directory and removes it again; git's refusal is the message. */
export async function trialWorktree(input: HostInput<"trialWorktree">, dataDir: string, signal?: AbortSignal): Promise<HostOutput<"trialWorktree">> {
  const path = join(dataDir, "trial", randomBytes(6).toString("hex"));
  mkdirSync(dirname(path), { recursive: true });
  const added = await run(input.repo, ["worktree", "add", "--no-checkout", "--detach", path, "HEAD"], signal);
  if (added.code !== 0) return { outcome: "refused", message: tail(added.stderr || added.stdout) };
  await run(input.repo, ["worktree", "remove", "--force", path], signal);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    await run(input.repo, ["worktree", "prune"], signal);
  }
  return { outcome: "ok" };
}

export async function landedOn(input: HostInput<"landedOn">, signal?: AbortSignal): Promise<HostOutput<"landedOn">> {
  const { repo, remote, base, sha } = input;
  const listed = await runRemote(repo, ["ls-remote", remote, `refs/heads/${base}`], networkTimeout(input), signal);
  if (listed.code !== 0) return remoteFailed(`git ls-remote ${remote}`, listed);
  const tip = listed.stdout.trim().split(/\s+/u)[0] ?? "";
  if (tip === "") return { outcome: "unavailable", message: `The remote "${remote}" has no branch ${base}.` };
  const fetched = await runRemote(repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/heads/${base}`], networkTimeout(input), signal);
  if (fetched.code !== 0) return remoteFailed(`git fetch from ${remote}`, fetched);
  const ancestry = await run(repo, ["merge-base", "--is-ancestor", sha, tip], signal);
  if (ancestry.code === 0 || ancestry.code === 1) return { outcome: "ok", landed: ancestry.code === 0 };
  throw failure(["merge-base", "--is-ancestor", sha, tip], ancestry);
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The first `head` bytes and the last `tail` bytes of a stream; the middle of a longer one is dropped and counted. */
class HeadTail {
  private headChunks: Buffer[] = [];
  private headSize = 0;
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = 0;
  constructor(
    private readonly head: number,
    private readonly tail: number,
  ) {}
  push(chunk: Buffer): void {
    if (this.headSize < this.head) {
      const taken = chunk.subarray(0, this.head - this.headSize);
      this.headChunks.push(taken);
      this.headSize += taken.length;
      chunk = chunk.subarray(taken.length);
      if (chunk.length === 0) return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.tail) {
      const first = this.chunks.shift()!;
      this.size -= first.length;
      this.dropped += first.length;
    }
  }
  toString(): string {
    const head = Buffer.concat(this.headChunks).toString("utf8");
    const rest = Buffer.concat(this.chunks);
    if (this.dropped === 0 && this.size <= this.tail) return head + rest.toString("utf8");
    const left = this.dropped + this.size - this.tail;
    return `${head}\n[… ${left} bytes left out …]\n${rest.subarray(this.size - this.tail).toString("utf8")}`;
  }
}

/** Runs a shell command in its own process group and kills the whole group on timeout or abort. */
export function spawnCommand(input: HostInput<"exec">, signal?: AbortSignal): Promise<HostOutput<"exec">> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(new Error("aborted before start"));
    const options = { cwd: input.cwd, env: { ...process.env, ...input.env }, detached: true };
    // Checks keep an ignored stdin: a piped one changes tools like rg, which search stdin when it is a pipe.
    const child =
      input.stdin === undefined
        ? spawn("/bin/sh", ["-c", input.command], { ...options, stdio: ["ignore", "pipe", "pipe"] })
        : spawn("/bin/sh", ["-c", input.command], { ...options, stdio: ["pipe", "pipe", "pipe"] });
    if (input.stdin !== undefined) {
      // A hook that exits without reading its input closes the pipe; that EPIPE is not its failure.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input.stdin);
    }
    const output = new HeadTail(OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES);
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    };
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.on("close", (code) => {
      done();
      resolve({ exitCode: code, timedOut, durationMs: Date.now() - started, output: output.toString() });
    });
  });
}

export const exec = spawnCommand;
