import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeToolPath, realPath, within } from "./paths";
import type { Scope } from "./schema";

// Keep this POSIX-compatible for the macOS shell overlay.
export const projectControl = "/[.]agents/tavern/(scopes[.]ya?ml|settings[.]toml)($|/)";
const projectRule = new RegExp(projectControl);

export function controlPaths(scope: Scope, file?: string): string[] {
  const home = scope.env.variables.HOME ?? homedir();
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agent = configured ? normalizeToolPath(configured, home, home) : join(home, ".pi/agent");
  const roots = [...scope.controlRoots ?? [], ...(file ? [dirname(file)] : []), join(agent, "extensions/tavern-guard"), join(home, ".pi/agent/extensions/tavern-guard"),
    ...[scope.expectedWorktree, scope.checks?.worktree].filter((root): root is string => !!root).map(root => join(root, ".agents/tavern/scopes.yml")),
    join(home, ".agents/tavern/scopes.yml"), join(home, ".agents/tavern/settings.toml")];
  return [...new Set(roots.flatMap(path => {
    try { return [path, realPath(path)]; }
    catch { return [path]; }
  }))];
}

export function targetsProtectedPath(paths: string[], cwd: string, home: string | undefined, protectedTarget: (target: string) => boolean): boolean {
  return paths.some(path => {
    if (!path.trim() || path.includes("\0")) return false;
    let target: string;
    try { target = normalizeToolPath(path, cwd, home); }
    catch { return false; }
    if (protectedTarget(target)) return true;
    try { return protectedTarget(realPath(target)); }
    catch { return false; }
  });
}

export function targetsControlFile(paths: string[], cwd: string, scope: Scope, file?: string, destructive = false): boolean {
  if (!paths.length) return false;
  const roots = controlPaths(scope, file);
  return targetsProtectedPath(paths, cwd, scope.env.variables.HOME, target =>
    projectRule.test(target) || roots.some(root => within(target, root) || destructive && within(root, target)));
}
