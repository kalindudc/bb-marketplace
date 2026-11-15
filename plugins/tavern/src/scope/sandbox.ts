import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { realPath, within } from "./paths";
import { checkerWritePaths } from "./checker";
import { join } from "node:path";
import type { Scope } from "./schema";

export const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const metadata = new Map<string, string[]>();
export function gitWriteRoots(root: string): string[] {
  const path = realPath(root);
  const cached = metadata.get(path);
  if (cached) return cached;
  const roots = ["--git-dir", "--git-common-dir"].map(flag => realPath(execFileSync("git", ["-C", path, "rev-parse", "--path-format=absolute", flag], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }).trim()));
  metadata.set(path, [...new Set(roots)]);
  return metadata.get(path)!;
}
const regexLiteral = (value: string) => '#"' + value.replaceAll('"', '\\"') + '"';
function pathFilter(path: string): string {
  if (!path.includes("*")) return "(subpath " + JSON.stringify(realPath(path)) + ")";
  const regex = "^" + path.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  return "(regex " + regexLiteral(regex) + ")";
}
export function sandboxProfile(scope: Scope, checking = false): string {
  let roots = [...scope.writes.allow];
  const protectedPaths: string[] = [], protectedAncestors: string[] = [], ignoredPaths: string[] = [], ignoredDirectories: string[] = [];
  if (scope.preset === "checker" && scope.checks?.worktree) {
    const root = scope.checks.worktree, policy = checkerWritePaths(scope);
    roots = roots.filter(path => {
      const wildcard = path.indexOf("*"), prefix = realPath(wildcard < 0 ? path : path.slice(0, path.lastIndexOf("/", wildcard)) || "/");
      return !within(root, prefix) && !within(prefix, root);
    });
    ignoredPaths.push(...policy.allow);
    ignoredDirectories.push(...policy.directories);
    protectedPaths.push(...policy.deny, join(root, ".git"), ...gitWriteRoots(root));
    protectedAncestors.push(...policy.ancestors);
  } else if (scope.preset === "checker" && checking) throw new Error("The checker has no maker worktree");
  if (scope.writes.mode === "worktree") roots.push(...gitWriteRoots(scope.expectedWorktree ?? roots[0]));
  const devices = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd", "/dev/tty"];
  return ["(version 1)", "(allow default)", ...(scope.writes.mode === "any" ? [] : ["(deny file-write*)"]),
    ...[...roots, ...devices].map(path => "(allow file-write* " + pathFilter(path) + ")"),
    ...ignoredPaths.map(path => "(allow file-write* (subpath " + JSON.stringify(path) + "))"),
    ...ignoredDirectories.flatMap(path => ["(allow file-write* (regex " + regexLiteral("^" + path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/") + "))", "(allow file-write* (require-all (literal " + JSON.stringify(path) + ") (vnode-type DIRECTORY)))"]),
    '(allow file-write* (regex #"^/dev/tty.*$"))',
    ...[...scope.writes.deny, ...protectedPaths].map(path => "(deny file-write* " + pathFilter(path) + ")"),
    ...protectedAncestors.map(path => "(deny file-write-unlink (literal " + JSON.stringify(path) + "))"),
    '(deny file-write* (regex #".*/\\.claude/settings(\\.local)?\\.json$"))',
    '(deny file-write* (regex #".*/\\.agents/tavern/scopes\\.ya?ml$"))',
    ...(scope.network === "none" || scope.preset === "checker" && checking ? ["(deny network*)"] : []),
  ].join("\n");
}
export function sandboxCommand(scope: Scope, command: string, checking = false): string {
  if (!scope.sandbox || scope.mode !== "enforce" || process.platform !== "darwin") return command;
  if (!existsSync("/usr/bin/sandbox-exec")) throw new Error("macOS sandbox-exec is unavailable");
  return "/usr/bin/sandbox-exec -p " + shellQuote(sandboxProfile(scope, checking)) + " /bin/bash -c " + shellQuote(command);
}
