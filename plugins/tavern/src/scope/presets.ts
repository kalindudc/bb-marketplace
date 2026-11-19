import { classScopeSchema, scopeNarrowingSchema, scopeSchema, type ClassScope, type Scope, type ScopeNarrowing } from "./schema";
import { glob, pathMatches, realPath } from "./paths";
import { tmpdir } from "node:os";
import { LEGACY_CATALOGUE_RULES } from "./acts";

export function scopeForClass(classId: string, narrowing?: ScopeNarrowing, definition?: ClassScope): Scope {
  const chosen = definition === undefined ? undefined : classScopeSchema.parse(definition);
  const preset = typeof chosen === "string" ? chosen : chosen?.preset ?? ({ ranger: "readonly", warden: "checker", smith: "worktree", keeper: "open" } as const)[classId as "ranger"] ?? "open";
  const open = preset === "open";
  const scope = scopeSchema.parse({
    v: 1, threadId: "pending", role: classId || "untyped", preset, issuedAt: 0, failClosed: true,
    writes: { mode: open ? "any" : preset === "worktree" ? "worktree" : "none",
      allow: open ? [] : [...(preset === "worktree" ? ["${worktree}"] : []), "${tmp}", "${threadStorage}"],
      deny: ["~/.ssh", "~/.pi/agent/extensions", "~/.agents/tavern/scopes.yml", ...(open ? ["~/.claude/settings.json", "~/.claude/settings.local.json"] : ["~/.claude"]), "${scopesDir}"] },
    tools: { allow: ["*"], deny: [], hide: false },
    shell: { deny: open ? [] : LEGACY_CATALOGUE_RULES.filter(rule => rule.id !== "git-push" || preset !== "worktree"), allow: [] },
    ...(preset === "checker" ? { checks: { commands: [] } } : {}),
    network: "any", github: open || preset === "worktree" ? "draft-pr-only" : "read",
    env: { poisonGh: true, blockGitPush: !open && preset !== "worktree" }, sandbox: !open, onViolation: "block",
  });
  return narrowScope(narrowScope(scope, typeof chosen === "object" ? (({ preset: _, ...rest }) => rest)(chosen) : undefined), narrowing);
}
export function narrowScope(base: Scope, patch?: ScopeNarrowing): Scope {
    const scope = structuredClone(base);
    if (!patch) return scope;
    const parsed = scopeNarrowingSchema.parse(patch);
    if (parsed.tools?.allow) {
      if (parsed.tools.allow.some(name => !scope.tools.allow.some(pattern => pattern === name || (!name.includes("*") && glob(pattern, name)))) ) throw new Error("A scope narrowing cannot widen tools");
      scope.tools.allow = parsed.tools.allow;
    }
    scope.tools.deny.push(...parsed.tools?.deny ?? []);
    if (parsed.writes?.allow) {
      if (parsed.writes.allow.some(path => path.split("/").includes(".."))) throw new Error("A scope narrowing cannot contain parent traversal");
      const temporary = (path: string) => scope.writes.allow.includes("${tmp}") && ["/tmp", "/private/tmp", tmpdir(), realPath(tmpdir())].some(root => pathMatches(root, path) && pathMatches(realPath(root), realPath(path)));
      if (parsed.writes.allow.some(path => !temporary(path) && scope.writes.mode !== "any" && !scope.writes.allow.some(root => root === path || (!root.includes("${") && pathMatches(root, path)) || path.startsWith(root + "/")))) throw new Error("A scope narrowing cannot widen write paths");
      scope.writes.allow = parsed.writes.allow;
      if (scope.writes.mode === "any") scope.writes.mode = "paths";
    }
    scope.writes.deny.push(...parsed.writes?.deny ?? []);
    scope.shell.deny.push(...parsed.shell?.deny ?? []);
    if (parsed.network) scope.network = parsed.network;
  return scope;
}
