// @vitest-environment node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { linkedWorktree } from "./git-fixture";
import { sandboxCommand } from "../../src/scope/sandbox";
import { scopeForClass } from "../../src/scope/presets";

it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))("allows a Smith to commit, branch and stash in its linked worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "tavern-linked-probe-"));
  try {
    const { worktree, git } = linkedWorktree(root);
    const scope = scopeForClass("smith");
    writeFileSync(join(worktree, "file"), "one\n");
    const run = (command: string) => spawnSync("/bin/bash", ["-c", sandboxCommand(scope, command)], { cwd: worktree, encoding: "utf8" });
    const commit = run("git add file && git -c user.name=Tavern -c user.email=tavern@example.invalid -c commit.gpgsign=false commit -qm probe && git checkout -qb probe-branch");
    expect(commit.status, commit.stderr).toBe(0); expect(git(worktree, "log", "-1", "--format=%s").trim()).toBe("probe");
    writeFileSync(join(worktree, "file"), "two\n");
    const stash = run("git stash push -qm probe-stash"); expect(stash.status).toBe(0); expect(git(worktree, "stash", "list")).toContain("probe-stash");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
