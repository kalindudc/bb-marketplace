// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host";
import type { HostInput } from "../src/contract";

const harness = experimental_createHostEntryHarness(hostEntry);
const ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com",
};
const saved: Record<string, string | undefined> = {};
let root: string;
let outside: string;
let sha: string;

const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
const sides = (path: string, target: HostInput<"fileSides">["target"], extra: Partial<HostInput<"fileSides">> = {}) =>
  harness.experimental_call("fileSides", { root, path, previousPath: null, untracked: false, target, ...extra });

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV)) { saved[key] = process.env[key]; process.env[key] = value; }
  root = realpathSync(mkdtempSync(join(tmpdir(), "vantage-sides-")));
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "a.txt"), "one\nTWO\n");
  writeFileSync(join(root, "added.txt"), "new\n");
  git("add", "-A");
  git("commit", "-q", "-m", "work");
  sha = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(root, "untracked.txt"), "fresh\n");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  symlinkSync("/etc/hosts", join(root, "link.txt"));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "vantage-outside-")));
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
  symlinkSync(outside, join(root, "escape"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe("fileSides", () => {
  it("reads HEAD and the working tree for an uncommitted change", async () => {
    expect(await sides("a.txt", { type: "uncommitted" })).toEqual({ outcome: "available", old: "one\nTWO\n", new: "one\nTWO\nthree\n" });
  });

  it("reads the merge base and HEAD for the committed change", async () => {
    expect(await sides("a.txt", { type: "committed", base: "main" })).toEqual({ outcome: "available", old: "one\ntwo\n", new: "one\nTWO\n" });
  });

  it("reads the parent and the commit for one commit, and no old side for a file the commit added", async () => {
    expect(await sides("a.txt", { type: "commit", sha })).toEqual({ outcome: "available", old: "one\ntwo\n", new: "one\nTWO\n" });
    expect(await sides("added.txt", { type: "commit", sha })).toEqual({ outcome: "available", old: null, new: "new\n" });
  });

  it("reads the merge base and the branch head for an archived branch", async () => {
    expect(await sides("a.txt", { type: "range", base: "main", head: "feature" })).toEqual({ outcome: "available", old: "one\ntwo\n", new: "one\nTWO\n" });
  });

  it("has only a new side for an untracked file, and never follows a symlink or sends a binary file", async () => {
    expect(await sides("untracked.txt", { type: "uncommitted" }, { untracked: true })).toEqual({ outcome: "available", old: null, new: "fresh\n" });
    expect(await sides("link.txt", { type: "uncommitted" }, { untracked: true })).toEqual({ outcome: "available", old: null, new: null });
    expect(await sides("binary.bin", { type: "uncommitted" }, { untracked: true })).toEqual({ outcome: "available", old: null, new: null });
  });

  it("never reads a file through a symlinked folder that points outside the repository", async () => {
    expect(await sides("escape/secret.txt", { type: "uncommitted" })).toEqual({ outcome: "available", old: null, new: null });
    expect(await sides("escape/secret.txt", { type: "uncommitted" }, { untracked: true })).toEqual({ outcome: "available", old: null, new: null });
    const patch = await harness.experimental_call("repoPatch", { root, path: "escape/secret.txt", previousPath: null, untracked: true, target: { type: "uncommitted" } });
    expect(patch).toMatchObject({ outcome: "unavailable", reason: "invalid-input" });
  });

  it("gives no content for a symlink or a folder stored in a commit, instead of failing", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "vantage-kinds-")));
    const run = (...args: string[]) => execFileSync("git", ["-C", scratch, ...args], { encoding: "utf8" });
    try {
      run("init", "-q", "-b", "main");
      writeFileSync(join(scratch, "a.txt"), "a\n");
      symlinkSync("a.txt", join(scratch, "link"));
      mkdirSync(join(scratch, "dir"));
      writeFileSync(join(scratch, "dir", "inner.txt"), "inner\n");
      run("add", "-A");
      run("commit", "-q", "-m", "kinds");
      const head = run("rev-parse", "HEAD").trim();
      const call = (path: string) => harness.experimental_call("fileSides", { root: scratch, path, previousPath: null, untracked: false, target: { type: "commit", sha: head } });
      expect(await call("link")).toEqual({ outcome: "available", old: null, new: null });
      expect(await call("dir")).toEqual({ outcome: "available", old: null, new: null });
      expect(await call("dir/inner.txt")).toEqual({ outcome: "available", old: null, new: "inner\n" });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses a path that leaves the repository", async () => {
    expect(await sides("../etc/passwd", { type: "uncommitted" })).toMatchObject({ outcome: "unavailable", reason: "invalid-input" });
  });
});
