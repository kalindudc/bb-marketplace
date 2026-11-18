import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import { realPath, within } from "./paths";
import type { Scope } from "./schema";

const variable = "${worktree}";
export function needsWorktree(scope: Scope): boolean {
  return [...scope.writes.allow, ...scope.writes.deny].some(path => path.includes(variable));
}
export function readerFallback(scope: Scope): Scope {
  if (scope.preset !== "worktree" || scope.expectedWorktree || !needsWorktree(scope)) return scope;
  return { ...scope, preset: "readonly", expectedWorktree: undefined,
    writes: { ...scope.writes, mode: "none", allow: scope.writes.allow.filter(path => !path.includes(variable)) },
    shell: { ...scope.shell, deny: [...scope.shell.deny, { id: "git-push", argv: ["git", "push"], why: "An unbound Smith runs as a Ranger" }] } };
}
export function checkedWorktreeRoot(path: string, home = homedir()): string {
  if (!isAbsolute(path)) throw new Error("The worktree root must be absolute");
  const root = realpathSync(path);
  if (!statSync(root).isDirectory()) throw new Error("The worktree root must be an existing directory");
  if (root === parse(root).root || root === realPath(home)) throw new Error("Refusing / or HOME as the worktree root");
  return root;
}
export function gitWorktreeRoot(cwd = process.cwd(), kind: Scope["workspaceKind"] = "linked-worktree"): string {
  let root: string;
  try {
    root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  } catch { throw new Error("Cannot resolve the scoped worktree from the session's git toplevel"); }
  const checked = checkedWorktreeRoot(root);
  const metadata = lstatSync(join(checked, ".git"));
  if (kind === "linked-worktree" && !metadata.isFile()) throw new Error("The worktree preset requires a linked Git worktree, not a shared checkout");
  if (kind === "dedicated-machine" && !metadata.isFile() && !metadata.isDirectory()) throw new Error("The dedicated checkout has no valid Git metadata entry");
  return checked;
}
export function bindWorktree(scope: Scope, path: string): Scope {
  const root = checkedWorktreeRoot(path);
  if (scope.workspaceKind === "dedicated-machine" && !scope.expectedWorktree) throw new Error("The dedicated checkout requires its trusted expected root");
  const bind = (value: string, allow: boolean) => {
    if (!value.includes(variable)) return value;
    if (!value.startsWith(variable) || !["", "/"].includes(value.slice(variable.length, variable.length + 1))) throw new Error("Worktree variables must begin a path root");
    const replaced = value.replaceAll(variable, root);
    const wildcard = replaced.indexOf("*");
    const slash = wildcard < 0 ? -1 : replaced.lastIndexOf("/", wildcard);
    const base = realPath(wildcard < 0 ? replaced : replaced.slice(0, slash));
    if (allow && !within(base, root)) throw new Error("A worktree-relative allowance escapes the worktree");
    return wildcard < 0 ? base : base + replaced.slice(slash);
  };
  if (scope.expectedWorktree && realPath(scope.expectedWorktree) !== root) throw new Error("The provisioned worktree differs from the expected root");
  return { ...scope, expectedWorktree: root, writes: { ...scope.writes, allow: scope.writes.allow.map(path => bind(path, true)), deny: scope.writes.deny.map(path => bind(path, false)) } };
}
