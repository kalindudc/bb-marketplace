import { dirname, isAbsolute, join } from "node:path";
import { targetsProtectedPath } from "./control-files";
import { readFileSync, statSync } from "node:fs";
import { execGitSync } from "../shared/git-safety";
import { realPath, within } from "./paths";
import { gitWorktreeRoot } from "./worktree";
import type { Scope } from "./schema";
import type { ShellCommand } from "./shell";

export function checkerWorktree(scope: Scope): string | undefined {
  return scope.preset === "checker" ? scope.checks?.worktree : undefined;
}

export function targetsMakerWorktree(scope: Scope, paths: string[], cwd: string, destructive = false): boolean {
  const root = checkerWorktree(scope);
  return !!root && targetsProtectedPath(paths, cwd, scope.env.variables.HOME, target => within(target, root) || destructive && within(root, target));
}

export function bindChecks(scope: Scope): Scope {
  if (scope.preset !== "checker" || !scope.checks?.worktree) return scope;
  const path = scope.checks.worktree;
  if (!isAbsolute(path)) throw new Error("The checker requires an absolute maker worktree");
  const root = gitWorktreeRoot(path, scope.workspaceKind);
  if (scope.workspaceKind === "dedicated-machine" && (!scope.expectedWorktree || realPath(scope.expectedWorktree) !== root)) throw new Error("The dedicated checker must use its trusted carried checkout");
  if (root !== realPath(path)) throw new Error("The checker root must be the maker's linked Git toplevel");
  return { ...scope, checks: { ...scope.checks, worktree: root } };
}
export function checkerWritePaths(scope: Scope): { allow: string[]; directories: string[]; deny: string[]; ancestors: string[] } {
  const root = bindChecks(scope).checks?.worktree;
  if (!root) throw new Error("The checker has no maker worktree");
  const git = (args: string[], input?: string) => execGitSync(root, args, { input, readOnly: true, encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  const entries = (value: string) => value.split("\0").filter(Boolean);
  const tracked = entries(git(["ls-files", "--cached", "-z"])).map(path => join(root, path));
  for (const path of tracked) {
    try { const stat = statSync(path); if (stat.isFile() && stat.nlink > 1) throw new Error("Cannot isolate a hard-linked tracked file: " + path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const candidates = new Set(["node_modules", "dist", "coverage", ".cache", ".pytest_cache", "__pycache__", ".mypy_cache", ".ruff_cache", ".vitest", ".eslintcache", "htmlcov", "target"].map(path => join(root, path)));
  for (const path of entries(git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]))) candidates.add(join(root, path));
  const ignoreFiles = entries(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ".gitignore", "**/.gitignore"])).map(path => join(root, path));
  for (const file of ignoreFiles) for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const pattern = raw.trim();
    if (!pattern || /^[#!]/.test(pattern) || /[\\*?\[\]]/.test(pattern)) continue;
    candidates.add(join(dirname(file), pattern.replace(/^\//, "").replace(/\/$/, "")));
  }
  const allow: string[] = [], directories: string[] = [];
  const ignored = (path: string) => {
    try { const pattern = entries(git(["check-ignore", "--no-index", "--verbose", "-z", "--stdin"], path + "\0"))[2]; return pattern?.startsWith("!") ? undefined : pattern; }
    catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  };
  for (const path of candidates) {
    const canonical = realPath(path);
    if (!within(canonical, root) || canonical === root || path.split("/").some(part => part.toLowerCase() === ".git")) continue;
    const matched = ignored(path), pattern = matched ?? ignored(path.replace(/\/$/, "") + "/");
    if (!pattern) continue;
    if (!matched || pattern.endsWith("/")) directories.push(canonical); else allow.push(canonical);
  }
  const ancestors = new Set<string>();
  for (const path of tracked) for (let parent = dirname(path); within(parent, root); parent = dirname(parent)) { ancestors.add(parent); if (parent === root) break; }
  return { allow: [...new Set(allow)], directories: [...new Set(directories)], deny: [...new Set(tracked.flatMap(path => [path, realPath(path)]))], ancestors: [...ancestors] };
}
export function checkInvocation(scope: Scope, command: ShellCommand, source: string, read: boolean): boolean {
  if (scope.preset !== "checker") return false;
  const [program, sub, action] = command.argv, argv = command.argv;
  const managers = ["npm", "pnpm", "yarn", "bun"];
  if (managers.includes(program)) {
    const args = argv.slice(1, argv.includes("--") ? argv.indexOf("--") : undefined);
    if (args.some(arg => /^(?:--(?:prefix|cwd|dir|directory|global|workspace|workspaces|filter)(?:=|$)|-[Cgw])/.test(arg))) return false;
    if (sub === "test") return true;
    // The repo's own check script is whatever its package.json names; the checker sandbox, not the script name, confines it.
    if (sub === "run" && !!action && !action.startsWith("-")) return true;
  }
  // npx runs the same runners through a shim; skip its own leading flags so `npx tsc` and `npx --no-install vitest run` are recognised.
  const invoked = program === "npx" ? argv.slice(Math.max(1, argv.findIndex((arg, index) => index > 0 && !arg.startsWith("-")))) : argv;
  const [runner, verb] = invoked;
  // A project binary reached directly: `vitest run`, or `node_modules/.bin/tsc` whose directory the shell already stripped.
  if (runner === "tsc" || runner === "jest") return true;
  if (runner === "vitest" && verb === "run") return true;
  if (runner === "pytest" || ["go", "cargo"].includes(runner ?? "") && verb === "test") return true;
  // A project binary reached through node: `node node_modules/vitest/vitest.mjs run`.
  if (program === "node" && !!sub && !sub.startsWith("-") && !sub.includes("..") && /(?:^|\/)node_modules\//.test(sub)) return true;
  return !!scope.checks?.commands.some(value => value === command.source || value === source && !read);
}
