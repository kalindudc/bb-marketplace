// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { homePullRequestRebaseMatches } from "../../src/server/pr-rebase";

it("replays against borrowed project objects without changing the checkout or accepting content changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-borrow-"));
  const project = join(root, "project"), remoteUrl = join(root, "remote.git"), work = join(root, "maker"), dataDir = join(root, "private");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (dir: string, file: string, content: string) => {
    writeFileSync(join(dir, file), content); git(dir, "add", file);
    git(dir, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-qm", file);
    return git(dir, "rev-parse", "HEAD");
  };
  try {
    mkdirSync(project);
    git(project, "init", "-qb", "main");
    commit(project, "base", "base\n");
    git(project, "worktree", "add", "-qb", "feature", work);
    const verified = commit(work, "feature", "valid\n");
    commit(project, "upstream", "upstream\n");
    git(root, "init", "-q", "--bare", remoteUrl);
    git(project, "push", remoteUrl, "HEAD:refs/heads/main");
    git(work, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "rebase", "main");
    const rebased = git(work, "rev-parse", "HEAD"), refs = git(project, "show-ref");
    expect(await homePullRequestRebaseMatches(work, { remoteUrl, dataDir, base: "main" }, verified, rebased)).toBe(true);
    expect(git(project, "show-ref")).toBe(refs);
    expect(readdirSync(dataDir)).toEqual([]);
    const changed = commit(work, "feature", "changed\n");
    expect(await homePullRequestRebaseMatches(work, { remoteUrl, dataDir, base: "main" }, verified, changed)).toBe(false);
    expect(readdirSync(dataDir)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
