// What the host entry runs on the machine that owns the checkout: git through argv, never a shell, and check
// commands in their own process group. host.ts wires these to RPC handlers; tests call them directly.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HostInput, HostOutput } from "../host-contract";

const GIT_TIMEOUT_MS = 30_000;
// Pushes, gh calls and the first checkout of the integration worktree can take a while on a slow link or a large repository.
const NETWORK_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const OUTPUT_HEAD_BYTES = 16 * 1024;
const OUTPUT_TAIL_BYTES = 48 * 1024;

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cwd: string, args: readonly string[], signal?: AbortSignal, timeout = GIT_TIMEOUT_MS): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, maxBuffer: GIT_MAX_BUFFER, timeout, signal, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (typeof failure.code === "number") return resolve({ code: failure.code, stdout, stderr });
        reject(new Error(failure.killed === true ? `git ${args[0]} took too long` : `git ${args[0]}: ${failure.message}`));
      },
    );
  });
}

function failure(args: readonly string[], result: GitRun): Error {
  return new Error(`git ${args.join(" ")} failed (${result.code}): ${(result.stderr.trim() || result.stdout.trim()).slice(-2000)}`);
}

/** Runs git in `cwd` and returns stdout; trimmed unless `raw` (NUL-separated listings). Throws when git exits non-zero. */
export async function git(cwd: string, args: readonly string[], opts: { raw?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  const result = await run(cwd, args, opts.signal);
  if (result.code !== 0) throw failure(args, result);
  return opts.raw === true ? result.stdout : result.stdout.trim();
}

async function tryGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string | null> {
  const result = await run(cwd, args, signal);
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
  const stat = await git(repo, ["diff", "--stat", "--no-color", range, "--"], { signal });
  const patch = Buffer.from(await git(repo, ["diff", "--no-color", range, "--"], { raw: true, signal }));
  const truncated = patch.length > maxBytes;
  return { stat, patch: patch.subarray(0, maxBytes).toString("utf8"), truncated };
}

// ---------------------------------------------------------------- the Changes tab

// Between two commits, so the user's diff drivers, text conversions and rename detection do not change what the page shows.
const PLAIN_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"] as const;
const NO_BLOB = /^0+$/u;
type ChangedFile = Extract<HostOutput<"changedFiles">, { outcome: "ok" }>["files"][number];
const STATUS_OF: Record<string, ChangedFile["status"]> = { A: "added", D: "deleted", T: "type_changed" };

const commitOf = (repo: string, ref: string, signal?: AbortSignal) => tryGit(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal);
const missing = (message: string) => ({ outcome: "missing" as const, message });

/** With `landed`, a head that base already contains is compared with base as it was before the merge that brought it in, on base's first-parent line. */
async function compareFrom(repo: string, target: string, head: string, landed: boolean, signal?: AbortSignal): Promise<string | null> {
  const base = await tryGit(repo, ["merge-base", target, head], signal);
  if (base === null || !landed || base !== head) return base;
  const merge = (await git(repo, ["rev-list", "--first-parent", "--ancestry-path", `${head}..${target}`], { signal })).split("\n").filter((line) => line !== "").at(-1);
  const before = merge === undefined ? null : await commitOf(repo, `${merge}^1`, signal);
  return (before === null ? null : await tryGit(repo, ["merge-base", before, head], signal)) ?? base;
}

export async function changedFiles(input: HostInput<"changedFiles">, signal?: AbortSignal): Promise<HostOutput<"changedFiles">> {
  const { repo, maxFiles } = input;
  const head = await commitOf(repo, input.head, signal);
  if (head === null) return missing(`${input.head} is not in the repository.`);
  const target = await commitOf(repo, input.base, signal);
  if (target === null) return missing(`${input.base} is not in the repository.`);
  const base = input.mergeBase ? await compareFrom(repo, target, head, input.landed === true, signal) : target;
  if (base === null) return missing(`${input.head} and ${input.base} share no history.`);

  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const entry of (await git(repo, ["diff", "--numstat", "-z", ...PLAIN_DIFF, base, head, "--"], { raw: true, signal })).split("\0")) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/su.exec(entry);
    if (match === null) continue;
    const binary = match[1] === "-";
    counts.set(match[3]!, { additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary });
  }
  const parts = (await git(repo, ["diff", "--raw", "-z", "--no-abbrev", ...PLAIN_DIFF, base, head, "--"], { raw: true, signal })).split("\0");
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
  for (const ref of [base, head]) if ((await commitOf(repo, ref, signal)) === null) return missing(`${ref} is not in the repository.`);
  const args = ["--literal-pathspecs", "diff", ...PLAIN_DIFF, "--src-prefix=a/", "--dst-prefix=b/", base, head, "--", path];
  const patch = Buffer.from(await git(repo, args, { raw: true, signal }));
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
  const path = join(dataDir, "worktrees", key);
  const unavailable = (reason: "branch_checked_out" | "git", message: string): HostOutput<"ensureWorktree"> => ({ outcome: "unavailable", reason, message });

  if (!existsSync(path)) {
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
  if (current !== branch) return unavailable("git", `The Loom worktree at ${path} is on ${current ?? "a detached HEAD"}, not ${branch}.`);

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

// gh never prompts: GH_PROMPT_DISABLED turns its prompts into errors.
function gh(cwd: string, args: readonly string[], opts: { stdin?: string; signal?: AbortSignal } = {}): Promise<GhRun> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      [...args],
      { cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: GIT_MAX_BUFFER, timeout: NETWORK_TIMEOUT_MS, signal: opts.signal, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        const failed = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failed.code === "ENOENT") return resolve("missing");
        if (typeof failed.code === "number") return resolve({ code: failed.code, stdout, stderr });
        reject(new Error(failed.killed === true ? `gh ${args[0]} took too long` : `gh ${args[0]}: ${failed.message}`));
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.stdin ?? "");
  });
}

const GH_MISSING = "The gh CLI is not installed on this machine, or it is not on PATH.";
const ghFailed = (what: string, run: GitRun) => `${what} failed: ${tail(run.stderr || run.stdout)}`;
const withoutCredentials = (url: string) => url.replace(/\/\/[^@/\s]+@/u, "//");

export async function prCreate(input: HostInput<"prCreate">, signal?: AbortSignal): Promise<HostOutput<"prCreate">> {
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

export async function prState(input: HostInput<"prState">, signal?: AbortSignal): Promise<HostOutput<"prState">> {
  const viewed = await gh(input.repo, ["pr", "view", input.url, "--json", "state"], { signal });
  if (viewed === "missing") return { outcome: "unavailable", message: GH_MISSING };
  if (viewed.code !== 0) return { outcome: "unavailable", message: ghFailed("gh pr view", viewed) };
  const state = parseJson<{ state?: unknown }>(viewed.stdout)?.state;
  if (state === "OPEN" || state === "MERGED" || state === "CLOSED") return { outcome: "ok", state };
  return { outcome: "unavailable", message: `gh pr view returned an unknown state: ${tail(viewed.stdout)}` };
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
