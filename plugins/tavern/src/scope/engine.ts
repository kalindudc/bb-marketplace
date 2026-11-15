import type { Scope } from "./schema";
import { checkInvocation } from "./checker";
import { glob, isSink, normalizeToolPath, within, writeAllowed, writeDenied } from "./paths";
import { normalizeRemote, pushSpec } from "./remote";
import { awkRead, fileRead, findRead, sedRead, xxdRead } from "./reads";
import { draftEditKey, githubApiRead } from "./github";
import { commandWritePaths, knownWritePaths, ruleMatches, shellCommands, type ShellCommand } from "./shell";

export interface ScopeCall { kind: "tool" | "bash" | "write" | "read"; toolName: string; input: Record<string, unknown>; cwd: string; resolvedPaths?: Record<string, string>; pushTargets?: Record<string, string[]>; pushHeads?: Record<string, string>; gitRoots?: Record<string, string>; directories?: string[]; ownedDraftPrs?: string[] }
export type Decision = { allow: true; check?: boolean } | { allow: false; ruleId: string; reason: string };
const allowed: Decision = { allow: true };
export const BLOCK_MARKER = "[Tavern scope blocked]";
export function blocked(what: string, ruleId: string, why: string): Decision {
  return { allow: false, ruleId, reason: `${BLOCK_MARKER} Blocked ${what}: ${why}. Report the need with tavern_report status needs-decision; do not try another route.` };
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
export function readonlyProgram(command: ShellCommand): boolean {
  const [program, sub, action] = command.argv;
  const argv = command.argv;
  if (!argv.length) return true;
  if (program === "git") return gitRead(argv);
  if (program === "gh") return ["view", "list", "status", "diff", "checks"].includes(action) || sub === "run" && action === "watch" || ["status", "search", "version", "help"].includes(sub) || sub === "api" && githubApiRead(argv);
  if (program === "kubectl") return ["get", "describe", "logs", "events", "version", "api-resources", "api-versions", "explain", "cluster-info", "top", "wait"].includes(sub) || sub === "auth" && action === "can-i" || sub === "config" && ["view", "get-contexts", "current-context"].includes(action);
  if (program === "sed") return sedRead(argv);
  if (program === "awk") return awkRead(argv);
  if (program === "find") return findRead(command, readonlyProgram);
  if (program === "xxd") return xxdRead(argv);
  if (program === "file") return fileRead(argv);
  if (program === "sort") return !argv.some(arg => /^--(?:output|compress-program)(?:=|$)|^-[^-]*o/.test(arg));
  if (program === "rg") return !argv.some(arg => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg));
  if (program === "bb") return ["status", "guide", "help"].includes(sub) || (["thread", "plugin", "provider", "project", "environment", "flare"].includes(sub) && ["show", "list", "log", "logs", "context", "status"].includes(action));
  if (program === "cortex") return ["ls", "show", "search", "recall"].includes(sub);
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
export function evaluate(scope: Scope, call: ScopeCall): Decision {
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
  try { commands = shellCommands(source, call.cwd, { temporaryRoot: temporaryRoot(scope), isRead: readonlyProgram, gitRoots: call.gitRoots, directories: call.directories, env: scope.env.variables }); } catch {
    if (scope.preset === "open") return allowed;
    for (const rule of scope.shell.deny) if (rule.regex && new RegExp(rule.regex).test(source)) return blocked("shell command", rule.id, rule.why);
    return blocked("shell command", "shell-parse", "unsupported shell syntax cannot be checked safely");
  }
  let checking = false;
  for (const command of commands) {
    const read = readonlyProgram(command), check = checkInvocation(scope, command, source, read);
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
    for (const rule of scope.shell.deny) if (ruleMatches(rule, command) && !excepted(rule.id)) return blocked(command.text, rule.id, rule.why);
    const paths = commandWritePaths(command);
    if (scope.preset !== "open" && command.gitEnvironment) return blocked(command.text, "git-environment", "GIT_DIR and GIT_WORK_TREE can redirect writes outside the bound checkout");
    if (scope.preset !== "open" && ["gs", "git-spice"].includes(program) && (["ss", "bs", "rs", "us", "uss", "bss", "dss"].includes(sub) || ["submit", "sync", "publish", "land"].includes(action))) return blocked(command.text, "git-stack-write", "stack publication needs an explicit scope decision");
    if (scope.preset === "checker" && (program === "git" || ["curl", "wget"].includes(program)) && !read) return blocked(command.text, "checker-write", "checker permissions do not allow Git or network writes, even in done-when commands");
    if (scope.preset !== "open" && program === "git") {
      const known = [...gitReads, "config", "branch", "remote", "stash", "push", "add", "commit", "checkout", "switch", "restore", "reset", "fetch", "pull", "merge", "rebase", "cherry-pick", "revert", "tag", "clean", "rm", "mv", "worktree", "init", "clone", "reflog", "apply", "am", "submodule", "lfs", "format-patch", "bisect"];
      if (!known.includes(sub)) return blocked(command.text, "git-alias", "unknown git subcommands or aliases cannot be checked");
      if (!gitRead(argv) && sub !== "push") paths.push(command.cwd);
      if (sub === "config" && argv.some(arg => ["--global", "--system"].includes(arg)) && !gitRead(argv)) return blocked(command.text, "git-global-config", "global git configuration is outside the member worktree");
    }
    for (const path of paths) if (!isSink(normalizeToolPath(path, command.cwd)) && (scope.preset !== "open" && (/[\$`]/.test(path) || path.startsWith("~") || command.uncertain) || !canWrite(path, command.cwd))) return blocked(`shell write to ${path}`, "shell-write", "the write target is protected, outside allowed roots or cannot be proven");
    if (scope.preset === "open") continue;
    if (command.fedInput && command.scriptInput === "opaque") return blocked(command.text, "shell-input", "shell input from a pipe or redirect cannot be inspected");
    if (scope.preset === "worktree" && command.cwdAlternative && !readonlyProgram(command) && !canWrite(command.cwd, command.cwd)) return blocked(command.text, "shell-location", "one possible working directory is outside allowed roots");
    if (command.uncertain && !readonlyProgram(command)) return blocked(command.text, "shell-location", "the command's working directory or symlinks cannot be proven");
    if (program === "git" && sub === "push" && scope.preset === "worktree") {
      const dangerous = argv.some(arg => /^--(?:force(?:-with-lease|-if-includes)?|mirror|delete|all|tags|follow-tags|prune)(?:=|$)/.test(arg) || /^-[^-]*[fd]/.test(arg) || arg.startsWith("+") || arg.startsWith(":"));
      const rawRefs = pushSpec(argv)?.refs ?? [];
      const refs = rawRefs.map(ref => ref === "HEAD" ? call.pushHeads?.[command.cwd + "\0" + command.sequence] ?? "" : ref);
      const safe = refs.length > 0 && refs[0] !== "tag" && refs.every(ref => {
        const destination = ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : ref;
        return /^(?:refs\/heads\/)?[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(destination) && (!destination.startsWith("refs/") || destination.startsWith("refs/heads/")) && destination !== "HEAD" && !destination.includes("..") && (ref.includes(":") || ref.startsWith("refs/heads/") || !/^v?\d/.test(ref));
      });
      if (dangerous && !excepted("git-push-force")) return blocked(command.text, "git-push-force", "force, mirror and deletion pushes are outside this scope");
      if (!safe && !excepted("git-push-target")) return blocked(command.text, "git-push-target", "pushes must name explicit branch targets; ambiguous bare tag names are not allowed");
      if (refs.some(ref => /^(?:refs\/heads\/)?(?:main|master)$/.test(ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : ref)) && !excepted("git-push-main")) return blocked(command.text, "git-push-main", "pushes to main and master require a user-controlled scope policy or explicit approval");
    }
    if ((["npm", "yarn", "pnpm", "bun", "cargo"].includes(program) && argv.slice(1).includes("publish") || program === "gem" && sub === "push" || program === "twine" && sub === "upload")) return blocked(command.text, "package-publish", "publishing packages requires the user\u0027s decision");
    if (program === "gh") {
      const api = sub === "api" && githubApiRead(argv);
      const read = ["view", "list", "status", "diff", "checks"].includes(action) || (sub === "run" && action === "watch") || ["status", "search", "version", "help"].includes(sub) || api;
      const draft = scope.github === "draft-pr-only" && sub === "pr" && action === "create" && argv.some(arg => ["--draft", "--draft=true", "-d"].includes(arg)) && !argv.includes("--draft=false");
      const edit = scope.github === "draft-pr-only" && sub === "pr" && action === "edit" && !command.githubEnvironment && call.ownedDraftPrs?.includes(draftEditKey(command));
      if (scope.github === "none" || (!read && !draft && !edit && !(sub === "pr" && action === "merge" && excepted("gh-merge")))) return blocked(command.text, "github", "GitHub writes require an explicit grant; Smith pull requests must be drafts");
    }
    if (program === "kubectl" && !["get", "describe", "logs", "events", "version", "api-resources", "api-versions", "explain", "cluster-info", "top", "wait"].includes(sub) && !(sub === "auth" && action === "can-i") && !(sub === "config" && ["view", "get-contexts", "current-context"].includes(action))) return blocked(command.text, "kubectl-write", "cluster writes, exec and cp are outside this scope, including dry runs");
    if (scope.writes.mode === "none") {
      const knownWriter = ["tee", "mkdir", "cp", "mv", "touch", "rm", "rmdir"].includes(program) && knownWritePaths(argv).length > 0;
      const outputOnly = program === "tee" && paths.length > 0 && paths.every(path => isSink(normalizeToolPath(path, command.cwd)));
      if (!read && !check && !(knownWriter && (scope.preset !== "keeper" || outputOnly))) return blocked(command.text, "readonly-shell", "this scope permits inspected read programs, not arbitrary programs or opaque shell input");
    }
  }
  return checking ? { allow: true, check: true } : allowed;
}
