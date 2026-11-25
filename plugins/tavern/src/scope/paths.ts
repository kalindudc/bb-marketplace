import { lstatSync, realpathSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  controlRoots?: string[];
  worktree?: string;
  threadStorage?: string;
  keeperScratch?: string;
}

function mapRoot(pattern: string, map: (root: string) => string): string {
  const wildcard = pattern.indexOf("*");
  if (wildcard < 0) return map(pattern);
  const slash = pattern.lastIndexOf("/", wildcard);
  return map(pattern.slice(0, slash) || "/").replace(/\/$/, "") + pattern.slice(slash);
}

function identity(root: string): string | undefined {
  try {
    const { dev, ino } = statSync(root, { bigint: true });
    return `${dev}:${ino}`;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

export function writeRoots(scope: Scope): string[] {
  if (!scope.writeRootIdentity) return scope.writes.allow;
  return scope.writes.allow.flatMap(pattern => {
    if (!pattern.startsWith("/") || pattern.includes("${")) return [pattern];
    try {
      return [mapRoot(pattern, root => {
        const actual = realPath(root);
        const prior = scope.writeRootIdentity?.[root];
        // Following a grant's old name is safe only if it still names the directory that was granted.
        if (actual !== root && (!prior || prior !== identity(actual))) throw new Error("Write root changed identity");
        return actual;
      })];
    } catch { return []; }
  });
}

export function writeDenials(scope: Scope): string[] {
  if (!scope.writeRootIdentity) return scope.writes.deny;
  return [...new Set(scope.writes.deny.flatMap(pattern => {
    if (!pattern.startsWith("/") || pattern.includes("${")) return [pattern];
    try { return [pattern, mapRoot(pattern, realPath)]; } catch { return [pattern]; }
  }))];
}

export function bindPaths(scope: Scope, vars: ScopePaths, nativePath?: (path: string) => string): Scope {
  const canonicalize = nativePath ?? ((path: string) => resolve(path));
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
      return mapRoot(value, resolvePath);
    });
  };
  const denied = scope.writes.deny.flatMap(pattern => {
    const resolved = expand(pattern);
    const given = expand(pattern, value => resolve(value));
    const targets: string[] = [];
    for (const path of nativePath ? given : []) {
      if (path.includes("*") || path.includes("${")) continue;
      try { for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isSymbolicLink()) targets.push(canonicalize(join(path, entry.name))); }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    return [...resolved, ...given, ...targets];
  });
  const storagePath = vars.threadStorage && resolve(vars.threadStorage);
  const storage = storagePath && join(canonicalize(dirname(storagePath)), basename(storagePath));
  const keeperScratch = vars.keeperScratch && resolve(vars.keeperScratch);
  const threadRoots = [storage, keeperScratch].filter((root): root is string => !!root);
  const inOwnStorage = (path: string) => !!storage && within(path, storage);
  const resolveAllowed = (path: string) => {
    const full = resolve(path);
    if (storagePath && storage && within(full, storagePath)) return join(storage, relative(storagePath, full));
    return inOwnStorage(full) ? full : canonicalize(full);
  };
  const allow = [...new Set([...scope.writes.allow.flatMap(pattern => expand(pattern, resolveAllowed)), ...threadRoots])];
  const writeRootIdentity: Record<string, string> = {};
  for (const pattern of nativePath ? allow : []) if (!pattern.includes("${")) mapRoot(pattern, root => {
    // Own storage is an exact location, not a grant that follows a directory to a new path.
    if (inOwnStorage(root)) return root;
    try {
      // A Keeper scratch path must not acquire the identity of a symlink's destination.
      if (root !== keeperScratch || realPath(root) === root) {
        const id = identity(root);
        if (id) writeRootIdentity[root] = id;
      }
    } catch (error) { if (root !== keeperScratch) throw error; }
    return root;
  });
  const controls = [vars.scopesDir, ...vars.controlRoots ?? []];
  return { ...scope, controlRoots: [...new Set(controls.flatMap(path => [resolve(path), canonicalize(path)]))], ...(nativePath ? { writeRootIdentity } : {}), env: { ...scope.env, variables: { ...scope.env.variables, HOME: vars.home, ...(vars.tmp.length ? { TMPDIR: vars.tmp.at(-1)! } : {}), ...(vars.threadStorage ? { BB_THREAD_STORAGE: vars.threadStorage } : {}) } }, writes: { ...scope.writes, allow, deny: [...new Set(denied)] } };
}
export function writeAllowed(scope: Scope, path: string, cwd: string, canonical?: string): boolean {
  const full = normalizeToolPath(path, cwd);
  if (isSink(full)) return true;
  try {
    const actual = canonical ?? (scope.writeRootIdentity ? realPath(full) : full);
    const denied = writeDenials(scope);
    const protectedPath = (target: string) => denied.some(root => pathMatches(root, target)) || scope.preset !== "open" && (/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(target) || /(?:^|\/)\.agents\/tavern\/scopes\.ya?ml$/.test(target));
    if (protectedPath(full) || actual !== full && protectedPath(actual)) return false;
    const matches = (root: string) => pathMatches(root, actual);
    return scope.writes.mode === "any" || scope.writes.allow.some(matches) || writeRoots(scope).some(matches);
  } catch { return false; }
}
