import { classScopeSchema, scopeNarrowingSchema, scopeSchema, type ClassScope, type Scope, type ScopeNarrowing, type ShellRule } from "./schema";
import { glob, pathMatches, realPath } from "./paths";
import { tmpdir } from "node:os";

const reads = ["read", "Read", "grep", "Grep", "find", "Glob", "ls", "write", "Write", "edit", "Edit", "bash", "Bash", "journal", "quest", "tavern_report", "tavern_ready", "flare", "flare_list", "codemode", "tool_search", "web_search", "web_fetch", "check_ui", "ui_examples", "web_extract", "web_map", "cortex_recall", "recall_session", "git_blame", "git_diff_summary", "ast_query", "mcp__*__read_*", "mcp__*__*_read_*", "mcp__*__search_*", "mcp__*__*_search_*", "mcp__*__get_*", "mcp__*__*_get_*", "mcp__*__list_*", "mcp__*__*_list_*"];
const externalWrites = ["*send*", "*post*", "*_*write*", "*delete*", "*create*", "*update*", "*publish*", "*merge*", "*deploy*", "spawn", "*spawn*", "powershell", "PowerShell", "bb_workflow_run", "ScheduleWakeup", "update_environment_directory"];
const rule = (id: string, argv: ShellRule["argv"], why: string): ShellRule => ({ id, argv, why });
const common: ShellRule[] = [
  rule("gh-merge", ["gh", "pr", "merge"], "Merging pull requests needs the user's decision"),
  rule("deploy", ["dev", "deploy"], "Deployments are outside this scope"),
  { id: "deploy-fallback", regex: "\\b(terraform\\s+(apply|destroy|import)|helm\\s+(install|upgrade|uninstall)|kapp\\s+deploy|dt\\s+deploy)\\b", why: "Deployments are outside this scope" },
];
export function scopeForClass(classId: string, narrowing?: ScopeNarrowing, definition?: ClassScope): Scope {
  const chosen = definition === undefined ? undefined : classScopeSchema.parse(definition);
  const preset = typeof chosen === "string" ? chosen : chosen?.preset ?? ({ ranger: "readonly", warden: "checker", smith: "worktree", keeper: "open" } as const)[classId as "ranger"] ?? "open";
  const open = preset === "open";
  const scope = scopeSchema.parse({
    v: 1, threadId: "pending", role: classId || "untyped", preset, issuedAt: 0, failClosed: true,
    writes: { mode: open ? "any" : preset === "worktree" ? "worktree" : "none",
      allow: open ? [] : [...(preset === "worktree" ? ["${worktree}"] : []), "${tmp}", "${threadStorage}"],
      deny: ["~/.ssh", "~/.pi/agent/extensions", "~/.agents/tavern/scopes.yml", ...(open ? ["~/.claude/settings.json", "~/.claude/settings.local.json"] : ["~/.claude"]), "${scopesDir}"] },
    tools: { allow: open || preset === "worktree" ? ["*"] : preset === "keeper" ? [...reads, "tavern_*"] : reads,
      deny: open ? [] : [...externalWrites, ...(preset === "keeper" ? ["apply_patch"] : [])], hide: !open },
    shell: { deny: open ? [] : [...common, ...(preset !== "worktree" ? [rule("git-push", ["git", "push"], "This scope does not allow pushes")] : [])], allow: [] },
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
