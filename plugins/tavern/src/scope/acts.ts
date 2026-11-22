import type { ActKind } from "./act-routing";
import { selectedAwayGuards } from "./away-policy";
import type { Scope, ShellRule } from "./schema";
import { writeAllowed } from "./paths";
import type { ScopeCall } from "./engine";
import { agentProgram, bbControlPositionals, bbPositionals } from "./legacy";
import { draftEditKey, githubApiRead } from "./github";
import { pushSpec } from "./remote";
import type { ShellCommand } from "./shell";
import { AUTHORITY, USER_ONLY_CLI } from "../shared/authority";
import { pullRequestWrite } from "./pr-policy";

const userMethods = new Set([...Object.keys(AUTHORITY).filter(act => AUTHORITY[act as keyof typeof AUTHORITY].level === "user-explicit"),
  "memoryProjects", "memorySettings", "memoryList", "memoryPrevious"]);
const bbOptions = String.raw`\s+(?:--(?:input-file|project|host|server|url|token)\s+[^\s;\n]+\s+|--[^\s;\n]+\s+)*`;
const cliControls = USER_ONLY_CLI.map(command => {
  const words = command.split(" "), option = words.at(-1)?.startsWith("--") ? words.pop() : undefined;
  return { words, option };
});
const controlEnd = String.raw`(?=$|[\s;|&])`;
const cliFallback = cliControls.map(({ words, option }) => words.join(bbOptions) + controlEnd + (option ? String.raw`[^;\n]*\s${option}(?=$|[\s=;|&])` : "")).join("|");
const tavernControlFallback = new RegExp(String.raw`\bbb${bbOptions}(?:(?:plugin${bbOptions}run${bbOptions})?tavern${bbOptions}(?:${cliFallback})|plugin${bbOptions}rpc${bbOptions}call${bbOptions}tavern${bbOptions}(?:${[...userMethods].join("|")})${controlEnd})`);
export function userControl(command: ShellCommand): boolean {
  const [program, group, verb, action, plugin, method] = bbControlPositionals(command.argv);
  if (program !== "bb") return false;
  if (group === "plugin" && verb === "rpc" && action === "call")
    return plugin === "tavern" && (userMethods.has(method) || /[$`]/.test(method ?? ""));
  if (group !== "tavern") return false;
  const words = bbControlPositionals(command.argv).slice(2);
  return cliControls.some(spec => spec.words.every((word, i) => word === words[i]) &&
    (!spec.option || command.argv.some(arg => arg === spec.option || arg.startsWith(spec.option + "="))));
}

export { ACT_KINDS, type ActKind } from "./act-routing";
export interface Act { kind: ActKind; ruleId: string; why: string }
interface ActDefinition extends Act { commands: string[]; matches(command: ShellCommand): boolean; fallback: RegExp }
const pr = (command: ShellCommand, actions: string[]) => ["gh", "dt"].includes(command.argv[0]) && command.argv[1] === "pr" && actions.includes(command.argv[2]);
export const kubectlRead = (a: string[]) => ["get", "describe", "logs", "events", "version", "api-resources", "api-versions", "explain", "cluster-info", "top", "wait", "kustomize", "completion"].includes(a[1])
  || a[1] === "auth" && a[2] === "can-i"
  || a[1] === "config" && ["view", "get-contexts", "current-context", "use-context", "set-context", "get-clusters", "get-users", "rename-context", "delete-context", "delete-cluster", "delete-user", "set-cluster", "set-credentials", "set", "unset"].includes(a[2])
  || a[1] === "plugin" && a[2] === "list"
  || a[1] === "rollout" && ["status", "history"].includes(a[2]);
const kubectlWrites = "apply|create|replace|patch|edit|delete|scale|exec|cp|drain|cordon|uncordon|annotate|label|set|taint|restart|undo|port-forward|proxy|diff|rollout|autoscale|debug|run|certificate";
const terraformWrites = "apply|destroy|import|refresh|taint|untaint|force-unlock";
const helmWrites = "install|upgrade|uninstall|rollback|test";
const terraformStateWrite = "mv|rm|push|replace-provider";
const terraformWorkspaceWrite = "new|delete";
const hasVerb = (pattern: string, verb: string) => pattern.split("|").includes(verb);
const dynamicClusterVerbs = new Set(["delete", "exec", "cp", "scale", "rollout", "drain", "cordon", "upgrade", "uninstall", "rollback", "destroy", "port-forward"]);
function clusterWrite(c: ShellCommand): boolean {
  const [program, verb, sub] = c.argv;
  const dynamic = /[$`]/.test(program ?? "");
  const index = dynamic ? c.argv.findIndex((arg, i) => i > 0 && !arg.startsWith("-")) : -1;
  const dynamicVerb = c.argv[index];
  const target = c.argv[index + 1];
  // A plain positional operand is also used by git apply; it is not a cluster signal.
  const clusterApply = dynamicVerb === "apply" && (!target || /^-(?:f|k)(?:$|.)|^--(?:filename|kustomize|auto-approve|var(?:-file)?|target)(?:=|$)/.test(target) || target.endsWith(".tfplan"));
  return (program === "kubectl" || program === "k") && !!verb && !kubectlRead(c.argv)
    || index > 0 && (dynamicClusterVerbs.has(dynamicVerb) || clusterApply)
    || dynamic && (verb === "state" && hasVerb(terraformStateWrite, sub) || verb === "workspace" && hasVerb(terraformWorkspaceWrite, sub))
    || program === "terraform" && (hasVerb(terraformWrites, verb) || verb === "state" && hasVerb(terraformStateWrite, sub) || verb === "workspace" && hasVerb(terraformWorkspaceWrite, sub))
    || program === "helm" && hasVerb(helmWrites, verb)
    || program === "kapp" && ["deploy", "delete"].includes(verb);
}
export function clusterCommandTarget(command: ShellCommand) {
  const [program, ...args] = command.originalArgv ?? command.argv;
  const readFlag = (...flags: string[]): string | undefined => {
    let value: string | undefined;
    for (let i = 0; i < args.length && args[i] !== "--"; i++) {
      for (const flag of flags) {
        if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith("-")) { value = args[++i]; break; }
        if (args[i].startsWith(flag + "=")) value = args[i].slice(flag.length + 1);
        else if (flag === "-n" && args[i].startsWith("-n") && args[i].length > 2) value = args[i].slice(2);
      }
    }
    return value || undefined;
  };
  if (!["kubectl", "k", "helm", "kapp"].includes(program) && !/[$`]/.test(program ?? "")) return undefined;
  const context = readFlag(program === "helm" ? "--kube-context" : program === "kapp" ? "--kubeconfig-context" : "--context");
  const namespace = readFlag("--namespace", "-n");
  return context || namespace ? { context, namespace } : undefined;
}
const githubRead = (a: string[]) => ["view", "list", "status", "diff", "checks"].includes(a[2]) || a[1] === "run" && a[2] === "watch" || ["status", "search", "version", "help", "--help", "--version"].includes(a[1]) || a[1] === "auth" && a[2] === "status" || a[1] === "api" && githubApiRead(a);
const httpWrite = (a: string[]) => a[0] === "curl" ? a.some((arg, i) => /^--(?:data|json|form|upload|config)|^-[^-]*[dFTK]/.test(arg) || /^(?:--request=|-X)(?!GET$|HEAD$|OPTIONS$).+/.test(arg) || ["-X", "--request"].includes(arg) && !["GET", "HEAD", "OPTIONS"].includes(a[i + 1])) : a[0] === "wget" && a.some(arg => /^--(?:post|body|method|input-file)/.test(arg));
const cloudWrite = (a: string[]) => a[0] === "gcloud" && a[1] === "storage" && ["cp", "mv", "rm", "rsync"].includes(a[2]);
function localHttp(a: string[]): boolean {
  const targets: string[] = [];
  const values = ["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-H", "--header", "-X", "--request", "-o", "--output", "-u", "--user", "-F", "--form", "-T", "--upload-file"];
  for (let i = 1; i < a.length; i++) {
    if (values.includes(a[i])) { i++; continue; }
    if (a[i] === "--url") targets.push(a[++i] ?? "");
    else if (a[i].startsWith("--url=")) targets.push(a[i].slice(6));
    else if (/^https?:\/\//.test(a[i])) targets.push(a[i]);
    else if (/^(?:localhost|127(?:\.\d{1,3}){0,3}|\[::1\])(?::\d+)?(?:\/|$)/.test(a[i])) targets.push("http://" + a[i]);
  }
  return targets.length > 0 && targets.every(target => {
    try { const host = new URL(target).hostname; return host === "localhost" || host === "[::1]" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host); }
    catch { return false; }
  });
}
const dangerousPush = (args: string[]) => args.some(arg => /^--(?:force|mirror|delete|all|tags|follow-tags|prune)(?:=|$)/.test(arg) || /^--force-if-includes(?:=|$)/.test(arg) && !args.some(flag => /^--force-with-lease(?:=|$)/.test(flag)) || /^-[^-]*[fd]/.test(arg) || arg.startsWith("+") || arg.startsWith(":"));
const cloudReads = ["list", "describe", "get-value", "read", "cat", "ls", "info"];
const cloudWrites = ["cp", "mv", "rm", "rsync", "create", "delete", "update", "set", "reset", "deploy", "apply", "destroy", "import", "install", "uninstall", "remove", "add"];
function machineRead(command: ShellCommand): boolean {
  const [program, sub, action, verb] = bbPositionals(command.argv);
  return program === "bb" && sub === "machine" && (!action || ["providers", "list", "show", "status", "logs", "help"].includes(action) || action === "env" && (!verb || ["list", "help"].includes(verb)));
}
export function readerNeedsDecision(command: ShellCommand): boolean {
  const [program, sub, action] = command.argv;
  if (["bb", "cortex"].includes(program)) return !agentProgram(command.argv) && !machineRead(command);
  if (program !== "gcloud" || sub === "config" && action === "set") return false;
  const verb = command.argv.slice(2).find(arg => cloudReads.includes(arg) || cloudWrites.includes(arg));
  return !verb || !cloudReads.includes(verb);
}
const providerMachineGroup = String.raw`[a-z0-9][a-z0-9-]*-machines`;
const providerMachineCommand = new RegExp(`^${providerMachineGroup}$`);
const providerConfigure = "rotate|park|remove";
const machineAllocate = "create|enroll";
function controlAct(command: ShellCommand): "configure" | "delete" | undefined {
  const argv = bbPositionals(command.argv), [program, sub, action, verb] = argv;
  if (program === "cortex") {
    if (["rm", "delete", "remove"].includes(sub)) return "delete";
    if (["agents", "reset", "restore"].includes(sub)) return "configure";
  }
  if (program === "bb") {
    if (sub === "plugin" && ["install", "uninstall", "enable", "disable", "dev", "settings"].includes(action) ||
      sub === "settings" && action === "set" ||
      sub === "lan" && ["on", "off", "pair", "revoke"].includes(action) ||
      sub === "loom" && ["approve", "start", "land", "live", "archive", "pause", "resume"].includes(action) ||
      ["automations", "automation"].includes(sub) && ["create", "update", "delete", "enable", "disable"].includes(action) ||
      providerMachineCommand.test(sub) && hasVerb(providerConfigure, action) ||
      sub === "machine" && (action === "rotate" || action === "env" && ["set", "unset"].includes(verb)) ||
      sub === "secrets" && action !== "request" || userControl(command) && argv.includes("settings")) return "configure";
    if (["thread", "project", "environment", "machine"].includes(sub) && ["delete", "archive", "remove"].includes(action)) return "delete";
  }
  if (program === "gcloud" && !cloudWrite(argv)) {
    const cloudVerb = argv.slice(2).find(arg => cloudReads.includes(arg) || cloudWrites.includes(arg));
    if (cloudVerb === "delete" || cloudVerb === "remove") return "delete";
  }
}
const deployFallback = /\bgcloud\b[^;\n]*\b(?:run|app|functions)\s+deploy\b|\b(?:dev|dt|quick)\s+deploy\b/;
const kubectlWriteFallback = new RegExp(String.raw`\bkubectl\b[^;\n]*\b(?:${kubectlWrites})\b|(?:^|[;&|(\n])[^\S\n]*k[^\S\n]+[^;&|\n]*\b(?:${kubectlWrites})\b`);
const otherClusterWriteFallback = new RegExp(String.raw`\b(?:terraform\s+(?:-chdir=\S+\s+)?(?:${terraformWrites}|state\s+(?:${terraformStateWrite})|workspace\s+(?:${terraformWorkspaceWrite}))|helm\b[^;\n]*\b(?:${helmWrites})|kapp\b[^;\n]*\b(?:deploy|delete))\b`);
const httpWriteFallback = /\b(?:curl|wget)\b[^;\n]*(?:--(?:data|json|form|upload|post|body|method)|-[dFT]|-X\s*(?:POST|PUT|PATCH|DELETE))/;
const sendFallback = /\b(?:slack|slack-cli|mail|mailx|sendmail|mutt)\b/;
export const ACT_CATALOGUE: readonly ActDefinition[] = [
  { kind: "merge", ruleId: "gh-merge", why: "Merging needs the user's grant", commands: ["gh pr merge", "dt pr merge", "git push main|master"], matches: c => pr(c, ["merge"]) || c.argv[0] === "git" && c.argv[1] === "push" && (pushSpec(c.argv)?.refs ?? []).some(ref => /^(?:refs\/heads\/)?(?:main|master)$/.test(ref.split(":").at(-1)!)), fallback: /\b(?:gh|dt)\b[^;\n]*\bpr\s+merge\b|\bgit\s+push\b[^;\n]*\b(?:main|master)\b/ },
  ...(["ready", "close", "review"] as const).map(kind => ({ kind, ruleId: "pr-" + kind, why: `Pull request ${kind} needs a grant`, commands: [`gh pr ${kind}`, `dt pr ${kind}`, ...(kind === "review" ? ["dt pr approve"] : [])], matches: (c: ShellCommand) => pr(c, kind === "review" ? ["review", "approve"] : [kind]), fallback: new RegExp(`\\b(?:gh|dt)\\b[^;\\n]*\\bpr\\s+(?:${kind}${kind === "review" ? "|approve" : ""})\\b`) })),
  { kind: "publish", ruleId: "publish", why: "Publishing outside the member's own work needs a grant", commands: ["git push", "gh writes", "dt pr create|edit|comment", "gcloud writes", "package publish", "gs submit"], matches: c => {
    const [p, s, a] = c.argv;
    return p === "git" && s === "push" || p === "gh" && !githubRead(c.argv) && !(s === "auth" && a === "token") && !pr(c, ["merge", "ready", "close", "review", "approve"]) || pr(c, ["create", "edit", "comment"]) || cloudWrite(c.argv) || ["npm", "yarn", "pnpm", "bun", "cargo"].includes(p) && c.argv.slice(1).includes("publish") || p === "gem" && s === "push" || p === "twine" && s === "upload" || ["gs", "git-spice"].includes(p) && (["ss", "bs", "rs", "us", "uss", "bss", "dss"].includes(s) || ["submit", "sync", "publish", "land"].includes(a));
  }, fallback: /\bgit\s+push\b|\b(?:gh|dt)\b[^;\n]*\b(?:create|edit|comment|publish|upload|dispatch)\b|\b(?:npm|yarn|pnpm|bun|cargo)\s+publish\b|\b(?:gem\s+push|twine\s+upload)\b|\bgcloud\s+storage\s+(?:cp|mv|rm|rsync)\b/ },
  { kind: "cluster-write", ruleId: "cluster-write", why: "Cluster writes always need the user's answer for the exact command", commands: ["kubectl writes", "terraform writes", "helm writes", "kapp deploy|delete"], matches: clusterWrite, fallback: new RegExp(`${kubectlWriteFallback.source}|${otherClusterWriteFallback.source}`) },
  { kind: "deploy", ruleId: "deploy", why: "Deployments need a grant", commands: ["dev deploy", "dt deploy", "quick deploy", "gcloud run|app|functions deploy"], matches: c => { const [p, s] = c.argv; return ["dev", "dt"].includes(p) && s === "deploy" || p === "quick" && c.argv.includes("deploy") || p === "gcloud" && ["run", "app", "functions"].includes(s) && c.argv[2] === "deploy"; }, fallback: deployFallback },
  { kind: "send", ruleId: "send", why: "Sending as the user needs a grant", commands: ["curl writes", "wget writes", "Slack and mail sends"], matches: c => httpWrite(c.argv) && !localHttp(c.argv) || ["slack", "slack-cli", "mail", "mailx", "sendmail", "mutt"].includes(c.argv[0]) || ["hermes", "gog"].includes(c.argv[0]) && c.argv.some(a => ["send", "post", "publish", "create", "update", "delete"].includes(a)), fallback: new RegExp(`${httpWriteFallback.source}|${sendFallback.source}`) },
  { kind: "delete", ruleId: "delete", why: "Deleting the user's things needs a grant", commands: ["bb thread|project|environment delete", "bb machine remove", "cortex rm", "gcloud resource delete"], matches: c => controlAct(c) === "delete", fallback: /\bbb\b[^;\n]*\b(?:thread|project|environment|machine)\s+(?:delete|archive|remove)\b|\bcortex\s+(?:rm|delete|remove)\b|\bgcloud\b[^;\n]*\b(?:delete|remove)\b/ },
  { kind: "configure", ruleId: "configure", why: "Changing the user's tools or settings needs a grant", commands: ["bb plugin install|uninstall|enable|disable|dev|settings", "bb settings set", "bb lan on|off|pair|revoke", "bb loom approve|start|land|live|archive|pause|resume", "bb automations create|update|delete|enable|disable", `bb *-machines ${providerConfigure}`, "bb machine rotate|env set|env unset", "bb secrets except request", "cortex agents|reset|restore", "Tavern settings writes"], matches: c => controlAct(c) === "configure", fallback: new RegExp(String.raw`\bbb\b[^;\n]*\b(?:plugin\s+(?:install|uninstall|enable|disable|dev|settings)|loom\s+(?:approve|start|land|live|archive|pause|resume)|automations?\s+(?:create|update|delete|enable|disable)|lan\s+(?:on|off|pair|revoke)|settings\s+set|${providerMachineGroup}\s+(?:${providerConfigure})|machine\s+(?:rotate|env\s+(?:set|unset))|secrets(?!\s+request\b))\b|\bcortex\s+(?:agents|reset|restore)\b`) },
  { kind: "credential", ruleId: "credential", why: "Revealing a credential needs the user's grant", commands: ["gh auth token", "security find-password -w|-g", "vault read|kv get", "gcloud secrets versions access"], matches: c => { const [p, s, a] = c.argv; return p === "gh" && s === "auth" && a === "token" || p === "security" && /^find-.*password$/.test(s ?? "") && c.argv.some(arg => /^-[^-]*[wg]/.test(arg)) || p === "gcloud" && s === "auth" && /^print-(?:access|identity)-token$/.test(a ?? "") || p === "gcloud" && s === "secrets" && a === "versions" && c.argv[3] === "access" || p === "vault" && (c.argv.includes("read") || c.argv.includes("kv") && c.argv.includes("get")); }, fallback: /\bgcloud\b[^;\n]*\bsecrets\s+versions\s+access\b|\bgh\s+auth\s+token\b|\bsecurity\s+find-[^;\n]*-[wg]\b|\bvault\s+(?:read|kv\s+get)\b/ },
  { kind: "tavern-control", ruleId: "tavern-control", why: "Tavern's controls are the user's; ask the user", commands: ["bb tavern user controls", "bb plugin rpc call tavern user controls"], matches: userControl, fallback: tavernControlFallback },
  { kind: "allocate", ruleId: "allocate", why: "Machines come only from rules; ask the Keeper", commands: [`bb machine|*-machines ${machineAllocate}`, "bb thread spawn with placement flags"], matches: c => { const [p, s, a] = bbPositionals(c.argv); return p === "bb" && (((s === "machine" || providerMachineCommand.test(s)) && hasVerb(machineAllocate, a)) || s === "thread" && a === "spawn" && (c.originalArgv ?? c.argv).some((arg, i, args) => /^(?:--new-machine|--machine|--host|--environment-provider|--project)(?:=|$)/.test(arg) && !["--task", "--title", "--message"].includes(args[i - 1]))); }, fallback: new RegExp(String.raw`\bbb\b[^;\n]*\b(?:machine|${providerMachineGroup})\s+(?:${machineAllocate})\b|\bbb\b(?=[^;\n]*\bthread\s+spawn\b)[^;\n]*--(?:new-machine|machine|host|environment-provider|project)\b`) },
];
export const actsForCommand = (command: ShellCommand): Act[] => {
  const flagEnd = command.argv.indexOf("--");
  const flags = flagEnd === -1 ? command.argv : command.argv.slice(0, flagEnd);
  if (flags.includes("--help") || flags.includes("--version")) return [];
  const acts = ACT_CATALOGUE.filter(act => act.matches(command)).map(({ kind, ruleId, why }) => ({ kind, ruleId, why }));
  if (command.argv[0] === "git" && command.argv[1] === "push") {
    const dangerous = dangerousPush(command.argv);
    const refs = pushSpec(command.argv)?.refs ?? [];
    const ambiguous = !refs.length || refs[0] === "tag" || refs.some(ref => !/^(?:refs\/heads\/)?[a-zA-Z0-9_][a-zA-Z0-9_./:-]*$/.test(ref) || ref.includes("..") || ref.startsWith("refs/") && !ref.startsWith("refs/heads/"));
    for (const act of acts) act.ruleId = act.kind === "merge" ? "git-push-main" : dangerous ? "git-push-force" : ambiguous ? "git-push-target" : "git-push";
    return acts.filter(act => act.kind !== "publish" || dangerous || ambiguous || !acts.some(other => other.kind === "merge"));
  }
  return acts;
};
export const fallbackActs = (source: string): Act[] => ACT_CATALOGUE.filter(act => act.fallback.test(source)).map(({ kind, ruleId, why }) => ({ kind, ruleId, why }));
const prDraftAct: Act = { kind: "send", ruleId: "pr-sends-as-you", why: "This pull request is not known to belong to the quest; use tavern_pull_request to record the decision or draft it for the user." };
const ownPrAct: Act = { kind: "publish", ruleId: "pr-owned-write", why: "Managing the quest’s own pull request" };
const prReadyAct: Act = { kind: "ready", ruleId: "pr-keeper-ready", why: "Only the Keeper marks a verified pull request ready or requests reviewers, through tavern_pull_request." };
const prCloseAct: Act = { kind: "close", ruleId: "pr-keeper-close", why: "Use tavern_pull_request to close a quest-owned pull request or draft the request for the user." };
export function pullRequestRoute(command: ShellCommand, owned: boolean): Act | undefined {
  if (command.argv.includes("--help") || command.argv.includes("--version")) return;
  if (pr(command, ["ready"]) || pr(command, ["create", "edit"]) &&
    command.argv.slice(3).some(arg => /^(?:--(?:add-)?reviewer(?:=|$)|-r)/.test(arg))) return prReadyAct;
  const write = pullRequestWrite(command);
  if (!write) return;
  if (write.operation === "close" && owned) return prCloseAct;
  if (owned && (write.operation === "comment" || write.operation === "edit")) return ownPrAct;
  return prDraftAct;
}
export function fallbackPullRequestRoute(source: string): Act | undefined {
  if (/\b(?:gh|dt)\b[^;\n]*\bpr\s+(?:ready\b|(?:create|edit)\b[^;\n]*\s(?:--(?:add-)?reviewer\b|-r\b))/.test(source)) return prReadyAct;
  if (/\b(?:gh|dt)\b[^;\n]*\bpr\s+(?:close|comment|edit|review|approve)\b/.test(source)) return prDraftAct;
}
export function baselineHolds(scope: Scope, call: ScopeCall, command: ShellCommand, act: Act): boolean {
  if (act.kind === "tavern-control") return false;
  if (scope.role === "keeper") return true;
  if (scope.role === "wanderer" && scope.preset === "open" && (act.ruleId === "pr-owned-write" || act.ruleId === "pr-sends-as-you" && scope.pullRequestPolicy?.alwaysAsk === false)) return true;
  if (scope.role !== "smith" || scope.preset !== "worktree" || act.kind !== "publish") return false;
  const [p, s, a] = command.argv;
  if (!writeAllowed(scope, command.cwd, command.cwd)) return false;
  if (p === "git" && s === "push") {
    const own = scope.assignedBranch;
    const refs = pushSpec(command.argv)?.refs ?? [];
    return !!own && !/^(?:main|master)$/.test(own) && refs.length > 0 && refs.every(ref => {
      const resolved = ref === "HEAD" ? call.pushHeads?.[command.cwd + "\0" + command.sequence] : ref;
      return resolved === own || resolved === "refs/heads/" + own || resolved === "HEAD:refs/heads/" + own || resolved === "HEAD:" + own || resolved === own + ":" + own || resolved === own + ":refs/heads/" + own;
    }) && !dangerousPush(command.argv);
  }
  if (!["gh", "dt"].includes(p) || s !== "pr" || scope.github !== "draft-pr-only" || command.githubEnvironment) return false;
  if (a === "create") return !!scope.assignedBranch && call.pushHeads?.[command.cwd + "\0" + command.sequence] === scope.assignedBranch && !command.repository && !command.argv.some(arg => /^(?:--head|--repo)(?:=|$)|^-H/.test(arg)) && command.argv.some(arg => ["--draft", "--draft=true", "-d"].includes(arg)) && !command.argv.includes("--draft=false") && !command.argv.some(arg => /^(?:--reviewer|--assignee|--label|--project)(?:=|$)|^-r/.test(arg));
  const owned = call.ownedPrs?.includes(draftEditKey(command));
  return !!owned && ["edit", "comment"].includes(a) && (a !== "edit" || command.argv.slice(3).every((arg, i, args) => !arg.startsWith("-") || ["--title", "--body", "--body-file", "-t", "-b", "-F"].includes(arg) && args[i + 1] !== undefined || /^(?:--(?:title|body|body-file)=|-[tbF].)/.test(arg)));
}
export const LEGACY_CATALOGUE_RULES: ShellRule[] = [
  { id: "gh-merge", argv: ["gh", "pr", "merge"], why: "Merging pull requests needs the user's decision" },
  { id: "deploy", argv: ["dev", "deploy"], why: "Deployments are outside this scope" },
  { id: "deploy-fallback", regex: "\\b(terraform\\s+(apply|destroy|import)|helm\\s+(install|upgrade|uninstall)|kapp\\s+deploy|dt\\s+deploy)\\b", why: "Deployments are outside this scope" },
  { id: "git-push", argv: ["git", "push"], why: "This scope does not allow pushes" },
];
export const isCatalogueRule = (rule: ShellRule) => LEGACY_CATALOGUE_RULES.some(legacy => Object.keys(rule).length === Object.keys(legacy).length && Object.entries(legacy).every(([key, value]) => JSON.stringify(rule[key as keyof ShellRule]) === JSON.stringify(value)));
const mainDestination = /^(?:refs\/heads\/)?(?:main|master)$/;
const mainRef = (ref: string) => mainDestination.test(ref.replace(/^\+/, "").split(":").at(-1)!);
const onlyMainPush = /^\s*git\s+push\s+(?:--(?:force-with-lease|force-if-includes|force|set-upstream)\s+|-u\s+)*[a-zA-Z0-9_.-]+(?:\s+\+?(?:[\w./-]*:)?(?:refs\/heads\/)?(?:main|master))+\s*$/;

export function closingAct(scope: Scope, act: Act, command: ShellCommand | string): boolean {
  const selected = selectedAwayGuards(scope);
  if (!selected) return scope.shell.deny.some(rule => rule.id.startsWith("away:"));
  const has = (kind: typeof selected[number]) => selected.includes(kind);
  if (act.kind === "publish" || act.kind === "merge") {
    if (typeof command === "string" && onlyMainPush.test(command)) return has("merge");
    const refs = typeof command === "string" ? null : pushSpec(command.argv)?.refs;
    if (refs?.some(mainRef)) return has("merge") || (has("other-writes") && refs.some(ref => !mainRef(ref)));
  }
  if (act.kind === "merge") return has("merge");
  if (act.kind === "delete") return has("delete");
  if (act.kind === "send") {
    if (typeof command !== "string") return has(["curl", "wget"].includes(command.argv[0]) ? "other-writes" : "sends-as-you");
    return (has("other-writes") && httpWriteFallback.test(command)) || (has("sends-as-you") && sendFallback.test(command));
  }
  if (act.kind === "deploy") return has("deploy");
  if (act.kind === "cluster-write") {
    if (typeof command !== "string") return has(command.argv[0] === "kubectl" ? "production" : "deploy");
    return (has("production") && kubectlWriteFallback.test(command)) || (has("deploy") && otherClusterWriteFallback.test(command));
  }
  return has("other-writes");
}
