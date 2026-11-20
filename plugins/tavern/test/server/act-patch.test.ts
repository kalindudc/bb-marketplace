// @vitest-environment node
import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRebaseMatches } from "../../src/server/act-patch";
it("compares immutable home repository objects against an explicit destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "tavern-act-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
    writeFileSync(join(root, "base"), "base\n"); git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "work"), "patch\n"); git("add", "."); git("commit", "-qm", "work"); const verified = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach", base); writeFileSync(join(root, "other"), "unrelated\n"); git("add", "."); git("commit", "-qm", "new base"); const destination = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", destination); git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"); git("cherry-pick", verified); const rebased = git("rev-parse", "HEAD");
    expect(await cleanRebaseMatches(join(root, ".git"), verified, rebased, destination)).toBe(true);
    writeFileSync(join(root, "work"), "different\n");
    git("add", "."); git("commit", "-qm", "different"); expect(await cleanRebaseMatches(join(root, ".git"), verified, git("rev-parse", "HEAD"), destination)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
