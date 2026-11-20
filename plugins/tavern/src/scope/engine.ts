import type { Scope } from "./schema";
import { agentProgram, bbPositionals, nestedCommands } from "./legacy";
import { actsForCommand, baselineHolds, isCatalogueRule, closingAct, fallbackActs, fallbackPullRequestRoute, pullRequestRoute, readerNeedsDecision, userControl, type Act } from "./acts";
import { readerFallback } from "./worktree";
import { checkInvocation } from "./checker";
import { glob, isSink, normalizeToolPath, within, writeAllowed, writeDenied } from "./paths";
import { normalizeRemote, pushSpec } from "./remote";
import { awkRead, fileRead, findRead, sedRead, xxdRead } from "./reads";
import { draftEditKey, githubApiRead } from "./github";
import { prCommandDigest, pullRequestOwned } from "./pr-policy";
import { commandWritePaths, knownWritePaths, ruleMatches, shellCommands, type ShellCommand } from "./shell";

export interface ScopeCall { containment?: "sandbox"; fetchWriteRoots?: string[]; kind: "tool" | "bash" | "write" | "read"; toolName: string; input: Record<string, unknown>; cwd: string; resolvedPaths?: Record<string, string>; pushTargets?: Record<string, string[]>; pushHeads?: Record<string, string>; gitRoots?: Record<string, string>; directories?: string[]; ownedDraftPrs?: string[]; ownedPrs?: string[]; questOwnedPrs?: string[]; observationId?: string; prGrantAvailable?(id: string): boolean }
export type Decision = { allow: true; check?: boolean; acts?: Act[]; prGrant?: string } | { allow: false; ruleId: string; reason: string };
const allowed: Decision = { allow: true };
export const BLOCK_MARKER = "[Tavern scope blocked]";
export function blocked(what: string, ruleId: string, why: string): Decision {
  return { allow: false, ruleId, reason: `${BLOCK_MARKER} Blocked ${what}: ${why}. Report the need with tavern_report status needs-decision.` };
}
export function toolAllowed(scope: Scope, name: string): boolean {
  return !scope.tools.deny.some(pattern => glob(pattern, name)) && scope.tools.allow.some(pattern => glob(pattern, name));
}
const gitReads = ["status", "diff", "show", "log", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "rev-list", "for-each-ref", "cat-file", "describe", "merge-base", "name-rev", "shortlog", "version", "--version", "--help", "help", "ls-remote", "show-ref", "check-ignore", "whatchanged", "count-objects"];
function gitRead(argv: string[]): boolean {
  if (gitReads.includes(argv[1])) return !argv.some(arg => arg.startsWith("--output") || arg === "--ext-diff" || arg === "--textconv");
  if (argv[1] === "reflog") return !argv.slice(2).some(arg => ["expire", "delete", "drop", "write"].includes(arg));
  if (argv[1] === "worktree") return argv[2] === "list";
  if (argv[1] === "apply" && argv.includes("--check")) return true;
  if (argv[1] === "stash") return argv[2] === "list" || argv[2] === "show";
  if (argv[1] === "tag") return argv.slice(2).some(arg => ["-l", "--list"].includes(arg)) && !argv.some(arg => /^--(?:delete|annotate|sign|force|message|file|local-user)(?:=|$)|^-[^-]*[dasfumF]/.test(arg));
  if (argv[1] === "remote") return argv.length === 2 || ["-v", "--verbose", "get-url", "show"].includes(argv[2]);
  if (argv[1] === "branch") return argv.length === 2 || (argv.slice(2).some(arg => ["-v", "-vv", "--list", "-a", "-r", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged"].includes(arg)) && !argv.some(arg => /^--(?:delete|move|copy|force|edit-description|set-upstream-to|unset-upstream)(?:=|$)|^-[^-]*[dDmMcCfut]/.test(arg)));
  return argv[1] === "config" && argv.some(arg => /^--(?:get(?:-all|-regexp|-urlmatch)?|list)$/.test(arg)) && !argv.some(arg => /^(?:--edit|--add|--replace-all|--unset|--remove-section|--rename-section)/.test(arg));
}
export const readonlyProgram = (command: ShellCommand): boolean => inspectedProgram(command, false);
export const containmentRead = (command: ShellCommand): boolean => inspectedProgram(command, true);
function inspectedProgram(command: ShellCommand, contained: boolean): boolean {
  const [program, sub, action] = command.argv;
  const argv = command.argv;
  if (!argv.length) return true;
  if (program === "git") return gitRead(argv);
  if (program === "gh") return ["view", "list", "status", "diff", "checks"].includes(action) || sub === "run" && action === "watch" || ["status", "search", "version", "help"].includes(sub) || contained && sub === "auth" && action === "status" || sub === "api" && githubApiRead(argv);
  if (program === "gcloud") return contained && sub === "storage" && action === "cat";
  if (program === "kubectl") return ["get", "describe", "logs", "events", "version", "api-resources", "api-versions", "explain", "cluster-info", "top", "wait"].includes(sub) || sub === "auth" && action === "can-i" || sub === "config" && ["view", "get-contexts", "current-context"].includes(action);
  if (program === "sed") return sedRead(argv);
  if (program === "awk") return awkRead(argv);
  if (program === "find") return findRead(command, readonlyProgram);
  if (program === "xxd") return xxdRead(argv);
  if (program === "file") return fileRead(argv);
  if (program === "sort") return !argv.some(arg => /^--(?:output|compress-program)(?:=|$)|^-[^-]*o/.test(arg));
  if (program === "rg") return !argv.some(arg => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg));
  if (["bb", "cortex"].includes(program)) return agentProgram(argv);
  if (program === "curl") return !argv.some((arg, i) => /^--(?:data|json|form|upload|request-target|config)|^-[^-]*[dFTK]/.test(arg) || arg === "--next" || ((arg === "-X" || arg === "--request") && !["GET", "HEAD", "OPTIONS"].includes(argv[i + 1])) || /^--request=/.test(arg) && !/^--request=(GET|HEAD|OPTIONS)$/.test(arg) || /^-X.+/.test(arg) && !/^-X(GET|HEAD|OPTIONS)$/.test(arg) || ["-O", "--remote-name", "--output-dir"].includes(arg) || ["-o", "--output"].includes(arg) && !isSink(argv[i + 1] ?? "") || /^(?:--output=|-o.)/.test(arg) && !isSink(arg.replace(/^--output=|^-o/, "")));
  if (program === "wget") return argv.includes("--spider") || argv.some((arg, i) => arg === "-O" && argv[i + 1] === "-") ? !argv.some(arg => /^--(?:post|body|method|input-file)/.test(arg)) : false;
  if (program === "node") return argv.length === 2 && ["--version", "-v"].includes(sub);
  if (program === "npm") return ["ls", "list", "view", "info", "show", "version"].includes(sub) && !(sub === "version" && argv.length > 2);
  if (program === "mktemp") return argv.slice(1).every(arg => ["-d", "--directory", "-q", "--quiet", "-u", "--dry-run"].includes(arg));
  if (program === "fd") return !argv.some(arg => /^--exec(?:-batch)?(?:=|$)|^-[xX]/.test(arg));
  if (program === "tree") return !argv.some(arg => /^-o/.test(arg));
  if (program === "hostname") return argv.slice(1).every(arg => ["-s", "-f", "-i", "-I", "--fqdn", "--short"].includes(arg));
  if (["bash", "sh", "dash", "zsh", "eval"].includes(program)) return command.scriptInput === "inline";
  return ["", "cd", "pushd", "popd", "pwd", "ls", "rg", "grep", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "od", "hexdump", "stat", "du", "df", "which", "type", "test", "[", "[[", "echo", "printf", "true", "false", "date", "uname", "jq", "diff", "nl", "basename", "dirname", "realpath", "readlink", "sleep", "export", "set", "local", "declare", "typeset", "exit", "return", "env", "printenv", "whoami", "id", "ps", "read", "tree", "fd", "column", "shasum", "md5", "hostname"].includes(program);
}
export function temporaryRoot(scope: Scope): string | undefined {
  const root = scope.env.variables.TMPDIR;
  if (!root?.startsWith("/") || /[\$`]/.test(root) || !writeAllowed(scope, root, root)) return;
  if (scope.writes.deny.some(pattern => {
    const prefix = pattern.split("*")[0];
    return !prefix || within(root, prefix) || within(prefix, root);
  })) return;
  return root;
}
export function authorityDecision(scope: Scope, call: ScopeCall): Decision | undefined {
  if (scope.role !== "keeper" && ["spawn", "bb_workflow_run"].includes(call.toolName)) return { allow: false, ruleId: "member-spawn", reason: "Members don't start threads; ask your Keeper to hire." };
  const source = call.input.command ?? call.input.cmd;
  if (typeof source !== "string") return;
  let commands: ShellCommand[];
  try { commands = shellCommands(source, call.cwd); } catch {
    if (fallbackActs(source).some(act => act.kind === "tavern-control")) return { allow: false, ruleId: "tavern-control", reason: "Tavern's controls are the user's; ask the user." };
    return;
  }
  for (const command of commands) {
    if (userControl(command)) return { allow: false, ruleId: "tavern-control", reason: "Tavern's controls are the user's; ask the user." };
    const words = bbPositionals(command.argv);
    if (scope.role !== "keeper" && words[0] === "bb" && words[1] === "thread") {
      if (words[2] === "spawn") return { allow: false, ruleId: "member-spawn", reason: "Members don't start threads; ask your Keeper to hire." };
      if (words[2] === "archive" && !agentProgram(command.argv)) return { allow: false, ruleId: "member-archive", reason: "Members don't archive threads; ask your Keeper." };
    }
    for (const source of nestedCommands(command)) {
      const decision = authorityDecision(scope, { ...call, input: { command: source } });
      if (decision) return decision;
    }
  }
}
export function evaluate(scope: Scope, call: ScopeCall): Decision {
  const authority = authorityDecision(scope, call);
  if (authority) return authority;
  const contained = call.containment === "sandbox" && scope.sandbox && ["bash", "Bash"].includes(call.toolName);
  if (contained) scope = readerFallback(scope);
  if ([...scope.writes.allow, ...scope.writes.deny].some(path => path.includes("${")) && !["tavern_report", "journal", "quest", "tavern_ready"].includes(call.toolName)) return blocked(call.toolName, "worktree-unresolved", "the worktree root must be bound from the provisioned environment");
  if (!toolAllowed(scope, call.toolName)) return blocked(`tool ${call.toolName}`, "tool", "the thread's scope does not allow this tool");
  const name = call.toolName.toLowerCase();
  const canWrite = (path: string, cwd: string) => {
    const full = normalizeToolPath(path, cwd);
    return isSink(full) || (!writeDenied(scope, full, cwd) && writeAllowed(scope, call.resolvedPaths?.[full] ?? full, cwd));
  };
  if (call.kind === "write" || ["write", "edit", "apply_patch", "multiedit"].includes(name)) {
    const path = call.input.path ?? call.input.file_path;
    if (typeof path !== "string" || !canWrite(path, call.cwd)) return blocked(`write to ${String(path)}`, "write-path", "the write target is outside allowed roots, protected or cannot be checked");
  }
  const source = call.input.command ?? call.input.cmd;
  if (typeof source !== "string") return call.kind === "bash" ? blocked("shell call", "shell-input", "the command cannot be checked") : allowed;
  if (scope.preset !== "open" && !(scope.commandTools ?? ["bash", "Bash"]).includes(call.toolName)) return blocked(call.toolName, "command-tool", "command-running tools require an explicit scope allowlist and a guarded execution backend");
  let commands;
  try { commands = shellCommands(source, call.cwd, { temporaryRoot: temporaryRoot(scope), isRead: contained ? containmentRead : readonlyProgram, gitRoots: call.gitRoots, directories: call.directories, env: scope.env.variables, containment: contained ? "sandbox" : undefined }); } catch {
    const route = fallbackPullRequestRoute(source);
    const acts = route ? [route, ...fallbackActs(source)] : fallbackActs(source);
    const refused = (route && (route.kind !== "send" || scope.pullRequestPolicy?.alwaysAsk !== false) ? route : undefined) ?? acts.find(act => closingAct(scope, act, source) || !(scope.role === "keeper" || scope.role === "wanderer" && scope.preset === "open") || act.kind === "tavern-control");
    if (refused) return blocked("shell command", refused.kind === "deploy" ? "deploy-fallback" : refused.ruleId, refused.why);
    if (scope.preset === "open") return acts.length ? { allow: true, acts } : allowed;
    for (const rule of scope.shell.deny) if (rule.regex && new RegExp(rule.regex).test(source)) return blocked("shell command", rule.id, rule.why);
    if (contained) return allowed;
    return blocked("shell command", "shell-parse", "unsupported shell syntax cannot be checked safely");
  }
  let checking = false, prGrant: string | undefined;
  const observed: Act[] = [];
  for (const command of commands) {
    for (const source of nestedCommands(command)) {
      const result = evaluate(scope, { ...call, input: { command: source }, cwd: command.cwd, prGrantAvailable: undefined });
      if (!result.allow) return result;
      observed.push(...result.acts ?? []);
    }
    const read = (contained ? containmentRead : readonlyProgram)(command), check = checkInvocation(scope, command, source, read);
    if (check) {
      const root = scope.checks?.worktree, location = call.resolvedPaths?.[normalizeToolPath(command.cwd, call.cwd)] ?? command.cwd;
      if (!root?.startsWith("/") || root === "/" || root === scope.env.variables.HOME || !within(location, root) || command.uncertain) return blocked(command.text, "checker-worktree", "checks must run in the trusted maker worktree; ask the Keeper to bind checks.worktree or use that directory");
      checking = true;
    }
    const argv = command.argv;
    const [program, sub, action] = argv;
    const excepted = (id: string) => scope.shell.allow.some(rule => {
      if (rule.id !== id || !ruleMatches(rule, command)) return false;
      if (!rule.remote) return true;
      const push = pushSpec(argv);
      if (!push) return false;
      const targets = call.pushTargets?.[command.cwd + "\0" + push.remote];
      return !!targets?.length && targets.every(target => glob(rule.remote!, normalizeRemote(target)));
    });
    const smithOwned = Boolean(call.ownedPrs?.includes(draftEditKey(command)));
    const questOwned = pullRequestOwned(command, scope.pullRequestPolicy?.owned ?? [], call.questOwnedPrs ?? []);
    const route = pullRequestRoute(command, smithOwned || questOwned);
    if (route && (route.kind === "ready" || route.kind === "close")) return blocked(command.text, route.ruleId, route.why);
    if (route?.kind === "send") {
      const grant = commands.length === 1 && !command.githubEnvironment && scope.pullRequestPolicy?.grants.find(g => g.digest === prCommandDigest(source) && call.prGrantAvailable?.(g.id));
      if (!grant && scope.pullRequestPolicy?.alwaysAsk !== false) return blocked(command.text, route.ruleId, route.why);
      if (grant) prGrant = grant.id;
    }
    for (const act of route && !smithOwned ? [route] : scope.pullRequestPolicy?.alwaysAsk === false && route?.kind === "send" ? [route] : actsForCommand(command)) {
      observed.push(act);
      if (closingAct(scope, act, command)) return blocked(command.text, "closing-act", "Closing time: " + act.kind + " waits for your return");
      if (!baselineHolds(scope, call, command, act) && !excepted(act.ruleId)) return blocked(command.text, act.ruleId, act.why);
    }
    for (const rule of scope.shell.deny) if (!isCatalogueRule(rule) && ruleMatches(rule, command) && !excepted(rule.id)) return blocked(command.text, rule.id, rule.why);
    const paths = commandWritePaths(command);
    if (scope.preset !== "open" && command.gitEnvironment) return blocked(command.text, "git-environment", "GIT_DIR and GIT_WORK_TREE can redirect writes outside the bound checkout");
    if (scope.preset === "checker" && (program === "git" || ["curl", "wget"].includes(program)) && !read && !(contained && program === "git" && sub === "fetch" && call.fetchWriteRoots?.length)) return blocked(command.text, "checker-write", "checker permissions do not allow Git or network writes, even in done-when commands");
    if (scope.preset !== "open" && program === "git") {
      const known = [...gitReads, "config", "branch", "remote", "stash", "push", "add", "commit", "checkout", "switch", "restore", "reset", "fetch", "pull", "merge", "rebase", "cherry-pick", "revert", "tag", "clean", "rm", "mv", "worktree", "init", "clone", "reflog", "apply", "am", "submodule", "lfs", "format-patch", "bisect"];
      if (!known.includes(sub)) return blocked(command.text, "git-alias", "unknown git subcommands or aliases cannot be checked");
      if (!gitRead(argv) && sub !== "push" && !(contained && sub === "fetch" && call.fetchWriteRoots?.length)) paths.push(command.cwd);
      if (sub === "config" && argv.some(arg => ["--global", "--system"].includes(arg)) && !gitRead(argv)) return blocked(command.text, "git-global-config", "global git configuration is outside the member worktree");
    }
    for (const path of paths) if (!(contained && (/[$`]/.test(path) || command.uncertain || command.cwdAlternative)) && !isSink(normalizeToolPath(path, command.cwd)) && (scope.preset !== "open" && (/[\$`]/.test(path) || path.startsWith("~") || command.uncertain) || !canWrite(path, command.cwd))) return blocked(`shell write to ${path}`, "shell-write", "the write target is protected, outside allowed roots or cannot be proven");
    if (scope.preset === "open") continue;
    if (!contained && command.fedInput && command.scriptInput === "opaque") return blocked(command.text, "shell-input", "shell input from a pipe or redirect cannot be inspected");
    if (!contained && scope.preset === "worktree" && command.cwdAlternative && !readonlyProgram(command) && !canWrite(command.cwd, command.cwd)) return blocked(command.text, "shell-location", "one possible working directory is outside allowed roots");
    if (!contained && command.uncertain && !readonlyProgram(command)) return blocked(command.text, "shell-location", "the command's working directory or symlinks cannot be proven");
    if (contained && scope.writes.mode === "none" && readerNeedsDecision(command)) return blocked(command.text, "legacy-act", "this consequential command requires a scope decision");
    if (scope.writes.mode === "none" && !contained) {
      const knownWriter = ["tee", "mkdir", "cp", "mv", "touch", "rm", "rmdir"].includes(program) && knownWritePaths(argv).length > 0;
      if (!read && !check && !knownWriter) return blocked(command.text, "readonly-shell", "this scope permits inspected read programs, not arbitrary programs or opaque shell input");
    }
  }
  return { allow: true, ...(checking ? { check: true } : {}), ...(observed.length ? { acts: observed } : {}), ...(prGrant ? { prGrant } : {}) };
}
