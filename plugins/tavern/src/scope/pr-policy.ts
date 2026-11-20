import { createHash } from "node:crypto";
import { githubApiRead, draftEditSelector } from "./github";
import { parseScript } from "./parser";
import { shellCommands, type ShellCommand } from "./shell";
import type { PullRequestDraftOperation } from "../shared/pull-request";

export function prUrl(value: string | undefined) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:" || url.username || url.password || url.search || url.hash) return;
    return url.origin.toLowerCase() + url.pathname.replace(/\/+$/, "");
  } catch { return; }
}

export function pullRequestWrite(command: ShellCommand): { operation: PullRequestDraftOperation; target?: string; selector?: string } | undefined {
  const [program, group, verb, ...args] = command.argv;
  if (["gh", "dt"].includes(program) && group === "pr" && ["review", "approve", "comment", "edit", "close"].includes(verb)) {
    const selector = draftEditSelector(command.argv);
    return { operation: verb === "review" && args.some(arg => arg === "--approve" || arg === "-a") ? "approve" : verb as PullRequestDraftOperation,
      target: prUrl(selector ?? undefined), selector: selector ?? undefined };
  }
  if (program !== "gh" || group !== "api" || githubApiRead(command.argv)) return;
  const argv = command.originalArgv ?? command.argv;
  const at = argv.indexOf("api"), options = argv.slice(at + 1);
  let host = "github.com";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--hostname") host = argv[i + 1] ?? "";
    else if (argv[i].startsWith("--hostname=")) host = argv[i].slice(11);
  }
  const values = ["--method", "-X", "--header", "-H", "--hostname", "--input", "--field", "--raw-field", "-f", "-F", "--jq", "-q", "--template", "-t", "--cache"];
  let endpoint: string | undefined;
  for (let i = 0; i < options.length; i++) {
    const arg = options[i];
    if (values.includes(arg)) { i++; continue; }
    if (!arg.startsWith("-")) { endpoint = arg; break; }
  }
  const path = endpoint?.match(/^\/?repos\/([\w.-]+\/[\w.-]+)\/pulls\/([1-9]\d*)(?:\/([^?]*))?(?:\?.*)?$/);
  if (!path && !endpoint?.match(/^\/?repos\/[^/]+\/[^/]+\/pulls\/[^/?]+/)) return;
  const suffix = path?.[3] ?? "";
  const operation = /(?:^|\/)comments(?:\/|$)/.test(suffix) ? "comment" : suffix.startsWith("reviews") || suffix.startsWith("requested_reviewers") ? "review" : "edit";
  return { operation, ...(path && /^[\w.-]+$/.test(host) ? { target: prUrl(`https://${host}/${path[1]}/pull/${path[2]}`) } : {}) };
}

export function pullRequestOwned(command: ShellCommand, owned: string[], facts: string[]) {
  const write = pullRequestWrite(command);
  return !command.githubEnvironment && !command.uncertain && Boolean(write?.target && !command.repository && owned.some(url => prUrl(url) === write.target) || facts.length && facts.includes(prCallKey(command)));
}

export const prCallKey = (command: ShellCommand) => JSON.stringify([command.cwd, command.sequence, command.repository, command.argv]);
export const prCommandDigest = (source: string) => createHash("sha256").update(source).digest("hex");

export function checkedPullRequestCommand(source: string, url: string, operation: PullRequestDraftOperation) {
  const list = parseScript(source);
  const chain = list[0]?.andOr;
  const simple = chain?.first.commands[0];
  if (list.length !== 1 || list[0].background || chain.rest.length || chain.first.commands.length !== 1 || !simple || simple.type !== "simple" ||
      simple.redirects.length || simple.words.some(word => word.subs.length) || !["gh", "dt"].includes(simple.words[0]?.text)) throw new Error("Supply one literal gh or dt pull request command with its full URL.");
  const [command] = shellCommands(source, "/");
  const write = pullRequestWrite(command);
  const close = operation === "close" && command.argv[1] === "pr" && command.argv[2] === "close" && command.argv.slice(3).length === 1;
  if (command.repository || command.githubEnvironment || (close ? prUrl(command.argv[3]) !== prUrl(url) : write?.operation !== operation || !write.target || write.target !== prUrl(url)) ||
      command.argv.some(arg => /^(?:--(?:body-file|input|hostname|add-reviewer|reviewer)(?:=|$)|-[Fr])/.test(arg)))
    throw new Error("The exact command must use the requested operation and full PR URL, with inline text and no repository override or reviewer request.");
  return prCommandDigest(source);
}
