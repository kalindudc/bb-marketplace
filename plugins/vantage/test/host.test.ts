// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host";
import { GitRunnerError } from "../src/git-process";
import type { HostInput, HostOutput } from "../src/contract";

type Files = Extract<HostOutput<"repoFiles">, { outcome: "available" }>["files"];
type Patch = Extract<HostOutput<"repoPatch">, { outcome: "available" }>;

const commands = vi.hoisted(() => [] as string[][]);
const rootFault = vi.hoisted(() => ({ git: null as GitRunnerError | string | null, fs: null as string | null }));
const probes = vi.hoisted(() => [] as string[]);
vi.mock(import("node:fs/promises"), async (original) => {
  const fs = await original();
  return {
    ...fs,
    realpath: ((...args: Parameters<typeof fs.realpath>) => {
      probes.push(String(args[0]));
      if (rootFault.fs !== null && args[0] === work)
        return Promise.reject(Object.assign(new Error("Root filesystem is unavailable"), { code: rootFault.fs }));
      return fs.realpath(...args);
    }) as typeof fs.realpath,
  };
});
vi.mock(import("../src/git-process"), async (original) => {
  const { createGitRunner, ...exports } = await original();
  return {
    ...exports,
    createGitRunner: () => {
      const runner = createGitRunner();
      return {
        ...runner,
        run(...args: Parameters<typeof runner.run>) {
          commands.push([...args[1]]);
          const fault = rootFault.git;
          if (fault !== null && args[0] === work && args[1].join(" ") === "rev-parse --show-toplevel") {
            if (typeof fault !== "string") return Promise.reject(fault);
            return Promise.resolve({ code: 128, stdout: Buffer.alloc(0), stderr: Buffer.from(fault) });
          }
          return runner.run(...args);
        },
      };
    },
  };
});

const harness = experimental_createHostEntryHarness(hostEntry);
const savedEnv: Record<string, string | undefined> = {};
const HERMETIC_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "t@example.com",
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
const repoFiles = (root: string, target: HostInput<"repoFiles">["target"]) =>
  harness.experimental_call("repoFiles", { root, target });
const repoPatch = (
  root: string,
  path: string,
  target: HostInput<"repoPatch">["target"],
  extra: Partial<HostInput<"repoPatch">> = {},
) => harness.experimental_call("repoPatch", { root, path, previousPath: null, untracked: false, target, ...extra });
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
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = scratch;
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
  git(work, "config", "diff.renames", "true");
  git(work, "config", "status.renames", "true");
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
      paths: [join(work, "src/a.ts"), join(work, "old.txt"), join(work, "gone/deep/x.ts"), work, join(work, "src")],
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

  it("shares the missing parent walk without losing a nested repository boundary", async () => {
    const outer = join(scratch, "outer");
    const inner = join(outer, "nested");
    mkdirSync(inner, { recursive: true });
    git(outer, "init", "-q");
    git(inner, "init", "-q", "--separate-git-dir", join(scratch, "nested-git"));
    const missing = join(inner, "missing");
    const before = probes.length;
    const { results } = await harness.experimental_call("resolveRoots", {
      paths: [outer, inner, ...["deep/a", "deep/b", "other/c"].map((file) => join(missing, file))],
    });
    expect(results.map(({ root, relative }) => [root, relative])).toEqual([
      [outer, ""],
      [inner, ""],
      [inner, "missing/deep/a"],
      [inner, "missing/deep/b"],
      [inner, "missing/other/c"],
    ]);
    expect(probes.slice(before).filter((path) => path === missing)).toHaveLength(1);
    expect(probes.slice(before).filter((path) => path === inner)).toHaveLength(1);
  });

  it("does at most 40 directory walks for a batch of 40 existing directories across three repositories", async () => {
    const roots = ["one", "two", "three"].map((name) => {
      const root = join(scratch, `many-${name}`);
      mkdirSync(root);
      git(root, "init", "-q");
      return root;
    });
    const paths = Array.from({ length: 40 }, (_, index) => {
      const path = join(roots[index % roots.length]!, `dir-${index}`);
      mkdirSync(path);
      return path;
    });
    const before = { fs: probes.length, git: commands.length };
    const { results } = await harness.experimental_call("resolveRoots", { paths });
    expect(results.map(({ root }) => root)).toEqual(paths.map((_, index) => roots[index % roots.length]));
    expect(probes.slice(before.fs)).toHaveLength(40);
    expect(commands.slice(before.git)).toHaveLength(40);
  });

  it("refuses configured paths before probing the filesystem or Git", async () => {
    const before = { fs: probes.length, git: commands.length };
    const paths = [join(scratch, "checkouts/nested/src/zone"), "~/checkouts/project"];
    expect(await harness.experimental_call("resolveRoots", { paths, excludedRoots: ["~/checkouts"] })).toEqual({
      results: paths.map((path) => ({ path, root: null, relative: null, excluded: true })),
    });
    expect({ fs: probes.length, git: commands.length }).toEqual(before);
  });

  it("returns null outside any repository", async () => {
    const { results } = await harness.experimental_call("resolveRoots", {
      paths: [join(plain, "file.txt"), join(plain, "missing/file.txt")],
    });
    expect(results.map(({ root, relative }) => ({ root, relative }))).toEqual([
      { root: null, relative: null },
      { root: null, relative: null },
    ]);
  });

  it("reports the root the way git prints it for a repository under /tmp", async () => {
    const expected = git(tmpRepo, "rev-parse", "--show-toplevel").trim();
    const { results } = await harness.experimental_call("resolveRoots", { paths: [join(tmpRepo, "dir/file.txt")] });
    expect(results[0]).toMatchObject({ root: expected, relative: "dir/file.txt" });
  });
});

describe("resolveRoots under the home folder", () => {
  it("expands ~/ against this machine's home folder and answers with the path it was asked", async () => {
    const home = process.env.HOME;
    process.env.HOME = scratch;
    try {
      const { results } = await harness.experimental_call("resolveRoots", {
        paths: ["~/work/src", "~/plain/file.txt"],
      });
      expect(results).toEqual([
        { path: "~/work/src", root: work, relative: "src" },
        { path: "~/plain/file.txt", root: null, relative: null },
      ]);
    } finally {
      process.env.HOME = home;
    }
  });

  it("refuses a relative path or a bare ~ before any git call", async () => {
    await expect(harness.experimental_call("resolveRoots", { paths: ["~"] })).rejects.toThrow();
    await expect(harness.experimental_call("resolveRoots", { paths: ["work/src"] })).rejects.toThrow();
  });
});

describe("verifyRoots", () => {
  it.each(["timeout", "queue-full", "start"] as const)("rethrows a Git runner %s failure", async (kind) => {
    rootFault.git = new GitRunnerError(kind, `Git verification ${kind}`);
    try {
      await expect(harness.experimental_call("verifyRoots", { roots: [work] })).rejects.toThrow(
        `Git verification ${kind}`,
      );
    } finally {
      rootFault.git = null;
    }
  });

  it("does not turn an unrelated Git exit or filesystem error into a missing root", async () => {
    rootFault.git = "fatal: detected dubious ownership in repository";
    try {
      await expect(harness.experimental_call("verifyRoots", { roots: [work] })).rejects.toThrow("dubious ownership");
    } finally {
      rootFault.git = null;
    }
    rootFault.fs = "EACCES";
    try {
      await expect(harness.experimental_call("verifyRoots", { roots: [work] })).rejects.toThrow(
        "Root filesystem is unavailable",
      );
    } finally {
      rootFault.fs = null;
    }
  });

  it("checks distinct roots with Git and rejects a deleted root and a non-top directory", async () => {
    const gone = join(scratch, "gone-root");
    mkdirSync(gone);
    git(gone, "init", "-q");
    expect(await harness.experimental_call("verifyRoots", { roots: [gone] })).toEqual({ invalidRoots: [] });
    rmSync(gone, { recursive: true });
    const below = join(work, "src");
    const before = { fs: probes.length, git: commands.length };
    expect(await harness.experimental_call("verifyRoots", { roots: [work, work, gone, below, plain] })).toEqual({
      invalidRoots: [gone, below, plain],
    });
    expect(commands.slice(before.git)).toEqual(Array.from({ length: 3 }, () => ["rev-parse", "--show-toplevel"]));
  });

  it("refuses excluded root verification before probing the filesystem or Git", async () => {
    const blocked = join(scratch, "checkouts/nested/src");
    const before = { fs: probes.length, git: commands.length };
    await expect(
      harness.experimental_call("verifyRoots", { roots: [blocked], excludedRoots: [join(scratch, "checkouts")] }),
    ).rejects.toThrow(/excluded/);
    expect({ fs: probes.length, git: commands.length }).toEqual(before);
  });
});

describe("checkoutStatus", () => {
  type Status = Extract<HostOutput<"checkoutStatus">, { outcome: "available" }>;
  const statusOf = async (root: string, base: string | null = null): Promise<Status> => {
    const output = await harness.experimental_call("checkoutStatus", { root, base });
    if (output.outcome !== "available") throw new Error(`unavailable: ${output.message}`);
    return output;
  };

  it("splits uncommitted from committed work and counts the commits against origin/HEAD", async () => {
    const status = await statusOf(work);
    expect(status).toMatchObject({
      branch: "feature",
      base: "origin/main",
      aheadCount: 1,
      behindCount: 0,
      truncated: false,
    });
    expect(status.commits.map((commit) => commit.subject)).toEqual(["feature work"]);
    expect(status.committed.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/feature.ts"]);
    expect(byPath(status.committed, "src/a.ts")).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    expect(status.uncommitted.map((file) => file.path).sort()).toEqual([
      "GUIDE.md",
      "README.md",
      "image.bin",
      "notes.txt",
      "old.txt",
      "src/b.ts",
    ]);
  });

  it("uses at most six Git processes for a dirty checkout when HEAD and base refs are unchanged", async () => {
    const input = { root: work, base: "origin/main", pick: true };
    const first = await harness.experimental_call("checkoutStatus", input);
    expect(first).toMatchObject({ outcome: "available", branch: "feature", aheadCount: 1 });
    commands.length = 0;
    expect(await harness.experimental_call("checkoutStatus", input)).toEqual(first);
    expect(commands.find((args) => args[0] === "status")).toContain("--porcelain=v2");
    expect(commands.map((args) => args[0])).toHaveLength(5);
  });

  it("recomputes branch history when a candidate ref moves but HEAD does not", async () => {
    const root = join(scratch, "moving-base");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "topic");
    put(root, "base.txt", "base\n");
    commitAll(root, "base");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    put(root, "work.txt", "work\n");
    commitAll(root, "work");
    const input = { root, base: "origin/main", pick: true };
    expect(await harness.experimental_call("checkoutStatus", input)).toMatchObject({
      outcome: "available",
      aheadCount: 1,
    });
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    commands.length = 0;
    expect(await harness.experimental_call("checkoutStatus", input)).toMatchObject({
      outcome: "available",
      aheadCount: 0,
      committed: [],
    });
    expect(commands.map((args) => args[0])).toHaveLength(3);
  });

  it("checks net working changes against HEAD when staged and unstaged edits cancel out", async () => {
    const root = join(scratch, "staged-then-restored");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    put(root, "a.txt", "base\n");
    commitAll(root, "base");
    put(root, "a.txt", "staged\n");
    git(root, "add", "a.txt");
    put(root, "a.txt", "base\n");
    const legacy = git(root, "-c", "diff.autoRefreshIndex=false", "diff", "--name-only", "-z", "HEAD")
      .split("\0")
      .filter(Boolean);
    commands.length = 0;
    const status = await statusOf(root);
    expect(commands.some((args) => args.includes("--raw"))).toBe(true);
    expect(status.uncommitted.map((file) => file.path)).toEqual(legacy);
    expect(status.uncommitted.every((file) => file.additions === null && file.deletions === null)).toBe(true);
  });

  it("reuses immutable patch metadata for file sides, and rechecks exclusions", async () => {
    const target = { type: "uncommitted" } as const;
    const input = { root: work, path: "src/b.ts", previousPath: null, untracked: false, target };
    expect(await harness.experimental_call("repoPatch", input)).toMatchObject({ outcome: "available" });
    commands.length = 0;
    expect(await harness.experimental_call("fileSides", input)).toMatchObject({
      outcome: "available",
      old: "export const b = 1;\n",
      new: "export const b = 2;\n",
    });
    expect(commands.length).toBeLessThanOrEqual(2);
    expect(await harness.experimental_call("fileSides", { ...input, excludedRoots: [work] })).toMatchObject({
      outcome: "unavailable",
    });
  });

  it("counts the commits the base has that the checkout lacks", async () => {
    const status = await statusOf(lagging);
    expect(status).toMatchObject({ branch: "topic", aheadCount: 2, behindCount: 1, uncommitted: [] });
    expect(status.committed.map((file) => file.path).sort()).toEqual(["one.txt", "two.txt"]);
  });

  it("still lists uncommitted files when there is no base to compare with", async () => {
    const status = await statusOf(unborn);
    expect(status).toMatchObject({ base: null, aheadCount: null, behindCount: null, committed: [], commits: [] });
    expect(status.uncommitted.map((file) => file.path).sort()).toEqual(["loose.txt", "staged.txt"]);
    expect((await statusOf(work, "no-such-base")).base).toBeNull();
  });

  it("reports a folder that is not a repository", async () => {
    expect(await harness.experimental_call("checkoutStatus", { root: plain, base: null })).toMatchObject({
      outcome: "unavailable",
      reason: "not-a-repo",
    });
  });
});

describe("repoFiles and repoPatch committed", () => {
  it("shows only what is committed since the merge base, not the working tree", async () => {
    const output = await repoFiles(work, { type: "committed", base: null });
    expect(output).toMatchObject({ outcome: "available", branch: "feature", base: "origin/main" });
    expect(
      filesOf(output)
        .map((file) => file.path)
        .sort(),
    ).toEqual(["src/a.ts", "src/feature.ts"]);
    expect(patchOf(await repoPatch(work, "src/a.ts", { type: "committed", base: null })).patch).toContain(
      "+export const c = 4;",
    );
    expect(patchOf(await repoPatch(work, "src/b.ts", { type: "committed", base: null })).patch).toBe("");
  });

  it("reports a checkout with no base as a missing ref", async () => {
    expect(await repoFiles(unborn, { type: "committed", base: null })).toMatchObject({
      outcome: "unavailable",
      reason: "missing-ref",
    });
  });
});

describe("repoFiles uncommitted", () => {
  it("lists modified, added, deleted, untracked and binary files with counts", async () => {
    const output = await repoFiles(work, { type: "uncommitted" });
    expect(output).toMatchObject({
      outcome: "available",
      branch: "feature",
      base: null,
      aheadCount: null,
      truncated: false,
    });
    const files = filesOf(output);
    expect(files.map((file) => file.path)).toEqual([
      "GUIDE.md",
      "README.md",
      "image.bin",
      "notes.txt",
      "old.txt",
      "src/b.ts",
    ]);
    expect(byPath(files, "src/b.ts")).toEqual({
      path: "src/b.ts",
      previousPath: null,
      status: "modified",
      additions: 1,
      deletions: 1,
      binary: false,
    });
    expect(byPath(files, "GUIDE.md")).toMatchObject({
      status: "added",
      previousPath: null,
      additions: 3,
      deletions: 0,
    });
    expect(byPath(files, "README.md")).toMatchObject({
      status: "deleted",
      previousPath: null,
      additions: 0,
      deletions: 3,
    });
    expect(byPath(files, "old.txt")).toMatchObject({ status: "deleted", additions: 0, deletions: 3 });
    expect(byPath(files, "notes.txt")).toMatchObject({
      status: "untracked",
      additions: 3,
      deletions: 0,
      binary: false,
    });
    expect(byPath(files, "image.bin")).toMatchObject({
      status: "untracked",
      additions: null,
      deletions: null,
      binary: true,
    });
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
    expect(byPath(files, "GUIDE.md")).toMatchObject({ status: "added", previousPath: null });
    expect(byPath(files, "README.md")).toMatchObject({ status: "deleted", previousPath: null });
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
      outcome: "unavailable",
      reason: "missing-ref",
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
      outcome: "available",
      base: "origin/main",
      aheadCount: 1,
    });
  });

  it("reports an unknown branch as a missing ref", async () => {
    expect(await repoFiles(work, { type: "range", base: "origin/main", head: "gone/branch" })).toMatchObject({
      outcome: "unavailable",
      reason: "missing-ref",
    });
  });
});

describe("repoFiles range history", () => {
  it("counts the commits the base has that the branch lacks", async () => {
    expect(await repoFiles(lagging, { type: "range", base: "origin/main", head: "topic" })).toMatchObject({
      outcome: "available",
      aheadCount: 2,
      behindCount: 1,
    });
  });

  it("lists the branch's commits newest first with the author time in milliseconds", async () => {
    const output = await repoFiles(lagging, { type: "range", base: "origin/main", head: "topic" });
    if (output.outcome !== "available") throw new Error(output.message);
    expect(output.commits.map((commit) => commit.subject)).toEqual(["second topic commit", "first topic commit"]);
    const head = git(lagging, "rev-parse", "topic").trim();
    const seconds = Number(git(lagging, "log", "-1", "--format=%at", "topic").trim());
    expect(output.commits[0]).toEqual({
      sha: head,
      shortSha: head.slice(0, output.commits[0]!.shortSha.length),
      authorName: "Test",
      authoredAt: seconds * 1000,
      subject: "second topic commit",
    });
    expect(output.commits[0]!.authoredAt).toBeGreaterThan(1_000_000_000_000);
  });

  it("reports no behind count and no commits for the other targets", async () => {
    expect(await repoFiles(lagging, { type: "merge-base", base: "origin/main" })).toMatchObject({
      behindCount: null,
      commits: [],
    });
    expect(await repoFiles(lagging, { type: "uncommitted" })).toMatchObject({ behindCount: null, commits: [] });
  });
});

describe("repoFiles and repoPatch commit", () => {
  const featureSha = () => git(work, "rev-parse", "HEAD").trim();
  const rootSha = () => git(work, "rev-list", "--max-parents=0", "HEAD").trim();

  it("lists the files a commit changed against its parent", async () => {
    const output = await repoFiles(work, { type: "commit", sha: featureSha() });
    expect(output).toMatchObject({
      outcome: "available",
      base: null,
      aheadCount: null,
      behindCount: null,
      commits: [],
      truncated: false,
    });
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
    expect(await repoFiles(work, { type: "commit", sha: "0123456789abcdef" })).toMatchObject({
      outcome: "unavailable",
      reason: "git-failed",
    });
    expect(await repoPatch(work, "src/a.ts", { type: "commit", sha: "0123456789abcdef" })).toMatchObject({
      outcome: "unavailable",
      reason: "git-failed",
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

  it.each([
    ["committed", "config"],
    ["commit", "config"],
    ["uncommitted", "config"],
    ["uncommitted", "config[old]*"],
  ] as const)("diffs a deleted file whose path became a folder (%s, %s)", async (type, path) => {
    const root = mkdtempSync(join(scratch, "file-to-folder-"));
    git(root, "init", "-q", "-b", "main");
    put(root, path, "old config\n");
    commitAll(root, "base");
    git(root, "checkout", "-q", "-b", "feature");
    rmSync(join(root, path));
    put(root, `${path}/settings.json`, "folder contents\n");
    put(root, `${path}/large.bin`, "");
    truncateSync(join(root, path, "large.bin"), 1_048_577);
    git(root, "add", "-A");
    if (type !== "uncommitted") git(root, "commit", "-q", "-m", "use a folder");
    const target: HostInput<"repoPatch">["target"] =
      type === "commit"
        ? { type, sha: git(root, "rev-parse", "HEAD").trim() }
        : type === "committed"
          ? { type, base: "main" }
          : { type };

    expect(byPath(filesOf(await repoFiles(root, target)), path)).toMatchObject({ status: "deleted" });
    const { patch, truncated } = patchOf(await repoPatch(root, path, target));
    expect(truncated).toBe(false);
    expect(patch).toContain("deleted file mode");
    expect(patch).toContain("-old config");
    expect(patch.match(/^diff --git /gm)).toHaveLength(1);
    expect(patch).not.toContain("settings.json");
    expect(patch).not.toContain("folder contents");
    expect(
      await harness.experimental_call("fileSides", {
        root,
        path,
        previousPath: null,
        untracked: false,
        target,
      }),
    ).toEqual({ outcome: "available", old: "old config\n", new: null });
  });

  it.each(["unstaged", "staged"] as const)("diffs a deleted file whose folder became a file (%s)", async (stage) => {
    const root = mkdtempSync(join(scratch, "folder-to-file-"));
    git(root, "init", "-q", "-b", "main");
    const path = "assets/logo.svg";
    const before = '<svg id="before"/>\n';
    put(root, path, before);
    commitAll(root, "base");
    rmSync(join(root, "assets"), { recursive: true });
    put(root, "assets", "now a file\n");
    if (stage === "staged") git(root, "add", "-A");
    const target = { type: "uncommitted" } as const;

    expect(byPath(filesOf(await repoFiles(root, target)), path)).toMatchObject({ status: "deleted" });
    const { patch } = patchOf(await repoPatch(root, path, target));
    expect(patch.match(/^diff --git /gm)).toHaveLength(1);
    expect(patch).toContain("deleted file mode");
    expect(patch).not.toContain("now a file");
    const input = { root, path, previousPath: null, untracked: false, target };
    expect.soft(await harness.experimental_call("fileSides", input)).toEqual({
      outcome: "available",
      old: before,
      new: null,
    });
    expect.soft(await harness.experimental_call("imageSides", input)).toEqual({
      outcome: "available",
      old: Buffer.from(before).toString("base64"),
      new: null,
      truncated: false,
    });
  });

  it("still refuses symlinks and staged or committed submodules", async () => {
    const root = join(scratch, "patch-non-regular");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    put(root, "target.txt", "target\n");
    commitAll(root, "base");
    git(root, "checkout", "-q", "-b", "feature");
    symlinkSync("target.txt", join(root, "link"));
    git(root, "add", "link");
    git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD").trim()},module`);

    expect(await repoPatch(root, "link", { type: "uncommitted" })).toMatchObject({
      outcome: "unavailable",
      reason: "invalid-input",
    });
    mkdirSync(join(root, "module"));
    expect(await repoPatch(root, "module", { type: "uncommitted" })).toMatchObject({
      outcome: "unavailable",
      message: "A staged file is too large or unavailable",
    });
    git(root, "commit", "-q", "-m", "non-regular entries");
    for (const path of ["link", "module"]) {
      expect(await repoPatch(root, path, { type: "committed", base: "main" })).toMatchObject({
        outcome: "unavailable",
        message: "Only regular files can be diffed",
      });
    }
  });

  it("flags a binary file", async () => {
    const result = patchOf(await repoPatch(work, "image.bin", { type: "uncommitted" }, { untracked: true }));
    expect(result.binary).toBe(true);
  });

  it("shows add and delete with a legacy previous path without enabling rename detection", async () => {
    const result = patchOf(await repoPatch(work, "GUIDE.md", { type: "uncommitted" }, { previousPath: "README.md" }));
    expect(result.patch).toContain("new file mode");
    expect(result.patch).toContain("deleted file mode");
    expect(result.patch).not.toContain("rename from");
  });

  it.each(["added", "deleted"] as const)(
    "uses only the selected path for overlapping legacy sides (%s)",
    async (status) => {
      const root = mkdtempSync(join(scratch, "legacy-overlap-"));
      git(root, "init", "-q", "-b", "main");
      const parent = "diagram.svg";
      const child = `${parent}/view.svg`;
      const before = '<svg id="before"/>\n';
      const after = '<svg id="after"/>\n';
      put(root, parent, before);
      commitAll(root, "base");
      rmSync(join(root, parent));
      put(root, child, after);
      git(root, "add", "-A");

      const added = status === "added";
      const path = added ? child : parent;
      const previousPath = added ? parent : child;
      const target = { type: "uncommitted" } as const;
      const { patch } = patchOf(await repoPatch(root, path, target, { previousPath }));
      expect(patch.match(/^diff --git /gm)).toHaveLength(1);
      expect(patch).toContain(added ? "new file mode" : "deleted file mode");
      const input = { root, path, previousPath, untracked: false, target };
      expect.soft(await harness.experimental_call("fileSides", input)).toEqual({
        outcome: "available",
        old: added ? null : before,
        new: added ? after : null,
      });
      expect.soft(await harness.experimental_call("imageSides", input)).toEqual({
        outcome: "available",
        old: added ? null : Buffer.from(before).toString("base64"),
        new: added ? Buffer.from(after).toString("base64") : null,
        truncated: false,
      });
    },
  );

  it("returns a committed change for the merge-base and range targets", async () => {
    const mergeBase = patchOf(await repoPatch(work, "src/a.ts", { type: "merge-base", base: null }));
    expect(mergeBase.patch).toContain("+export const c = 4;");
    const range = patchOf(
      await repoPatch(work, "src/feature.ts", { type: "range", base: "origin/main", head: "feature" }),
    );
    expect(range.patch).toContain("+export const feature = true;");
  });

  it("uses the empty tree when the repository has no commit", async () => {
    const result = patchOf(await repoPatch(unborn, "staged.txt", { type: "uncommitted" }));
    expect(result.patch).toContain("+a");
  });

  it("refuses a large untracked file before generating a patch", async () => {
    const big = join(scratch, "big");
    mkdirSync(big);
    git(big, "init", "-q", "-b", "main");
    put(big, "huge.txt", "");
    truncateSync(join(big, "huge.txt"), 1_048_577);
    expect(await repoPatch(big, "huge.txt", { type: "uncommitted" }, { untracked: true })).toMatchObject({
      outcome: "unavailable",
      message: expect.stringMatching(/too large/),
    });
  });
});

describe("checkoutStatus with the closest base", () => {
  type Status = Extract<HostOutput<"checkoutStatus">, { outcome: "available" }>;
  let stale: string;
  let renamed: string;
  let folders: string;
  const statusOf = async (root: string, base: string | null, pick: boolean, folderLimit?: number): Promise<Status> => {
    const output = await harness.experimental_call("checkoutStatus", {
      root,
      base,
      pick,
      ...(folderLimit === undefined ? {} : { folderLimit }),
    });
    if (output.outcome !== "available") throw new Error(`unavailable: ${output.message}`);
    return output;
  };

  beforeAll(() => {
    const upstream = join(scratch, "pick-upstream");
    mkdirSync(upstream);
    git(upstream, "init", "-q", "-b", "main");
    for (const name of ["a", "b", "c"]) {
      put(upstream, `${name}.txt`, `${name}\n`);
      commitAll(upstream, `upstream ${name}`);
    }
    // A local main left two commits behind origin/main, and a branch started from origin/main.
    stale = join(scratch, "pick-stale");
    execFileSync("git", ["clone", "-q", upstream, stale]);
    git(stale, "checkout", "-q", "-b", "feature", "origin/main");
    git(stale, "branch", "-f", "main", "HEAD~2");
    put(stale, "mine.txt", "mine\n");
    commitAll(stale, "my one commit");

    // A checkout on main, level with origin/main, whose recorded base is an old master.
    renamed = join(scratch, "pick-renamed");
    execFileSync("git", ["clone", "-q", upstream, renamed]);
    git(renamed, "branch", "master", "HEAD~2");

    folders = join(scratch, "pick-folders");
    execFileSync("git", ["clone", "-q", upstream, folders]);
    for (const name of ["1", "2", "3", "4", "5"]) put(folders, `vendor/lib/${name}.js`, "x\n");
    put(folders, "small/one.txt", "one\n");
    put(folders, "small/two.txt", "two\n");
    const clone = join(folders, "copy");
    execFileSync("git", ["clone", "-q", upstream, clone]);
  });

  it("compares with origin/main instead of a local main that fell behind, and says what it skipped", async () => {
    const picked = await statusOf(stale, "main", true);
    expect(picked).toMatchObject({
      branch: "feature",
      base: "origin/main",
      aheadCount: 1,
      skippedBase: { name: "main", aheadCount: 3 },
    });
    expect(picked.committed.map((file) => file.path)).toEqual(["mine.txt"]);
    expect(picked.head).toBe(git(stale, "rev-parse", "HEAD").trim());
    const asked = await statusOf(stale, "main", false);
    expect(asked).toMatchObject({ base: "main", aheadCount: 3, skippedBase: null });
    expect(asked.committed.map((file) => file.path).sort()).toEqual(["b.txt", "c.txt", "mine.txt"]);
  });

  it("treats a checkout on main as level with origin/main, not ahead of an old master", async () => {
    const picked = await statusOf(renamed, "master", true);
    expect(picked).toMatchObject({
      branch: "main",
      base: "origin/main",
      aheadCount: 0,
      committed: [],
      skippedBase: { name: "master", aheadCount: 2 },
    });
    expect(await statusOf(renamed, "master", false)).toMatchObject({ base: "master", aheadCount: 2 });
  });

  it("matches the old chooseBase results across its recorded, closer, level and missing base cases", async () => {
    const cases = [
      { root: stale, requested: "main", pick: true, expected: ["origin/main", 1, { name: "main", aheadCount: 3 }] },
      { root: stale, requested: "main", pick: false, expected: ["main", 3, null] },
      {
        root: renamed,
        requested: "master",
        pick: true,
        expected: ["origin/main", 0, { name: "master", aheadCount: 2 }],
      },
      { root: renamed, requested: "master", pick: false, expected: ["master", 2, null] },
      { root: work, requested: "origin/main", pick: true, expected: ["origin/main", 1, null] },
      { root: folders, requested: null, pick: true, expected: ["origin/main", 0, null] },
      { root: work, requested: "no-such-base", pick: false, expected: [null, null, null] },
    ];
    for (const { root, requested, pick, expected } of cases) {
      const { base, aheadCount, skippedBase } = await statusOf(root, requested, pick);
      expect([base, aheadCount, skippedBase]).toEqual(expected);
    }
  });

  it("keeps origin's default ahead of equally close fallback refs and an eligible local branch's upstream", async () => {
    const root = join(scratch, "pick-order");
    execFileSync("git", ["clone", "-q", renamed, root]);
    git(root, "update-ref", "refs/remotes/origin/stable", "origin/main");
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/stable");
    git(root, "branch", "--set-upstream-to", "origin/main", "main");
    expect(await statusOf(root, null, true)).toMatchObject({ base: "origin/stable", aheadCount: 0 });
  });

  it("resolves an abbreviated requested commit like chooseBase did with and without picking", async () => {
    const abbreviated = git(stale, "rev-parse", "--short=4", "HEAD").trim();
    for (const pick of [false, true]) {
      expect(await statusOf(stale, abbreviated, pick)).toMatchObject({ base: abbreviated, aheadCount: 0 });
    }
  });

  it("keeps the base asked for when nothing is closer", async () => {
    expect(await statusOf(work, "origin/main", true)).toMatchObject({
      base: "origin/main",
      aheadCount: 1,
      skippedBase: null,
    });
  });

  it("folds an untracked folder above the limit and one holding a repository into one entry each", async () => {
    const status = await statusOf(folders, null, true, 3);
    const paths = status.uncommitted.map((file) => file.path);
    expect(paths).toEqual(["copy/", "small/one.txt", "small/two.txt", "vendor/"]);
    expect(byPath(status.uncommitted, "vendor/")).toMatchObject({
      status: "untracked",
      additions: null,
      deletions: null,
      folder: {
        files: 5,
        repository: false,
        sample: ["vendor/lib/1.js", "vendor/lib/2.js", "vendor/lib/3.js", "vendor/lib/4.js", "vendor/lib/5.js"],
      },
    });
    expect(byPath(status.uncommitted, "copy/")?.folder).toMatchObject({ repository: true });
    expect(byPath(status.uncommitted, "small/one.txt")).toMatchObject({ additions: 1 });
    expect(byPath(status.uncommitted, "small/one.txt")).not.toHaveProperty("folder");
    const roomy = await statusOf(folders, null, true, 10);
    expect(roomy.uncommitted.map((file) => file.path)).toEqual([
      "copy/",
      "small/one.txt",
      "small/two.txt",
      "vendor/lib/1.js",
      "vendor/lib/2.js",
      "vendor/lib/3.js",
      "vendor/lib/4.js",
      "vendor/lib/5.js",
    ]);
  });
});

describe("threadCommits", () => {
  let mainline: string;
  const gitAt = (cwd: string, seconds: number, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_COMMITTER_DATE: `@${seconds} +0000` },
    });
  const commitAt = (seconds: number, message: string, extra: string[] = []) => {
    put(mainline, "log.txt", `${message}\n`);
    git(mainline, "add", "-A");
    gitAt(mainline, seconds, "commit", "-q", ...extra, "-m", message);
  };
  const around = (seconds: number) => ({ start: (seconds - 10) * 1000, end: (seconds + 10) * 1000 });
  const threadCommits = (root: string, windows: HostInput<"threadCommits">["windows"]) =>
    harness.experimental_call("threadCommits", { root, windows });

  beforeAll(() => {
    mainline = join(scratch, "mainline");
    mkdirSync(mainline);
    git(mainline, "init", "-q", "-b", "main");
    commitAt(1000, "base");
    commitAt(2000, "mine 1");
    commitAt(3000, "theirs");
    commitAt(4000, "mine 2");
    commitAt(4005, "mine 2, amended", ["--amend"]);
    git(mainline, "checkout", "-q", "-b", "side");
    commitAt(4500, "side work");
    git(mainline, "checkout", "-q", "main");
  });

  it("lists the commits made in the windows that are still on the checked-out branch, newest first", async () => {
    const result = await threadCommits(mainline, [around(2000), around(4000), around(4500)]);
    if (result.outcome !== "available") throw new Error(result.message);
    expect(result.commits.map((commit) => commit.subject)).toEqual(["mine 2, amended", "mine 1"]);
    expect(result.commits[0]).toMatchObject({ authorName: "Test", shortSha: expect.stringMatching(/^[0-9a-f]{7,}$/) });
  });

  it("names the commit before the oldest of them, so a diff from it shows only their work", async () => {
    const sha = (rev: string) => git(mainline, "rev-parse", rev).trim();
    const both = await threadCommits(mainline, [around(3000), around(4000)]);
    expect(both).toMatchObject({ outcome: "available", since: sha("main~2") });
    expect(await threadCommits(mainline, [around(4000)])).toMatchObject({ since: sha("main~1") });
    // The root commit has nothing before it.
    expect(await threadCommits(mainline, [around(1000)])).toMatchObject({ since: null });
  });

  it.each([
    { windows: [around(2000), around(4000)], total: 2, placement: "between" },
    { windows: [around(2000)], total: 1, placement: "after" },
  ])("names no starting commit when unrelated linear commits fall $placement", async ({ windows, total }) => {
    expect(await threadCommits(mainline, windows)).toMatchObject({ outcome: "available", total, since: null });
  });

  it("counts every one of them, and names no starting commit when a merge came after it", async () => {
    expect(await threadCommits(mainline, [around(2000), around(4000)])).toMatchObject({ total: 2 });
    const merging = join(scratch, "merging");
    execFileSync("git", ["clone", "-q", mainline, merging]);
    git(merging, "checkout", "-q", "-b", "work");
    put(merging, "mine.txt", "mine\n");
    git(merging, "add", "-A");
    gitAt(merging, 6000, "commit", "-q", "-m", "mine");
    git(merging, "checkout", "-q", "main");
    put(merging, "theirs.txt", "theirs\n");
    commitAll(merging, "theirs on main");
    git(merging, "checkout", "-q", "work");
    gitAt(merging, 7000, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    const result = await threadCommits(merging, [around(6000)]);
    expect(result).toMatchObject({ outcome: "available", total: 1, since: null });
  });

  it("leaves out commits made outside every window", async () => {
    const result = await threadCommits(mainline, [around(2000)]);
    expect(result.outcome === "available" && result.commits.map((commit) => commit.subject)).toEqual(["mine 1"]);
  });

  it("finds nothing in a repository with no commits, and refuses a folder that is not one", async () => {
    expect(await threadCommits(unborn, [around(2000)])).toEqual({
      outcome: "available",
      commits: [],
      total: 0,
      since: null,
    });
    expect(await threadCommits(plain, [around(2000)])).toMatchObject({ outcome: "unavailable", reason: "not-a-repo" });
  });
});

describe("failures", () => {
  it("rejects unsafe paths and refs as invalid input", async () => {
    expect(await repoPatch(work, "../x", { type: "uncommitted" })).toMatchObject({
      outcome: "unavailable",
      reason: "invalid-input",
    });
    expect(await repoPatch(work, "src/b.ts", { type: "uncommitted" }, { previousPath: "/etc/passwd" })).toMatchObject({
      outcome: "unavailable",
      reason: "invalid-input",
    });
    expect(await repoFiles(work, { type: "range", base: "origin/main", head: "-x" })).toMatchObject({
      outcome: "unavailable",
      reason: "invalid-input",
    });
    expect(await repoFiles(work, { type: "range", base: "a..b", head: "feature" })).toMatchObject({
      outcome: "unavailable",
      reason: "invalid-input",
    });
    expect(await repoFiles(work, { type: "merge-base", base: "--output=x" })).toMatchObject({
      outcome: "unavailable",
      reason: "invalid-input",
    });
  });

  it("rejects a root that is a subdirectory of a repository", async () => {
    expect(await repoFiles(join(work, "src"), { type: "uncommitted" })).toMatchObject({
      outcome: "unavailable",
      reason: "invalid-input",
    });
    expect(await repoPatch(join(work, "src"), "b.ts", { type: "uncommitted" })).toMatchObject({
      outcome: "unavailable",
      reason: "invalid-input",
    });
  });

  it("reports a folder that is not a repository", async () => {
    expect(await repoFiles(plain, { type: "uncommitted" })).toMatchObject({
      outcome: "unavailable",
      reason: "not-a-repo",
    });
    expect(await repoFiles(join(scratch, "vanished"), { type: "uncommitted" })).toMatchObject({
      outcome: "unavailable",
      reason: "not-a-repo",
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
