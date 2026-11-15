import { lstatSync, realpathSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Scope } from "./schema";

export function glob(pattern: string, value: string): boolean {
  const regex = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + regex + "$").test(value);
}

export function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
}

export function pathMatches(pattern: string, path: string): boolean {
  return pattern.includes("*") ? glob(pattern, path) : within(path, pattern);
}

export function normalizeToolPath(path: string, cwd: string, home = homedir()): string {
  let value = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = home;
  else if (value.startsWith("~/")) value = join(home, value.slice(2));
  else if (value.startsWith("file://")) value = fileURLToPath(value);
  return resolve(cwd, value);
}
export const isSink = (path: string) => ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"].includes(path) || /^\/dev\/(?:fd\/\d+|tty\w*)$/.test(path);
// New files can escape through a symlinked existing ancestor.
export function realPath(path: string, cwd = process.cwd()): string {
  const absolute = normalizeToolPath(path, cwd);
  try { return realpathSync(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if (lstatSync(absolute).isSymbolicLink()) throw new Error("Unresolvable symlink: " + absolute);
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner;
    }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(realPath(parent), absolute.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
  }
}

export interface ScopePaths {
  home: string;
  tmp: string[];
  scopesDir: string;
  worktree?: string;
  threadStorage?: string;
}
export function bindPaths(scope: Scope, vars: ScopePaths, canonicalize: (path: string) => string = path => resolve(path)): Scope {
  const expand = (pattern: string, resolvePath = canonicalize): string[] => {
    let values = [pattern.replace(/^~(?=\/|$)/, vars.home)];
    for (const [name, replacements] of Object.entries({ tmp: vars.tmp, worktree: vars.worktree ? [vars.worktree] : [], threadStorage: vars.threadStorage ? [vars.threadStorage] : [], scopesDir: [vars.scopesDir] })) {
      if (!values.some(value => value.includes("${" + name + "}"))) continue;
      if (!replacements.length) {
        if (name === "worktree") continue;
        if (name === "threadStorage") return [];
        throw new Error("Missing scope path binding: " + name);
      }
      values = values.flatMap(value => replacements.map(replacement => value.replaceAll("${" + name + "}", replacement)));
    }
    return values.flatMap(value => {
      if (/\$\{/.test(value.replaceAll("${worktree}", ""))) throw new Error("Unknown scope path variable: " + value);
      if (value.includes("${worktree}")) return value;
      const wildcard = value.indexOf("*");
      if (wildcard < 0) return resolvePath(value);
      const slash = value.lastIndexOf("/", wildcard);
      return resolvePath(value.slice(0, slash) || "/") + value.slice(slash);
    });
  };
  const denied = scope.writes.deny.flatMap(pattern => {
    const resolved = expand(pattern);
    const given = expand(pattern, value => resolve(value));
    const targets: string[] = [];
    for (const path of given) {
      if (path.includes("*") || path.includes("${")) continue;
      try { for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isSymbolicLink()) targets.push(canonicalize(join(path, entry.name))); }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    return [...resolved, ...given, ...targets];
  });
  return { ...scope, env: { ...scope.env, variables: { ...scope.env.variables, HOME: vars.home, ...(vars.tmp.length ? { TMPDIR: vars.tmp.at(-1)! } : {}), ...(vars.threadStorage ? { BB_THREAD_STORAGE: vars.threadStorage } : {}) } }, writes: { ...scope.writes, allow: scope.writes.allow.flatMap(pattern => expand(pattern)), deny: [...new Set(denied)] } };
}
export function writeDenied(scope: Scope, path: string, cwd: string): boolean {
  const full = normalizeToolPath(path, cwd);
  return scope.writes.deny.some(root => pathMatches(root, full)) || scope.preset !== "open" && (/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(full) || /(?:^|\/)\.agents\/tavern\/scopes\.ya?ml$/.test(full));
}
export function writeAllowed(scope: Scope, path: string, cwd: string): boolean {
  const full = normalizeToolPath(path, cwd);
  if (isSink(full)) return true;
  if (writeDenied(scope, full, cwd)) return false;
  if (scope.preset === "keeper") return false;
  return scope.writes.mode === "any" || scope.writes.allow.some(root => pathMatches(root, full));
}
