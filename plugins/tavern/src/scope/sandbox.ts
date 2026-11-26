import { existsSync } from "node:fs";
import { execGitSync } from "../shared/git-safety";
import { realPath, within, writeDenials, writeRoots } from "./paths";
import { checkerWorktree, checkerWritePaths } from "./checker";
import { dirname, join } from "node:path";
import { controlPaths, projectControl } from "./control-files";
import type { Scope } from "./schema";

export const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const metadata = new Map<string, string[]>();
function gitWriteRoots(root: string): string[] {
  const path = realPath(root);
  const cached = metadata.get(path);
  if (cached) return cached;
  const roots = ["--git-dir", "--git-common-dir"].map(flag => realPath(execGitSync(path, ["rev-parse", "--path-format=absolute", flag], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }).trim()));
  metadata.set(path, [...new Set(roots)]);
  return metadata.get(path)!;
}
const regexLiteral = (value: string) => '#"' + value.replaceAll('"', '\\"') + '"';
function pathFilter(path: string): string {
  if (!path.includes("*")) return "(subpath " + JSON.stringify(path) + ")";
  const regex = "^" + path.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  return "(regex " + regexLiteral(regex) + ")";
}
function checkerProfile(scope: Scope): string {
  const root = checkerWorktree(scope);
  if (!root) throw new Error("The checker has no maker worktree");
  const policy = checkerWritePaths(scope);
  const roots = writeRoots(scope).filter(path => {
    const wildcard = path.indexOf("*"), prefix = realPath(wildcard < 0 ? path : path.slice(0, path.lastIndexOf("/", wildcard)) || "/");
    return !within(root, prefix) && !within(prefix, root);
  });
  const protectedPaths = [...policy.deny, join(root, ".git"), ...gitWriteRoots(root)];
  const devices = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd", "/dev/tty"];
  return ["(version 1)", "(allow default)", "(deny file-write*)",
    ...[...roots, ...devices].map(path => "(allow file-write* " + pathFilter(path) + ")"),
    ...policy.allow.map(path => "(allow file-write* (subpath " + JSON.stringify(path) + "))"),
    ...policy.directories.flatMap(path => ["(allow file-write* (regex " + regexLiteral("^" + path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/") + "))", "(allow file-write* (require-all (literal " + JSON.stringify(path) + ") (vnode-type DIRECTORY)))"]),
    '(allow file-write* (regex #"^/dev/tty.*$"))',
    ...[...writeDenials(scope), ...protectedPaths].map(path => "(deny file-write* " + pathFilter(path) + ")"),
    ...policy.ancestors.map(path => "(deny file-write-unlink (literal " + JSON.stringify(path) + "))"),
    '(deny file-write* (regex #".*/\\.claude/settings(\\.local)?\\.json$"))',
    "(deny network*)",
  ].join("\n");
}
const sandboxPrefix = "/usr/bin/sandbox-exec -p ";
const quoted = String.raw`'(?:[^']|'\\'')*'`;
const wrappedCall = new RegExp(`^${sandboxPrefix}(${quoted}) /bin/bash -c (${quoted})$`);
export function guardedShellSource(command: string): string {
  const match = wrappedCall.exec(command);
  return match ? match[2].slice(1, -1).replaceAll("'\\''", "'") : command;
}

export function sandboxCommand(scope: Scope, command: string, checking = false, file?: string): string {
  if (process.platform !== "darwin") return command;
  if (!existsSync("/usr/bin/sandbox-exec")) {
    if (checking) throw new Error("macOS sandbox-exec is unavailable for this check");
    return command;
  }
  const maker = !checking && checkerWorktree(scope);
  const roots = [...controlPaths(scope, file), ...(maker ? [maker, ...gitWriteRoots(maker)] : [])], ancestors = new Set<string>();
  for (const root of roots) for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent)) ancestors.add(parent);
  const profile = [checking ? checkerProfile(scope) : "(version 1)\n(allow default)",
    ...roots.map(path => "(deny file-write* (subpath " + JSON.stringify(path) + "))"),
    ...[...ancestors].map(path => "(deny file-write-unlink (literal " + JSON.stringify(path) + "))"),
    "(deny file-write* (regex " + regexLiteral(".*" + projectControl) + "))",
  ].join("\n");
  return sandboxPrefix + shellQuote(profile) + " /bin/bash -c " + shellQuote(command);
}
