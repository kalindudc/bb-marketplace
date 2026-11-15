import { execFileSync } from "node:child_process";
import { join } from "node:path";
export function linkedWorktree(root: string) {
  const main = join(root, "main"), worktree = join(root, "work");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Tavern test", "-c", "user.email=tavern@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "config", "core.hooksPath", "/dev/null");
  git(main, "commit", "--allow-empty", "-qm", "fixture");
  git(main, "worktree", "add", "-qb", "topic", worktree);
  return { main, worktree, git };
}
