// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import hostEntry from "../host";
import { restrictedGitBin } from "./restricted-git";
import { hostContract, REPLY_MARK, type HostInput, type HostOutput } from "../src/host-contract";
import {
  batchQuery,
  behindBase,
  carryDelete,
  carryFinish,
  carryStart,
  carryWrite,
  changedFiles,
  commitAll,
  conflictMarkers,
  diff,
  ensureBranch,
  ensureWorktree,
  exec,
  exportChanges,
  fetchBranch,
  fetchTip,
  filePatch,
  ghStatus,
  ghTransient,
  git,
  importChunk,
  importCommit,
  landedOn,
  merge,
  mergeOnto,
  parseRemoteUrl,
  pointRefs,
  prBatch,
  prCommit,
  prCreate,
  prEdit,
  prFeedback,
  prReply,
  prRequestReview,
  prRetarget,
  prState,
  push,
  readBlob,
  refTip,
  remoteBranch,
  remotes,
  resetHard,
  stackBase,
  trialWorktree,
  worktreeState,
} from "../src/host/ops";

const ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const AUTHOR_VARS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const saved: Record<string, string | undefined> = {};

let scratch: string;
let counter = 0;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const GH = { kind: "gh" } as const;
// What the Delta CLI printed on 2026-10-26 while this machine's resolver lost names, and what gh prints when it cannot connect.
const DT_OFFLINE = [
  "Error: GET https://delta.shopify.io/api/v3/repos/shop/world/pulls/2313251",
  "",
  "Caused by:",
  "    0: error sending request for url (https://delta.shopify.io/api/v3/repos/shop/world/pulls/2313251)",
  "    1: client error (Connect)",
  "    2: dns error",
  "    3: failed to lookup address information: nodename nor servname provided, or not known",
].join("\n");
const GH_OFFLINE = "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com";
const put = (root: string, path: string, content: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
};

function makeRepo(identity = true): string {
  const dir = join(scratch, `repo-${counter++}`);
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  if (identity) {
    sh(dir, "config", "user.email", "dev@example.com");
    sh(dir, "config", "user.name", "Dev");
    put(dir, "README.md", "hello\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

function addWorktree(repo: string, branch: string): string {
  const path = join(scratch, `wt-${counter++}`);
  sh(repo, "worktree", "add", "-q", "-b", branch, path, "main");
  return path;
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "loom-host-")));
  for (const key of [...Object.keys(ENV), ...AUTHOR_VARS]) saved[key] = process.env[key];
  for (const key of AUTHOR_VARS) delete process.env[key];
  Object.assign(process.env, ENV);
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("ensureBranch", () => {
  it("creates the branch once and then leaves it where it is", async () => {
    const repo = makeRepo();
    const first = await ensureBranch({ repo, branch: "loom/csv", from: "main" });
    expect(first).toEqual({ sha: sh(repo, "rev-parse", "main"), created: true });

    put(repo, "later.txt", "x");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "later");
    const second = await ensureBranch({ repo, branch: "loom/csv", from: "main" });
    expect(second).toEqual({ sha: first.sha, created: false });
    expect(sh(repo, "rev-parse", "loom/csv")).toBe(first.sha);
  });

  it("fails when the base does not exist", async () => {
    const repo = makeRepo();
    await expect(ensureBranch({ repo, branch: "loom/csv", from: "nope" })).rejects.toThrow(/nope/);
  });
});

describe("commitAll", () => {
  it("is a no-op on a clean tree and commits tracked and untracked changes otherwise", async () => {
    const repo = makeRepo();
    const head = sh(repo, "rev-parse", "HEAD");
    expect(await commitAll({ worktree: repo, message: "nothing" })).toEqual({ sha: head, committed: false });

    put(repo, "README.md", "changed\n");
    put(repo, "src/new.ts", "export {};\n");
    const done = await commitAll({ worktree: repo, message: "CSV-1: work" });
    expect(done.committed).toBe(true);
    expect(done.sha).toBe(sh(repo, "rev-parse", "HEAD"));
    expect(done.sha).not.toBe(head);
    expect(sh(repo, "log", "-1", "--format=%s")).toBe("CSV-1: work");
    expect(sh(repo, "status", "--porcelain")).toBe("");
    expect(sh(repo, "ls-files")).toContain("src/new.ts");
  });

  it("uses the Loom identity when git has none, and keeps the repository's own otherwise", async () => {
    const bare = makeRepo(false);
    put(bare, "a.txt", "a");
    const first = await commitAll({ worktree: bare, message: "first" });
    expect(first.committed).toBe(true);
    expect(sh(bare, "log", "-1", "--format=%an <%ae>")).toBe("Loom <loom@localhost>");

    const own = makeRepo();
    put(own, "b.txt", "b");
    await commitAll({ worktree: own, message: "second" });
    expect(sh(own, "log", "-1", "--format=%ae")).toBe("dev@example.com");
  });
});

describe("worktreeState", () => {
  it("lists committed, modified and untracked files against the merge base", async () => {
    const repo = makeRepo();
    const worktree = addWorktree(repo, "loom/csv-1");
    put(worktree, "src/a.ts", "a");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "a");
    put(worktree, "README.md", "edited\n");
    put(worktree, "notes/new.txt", "new");

    put(repo, "other.txt", "main moved on");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "main moves");

    const state = await worktreeState({ worktree, base: "main" });
    expect(state.branch).toBe("loom/csv-1");
    expect(state.head).toBe(sh(worktree, "rev-parse", "HEAD"));
    expect(state.dirty).toBe(true);
    expect([...state.changed].sort()).toEqual(["README.md", "notes/new.txt", "src/a.ts"]);
  });

  it("is clean after commitAll and reports a detached head as no branch", async () => {
    const repo = makeRepo();
    const worktree = addWorktree(repo, "loom/csv-2");
    put(worktree, "src/a.ts", "a");
    const { sha } = await commitAll({ worktree, message: "a" });
    expect(await worktreeState({ worktree, base: "main" })).toEqual({ branch: "loom/csv-2", head: sha, tree: sh(worktree, "rev-parse", "HEAD^{tree}"), dirty: false, changed: ["src/a.ts"], unfinishedMerge: false });

    sh(worktree, "checkout", "-q", "--detach");
    expect((await worktreeState({ worktree, base: "main" })).branch).toBeNull();
  });

  it("reports the tree of HEAD, which a commit carried to another machine keeps", async () => {
    const repo = makeRepo();
    expect((await worktreeState({ worktree: repo, base: "main" })).tree).toBe(sh(repo, "rev-parse", "HEAD^{tree}"));
  });

  it("fails clearly when the base is missing", async () => {
    const repo = makeRepo();
    await expect(worktreeState({ worktree: repo, base: "origin/main" })).rejects.toThrow(/origin\/main/);
  });

  it("with trackedOnly, reports untracked files as clean and still reports modified tracked files", async () => {
    const repo = makeRepo();
    const worktree = addWorktree(repo, "loom/csv-3");
    put(worktree, "scratch.log", "junk");
    expect((await worktreeState({ worktree, base: "main" })).dirty).toBe(true);
    expect((await worktreeState({ worktree, base: "main", trackedOnly: true })).dirty).toBe(false);

    put(worktree, "README.md", "edited\n");
    expect((await worktreeState({ worktree, base: "main", trackedOnly: true })).dirty).toBe(true);
  });
});

describe("git", () => {
  it("returns stdout and fails with the error text", async () => {
    const repo = makeRepo();
    expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    await expect(git(repo, ["rev-parse", "--verify", "missing-ref"])).rejects.toThrow(/missing-ref/);
  });
});

describe("exec", () => {
  it("returns the exit code and the combined output", async () => {
    const ok = await exec({ cwd: scratch, command: "echo out; echo err 1>&2", timeoutMs: 5000 });
    expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
    expect(ok.output).toContain("out");
    expect(ok.output).toContain("err");
    const bad = await exec({ cwd: scratch, command: "echo broken; exit 3", timeoutMs: 5000 });
    expect(bad).toMatchObject({ exitCode: 3, timedOut: false });
    expect(bad.output).toContain("broken");
  });

  it("keeps the first 16 KB and the last 48 KB, and names the bytes left out", async () => {
    const big = await exec({ cwd: scratch, command: "head -c 20000 /dev/zero | tr '\\0' 'H'; head -c 148000 /dev/zero | tr '\\0' 'a'", timeoutMs: 10_000 });
    expect(big.output).toBe(`${"H".repeat(16384)}\n[… 102464 bytes left out …]\n${"a".repeat(49152)}`);
    const small = await exec({ cwd: scratch, command: "head -c 1000 /dev/zero | tr '\\0' 'b'", timeoutMs: 10_000 });
    expect(small.output).toBe("b".repeat(1000));
  });

  it("times out and kills the whole process group", async () => {
    const pidFile = join(scratch, "sleeper.pid");
    const started = Date.now();
    const result = await exec({ cwd: scratch, command: `sleep 60 & echo $! > ${pidFile}; wait`, timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kills the group when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = exec({ cwd: scratch, command: "sleep 60", timeoutMs: 60_000 }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("passes the given stdin to the command", async () => {
    const result = await exec({ cwd: scratch, command: "cat", timeoutMs: 5000, stdin: "the record\n" });
    expect(result).toMatchObject({ exitCode: 0, output: "the record\n" });
  });

  it("adds the given LOOM_ variables to the environment", async () => {
    const result = await exec({ cwd: scratch, command: 'echo "$LOOM_PROJECT_SLUG"', timeoutMs: 5000, env: { LOOM_PROJECT_SLUG: "paper-look" } });
    expect(result.output).toBe("paper-look\n");
  });

  it("passes when the command exits without reading a large stdin", async () => {
    const result = await exec({ cwd: scratch, command: "true", timeoutMs: 5000, stdin: "r".repeat(300_000) });
    expect(result.exitCode).toBe(0);
  });

  it("keeps stdin ignored without stdin, so checks behave as before", async () => {
    const command = "test -c /dev/stdin && echo ignored || echo piped";
    expect((await exec({ cwd: scratch, command, timeoutMs: 5000 })).output).toBe("ignored\n");
    expect((await exec({ cwd: scratch, command, timeoutMs: 5000, stdin: "" })).output).toBe("piped\n");
  });
});

// ---------------------------------------------------------------- review and merge

const commitFile = (repo: string, path: string, content: string, message = path) => {
  put(repo, path, content);
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", message);
  return sh(repo, "rev-parse", "HEAD");
};

/** A feature branch off main in its own worktree, with one commit. Returns the commit. */
function featureCommit(repo: string, branch: string, path: string, content: string): string {
  const worktree = addWorktree(repo, branch);
  return commitFile(worktree, path, content, `${branch}: ${path}`);
}

describe("diff", () => {
  it("returns the stat and the patch of head against the merge base, so moved base commits are left out", async () => {
    const repo = makeRepo();
    const head = featureCommit(repo, "loom/csv-1", "src/a.ts", "export const a = 1;\n");
    commitFile(repo, "other.txt", "main moved on");
    const result = await diff({ repo, base: "main", head, maxBytes: 100_000 });
    expect(result.stat).toContain("src/a.ts");
    expect(result.stat).not.toContain("other.txt");
    expect(result.patch).toContain("+export const a = 1;");
    expect(result.truncated).toBe(false);
  });

  it("clips the patch at maxBytes and says so", async () => {
    const repo = makeRepo();
    const head = featureCommit(repo, "loom/csv-1", "big.txt", `${"line of text\n".repeat(5000)}`);
    const result = await diff({ repo, base: "main", head, maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.patch.length).toBeLessThanOrEqual(1000);
    expect(result.stat).toContain("big.txt");
  });
});

describe("changedFiles and filePatch", () => {
  const okFiles = async (input: Parameters<typeof changedFiles>[0]) => {
    const result = await changedFiles(input);
    if (result.outcome !== "ok") throw new Error(result.message);
    return result;
  };

  it("lists each file with its status, line counts and blob, against the merge base when asked", async () => {
    const repo = makeRepo();
    commitFile(repo, "gone.txt", "bye\n");
    const worktree = addWorktree(repo, "feature-files");
    put(worktree, "src/new.ts", "export const a = 1;\nexport const b = 2;\n");
    put(worktree, "README.md", "hello there\n");
    put(worktree, "logo.png", Buffer.from([0, 1, 2, 3, 0, 255]).toString("latin1"));
    sh(worktree, "rm", "-q", "gone.txt");
    const head = commitFile(worktree, "src/new.ts", "export const a = 1;\nexport const b = 2;\n", "feature");
    commitFile(repo, "other.txt", "main moved on\n");

    const result = await okFiles({ repo, base: "main", head: "feature-files", mergeBase: true, maxFiles: 100 });
    expect(result.head).toBe(head);
    expect(result.base).toBe(sh(repo, "merge-base", "main", head));
    expect(result.truncated).toBe(false);
    expect(result.files.map((file) => [file.path, file.status, file.additions, file.deletions, file.binary])).toEqual([
      ["README.md", "modified", 1, 1, false],
      ["gone.txt", "deleted", 0, 1, false],
      ["logo.png", "added", 0, 0, true],
      ["src/new.ts", "added", 2, 0, false],
    ]);
    expect(result.files.find((file) => file.path === "src/new.ts")!.blob).toBe(sh(repo, "rev-parse", `${head}:src/new.ts`));
    expect(result.files.find((file) => file.path === "gone.txt")!.blob).toBeNull();

    const direct = await okFiles({ repo, base: "main", head, mergeBase: false, maxFiles: 100 });
    expect(direct.files.map((file) => file.path)).toContain("other.txt");
    expect((await okFiles({ repo, base: "main", head, mergeBase: true, maxFiles: 2 })).truncated).toBe(true);
  });

  it("with landed, compares a head main already merged with main as it was before that merge", async () => {
    const repo = makeRepo();
    const worktree = addWorktree(repo, "feature-landed");
    commitFile(worktree, "one.txt", "1\n");
    const head = commitFile(worktree, "two.txt", "2\n");
    commitFile(repo, "main.txt", "main\n");
    sh(repo, "merge", "-q", "--no-ff", "-m", "Merge feature", "feature-landed");
    commitFile(repo, "after.txt", "after\n");

    expect((await okFiles({ repo, base: "main", head, mergeBase: true, maxFiles: 100 })).files).toEqual([]);
    const landed = await okFiles({ repo, base: "main", head, mergeBase: true, landed: true, maxFiles: 100 });
    expect(landed.files.map((file) => file.path)).toEqual(["one.txt", "two.txt"]);
    // A head main has not merged is unaffected by landed.
    const open = featureCommit(repo, "feature-open", "three.txt", "3\n");
    expect((await okFiles({ repo, base: "main", head: open, mergeBase: true, landed: true, maxFiles: 100 })).files.map((file) => file.path)).toEqual(["three.txt"]);
  });

  it("says a commit or a ref is missing instead of throwing", async () => {
    const repo = makeRepo();
    const gone = "0123456789abcdef0123456789abcdef01234567";
    expect(await changedFiles({ repo, base: "main", head: gone, mergeBase: true, maxFiles: 10 })).toMatchObject({ outcome: "missing", message: expect.stringContaining(gone) });
    expect(await changedFiles({ repo, base: "origin/main", head: "main", mergeBase: true, maxFiles: 10 })).toMatchObject({ outcome: "missing", message: expect.stringContaining("origin/main") });
    const head = sh(repo, "rev-parse", "HEAD");
    expect(await filePatch({ repo, base: gone, head, path: "README.md", maxBytes: 1000 })).toMatchObject({ outcome: "missing" });
  });

  it("returns one file's patch with standard prefixes, whatever the user's diff settings, and clips it", async () => {
    const repo = makeRepo();
    sh(repo, "config", "diff.noprefix", "true");
    const base = sh(repo, "rev-parse", "HEAD");
    put(repo, "a.txt", "a\n");
    put(repo, "b.txt", "b\n");
    put(repo, "[b].txt", `${"line\n".repeat(1000)}`);
    const head = commitFile(repo, "README.md", "hello again\n");

    const one = await filePatch({ repo, base, head, path: "README.md", maxBytes: 10_000 });
    expect(one).toMatchObject({ outcome: "ok", truncated: false });
    if (one.outcome !== "ok") throw new Error("expected ok");
    expect(one.patch).toContain("diff --git a/README.md b/README.md");
    expect(one.patch).toContain("+hello again");
    expect(one.patch).not.toContain("a.txt");
    // The path is literal, not a glob that would also match b.txt.
    const literal = await filePatch({ repo, base, head, path: "[b].txt", maxBytes: 1000 });
    expect(literal).toMatchObject({ outcome: "ok", truncated: true });
    if (literal.outcome !== "ok") throw new Error("expected ok");
    expect(literal.patch.length).toBeLessThanOrEqual(1000);
    expect(literal.patch).toContain("a/[b].txt");
    expect(literal.patch).not.toContain("a/b.txt");
  });
});

describe("ensureWorktree", () => {
  const dataDir = () => join(scratch, "data");

  it("adds the worktree under dataDir/worktrees/<key> and reuses it", async () => {
    const repo = makeRepo();
    await ensureBranch({ repo, branch: "loom/csv", from: "main" });
    const first = await ensureWorktree({ repo, key: "csv", branch: "loom/csv" }, dataDir());
    expect(first).toEqual({ outcome: "ok", path: join(dataDir(), "worktrees", "csv") });
    expect(sh(join(dataDir(), "worktrees", "csv"), "symbolic-ref", "--short", "HEAD")).toBe("loom/csv");
    expect(await ensureWorktree({ repo, key: "csv", branch: "loom/csv" }, dataDir())).toEqual(first);
  });

  it("cleans a half-done merge and untracked files in an existing worktree", async () => {
    const repo = makeRepo();
    await ensureBranch({ repo, branch: "loom/clean", from: "main" });
    const ready = await ensureWorktree({ repo, key: "clean", branch: "loom/clean" }, dataDir());
    if (ready.outcome !== "ok") throw new Error("expected ok");
    commitFile(ready.path, "a.txt", "ours\n");
    const theirs = featureCommit(repo, "side", "a.txt", "theirs\n");
    expect(() => sh(ready.path, "merge", "--no-ff", "--no-edit", theirs)).toThrow();
    expect(existsSync(join(ready.path, ".git"))).toBe(true);
    put(ready.path, "scratch.txt", "junk");
    expect(sh(ready.path, "status", "--porcelain")).not.toBe("");

    const again = await ensureWorktree({ repo, key: "clean", branch: "loom/clean" }, dataDir());
    expect(again).toEqual(ready);
    expect(sh(ready.path, "status", "--porcelain")).toBe("");
    expect(() => sh(ready.path, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
  });

  it("recovers a worktree directory that was deleted but is still registered, through worktree prune", async () => {
    const repo = makeRepo();
    await ensureBranch({ repo, branch: "loom/gone", from: "main" });
    const first = await ensureWorktree({ repo, key: "gone", branch: "loom/gone" }, dataDir());
    if (first.outcome !== "ok") throw new Error("expected ok");
    rmSync(first.path, { recursive: true, force: true });
    expect(sh(repo, "worktree", "list")).toContain(first.path);
    expect(await ensureWorktree({ repo, key: "gone", branch: "loom/gone" }, dataDir())).toEqual(first);
    expect(existsSync(join(first.path, "README.md"))).toBe(true);
  });

  it("reports branch_checked_out when the branch is checked out in another worktree", async () => {
    const repo = makeRepo();
    sh(repo, "checkout", "-q", "-b", "loom/busy");
    const result = await ensureWorktree({ repo, key: "busy", branch: "loom/busy" }, dataDir());
    expect(result).toMatchObject({ outcome: "unavailable", reason: "branch_checked_out" });
  });

  it("refuses a worktree that is on another branch, and a missing branch", async () => {
    const repo = makeRepo();
    await ensureBranch({ repo, branch: "loom/other", from: "main" });
    const ready = await ensureWorktree({ repo, key: "other", branch: "loom/other" }, dataDir());
    if (ready.outcome !== "ok") throw new Error("expected ok");
    sh(ready.path, "checkout", "-q", "-b", "elsewhere");
    const result = await ensureWorktree({ repo, key: "other", branch: "loom/other" }, dataDir());
    expect(result).toMatchObject({ outcome: "unavailable", reason: "git" });
    expect(result.outcome === "unavailable" && result.message).toContain(`The Loom worktree at ${ready.path} is on elsewhere, not loom/other.`);

    expect(await ensureWorktree({ repo, key: "nobranch", branch: "loom/nope" }, dataDir())).toMatchObject({ outcome: "unavailable", reason: "git" });
  });

  it("refuses a worktree that is on another branch without discarding anything in it", async () => {
    const repo = makeRepo();
    await ensureBranch({ repo, branch: "loom/keep", from: "main" });
    const ready = await ensureWorktree({ repo, key: "keep", branch: "loom/keep" }, dataDir());
    if (ready.outcome !== "ok") throw new Error("expected ok");
    sh(ready.path, "checkout", "-q", "-b", "elsewhere");
    put(ready.path, "README.md", "human edit\n");
    put(ready.path, "notes.txt", "human notes\n");
    const status = sh(ready.path, "status", "--porcelain");

    expect(await ensureWorktree({ repo, key: "keep", branch: "loom/keep" }, dataDir())).toMatchObject({ outcome: "unavailable", reason: "git" });
    expect(readFileSync(join(ready.path, "README.md"), "utf8")).toBe("human edit\n");
    expect(readFileSync(join(ready.path, "notes.txt"), "utf8")).toBe("human notes\n");
    expect(sh(ready.path, "status", "--porcelain")).toBe(status);
    expect(sh(ready.path, "symbolic-ref", "--short", "HEAD")).toBe("elsewhere");
  });

  it("leaves a half-done merge alone in a worktree that is on another branch", async () => {
    const repo = makeRepo();
    await ensureBranch({ repo, branch: "loom/half", from: "main" });
    const ready = await ensureWorktree({ repo, key: "half", branch: "loom/half" }, dataDir());
    if (ready.outcome !== "ok") throw new Error("expected ok");
    sh(ready.path, "checkout", "-q", "-b", "elsewhere");
    commitFile(ready.path, "a.txt", "ours\n");
    const theirs = featureCommit(repo, "half-side", "a.txt", "theirs\n");
    expect(() => sh(ready.path, "merge", "--no-ff", "--no-edit", theirs)).toThrow();

    expect(await ensureWorktree({ repo, key: "half", branch: "loom/half" }, dataDir())).toMatchObject({ outcome: "unavailable", reason: "git" });
    expect(sh(ready.path, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toBe(theirs);
  });

  it("refuses a worktree that belongs to another repository without discarding anything in it", async () => {
    const owner = makeRepo();
    await ensureBranch({ repo: owner, branch: "loom/shared", from: "main" });
    const ready = await ensureWorktree({ repo: owner, key: "shared", branch: "loom/shared" }, dataDir());
    if (ready.outcome !== "ok") throw new Error("expected ok");
    put(ready.path, "README.md", "owner edit\n");
    put(ready.path, "notes.txt", "owner notes\n");

    const other = makeRepo();
    await ensureBranch({ repo: other, branch: "loom/shared", from: "main" });
    const result = await ensureWorktree({ repo: other, key: "shared", branch: "loom/shared" }, dataDir());
    expect(result).toMatchObject({ outcome: "unavailable", reason: "git" });
    expect(result.outcome === "unavailable" && result.message).toContain(owner);
    expect(readFileSync(join(ready.path, "README.md"), "utf8")).toBe("owner edit\n");
    expect(existsSync(join(ready.path, "notes.txt"))).toBe(true);
  });

  it("never cleans a directory that is not a worktree of its own", async () => {
    const repo = makeRepo();
    await ensureBranch({ repo, branch: "loom/stray", from: "main" });
    const stray = join(dataDir(), "worktrees", "stray");
    mkdirSync(stray, { recursive: true });
    put(stray, "keep.txt", "mine");
    const result = await ensureWorktree({ repo, key: "stray", branch: "loom/stray" }, dataDir());
    expect(result).toMatchObject({ outcome: "unavailable", reason: "git" });
    expect(existsSync(join(stray, "keep.txt"))).toBe(true);
  });
});

describe("merge and resetHard", () => {
  async function integration(name: string) {
    const repo = makeRepo();
    await ensureBranch({ repo, branch: `loom/${name}`, from: "main" });
    const ready = await ensureWorktree({ repo, key: name, branch: `loom/${name}` }, join(scratch, "data"));
    if (ready.outcome !== "ok") throw new Error("expected ok");
    return { repo, worktree: ready.path };
  }

  it("merges a commit with a merge commit that carries the message", async () => {
    const { repo, worktree } = await integration("m1");
    const feature = featureCommit(repo, "feature-1", "src/a.ts", "a\n");
    const before = sh(worktree, "rev-parse", "HEAD");
    const result = await merge({ worktree, ref: feature, message: "CSV-1: Order rows (Loom)" });
    expect(result).toEqual({ outcome: "merged", sha: sh(worktree, "rev-parse", "HEAD"), before, already: false });
    expect(sh(worktree, "log", "-1", "--format=%s")).toBe("CSV-1: Order rows (Loom)");
    expect(sh(worktree, "rev-parse", "HEAD^2")).toBe(feature);
    expect(existsSync(join(worktree, "src/a.ts"))).toBe(true);
  });

  it("lists the conflicting files and aborts the merge", async () => {
    const { repo, worktree } = await integration("m2");
    commitFile(worktree, "shared.txt", "ours\n");
    const feature = featureCommit(repo, "feature-2", "shared.txt", "theirs\n");
    const head = sh(worktree, "rev-parse", "HEAD");
    expect(await merge({ worktree, ref: feature, message: "CSV-2: x (Loom)" })).toEqual({ outcome: "conflict", files: ["shared.txt"] });
    expect(sh(worktree, "rev-parse", "HEAD")).toBe(head);
    expect(sh(worktree, "status", "--porcelain")).toBe("");
    expect(() => sh(worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
  });

  it("reports a merge the worktree's worker began and did not finish, even with nothing left to resolve", async () => {
    const repo = makeRepo();
    const worktree = addWorktree(repo, "worker-o");
    commitFile(worktree, "shared.txt", "ours\n");
    const theirs = featureCommit(repo, "theirs-o", "shared.txt", "theirs\n");
    expect(() => sh(worktree, "merge", "--no-edit", theirs)).toThrow();
    sh(worktree, "checkout", "--ours", "shared.txt");
    sh(worktree, "add", "shared.txt");
    expect(await worktreeState({ worktree, base: "main" })).toMatchObject({ dirty: false, unfinishedMerge: true });
    sh(worktree, "commit", "-q", "--no-edit");
    expect(await worktreeState({ worktree, base: "main" })).toMatchObject({ unfinishedMerge: false });
  });

  it("leaves a merge the worktree's worker began and did not finish as it is, with its resolution, and says so", async () => {
    const repo = makeRepo();
    const worktree = addWorktree(repo, "worker-m");
    commitFile(worktree, "shared.txt", "ours\n");
    const theirs = featureCommit(repo, "theirs-m", "shared.txt", "theirs\n");
    expect(() => sh(worktree, "merge", "--no-edit", theirs)).toThrow();
    put(worktree, "shared.txt", "ours and theirs\n");
    const head = sh(worktree, "rev-parse", "HEAD");
    const next = featureCommit(repo, "next-m", "other.txt", "next\n");
    expect(await merge({ worktree, ref: next, message: "Merge CSV-1's pull request into CSV-2 (Loom)" })).toEqual({ outcome: "unfinished" });
    expect(sh(worktree, "rev-parse", "MERGE_HEAD")).toBe(theirs);
    expect(sh(worktree, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(worktree, "shared.txt"), "utf8")).toBe("ours and theirs\n");
  });

  it("reports a second merge of the same sha as already merged, with the rollback point the caller persisted", async () => {
    const { repo, worktree } = await integration("m3");
    const feature = featureCommit(repo, "feature-3", "src/b.ts", "b\n");
    const first = await merge({ worktree, ref: feature, message: "CSV-3: b (Loom)" });
    if (first.outcome !== "merged") throw new Error("expected merged");
    const second = await merge({ worktree, ref: feature, message: "CSV-3: b (Loom)", before: first.before });
    expect(second).toEqual({ outcome: "merged", sha: first.sha, before: first.before, already: true });
    expect(sh(worktree, "rev-list", "--count", "HEAD")).toBe(sh(worktree, "rev-list", "--count", first.sha));
  });

  it("uses HEAD, never HEAD^1, as the rollback point of an already merged sha when none was persisted, even for a merge that is another ticket's", async () => {
    const { repo, worktree } = await integration("m3b");
    const feature = featureCommit(repo, "feature-3b", "src/b2.ts", "b\n");
    const first = await merge({ worktree, ref: feature, message: "CSV-1: done (Loom)" });
    if (first.outcome !== "merged") throw new Error("expected merged");
    expect(sh(worktree, "rev-parse", "HEAD^2")).toBe(feature);
    const second = await merge({ worktree, ref: feature, message: "CSV-2: different ticket (Loom)" });
    expect(second).toEqual({ outcome: "merged", sha: first.sha, before: first.sha, already: true });
  });

  it("reports the real HEAD as the rollback point of a merge it makes, whatever rollback point the caller passed", async () => {
    const { repo, worktree } = await integration("m3c");
    const feature = featureCommit(repo, "feature-3c", "src/b3.ts", "b\n");
    const head = sh(worktree, "rev-parse", "HEAD");
    const result = await merge({ worktree, ref: feature, message: "CSV-3: b (Loom)", before: sh(repo, "rev-parse", "main") });
    expect(result).toMatchObject({ outcome: "merged", before: head, already: false });
  });

  it("uses HEAD as the rollback point when the sha was already in the branch without a merge commit of its own", async () => {
    const { repo, worktree } = await integration("m4");
    const feature = featureCommit(repo, "feature-4", "src/c.ts", "c\n");
    sh(worktree, "merge", "--ff-only", feature);
    const result = await merge({ worktree, ref: feature, message: "x" });
    expect(result).toEqual({ outcome: "merged", sha: feature, before: feature, already: true });
  });

  it("resets the worktree hard to a commit", async () => {
    const { repo, worktree } = await integration("m5");
    const feature = featureCommit(repo, "feature-5", "src/d.ts", "d\n");
    const first = await merge({ worktree, ref: feature, message: "CSV-5: d (Loom)" });
    if (first.outcome !== "merged") throw new Error("expected merged");
    put(worktree, "src/d.ts", "dirty\n");
    expect(await resetHard({ worktree, sha: first.before })).toEqual({ sha: first.before });
    expect(sh(worktree, "rev-parse", "HEAD")).toBe(first.before);
    expect(existsSync(join(worktree, "src/d.ts"))).toBe(false);
    expect(sh(worktree, "status", "--porcelain")).toBe("");
  });
});

describe("push", () => {
  it("pushes the sha to refs/heads/<branch> on the remote", async () => {
    const repo = makeRepo();
    const remote = join(scratch, `remote-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    const head = commitFile(repo, "x.txt", "x");
    expect(await push({ repo, remote: "origin", src: head, branch: "loom/csv-1" })).toEqual({ outcome: "ok" });
    expect(execFileSync("git", ["-C", remote, "rev-parse", "refs/heads/loom/csv-1"], { encoding: "utf8" }).trim()).toBe(head);
  });

  it("is unavailable, with git's message, when the remote is missing", async () => {
    const repo = makeRepo();
    const result = await push({ repo, remote: "origin", src: "HEAD", branch: "loom/csv-1" });
    expect(result.outcome).toBe("unavailable");
    expect(result.outcome === "unavailable" && result.message).toMatch(/origin/);
  });
});

describe("a network op that cannot reach the remote", () => {
  const unreachable = () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://nowhere.invalid/acme/shop.git");
    return repo;
  };

  it("marks a push, a fetch of the pull request's tip and the push-only forge's read as worth waiting out", async () => {
    const repo = unreachable();
    const head = sh(repo, "rev-parse", "HEAD");
    expect(await push({ repo, remote: "origin", src: head, branch: "loom/x" })).toMatchObject({ outcome: "unavailable", transient: "network" });
    expect(await fetchTip({ repo, remote: "origin", branch: "loom/x", base: "main", ref: "refs/loom/csv/csv-1/tip" })).toMatchObject({ outcome: "unavailable", transient: "network" });
    expect(await prCommit({ repo, remote: "origin", branch: "loom/x", base: "main", head, message: "x" })).toMatchObject({ outcome: "unavailable", transient: "network" });
    expect(await landedOn({ repo, remote: "origin", base: "main", sha: head })).toMatchObject({ outcome: "unavailable", transient: "network" });
    expect(await stackBase({ repo, branch: "loom/csv/csv-1-stack", commits: [], base: { remote: "origin", branch: "main" }, message: "x" })).toMatchObject({ outcome: "unavailable", transient: "network" });
  });

  it("leaves a remote that does not exist, a refused push and a missing branch unmarked", async () => {
    const repo = makeRepo();
    const head = sh(repo, "rev-parse", "HEAD");
    expect(await push({ repo, remote: "nowhere", src: head, branch: "loom/x" })).not.toHaveProperty("transient");
    expect(await fetchTip({ repo, remote: "nowhere", branch: "loom/x", base: "main", ref: "refs/loom/csv/csv-1/tip" })).not.toHaveProperty("transient");
  });
});

describe("fetchBranch", () => {
  it("fetches the remote's branch tip in a worktree, without writing the repository's own FETCH_HEAD", async () => {
    const repo = makeRepo();
    const remote = join(scratch, `remote-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "push", "-q", "origin", "main");
    const worktree = addWorktree(repo, "loom/fetch");
    const clone = join(scratch, `clone-${counter++}`);
    execFileSync("git", ["clone", "-q", "-b", "main", remote, clone]);
    sh(clone, "config", "user.email", "dev@example.com");
    sh(clone, "config", "user.name", "Dev");
    const upstream = commitFile(clone, "up.txt", "up");
    sh(clone, "push", "-q", "origin", "HEAD:main");

    expect(await fetchBranch({ worktree, remote: "origin", branch: "main" })).toEqual({ outcome: "ok", sha: upstream });
    expect(existsSync(join(repo, ".git", "FETCH_HEAD"))).toBe(false);
  });

  it("is unavailable, with git's message, when the remote is missing", async () => {
    const repo = makeRepo();
    const result = await fetchBranch({ worktree: repo, remote: "origin", branch: "main" });
    expect(result.outcome).toBe("unavailable");
    expect(result.outcome === "unavailable" && result.message).toMatch(/^git fetch from origin failed/);
  });
});

describe("gh", () => {
  let bin: string;
  let savedPath: string | undefined;

  const fakeGh = (script: string) => {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ndir="${bin}"\nprintf '%s\\n' "$@" >> "$dir/args.txt"\nprintf -- '--\\n' >> "$dir/args.txt"\n${script}\n`);
    chmodSync(join(bin, "gh"), 0o755);
  };
  const calls = (): string[][] =>
    existsSync(join(bin, "args.txt"))
      ? readFileSync(join(bin, "args.txt"), "utf8")
          .split("--\n")
          .filter((chunk) => chunk !== "")
          .map((chunk) => chunk.trimEnd().split("\n"))
      : [];

  function repoWithRemote(url: string): string {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", url);
    return repo;
  }

  beforeAll(() => {
    savedPath = process.env.PATH;
  });
  beforeEach(() => {
    bin = join(scratch, `bin-${counter++}`);
    mkdirSync(bin);
    process.env.PATH = `${bin}:${savedPath}`;
  });
  afterAll(() => {
    process.env.PATH = savedPath;
  });

  it("parses https and ssh remote urls", () => {
    expect(parseRemoteUrl("https://github.com/acme/shop.git")).toBe("github.com/acme/shop");
    expect(parseRemoteUrl("https://github.example.com/acme/shop")).toBe("github.example.com/acme/shop");
    expect(parseRemoteUrl("git@github.com:acme/shop.git")).toBe("github.com/acme/shop");
    expect(parseRemoteUrl("ssh://git@github.com/acme/shop.git")).toBe("github.com/acme/shop");
    expect(parseRemoteUrl("/srv/git/shop.git")).toBeNull();
    expect(parseRemoteUrl("https://github.com/acme")).toBeNull();
  });

  it("creates the pull request with --repo from an https remote, the body on stdin, and returns the last stdout line", async () => {
    fakeGh(`cat > "$dir/stdin.txt"\necho "Creating pull request for loom/csv-1 into main" 1>&2\necho "https://github.com/acme/shop/pull/7"`);
    const repo = repoWithRemote("https://github.com/acme/shop.git");
    const result = await prCreate({ repo, remote: "origin", base: "main", head: "loom/csv-1", title: "CSV-1: Order rows", body: "Body line\n\nAcceptance:\n1. x", draft: true, forge: GH });
    expect(result).toEqual({ outcome: "ok", url: "https://github.com/acme/shop/pull/7" });
    expect(calls()).toEqual([["pr", "create", "--repo", "github.com/acme/shop", "--base", "main", "--head", "loom/csv-1", "--title", "CSV-1: Order rows", "--body-file", "-", "--draft"]]);
    expect(readFileSync(join(bin, "stdin.txt"), "utf8")).toBe("Body line\n\nAcceptance:\n1. x");
  });

  it("parses an ssh remote and leaves out --draft for a ready pull request", async () => {
    fakeGh(`cat > /dev/null\necho "https://github.com/acme/shop/pull/8"`);
    const repo = repoWithRemote("git@github.com:acme/shop.git");
    await prCreate({ repo, remote: "origin", base: "main", head: "loom/csv-2", title: "t", body: "", draft: false, forge: GH });
    expect(calls()[0]).toEqual(["pr", "create", "--repo", "github.com/acme/shop", "--base", "main", "--head", "loom/csv-2", "--title", "t", "--body-file", "-"]);
  });

  it("takes the repository from the push URL, which is where git push sends the branch", async () => {
    fakeGh(`cat > /dev/null\necho "https://github.com/fork/shop/pull/3"`);
    const repo = repoWithRemote("https://github.com/acme/shop.git");
    sh(repo, "remote", "set-url", "--push", "origin", "git@github.com:fork/shop.git");
    await prCreate({ repo, remote: "origin", base: "main", head: "loom/csv-3", title: "t", body: "", draft: true, forge: GH });
    expect(calls()[0]).toEqual(["pr", "create", "--repo", "github.com/fork/shop", "--base", "main", "--head", "loom/csv-3", "--title", "t", "--body-file", "-", "--draft"]);
  });

  it("is unavailable, without calling gh, when the remote pushes to more than one URL", async () => {
    fakeGh(`cat > /dev/null\necho "https://github.com/acme/shop/pull/4"`);
    const repo = repoWithRemote("https://github.com/acme/shop.git");
    sh(repo, "remote", "set-url", "--push", "origin", "git@github.com:acme/shop.git");
    sh(repo, "remote", "set-url", "--add", "--push", "origin", "git@github.com:fork/shop.git");
    const result = await prCreate({ repo, remote: "origin", base: "main", head: "loom/csv-4", title: "t", body: "", draft: true, forge: GH });
    expect(result).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/"origin".*2 push URLs/u) });
    expect(calls()).toEqual([]);
  });

  it("falls back to gh pr view when the pull request already exists", async () => {
    fakeGh(
      `case "$1 $2" in\n"pr create") cat > /dev/null; echo 'a pull request for branch "loom/csv-1" into branch "main" already exists:' 1>&2; echo "https://github.com/acme/shop/pull/7" 1>&2; exit 1;;\n"pr view") echo '{"url":"https://github.com/acme/shop/pull/7"}';;\nesac`,
    );
    const repo = repoWithRemote("https://github.com/acme/shop.git");
    const result = await prCreate({ repo, remote: "origin", base: "main", head: "loom/csv-1", title: "t", body: "b", draft: true, forge: GH });
    expect(result).toEqual({ outcome: "ok", url: "https://github.com/acme/shop/pull/7" });
    expect(calls()[1]).toEqual(["pr", "view", "loom/csv-1", "--repo", "github.com/acme/shop", "--json", "url"]);
  });

  it("is unavailable when the remote does not parse, the remote is missing, gh fails or gh is not installed", async () => {
    fakeGh(`cat > /dev/null\necho "https://github.com/x/y/pull/1"`);
    const local = repoWithRemote("/srv/git/shop.git");
    expect(await prCreate({ repo: local, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true, forge: GH })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("GitHub") });
    const bare = makeRepo();
    expect(await prCreate({ repo: bare, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true, forge: GH })).toMatchObject({ outcome: "unavailable" });
    expect(calls()).toEqual([]);

    fakeGh(`cat > /dev/null\necho "gh: not logged in" 1>&2\nexit 4`);
    const repo = repoWithRemote("https://github.com/acme/shop.git");
    const failed = await prCreate({ repo, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true, forge: GH });
    expect(failed).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("not logged in") });

    const gitOnly = join(scratch, `git-only-${counter++}`);
    mkdirSync(gitOnly);
    symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(gitOnly, "git"));
    process.env.PATH = gitOnly;
    const missing = await prCreate({ repo, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true, forge: GH });
    expect(missing).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("gh") });
  });

  it("reads the state of a pull request, and sets the prompt guards", async () => {
    fakeGh(`echo "$GH_PROMPT_DISABLED $GIT_TERMINAL_PROMPT" > "$dir/env.txt"\necho '{"state":"MERGED"}'`);
    const repo = makeRepo();
    expect(await prState({ repo, url: "https://github.com/acme/shop/pull/7", forge: GH })).toEqual({ outcome: "ok", state: "MERGED" });
    expect(calls()).toEqual([["pr", "view", "https://github.com/acme/shop/pull/7", "--json", "state"]]);
    expect(readFileSync(join(bin, "env.txt"), "utf8").trim()).toBe("1 0");

    fakeGh(`echo "no pull requests found" 1>&2\nexit 1`);
    expect(await prState({ repo, url: "https://github.com/acme/shop/pull/9", forge: GH })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("no pull requests found") });
    fakeGh(`echo '{"state":"WEIRD"}'`);
    expect(await prState({ repo, url: "https://github.com/acme/shop/pull/9", forge: GH })).toMatchObject({ outcome: "unavailable" });
  });

  it("marks gh pr view's server errors and rate limits as transient, and runs it once", async () => {
    const repo = makeRepo();
    fakeGh(`echo "HTTP 503: Service Unavailable (https://api.github.com/graphql)" 1>&2\nexit 1`);
    expect(await prState({ repo, url: "https://github.com/acme/shop/pull/7", forge: GH })).toEqual({ outcome: "unavailable", message: "gh pr view failed: HTTP 503: Service Unavailable (https://api.github.com/graphql)", transient: "server" });
    expect(calls()).toHaveLength(1);
    fakeGh(`echo "GraphQL: API rate limit exceeded for user ID 1234567." 1>&2\nexit 1`);
    expect(await prState({ repo, url: "https://github.com/acme/shop/pull/7", forge: GH })).toMatchObject({ outcome: "unavailable", transient: "rate_limit" });
    expect(calls()).toHaveLength(2);
    fakeGh(`echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" 1>&2\nexit 1`);
    expect(await prState({ repo, url: "https://github.com/acme/shop/pull/7", forge: GH })).not.toHaveProperty("transient");
  });

  it("marks gh pr view's failure to connect as a network failure, and runs it once", async () => {
    fakeGh(`printf '%s\\n' "error connecting to api.github.com" "check your internet connection or https://githubstatus.com" 1>&2\nexit 1`);
    expect(await prState({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", forge: GH })).toEqual({ outcome: "unavailable", message: `gh pr view failed: ${GH_OFFLINE}`, transient: "network" });
    expect(calls()).toHaveLength(1);
  });

  it("asks each reviewer for a review in its own REST call, the login in the JSON on stdin, and reports the ones GitHub refused", async () => {
    fakeGh(`body=$(cat)\necho "$body" >> "$dir/stdin.txt"\ncase "$body" in *carol*) echo "gh: Reviews may only be requested from collaborators. (HTTP 422)" 1>&2; exit 1;; esac`);
    const repo = makeRepo();
    const result = await prRequestReview({ repo, url: "https://github.example.com/acme/shop/pull/7", reviewers: ["alice", "carol"] });
    expect(result).toEqual({ outcome: "ok", requested: ["alice"], failed: [{ login: "carol", message: "gh: Reviews may only be requested from collaborators. (HTTP 422)" }] });
    const call = ["api", "--hostname", "github.example.com", "--method", "POST", "repos/acme/shop/pulls/7/requested_reviewers", "--input", "-", "--silent"];
    expect(calls()).toEqual([call, call]);
    expect(readFileSync(join(bin, "stdin.txt"), "utf8")).toBe('{"reviewers":["alice"]}\n{"reviewers":["carol"]}\n');

    expect(await prRequestReview({ repo, url: "https://review.example.com/shop/42", reviewers: ["alice"] })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("not a GitHub pull request URL") });
    expect(calls()).toHaveLength(2);
  });

  it("sets a pull request's title and description with gh pr edit, the body on stdin, and classifies a failure as a read's", async () => {
    fakeGh(`cat > "$dir/stdin.txt"\necho "https://github.com/acme/shop/pull/7"`);
    const input = { repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", title: "Add order rows", body: "Why\n\n<!-- loom:begin -->\nOpened by Loom for CSV-1.\n<!-- loom:end -->", forge: GH };
    expect(await prEdit(input)).toEqual({ outcome: "ok" });
    expect(calls()).toEqual([["pr", "edit", "https://github.com/acme/shop/pull/7", "--title", "Add order rows", "--body-file", "-"]]);
    expect(readFileSync(join(bin, "stdin.txt"), "utf8")).toBe(input.body);
    fakeGh(`echo "HTTP 502: Bad Gateway" 1>&2\nexit 1`);
    expect(await prEdit(input)).toEqual({ outcome: "unavailable", message: "gh pr edit failed: HTTP 502: Bad Gateway", transient: "server" });
    fakeGh(`echo "GraphQL: Resource not accessible by integration" 1>&2\nexit 1`);
    expect(await prEdit(input)).toEqual({ outcome: "unavailable", message: "gh pr edit failed: GraphQL: Resource not accessible by integration" });
  });

  it("replies in a review thread by the node id in its key and resolves it, and answers a review or a comment with a pull request comment", async () => {
    fakeGh(`case "$*" in *resolveReviewThread*) echo '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}';; *) echo '{"data":{"addPullRequestReviewThreadReply":{"comment":{"url":"https://github.example.com/acme/shop/pull/7#discussion_r9"}}}}';; esac`);
    const repo = makeRepo();
    const base = { repo, url: "https://github.example.com/acme/shop/pull/7", body: "Renamed it.", forge: GH };
    expect(await prReply({ ...base, key: "thread:PRRT_kwDO12:55:abc", kind: "thread", resolve: true })).toEqual({ outcome: "ok", url: "https://github.example.com/acme/shop/pull/7#discussion_r9", resolved: true });
    const [reply, resolve] = calls();
    expect(reply!.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.example.com"]);
    expect(reply).toContain("thread=PRRT_kwDO12");
    expect(reply).toContain("body=Renamed it.");
    expect(reply!.join("\n")).toContain("addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body })");
    expect(resolve!.join("\n")).toContain("resolveReviewThread(input: { threadId: $thread })");
    expect(await prReply({ ...base, key: "thread:PRRT_kwDO12:55:abc", kind: "thread", resolve: false })).toMatchObject({ resolved: false });
    expect(calls()).toHaveLength(3);
    expect(await prReply({ ...base, key: "thread:bad id:1:x", kind: "thread", resolve: false })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("names no review thread") });

    fakeGh(`cat > "$dir/stdin.txt"\necho "https://github.example.com/acme/shop/pull/7#issuecomment-3"`);
    expect(await prReply({ ...base, key: "review:1:abc", kind: "review", body: "> Rename the column.\n\nDone.", resolve: true })).toEqual({ outcome: "ok", url: "https://github.example.com/acme/shop/pull/7#issuecomment-3", resolved: false });
    expect(calls().at(-1)).toEqual(["pr", "comment", "https://github.example.com/acme/shop/pull/7", "--body-file", "-"]);
    expect(readFileSync(join(bin, "stdin.txt"), "utf8")).toBe("> Rename the column.\n\nDone.");
  });

  it("keeps a reply that went out when its thread does not resolve, and says why", async () => {
    fakeGh(`case "$*" in *resolveReviewThread*) echo "GraphQL: Resource not accessible by integration" 1>&2; exit 1;; *) echo '{"data":{"addPullRequestReviewThreadReply":{"comment":{"url":"https://github.com/acme/shop/pull/7#discussion_r9"}}}}';; esac`);
    const result = await prReply({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", key: "thread:PRRT_1:2:x", kind: "thread", body: "Done.", resolve: true, forge: GH });
    expect(result).toEqual({ outcome: "ok", url: "https://github.com/acme/shop/pull/7#discussion_r9", resolved: false, message: "gh api graphql failed: GraphQL: Resource not accessible by integration" });
  });
});

describe("ghTransient", () => {
  const failed = (stderr: string, stdout = "", code = 1) => ghTransient({ code, stdout, stderr });

  it.each([
    "gh: HTTP 500",
    "gh: HTTP 502",
    "gh: HTTP 503",
    "gh: HTTP 504",
    "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
    "gh: Server Error",
    "gh: Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug. Please include `C2D4:1F2A:3B4C5D:6E7F80:6720A1B2` when reporting this issue.",
    'Post "https://api.github.com/graphql": read tcp 192.168.1.20:52144->140.82.112.6:443: read: connection reset by peer',
    'Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: connect: connection refused',
    'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
    'Post "https://api.github.com/graphql": unexpected EOF',
    'Post "https://api.github.com/graphql": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
    "gh timed out after 2 minutes",
  ])("is a server error: %s", (stderr) => {
    expect(failed(`${stderr}\n`)).toEqual({ transient: "server" });
  });

  it("reads a server error from a JSON body when stderr has none", () => {
    expect(failed("", '{"message":"Server Error"}')).toEqual({ transient: "server" });
    expect(failed("", "<html><head><title>502 Bad Gateway</title></head></html>")).toEqual({ transient: "server" });
  });

  it.each([
    ["gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. If you reach out to GitHub Support for help, please include the request ID C2D4:1F2A:3B4C5D.", '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again.","documentation_url":"https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits"}'],
    ["gh: API rate limit exceeded for user ID 1234567.", '{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded for user ID 1234567."}]}'],
    ["HTTP 403: API rate limit exceeded for user ID 1234567. (https://api.github.com/repos/acme/shop/pulls/7)", ""],
    ["gh: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again. (HTTP 403)", ""],
    ["gh: HTTP 429: Too Many Requests", ""],
  ])("is a rate limit: %s", (stderr, stdout) => {
    expect(failed(`${stderr}\n`, stdout)).toEqual({ transient: "rate_limit" });
  });

  it("keeps the time GitHub names for a rate limit", () => {
    expect(failed("gh: HTTP 429: Too Many Requests\nRetry-After: 120\n")).toEqual({ transient: "rate_limit", retryAfterMs: 120_000 });
    expect(failed("gh: You have exceeded a secondary rate limit. Try again in 3 minutes.\n")).toEqual({ transient: "rate_limit", retryAfterMs: 180_000 });
    const reset = Math.floor(Date.now() / 1000) + 600;
    const wait = failed(`gh: API rate limit exceeded for user ID 1. x-ratelimit-reset: ${reset}\n`)?.retryAfterMs ?? 0;
    expect(wait).toBeGreaterThan(590_000);
    expect(wait).toBeLessThanOrEqual(600_000);
  });

  it.each([
    ["gh: HTTP 401: Bad credentials (https://api.github.com/graphql)", "", 1],
    ["To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.", "", 4],
    ["gh: Could not resolve to a PullRequest with the number of 9.", '{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a PullRequest with the number of 9."}]}', 1],
    ["gh: HTTP 404: Not Found (https://api.github.com/repos/acme/shop/pulls/9)", "", 1],
    ["gh: HTTP 403: Resource not accessible by integration", "", 1],
    ["gh: HTTP 501", "", 1],
    ["gh: HTTP 401: Bad credentials, which no timeout fixes", "", 1],
  ] as const)("is not transient: %s", (stderr, stdout, code) => {
    expect(failed(`${stderr}\n`, stdout, code)).toBeNull();
  });

  it.each([
    DT_OFFLINE,
    GH_OFFLINE,
    'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host',
    'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com on 192.168.1.1:53: read udp 192.168.1.20:61234->192.168.1.1:53: i/o timeout',
    'Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: connect: network is unreachable',
    'Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: connect: no route to host',
    'Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: connect: connection timed out',
    "curl: (6) Could not resolve host: delta.shopify.io",
    "getaddrinfo ENOTFOUND delta.shopify.io",
    "ssh: Could not resolve hostname github.com: Temporary failure in name resolution",
    "dial tcp: lookup delta.shopify.io: Name or service not known",
  ])("is a network failure: %s", (stderr) => {
    expect(failed(`${stderr}\n`)).toEqual({ transient: "network" });
  });

  it("is not a network failure for a missing login, an answer with a status, or a pull request's own text, whatever words they hold", () => {
    expect(failed(`${GH_OFFLINE}\n`, "", 4)).toBeNull();
    expect(failed("gh: HTTP 401: Bad credentials; check your internet connection\n")).toBeNull();
    expect(failed("gh: HTTP 404: Not Found (dns error)\n")).toBeNull();
    const body = JSON.stringify({ data: { repository: { pullRequest: { comments: { nodes: [{ body: "The deploy hit a dns error: could not resolve host" }] } } } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 9." }] });
    expect(failed("gh: Could not resolve to a PullRequest with the number of 9.\n", body)).toBeNull();
  });

  it("reads only the error fields of a JSON body, not the pull request text it carries", () => {
    const body = JSON.stringify({ data: { repository: { pullRequest: { comments: { nodes: [{ body: "CI failed with HTTP 502 and a rate limit, something went wrong" }] } } } }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
    expect(failed("gh: Resource not accessible by integration\n", body)).toBeNull();
  });

  it("reads a status a forge CLI prints at the start of a line, as Error: 429: or 503:", () => {
    expect(failed("Error: 429: other changes to shop/world's pull requests, reviews, checks or settings were still being saved after 30s, so nothing was changed; retry shortly\n")).toEqual({ transient: "rate_limit" });
    expect(failed("Error: 503: the service is restarting\n")).toEqual({ transient: "server" });
    expect(failed("503: upstream connect error or disconnect/reset before headers. reset reason: connection termination\n")).toEqual({ transient: "server" });
    expect(failed("Error: 404: no pull request 7 in shop/world\n")).toBeNull();
    expect(failed("Error: 401: run dt auth login\n")).toBeNull();
  });

  it("reads no status from a number inside a line, or inside a JSON line's pull request text", () => {
    expect(failed("Fix the 503: page the deploy shows\n")).toBeNull();
    const body = JSON.stringify({ message: "Not Found", data: { body: "503: upstream connect error\n429: retry shortly" } });
    expect(failed("gh: Not Found\n", body)).toBeNull();
  });

  it.each([
    ["fatal: unable to access 'https://github.com/acme/shop.git/': The requested URL returned error: 503", { transient: "server" }],
    ["error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nfatal: the remote end hung up unexpectedly", { transient: "server" }],
    ["fatal: the remote end hung up unexpectedly", { transient: "server" }],
    ["fatal: unable to access 'https://github.com/acme/shop.git/': Failed to connect to github.com port 443 after 75003 ms: Couldn't connect to server", { transient: "network" }],
    ["fatal: unable to access 'https://github.com/acme/shop.git/': Could not resolve host: github.com", { transient: "network" }],
    ["fatal: unable to access 'https://github.com/acme/shop.git/': The requested URL returned error: 403", null],
    [" ! [rejected]        loom/csv/csv-1 -> loom/csv/csv-1 (fetch first)\nerror: failed to push some refs to 'https://github.com/acme/shop.git'", null],
    ["remote: error: GH006: Protected branch update failed for refs/heads/main.", null],
  ] as const)("classifies git's network output by the same rules: %s", (stderr, expected) => {
    expect(ghTransient({ code: 128, stdout: "", stderr })).toEqual(expected);
  });
});

describe("host entry", () => {
  const harness = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir: join(tmpdir(), "loom-host-entry-data"), tempDir: tmpdir() } });

  it("lets bb send again only the quick local reads that change nothing, so a new method that writes, or a slow forge read, is not retried", () => {
    const retryable = Object.entries(hostContract as unknown as Record<string, { experimental_retryable?: boolean }>)
      .filter(([, method]) => method.experimental_retryable === true)
      .map(([name]) => name)
      .sort();
    expect(retryable).toEqual(["changedFiles", "diff", "filePatch", "remotes", "worktreeState"]);
  });

  it("serves the four operations through the contract", async () => {
    const repo = makeRepo();
    expect(await harness.experimental_call("ensureBranch", { repo, branch: "loom/x", from: "main" })).toMatchObject({ created: true });
    put(repo, "x.txt", "x");
    expect(await harness.experimental_call("commitAll", { worktree: repo, message: "x" })).toMatchObject({ committed: true });
    expect(await harness.experimental_call("worktreeState", { worktree: repo, base: "loom/x" })).toMatchObject({ dirty: false, changed: ["x.txt"] });
    expect(await harness.experimental_call("exec", { cwd: repo, command: "ls", timeoutMs: 5000 })).toMatchObject({ exitCode: 0, timedOut: false });
    expect(existsSync(join(repo, "x.txt"))).toBe(true);
  });

  it("serves the review and merge operations through the contract", async () => {
    const repo = makeRepo();
    const feature = featureCommit(repo, "feature-entry", "src/e.ts", "e\n");
    expect(await harness.experimental_call("diff", { repo, base: "main", head: feature, maxBytes: 10_000 })).toMatchObject({ truncated: false });
    expect(await harness.experimental_call("changedFiles", { repo, base: "main", head: feature, mergeBase: true, maxFiles: 10 })).toMatchObject({ outcome: "ok", files: [{ path: "src/e.ts", status: "added" }] });
    expect(await harness.experimental_call("filePatch", { repo, base: sh(repo, "rev-parse", "main"), head: feature, path: "src/e.ts", maxBytes: 10_000 })).toMatchObject({ outcome: "ok" });
    await harness.experimental_call("ensureBranch", { repo, branch: "loom/entry", from: "main" });
    const slug = `entry-${counter++}`;
    const ready = await harness.experimental_call("ensureWorktree", { repo, key: slug, branch: "loom/entry" });
    if (ready.outcome !== "ok") throw new Error("expected ok");
    expect(ready.path).toBe(join(tmpdir(), "loom-host-entry-data", "worktrees", slug));
    const merged = await harness.experimental_call("merge", { worktree: ready.path, ref: feature, message: "CSV-1: e (Loom)" });
    expect(merged).toMatchObject({ outcome: "merged", already: false });
    if (merged.outcome !== "merged") throw new Error("expected merged");
    expect(await harness.experimental_call("merge", { worktree: ready.path, ref: feature, message: "CSV-1: e (Loom)", before: merged.before })).toEqual({ ...merged, already: true });
    expect(await harness.experimental_call("resetHard", { worktree: ready.path, sha: merged.before })).toEqual({ sha: merged.before });
    sh(repo, "worktree", "remove", "--force", ready.path);
  });

  it("adds a repo's Loom worktree under the key <slug>.<name>, and refuses any looser key", async () => {
    const repo = makeRepo();
    await harness.experimental_call("ensureBranch", { repo, branch: "loom/multi", from: "main" });
    const key = `multi-${counter++}.web-app`;
    const ready = await harness.experimental_call("ensureWorktree", { repo, key, branch: "loom/multi" });
    expect(ready).toEqual({ outcome: "ok", path: join(tmpdir(), "loom-host-entry-data", "worktrees", key) });
    if (ready.outcome === "ok") sh(repo, "worktree", "remove", "--force", ready.path);

    for (const loose of ["multi.", ".web", "multi..web", "multi.web.api", "multi/web", "../multi", "multi.Web", "multi.9web", "multi.-web", `multi.${"w".repeat(25)}`, "m.web", "Multi.web"]) {
      await expect(harness.experimental_call("ensureWorktree", { repo, key: loose, branch: "loom/multi" }), loose).rejects.toThrow();
    }
  });

  it("refuses a relative path, an option-like ref and a timeout outside the range", async () => {
    await expect(harness.experimental_call("exec", { cwd: "relative", command: "ls", timeoutMs: 5000 })).rejects.toThrow();
    await expect(harness.experimental_call("exec", { cwd: scratch, command: "ls", timeoutMs: 10 })).rejects.toThrow();
    await expect(harness.experimental_call("ensureBranch", { repo: scratch, branch: "--force", from: "main" })).rejects.toThrow();
    await expect(harness.experimental_call("ensureBranch", { repo: scratch, branch: "a..b", from: "main" })).rejects.toThrow();
    await expect(harness.experimental_call("ensureBranch", { repo: scratch, branch: "a b", from: "main" })).rejects.toThrow();
    await expect(harness.experimental_call("fetchBranch", { worktree: scratch, remote: "--upload-pack=x", branch: "main" })).rejects.toThrow();
    for (const reviewers of [[], ["-alice"], ["al ice"], ["alice[bot]"]]) {
      await expect(harness.experimental_call("prRequestReview", { repo: scratch, url: "https://github.com/acme/shop/pull/7", reviewers }), JSON.stringify(reviewers)).rejects.toThrow();
    }
  });
});

describe("the spec's forge commands", () => {
  it("opens with the open command: the body on stdin, LOOM_* in the environment, the last URL it prints", async () => {
    const repo = makeRepo();
    const out = join(scratch, `open-${counter++}`);
    const open = `cat > "${out}.body"; printf '%s|%s|%s|%s|%s|%s' "$LOOM_REMOTE" "$LOOM_BASE" "$LOOM_HEAD" "$LOOM_TITLE" "$LOOM_DRAFT" "$PWD" > "${out}.env"; echo "created https://review.example.com/r/1"; echo "see https://review.example.com/r/42."`;
    const result = await prCreate({ repo, remote: "upstream", base: "main", head: "loom/csv-1", title: "CSV-1: Rows", body: "the body", draft: false, forge: { kind: "command", open } });
    expect(result).toEqual({ outcome: "ok", url: "https://review.example.com/r/42" });
    expect(readFileSync(`${out}.env`, "utf8")).toBe(`upstream|main|loom/csv-1|CSV-1: Rows|0|${repo}`);
    expect(readFileSync(`${out}.body`, "utf8")).toBe("the body");
  });

  it("is unavailable when the open command fails or prints no URL", async () => {
    const repo = makeRepo();
    const input = { repo, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true };
    expect(await prCreate({ ...input, forge: { kind: "command", open: "echo denied; exit 2" } })).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/open command failed \(exit 2\): denied/u) });
    expect(await prCreate({ ...input, forge: { kind: "command", open: "echo created" } })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("printed no pull request URL") });
  });

  it("marks an open command that printed a temporary error instead of a URL as one to wait out, and keeps its message", async () => {
    const repo = makeRepo();
    const input = { repo, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true };
    const busy = "Error: 429: other changes to shop/world's pull requests, reviews, checks or settings were still being saved after 30s, so nothing was changed; retry shortly";
    expect(await prCreate({ ...input, forge: { kind: "command", open: `echo "${busy}"` } })).toEqual({ outcome: "unavailable", message: `The forge's open command printed no pull request URL: ${busy}`, transient: "rate_limit" });
    expect(await prCreate({ ...input, forge: { kind: "command", open: `echo "${busy}" >&2; exit 1` } })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("open command failed (exit 1)"), transient: "rate_limit" });
    expect(await prCreate({ ...input, forge: { kind: "command", open: "echo 'Error: 503: upstream connect error'" } })).toMatchObject({ transient: "server" });
    expect(await prCreate({ ...input, forge: { kind: "command", open: "echo 'pr created'" } })).not.toHaveProperty("transient");
  });

  it("reads only the error fields of a JSON body longer than the message shows, never the pull request text in it", async () => {
    const repo = makeRepo();
    const input = { repo, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true };
    const body = join(scratch, `body-${counter++}.json`);
    writeFileSync(body, `${JSON.stringify({ number: 7, body: `${"x".repeat(3000)} the deploy got HTTP 503 from the edge ${"y".repeat(100)}` })}\n`);
    expect(await prCreate({ ...input, forge: { kind: "command", open: `cat "${body}"` } })).not.toHaveProperty("transient");
    expect(await prState({ repo, url: "https://review.example.com/r/7", forge: { kind: "command", state: `cat "${body}"; exit 1` } })).not.toHaveProperty("transient");
    writeFileSync(body, `${JSON.stringify({ message: "HTTP 503: upstream connect error", body: "z".repeat(3000) })}\n`);
    expect(await prCreate({ ...input, forge: { kind: "command", open: `cat "${body}"` } })).toMatchObject({ transient: "server" });
  });

  it("edits with the edit command and replies with the reply command: the text on stdin, LOOM_* in the environment", async () => {
    const repo = makeRepo();
    const out = join(scratch, `write-${counter++}`);
    const url = "https://review.example.com/r/42";
    const edit = `cat > "${out}.body"; printf '%s|%s|%s' "$LOOM_URL" "$LOOM_PR_NUMBER" "$LOOM_TITLE" > "${out}.env"`;
    expect(await prEdit({ repo, url, title: "Add rows", body: "the body", forge: { kind: "command", edit } })).toEqual({ outcome: "ok" });
    expect(readFileSync(`${out}.env`, "utf8")).toBe(`${url}|42|Add rows`);
    expect(readFileSync(`${out}.body`, "utf8")).toBe("the body");
    expect(await prEdit({ repo, url, title: "t", body: "", forge: { kind: "command", edit: "echo 'Error: 429: busy; retry shortly' >&2; exit 1" } })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("The forge's edit command failed (exit 1)"), transient: "rate_limit" });

    const reply = `cat > "${out}.reply"; printf '%s|%s|%s|%s|%s' "$LOOM_URL" "$LOOM_PR_NUMBER" "$LOOM_ITEM" "$LOOM_ITEM_KIND" "$LOOM_RESOLVE" > "${out}.renv"; echo "posted https://review.example.com/r/42#c7."`;
    expect(await prReply({ repo, url, key: "thread:9", kind: "thread", body: "Done.", resolve: true, forge: { kind: "command", reply } })).toEqual({ outcome: "ok", url: "https://review.example.com/r/42#c7", resolved: true });
    expect(readFileSync(`${out}.renv`, "utf8")).toBe(`${url}|42|thread:9|thread|1`);
    expect(readFileSync(`${out}.reply`, "utf8")).toBe("Done.");
    expect(await prReply({ repo, url, key: "comment:3", kind: "comment", body: "Done.", resolve: false, forge: { kind: "command", reply: "echo nope; exit 2" } })).toMatchObject({ outcome: "unavailable", message: "The forge's reply command failed (exit 2): nope" });
  });

  it("moves a pull request with the retarget command, LOOM_URL, LOOM_PR_NUMBER and LOOM_BASE set, and marks a failure that looks temporary", async () => {
    const repo = makeRepo();
    const out = join(scratch, `retarget-${counter++}`);
    const url = "https://review.example.com/r/42";
    const retarget = (command: string) => prRetarget({ repo, url, base: "main", forge: { kind: "command", retarget: command } });
    expect(await retarget(`printf '%s|%s|%s' "$LOOM_URL" "$LOOM_PR_NUMBER" "$LOOM_BASE" > "${out}"`)).toEqual({ outcome: "ok" });
    expect(readFileSync(out, "utf8")).toBe(`${url}|42|main`);
    expect(await retarget("echo 'Error: 503: upstream connect error' >&2; exit 1")).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("The forge's retarget command failed (exit 1)"), transient: "server" });
    expect(await retarget("echo 'no such pull request' >&2; exit 1")).not.toHaveProperty("transient");
  });

  it("gives the retarget command 5 minutes, as after_push gets, and waits out one that runs longer", async () => {
    const repo = makeRepo();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const moving = prRetarget({ repo, url: "https://review.example.com/r/42", base: "main", forge: { kind: "command", retarget: "sleep 600" } }).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await moving).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("The forge's retarget command took longer than 5 minutes"), transient: "server" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the first word of the state command's last line, in any case, with LOOM_URL and LOOM_PR_NUMBER set", async () => {
    const repo = makeRepo();
    const url = "https://review.example.com/r/42";
    const state = 'echo "warning: old cli"; [ "$LOOM_URL" = "https://review.example.com/r/42" ] && echo "Merged as $LOOM_PR_NUMBER"';
    expect(await prState({ repo, url, forge: { kind: "command", state } })).toEqual({ outcome: "ok", state: "MERGED" });
    expect(await prState({ repo, url, forge: { kind: "command", state: "echo open" } })).toEqual({ outcome: "ok", state: "OPEN" });
    expect(await prState({ repo, url, forge: { kind: "command", state: "echo pending" } })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining('printed "pending", not open, merged or closed') });
  });

  describe("a failed read", () => {
    const url = "https://delta.shopify.io/shop/world/pull/2313251";
    let runs: string;
    beforeEach(() => {
      runs = join(scratch, `runs-${counter++}`);
    });
    /** A command that notes each run, prints `output` on stderr and exits with `exit`. */
    const printing = (output: string, exit = 1) => {
      const file = join(scratch, `output-${counter++}`);
      writeFileSync(file, output);
      return `echo run >> "${runs}"; cat "${file}" >&2; exit ${exit}`;
    };
    const state = async (command: string) => prState({ repo: makeRepo(), url, forge: { kind: "command", state: command } });

    it("classifies a failed state command's output by gh's rules: a network failure, a server error or a rate limit waits, and the command runs once", async () => {
      expect(await state(printing(DT_OFFLINE))).toEqual({ outcome: "unavailable", message: `The forge's state command failed (exit 1): ${DT_OFFLINE}`, transient: "network" });
      expect(readFileSync(runs, "utf8")).toBe("run\n");
      const bad = "Error: GET https://delta.shopify.io/api/v3/repos/shop/world/pulls/1\n\nCaused by:\n    HTTP status server error (502 Bad Gateway) for url (https://delta.shopify.io/api/v3/repos/shop/world/pulls/1)";
      expect(await state(printing(bad))).toMatchObject({ outcome: "unavailable", transient: "server" });
      expect(await state(printing("Error: GET https://delta.shopify.io/api/v3/repos/shop/world/pulls/1\n\nCaused by:\n    429 Too Many Requests"))).toMatchObject({ outcome: "unavailable", transient: "rate_limit" });
      expect(readFileSync(runs, "utf8")).toBe("run\nrun\nrun\n");
    });

    it("pauses on a failed state command that is not worth waiting out, and on one that ran but printed no state", async () => {
      expect(await state(printing("Error: GET https://delta.shopify.io/api/v3/repos/shop/world/pulls/1\n\nCaused by:\n    HTTP status client error (404 Not Found) for url (https://delta.shopify.io/api/v3/repos/shop/world/pulls/1)"))).not.toHaveProperty("transient");
      expect(await state(printing("dt: you are not logged in; run dt auth login"))).not.toHaveProperty("transient");
      expect(await state(printing(DT_OFFLINE, 4))).not.toHaveProperty("transient");
      // A command that exits 0 after its CLI failed printed the wrong thing, which is its own bug, whatever the text says.
      expect(await state(printing(DT_OFFLINE, 0))).toEqual({ outcome: "unavailable", message: `The forge's state command printed "3: failed to lookup address information: nodename nor servname provided, or not known", not open, merged or closed.` });
    });

    it("classifies a failed feedback command the same way, and still pauses when it prints no JSON object or the wrong one", async () => {
      const feedback = async (command: string) => prFeedback({ repo: makeRepo(), url, forge: { kind: "command", feedback: command } });
      expect(await feedback(printing(DT_OFFLINE))).toEqual({ outcome: "unavailable", message: `The forge's feedback command failed (exit 1): ${DT_OFFLINE}`, transient: "network" });
      expect(readFileSync(runs, "utf8")).toBe("run\n");
      const notJson = await feedback(printing(DT_OFFLINE, 0));
      expect(notJson).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("must print a JSON object on its last line") });
      expect(notJson).not.toHaveProperty("transient");
      expect(await feedback(`echo '{"state":"open"}'`)).not.toHaveProperty("transient");
    });

    it("reads only the error fields of a JSON line in a failed command's output, not the pull request text it carries", async () => {
      const feedback = async (command: string) => prFeedback({ repo: makeRepo(), url, forge: { kind: "command", feedback: command } });
      const pull = JSON.stringify({ state: "open", head: "abc123", items: [{ id: 1, kind: "comment", author: "alice", body: "The deploy hit a dns error, could not resolve host" }] });
      expect(await feedback(`echo '${pull}'; exit 1`)).not.toHaveProperty("transient");
      expect(await feedback(`echo '{"message":"error connecting to delta.shopify.io"}'; exit 1`)).toMatchObject({ transient: "network" });
    });

    it("counts a state or feedback command that timed out as a failure worth waiting out", async () => {
      const repo = makeRepo();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const reading = prState({ repo, url, forge: { kind: "command", state: "sleep 30" } });
        const following = prFeedback({ repo, url, forge: { kind: "command", feedback: "echo 'HTTP 401: Bad credentials'; sleep 30" } });
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(await reading).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("The forge's state command took longer than 2 minutes"), transient: "server" });
        expect(await following).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("The forge's feedback command took longer than 2 minutes"), transient: "server" });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("remotes", () => {
  it("lists each remote with its push URLs, credentials left out", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://user:secret@example.com/acme/shop.git");
    sh(repo, "remote", "add", "forge", "https://forge.example.com/shop/store.git");
    sh(repo, "remote", "set-url", "--push", "forge", "git@forge.example.com:shop/store.git");
    expect(await remotes({ repo })).toEqual({
      remotes: [
        { name: "forge", pushUrls: ["git@forge.example.com:shop/store.git"] },
        { name: "origin", pushUrls: ["https://example.com/acme/shop.git"] },
      ],
    });
  });
});

describe("ghStatus", () => {
  let savedPath: string | undefined;
  beforeAll(() => {
    savedPath = process.env.PATH;
  });
  afterAll(() => {
    process.env.PATH = savedPath;
  });
  const pathWith = (script: string | null) => {
    const bin = join(scratch, `ghbin-${counter++}`);
    mkdirSync(bin);
    if (script === null) symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    else {
      writeFileSync(join(bin, "gh"), `#!/bin/sh\n${script}\n`);
      chmodSync(join(bin, "gh"), 0o755);
    }
    process.env.PATH = script === null ? bin : `${bin}:${savedPath}`;
  };

  it("asks gh about the host the push URL points at", async () => {
    pathWith('[ "$1 $2 $3 $4" = "auth status --hostname github.com" ] && exit 0; exit 1');
    const repo = makeRepo();
    expect(await ghStatus({ repo, pushUrl: "https://github.com/acme/shop.git" })).toEqual({ status: "ready", host: "github.com" });
    expect(await ghStatus({ repo, pushUrl: "git@forge.example.com:shop/store.git" })).toEqual({ status: "signed_out", host: "forge.example.com" });
    expect(await ghStatus({ repo, pushUrl: "/srv/git/shop.git" })).toEqual({ status: "not_a_url", host: null });
  });

  it("says gh is missing when it is not on PATH", async () => {
    const repo = makeRepo();
    pathWith(null);
    expect(await ghStatus({ repo, pushUrl: "https://github.com/acme/shop.git" })).toEqual({ status: "missing", host: "github.com" });
  });
});

describe("trialWorktree", () => {
  const dataDir = () => join(scratch, "trial-data");

  it("adds a worktree with no checkout and removes it again", async () => {
    const repo = makeRepo();
    expect(await trialWorktree({ repo }, dataDir())).toEqual({ outcome: "ok" });
    expect(sh(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("is refused with git's message when git cannot add one", async () => {
    const repo = makeRepo(false);
    const result = await trialWorktree({ repo }, dataDir());
    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.message).toMatch(/HEAD/u);
  });
});

describe("landedOn", () => {
  it("says whether the remote's base branch contains the commit, writing no FETCH_HEAD", async () => {
    const repo = makeRepo();
    const remote = join(scratch, `remote-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "push", "-q", "origin", "main");
    const head = commitFile(repo, "x.txt", "x");
    expect(await landedOn({ repo, remote: "origin", base: "main", sha: head })).toEqual({ outcome: "ok", landed: false });
    sh(repo, "push", "-q", "origin", "HEAD:main");
    expect(await landedOn({ repo, remote: "origin", base: "main", sha: head })).toEqual({ outcome: "ok", landed: true });
    expect(existsSync(join(repo, ".git", "FETCH_HEAD"))).toBe(false);
  });

  it("is unavailable when the remote has no such branch", async () => {
    const repo = makeRepo();
    const remote = join(scratch, `remote-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    expect(await landedOn({ repo, remote: "origin", base: "main", sha: sh(repo, "rev-parse", "HEAD") })).toEqual({ outcome: "unavailable", message: 'The remote "origin" has no branch main.' });
  });
});

describe("behindBase", () => {
  const setup = () => {
    const repo = makeRepo();
    const remote = join(scratch, `remote-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "push", "-q", "origin", "main");
    const pushed = sh(repo, "rev-parse", "HEAD");
    // Another clone moves the remote's main on by three commits, which this checkout has not fetched.
    const other = join(scratch, `clone-${counter++}`);
    execFileSync("git", ["clone", "-q", "-b", "main", remote, other]);
    sh(other, "config", "user.email", "dev@example.com");
    sh(other, "config", "user.name", "Dev");
    for (const n of [1, 2, 3]) commitFile(other, `base${n}.txt`, `${n}\n`);
    sh(other, "push", "-q", "origin", "main");
    return { repo, pushed, tip: sh(other, "rev-parse", "HEAD") };
  };

  it("fetches the base branch into its remote-tracking ref and counts the commits each commit lacks", async () => {
    const { repo, pushed, tip } = setup();
    expect(await behindBase({ repo, remote: "origin", base: "main", fetch: true, shas: [pushed, tip] })).toEqual({ outcome: "ok", tip, behind: [{ sha: pushed, commits: 3 }, { sha: tip, commits: 0 }] });
    expect(sh(repo, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
    expect(existsSync(join(repo, ".git", "FETCH_HEAD"))).toBe(false);
  });

  it("counts on the ref as it is without fetch, and counts a commit the repository lacks as null", async () => {
    const { repo, pushed, tip } = setup();
    sh(repo, "update-ref", "refs/remotes/origin/main", pushed);
    const unknown = "0123456789abcdef0123456789abcdef01234567";
    expect(await behindBase({ repo, remote: "origin", base: "main", fetch: false, shas: [pushed, unknown] })).toEqual({ outcome: "ok", tip: pushed, behind: [{ sha: pushed, commits: 0 }, { sha: unknown, commits: null }] });
    expect(sh(repo, "rev-parse", "refs/remotes/origin/main")).not.toBe(tip);
  });

  it("is unavailable when there is nothing to count against, and when the fetch fails", async () => {
    const repo = makeRepo();
    const head = sh(repo, "rev-parse", "HEAD");
    expect(await behindBase({ repo, remote: "origin", base: "main", fetch: false, shas: [head] })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("has no origin/main to count against") });
    sh(repo, "remote", "add", "origin", join(scratch, "no-such-remote.git"));
    expect(await behindBase({ repo, remote: "origin", base: "main", fetch: true, shas: [head] })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("git fetch from origin") });
  });
});

describe("remoteBranch", () => {
  it("reads a branch's tip where git push sends it, and null once the branch is gone, without fetching it", async () => {
    const repo = makeRepo();
    const remote = join(scratch, `remote-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "push", "-q", "origin", "main:loom/csv/csv-1");
    const head = sh(repo, "rev-parse", "HEAD");
    expect(await remoteBranch({ repo, remote: "origin", branch: "loom/csv/csv-1" })).toEqual({ outcome: "ok", sha: head });
    sh(repo, "push", "-q", "origin", ":loom/csv/csv-1");
    expect(await remoteBranch({ repo, remote: "origin", branch: "loom/csv/csv-1" })).toEqual({ outcome: "ok", sha: null });
    expect(await remoteBranch({ repo, remote: "nowhere", branch: "main" })).toMatchObject({ outcome: "unavailable", message: 'The git remote "nowhere" does not exist in ' + repo + "." });
  });
});

describe("ensureWorktree with a prepared path", () => {
  const dataDir = () => join(scratch, "prepared-data");

  it("uses the path as it is and switches a clean checkout to the integration branch", async () => {
    const repo = makeRepo();
    await ensureBranch({ repo, branch: "loom/prep", from: "main" });
    const path = addWorktree(repo, "tree-branch");
    expect(await ensureWorktree({ repo, key: "prep", branch: "loom/prep", path }, dataDir())).toEqual({ outcome: "ok", path });
    expect(sh(path, "symbolic-ref", "--short", "HEAD")).toBe("loom/prep");
  });

  it("refuses one with uncommitted changes, one that does not exist, and one of another repository", async () => {
    const repo = makeRepo();
    await ensureBranch({ repo, branch: "loom/prep2", from: "main" });
    const dirty = addWorktree(repo, "tree-dirty");
    put(dirty, "README.md", "changed\n");
    expect(await ensureWorktree({ repo, key: "prep", branch: "loom/prep2", path: dirty }, dataDir())).toMatchObject({ outcome: "unavailable", reason: "git", message: expect.stringContaining("with uncommitted changes") });
    expect(await ensureWorktree({ repo, key: "prep", branch: "loom/prep2", path: join(scratch, "nowhere") }, dataDir())).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("which does not exist") });
    const other = makeRepo();
    expect(await ensureWorktree({ repo, key: "prep", branch: "loom/prep2", path: other }, dataDir())).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("belongs to the repository") });
  });
});

describe("host entry: discovery and the push-only forge", () => {
  const harness = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir: join(tmpdir(), "loom-host-entry-data"), tempDir: tmpdir() } });

  it("serves remotes and trialWorktree through the contract", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://example.com/acme/shop.git");
    expect(await harness.experimental_call("remotes", { repo })).toEqual({ remotes: [{ name: "origin", pushUrls: ["https://example.com/acme/shop.git"] }] });
    expect(await harness.experimental_call("trialWorktree", { repo })).toEqual({ outcome: "ok" });
  });
});

describe("stackBase", () => {
  // Two pull request branches off main, each with its own file; `shared` makes them both change one file.
  const setup = (shared = false) => {
    const repo = makeRepo();
    const remote = join(scratch, `remote-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "push", "-q", "origin", "main");
    sh(repo, "checkout", "-q", "-b", "one", "main");
    const one = commitFile(repo, shared ? "README.md" : "one.txt", "one\n");
    sh(repo, "checkout", "-q", "-b", "two", "main");
    const two = commitFile(repo, shared ? "README.md" : "two.txt", "two\n");
    sh(repo, "checkout", "-q", "main");
    return { repo, remote, one, two };
  };
  const input = (repo: string, commits: string[], base = false) => ({ repo, branch: "loom/csv/csv-3-stack", commits, ...(base ? { base: { remote: "origin", branch: "main" } } : {}), message: "Loom: CSV-1 and CSV-2 for CSV-3" });

  it("points the branch at the one commit given, with no new commit", async () => {
    const { repo, one } = setup();
    expect(await stackBase(input(repo, [one]))).toEqual({ outcome: "ok", sha: one, tip: null, tree: sh(repo, "rev-parse", `${one}^{tree}`) });
    expect(sh(repo, "rev-parse", "loom/csv/csv-3-stack")).toBe(one);
  });

  it("merges two pull request commits into one commit with both as parents, touching no worktree", async () => {
    const { repo, one, two } = setup();
    const built = (await stackBase(input(repo, [one, two]))) as { outcome: "ok"; sha: string };
    expect(built.outcome).toBe("ok");
    expect(sh(repo, "log", "-1", "--format=%P", built.sha).split(" ")).toEqual([one, two]);
    expect(sh(repo, "ls-tree", "--name-only", built.sha).split("\n").sort()).toEqual(["README.md", "one.txt", "two.txt"]);
    expect(sh(repo, "log", "-1", "--format=%s", built.sha)).toBe("Loom: CSV-1 and CSV-2 for CSV-3");
    expect(sh(repo, "status", "--porcelain")).toBe("");
  });

  it("fetches the base branch's tip and leaves out a commit another one already contains", async () => {
    const { repo, remote, one } = setup();
    // The base branch moved on the remote to a commit that contains `one`, as when its pull request merged.
    sh(repo, "push", "-q", remote, `${one}:refs/heads/main`);
    const built = await stackBase(input(repo, [one], true));
    expect(built).toEqual({ outcome: "ok", sha: one, tip: one, tree: sh(repo, "rev-parse", `${one}^{tree}`) });
    expect(sh(repo, "rev-parse", "refs/remotes/origin/main")).toBe(one);
  });

  it("reports the files two commits conflict in and moves no branch", async () => {
    const { repo, one, two } = setup(true);
    expect(await stackBase(input(repo, [one, two]))).toEqual({ outcome: "conflict", files: ["README.md"] });
    expect(sh(repo, "branch", "--list", "loom/csv/csv-3-stack")).toBe("");
  });

  it("refuses to move a branch a worktree has checked out", async () => {
    const { repo, one, two } = setup();
    sh(repo, "branch", "loom/csv/csv-3-stack", one);
    sh(repo, "worktree", "add", "-q", join(scratch, `wt-${counter++}`), "loom/csv/csv-3-stack");
    const built = await stackBase(input(repo, [one, two]));
    expect(built).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("is checked out in a worktree") });
    expect(sh(repo, "rev-parse", "loom/csv/csv-3-stack")).toBe(one);
  });
});

describe("mergeOnto", () => {
  const REFS = ["refs/heads/loom/csv/csv-2-home", "refs/loom/csv/csv-2/reviewed"];
  // A ticket's head on one dependency commit, and the dependency's next commit; `clash` makes both change the same line.
  const setup = (clash = false) => {
    const repo = makeRepo();
    sh(repo, "checkout", "-q", "-b", "dep", "main");
    const dep = commitFile(repo, "dep.txt", "dep\n");
    sh(repo, "checkout", "-q", "-b", "work", dep);
    const head = commitFile(repo, clash ? "dep.txt" : "mine.txt", "mine\n");
    sh(repo, "checkout", "-q", "dep");
    const next = commitFile(repo, "dep.txt", "dep, fixed\n");
    sh(repo, "checkout", "-q", "main");
    return { repo, dep, head, next };
  };
  const input = (repo: string, head: string, ref: string) => ({ repo, head, ref, message: "Merge CSV-1's pull request into CSV-2 (Loom)", refs: REFS });

  it("merges with merge-tree into a commit whose parents are the head and the new commit, touching no worktree, and points the refs at it", async () => {
    const { repo, head, next } = setup();
    const merged = await mergeOnto(input(repo, head, next));
    expect(merged).toEqual({ outcome: "merged", sha: expect.stringMatching(/^[0-9a-f]{40}$/u), tree: expect.stringMatching(/^[0-9a-f]{40}$/u), already: false });
    const { sha, tree } = merged as { sha: string; tree: string };
    expect(sh(repo, "log", "-1", "--format=%P", sha).split(" ")).toEqual([head, next]);
    expect(sh(repo, "rev-parse", `${sha}^{tree}`)).toBe(tree);
    expect(sh(repo, "show", `${sha}:dep.txt`)).toBe("dep, fixed");
    for (const ref of REFS) expect(sh(repo, "rev-parse", ref)).toBe(sha);
    expect(sh(repo, "status", "--porcelain")).toBe("");
  });

  it("reports a commit the head already has as merged, and moves no ref", async () => {
    const { repo, dep, head } = setup();
    expect(await mergeOnto(input(repo, head, dep))).toEqual({ outcome: "merged", sha: head, tree: sh(repo, "rev-parse", `${head}^{tree}`), already: true });
    expect(sh(repo, "for-each-ref", "refs/loom")).toBe("");
  });

  it("commits a conflict as the tree with conflict markers, on both parents, and names the files", async () => {
    const { repo, head, next } = setup(true);
    const conflicted = await mergeOnto(input(repo, head, next));
    expect(conflicted).toMatchObject({ outcome: "conflict", files: ["dep.txt"] });
    const { sha } = conflicted as { sha: string };
    expect(sh(repo, "log", "-1", "--format=%P", sha).split(" ")).toEqual([head, next]);
    expect(sh(repo, "show", `${sha}:dep.txt`)).toMatch(/^<<<<<<< .*\nmine\n=======\ndep, fixed\n>>>>>>> /u);
    for (const ref of REFS) expect(sh(repo, "rev-parse", ref)).toBe(sha);
  });

  // A head rebuilt from another machine's worktree shares no history with the pull request branch: Loom's push of it is a
  // sibling with the same tree, and someone else's commit on the branch edits a line the ticket wrote.
  const rebuilt = () => {
    const repo = makeRepo();
    const base = sh(repo, "rev-parse", "main");
    sh(repo, "checkout", "-q", "-b", "home", base);
    const head = commitFile(repo, "mine.txt", "one\ntwo\nthree\n");
    const pushed = sh(repo, "commit-tree", `${head}^{tree}`, "-p", base, "-m", "CSV-1: Order rows");
    sh(repo, "checkout", "-q", "-b", "pr", pushed);
    put(repo, "theirs.txt", "theirs\n");
    const theirs = commitFile(repo, "mine.txt", "one\nTWO\nthree\n", "Reviewer: capitals");
    sh(repo, "checkout", "-q", "main");
    return { repo, head, pushed, theirs };
  };

  it("merges against the base it is given, the commit Loom last pushed, so an edit of the ticket's own lines merges cleanly", async () => {
    const { repo, head, pushed, theirs } = rebuilt();
    expect(await mergeOnto({ ...input(repo, head, theirs), refs: [] })).toMatchObject({ outcome: "conflict", files: ["mine.txt"] });
    const merged = await mergeOnto({ ...input(repo, head, theirs), refs: [], base: pushed });
    expect(merged).toMatchObject({ outcome: "merged", already: false });
    const { sha, tree } = merged as { sha: string; tree: string };
    expect(tree).toBe(sh(repo, "rev-parse", `${theirs}^{tree}`));
    expect(sh(repo, "log", "-1", "--format=%P", sha).split(" ")).toEqual([head, theirs]);
  });

  it("ignores a base that is not on the merged commit's history, as after a force push", async () => {
    const { repo, head, theirs } = rebuilt();
    const unrelated = commitFile(repo, "other.txt", "other\n");
    expect(await mergeOnto({ ...input(repo, head, theirs), refs: [], base: unrelated })).toMatchObject({ outcome: "conflict", files: ["mine.txt"] });
  });
});

describe("a checkout in a subdirectory of its repository, as a bb project in a monorepo is", () => {
  const harness = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir: join(tmpdir(), "loom-host-entry-data"), tempDir: tmpdir() } });
  // As LANE-17 had: the project is areas/infra/routing/nrm, and the ticket and the commit it takes both change a file outside it.
  const monorepo = () => {
    const repo = makeRepo();
    put(repo, "areas/infra/routing/nrm/routes.conf", "routes\n");
    const base = commitFile(repo, "clients/admin-web/app.ts", "base\n");
    sh(repo, "checkout", "-q", "-b", "work", base);
    const head = commitFile(repo, "clients/admin-web/app.ts", "mine\n");
    sh(repo, "checkout", "-q", "-b", "other", base);
    const theirs = commitFile(repo, "clients/admin-web/app.ts", "theirs\n");
    sh(repo, "checkout", "-q", "main");
    return { repo, checkout: join(repo, "areas/infra/routing/nrm"), head, theirs };
  };

  it("names mergeOnto's conflicts from the repository's top level, where the carry puts them, and conflictMarkers takes them", async () => {
    const { repo, checkout, head, theirs } = monorepo();
    const merged = await mergeOnto({ repo: checkout, head, ref: theirs, message: "Merge (Loom)", refs: [] });
    expect(merged).toMatchObject({ outcome: "conflict", files: ["clients/admin-web/app.ts"] });
    const exported = await exportChanges({ worktree: checkout, base: head, head: (merged as { sha: string }).sha });
    expect(exported.changes.map((change) => change.path)).toEqual(["clients/admin-web/app.ts"]);

    sh(repo, "checkout", "-q", "--detach", (merged as { sha: string }).sha);
    expect(await harness.experimental_call("conflictMarkers", { worktree: repo, paths: (merged as { files: string[] }).files })).toEqual({ files: ["clients/admin-web/app.ts"] });
  });

  it("names stackBase's conflicts from the top level too", async () => {
    const { checkout, head, theirs } = monorepo();
    expect(await stackBase({ repo: checkout, branch: "loom/csv/csv-2-stack", commits: [head, theirs], message: "Loom: stack" })).toEqual({ outcome: "conflict", files: ["clients/admin-web/app.ts"] });
  });

  it("shows the patch of a file changedFiles lists outside the checkout's directory", async () => {
    const { checkout, head } = monorepo();
    const listed = await changedFiles({ repo: checkout, base: "main", head, mergeBase: true, maxFiles: 10 });
    expect(listed).toMatchObject({ outcome: "ok", files: [{ path: "clients/admin-web/app.ts" }] });
    const base = (listed as { base: string }).base;
    const patch = await filePatch({ repo: checkout, base, head, path: "clients/admin-web/app.ts", maxBytes: 10_000 });
    expect(patch).toMatchObject({ outcome: "ok", patch: expect.stringContaining("+mine") });
  });

  it("lists a worktree's untracked files from the top level, inside the checkout's directory and out of it", async () => {
    const { repo, checkout } = monorepo();
    put(repo, "areas/infra/routing/nrm/new.conf", "new\n");
    put(repo, "clients/admin-web/new.ts", "new\n");
    expect((await worktreeState({ worktree: checkout, base: "main" })).changed).toEqual(["areas/infra/routing/nrm/new.conf", "clients/admin-web/new.ts"]);
  });
});

describe("fetchTip and pointRefs", () => {
  const setup = () => {
    const repo = makeRepo();
    const remote = join(scratch, `remote-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "push", "-q", "origin", "main");
    const clone = join(scratch, `clone-${counter++}`);
    execFileSync("git", ["clone", "-q", "-b", "main", remote, clone]);
    sh(clone, "config", "user.email", "other@example.com");
    sh(clone, "config", "user.name", "Other");
    return { repo, remote, clone };
  };
  const input = (repo: string) => ({ repo, remote: "origin", branch: "loom/csv-1", base: "main", ref: "refs/loom/csv/csv-1/tip" });

  it("fetches the branch's tip onto the ref and the base branch into its tracking ref, and names the newest base commit the tip has", async () => {
    const { repo, clone } = setup();
    sh(clone, "checkout", "-q", "-b", "loom/csv-1");
    commitFile(clone, "a.txt", "a\n");
    sh(clone, "checkout", "-q", "main");
    const newer = commitFile(clone, "main.txt", "main\n");
    sh(clone, "push", "-q", "origin", "main");
    sh(clone, "checkout", "-q", "loom/csv-1");
    sh(clone, "merge", "-q", "--no-edit", "main");
    const tip = sh(clone, "rev-parse", "HEAD");
    sh(clone, "push", "-q", "origin", "loom/csv-1");

    const read = await fetchTip(input(repo));
    expect(read).toEqual({ outcome: "ok", sha: tip, tree: sh(clone, "rev-parse", "HEAD^{tree}"), mainBase: newer });
    expect(sh(repo, "rev-parse", "refs/loom/csv/csv-1/tip")).toBe(tip);
    expect(sh(repo, "rev-parse", "refs/remotes/origin/main")).toBe(newer);
    expect(existsSync(join(repo, ".git", "FETCH_HEAD"))).toBe(false);

    await pointRefs({ repo, sha: newer, refs: ["refs/heads/loom/csv/csv-1-home", "refs/loom/csv/csv-1/reviewed"] });
    expect(sh(repo, "rev-parse", "loom/csv/csv-1-home")).toBe(newer);
    expect(sh(repo, "rev-parse", "refs/loom/csv/csv-1/reviewed")).toBe(newer);
  });

  it("reports a branch that is not on the remote as missing, and a remote it cannot read as unavailable", async () => {
    const { repo } = setup();
    expect(await fetchTip(input(repo))).toEqual({ outcome: "missing" });
    expect(await fetchTip({ ...input(repo), remote: "nowhere" })).toMatchObject({ outcome: "unavailable", message: 'The git remote "nowhere" does not exist in ' + repo + "." });
  });
});

describe("prCommit", () => {
  const setup = () => {
    const repo = makeRepo();
    const remote = join(scratch, `remote-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "push", "-q", "origin", "main");
    const base = sh(repo, "rev-parse", "main");
    sh(repo, "checkout", "-q", "-b", "work");
    commitFile(repo, "a.txt", "a", "WIP one");
    const head = commitFile(repo, "b.txt", "b", "WIP two");
    return { repo, remote, base, head };
  };
  const tree = (repo: string, ref: string) => sh(repo, "rev-parse", `${ref}^{tree}`);
  const parents = (repo: string, sha: string) => sh(repo, "log", "-1", "--format=%P", sha).split(" ").filter((part) => part !== "");
  const input = (repo: string, head: string, more: { message?: string; pushed?: string } = {}) => ({ repo, remote: "origin", branch: "loom/csv-1", base: "origin/main", head, message: more.message ?? "Add a and b\n\nTwo files.", ...(more.pushed === undefined ? {} : { pushed: more.pushed }) });

  it("builds one commit with head's files on its merge base when the branch is not on the remote yet, with the message as given", async () => {
    const { repo, base, head } = setup();
    const built = await prCommit(input(repo, head));
    expect(built).toMatchObject({ outcome: "ok", created: true });
    const sha = (built as { sha: string }).sha;
    expect(tree(repo, sha)).toBe(tree(repo, head));
    expect(parents(repo, sha)).toEqual([base]);
    expect(sh(repo, "log", "-1", "--format=%B", sha)).toBe("Add a and b\n\nTwo files.");
  });

  it("adds one commit on the remote tip for a fix round, and reports nothing new when the tip already has head's files", async () => {
    const { repo, head } = setup();
    const first = (await prCommit(input(repo, head))) as { sha: string };
    await push({ repo, remote: "origin", src: first.sha, branch: "loom/csv-1" });
    const fixed = commitFile(repo, "c.txt", "c", "WIP fix");
    const fix = await prCommit(input(repo, fixed, { message: "Fix c", pushed: first.sha }));
    expect(fix).toMatchObject({ outcome: "ok", created: true });
    const sha = (fix as { sha: string }).sha;
    expect(parents(repo, sha)).toEqual([first.sha]);
    expect(tree(repo, sha)).toBe(tree(repo, fixed));
    await push({ repo, remote: "origin", src: sha, branch: "loom/csv-1" });
    expect(await prCommit(input(repo, fixed, { pushed: sha }))).toEqual({ outcome: "ok", sha, created: false });
  });

  it("adds a commit that takes the base when merging it left head's tree as the tip's, so the branch is no longer behind", async () => {
    const { repo, remote, head } = setup();
    const first = (await prCommit(input(repo, head))) as { sha: string };
    await push({ repo, remote: "origin", src: first.sha, branch: "loom/csv-1" });
    // The base gets an edit and its revert: two commits that leave its files as they were.
    const other = join(scratch, `clone-${counter++}`);
    execFileSync("git", ["clone", "-q", "-b", "main", remote, other]);
    sh(other, "config", "user.email", "other@example.com");
    sh(other, "config", "user.name", "Other");
    commitFile(other, "README.md", "changed\n", "Edit the readme");
    sh(other, "revert", "--no-edit", "HEAD");
    sh(other, "push", "-q", "origin", "main");
    sh(repo, "fetch", "-q", "origin");
    const tipOfBase = sh(repo, "rev-parse", "origin/main");
    sh(repo, "merge", "-q", "--no-edit", "origin/main");
    const merged = sh(repo, "rev-parse", "HEAD");
    expect(tree(repo, merged)).toBe(tree(repo, first.sha));
    expect(await behindBase({ repo, remote: "origin", base: "main", fetch: false, shas: [first.sha] })).toMatchObject({ behind: [{ sha: first.sha, commits: 2 }] });

    const refreshed = (await prCommit(input(repo, merged, { message: "CSV-1: merge origin/main (Loom)", pushed: first.sha }))) as { sha: string; created: boolean };
    expect(refreshed.created).toBe(true);
    expect(parents(repo, refreshed.sha)).toEqual([first.sha, tipOfBase]);
    expect(tree(repo, refreshed.sha)).toBe(tree(repo, first.sha));
    await push({ repo, remote: "origin", src: refreshed.sha, branch: "loom/csv-1" });
    expect(await behindBase({ repo, remote: "origin", base: "main", fetch: false, shas: [refreshed.sha] })).toMatchObject({ behind: [{ sha: refreshed.sha, commits: 0 }] });
    expect(await prCommit(input(repo, merged, { pushed: refreshed.sha }))).toEqual({ outcome: "ok", sha: refreshed.sha, created: false });
  });

  it("reports the branch as diverged when it has commits that neither Loom pushed nor head contains", async () => {
    const { repo, remote, head } = setup();
    const first = (await prCommit(input(repo, head))) as { sha: string };
    await push({ repo, remote: "origin", src: first.sha, branch: "loom/csv-1" });
    const clone = join(scratch, `clone-${counter++}`);
    execFileSync("git", ["clone", "-q", "-b", "loom/csv-1", remote, clone]);
    sh(clone, "config", "user.email", "other@example.com");
    sh(clone, "config", "user.name", "Other");
    const theirs = commitFile(clone, "theirs.txt", "t");
    sh(clone, "push", "-q", "origin", "HEAD:loom/csv-1");
    const fixed = commitFile(repo, "c.txt", "c");
    expect(await prCommit(input(repo, fixed, { pushed: first.sha }))).toEqual({ outcome: "diverged", tip: theirs });

    sh(repo, "fetch", "-q", "origin", "loom/csv-1");
    sh(repo, "merge", "-q", "--no-edit", "FETCH_HEAD");
    const merged = sh(repo, "rev-parse", "HEAD");
    const fix = (await prCommit(input(repo, merged, { pushed: first.sha }))) as { sha: string; created: boolean };
    expect(fix.created).toBe(true);
    expect(parents(repo, fix.sha)).toEqual([theirs]);
  });

  it("adds the newer base as a second parent when head merged it, so the pull request's diff stays the ticket's own", async () => {
    const { repo, head } = setup();
    const first = (await prCommit(input(repo, head))) as { sha: string };
    await push({ repo, remote: "origin", src: first.sha, branch: "loom/csv-1" });
    sh(repo, "checkout", "-q", "main");
    const newer = commitFile(repo, "main.txt", "m");
    sh(repo, "push", "-q", "origin", "main");
    sh(repo, "checkout", "-q", "work");
    sh(repo, "merge", "-q", "--no-edit", "origin/main");
    const merged = sh(repo, "rev-parse", "HEAD");
    const fix = (await prCommit(input(repo, merged, { pushed: first.sha }))) as { sha: string };
    expect(parents(repo, fix.sha)).toEqual([first.sha, newer]);
    expect(tree(repo, fix.sha)).toBe(tree(repo, merged));
  });

  it("reads the branch where the remote pushes, when it fetches from somewhere else", async () => {
    const { repo, head } = setup();
    const fork = join(scratch, `fork-${counter++}.git`);
    execFileSync("git", ["init", "-q", "--bare", fork]);
    sh(repo, "remote", "set-url", "--push", "origin", fork);
    const first = (await prCommit(input(repo, head))) as { sha: string };
    await push({ repo, remote: "origin", src: first.sha, branch: "loom/csv-1" });
    const fixed = commitFile(repo, "c.txt", "c");
    const fix = (await prCommit(input(repo, fixed, { pushed: first.sha }))) as { sha: string };
    expect(parents(repo, fix.sha)).toEqual([first.sha]);
  });

  it("is unavailable, with git's message, when the remote cannot be read", async () => {
    const repo = makeRepo();
    const result = await prCommit(input(repo, "HEAD"));
    expect(result.outcome).toBe("unavailable");
  });
});

describe("prFeedback", () => {
  const FEEDBACK = (command: string) => ({ kind: "command" as const, feedback: command });

  it("reads a forge command's feedback from the JSON object on its last line, with LOOM_URL and LOOM_PR_NUMBER", async () => {
    const repo = makeRepo();
    const json = JSON.stringify({ state: "open", head: "abc123", author: "me", checks: [{ id: 7, name: "ci", state: "failed", url: "https://ci.example.com/7" }], items: [{ id: "r1", kind: "review", author: "alice", body: "Rename it.", state: "changes_requested" }, { id: 9, kind: "thread", author: "bob", body: "Why?", path: "src/a.ts", line: 3 }] });
    const result = await prFeedback({ repo, url: "https://review.example.com/shop/42", forge: FEEDBACK(`echo "warming up" >&2; test "$LOOM_PR_NUMBER" = 42 && echo '${json}'`) });
    expect(result).toEqual({
      outcome: "ok",
      state: "OPEN",
      head: "abc123",
      author: "me",
      draft: null,
      review: null,
      base: null,
      title: null,
      body: null,
      mergeable: null,
      checks: [{ key: "check:7", name: "ci", state: "failed", url: "https://ci.example.com/7", started: null, startedAt: null, completedAt: null, progress: null, steps: null }],
      items: [
        { key: "review:r1", kind: "review", author: "alice", bot: false, body: "Rename it.", url: null, state: "changes_requested", path: null, line: null },
        { key: "thread:9", kind: "thread", author: "bob", bot: false, body: "Why?", url: null, state: null, path: "src/a.ts", line: 3 },
      ],
    });
  });

  it("reads a command forge's title and description when it prints them, and keeps the mark at the end of a long reply Loom posted", async () => {
    const reply = `${"x".repeat(2500)}\n\nPosted by Loom\n${REPLY_MARK}`;
    const json = JSON.stringify({ state: "open", head: "abc123", title: "Add rows", body: "Why\n<!-- loom:begin -->\nx\n<!-- loom:end -->", items: [{ id: 9, kind: "thread", author: "", body: reply }, { id: 10, kind: "comment", author: "", body: "y".repeat(2500) }] });
    const file = join(scratch, `feedback-${counter++}.json`);
    writeFileSync(file, json);
    const result = await prFeedback({ repo: makeRepo(), url: "https://review.example.com/shop/42", forge: FEEDBACK(`cat "${file}"`) });
    const ok = result as Extract<typeof result, { outcome: "ok" }>;
    expect(ok).toMatchObject({ title: "Add rows", body: "Why\n<!-- loom:begin -->\nx\n<!-- loom:end -->" });
    expect(ok.items[0]!.body.length).toBe(2000);
    expect(ok.items[0]!.body.endsWith(`…\n${REPLY_MARK}`)).toBe(true);
    expect(ok.items[1]!.body).toBe(`${"y".repeat(1999)}…`);
  });

  it("reads whether a command forge's check started, when, and how far it got", async () => {
    const json = JSON.stringify({
      state: "open",
      head: "abc123",
      checks: [
        { id: "a", name: "build", state: "pending", started: true, started_at: "2026-10-24T10:00:00Z", progress: 80 },
        { id: "b", name: "deploy", state: "pending", started: false },
        { id: "c", name: "lint", state: "passed", started_at: "2026-10-24T10:00:00+00:00", completed_at: "2026-10-24T10:02:30Z" },
      ],
    });
    const result = await prFeedback({ repo: makeRepo(), url: "https://review.example.com/shop/42", forge: FEEDBACK(`echo '${json}'`) });
    const ok = result as Extract<typeof result, { outcome: "ok" }>;
    const at = Date.parse("2026-10-24T10:00:00Z");
    expect(ok.checks).toEqual([
      { key: "check:a", name: "build", state: "pending", url: null, started: true, startedAt: at, completedAt: null, progress: 80, steps: null },
      { key: "check:b", name: "deploy", state: "pending", url: null, started: false, startedAt: null, completedAt: null, progress: null, steps: null },
      { key: "check:c", name: "lint", state: "passed", url: null, started: null, startedAt: at, completedAt: at + 150_000, progress: null, steps: null },
    ]);
    const bad = await prFeedback({ repo: makeRepo(), url: "https://review.example.com/shop/42", forge: FEEDBACK(`echo '{"state":"open","head":"a","checks":[{"id":1,"name":"x","state":"pending","progress":150}]}'`) });
    expect(bad).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("checks.0.progress") });
  });

  it("reads the draft flag, the review decision in any case, the base branch and whether it is mergeable as a forge command prints them", async () => {
    const repo = makeRepo();
    const url = "https://review.example.com/shop/42";
    const json = JSON.stringify({ state: "merged", head: "abc123", draft: true, review: "Changes_Requested", base: "loom/x/csv-1", mergeable: false });
    expect(await prFeedback({ repo, url, forge: FEEDBACK(`echo '${json}'`) })).toMatchObject({ outcome: "ok", state: "MERGED", draft: true, review: "CHANGES_REQUESTED", base: "loom/x/csv-1", mergeable: false });
    const nulls = JSON.stringify({ state: "open", head: "abc123", draft: null, review: null, base: null, mergeable: null });
    expect(await prFeedback({ repo, url, forge: FEEDBACK(`echo '${nulls}'`) })).toMatchObject({ outcome: "ok", draft: null, review: null, base: null, mergeable: null });
    const word = JSON.stringify({ state: "open", head: "abc123", mergeable: "yes" });
    expect(await prFeedback({ repo, url, forge: FEEDBACK(`echo '${word}'`) })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("mergeable:") });
    const bad = await prFeedback({ repo, url, forge: FEEDBACK(`echo '{"state":"open","head":"a","review":"lgtm"}'`) });
    expect(bad).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("review:") });
  });

  it("is unavailable, naming the problem, when the command's last line is not that object or the command fails", async () => {
    const repo = makeRepo();
    const url = "https://review.example.com/shop/42";
    const bad = await prFeedback({ repo, url, forge: FEEDBACK(`echo '{"state":"open"}'`) });
    expect(bad).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("must print a JSON object on its last line; head:") });
    expect(await prFeedback({ repo, url, forge: FEEDBACK("exit 3") })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("feedback command failed (exit 3)") });
  });

  describe("through gh", () => {
    let bin: string;
    let savedPath: string | undefined;
    beforeAll(() => {
      savedPath = process.env.PATH;
    });
    beforeEach(() => {
      bin = join(scratch, `bin-${counter++}`);
      mkdirSync(bin);
      process.env.PATH = `${bin}:${savedPath}`;
    });
    afterAll(() => {
      process.env.PATH = savedPath;
    });
    // The main query answers with `json`; the steps query (nodes by id) answers with `steps`, or fails as GitHub's 502 does.
    const fakeGh = (json: unknown, steps: unknown = { data: { nodes: [] } }) => {
      writeFileSync(join(bin, "response.json"), JSON.stringify(json));
      writeFileSync(join(bin, "steps.json"), JSON.stringify(steps));
      const answerSteps = steps === "fail" ? `echo "gh: HTTP 502" >&2; exit 1` : `cat "${bin}/steps.json"`;
      writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${bin}/args.txt"\nprintf -- '--\\n' >> "${bin}/args.txt"\ncase "$*" in *"nodes(ids:"*) ${answerSteps};; *) cat "${bin}/response.json";; esac\n`);
      chmodSync(join(bin, "gh"), 0o755);
    };
    const calls = (): string[][] =>
      existsSync(join(bin, "args.txt"))
        ? readFileSync(join(bin, "args.txt"), "utf8")
            .split("--\n")
            .filter((chunk) => chunk !== "")
            .map((chunk) => chunk.trimEnd().split("\n"))
        : [];
    // The query is the last argument, and args.txt has one line per line of it.
    const queryOf = (call: string[]) => call.slice(call.findIndex((arg) => arg.startsWith("query="))).join("\n");
    const pullWith = (contexts: Array<Record<string, unknown>>) => ({
      data: { repository: { pullRequest: { state: "OPEN", headRefOid: "f00d", author: user("me"), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] } } } },
    });
    const run = (id: number, status: string, conclusion: string | null = null) => ({ __typename: "CheckRun", id: `CR_${id}`, databaseId: id, name: `job-${id}`, status, conclusion, detailsUrl: null, startedAt: "2026-10-24T10:00:00Z", completedAt: null });
    const user = (login: string) => ({ __typename: "User", login });
    const bot = (login: string) => ({ __typename: "Bot", login });

    it("asks GitHub's GraphQL API for the pull request in the URL and maps its checks, reviews, unresolved threads and comments", async () => {
      fakeGh({
        data: {
          repository: {
            pullRequest: {
              state: "OPEN",
              headRefOid: "f00d",
              author: user("me"),
              commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
                { __typename: "CheckRun", id: "CR_11", databaseId: 11, name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/11", startedAt: "2026-10-24T10:00:00Z", completedAt: "2026-10-24T10:01:00Z" },
                { __typename: "CheckRun", id: "CR_12", databaseId: 12, name: "deploy", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: null },
                { __typename: "CheckRun", id: "CR_13", databaseId: 13, name: "test", status: "IN_PROGRESS", conclusion: null, detailsUrl: null, startedAt: "2026-10-24T10:00:00Z", completedAt: null },
                { __typename: "StatusContext", context: "reviews", state: "PENDING", targetUrl: null },
                { __typename: "CheckRun", id: "CR_14", databaseId: 14, name: "e2e", status: "QUEUED", conclusion: null, detailsUrl: null, startedAt: null, completedAt: null },
              ] } } } }] },
              reviews: { nodes: [{ databaseId: 21, author: user("alice"), state: "CHANGES_REQUESTED", body: "Please rename.", url: "https://gh/r21" }] },
              reviewThreads: { nodes: [
                { id: "T1", isResolved: false, path: "a.ts", line: 4, comments: { nodes: [{ databaseId: 31, author: bot("binks"), body: "Unanchored regex.", url: "https://gh/c31" }, { databaseId: 32, author: user("me"), body: "Will fix.", url: "https://gh/c32" }] } },
                { id: "T2", isResolved: true, path: "b.ts", line: 1, comments: { nodes: [{ databaseId: 33, author: user("alice"), body: "Done.", url: "https://gh/c33" }] } },
              ] },
              comments: { nodes: [{ databaseId: 41, author: bot("terraform-actuator"), body: "Plan: 1 to change.", url: "https://gh/c41" }] },
            },
          },
        },
      }, { data: { nodes: [{ id: "CR_13", steps: { totalCount: 4, nodes: [{ status: "COMPLETED" }, { status: "COMPLETED" }, { status: "IN_PROGRESS" }, { status: "QUEUED" }] } }] } });
      const result = await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/76810", forge: GH });
      const [args, stepsCall] = calls() as [string[], string[]];
      expect(args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.com"]);
      expect(args).toEqual(expect.arrayContaining(["owner=acme", "name=shop", "number=76810"]));
      expect(result).toMatchObject({ outcome: "ok", state: "OPEN", head: "f00d", author: "me" });
      const ok = result as Extract<typeof result, { outcome: "ok" }>;
      expect(ok.checks.map((check) => [check.key, check.state])).toEqual([
        ["check:11", "failed"],
        ["check:12", "neutral"],
        ["check:13", "pending"],
        ["status:reviews:PENDING:f00d", "pending"],
        ["check:14", "pending"],
      ]);
      const at = Date.parse("2026-10-24T10:00:00Z");
      expect(ok.checks.map(({ started, startedAt, completedAt, steps }) => ({ started, startedAt, completedAt, steps }))).toEqual([
        { started: true, startedAt: at, completedAt: at + 60_000, steps: null },
        { started: true, startedAt: null, completedAt: null, steps: null },
        { started: true, startedAt: at, completedAt: null, steps: { done: 2, total: 4 } },
        { started: null, startedAt: null, completedAt: null, steps: null },
        { started: false, startedAt: null, completedAt: null, steps: null },
      ]);
      expect(queryOf(args)).toContain("... on CheckRun { id databaseId name status conclusion detailsUrl startedAt completedAt }");
      expect(queryOf(args)).not.toContain("steps");
      expect(stepsCall.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.com"]);
      expect(queryOf(stepsCall)).toBe('query=query { nodes(ids: ["CR_13"]) { ... on CheckRun { id steps(first: 100) { totalCount nodes { status } } } } }');
      expect(calls()).toHaveLength(2);
      expect(ok.items.map((item) => [item.kind, item.author, item.bot])).toEqual([
        ["review", "alice", false],
        ["thread", "me", false],
        ["comment", "terraform-actuator", true],
      ]);
      expect(ok.items[1]).toMatchObject({ key: expect.stringMatching(/^thread:T1:32:[0-9a-f]{12}$/u), path: "a.ts", line: 4, body: "binks: Unanchored regex.\n\nme: Will fix." });
    });

    it("asks for steps only while a check failed and runs are in progress, and for at most 20 runs", async () => {
      const running = Array.from({ length: 25 }, (_, index) => run(100 + index, "IN_PROGRESS"));
      fakeGh(pullWith([...running, run(1, "QUEUED")]));
      expect(await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", forge: GH })).toMatchObject({ outcome: "ok" });
      expect(calls()).toHaveLength(1);

      fakeGh(pullWith([run(2, "COMPLETED", "FAILURE"), run(3, "COMPLETED", "SUCCESS"), run(1, "QUEUED")]));
      await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", forge: GH });
      expect(calls()).toHaveLength(2);

      fakeGh(pullWith([run(2, "COMPLETED", "FAILURE"), run(1, "QUEUED"), ...running]));
      await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", forge: GH });
      expect(calls()).toHaveLength(4);
      const ids = JSON.parse(/nodes\(ids: (\[[^\]]*\])\)/u.exec(queryOf(calls()[3]!))![1]!) as string[];
      expect(ids).toEqual(running.slice(0, 20).map((node) => node.id));
    });

    it("returns the feedback without steps when the steps query fails, and asks it only once", async () => {
      fakeGh(pullWith([run(2, "COMPLETED", "FAILURE"), run(5, "IN_PROGRESS")]), "fail");
      const result = await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", forge: GH });
      expect(result).toMatchObject({ outcome: "ok", checks: [{ key: "check:2", state: "failed", steps: null }, { key: "check:5", state: "pending", started: true, steps: null }] });
      expect(calls()).toHaveLength(2);
    });

    it("marks a GitHub server error or rate limit as transient, and asks once", async () => {
      writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf -- '--\\n' >> "${bin}/args.txt"\necho "gh: HTTP 502" >&2\nexit 1\n`);
      chmodSync(join(bin, "gh"), 0o755);
      expect(await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", forge: GH })).toEqual({ outcome: "unavailable", message: "gh api graphql failed: gh: HTTP 502", transient: "server" });
      expect(readFileSync(join(bin, "args.txt"), "utf8")).toBe("--\n");

      const limited = '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again.","documentation_url":"https://docs.github.com/rest/overview/rate-limits-for-the-rest-api"}';
      writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf -- '--\\n' >> "${bin}/args.txt"\necho '${limited}'\necho "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again." >&2\nexit 1\n`);
      expect(await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", forge: GH })).toMatchObject({ outcome: "unavailable", transient: "rate_limit" });
      expect(readFileSync(join(bin, "args.txt"), "utf8")).toBe("--\n--\n");

      writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "gh: Could not resolve to a PullRequest with the number of 7." >&2\nexit 1\n`);
      expect(await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", forge: GH })).toEqual({ outcome: "unavailable", message: "gh api graphql failed: gh: Could not resolve to a PullRequest with the number of 7." });
    });

    it("marks gh's failure to connect as a network failure, and asks once", async () => {
      writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf -- '--\\n' >> "${bin}/args.txt"\nprintf '%s\\n' "error connecting to api.github.com" "check your internet connection or https://githubstatus.com" >&2\nexit 1\n`);
      chmodSync(join(bin, "gh"), 0o755);
      expect(await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/7", forge: GH })).toEqual({ outcome: "unavailable", message: `gh api graphql failed: ${GH_OFFLINE}`, transient: "network" });
      expect(readFileSync(join(bin, "args.txt"), "utf8")).toBe("--\n");
    });

    it("is unavailable for a URL that is not a GitHub pull request, and when gh finds none", async () => {
      expect(await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/issues/3", forge: GH })).toMatchObject({ outcome: "unavailable" });
      fakeGh({ data: { repository: { pullRequest: null } } });
      expect(await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/3", forge: GH })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("gh found no pull request") });
    });

    it("reads the draft flag, review decision and base branch with the rest of the feedback", async () => {
      fakeGh({ data: { repository: { pullRequest: { state: "OPEN", isDraft: true, reviewDecision: "REVIEW_REQUIRED", baseRefName: "main", headRefOid: "f00d", author: user("me"), commits: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] } } } } });
      expect(await prFeedback({ repo: makeRepo(), url: "https://github.com/acme/shop/pull/3", forge: GH })).toMatchObject({ outcome: "ok", draft: true, review: "REVIEW_REQUIRED", base: "main" });
      expect(readFileSync(join(bin, "args.txt"), "utf8")).toContain("number state isDraft reviewDecision baseRefName");
    });
  });
});

describe("prBatch", () => {
  let bin: string;
  let savedPath: string | undefined;
  beforeAll(() => {
    savedPath = process.env.PATH;
  });
  beforeEach(() => {
    bin = join(scratch, `bin-${counter++}`);
    mkdirSync(bin);
    process.env.PATH = `${bin}:${savedPath}`;
  });
  afterAll(() => {
    process.env.PATH = savedPath;
  });
  // gh prints GitHub's answer and exits 1 when it has errors, as it does for a number with no pull request.
  const fakeGh = (json: unknown, exit = 0) => {
    writeFileSync(join(bin, "response.json"), JSON.stringify(json));
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args.txt"\ncat "${bin}/response.json"\n${exit === 0 ? "" : `echo "gh: Could not resolve" >&2\nexit ${exit}\n`}`);
    chmodSync(join(bin, "gh"), 0o755);
  };
  const args = () => readFileSync(join(bin, "args.txt"), "utf8");
  const query = () => args().slice(args().indexOf("query=") + "query=".length);
  const input = (numbers: number[], feedback: boolean) => ({ repo: makeRepo(), host: "github.example.com", owner: "acme", name: "shop", numbers, feedback });
  const pull = (number: number, more: Record<string, unknown> = {}) => ({ number, state: "OPEN", isDraft: false, reviewDecision: null, baseRefName: "main", ...more });

  it("asks for every number as an aliased pullRequest field over one fragment, light without the feedback", async () => {
    fakeGh({ data: { repository: { p0: pull(123), p1: pull(7) } } });
    await prBatch(input([123, 7], false));
    expect(args().split("\n").slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.example.com"]);
    expect(args()).toContain("owner=acme\n");
    expect(args()).toContain("name=shop\n");
    expect(query()).toBe(
      [
        "query($owner: String!, $name: String!) {",
        "  repository(owner: $owner, name: $name) {",
        "    p0: pullRequest(number: 123) { ...F }",
        "    p1: pullRequest(number: 7) { ...F }",
        "  }",
        "}",
        "fragment F on PullRequest { number state isDraft reviewDecision baseRefName mergeable title body }",
        "",
      ].join("\n"),
    );
    expect(batchQuery([1], true)).toContain("fragment F on PullRequest {\n  number state isDraft reviewDecision baseRefName mergeable title body headRefOid author { login }");
    expect(batchQuery([1], true)).toContain("reviewThreads(last: 100)");
  });

  it("reads each pull request's title and description, for Loom's own sections in it", async () => {
    fakeGh({ data: { repository: { p0: pull(3, { title: "Add rows", body: "Why" }), p1: pull(4, { title: null, body: null }) } } });
    expect(await prBatch(input([3, 4], false))).toMatchObject({ outcome: "ok", pulls: [{ number: 3, title: "Add rows", body: "Why", feedback: null }, { number: 4, title: null, body: null }] });
  });

  it("maps each pull request's state, draft flag, review decision, base and mergeability, and lists a number GitHub did not answer for as missing", async () => {
    fakeGh(
      {
        data: { repository: { p0: pull(12, { state: "MERGED", isDraft: true, reviewDecision: "APPROVED", baseRefName: "loom/x/csv-1", mergeable: "UNKNOWN" }), p1: null, p2: pull(14, { state: "CLOSED", reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING" }), p3: pull(15, { mergeable: "MERGEABLE" }) } },
        errors: [{ type: "NOT_FOUND", path: ["repository", "p1"], message: "Could not resolve to a PullRequest with the number of 13." }],
      },
      1,
    );
    expect(await prBatch(input([12, 13, 14, 15], false))).toEqual({
      outcome: "ok",
      pulls: [
        { number: 12, state: "MERGED", draft: true, review: "APPROVED", base: "loom/x/csv-1", mergeable: null, title: null, body: null, feedback: null },
        { number: 14, state: "CLOSED", draft: false, review: "CHANGES_REQUESTED", base: "main", mergeable: false, title: null, body: null, feedback: null },
        { number: 15, state: "OPEN", draft: false, review: null, base: "main", mergeable: true, title: null, body: null, feedback: null },
      ],
      missing: [{ number: 13, message: "gh found no pull request #13 in acme/shop: Could not resolve to a PullRequest with the number of 13." }],
    });
  });

  it("gives each pull request what prFeedback reads for it when the feedback is asked for", async () => {
    const full = { ...pull(5, { reviewDecision: "REVIEW_REQUIRED" }), headRefOid: "f00d", author: { __typename: "User", login: "me" }, commits: { nodes: [] }, reviews: { nodes: [{ databaseId: 1, author: { __typename: "User", login: "alice" }, state: "COMMENTED", body: "Why?", url: "https://gh/r1" }] }, reviewThreads: { nodes: [] }, comments: { nodes: [] } };
    fakeGh({ data: { repository: { p0: full } } });
    const read = await prBatch(input([5], true));
    fakeGh({ data: { repository: { pullRequest: full } } });
    const single = await prFeedback({ repo: makeRepo(), url: "https://github.example.com/acme/shop/pull/5", forge: GH });
    expect(read).toMatchObject({ outcome: "ok", pulls: [{ number: 5, state: "OPEN", draft: false, review: "REVIEW_REQUIRED", base: "main" }], missing: [] });
    const { title: _title, body: _body, ...feedback } = single as Extract<typeof single, { outcome: "ok" }>;
    expect((read as Extract<typeof read, { outcome: "ok" }>).pulls[0]!.feedback).toEqual(feedback);
    expect(single).toMatchObject({ outcome: "ok", head: "f00d", items: [{ kind: "review", author: "alice", state: "commented" }] });
  });

  it("is unavailable when gh fails with no answer, and when the repository is not there", async () => {
    fakeGh({ message: "Bad credentials" }, 4);
    expect(await prBatch(input([1], false))).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("gh api graphql failed") });
    fakeGh({ data: { repository: null } });
    expect(await prBatch(input([1], false))).toEqual({ outcome: "unavailable", message: expect.stringContaining("gh found no repository acme/shop on github.example.com") });
  });

  it("asks for no check run's steps, and asks for them only for a pull request with a failed check and others running", async () => {
    const run = (id: number, status: string, conclusion: string | null = null) => ({ __typename: "CheckRun", id: `CR_${id}`, databaseId: id, name: `job-${id}`, status, conclusion, detailsUrl: null, startedAt: null, completedAt: null });
    const withRuns = (number: number, runs: unknown[]) => ({ ...pull(number), headRefOid: "f00d", author: null, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: runs } } } }] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] } });
    const answer = { data: { repository: { p0: withRuns(1, [run(1, "COMPLETED", "FAILURE"), run(2, "IN_PROGRESS")]), p1: withRuns(2, [run(3, "IN_PROGRESS")]) } } };
    writeFileSync(join(bin, "response.json"), JSON.stringify(answer));
    writeFileSync(join(bin, "steps.json"), JSON.stringify({ data: { nodes: [{ id: "CR_2", steps: { totalCount: 4, nodes: [{ status: "COMPLETED" }, { status: "IN_PROGRESS" }] } }] } }));
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${bin}/calls.txt"\ncase "$*" in *"nodes(ids:"*) cat "${bin}/steps.json";; *) cat "${bin}/response.json";; esac\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const read = await prBatch(input([1, 2], true));
    const calls = readFileSync(join(bin, "calls.txt"), "utf8").split("\n").filter((line) => line.startsWith("api graphql"));
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("steps");
    expect(calls[1]).toContain('nodes(ids: ["CR_2"])');
    const pulls = (read as Extract<typeof read, { outcome: "ok" }>).pulls;
    expect(pulls[0]!.feedback!.checks.map((check) => check.steps)).toEqual([null, { done: 1, total: 4 }]);
    expect(pulls[1]!.feedback!.checks.map((check) => check.steps)).toEqual([null]);
  });

  it("keeps a server error or rate limit GitHub gave for one pull request of a partial answer worth waiting out", async () => {
    const answer = {
      data: { repository: { p0: pull(1), p1: null, p2: null, p3: null } },
      errors: [
        { path: ["repository", "p1"], message: "Something went wrong while executing your query. Please include `ABCD` when reporting this issue." },
        { path: ["repository", "p2"], type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1234567." },
        { path: ["repository", "p3"], type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 4." },
      ],
    };
    fakeGh(answer, 1);
    const read = await prBatch(input([1, 2, 3, 4], false));
    expect(read).toMatchObject({ outcome: "ok", pulls: [{ number: 1 }] });
    const missing = (read as Extract<typeof read, { outcome: "ok" }>).missing;
    expect(missing.map((miss) => [miss.number, miss.transient ?? null])).toEqual([
      [2, "server"],
      [3, "rate_limit"],
      [4, null],
    ]);
    expect(missing[2]!.message).toBe("gh found no pull request #4 in acme/shop: Could not resolve to a PullRequest with the number of 4.");
  });

  it("counts a pull request whose state came back but a field inside failed as a failed read, worth waiting out on a server error", async () => {
    const broken = { ...pull(1), headRefOid: "f00d", author: null, commits: { nodes: [] }, reviews: null, reviewThreads: { nodes: [] }, comments: { nodes: [] } };
    fakeGh({ data: { repository: { p0: broken } }, errors: [{ path: ["repository", "p0", "reviews"], message: "Something went wrong while executing your query." }] }, 1);
    const read = await prBatch(input([1], true));
    expect(read).toMatchObject({ outcome: "ok", pulls: [], missing: [{ number: 1, transient: "server", message: "GitHub did not answer for pull request #1 in acme/shop: Something went wrong while executing your query." }] });
  });

  it("fails the read of a pull request with any error under it, though the field GitHub could not fill came back null", async () => {
    const run = { ...pull(1, { reviewDecision: "APPROVED" }), headRefOid: "f00d", author: null, commits: { nodes: [{ commit: { statusCheckRollup: null } }] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] } };
    fakeGh({ data: { repository: { p0: run, p1: { ...run, number: 2, commits: { nodes: [] } } } }, errors: [{ path: ["repository", "p0", "commits", "nodes", 0, "commit", "statusCheckRollup"], message: "Something went wrong while executing your query." }] }, 1);
    const read = await prBatch(input([1, 2], true));
    expect(read).toMatchObject({ outcome: "ok", missing: [{ number: 1, transient: "server" }] });
    expect((read as Extract<typeof read, { outcome: "ok" }>).pulls.map((each) => each.number)).toEqual([2]);
  });

  it("marks a GitHub server error or rate limit as transient", async () => {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "gh: HTTP 502" >&2\nexit 1\n`);
    chmodSync(join(bin, "gh"), 0o755);
    expect(await prBatch(input([1, 2], false))).toEqual({ outcome: "unavailable", message: "gh api graphql failed: gh: HTTP 502", transient: "server" });
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "GraphQL: API rate limit exceeded for user ID 1234567." >&2\nexit 1\n`);
    expect(await prBatch(input([1], false))).toMatchObject({ outcome: "unavailable", transient: "rate_limit" });
  });

  it("marks a call that could not connect as one network failure for the whole batch, and asks once", async () => {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho run >> "${bin}/runs.txt"\nprintf '%s\\n' "error connecting to api.github.com" "check your internet connection or https://githubstatus.com" >&2\nexit 1\n`);
    chmodSync(join(bin, "gh"), 0o755);
    expect(await prBatch(input([1, 2, 3], true))).toEqual({ outcome: "unavailable", message: `gh api graphql failed: ${GH_OFFLINE}`, transient: "network" });
    expect(readFileSync(join(bin, "runs.txt"), "utf8")).toBe("run\n");
  });

  it("is served through the contract, which refuses more than 10 numbers and a name that is not GitHub's", async () => {
    const harness = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir: join(tmpdir(), "loom-host-entry-data"), tempDir: tmpdir() } });
    fakeGh({ data: { repository: { p0: pull(1) } } });
    expect(await harness.experimental_call("prBatch", input([1], false))).toMatchObject({ outcome: "ok", pulls: [{ number: 1 }] });
    const numbers = Array.from({ length: 11 }, (_, index) => index + 1);
    await expect(harness.experimental_call("prBatch", input(numbers, false))).rejects.toThrow();
    await expect(harness.experimental_call("prBatch", { ...input([1], false), owner: "--jq" })).rejects.toThrow();
    await expect(harness.experimental_call("prBatch", { ...input([1], false), name: "shop) { x }" })).rejects.toThrow();
    await expect(harness.experimental_call("prBatch", input([], false))).rejects.toThrow();
  });
});

describe("carrying a commit to the project's machine: exportChanges, readBlob, importChunk and importCommit", () => {
  const MiB = 1024 * 1024;
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(scratch, `data-${counter++}`);
  });

  /** A bare "origin" with one commit on main, and a clone of it with an identity. */
  function origin(): { remote: string; clone: () => string } {
    const seed = makeRepo();
    put(seed, "old.txt", "old\n");
    put(seed, "script.sh", "#!/bin/sh\necho hi\n");
    sh(seed, "add", "-A");
    sh(seed, "commit", "-q", "-m", "seed");
    const remote = join(scratch, `origin-${counter++}.git`);
    execFileSync("git", ["clone", "-q", "--bare", seed, remote]);
    const clone = () => {
      const dir = join(scratch, `clone-${counter++}`);
      execFileSync("git", ["clone", "-q", remote, dir]);
      sh(dir, "config", "user.email", "worker@example.com");
      sh(dir, "config", "user.name", "Worker");
      return dir;
    };
    return { remote, clone };
  }

  /** What the transport does: every blob in 4 MiB ranges from `from`, then one importCommit into `to`. */
  async function carry(from: string, to: string, exported: HostOutput<"exportChanges">, opts: { tree?: string; refs?: string[]; corrupt?: boolean; parent?: string } = {}) {
    const ranges: Array<{ path: string; offset: number; bytes: number }> = [];
    const entries: HostInput<"importCommit">["entries"] = [];
    for (const change of exported.changes) {
      if (change.status === "D") {
        entries.push({ path: change.path, delete: true });
        continue;
      }
      const upload = `csv-1-${change.blob}`;
      for (let offset = 0; offset === 0 || offset < change.size!; offset += 4 * MiB) {
        let { data } = await readBlob({ repo: from, sha: change.blob!, offset, length: Math.min(4 * MiB, change.size! - offset) || 0 });
        if (opts.corrupt === true) data = Buffer.from("tampered").toString("base64");
        ranges.push({ path: change.path, offset, bytes: Buffer.from(data, "base64").length });
        await importChunk({ upload, offset, data }, dataDir);
      }
      entries.push({ path: change.path, mode: change.mode!, upload });
    }
    const result = await importCommit({ repo: to, remote: "origin", baseBranch: "main", base: exported.base, tree: opts.tree ?? exported.tree, message: exported.message, author: exported.author, entries, refs: opts.refs ?? ["refs/heads/loom/csv/csv-1-home"], ...(opts.parent === undefined ? {} : { parent: opts.parent }) }, dataDir);
    return { result, ranges };
  }

  it("exports and imports through a checkout that is a subdirectory of its repository, as a bb project in a monorepo is", async () => {
    const { clone } = origin();
    const laptop = clone();
    const worker = clone();
    put(worker, "areas/zone/note.md", "zone\n");
    put(worker, "elsewhere.txt", "outside the zone\n");
    sh(worker, "add", "-A");
    sh(worker, "commit", "-q", "-m", "a change in a zone");
    put(laptop, "areas/zone/.keep", "");
    const zone = join(laptop, "areas/zone");

    const { result } = await carry(worker, zone, await exportChanges({ worktree: worker, base: "origin/main" }));
    expect(result.outcome).toBe("ok");
    const sha = (result as { sha: string }).sha;
    expect(sh(laptop, "rev-parse", `${sha}^{tree}`)).toBe(sh(worker, "rev-parse", "HEAD^{tree}"));

    const back = await exportChanges({ worktree: zone, base: "origin/main", head: sha });
    expect(back.changes.map((change) => [change.path, change.blob])).toEqual([
      ["areas/zone/note.md", sh(worker, "rev-parse", "HEAD:areas/zone/note.md")],
      ["elsewhere.txt", sh(worker, "rev-parse", "HEAD:elsewhere.txt")],
    ]);
  });

  it("rebuilds an added, a modified, a deleted and an executable file on the same base, with the worker's tree, author and message", async () => {
    const { clone } = origin();
    const laptop = clone();
    const worker = clone();
    put(worker, "src/new.txt", "new\n");
    put(worker, "README.md", "changed\n");
    rmSync(join(worker, "old.txt"));
    chmodSync(join(worker, "script.sh"), 0o755);
    sh(worker, "add", "-A");
    sh(worker, "commit", "-q", "-m", "CSV-1: Order rows\n\nThe body.");
    const base = sh(worker, "rev-parse", "origin/main");

    const exported = await exportChanges({ worktree: worker, base: "origin/main" });
    expect(exported).toMatchObject({ base, head: sh(worker, "rev-parse", "HEAD"), tree: sh(worker, "rev-parse", "HEAD^{tree}"), message: "CSV-1: Order rows\n\nThe body.\n", author: { name: "Worker", email: "worker@example.com" } });
    expect(exported.author.date).toMatch(/^\d+ [+-]\d{4}$/u);
    expect(exported.changes).toEqual([
      { status: "M", path: "README.md", mode: "100644", blob: sh(worker, "rev-parse", "HEAD:README.md"), size: 8 },
      { status: "D", path: "old.txt" },
      { status: "M", path: "script.sh", mode: "100755", blob: sh(worker, "rev-parse", "HEAD:script.sh"), size: 18 },
      { status: "A", path: "src/new.txt", mode: "100644", blob: sh(worker, "rev-parse", "HEAD:src/new.txt"), size: 4 },
    ]);

    const { result } = await carry(worker, laptop, exported, { refs: ["refs/heads/loom/csv/csv-1-home", "refs/loom/csv/csv-1/reviewed"] });
    expect(result.outcome).toBe("ok");
    const sha = (result as { sha: string }).sha;
    expect(sh(laptop, "rev-parse", `${sha}^{tree}`)).toBe(exported.tree);
    expect(sh(laptop, "rev-parse", `${sha}^`)).toBe(base);
    expect(sh(laptop, "log", "-1", "--format=%an <%ae> %at|%cn <%ce> %ct|%B", sha)).toBe(`Worker <worker@example.com> ${exported.author.date.split(" ")[0]}|Worker <worker@example.com> ${exported.author.date.split(" ")[0]}|CSV-1: Order rows\n\nThe body.`);
    expect(sh(laptop, "rev-parse", "loom/csv/csv-1-home")).toBe(sha);
    expect(sh(laptop, "rev-parse", "refs/loom/csv/csv-1/reviewed")).toBe(sha);
    expect(sh(laptop, "status", "--porcelain")).toBe("");
    expect(existsSync(join(dataDir, "imports")) ? execFileSync("ls", [join(dataDir, "imports")], { encoding: "utf8" }) : "").toBe("");
  });

  it("moves a 6 MiB binary in two ranges, and gives the same commit when run again", async () => {
    const { clone } = origin();
    const laptop = clone();
    const worker = clone();
    const big = Buffer.alloc(6 * MiB);
    for (let index = 0; index < big.length; index += 4096) big[index] = index % 251;
    writeFileSync(join(worker, "big.bin"), big);
    sh(worker, "add", "-A");
    sh(worker, "commit", "-q", "-m", "big");

    const exported = await exportChanges({ worktree: worker, base: "origin/main" });
    const first = await carry(worker, laptop, exported);
    expect(first.ranges).toEqual([
      { path: "big.bin", offset: 0, bytes: 4 * MiB },
      { path: "big.bin", offset: 4 * MiB, bytes: 2 * MiB },
    ]);
    expect(first.result.outcome).toBe("ok");
    const again = await carry(worker, laptop, exported);
    expect(again.result).toEqual(first.result);
    expect(sh(laptop, "rev-parse", `${(first.result as { sha: string }).sha}^{tree}`)).toBe(exported.tree);
  });

  it("refuses a wrong chunk, a chunk out of order and a tree that does not match, and moves no ref", async () => {
    const { clone } = origin();
    const laptop = clone();
    const worker = clone();
    commitFile(worker, "a.txt", "a\n");
    const exported = await exportChanges({ worktree: worker, base: "origin/main" });

    const tampered = await carry(worker, laptop, exported, { corrupt: true });
    expect(tampered.result).toEqual({ outcome: "mismatch", tree: expect.stringMatching(/^[0-9a-f]{40}$/u) });
    const wrongTree = await carry(worker, laptop, exported, { tree: sh(laptop, "rev-parse", "HEAD^{tree}") });
    expect(wrongTree.result).toEqual({ outcome: "mismatch", tree: exported.tree });
    expect(sh(laptop, "branch", "--list", "loom/*")).toBe("");
    await expect(importChunk({ upload: "csv-1-x", offset: 5, data: "eA==" }, dataDir)).rejects.toThrow(/has 0 bytes, not 5/u);
  });

  it("commits a stacked ticket's tree on the commit it is stacked on, so its diff from there is its own", async () => {
    const { clone } = origin();
    const laptop = clone();
    sh(laptop, "switch", "-q", "-c", "loom/csv/csv-2-stack");
    const stacked = commitFile(laptop, "dep.txt", "dep\n", "Loom: CSV-1 for CSV-2");
    sh(laptop, "switch", "-q", "main");
    const worker = clone();
    commitFile(worker, "dep.txt", "dep\n", "Loom: CSV-1 for CSV-2");
    commitFile(worker, "mine.txt", "mine\n", "CSV-2: Export endpoint");

    const { result } = await carry(worker, laptop, await exportChanges({ worktree: worker, base: "origin/main" }), { parent: stacked });
    const sha = (result as { sha: string }).sha;
    expect(sh(laptop, "rev-parse", `${sha}^@`)).toBe(stacked);
    expect(sh(laptop, "rev-parse", `${sha}^{tree}`)).toBe(sh(worker, "rev-parse", "HEAD^{tree}"));
    expect(sh(laptop, "diff", "--name-only", `${stacked}...${sha}`)).toBe("mine.txt");
  });

  it("fetches a base the project's checkout does not have yet from its remote", async () => {
    const { clone } = origin();
    const laptop = clone();
    const upstream = clone();
    const newer = commitFile(upstream, "upstream.txt", "up\n");
    sh(upstream, "push", "-q", "origin", "HEAD:main");
    const worker = clone();
    commitFile(worker, "a.txt", "a\n");
    expect(() => execFileSync("git", ["-C", laptop, "cat-file", "-e", `${newer}^{commit}`], { stdio: "pipe" })).toThrow();

    const exported = await exportChanges({ worktree: worker, base: "origin/main" });
    expect(exported.base).toBe(newer);
    const { result } = await carry(worker, laptop, exported);
    expect(result.outcome).toBe("ok");
    expect(sh(laptop, "rev-parse", `${(result as { sha: string }).sha}^`)).toBe(newer);
    expect(sh(laptop, "rev-parse", "origin/main")).toBe(newer);
  });

  describe("with 500 changed files", () => {
    let path: string | undefined;
    let log: string;

    beforeAll(() => {
      const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const bin = join(scratch, "logging-bin");
      log = join(scratch, "git-calls.log");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
      path = process.env.PATH;
      process.env.PATH = `${bin}:${path}`;
    });

    afterAll(() => {
      process.env.PATH = path;
    });

    const gitCalls = (pattern: RegExp) => readFileSync(log, "utf8").split("\n").filter((line) => pattern.test(line)).length;

    it("reads every size with one git process and hashes every file with another, and rebuilds the tree", async () => {
      const { clone } = origin();
      const laptop = clone();
      const worker = clone();
      for (let index = 0; index < 500; index += 1) put(worker, `gen/${index}.txt`, `file ${index % 499}\n`);
      sh(worker, "add", "-A");
      sh(worker, "commit", "-q", "-m", "CSV-1: Generate");

      writeFileSync(log, "");
      const exported = await exportChanges({ worktree: worker, base: "origin/main" });
      expect(exported.changes).toHaveLength(500);
      expect(exported.changes.map((change) => change.size)).toEqual(exported.changes.map((change) => readFileSync(join(worker, change.path)).length));
      expect(gitCalls(/ cat-file -s /u)).toBe(0);
      expect(gitCalls(/ cat-file --batch-check/u)).toBe(1);

      const uploads = new Map<string, string>();
      for (const change of exported.changes) {
        if (uploads.has(change.blob!)) continue;
        uploads.set(change.blob!, `csv-1-${change.blob}`);
        await importChunk({ upload: `csv-1-${change.blob}`, offset: 0, data: readFileSync(join(worker, change.path)).toString("base64") }, dataDir);
      }
      expect(uploads.size).toBe(499);
      writeFileSync(log, "");
      const entries = exported.changes.map((change) => ({ path: change.path, mode: change.mode!, upload: uploads.get(change.blob!)! }));
      const made = await importCommit({ repo: laptop, remote: "origin", baseBranch: "main", base: exported.base, tree: exported.tree, message: exported.message, author: exported.author, entries, refs: ["refs/heads/loom/csv/csv-1-home"] }, dataDir);
      expect(made.outcome).toBe("ok");
      expect(sh(laptop, "rev-parse", "loom/csv/csv-1-home^{tree}")).toBe(exported.tree);
      expect(gitCalls(/ hash-object /u)).toBe(1);
    }, 60_000);
  });

  it("reads a ref's commit and tree, and whether it builds on another commit", async () => {
    const repo = makeRepo();
    const base = sh(repo, "rev-parse", "HEAD");
    sh(repo, "switch", "-q", "-c", "loom/csv/csv-1-home");
    const home = commitFile(repo, "a.txt", "a\n");
    sh(repo, "switch", "-q", "-c", "loom/csv/csv-1-2");
    const own = commitFile(repo, "b.txt", "b\n");
    sh(repo, "switch", "-q", "-c", "synced", base);
    commitFile(repo, "a.txt", "a\n", "a.txt, synced from another machine");

    expect(await refTip({ repo, ref: "refs/heads/loom/csv/csv-1-2" })).toEqual({ outcome: "ok", sha: own, tree: sh(repo, "rev-parse", `${own}^{tree}`) });
    expect(await refTip({ repo, ref: "refs/heads/loom/csv/csv-1-2", contains: home })).toMatchObject({ outcome: "ok", contains: true });
    expect(await refTip({ repo, ref: "refs/heads/loom/csv/csv-1-home", contains: home })).toMatchObject({ outcome: "ok", contains: true });
    expect(await refTip({ repo, ref: "refs/heads/synced", contains: home })).toMatchObject({ outcome: "ok", contains: false });
    expect(await refTip({ repo, ref: "refs/heads/gone", contains: home })).toMatchObject({ outcome: "missing" });
  });

  it("exports a given commit of a checkout against its merge base with the base", async () => {
    const { clone } = origin();
    const laptop = clone();
    sh(laptop, "switch", "-q", "-c", "work");
    const sha = commitFile(laptop, "b.txt", "b\n");
    sh(laptop, "switch", "-q", "main");
    const exported = await exportChanges({ worktree: laptop, base: "origin/main", head: sha });
    expect(exported).toMatchObject({ head: sha, base: sh(laptop, "rev-parse", "origin/main"), changes: [{ status: "A", path: "b.txt" }] });
  });
});

describe("carrying a commit to a thread's own machine: carryStart, carryWrite, carryDelete and carryFinish", () => {
  let path: string | undefined;
  let bin: string;

  beforeAll(() => {
    bin = restrictedGitBin(scratch);
    path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
  });

  afterAll(() => {
    process.env.PATH = path;
  });

  function setup() {
    const seed = makeRepo();
    put(seed, "old.txt", "old\n");
    put(seed, "keep/run.sh", "#!/bin/sh\n");
    sh(seed, "add", "-A");
    sh(seed, "commit", "-q", "-m", "seed");
    const remote = join(scratch, `origin-${counter++}.git`);
    execFileSync("git", ["clone", "-q", "--bare", seed, remote]);
    const clone = () => {
      const dir = join(scratch, `clone-${counter++}`);
      execFileSync("git", ["clone", "-q", remote, dir]);
      sh(dir, "config", "user.email", "dev@example.com");
      sh(dir, "config", "user.name", "Dev");
      return dir;
    };
    return { remote, clone };
  }

  /** What the transport does toward a thread's machine, from the project's checkout. */
  async function carryOut(checkout: string, worktree: string, exported: HostOutput<"exportChanges">, tree = exported.tree) {
    const started = await carryStart({ worktree, remote: "origin", baseBranch: "main", base: exported.base, tree: exported.tree });
    if (started.outcome !== "ok") return started;
    await carryDelete({ worktree, paths: exported.changes.filter((change) => change.status === "D").map((change) => change.path) });
    for (const change of exported.changes) {
      if (change.status === "D") continue;
      for (let offset = 0; offset === 0 || offset < change.size!; offset += 4 * 1024 * 1024) {
        const { data } = await readBlob({ repo: checkout, sha: change.blob!, offset, length: Math.min(4 * 1024 * 1024, change.size! - offset) });
        await carryWrite({ worktree, path: change.path, mode: change.mode!, offset, data });
      }
    }
    const paths = exported.changes.filter((change) => change.status !== "D").map((change) => change.path);
    return carryFinish({ worktree, base: exported.base, message: exported.message, author: exported.author, tree, paths });
  }

  it("puts the commit's tree in the worktree with worktree commands alone, where a temporary index is refused", async () => {
    const { clone } = setup();
    const checkout = clone();
    sh(checkout, "switch", "-q", "-c", "loom/csv/csv-1-home");
    put(checkout, "src/new.txt", "new\n");
    put(checkout, "keep/run.sh", "#!/bin/sh\necho run\n");
    chmodSync(join(checkout, "keep/run.sh"), 0o755);
    symlinkSync("new.txt", join(checkout, "src/link.txt"));
    rmSync(join(checkout, "old.txt"));
    sh(checkout, "add", "-A");
    sh(checkout, "commit", "-q", "-m", "CSV-1: Order rows");
    const home = sh(checkout, "rev-parse", "HEAD");
    const worktree = clone();
    expect(() => execFileSync("git", ["-C", worktree, "read-tree", "HEAD"], { env: { ...process.env, GIT_INDEX_FILE: join(scratch, "tmp-index") }, stdio: "pipe" })).toThrow(/temporary index/u);

    const exported = await exportChanges({ worktree: checkout, base: "origin/main", head: home });
    const finished = await carryOut(checkout, worktree, exported);
    expect(finished).toEqual({ outcome: "ok", head: sh(worktree, "rev-parse", "HEAD"), tree: exported.tree });
    expect(sh(worktree, "rev-parse", "HEAD^")).toBe(exported.base);
    expect(sh(worktree, "log", "-1", "--format=%an <%ae> %at %s")).toBe(`Dev <dev@example.com> ${exported.author.date.split(" ")[0]} CSV-1: Order rows`);
    expect(sh(worktree, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(worktree, "src/link.txt"), "utf8")).toBe("new\n");
  });

  it("carries a file the commit force-added although .gitignore matches it", async () => {
    const { clone } = setup();
    const checkout = clone();
    sh(checkout, "switch", "-q", "-c", "loom/csv/csv-1-home");
    put(checkout, ".gitignore", "*.log\n");
    put(checkout, "keep.log", "kept\n");
    sh(checkout, "add", "-f", ".gitignore", "keep.log");
    sh(checkout, "commit", "-q", "-m", "CSV-1: Keep the log");
    const home = sh(checkout, "rev-parse", "HEAD");
    const worktree = clone();

    const exported = await exportChanges({ worktree: checkout, base: "origin/main", head: home });
    expect(await carryOut(checkout, worktree, exported)).toEqual({ outcome: "ok", head: sh(worktree, "rev-parse", "HEAD"), tree: exported.tree });
    expect(sh(worktree, "ls-files", "keep.log")).toBe("keep.log");
  });

  it("fetches a base the thread's machine does not have, and resets to the base when the tree does not match", async () => {
    const { clone } = setup();
    const worktree = clone();
    const upstream = clone();
    commitFile(upstream, "up.txt", "up\n");
    sh(upstream, "push", "-q", "origin", "HEAD:main");
    sh(upstream, "switch", "-q", "-c", "work");
    const sha = commitFile(upstream, "a.txt", "a\n");
    const exported = await exportChanges({ worktree: upstream, base: "origin/main", head: sha });

    const finished = await carryOut(upstream, worktree, exported, sh(worktree, "rev-parse", "HEAD^{tree}"));
    expect(finished).toEqual({ outcome: "mismatch", tree: exported.tree });
    expect(sh(worktree, "rev-parse", "HEAD")).toBe(exported.base);
    expect(sh(worktree, "status", "--porcelain")).toBe("");
  });

  it("refuses a worktree with uncommitted changes, and a path that leads out of it", async () => {
    const { clone } = setup();
    const worktree = clone();
    put(worktree, "notes.txt", "mine\n");
    const refused = await carryStart({ worktree, remote: "origin", baseBranch: "main", base: sh(worktree, "rev-parse", "HEAD"), tree: sh(worktree, "rev-parse", "HEAD:keep") });
    expect(refused).toEqual({ outcome: "unavailable", message: expect.stringMatching(/has uncommitted changes, so Loom cannot put the work in it: notes\.txt\. Stash or discard them, then try again$/u) });
    expect(readFileSync(join(worktree, "notes.txt"), "utf8")).toBe("mine\n");

    symlinkSync(scratch, join(worktree, "out"));
    await expect(carryWrite({ worktree, path: "out/escape.txt", mode: "100644", offset: 0, data: "eA==" })).rejects.toThrow(/leads out of the worktree/u);
    expect(existsSync(join(scratch, "escape.txt"))).toBe(false);
  });

  it("refuses a worktree with commits of its own, and keeps them", async () => {
    const { clone } = setup();
    const worktree = clone();
    const base = sh(worktree, "rev-parse", "origin/main");
    const mine = commitFile(worktree, "mine.txt", "mine\n");
    const refused = await carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: sh(worktree, "rev-parse", "origin/main^{tree}") });
    expect(refused).toEqual({ outcome: "unavailable", message: expect.stringMatching(/has commits that are not on origin\/main, so putting the work in would drop them: [0-9a-f]{12}\. Stash them or move them to another branch, then try again$/u) });
    expect(sh(worktree, "rev-parse", "HEAD")).toBe(mine);
    expect(readFileSync(join(worktree, "mine.txt"), "utf8")).toBe("mine\n");
  });

  it("leaves a worktree that has the tree already as it is, so carrying it twice is harmless", async () => {
    const { clone } = setup();
    const checkout = clone();
    sh(checkout, "switch", "-q", "-c", "loom/csv/csv-1-home");
    const home = commitFile(checkout, "src/new.txt", "new\n");
    const worktree = clone();
    const exported = await exportChanges({ worktree: checkout, base: "origin/main", head: home });
    expect(await carryOut(checkout, worktree, exported)).toMatchObject({ outcome: "ok", tree: exported.tree });
    const carried = sh(worktree, "rev-parse", "HEAD");

    expect(await carryStart({ worktree, remote: "origin", baseBranch: "main", base: exported.base, tree: exported.tree })).toEqual({ outcome: "ok", present: true });
    expect(sh(worktree, "rev-parse", "HEAD")).toBe(carried);
    expect(sh(worktree, "status", "--porcelain")).toBe("");
  });

  it("leaves a merge the worker has not finished as it is, even with nothing left to resolve", async () => {
    const { clone } = setup();
    const worktree = clone();
    const theirs = sh(worktree, "rev-parse", "HEAD");
    writeFileSync(join(worktree, ".git", "MERGE_HEAD"), `${theirs}\n`);
    expect(sh(worktree, "status", "--porcelain")).toBe("");
    const refused = await carryStart({ worktree, remote: "origin", baseBranch: "main", base: theirs, tree: sh(worktree, "rev-parse", "HEAD:keep") });
    expect(refused).toEqual({ outcome: "unavailable", message: expect.stringContaining("has a merge that is not finished, so Loom left it as it is. Finish it with git commit, or abort it with git merge --abort") });
    expect(readFileSync(join(worktree, ".git", "MERGE_HEAD"), "utf8")).toBe(`${theirs}\n`);
  });

  it("starts again over a carry that was cut short, whose files are its own, and refuses one that is not", async () => {
    const { clone } = setup();
    const checkout = clone();
    sh(checkout, "switch", "-q", "-c", "loom/csv/csv-1-home");
    put(checkout, "src/one.txt", "one\n");
    const home = commitFile(checkout, "src/two.txt", "two\n");
    const worktree = clone();
    const exported = await exportChanges({ worktree: checkout, base: "origin/main", head: home });
    const start = { worktree, remote: "origin", baseBranch: "main", base: exported.base, tree: exported.tree };
    expect(await carryStart(start)).toEqual({ outcome: "ok", present: false });
    await carryWrite({ worktree, path: "src/one.txt", mode: "100644", offset: 0, data: Buffer.from("one\n").toString("base64") });
    expect(await carryStart(start)).toEqual({ outcome: "ok", present: false });
    expect(existsSync(join(worktree, "src/one.txt"))).toBe(false);
    expect(await carryOut(checkout, worktree, exported)).toMatchObject({ outcome: "ok", tree: exported.tree });

    put(worktree, "notes.txt", "mine\n");
    expect(await carryStart({ ...start, tree: sh(worktree, "rev-parse", "HEAD:keep") })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("has uncommitted changes") });
    expect(readFileSync(join(worktree, "notes.txt"), "utf8")).toBe("mine\n");
  });

  it("starts again over a stacked carry cut short after its first commit, partly written or not, until its last tree is in", async () => {
    const { clone } = setup();
    const checkout = clone();
    sh(checkout, "switch", "-q", "-c", "loom/csv/csv-2-home");
    const stacked = commitFile(checkout, "dep/a.txt", "dep\n");
    const home = commitFile(checkout, "src/b.txt", "mine\n");
    const first = await exportChanges({ worktree: checkout, base: "origin/main", head: stacked });
    const second = await exportChanges({ worktree: checkout, base: stacked, head: home });
    const worktree = clone();
    const start = { worktree, remote: "origin", baseBranch: "main", base: first.base, tree: second.tree };
    const write = (path: string, content: string) => carryWrite({ worktree, path, mode: "100644", offset: 0, data: Buffer.from(content).toString("base64") });
    const finish = (exported: HostOutput<"exportChanges">) => carryFinish({ worktree, base: first.base, message: exported.message, author: exported.author, tree: exported.tree, paths: exported.changes.map((change) => change.path) });
    const commitOfDependency = async () => {
      expect(await carryStart(start)).toEqual({ outcome: "ok", present: false });
      await write("dep/a.txt", "dep\n");
      expect(await finish(first)).toMatchObject({ outcome: "ok", tree: first.tree });
    };

    await commitOfDependency();
    await write("src/b.txt", "mi");
    await commitOfDependency();
    await commitOfDependency();
    await write("src/b.txt", "mine\n");
    expect(await finish(second)).toMatchObject({ outcome: "ok", tree: second.tree });
    expect(sh(worktree, "rev-parse", "HEAD^^")).toBe(first.base);
    expect(existsSync(join(worktree, ".git", "loom-carry"))).toBe(false);

    put(worktree, "notes.txt", "mine\n");
    expect(await carryStart({ ...start, tree: first.tree })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("has uncommitted changes") });
  });

  it("marks a base fetch that could not reach the remote as worth waiting out", async () => {
    const { clone } = setup();
    const worktree = clone();
    sh(worktree, "remote", "set-url", "origin", "https://nowhere.invalid/acme/shop.git");
    const started = await carryStart({ worktree, remote: "origin", baseBranch: "main", base: "1".repeat(40), tree: sh(worktree, "rev-parse", "HEAD:keep") });
    expect(started).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("did not bring it"), transient: "network" });
  });

  it("carries into a worktree whose path is a subdirectory of its repository, with the paths from its top level", async () => {
    const { clone } = setup();
    const checkout = clone();
    sh(checkout, "switch", "-q", "-c", "loom/csv/csv-1-home");
    put(checkout, "src/new.txt", "new\n");
    rmSync(join(checkout, "old.txt"));
    sh(checkout, "add", "-A");
    sh(checkout, "commit", "-q", "-m", "CSV-1: Order rows");
    const home = sh(checkout, "rev-parse", "HEAD");
    const worktree = clone();
    const zone = join(worktree, "keep");
    const exported = await exportChanges({ worktree: join(checkout, "keep"), base: "origin/main", head: home });

    expect(await carryOut(checkout, zone, exported)).toEqual({ outcome: "ok", head: sh(worktree, "rev-parse", "HEAD"), tree: exported.tree });
    expect(readFileSync(join(worktree, "src/new.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(worktree, "old.txt"))).toBe(false);
    expect(existsSync(join(zone, "src"))).toBe(false);
    expect(sh(worktree, "status", "--porcelain")).toBe("");

    put(worktree, "src/new.txt", "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n");
    expect(await conflictMarkers({ worktree: zone, paths: ["src/new.txt"] })).toEqual({ files: ["src/new.txt"] });
  });

  it("lists the files that still have conflict markers, and leaves out resolved and deleted ones", async () => {
    const { clone } = setup();
    const worktree = clone();
    put(worktree, "src/a.ts", "keep\n<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n");
    put(worktree, "src/b.ts", "resolved\n");
    put(worktree, "src/c.md", "a line of <<<<<<< in prose\n");
    expect(await conflictMarkers({ worktree, paths: ["src/a.ts", "src/b.ts", "src/c.md", "src/gone.ts"] })).toEqual({ files: ["src/a.ts"] });
  });

  it("resets a worktree with commits of its own when HEAD has the tree the caller says the project's machine keeps", async () => {
    const { clone } = setup();
    const worktree = clone();
    const base = sh(worktree, "rev-parse", "origin/main");
    commitFile(worktree, "mine.txt", "mine\n");
    const kept = sh(worktree, "rev-parse", "HEAD^{tree}");
    expect(await carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: sh(worktree, "rev-parse", "origin/main^{tree}"), replaces: kept })).toEqual({ outcome: "ok", present: false });
    expect(sh(worktree, "rev-parse", "HEAD")).toBe(base);

    commitFile(worktree, "other.txt", "other\n");
    const refused = await carryStart({ worktree, remote: "origin", baseBranch: "main", base, tree: sh(worktree, "rev-parse", "origin/main^{tree}"), replaces: kept });
    expect(refused).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("has commits that are not on origin/main") });
  });

  it("measures the changes from the newest commit on HEAD's first-parent line with the given tree, and says when there is none", async () => {
    const { clone } = setup();
    const worktree = clone();
    commitFile(worktree, "dep.txt", "the dependency's work\n", "Loom: CSV-1 for CSV-2");
    const stacked = sh(worktree, "rev-parse", "HEAD^{tree}");
    commitFile(worktree, "src/mine.txt", "mine\n");
    put(worktree, "src/loose.txt", "loose\n");

    expect(await worktreeState({ worktree, base: "origin/main", baseTree: stacked })).toMatchObject({ changed: ["src/loose.txt", "src/mine.txt"], onBase: true });
    expect(await worktreeState({ worktree, base: "origin/main" })).toMatchObject({ changed: ["dep.txt", "src/loose.txt", "src/mine.txt"] });
    const missing = await worktreeState({ worktree, base: "origin/main", baseTree: sh(worktree, "rev-parse", "HEAD:src") });
    expect(missing).toMatchObject({ changed: ["dep.txt", "src/loose.txt", "src/mine.txt"], onBase: false });
  });
});
