// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import hostEntry from "../host";
import { changedFiles, commitAll, diff, ensureBranch, ensureWorktree, exec, fetchBranch, filePatch, git, merge, parseRemoteUrl, prCreate, prState, push, resetHard, worktreeState } from "../src/host/ops";

const ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const AUTHOR_VARS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const saved: Record<string, string | undefined> = {};

let scratch: string;
let counter = 0;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
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
    expect(await worktreeState({ worktree, base: "main" })).toEqual({ branch: "loom/csv-2", head: sha, dirty: false, changed: ["src/a.ts"] });

    sh(worktree, "checkout", "-q", "--detach");
    expect((await worktreeState({ worktree, base: "main" })).branch).toBeNull();
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
    const result = await prCreate({ repo, remote: "origin", base: "main", head: "loom/csv-1", title: "CSV-1: Order rows", body: "Body line\n\nAcceptance:\n1. x", draft: true });
    expect(result).toEqual({ outcome: "ok", url: "https://github.com/acme/shop/pull/7" });
    expect(calls()).toEqual([["pr", "create", "--repo", "github.com/acme/shop", "--base", "main", "--head", "loom/csv-1", "--title", "CSV-1: Order rows", "--body-file", "-", "--draft"]]);
    expect(readFileSync(join(bin, "stdin.txt"), "utf8")).toBe("Body line\n\nAcceptance:\n1. x");
  });

  it("parses an ssh remote and leaves out --draft for a ready pull request", async () => {
    fakeGh(`cat > /dev/null\necho "https://github.com/acme/shop/pull/8"`);
    const repo = repoWithRemote("git@github.com:acme/shop.git");
    await prCreate({ repo, remote: "origin", base: "main", head: "loom/csv-2", title: "t", body: "", draft: false });
    expect(calls()[0]).toEqual(["pr", "create", "--repo", "github.com/acme/shop", "--base", "main", "--head", "loom/csv-2", "--title", "t", "--body-file", "-"]);
  });

  it("takes the repository from the push URL, which is where git push sends the branch", async () => {
    fakeGh(`cat > /dev/null\necho "https://github.com/fork/shop/pull/3"`);
    const repo = repoWithRemote("https://github.com/acme/shop.git");
    sh(repo, "remote", "set-url", "--push", "origin", "git@github.com:fork/shop.git");
    await prCreate({ repo, remote: "origin", base: "main", head: "loom/csv-3", title: "t", body: "", draft: true });
    expect(calls()[0]).toEqual(["pr", "create", "--repo", "github.com/fork/shop", "--base", "main", "--head", "loom/csv-3", "--title", "t", "--body-file", "-", "--draft"]);
  });

  it("is unavailable, without calling gh, when the remote pushes to more than one URL", async () => {
    fakeGh(`cat > /dev/null\necho "https://github.com/acme/shop/pull/4"`);
    const repo = repoWithRemote("https://github.com/acme/shop.git");
    sh(repo, "remote", "set-url", "--push", "origin", "git@github.com:acme/shop.git");
    sh(repo, "remote", "set-url", "--add", "--push", "origin", "git@github.com:fork/shop.git");
    const result = await prCreate({ repo, remote: "origin", base: "main", head: "loom/csv-4", title: "t", body: "", draft: true });
    expect(result).toMatchObject({ outcome: "unavailable", message: expect.stringMatching(/"origin".*2 push URLs/u) });
    expect(calls()).toEqual([]);
  });

  it("falls back to gh pr view when the pull request already exists", async () => {
    fakeGh(
      `case "$1 $2" in\n"pr create") cat > /dev/null; echo 'a pull request for branch "loom/csv-1" into branch "main" already exists:' 1>&2; echo "https://github.com/acme/shop/pull/7" 1>&2; exit 1;;\n"pr view") echo '{"url":"https://github.com/acme/shop/pull/7"}';;\nesac`,
    );
    const repo = repoWithRemote("https://github.com/acme/shop.git");
    const result = await prCreate({ repo, remote: "origin", base: "main", head: "loom/csv-1", title: "t", body: "b", draft: true });
    expect(result).toEqual({ outcome: "ok", url: "https://github.com/acme/shop/pull/7" });
    expect(calls()[1]).toEqual(["pr", "view", "loom/csv-1", "--repo", "github.com/acme/shop", "--json", "url"]);
  });

  it("is unavailable when the remote does not parse, the remote is missing, gh fails or gh is not installed", async () => {
    fakeGh(`cat > /dev/null\necho "https://github.com/x/y/pull/1"`);
    const local = repoWithRemote("/srv/git/shop.git");
    expect(await prCreate({ repo: local, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("GitHub") });
    const bare = makeRepo();
    expect(await prCreate({ repo: bare, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true })).toMatchObject({ outcome: "unavailable" });
    expect(calls()).toEqual([]);

    fakeGh(`cat > /dev/null\necho "gh: not logged in" 1>&2\nexit 4`);
    const repo = repoWithRemote("https://github.com/acme/shop.git");
    const failed = await prCreate({ repo, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true });
    expect(failed).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("not logged in") });

    const gitOnly = join(scratch, `git-only-${counter++}`);
    mkdirSync(gitOnly);
    symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(gitOnly, "git"));
    process.env.PATH = gitOnly;
    const missing = await prCreate({ repo, remote: "origin", base: "main", head: "h", title: "t", body: "", draft: true });
    expect(missing).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("gh") });
  });

  it("reads the state of a pull request, and sets the prompt guards", async () => {
    fakeGh(`echo "$GH_PROMPT_DISABLED $GIT_TERMINAL_PROMPT" > "$dir/env.txt"\necho '{"state":"MERGED"}'`);
    const repo = makeRepo();
    expect(await prState({ repo, url: "https://github.com/acme/shop/pull/7" })).toEqual({ outcome: "ok", state: "MERGED" });
    expect(calls()).toEqual([["pr", "view", "https://github.com/acme/shop/pull/7", "--json", "state"]]);
    expect(readFileSync(join(bin, "env.txt"), "utf8").trim()).toBe("1 0");

    fakeGh(`echo "no pull requests found" 1>&2\nexit 1`);
    expect(await prState({ repo, url: "https://github.com/acme/shop/pull/9" })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("no pull requests found") });
    fakeGh(`echo '{"state":"WEIRD"}'`);
    expect(await prState({ repo, url: "https://github.com/acme/shop/pull/9" })).toMatchObject({ outcome: "unavailable" });
  });
});

describe("host entry", () => {
  const harness = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir: join(tmpdir(), "loom-host-entry-data"), tempDir: tmpdir() } });

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

  it("refuses a relative path, an option-like ref and a timeout outside the range", async () => {
    await expect(harness.experimental_call("exec", { cwd: "relative", command: "ls", timeoutMs: 5000 })).rejects.toThrow();
    await expect(harness.experimental_call("exec", { cwd: scratch, command: "ls", timeoutMs: 10 })).rejects.toThrow();
    await expect(harness.experimental_call("ensureBranch", { repo: scratch, branch: "--force", from: "main" })).rejects.toThrow();
    await expect(harness.experimental_call("ensureBranch", { repo: scratch, branch: "a..b", from: "main" })).rejects.toThrow();
    await expect(harness.experimental_call("ensureBranch", { repo: scratch, branch: "a b", from: "main" })).rejects.toThrow();
    await expect(harness.experimental_call("fetchBranch", { worktree: scratch, remote: "--upload-pack=x", branch: "main" })).rejects.toThrow();
  });
});
