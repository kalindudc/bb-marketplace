// What the host entry runs on the machine that owns the checkout: git through argv, never a shell, and check
// commands in their own process group. host.ts wires these to RPC handlers; tests call them directly.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { experimental_runVcsProcess, type ExperimentalVcsProcessPriority } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { githubPull, prNumber, REVIEW_DECISIONS, type HostInput, type HostOutput } from "../host-contract";

const GIT_TIMEOUT_MS = 30_000;
// Pushes, gh calls and the first checkout of the integration worktree can take a while on a slow link or a large repository.
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

function run(cwd: string, args: readonly string[], signal?: AbortSignal, timeout = GIT_TIMEOUT_MS, priority: Priority = "background"): Promise<GitRun> {
  const argv = ["-C", cwd, ...args];
  return experimental_runVcsProcess(
    "git",
    argv,
    () =>
      new Promise<GitRun>((resolve, reject) => {
        execFile(
          "git",
          argv,
          { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, maxBuffer: GIT_MAX_BUFFER, timeout, signal, encoding: "utf8" },
          (error, stdout, stderr) => {
            if (error === null) return resolve({ code: 0, stdout, stderr });
            const failure = error as NodeJS.ErrnoException & { killed?: boolean };
            if (typeof failure.code === "number") return resolve({ code: failure.code, stdout, stderr });
            reject(new Error(failure.killed === true ? `git ${args[0]} took too long` : `git ${args[0]}: ${failure.message}`));
          },
        );
      }),
    { priority, signal },
  );
}

function failure(args: readonly string[], result: GitRun): Error {
  return new Error(`git ${args.join(" ")} failed (${result.code}): ${(result.stderr.trim() || result.stdout.trim()).slice(-2000)}`);
}

/** Runs git in `cwd` and returns stdout; trimmed unless `raw` (NUL-separated listings). Throws when git exits non-zero. */
export async function git(cwd: string, args: readonly string[], opts: { raw?: boolean; signal?: AbortSignal; priority?: Priority } = {}): Promise<string> {
  const result = await run(cwd, args, opts.signal, GIT_TIMEOUT_MS, opts.priority);
  if (result.code !== 0) throw failure(args, result);
  return opts.raw === true ? result.stdout : result.stdout.trim();
}

async function tryGit(cwd: string, args: readonly string[], signal?: AbortSignal, priority?: Priority): Promise<string | null> {
  const result = await run(cwd, args, signal, GIT_TIMEOUT_MS, priority);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function ensureBranch(input: HostInput<"ensureBranch">, signal?: AbortSignal): Promise<HostOutput<"ensureBranch">> {
  const { repo, branch, from } = input;
  const existing = await tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], signal);
  if (existing !== null) return { sha: existing, created: false };
  const sha = await git(repo, ["rev-parse", "--verify", `${from}^{commit}`], { signal });
  await git(repo, ["branch", "--no-track", branch, sha], { signal });
  return { sha, created: true };
}

export async function worktreeState(input: HostInput<"worktreeState">, signal?: AbortSignal): Promise<HostOutput<"worktreeState">> {
  const { worktree, base, trackedOnly } = input;
  const head = await git(worktree, ["rev-parse", "HEAD"], { signal });
  const branch = (await tryGit(worktree, ["symbolic-ref", "--short", "-q", "HEAD"], signal)) || null;
  const dirty = (await git(worktree, ["status", "--porcelain", ...(trackedOnly === true ? ["--untracked-files=no"] : [])], { signal })) !== "";
  const mergeBase = await git(worktree, ["merge-base", base, "HEAD"], { signal });
  const tracked = await git(worktree, ["diff", "--name-only", "-z", "--no-renames", mergeBase], { raw: true, signal });
  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], { raw: true, signal });
  const changed = [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter((path) => path !== ""))].sort();
  return { branch, head, dirty, changed };
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
  const patch = Buffer.from(await git(repo, args, { raw: true, signal, priority: INTERACTIVE }));
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
 * merge that was, so the rollback point is the one the caller persisted before the first run, or HEAD when it has none.
 */
export async function merge(input: HostInput<"merge">, signal?: AbortSignal): Promise<HostOutput<"merge">> {
  const { worktree, message } = input;
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
  const pushed = await run(repo, ["push", remote, `${src}:refs/heads/${branch}`], signal, NETWORK_TIMEOUT_MS);
  return pushed.code === 0 ? { outcome: "ok" } : { outcome: "unavailable", message: `git push to ${remote} failed: ${tail(pushed.stderr || pushed.stdout)}` };
}

const isAncestor = async (repo: string, ancestor: string, of: string, signal?: AbortSignal): Promise<boolean> => {
  const checked = await run(repo, ["merge-base", "--is-ancestor", ancestor, of], signal);
  if (checked.code === 0 || checked.code === 1) return checked.code === 0;
  throw failure(["merge-base", "--is-ancestor", ancestor, of], checked);
};

/**
 * The one commit Loom pushes for a ticket's pull request: head's tree on the remote branch's tip, or, when the branch is not
 * there yet, on head's merge base with `base`. When head also contains a newer base than the tip does, that base is a second
 * parent, so the pull request's diff stays the ticket's own. It signs as the user's git config says.
 */
export async function prCommit(input: HostInput<"prCommit">, signal?: AbortSignal): Promise<HostOutput<"prCommit">> {
  const { repo, remote, branch, base, head, message, pushed } = input;
  // The branch is read where `git push` sends it, which a remote that fetches from elsewhere does not show.
  const pushUrls = (await tryGit(repo, ["remote", "get-url", "--push", "--all", remote], signal))?.split("\n").filter((line) => line !== "");
  if (pushUrls === undefined || pushUrls.length === 0) return { outcome: "unavailable", message: `The git remote "${remote}" does not exist in ${repo}.` };
  if (pushUrls.length > 1) return { outcome: "unavailable", message: `The remote "${remote}" has ${pushUrls.length} push URLs, so Loom cannot tell which one holds the pull request's branch. Leave one with \`git remote set-url --push ${remote} <url>\`.` };
  const target = pushUrls[0]!;
  const listed = await run(repo, ["ls-remote", target, `refs/heads/${branch}`], signal, NETWORK_TIMEOUT_MS);
  if (listed.code !== 0) return { outcome: "unavailable", message: `git ls-remote ${remote} failed: ${tail(listed.stderr || listed.stdout)}` };
  const tip = listed.stdout.trim().split(/\s+/u)[0] || null;
  if (tip !== null && (await tryGit(repo, ["cat-file", "-e", `${tip}^{commit}`], signal)) === null) {
    const fetched = await run(repo, ["fetch", "--no-tags", "--no-write-fetch-head", target, `refs/heads/${branch}`], signal, NETWORK_TIMEOUT_MS);
    if (fetched.code !== 0) return { outcome: "unavailable", message: `git fetch from ${remote} failed: ${tail(fetched.stderr || fetched.stdout)}` };
  }
  const tree = await git(repo, ["rev-parse", "--verify", `${head}^{tree}`], { signal });
  const mergeBase = await git(repo, ["merge-base", head, base], { signal });
  const parents: string[] = [];
  if (tip !== null) {
    if ((await git(repo, ["rev-parse", "--verify", `${tip}^{tree}`], { signal })) === tree) return { outcome: "ok", sha: tip, created: false };
    if (tip !== pushed && !(await isAncestor(repo, tip, head, signal))) return { outcome: "diverged", tip };
    parents.push(tip);
    if (!(await isAncestor(repo, mergeBase, tip, signal))) parents.push(mergeBase);
  } else {
    parents.push(mergeBase);
  }
  return { outcome: "ok", sha: await commitTree(repo, tree, parents, message, signal), created: true };
}

// git commit-tree with the message on stdin, which execFile cannot give, so it runs through spawn.
function commitTree(repo: string, tree: string, parents: readonly string[], message: string, signal?: AbortSignal): Promise<string> {
  return identityArgs(repo, signal).then((identity) => {
    const args = ["-C", repo, ...identity, "commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-F", "-"];
    return experimental_runVcsProcess(
      "git",
      args,
      () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, signal, stdio: ["pipe", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          const timer = setTimeout(() => child.kill("SIGKILL"), NETWORK_TIMEOUT_MS);
          child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
          child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
          child.stdin.on("error", () => undefined);
          child.stdin.end(message.endsWith("\n") ? message : `${message}\n`);
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            const sha = stdout.trim();
            if (code === 0 && /^[0-9a-f]{40,64}$/u.test(sha)) resolve(sha);
            else reject(new Error(`git commit-tree failed (${code ?? "killed"}): ${tail(stderr || stdout)}`));
          });
        }),
      { priority: "background", signal },
    );
  });
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
    const fetched = await run(repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${base}:${tracking}`], signal, NETWORK_TIMEOUT_MS);
    if (fetched.code !== 0) return { outcome: "unavailable", message: `git fetch from ${remote} failed: ${tail(fetched.stderr || fetched.stdout)}` };
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
  for (const next of kept.slice(1)) {
    const merged = await run(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", sha, next], signal);
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
  return { outcome: "ok", sha, tip };
}

export async function fetchBranch(input: HostInput<"fetchBranch">, signal?: AbortSignal): Promise<HostOutput<"fetchBranch">> {
  const { worktree, remote, branch } = input;
  const fetched = await run(worktree, ["fetch", "--no-tags", remote, `refs/heads/${branch}`], signal, NETWORK_TIMEOUT_MS);
  if (fetched.code !== 0) return { outcome: "unavailable", message: `git fetch from ${remote} failed: ${tail(fetched.stderr || fetched.stdout)}` };
  return { outcome: "ok", sha: await git(worktree, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { signal }) };
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

type ReadUnavailable = Extract<HostOutput<"prFeedback">, { outcome: "unavailable" }>;
type Transient = Pick<ReadUnavailable, "transient" | "retryAfterMs">;

/** One gh call for a pull request read. A timeout comes back as a failed run, so it is classified like GitHub's own; nothing here runs gh again. */
async function ghRead(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<GhRun> {
  try {
    return await gh(cwd, args, { signal });
  } catch (error) {
    if (error instanceof GhTimedOut) return { code: -1, stdout: "", stderr: `gh timed out after ${NETWORK_TIMEOUT_MS / 60_000} minutes` };
    throw error;
  }
}

const GH_AUTH_EXIT = 4;
const HTTP_STATUS = /\bHTTP (\d{3})\b/u;
const RATE_LIMITED = /rate[-_ ]limit|abuse detection|too many requests/iu;
const SERVER_TROUBLE = /\bserver error\b|bad gateway|service unavailable|gateway time-?out|\btime(?:d[- ]?|[- ]?)out|deadline exceeded|connection (?:reset|refused)|\bEOF\b|TLS handshake|something went wrong/iu;
// The read never reached the forge: its name did not resolve or no connection opened. That is this machine's resolver or
// network, not one pull request, so it is tested before SERVER_TROUBLE, whose timeouts would also match a connect timeout.
const NETWORK_TROUBLE =
  /could not resolve host|dns error|failed to lookup address|nodename nor servname|no such host|temporary failure in name resolution|getaddrinfo|name or service not known|error connecting to|client error \(connect\)|network is unreachable|host is unreachable|no route to host|connection timed out|i\/o timeout|check your internet connection/iu;
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

// A failed read's stdout is the response body, which can hold the pull request's own text; only its error fields are read.
function ghErrorText(run: GitRun): string {
  const fields = errorFields(run.stdout);
  return fields === null ? `${run.stderr}\n${run.stdout.slice(0, 2000)}` : [run.stderr, ...fields].join("\n");
}

function retryAfterMs(text: string): number | null {
  const seconds = RETRY_AFTER_SECONDS.exec(text);
  const reset = RATE_LIMIT_RESET.exec(text);
  const later = TRY_AGAIN_IN.exec(text);
  const ms = seconds !== null ? Number(seconds[1]) * 1000 : reset !== null ? Number(reset[1]) * 1000 - Date.now() : later !== null ? Number(later[1]) * UNIT_MS[later[2]!.toLowerCase()]! : null;
  return ms === null ? null : Math.min(LONGEST_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}

/**
 * Whether a failed gh read is worth waiting out: `rate_limit` when GitHub says it rate-limited the call (HTTP 403 or 429, or
 * GraphQL's RATE_LIMITED), `server` for its 500, 502, 503 and 504 answers, timeouts and dropped connections, and `network`
 * when the call never reached it, such as a name lookup that failed. Null for the rest, such as a missing login, a 404 or a
 * bad URL. A forge command's failed read is classified by the same rules.
 */
export function ghTransient(run: GitRun): Transient | null {
  if (run.code === GH_AUTH_EXIT) return null;
  const text = ghErrorText(run);
  const status = HTTP_STATUS.exec(text)?.[1];
  if (RATE_LIMITED.test(text) && (status === undefined || status === "403" || status === "429")) {
    const wait = retryAfterMs(text);
    return wait === null ? { transient: "rate_limit" } : { transient: "rate_limit", retryAfterMs: wait };
  }
  if (status !== undefined) return /^50[0234]$/u.test(status) ? { transient: "server" } : null;
  if (NETWORK_TROUBLE.test(text)) return { transient: "network" };
  return SERVER_TROUBLE.test(text) ? { transient: "server" } : null;
}

function readFailed(what: string, run: GitRun): ReadUnavailable {
  return { outcome: "unavailable", message: ghFailed(what, run), ...ghTransient(run) };
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

  const created = await gh(repo, ["pr", "create", "--repo", github, "--base", base, "--head", head, "--title", title, "--body-file", "-", ...(draft ? ["--draft"] : [])], { stdin: body, signal });
  if (created === "missing") return unavailable(GH_MISSING);
  if (created.code === 0) {
    const url = created.stdout.trim().split("\n").pop() ?? "";
    return /^https?:\/\/\S+$/u.test(url) ? { outcome: "ok", url } : unavailable(`gh pr create printed no pull request URL: ${tail(created.stdout)}`);
  }
  if (!/already exists/iu.test(`${created.stderr}\n${created.stdout}`)) return unavailable(ghFailed("gh pr create", created));

  const viewed = await gh(repo, ["pr", "view", head, "--repo", github, "--json", "url"], { signal });
  if (viewed === "missing") return unavailable(GH_MISSING);
  if (viewed.code !== 0) return unavailable(ghFailed("gh pr view", viewed));
  const url = parseJson<{ url?: unknown }>(viewed.stdout)?.url;
  return typeof url === "string" ? { outcome: "ok", url } : unavailable(`gh pr view printed no URL: ${tail(viewed.stdout)}`);
}

export async function prRetarget(input: HostInput<"prRetarget">, signal?: AbortSignal): Promise<HostOutput<"prRetarget">> {
  const edited = await gh(input.repo, ["pr", "edit", input.url, "--base", input.base], { signal });
  if (edited === "missing") return { outcome: "unavailable", message: GH_MISSING };
  if (edited.code !== 0) return { outcome: "unavailable", message: ghFailed("gh pr edit", edited) };
  return { outcome: "ok" };
}

export async function prState(input: HostInput<"prState">, signal?: AbortSignal): Promise<HostOutput<"prState">> {
  if (input.forge.kind === "command") return stateWithCommand(input, input.forge.state, signal);
  const viewed = await ghRead(input.repo, ["pr", "view", input.url, "--json", "state"], signal);
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
const clipBody = (text: string) => (text.length <= BODY_MAX ? text : `${text.slice(0, BODY_MAX - 1)}…`);

// What Loom reads of every pull request, and with the feedback the rest of what prFeedback answers. It asks for no check
// run's steps, which made one pull request's read slow enough to time out at GitHub; runningSteps reads them when needed.
const META_FIELDS = "number state isDraft reviewDecision baseRefName";
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

/** The draft flag, review decision and base branch GitHub reports; null for one the answer leaves out. */
function ghMeta(pull: GhMeta): { draft: boolean | null; review: Review | null; base: string | null } {
  return { draft: typeof pull.isDraft === "boolean" ? pull.isDraft : null, review: reviewOf(pull.reviewDecision), base: typeof pull.baseRefName === "string" ? pull.baseRefName : null };
}

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
  const asked = await ghRead(repo, ["api", "graphql", "--hostname", host, "-f", `query=${query}`], signal).catch(() => null);
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
  const asked = await ghRead(input.repo, ["api", "graphql", "--hostname", host, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`, "-f", `query=${FEEDBACK_QUERY}`], signal);
  if (asked === "missing") return { outcome: "unavailable", message: GH_MISSING };
  if (asked.code !== 0) return readFailed("gh api graphql", asked);
  const pull = parseJson<{ data?: { repository?: { pullRequest?: GhPull | null } | null } }>(asked.stdout)?.data?.repository?.pullRequest;
  if (pull == null) return { outcome: "unavailable", message: `gh found no pull request at ${input.url}: ${tail(asked.stdout, 300)}` };
  return ghFeedback(pull, await runningSteps(input.repo, host, pull, signal));
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
  const asked = await ghRead(repo, ["api", "graphql", "--hostname", host, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${batchQuery(numbers, feedback)}`], signal);
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
    pulls.push({ number, state: stateOf(pull.state), ...ghMeta(pull), feedback: read });
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
    const asked = await gh(input.repo, ["api", "--hostname", host, "--method", "POST", `repos/${owner}/${name}/pulls/${number}/requested_reviewers`, "--input", "-", "--silent"], { stdin: JSON.stringify({ reviewers: [login] }), signal });
    if (asked === "missing") return { outcome: "unavailable", message: GH_MISSING };
    if (asked.code === 0) requested.push(login);
    else failed.push({ login, message: tail(asked.stderr || asked.stdout, 500) });
  }
  return { outcome: "ok", requested, failed };
}

// ---------------------------------------------------------------- the spec's forge commands

const URL_IN_OUTPUT = /https?:\/\/\S+/gu;

function commandFailure(what: string, result: HostOutput<"exec">): string | null {
  if (result.timedOut) return `The forge's ${what} command took longer than ${FORGE_COMMAND_MS / 60_000} minutes: ${tail(result.output)}`;
  if (result.exitCode !== 0) return `The forge's ${what} command failed (exit ${result.exitCode}): ${tail(result.output)}`;
  return null;
}

// The output mixes the command's stdout and stderr, and a JSON line can carry the pull request's own text, so only the error
// fields of such a line count. The text is the tail the message shows.
const commandErrorText = (output: string) =>
  tail(output)
    .split("\n")
    .map((line) => errorFields(line.trim())?.join("\n") ?? line)
    .join("\n");

/**
 * Why a forge's state or feedback command failed, with `transient` when its output reads as a failure worth waiting out by
 * ghTransient's rules; a command that timed out always is. A command that ran but printed the wrong thing is not: that is
 * the command's own bug. Nothing here runs the command again.
 */
function commandReadFailed(what: string, result: HostOutput<"exec">): ReadUnavailable | null {
  const message = commandFailure(what, result);
  if (message === null) return null;
  const transient = ghTransient({ code: result.exitCode ?? -1, stdout: "", stderr: commandErrorText(result.output) }) ?? (result.timedOut ? { transient: "server" as const } : null);
  return { outcome: "unavailable", message, ...transient };
}

async function openWithCommand(input: HostInput<"prCreate">, command: string, signal?: AbortSignal): Promise<HostOutput<"prCreate">> {
  const { repo, remote, base, head, title, body, draft } = input;
  const env = { LOOM_REMOTE: remote, LOOM_BASE: base, LOOM_HEAD: head, LOOM_TITLE: title, LOOM_DRAFT: draft ? "1" : "0" };
  const result = await spawnCommand({ cwd: repo, command, timeoutMs: FORGE_COMMAND_MS, stdin: body, env }, signal);
  const failed = commandFailure("open", result);
  if (failed !== null) return { outcome: "unavailable", message: failed };
  const url = [...result.output.matchAll(URL_IN_OUTPUT)].at(-1)?.[0].replace(/[.,;:)\]'"]+$/u, "");
  return url === undefined ? { outcome: "unavailable", message: `The forge's open command printed no pull request URL: ${tail(result.output)}` } : { outcome: "ok", url };
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
  const listed = await run(repo, ["ls-remote", remote, `refs/heads/${base}`], signal, NETWORK_TIMEOUT_MS);
  if (listed.code !== 0) return { outcome: "unavailable", message: `git ls-remote ${remote} failed: ${tail(listed.stderr || listed.stdout)}` };
  const tip = listed.stdout.trim().split(/\s+/u)[0] ?? "";
  if (tip === "") return { outcome: "unavailable", message: `The remote "${remote}" has no branch ${base}.` };
  const fetched = await run(repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/heads/${base}`], signal, NETWORK_TIMEOUT_MS);
  if (fetched.code !== 0) return { outcome: "unavailable", message: `git fetch from ${remote} failed: ${tail(fetched.stderr || fetched.stdout)}` };
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
