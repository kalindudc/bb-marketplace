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

const reviewMutationName = /\b(?:resolveReviewThread|unresolveReviewThread|convertPullRequestToDraft)\b/;
type ReviewNode = { id: string; kind: "PullRequestReviewThread" | "PullRequest" };
type PullRequestWrite = { operation: PullRequestDraftOperation; target?: string; selector?: string; node?: ReviewNode; keeperAction?: boolean; typedReady?: boolean; fileSourced?: boolean };

export function reviewNodeQuery({ id, kind }: ReviewNode) {
  const fields = kind === "PullRequestReviewThread" ? "pullRequest{url}" : "url";
  return ["api", "graphql", "-f", `query=query($id:ID!){node(id:$id){... on ${kind}{${fields}}}}`, "-f", "id=" + id];
}

export function reviewNodeUrl(result: string, kind: ReviewNode["kind"]) {
  const { data, errors } = JSON.parse(result);
  const url = kind === "PullRequestReviewThread" ? data?.node?.pullRequest?.url : data?.node?.url;
  return !errors?.length && typeof url === "string" ? prUrl(url) : undefined;
}

function graphqlReview(options: string[]): PullRequestWrite | undefined {
  if (options.some(arg => /\bmarkPullRequestReadyForReview\s*\(/.test(arg))) return { operation: "review", typedReady: true };
  if (!options.some(arg => reviewMutationName.test(arg))) return;
  const unproven: PullRequestWrite = { operation: "review" };
  const fields = new Map<string, string>();
  let endpoint = false, post = false;
  for (let i = 0; i < options.length; i++) {
    const arg = options[i]!;
    if (arg === "graphql" && !endpoint) { endpoint = true; continue; }
    if (!post && (arg === "-XPOST" || arg === "--method=POST" ||
        ["-X", "--method"].includes(arg) && options[i + 1] === "POST")) {
      post = true;
      if (["-X", "--method"].includes(arg)) i++;
      continue;
    }
    const field = ["-f", "-F", "--field", "--raw-field"].includes(arg) ? options[++i]
      : /^(?:-[fF].|--(?:raw-)?field=)/.test(arg) ? arg.replace(/^(?:-[fF]|--(?:raw-)?field=)/, "") : undefined;
    const pair = field?.match(/^(\w+)=([\s\S]+)$/);
    if (!pair || fields.has(pair[1]!)) return unproven;
    fields.set(pair[1]!, pair[2]!);
  }
  // An ownership proof applies to one known mutation, not an arbitrary GraphQL document.
  const query = fields.get("query")?.replace(/\s+/g, "") ?? "";
  const match = /^mutation(?:\w+)?(?:\(\$(\w+):ID!\))?\{(\w+)\(input:\{(threadId|pullRequestId):(?:"([\w-]+)"|\$(\w+))\}\)\{(?:clientMutationId|thread\{(?:id|isResolved)+\}|pullRequest\{(?:id|url|isDraft)+\})\}\}$/.exec(query);
  if (!endpoint || !match) return unproven;
  const [, variable, verb, key, literal, reference] = match;
  const kind = verb === "resolveReviewThread" || verb === "unresolveReviewThread" ? "PullRequestReviewThread" :
    verb === "convertPullRequestToDraft" ? "PullRequest" : undefined;
  const id = variable && variable === reference ? fields.get(variable) : !variable && literal;
  if (!kind || key !== (kind === "PullRequestReviewThread" ? "threadId" : "pullRequestId") ||
      !id || !/^[\w-]+$/.test(id) || fields.size !== (variable ? 2 : 1)) return unproven;
  return { operation: "review", keeperAction: true, node: { id, kind } };
}

export function pullRequestWrite(command: ShellCommand, keeper = false): PullRequestWrite | undefined {
  const [program, group, verb, ...args] = command.argv;
  if (["gh", "dt"].includes(program) && group === "pr" && ["review", "approve", "comment", "edit", "close"].includes(verb)) {
    const selector = draftEditSelector(command.argv);
    const operation = verb === "review" && args.some(arg => ["--approve", "-a"].includes(arg)) ? "approve" : verb as PullRequestDraftOperation;
    const fileSourced = args.some(arg => /^(?:--body-file(?:=|$)|-F)/.test(arg));
    const commentReview = operation === "review" && args.some(arg => ["--comment", "-c"].includes(arg)) &&
      !args.some(arg => ["--approve", "-a", "--request-changes", "-r"].includes(arg));
    return { operation, target: prUrl(selector ?? undefined), selector: selector ?? undefined,
      fileSourced, keeperAction: keeper && !fileSourced && selector !== null && (["comment", "edit", "close"].includes(operation) || commentReview) };
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
  if (keeper && endpoint === "graphql") return graphqlReview(options);
  const path = endpoint?.match(/^\/?repos\/([\w.-]+\/[\w.-]+)\/pulls\/([1-9]\d*)(?:\/([^?]*))?(?:\?.*)?$/) ??
    (keeper ? endpoint?.match(/^\/?repos\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/(comments)$/) : undefined);
  if (!path && !endpoint?.match(/^\/?repos\/[^/]+\/[^/]+\/pulls\/[^/?]+/)) return;
  const suffix = path?.[3] ?? "";
  const fileSourced = options.some((arg, index) => /^--input(?:=|$)/.test(arg) ||
    (arg === "-F" || arg === "--field") && /^[^=]+=@/.test(options[index + 1] ?? "") ||
    /^(?:-F=?|--field=)[^=]+=@/.test(arg));
  const closing = keeper && !suffix && options.some(arg => /^(?:(?:-[fF]|--(?:raw-)?field=))?state=closed$/.test(arg));
  const operation = closing ? "close" : /(?:^|\/)comments(?:\/|$)/.test(suffix) ? "comment" :
    suffix.startsWith("reviews") || suffix.startsWith("requested_reviewers") ? "review" : "edit";
  const reviewEvents = options.filter(arg => /^(?:(?:-[fF]|--(?:raw-)?field=))?event=/.test(arg));
  const commentReview = suffix === "reviews" && reviewEvents.length === 1 && reviewEvents[0]!.endsWith("event=COMMENT");
  const keeperAction = keeper && !!path && !fileSourced && (commentReview || /^(?:|comments(?:\/[1-9]\d*\/replies)?)$/.test(suffix));
  return { operation, keeperAction, fileSourced, typedReady: keeper && /^requested_reviewers\/?$/.test(suffix), ...(path && /^[\w.-]+$/.test(host) ? { target: prUrl(`https://${host}/${path[1]}/pull/${path[2]}`) } : {}) };
}

export function ownedPullRequestTarget(command: ShellCommand, write: PullRequestWrite | undefined, owned: string[], facts: Record<string, string>) {
  if (!write || command.githubEnvironment || command.uncertain || command.cwdAlternative || command.xargs) return;
  const target = facts[prCallKey(command)] ?? (!command.repository ? write.target : undefined);
  return target ? owned.find(url => prUrl(url) === target) : undefined;
}

export const prCallKey = (command: ShellCommand) => JSON.stringify([command.cwd, command.sequence, command.repository, command.originalArgv ?? command.argv]);
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
