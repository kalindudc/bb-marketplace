// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host";
import type { HostInput, HostOutput } from "../src/contract";

type Files = Extract<HostOutput<"repoFiles">, { outcome: "available" }>["files"];
type Patch = Extract<HostOutput<"repoPatch">, { outcome: "available" }>;

const harness = experimental_createHostEntryHarness(hostEntry);
const savedEnv: Record<string, string | undefined> = {};
const HERMETIC_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com",
};

let scratch: string;
let work: string;
let plain: string;
let unborn: string;
let tmpRepo: string;
let lagging: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
function put(root: string, path: string, content: string | Buffer): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}
function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}
const repoFiles = (root: string, target: HostInput<"repoFiles">["target"]) => harness.experimental_call("repoFiles", { root, target });
const repoPatch = (root: string, path: string, target: HostInput<"repoPatch">["target"], extra: Partial<HostInput<"repoPatch">> = {}) =>
  harness.experimental_call("repoPatch", { root, path, previousPath: null, untracked: false, target, ...extra });
const filesOf = (output: HostOutput<"repoFiles">): Files => {
  if (output.outcome !== "available") throw new Error(`unavailable: ${output.message}`);
  return output.files;
};
const patchOf = (output: HostOutput<"repoPatch">): Patch => {
  if (output.outcome !== "available") throw new Error(`unavailable: ${output.message}`);
  return output;
};
const byPath = (files: Files, path: string) => files.find((file) => file.path === path);

beforeAll(() => {
  for (const [key, value] of Object.entries(HERMETIC_ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "vantage-host-")));
  const origin = join(scratch, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  put(origin, "README.md", "# Title\n\nSome text.\n");
  put(origin, "src/a.ts", "export const a = 1;\nexport const b = 2;\n");
  put(origin, "src/b.ts", "export const b = 1;\n");
  put(origin, "old.txt", "one\ntwo\nthree\n");
  commitAll(origin, "initial");

  work = join(scratch, "work");
  execFileSync("git", ["clone", "-q", origin, work]);
  git(work, "checkout", "-q", "-b", "feature");
  put(work, "src/a.ts", "export const a = 1;\nexport const b = 3;\nexport const c = 4;\n");
  put(work, "src/feature.ts", "export const feature = true;\n");
  commitAll(work, "feature work");

  put(work, "src/b.ts", "export const b = 2;\n");
  git(work, "mv", "README.md", "GUIDE.md");
  rmSync(join(work, "old.txt"));
  put(work, "notes.txt", "one\ntwo\nthree\n");
  put(work, "image.bin", Buffer.from([1, 2, 0, 3, 4]));

  plain = join(scratch, "plain");
  mkdirSync(plain);
  put(plain, "file.txt", "x\n");

  unborn = join(scratch, "unborn");
  mkdirSync(unborn);
  git(unborn, "init", "-q", "-b", "main");
  put(unborn, "staged.txt", "a\nb\n");
  git(unborn, "add", "staged.txt");
  put(unborn, "loose.txt", "c\n");

  const upstream = join(scratch, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  put(upstream, "base.txt", "base\n");
  commitAll(upstream, "base");
  lagging = join(scratch, "lagging");
  execFileSync("git", ["clone", "-q", upstream, lagging]);
  git(lagging, "checkout", "-q", "-b", "topic");
  put(lagging, "one.txt", "one\n");
  commitAll(lagging, "first topic commit");
  put(lagging, "two.txt", "two\n");
  commitAll(lagging, "second topic commit");
  put(upstream, "main-only.txt", "moved on\n");
  commitAll(upstream, "main moves on");
  git(lagging, "fetch", "-q", "origin");

  tmpRepo = mkdtempSync("/tmp/vantage-host-");
  git(tmpRepo, "init", "-q", "-b", "main");
  put(tmpRepo, "dir/file.txt", "x\n");
});

afterAll(async () => {
  await harness.experimental_dispose();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(tmpRepo, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveRoots", () => {
  it("finds the root and the repository-relative path of nested, deleted and missing files", async () => {
    const { results } = await harness.experimental_call("resolveRoots", {
      paths: [
        join(work, "src/a.ts"), join(work, "old.txt"), join(work, "gone/deep/x.ts"), work, join(work, "src"),
      ],
    });
    expect(results.map(({ root, relative }) => ({ root, relative }))).toEqual([
      { root: work, relative: "src/a.ts" },
      { root: work, relative: "old.txt" },
      { root: work, relative: "gone/deep/x.ts" },
      { root: work, relative: "" },
      { root: work, relative: "src" },
    ]);
    expect(results[0]?.path).toBe(join(work, "src/a.ts"));
  });

  it("returns null outside any repository", async () => {
    const { results } = await harness.experimental_call("resolveRoots", {
      paths: [join(plain, "file.txt"), join(plain, "missing/file.txt")],
    });
    expect(results.map(({ root, relative }) => ({ root, relative }))).toEqual([
      { root: null, relative: null }, { root: null, relative: null },
    ]);
  });

  it("reports the root the way git prints it for a repository under /tmp", async () => {
    const expected = git(tmpRepo, "rev-parse", "--show-toplevel").trim();
    const { results } = await harness.experimental_call("resolveRoots", { paths: [join(tmpRepo, "dir/file.txt")] });
    expect(results[0]).toMatchObject({ root: expected, relative: "dir/file.txt" });
  });
});

describe("repoFiles uncommitted", () => {
  it("lists modified, renamed, deleted, untracked and binary files with counts", async () => {
    const output = await repoFiles(work, { type: "uncommitted" });
    expect(output).toMatchObject({ outcome: "available", branch: "feature", base: null, aheadCount: null, truncated: false });
    const files = filesOf(output);
    expect(files.map((file) => file.path)).toEqual(["GUIDE.md", "image.bin", "notes.txt", "old.txt", "src/b.ts"]);
    expect(byPath(files, "src/b.ts")).toEqual({
      path: "src/b.ts", previousPath: null, status: "modified", additions: 1, deletions: 1, binary: false,
    });
    expect(byPath(files, "GUIDE.md")).toMatchObject({ status: "renamed", previousPath: "README.md", additions: 0, deletions: 0 });
    expect(byPath(files, "old.txt")).toMatchObject({ status: "deleted", additions: 0, deletions: 3 });
    expect(byPath(files, "notes.txt")).toMatchObject({ status: "untracked", additions: 3, deletions: 0, binary: false });
    expect(byPath(files, "image.bin")).toMatchObject({ status: "untracked", additions: null, deletions: null, binary: true });
  });

  it("works in a repository that has no commit yet", async () => {
    const files = filesOf(await repoFiles(unborn, { type: "uncommitted" }));
    expect(byPath(files, "staged.txt")).toMatchObject({ status: "added", additions: 2, deletions: 0 });
    expect(byPath(files, "loose.txt")).toMatchObject({ status: "untracked", additions: 1 });
  });

  it("reports a detached HEAD as no branch", async () => {
    const sha = git(work, "rev-parse", "HEAD").trim();
    const detached = join(scratch, "detached");
    execFileSync("git", ["clone", "-q", work, detached]);
    git(detached, "checkout", "-q", "--detach", sha);
    expect(await repoFiles(detached, { type: "uncommitted" })).toMatchObject({ outcome: "available", branch: null });
  });
});

describe("repoFiles merge-base", () => {
  it("compares with origin/HEAD, so committed and uncommitted work both show", async () => {
    const output = await repoFiles(work, { type: "merge-base", base: null });
    expect(output).toMatchObject({ outcome: "available", branch: "feature", base: "origin/main", aheadCount: 1 });
    const files = filesOf(output);
    expect(byPath(files, "src/a.ts")).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    expect(byPath(files, "src/feature.ts")).toMatchObject({ status: "added", additions: 1 });
    expect(byPath(files, "GUIDE.md")).toMatchObject({ status: "renamed", previousPath: "README.md" });
    expect(byPath(files, "notes.txt")).toMatchObject({ status: "untracked", additions: 3 });
  });

  it("takes an explicit base", async () => {
    const output = await repoFiles(work, { type: "merge-base", base: "origin/main" });
    expect(output).toMatchObject({ outcome: "available", base: "origin/main", aheadCount: 1 });
  });

  it("falls back to the uncommitted changes when there is no base", async () => {
    const output = await repoFiles(unborn, { type: "merge-base", base: null });
    expect(output).toMatchObject({ outcome: "available", base: null });
    expect(byPath(filesOf(output), "loose.txt")).toBeDefined();
  });

  it("reports an unknown base as a missing ref", async () => {
    expect(await repoFiles(work, { type: "merge-base", base: "origin/nope" })).toMatchObject({
      outcome: "unavailable", reason: "missing-ref",
    });
  });
});

describe("repoFiles range", () => {
  it("shows the branch's own commits and counts them", async () => {
    const output = await repoFiles(work, { type: "range", base: "origin/main", head: "feature" });
    expect(output).toMatchObject({ outcome: "available", branch: "feature", base: "origin/main", aheadCount: 1 });
    const files = filesOf(output);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/feature.ts"]);
    expect(byPath(files, "src/a.ts")).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
  });

  it("uses origin/HEAD when the base is null", async () => {
    expect(await repoFiles(work, { type: "range", base: null, head: "feature" })).toMatchObject({
      outcome: "available", base: "origin/main", aheadCount: 1,
    });
  });

  it("reports an unknown branch as a missing ref", async () => {
    expect(await repoFiles(work, { type: "range", base: "origin/main", head: "gone/branch" })).toMatchObject({
      outcome: "unavailable", reason: "missing-ref",
    });
  });
});

describe("repoFiles range history", () => {
  it("counts the commits the base has that the branch lacks", async () => {
    expect(await repoFiles(lagging, { type: "range", base: "origin/main", head: "topic" })).toMatchObject({
      outcome: "available", aheadCount: 2, behindCount: 1,
    });
  });

  it("lists the branch's commits newest first with the author time in milliseconds", async () => {
    const output = await repoFiles(lagging, { type: "range", base: "origin/main", head: "topic" });
    if (output.outcome !== "available") throw new Error(output.message);
    expect(output.commits.map((commit) => commit.subject)).toEqual(["second topic commit", "first topic commit"]);
    const head = git(lagging, "rev-parse", "topic").trim();
    const seconds = Number(git(lagging, "log", "-1", "--format=%at", "topic").trim());
    expect(output.commits[0]).toEqual({
      sha: head, shortSha: head.slice(0, output.commits[0]!.shortSha.length), authorName: "Test",
      authoredAt: seconds * 1000, subject: "second topic commit",
    });
    expect(output.commits[0]!.authoredAt).toBeGreaterThan(1_000_000_000_000);
  });

  it("reports no behind count and no commits for the other targets", async () => {
    expect(await repoFiles(lagging, { type: "merge-base", base: "origin/main" })).toMatchObject({ behindCount: null, commits: [] });
    expect(await repoFiles(lagging, { type: "uncommitted" })).toMatchObject({ behindCount: null, commits: [] });
  });
});

describe("repoFiles and repoPatch commit", () => {
  const featureSha = () => git(work, "rev-parse", "HEAD").trim();
  const rootSha = () => git(work, "rev-list", "--max-parents=0", "HEAD").trim();

  it("lists the files a commit changed against its parent", async () => {
    const output = await repoFiles(work, { type: "commit", sha: featureSha() });
    expect(output).toMatchObject({ outcome: "available", base: null, aheadCount: null, behindCount: null, commits: [], truncated: false });
    const files = filesOf(output);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/feature.ts"]);
    expect(byPath(files, "src/a.ts")).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    expect(byPath(files, "src/feature.ts")).toMatchObject({ status: "added", additions: 1, deletions: 0 });
  });

  it("returns the patch of a file in a commit", async () => {
    const result = patchOf(await repoPatch(work, "src/a.ts", { type: "commit", sha: featureSha() }));
    expect(result.patch).toContain("+export const c = 4;");
    expect(result.patch).not.toContain("+export const b = 2;\n+export const b");
  });

  it("diffs the root commit against the empty tree", async () => {
    const files = filesOf(await repoFiles(work, { type: "commit", sha: rootSha() }));
    expect(files.map((file) => file.path)).toEqual(["README.md", "old.txt", "src/a.ts", "src/b.ts"]);
    expect(files.every((file) => file.status === "added")).toBe(true);
    const result = patchOf(await repoPatch(work, "old.txt", { type: "commit", sha: rootSha() }));
    expect(result.patch).toContain("+one");
    expect(result.patch).toContain("new file mode");
  });

  it("accepts an abbreviated sha", async () => {
    const files = filesOf(await repoFiles(work, { type: "commit", sha: featureSha().slice(0, 9) }));
    expect(files).toHaveLength(2);
  });

  it("reports an unknown commit as a git failure", async () => {
    expect(await repoFiles(work, { type: "commit", sha: "0123456789abcdef" })).toMatchObject({ outcome: "unavailable", reason: "git-failed" });
    expect(await repoPatch(work, "src/a.ts", { type: "commit", sha: "0123456789abcdef" })).toMatchObject({
      outcome: "unavailable", reason: "git-failed",
    });
  });

  it("refuses a sha that is not hex before git is asked", async () => {
    await expect(repoFiles(work, { type: "commit", sha: "zz" })).rejects.toThrow();
    await expect(repoPatch(work, "src/a.ts", { type: "commit", sha: "--output=x1" })).rejects.toThrow();
  });
});

describe("repoPatch", () => {
  it("returns the patch of a tracked file", async () => {
    const result = patchOf(await repoPatch(work, "src/b.ts", { type: "uncommitted" }));
    expect(result).toMatchObject({ truncated: false, binary: false });
    expect(result.patch).toContain("-export const b = 1;");
    expect(result.patch).toContain("+export const b = 2;");
  });

  it("returns the patch of an untracked file with --no-index", async () => {
    const result = patchOf(await repoPatch(work, "notes.txt", { type: "uncommitted" }, { untracked: true }));
    expect(result.patch).toContain("+one");
    expect(result.patch).toContain("+three");
    expect(result.binary).toBe(false);
  });

  it("flags a binary file", async () => {
    const result = patchOf(await repoPatch(work, "image.bin", { type: "uncommitted" }, { untracked: true }));
    expect(result.binary).toBe(true);
  });

  it("follows a rename through its previous path", async () => {
    const result = patchOf(await repoPatch(work, "GUIDE.md", { type: "uncommitted" }, { previousPath: "README.md" }));
    expect(result.patch).toContain("rename from README.md");
    expect(result.patch).toContain("rename to GUIDE.md");
  });

  it("returns a committed change for the merge-base and range targets", async () => {
    const mergeBase = patchOf(await repoPatch(work, "src/a.ts", { type: "merge-base", base: null }));
    expect(mergeBase.patch).toContain("+export const c = 4;");
    const range = patchOf(await repoPatch(work, "src/feature.ts", { type: "range", base: "origin/main", head: "feature" }));
    expect(range.patch).toContain("+export const feature = true;");
  });

  it("uses the empty tree when the repository has no commit", async () => {
    const result = patchOf(await repoPatch(unborn, "staged.txt", { type: "uncommitted" }));
    expect(result.patch).toContain("+a");
  });

  it("cuts a patch above 1 MiB on a line boundary", async () => {
    const big = join(scratch, "big");
    mkdirSync(big);
    git(big, "init", "-q", "-b", "main");
    put(big, "seed.txt", "seed\n");
    commitAll(big, "seed");
    put(big, "huge.txt", Array.from({ length: 30_000 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n") + "\n");
    const result = patchOf(await repoPatch(big, "huge.txt", { type: "uncommitted" }, { untracked: true }));
    expect(result.truncated).toBe(true);
    expect(result.patch.length).toBeLessThanOrEqual(1_048_576);
    expect(result.patch.endsWith("\n")).toBe(true);
  });
});

describe("failures", () => {
  it("rejects unsafe paths and refs as invalid input", async () => {
    expect(await repoPatch(work, "../x", { type: "uncommitted" })).toMatchObject({ outcome: "unavailable", reason: "invalid-input" });
    expect(await repoPatch(work, "src/b.ts", { type: "uncommitted" }, { previousPath: "/etc/passwd" })).toMatchObject({
      outcome: "unavailable", reason: "invalid-input",
    });
    expect(await repoFiles(work, { type: "range", base: "origin/main", head: "-x" })).toMatchObject({
      outcome: "unavailable", reason: "invalid-input",
    });
    expect(await repoFiles(work, { type: "range", base: "a..b", head: "feature" })).toMatchObject({
      outcome: "unavailable", reason: "invalid-input",
    });
    expect(await repoFiles(work, { type: "merge-base", base: "--output=x" })).toMatchObject({
      outcome: "unavailable", reason: "invalid-input",
    });
  });

  it("rejects a root that is a subdirectory of a repository", async () => {
    expect(await repoFiles(join(work, "src"), { type: "uncommitted" })).toMatchObject({
      outcome: "unavailable", reason: "invalid-input",
    });
    expect(await repoPatch(join(work, "src"), "b.ts", { type: "uncommitted" })).toMatchObject({
      outcome: "unavailable", reason: "invalid-input",
    });
  });

  it("reports a folder that is not a repository", async () => {
    expect(await repoFiles(plain, { type: "uncommitted" })).toMatchObject({ outcome: "unavailable", reason: "not-a-repo" });
    expect(await repoFiles(join(scratch, "vanished"), { type: "uncommitted" })).toMatchObject({
      outcome: "unavailable", reason: "not-a-repo",
    });
  });

  it("still reads a repository while another git process holds the index lock", async () => {
    const lock = join(work, ".git", "index.lock");
    writeFileSync(lock, "");
    try {
      expect(await repoFiles(work, { type: "uncommitted" })).toMatchObject({ outcome: "available" });
    } finally {
      rmSync(lock);
    }
  });
});
