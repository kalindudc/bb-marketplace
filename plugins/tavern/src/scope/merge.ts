import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActTarget } from "../shared/quest-authority";
import { githubApiRead } from "./github";
import { nestedCommands } from "./legacy";
import { realPath } from "./paths";
import { normalizeRemote, pushSpec } from "./remote";
import { shellCommands, type ShellCommand } from "./shell";

export type ReadMerge = (program: string, args: string[], cwd: string) => string;
export type MergeCall = { description: string; repository?: string; branch?: string; issue?: string; command?: ShellCommand; source?: string; tracking?: string; pr?: number; api?: boolean };
const traditional = ["main", "master"];
const head = "refs/heads/";
const branchName = (ref: string) => ref.startsWith(head) ? ref.slice(head.length) : ref.startsWith("refs/") ? undefined : ref;
const scalar = (value: string | undefined): value is string => !!value && !/[\s$`*?\[\]\u0000]/.test(value);
const remoteKey = (remote: string, cwd: string) => remote.startsWith("file://") ? realPath(fileURLToPath(remote)) :
  isAbsolute(remote) || remote.startsWith(".") ? realPath(remote, cwd) : normalizeRemote(remote);
const probe = (read: ReadMerge, program: string, args: string[], cwd: string) => {
  try { return read(program, args, cwd).trim() || undefined; }
  catch { return undefined; }
};
const config = (read: ReadMerge, cwd: string, key: string) => probe(read, "git", ["config", "--get", key], cwd);
const ref = (read: ReadMerge, cwd: string, name: string) => probe(read, "git", ["symbolic-ref", "--quiet", name], cwd);
const prApi = /(?:^|\/)repos\/([^/]+\/[^/]+)\/pulls\/([^/]+)\/merge\/?(?:\?.*)?$/;
const branchApi = /(?:^|\/)repos\/([^/]+\/[^/]+)\/(?:merges|merge-upstream)\/?(?:\?.*)?$/;
const writeApi = /(?:^|\/)repos\/([^/]+\/[^/]+)\/(git\/refs(?:\/heads\/([^?]+))?|contents(?:\/[^?]*)?)(?:\?.*)?$/;
const graphqlMerge = /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/;
const graphqlWrite = /\bcreateCommitOnBranch\b/;
const graphql = (arg: string) => /(?:^|\/)graphql(?:\?.*)?$/.test(arg);
const field = (args: string[], name: string) => args.map(arg => new RegExp(`(?:^|[=&])${name}=([\\w./-]+)$|["']?${name}["']?\\s*:\\s*["']([\\w./-]+)["']`).exec(arg)).find(Boolean)?.slice(1).find(Boolean);
const trackedHead = (read: ReadMerge, cwd: string, remote: string) => {
  const prefix = `refs/remotes/${remote}/`, value = ref(read, cwd, prefix + "HEAD");
  return value?.startsWith(prefix) ? value.slice(prefix.length) : undefined;
};

function directBranchWrite(command: ShellCommand, args: string[], read: ReadMerge | undefined): MergeCall | undefined {
  const write = args.map(arg => writeApi.exec(arg)).find(Boolean);
  if (!write && !(args.some(graphql) && args.some(arg => graphqlWrite.test(arg)))) return;
  const repository = write?.[1] ?? field(args, "repositoryNameWithOwner") ?? command.repository;
  const named = write ? write[3] ?? field(args, write[2]?.startsWith("contents") ? "branch" : "ref") : field(args, "branchName");
  const branch = named ? branchName(named) : undefined;
  const defaults = new Set(traditional);
  if (read && repository) {
    for (const remote of (probe(read, "git", ["remote"], command.cwd) ?? "").split("\n").filter(Boolean)) {
      const url = probe(read, "git", ["remote", "get-url", remote], command.cwd);
      if (!url || !(normalizeRemote(url) === repository || normalizeRemote(url).endsWith("/" + repository))) continue;
      const base = trackedHead(read, command.cwd, remote);
      if (base) defaults.add(base);
    }
  }
  if (named && (!branch || !defaults.has(branch))) return;
  return { description: "protected branch API write", repository, branch: branch ?? [...defaults].join(", "), issue: "this API route does not provide a verifiable exact merge" };
}

function networkMerge(command: ShellCommand, read: ReadMerge | undefined): MergeCall | undefined {
  const [tool, group, ...rest] = command.argv;
  const args = tool === "gh" ? rest : command.argv.slice(1);
  if (tool === "gh" ? group !== "api" || githubApiRead(command.argv) : !["curl", "wget"].includes(tool) || !args.some((arg, i) =>
      /^--(?:data|json|form|upload-file|post-|body-)/.test(arg) || /^-[dFT]/.test(arg) || /^(?:-X|--request=|--method=)(?:PUT|POST|PATCH|DELETE)$/.test(arg) ||
      ["-X", "--request", "--method"].includes(arg) && /^(?:PUT|POST|PATCH|DELETE)$/.test(args[i + 1] ?? ""))) return;
  if (tool !== "gh") {
    const endpoint = args.map(arg => prApi.exec(arg) ?? branchApi.exec(arg)).find(Boolean);
    if (endpoint || args.some(graphql) && args.some(arg => graphqlMerge.test(arg)))
      return { description: "pull request merge", repository: endpoint?.[1], issue: "this HTTP client cannot verify the exact merge" };
  }
  return directBranchWrite(command, args, read);
}
export const explicitMerge = (command: ShellCommand) => {
  const [tool, action, sub] = command.argv;
  if (command.argv.includes("--help") || command.argv.includes("--version")) return false;
  if (["gh", "dt"].includes(tool) && action === "pr" && sub === "merge") return true;
  return tool === "gh" && action === "api" && !githubApiRead(command.argv) && (command.argv.slice(2).some(arg => prApi.test(arg) || branchApi.test(arg)) ||
    command.argv.some(graphql) && command.argv.some(arg => graphqlMerge.test(arg)));
};
export const protectedApiWrite = (command: ShellCommand) =>
  command.argv[0] === "gh" && command.argv[1] === "api" && explicitMerge(command) || !!networkMerge(command, undefined);
const simple = (command: ShellCommand) => !command.uncertain && !command.cwdAlternative && !command.gitEnvironment && !command.githubEnvironment;

function inspectPush(command: ShellCommand, read: ReadMerge): MergeCall | undefined {
  const { argv, cwd } = command;
  const description = "protected-branch push";
  const spec = pushSpec(argv), current = () => ref(read, cwd, "HEAD")?.slice(head.length);
  const defaultRemote = (branch: string | undefined) => (branch && config(read, cwd, `branch.${branch}.pushRemote`)) || config(read, cwd, "remote.pushDefault") || (branch && config(read, cwd, `branch.${branch}.remote`)) || "origin";
  const remote = spec?.remote ?? defaultRemote(current());
  const urls = (probe(read, "git", ["remote", "get-url", "--push", "--all", remote], cwd) ?? (/[/:]/.test(remote) ? remote : "")).split("\n").filter(Boolean);
  const repository = urls.length === 1 ? remoteKey(urls[0]!, cwd) : remote;
  const bases = new Set(traditional);
  const tracksPushRemote = urls.length === 1 && urls[0] === probe(read, "git", ["remote", "get-url", remote], cwd);
  const defaultBranch = tracksPushRemote ? trackedHead(read, cwd, remote) : undefined;
  if (defaultBranch) bases.add(defaultBranch);
  const issue = (reason: string, branch?: string): MergeCall => ({ description, repository, branch, issue: reason });
  const args = argv.slice(2), flags = args.slice(0, args.includes("--") ? args.indexOf("--") : undefined);
  if (!simple(command) || !scalar(remote) || command.originalArgv?.some(arg => /^(?:-c|--git-dir|--work-tree|--namespace)(?:=|$)/.test(arg))) return issue("the Git destination cannot be verified");
  if (flags.some(arg => /^(?:--receive-pack|--exec)(?:=|$)/.test(arg))) return issue("the push overrides the server command");
  if (flags.some(arg => /^--(?:all|branches|mirror|prune)(?:=|$)/.test(arg)) || config(read, cwd, `remote.${remote}.mirror`) === "true")
    return issue("the push can write multiple branches", [...bases].join(", "));
  const repospec = spec?.refs ?? [];
  let refs = repospec;
  if (!refs.length) {
    const configured = probe(read, "git", ["config", "--get-all", `remote.${remote}.push`], cwd);
    if (configured) refs = configured.split("\n");
    else {
      const mode = config(read, cwd, "push.default") ?? "simple", branch = current();
      if (mode === "matching") return issue("matching pushes can write multiple branches", [...bases].join(", "));
      if (flags.includes("--tags") || mode === "nothing" || !branch) return;
      const tracking = config(read, cwd, `branch.${branch}.merge`);
      const trackingRemote = config(read, cwd, `branch.${branch}.remote`);
      const setup = !tracking && probe(read, "git", ["config", "--type=bool", "--get", "push.autoSetupRemote"], cwd) === "true";
      const destination = !setup && (mode === "upstream" || mode === "simple" && (!trackingRemote || trackingRemote === remote)) ? tracking : head + branch;
      if (!destination) return;
      refs = [branch + ":" + destination];
    }
  }
  const deletion = flags.some(arg => arg === "--delete" || arg === "-d");
  const writes = refs.map(value => {
    const [source, destination = source] = value.replace(/^\+/, "").split(":");
    const name = destination === "HEAD" || destination === "@" ? current() : branchName(destination ?? "");
    return { source, name, destination };
  });
  if (writes.some(write => !scalar(write.destination) || ["HEAD", "@"].includes(write.destination ?? "") && !write.name)) return issue("a refspec does not identify a single branch", [...bases].join(", "));
  const changed = writes.find(write => write.name && bases.has(write.name));
  if (!changed) return;
  if (writes.length !== 1 || deletion || !changed.source || urls.length !== 1) return issue("the exact protected branch update could not be verified", changed.name);
  if (refs.some(arg => arg.startsWith("+")) || flags.some(arg => /^--(?:force|force-with-lease|force-if-includes)(?:=|$)/.test(arg) || arg === "-f"))
    return issue("forced updates are not ordinary merges", changed.name);
  if (flags.some(arg => /^--(?:recurse-submodules|signed|push-option)(?:=|$)/.test(arg) || /^-o/.test(arg)) ||
      ["on-demand", "only"].includes(config(read, cwd, "push.recurseSubmodules") ?? ""))
    return issue("additional push effects cannot be verified", changed.name);
  return { description, repository, branch: changed.name, command, source: changed.source, tracking: tracksPushRemote ? `refs/remotes/${remote}/` : undefined };
}

export function inspectMerge(source: string, cwd: string, read: ReadMerge | undefined, depth = 0): MergeCall | undefined {
  if (depth >= 16) return;
  let commands: ShellCommand[];
  try { commands = shellCommands(source, cwd); }
  catch {
    if (/\b(?:gh|dt)\b[^;\n]*\bpr\s+merge\b|\b(?:gh\s+api|curl|wget)\b[^;\n]*(?:\/merge|graphql|\/git\/refs|\/contents)|\bgit\b[^;\n]*\b(?:push|send-pack)\b/.test(source))
      return { description: "merge or protected-branch push", issue: "the shell syntax cannot be parsed" };
    return;
  }
  if (read && commands.length === 2) {
    const [lookup, push] = commands;
    const branchQueries = ["git branch --show-current", "git rev-parse --abbrev-ref HEAD"];
    const query = lookup!.argv.join(" ");
    const substitution = `$(${query})`;
    if (branchQueries.includes(query) && push!.argv[0] === "git" && push!.argv[1] === "push" && push!.argv.includes(substitution) && lookup!.cwd === push!.cwd) {
      const name = probe(read, "git", lookup!.argv.slice(1), lookup!.cwd);
      if (scalar(name) && name !== "HEAD") commands = [{ ...push!, argv: push!.argv.map(arg => arg === substitution ? name : arg) }];
    }
  }
  for (const command of commands) {
    const [tool, action] = command.argv;
    let merge: MergeCall | undefined;
    if (explicitMerge(command)) {
      const endpoint = command.argv.find(arg => prApi.test(arg) || branchApi.test(arg));
      const match = endpoint?.match(prApi), branchMerge = endpoint?.match(branchApi);
      const pr = match && /^\d+$/.test(match[2]!) ? Number(match[2]) : undefined;
      merge = { description: "pull request merge", repository: match?.[1] ?? branchMerge?.[1] ?? command.repository, pr, api: action === "api", command };
      if (tool !== "gh" || !simple(command) || action === "api" && !pr) merge.issue = "this forge command does not identify a verifiable exact pull request merge";
    } else if (tool === "git" && (action === "send-pack" || action === "subtree" && command.argv[2] === "push") ||
        command.xargs && tool === "git" && action === "push") {
      merge = { description: "protected-branch push", issue: "this push does not provide verifiable arguments and destination" };
    } else if (tool === "git" && action === "push" && !command.argv.some(arg => ["--help", "--version"].includes(arg))) {
      if (read) merge = inspectPush(command, read);
      else if (command.argv.some(arg => /(?:^|:)(?:refs\/heads\/)?(?:main|master)$|^--(?:all|mirror)$/.test(arg)) || !pushSpec(command.argv)?.refs.length)
        merge = { description: "protected-branch push", issue: "the push destination cannot be resolved" };
    } else merge = networkMerge(command, read);
    if (merge) return commands.length === 1 || merge.issue ? merge : { ...merge, issue: "a protected write must be a separate command so its target can be verified" };
    for (const nested of nestedCommands(command)) {
      const found = inspectMerge(nested, command.cwd, command.argv[0] === "ssh" ? undefined : read, depth + 1);
      if (found) return { ...found, issue: "a protected write cannot be verified inside a wrapper" };
    }
  }
}

export function exactMerge(call: MergeCall, target: ActTarget, read: ReadMerge): boolean | "head-changed" {
  const { command, repository, branch, source, tracking, pr, api } = call;
  const merge = target.merge, commit = target.commit;
  if (!command || command.writes.length || command.fedInput || call.issue || !merge || !commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return false;
  if (source) {
    if (!merge.sourceBranch || merge.pullRequest || repository !== merge.repository || branch !== merge.targetBranch || source !== commit) return false;
    const sourceRef = head + merge.sourceBranch;
    const current = probe(read, "git", ["rev-parse", "--verify", `${sourceRef}^{commit}`], command.cwd);
    const published = tracking && probe(read, "git", ["rev-parse", "--verify", `${tracking}${merge.sourceBranch}^{commit}`], command.cwd);
    return current !== commit || published && published !== commit ? "head-changed" : true;
  }
  if (!merge.pullRequest || merge.sourceBranch) return false;
  const flags = command.argv.slice(api ? 2 : 3);
  let selector: string | undefined;
  if (api) {
    const endpoint = flags.find(arg => prApi.test(arg));
    if (!pr || !repository || !endpoint?.startsWith("repos/") || !flags.includes("sha=" + commit) ||
        !flags.some((arg, i) => arg === "--method=PUT" || arg === "-XPUT" || ["-X", "--method"].includes(arg) && flags[i + 1] === "PUT") ||
        flags.some((arg, i) => ![endpoint, "--method=PUT", "-XPUT", "--method", "-X", "-f", "--raw-field"].includes(arg) && !(arg === "PUT" && ["--method", "-X"].includes(flags[i - 1]!)) && !(arg === "sha=" + commit && ["-f", "--raw-field"].includes(flags[i - 1]!)))) return false;
    selector = String(pr);
  } else {
    const selectors: string[] = [];
    let pinned = false;
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i]!;
      if (flag === `--match-head-commit=${commit}` || flag === "--match-head-commit" && flags[++i] === commit) pinned = true;
      else if (["--merge", "--squash", "--rebase", "-m", "-s", "-r"].includes(flag)) continue;
      else if (/^\d+$|^https:\/\/[^\s]+\/pull\/\d+$/.test(flag)) selectors.push(flag);
      else return false;
    }
    if (!pinned || selectors.length !== 1) return false;
    selector = selectors[0];
  }
  const raw = probe(read, "gh", ["pr", "view", selector!, ...(repository ? ["--repo", repository] : []), "--json", "url,baseRefName,headRefOid,state"], command.cwd);
  if (!raw) return false;
  try {
    const current = JSON.parse(raw);
    if (current.state !== "OPEN" || current.url !== merge.pullRequest || normalizeRemote(current.url.replace(/\/pull\/\d+$/, "")) !== merge.repository) return false;
    return current.headRefOid !== commit ? "head-changed" : current.baseRefName === merge.targetBranch;
  } catch { return false; }
}
