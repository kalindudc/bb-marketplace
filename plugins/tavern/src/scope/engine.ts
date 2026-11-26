import type { Scope } from "./schema";
import { agentProgram, bbPositionals, nestedCommands } from "./legacy";
import { actsForCommand, baselineHolds, closingAct, clusterCommandTarget, fallbackActs, fallbackPullRequestRoute, isCatalogueRule, pullRequestRoute, terraformStateFallback, terraformStateProblem, typedPullRequestAct, userControl, kubectlRead, type Act, type ActKind } from "./acts";
import { actAskKind } from "./act-routing";
import { closingTool } from "./away-policy";
import { shellGrantTarget, type ShellGrantProjection } from "./shell-grants";
import { namedCommunication } from "./communication";
import { shellCommunication } from "./shell-communication";
import type { CommunicationPreview } from "../shared/communication";
import { targetsControlFile } from "./control-files";
import { checkInvocation, targetsMakerWorktree } from "./checker";
import { glob, isSink, normalizeToolPath, within, writeAllowed } from "./paths";
import { normalizeRemote, pushSpec } from "./remote";
import { awkRead, fileRead, findRead, sedRead, xxdRead } from "./reads";
import { draftEditKey, githubApiRead } from "./github";
import { prCommandDigest, pullRequestOwned } from "./pr-policy";
import { commandWritePaths, ruleMatches, shellCommands, type ShellCommand } from "./shell";
import { memoryCommandRule, runsMemoryCommand } from "./memory-policy";
import { explicitMerge, inspectMerge, protectedApiWrite, type MergeCall } from "./merge";
import type { ActTarget } from "../shared/quest-authority";

export interface ScopeCall { scopeFile?: string; draftApproved?: boolean; merge?: MergeCall | null; mergeMatches?: boolean; mergeHeadChanged?: boolean; mergeObserved?: boolean; clusterWriteApproved?: boolean; clusterObservation?: string; containment?: "sandbox"; kind: "tool" | "bash" | "write" | "read"; toolName: string; input: Record<string, unknown>; cwd: string; resolvedPaths?: Record<string, string>; pushTargets?: Record<string, string[]>; pushHeads?: Record<string, string>; gitRoots?: Record<string, string>; directories?: string[]; ownedDraftPrs?: string[]; ownedPrs?: string[]; questOwnedPrs?: string[]; observationId?: string; shellGrants?: readonly ShellGrantProjection[]; prGrantAvailable?(id: string): boolean }
export type Decision = { allow: true; check?: boolean; inspectionUnavailable?: true; acts?: Act[]; prGrant?: string; shellGrant?: string } | { allow: false; ruleId: string; reason: string; act?: ActKind };
const allowed: Decision = { allow: true };
export const BLOCK_MARKER = "[Tavern scope blocked]";
export const HELD_MARKER = BLOCK_MARKER + " Held ";
const keepWorking = "Tell your Keeper what you need it for and carry on with other work.";
export function blocked(what: string, ruleId: string, why: string): Decision {
  return { allow: false, ruleId, reason: `${BLOCK_MARKER} Blocked ${what}: ${why.replace(/\.$/, "")}. ${keepWorking}` };
}
function blockedAct(what: string, act: Act, ruleId = act.ruleId): Decision {
  const ask = actAskKind(act.kind);
  if (!ask) return blocked(what, ruleId, act.why);
  const why = ruleId === "pr-sends-as-you" ? " " + act.why : "";
  return { allow: false, act: act.kind, ruleId, reason: `${HELD_MARKER}${act.kind}. This needs a ${ask} ask. Nothing was done. ${keepWorking} Held command: ${JSON.stringify(what.slice(0, 8000))}.${why}` };
}
export function mergeBlock(merge: MergeCall, target?: ActTarget, staleVerdict = false) {
  const where = merge.repository ?? target?.merge?.repository ?? "unresolved repository";
  const branch = merge.branch ?? target?.merge?.targetBranch ?? "unresolved target branch";
  const why = merge.issue ?? (staleVerdict ? "the Warden verdict is no longer current" : "no current, unused approval matches this exact protected write");
  const next = staleVerdict ? `Get a current Warden verdict on ${target?.commit}.` : merge.issue ? "Name one exact repository, source, target branch and head revision." :
    "Ask the user with tavern_ask; for an open ask use its mergeAskId and action ask-user.";
  return { allow: false as const, ruleId: "merge-approval", reason: `${BLOCK_MARKER} ${merge.description} to ${where} (${branch}): ${why}. ${next}` };
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
  if (program === "kubectl") return kubectlRead(argv);
  if (program === "helm") return sub === "template" && !argv.some(arg => /^--output-dir(?:=|$)/.test(arg));
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
export function clusterWriteBlock(source: string, closing = false, role?: string) {
  const action = role === "keeper"
    ? "Ask with tavern_ask, kind cluster-write: give the exact command, context, namespace, what changes and how to undo it."
    : "Tell your Keeper the exact command, context, namespace, what changes and how to undo it. The Keeper asks the user to approve it for this thread.";
  return { allow: false as const, ruleId: closing ? "closing-act" : "cluster-write", reason: `${BLOCK_MARKER} Blocked ${source.slice(0, 2000)}: ${closing ? "Closing time: cluster writes wait for your return. " : ""}Cluster writes always need the user's approval and confirmation for the exact command. ${action} Carry on with other work meanwhile.` };
}
export function clusterWriteCommands(source: string, cwd: string, depth = 0): ShellCommand[] {
  if (depth >= 16) throw new Error("nested shell commands exceed the guard's inspection limit");
  return shellCommands(source, cwd).flatMap(command => [
    ...(actsForCommand(command).some(act => act.kind === "cluster-write") ? [command] : []),
    ...nestedCommands(command).flatMap(nested => clusterWriteCommands(nested, command.cwd, depth + 1)),
  ]);
}
export function hasClusterWrite(source: string, cwd: string): boolean {
  try { return clusterWriteCommands(source, cwd).length > 0; }
  catch { return fallbackActs(source).some(act => act.kind === "cluster-write"); }
}
export function communicationAct(scope: Scope, call: ScopeCall): CommunicationPreview | undefined {
  const named = namedCommunication(scope.sendTools, call);
  return named?.act === "send" ? named : shellCommunication(scope, call) ?? named;
}
export function communicationDecision(scope: Scope, call: ScopeCall): Decision | undefined {
  const act = communicationAct(scope, call);
  if (act?.act === "send") return { allow: false, ruleId: "send-guard", act: "send", reason: `${BLOCK_MARKER} Agents do not send as you. Draft instead for the user to post. Nothing was sent.` };
  if (act?.act === "draft" && !call.draftApproved) return { allow: false, ruleId: "draft-guard", act: "draft", reason: `${BLOCK_MARKER} This draft needs approval. Nothing was drafted.` };
}
export function authorityDecision(scope: Scope, call: ScopeCall, remote = false): Decision | undefined {
  const communication = communicationDecision(scope, call);
  if (communication) return communication;
  if (scope.role !== "keeper" && ["spawn", "bb_workflow_run"].includes(call.toolName)) return { allow: false, ruleId: "member-spawn", reason: "Members don't start threads; ask your Keeper to hire." };
  if (!remote && isWriteCall(call)) {
    const paths = [call.input.path, call.input.file_path, call.input.new_path].filter((path): path is string => typeof path === "string");
    if (typeof call.input.patch === "string")
      for (const match of call.input.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(match[1].trim());
    if (targetsControlFile(paths, call.cwd, scope, call.scopeFile)) return controlBlock();
    if (targetsMakerWorktree(scope, paths, call.cwd)) return makerBlock();
  }
  const approvedDraft = call.draftApproved === true && namedCommunication(scope.sendTools, call)?.act === "draft";
  if (closingTool(scope, call.toolName, approvedDraft))
    return blocked("tool " + call.toolName, "closing-act", "Closing time: this tool waits for your return");
  const source = call.input.command ?? call.input.cmd;
  if (typeof source !== "string") return;
  const closing = !call.clusterObservation && scope.shell.deny.some(rule => rule.id.startsWith("away:") || rule.id === "cluster-write-while-away");
  let commands: ShellCommand[];
  try { commands = shellCommands(source, call.cwd, { env: scope.env.variables, gitRoots: call.gitRoots, directories: call.directories }); } catch {
    if (terraformStateFallback.test(source)) return stateBlock("The Terraform command could not be checked for shared-state locks.");
    const acts = fallbackActs(source);
    if (acts.some(act => act.kind === "cluster-write")) return clusterWriteBlock(source, closing, scope.role);
    if (acts.some(act => act.kind === "tavern-control")) return { allow: false, ruleId: "tavern-control", reason: "Tavern's controls are the user's; ask the user." };
    return;
  }
  for (const command of commands) {
    const stateProblem = terraformStateProblem(command);
    if (stateProblem) return stateBlock(stateProblem);
    if (!remote) {
      let paths: string[];
      try { paths = commandWritePaths(command); } catch { paths = command.writes; }
      const destructive = ["rm", "mv", "rmdir"].includes(command.argv[0]);
      if (targetsControlFile(paths, command.cwd, scope, call.scopeFile, destructive)) return controlBlock();
      if (targetsMakerWorktree(scope, paths, command.cwd, destructive) ||
          command.argv[0] === "git" && !gitRead(command.argv) && targetsMakerWorktree(scope, [command.cwd], command.cwd))
        return makerBlock();
    }
    if (actsForCommand(command).some(act => act.kind === "cluster-write")) {
      if (closing || !call.clusterWriteApproved) return clusterWriteBlock(source, closing, scope.role);
      if (["kubectl", "k"].includes(command.argv[0]) || /[$`]/.test(command.argv[0] ?? "")) {
        const target = clusterCommandTarget(command);
        if (!target?.context || !target.namespace || /[$`]/.test(target.context + target.namespace))
          return blocked("Kubernetes write", "cluster-target", "the exact command must explicitly name a literal cluster context and namespace");
      }
    }
    if (userControl(command)) return { allow: false, ruleId: "tavern-control", reason: "Tavern's controls are the user's; ask the user." };
    const words = bbPositionals(command.argv);
    if (scope.role !== "keeper" && words[0] === "bb" && words[1] === "thread") {
      if (words[2] === "spawn") return { allow: false, ruleId: "member-spawn", reason: "Members don't start threads; ask your Keeper to hire." };
      if (words[2] === "archive" && !agentProgram(command.argv)) return { allow: false, ruleId: "member-archive", reason: "Members don't archive threads; ask your Keeper." };
    }
    for (const source of nestedCommands(command)) {
      const decision = authorityDecision(scope, { ...call, input: { command: source }, cwd: command.cwd }, remote || command.argv[0] === "ssh");
      if (decision) return !decision.allow && ["cluster-write", "closing-act"].includes(decision.ruleId) ? clusterWriteBlock(String(call.input.command ?? call.input.cmd), decision.ruleId === "closing-act", scope.role) : decision;
    }
  }
}
const controlBlock = () => blocked("file change", "tavern-control-files", "Tavern settings, rules, receipts and guard files are protected");
const makerBlock = () => blocked("file change", "checker-write", "the maker's checkout is read-only for its Warden");
const stateBlock = (why: string) => blocked("shared-state command", "terraform-state", why);

export const isWriteCall = (call: ScopeCall) =>
  call.kind === "write" || ["write", "edit", "apply_patch", "multiedit"].includes(call.toolName.toLowerCase());

const isGuardedAct = (act: Act) => act.kind !== "configure" && act.kind !== "allocate";

export function evaluate(scope: Scope, call: ScopeCall, _legacyWanderer = false): Decision {
  return evaluateShell(scope, call, false);
}

function evaluateShell(scope: Scope, call: ScopeCall, remote: boolean): Decision {
  const authority = authorityDecision(scope, call, remote);
  if (authority) return authority;
  const source = call.input.command ?? call.input.cmd;
  if (typeof source !== "string") return call.kind === "bash" ? { allow: true, inspectionUnavailable: true } : allowed;
  if (scope.role === "keeper" && scope.mode !== "off" && !call.mergeObserved) {
    const merge = call.merge === undefined ? inspectMerge(source, call.cwd, undefined) : call.merge;
    if (merge && !call.mergeMatches) return mergeBlock(merge);
  }
  const contained = call.containment === "sandbox" && scope.sandbox && ["bash", "Bash"].includes(call.toolName);
  const memoryRule = memoryCommandRule(scope);
  const memoryPaths = memoryRule?.argv?.[0];
  let commands;
  try { commands = shellCommands(source, call.cwd, { temporaryRoot: temporaryRoot(scope), isRead: contained ? containmentRead : readonlyProgram, gitRoots: call.gitRoots, directories: call.directories, env: scope.env.variables, containment: contained ? "sandbox" : undefined }); } catch {
    const route = fallbackPullRequestRoute(source);
    const acts = route ? [route, ...fallbackActs(source)] : fallbackActs(source);
    const guarded = acts.filter(isGuardedAct);
    const refused = acts.find(act => closingAct(scope, act, source)) ?? guarded.find(act => scope.mode !== "off" &&
      (act === route ? typedPullRequestAct(act) || act.kind !== "send" || scope.pullRequestPolicy?.alwaysAsk !== false : scope.role !== "keeper" || act.kind === "merge"));
    if (refused) return closingAct(scope, refused, source)
      ? blocked("shell command", "closing-act", "Closing time: " + refused.kind + " waits for your return")
      : typedPullRequestAct(refused) ? blocked("pull request command", refused.ruleId, refused.why)
        : blockedAct(source, refused, refused.kind === "deploy" ? "deploy-fallback" : refused.ruleId);
    if (memoryRule && Array.isArray(memoryPaths) && memoryPaths.some(path => source.includes(path))) return blocked("shell command", memoryRule.id, memoryRule.why);
    return { allow: true, inspectionUnavailable: true, ...(guarded.length ? { acts: guarded } : {}) };
  }
  let checking = false, inspectionUnavailable = false, prGrant: string | undefined, shellGrant: string | undefined;
  const grantTarget = call.shellGrants?.length && commands.length === 1 ? shellGrantTarget(call, commands[0]) : null;
  const grant = grantTarget && call.shellGrants?.find(g => g.digest === grantTarget.digest);
  const matchesGrant = (act: Act) => !!grant && grantTarget?.act === act.kind;
  const observed: Act[] = [];
  for (const command of commands) {
    if (memoryRule && Array.isArray(memoryPaths) && runsMemoryCommand(memoryPaths, command, call.resolvedPaths))
      return blocked(command.text, memoryRule.id, memoryRule.why);
    for (const source of nestedCommands(command)) {
      const result = evaluateShell(scope, { ...call, input: { command: source }, cwd: command.cwd, prGrantAvailable: undefined, shellGrants: undefined }, remote || command.argv[0] === "ssh");
      if (!result.allow) return result;
      checking ||= result.check === true;
      inspectionUnavailable ||= result.inspectionUnavailable === true;
      observed.push(...result.acts ?? []);
    }
    const read = (contained ? containmentRead : readonlyProgram)(command), check = !remote && checkInvocation(scope, command, source, read);
    if (check) {
      if (["git", "curl", "wget"].includes(command.argv[0]) && !read)
        return blocked(command.text, "checker-write", "verification commands cannot write to Git or the network");
      const root = scope.checks?.worktree, location = call.resolvedPaths?.[normalizeToolPath(command.cwd, call.cwd)] ?? command.cwd;
      if (!root?.startsWith("/") || root === "/" || root === scope.env.variables.HOME || !within(location, root) || command.uncertain) return blocked(command.text, "checker-worktree", "checks must run in the trusted maker worktree; ask the Keeper to bind checks.worktree or use that directory");
      checking = true;
    }
    inspectionUnavailable ||= command.scriptInput === "opaque" || command.uncertain === true;
    const argv = command.argv;
    const closingLocal = scope.shell.deny.find(rule => /^away:.*:(?:delete|find-delete|git-delete|merge)$/.test(rule.id) && ruleMatches(rule, command));
    if (closingLocal) return blocked("shell command", closingLocal.id, closingLocal.why);
    const excepted = (id: string) => !["cluster-write", "deploy"].includes(id) && scope.shell.allow.some(rule => {
      if (rule.id !== id || !ruleMatches(rule, command)) return false;
      if (!rule.remote) return true;
      const push = pushSpec(argv);
      if (!push) return false;
      const targets = call.pushTargets?.[command.cwd + "\0" + push.remote];
      return !!targets?.length && targets.every(target => glob(rule.remote!, normalizeRemote(target)));
    });
    if (scope.role !== "keeper" && protectedApiWrite(command)) {
      const act: Act = { kind: "merge", ruleId: "merge-approval", why: "Use the exact protected merge approval, not a publishing grant" };
      if (closingAct(scope, act, command)) return blocked("protected API write", "closing-act", "Closing time: merge waits for your return");
      if (scope.mode !== "off") return blockedAct(source, act);
    }
    const smithOwned = Boolean(call.ownedPrs?.includes(draftEditKey(command)));
    const questOwned = pullRequestOwned(command, scope.pullRequestPolicy?.owned ?? [], call.questOwnedPrs ?? []);
    const route = scope.role === "keeper" && (call.mergeMatches || call.mergeObserved) && explicitMerge(command) ? undefined : pullRequestRoute(command, smithOwned || questOwned);
    if (route && typedPullRequestAct(route) && scope.mode !== "off") return blocked(command.text, route.ruleId, route.why);
    if (route?.kind === "send" && scope.mode !== "off") {
      const prException = commands.length === 1 && !command.githubEnvironment && scope.pullRequestPolicy?.grants.find(g => g.digest === prCommandDigest(source) && call.prGrantAvailable?.(g.id));
      if (!prException && scope.pullRequestPolicy?.alwaysAsk !== false) {
        if (closingAct(scope, route, command)) return blocked(command.text, "closing-act", "Closing time: " + route.kind + " waits for your return");
        if (!matchesGrant(route)) return blockedAct(source, route);
        shellGrant = grant!.id;
      }
      if (prException) prGrant = prException.id;
    }
    const commandActs = (route && !smithOwned ? [route] : scope.pullRequestPolicy?.alwaysAsk === false && route?.kind === "send" ? [route] : actsForCommand(command));
    if ((call.mergeMatches || call.mergeObserved) && !commandActs.some(act => act.kind === "merge"))
      commandActs.push({ kind: "merge", ruleId: "merge-approval", why: "Uses the recorded approval for this protected write" });
    const approvedClusterWrite = call.clusterWriteApproved && commandActs.some(act => act.kind === "cluster-write");
    for (const act of commandActs) {
      const isApprovedClusterAct = approvedClusterWrite && act.kind === "cluster-write";
      if (!(isApprovedClusterAct && call.clusterObservation) && closingAct(scope, act, command)) return blocked(command.text, "closing-act", "Closing time: " + act.kind + " waits for your return");
      if (!isGuardedAct(act)) continue;
      observed.push(act);
      if (scope.mode !== "off" && !isApprovedClusterAct && !baselineHolds(scope, call, command, act) && !excepted(act.ruleId)) {
        if (!matchesGrant(act)) return blockedAct(source, act);
        shellGrant = grant!.id;
      }
    }
    if (scope.mode !== "off" && commandActs.some(isGuardedAct))
      for (const rule of scope.shell.deny)
        if (!isCatalogueRule(rule) && ruleMatches(rule, command) && !excepted(rule.id)) return blocked(command.text, rule.id, rule.why);
  }
  return { allow: true, ...(checking ? { check: true } : {}), ...(inspectionUnavailable ? { inspectionUnavailable: true } : {}), ...(observed.length ? { acts: observed } : {}), ...(prGrant ? { prGrant } : {}), ...(shellGrant ? { shellGrant } : {}) };
}
