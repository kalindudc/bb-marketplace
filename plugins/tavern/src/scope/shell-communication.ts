import type { CommunicationPreview } from "../shared/communication";
import { readableBody, readableTarget } from "./communication";
import type { ScopeCall } from "./engine";
import { nestedCommands } from "./legacy";
import { draftEditKey } from "./github";
import { ownedPullRequestTarget, pullRequestWrite } from "./pr-policy";
import type { Scope } from "./schema";
import { shellCommands, type ShellCommand } from "./shell";

const postVerbs = ["send", "post", "publish"];
const reviewOps = ["comment", "review", "approve"];
function flag(args: string[], keys: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (keys.includes(arg)) return args[index + 1];
    const eq = arg.indexOf("=");
    if (eq !== -1 && keys.includes(arg.slice(0, eq))) return arg.slice(eq + 1);
  }
}
function legacyTarget(program: string, args: string[]): string | undefined {
  if (["slack", "slack-cli"].includes(program)) {
    const verb = ["message", "messages", "chat"].includes(args[0]) ? 1 : 0;
    if (!postVerbs.includes(args[verb])) return;
    return flag(args, ["--channel", "--recipient", "--to"]) ?? (args[verb + 1]?.startsWith("-") ? "" : args[verb + 1] ?? "");
  }
  if (["hermes", "gog"].includes(program)) {
    if (!postVerbs.includes(args[0]) && !postVerbs.includes(args[1])) return;
    return flag(args, ["--channel", "--recipient", "--to"]) ?? "";
  }
  if (!["mail", "mailx", "sendmail", "mutt"].includes(program)) return;
  if (program !== "sendmail" && args.some(arg => /^(?:-f.+|-f|-H|-e|-N|-p|-q)$/.test(arg))) return;
  if (program === "sendmail" && args.some(arg => ["-bp", "-bv", "-q"].includes(arg))) return;
  const recipients = args.flatMap((arg, i) => !arg.startsWith("-") && !["-s", "-r", "-a", "-e", "-c", "-b", "-F", "-f"].includes(args[i - 1] ?? "") ? [arg] : []);
  return recipients.length ? recipients.join(", ") : program === "sendmail" && args.includes("-t") ? "" : undefined;
}
function preview(scope: Scope, call: ScopeCall, command: ShellCommand): CommunicationPreview | null | undefined {
  const [program, ...args] = command.argv;
  if (["--help", "--version"].some(arg => args.includes(arg))) return;
  const keeper = scope.role === "keeper";
  const write = pullRequestWrite(command, keeper);
  const policy = scope.pullRequestPolicy, facts = call.questOwnedPrs ?? {};
  const owned = ownedPullRequestTarget(command, write, policy?.owned ?? [], facts);
  if (write?.typedReady || keeper && owned && write?.keeperAction) return null;
  const legacyOwned = keeper && !write?.fileSourced && ownedPullRequestTarget(command, write, policy?.legacyOwned ?? [], facts);
  const body = flag(args, ["--body", "--message", "--text", "-b", "-m"]) ?? args.find(arg => arg.startsWith("body="))?.slice(5);
  const source = command.source ?? command.text;
  const detail = source.length <= 256 * 1024 ? source : undefined;
  if (write && reviewOps.includes(write.operation) && !args.includes("--delete-last") && !args.some(arg => arg.includes("requested_reviewers")) && !["DELETE", "PATCH", "PUT"].includes(flag(args, ["--method", "-X"])?.toUpperCase() ?? "")) {
    if (legacyOwned || !keeper && owned || scope.role === "smith" && call.ownedPrs?.includes(draftEditKey(command)) && write.operation === "comment") return;
    return { act: "send", tool: program + " pull request", target: readableTarget(write.target ?? write.selector), body: command.uncertain ? null : readableBody(body), detail };
  }
  const target = legacyTarget(program, args);
  if (target === undefined) return;
  const verb = ["message", "messages", "chat"].includes(args[0]) ? 1 : 0;
  const positional = ["slack", "slack-cli"].includes(program) && args.length === verb + 3 && !args[verb + 2].startsWith("-") ? args[verb + 2] : undefined;
  return { act: "send", tool: program, target: command.uncertain ? null : readableTarget(target), body: command.uncertain ? null : readableBody(body ?? positional ?? command.literalStdin), detail };
}
export function shellCommunication(scope: Scope, call: ScopeCall): CommunicationPreview | undefined {
  if (call.kind !== "bash" && !(scope.commandTools ?? ["bash", "Bash"]).includes(call.toolName)) return;
  const rawSource = call.input.command ?? call.input.cmd;
  const prefixes = scope.sendTools?.flatMap(rule => rule.shell ? [{ argv: rule.shell.split(/ +/), act: rule.act }] : []) ?? [];
  if (typeof rawSource !== "string" || !prefixes.length && !/\b(?:slack|slack-cli|mail|mailx|sendmail|mutt|hermes|gog|gh|dt)\b/.test(rawSource)) return;
  const source = rawSource;
  let draft: CommunicationPreview | undefined;
  function find(script: string, cwd: string, depth: number): CommunicationPreview | undefined {
    if (depth >= 16) return;
    let commands;
    try { commands = shellCommands(script, cwd, { captureStdin: true, gitRoots: call.gitRoots, directories: call.directories, env: scope.env.variables }); }
    catch { return; }
    for (const command of commands) {
      const found = preview(scope, call, command);
      if (found) return found;
      if (found !== null && !command.argv.some(arg => arg === "--help" || arg === "--version")) {
        const matched = prefixes.filter(rule => rule.argv.every((word, index) => word.toLowerCase() === command.argv[index]?.toLowerCase()));
        const rule = matched.find(rule => rule.act === "send") ?? matched[0];
        if (rule) {
          const [program, ...args] = command.argv;
          const body = flag(args, ["--body", "--message", "--text", "-b", "-m"]) ?? command.literalStdin;
          const detail = rule.act === "draft" ? source : command.source ?? command.text;
          const result = { act: rule.act, tool: program.slice(0, 200), target: null, body: command.uncertain ? null : readableBody(body), ...(detail.length <= 256 * 1024 ? { detail } : {}) };
          if (rule.act === "send") return result;
          draft ??= result;
        }
      }
      for (const nested of nestedCommands(command)) {
        const child = find(nested, command.cwd, depth + 1);
        if (child) return child;
      }
    }
  }
  return find(source, call.cwd, 0) ?? draft;
}
