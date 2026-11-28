import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { execGitSync, gitEnvironmentSync } from "../shared/git-safety";
import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, resolve } from "node:path";
import { normalizeRemote, pushSpec } from "./remote";
import { draftEditKey, draftEditSelector } from "./github";
import { prCallKey, prUrl, pullRequestWrite, reviewNodeQuery, reviewNodeUrl } from "./pr-policy";
import { isSink, normalizeToolPath, realPath } from "./paths";
import { containmentRead, readonlyProgram, temporaryRoot, type ScopeCall } from "./engine";
import type { Scope } from "./schema";
import { commandWritePaths, shellCommands } from "./shell";
import { memoryCommandCandidates, memoryCommandRule, memoryExecutableKey } from "./memory-policy";
import { exactMerge, inspectMerge } from "./merge";
import type { ActTarget } from "../shared/quest-authority";

export interface PrepareDeps { scope?: Scope; mergeTarget?: ActTarget; readCommand?(program: string, args: string[], cwd?: string): string }
const commandReader = (root: string) => ((program: string, args: string[], cwd = root) => {
    const options: ExecFileSyncOptionsWithStringEncoding & { cwd: string; timeout: number } = { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] };
    if (program === "git") {
      const read = { ...options, readOnly: true };
      return args[0] === "-C" ? execGitSync(args[1]!, args.slice(2), read) : execGitSync(cwd, args, read);
    }
    const env = program === "gh" || program === "dt" ? gitEnvironmentSync(cwd, { childGit: true }) : undefined;
    return execFileSync(program, args, { ...options, env });
  });
export function prepareCall({ questOwnedPrs: _untrustedPrs, ...call }: ScopeCall, deps: PrepareDeps = {}): ScopeCall {
  const cwd = realPath(call.cwd);
  const read = deps.readCommand ?? commandReader(cwd);
  const resolvedPaths: Record<string, string> = {};
  const pushTargets: Record<string, string[]> = {};
  const pushHeads: Record<string, string> = {};
  const gitRoots: Record<string, string> = {};
  const directories: string[] = [];
  const ownedDraftPrs: string[] = [];
  const ownedPrs: string[] = [];
  const questOwnedPrs: Record<string, string> = {};
  const add = (path: string, base: string) => {
    if (!/[\$`]/.test(path)) {
      const full = normalizeToolPath(path, base);
      resolvedPaths[full] = isSink(full) ? full : realPath(path, base);
    }
  };
  for (const path of [call.input.path, call.input.file_path]) if (typeof path === "string") add(path, cwd);
  const command = call.input.command ?? call.input.cmd;
  const checkMerge = call.merge === undefined && deps.scope?.role === "keeper" && typeof command === "string";
  const merge = checkMerge ? inspectMerge(command, cwd, read) : undefined;
  const match = merge && deps.mergeTarget && exactMerge(merge, deps.mergeTarget, read);
  const mergeFacts = checkMerge ? { merge: merge ?? null, mergeMatches: match === true, ...(match === "head-changed" ? { mergeHeadChanged: true } : {}) } : {};
  if (typeof command === "string") {
    if (command.includes("$(git rev-parse --show-toplevel)")) {
      try { gitRoots[cwd] = read("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).trim(); }
      catch { /* An unresolved substitution never establishes a write location. */ }
    }
    let commands;
    try {
      const facts = { temporaryRoot: deps.scope ? temporaryRoot(deps.scope) : undefined, isRead: call.containment === "sandbox" ? containmentRead : readonlyProgram, gitRoots, directories, env: deps.scope?.env.variables, containment: call.containment };
      commands = shellCommands(command, cwd, facts);
      for (const path of new Set(commands.map(cmd => cmd.cwd))) {
        try { if (statSync(path).isDirectory()) directories.push(path); }
        catch { /* A directory that cannot be checked remains a possible failure path. */ }
      }
      commands = shellCommands(command, cwd, facts);
    } catch { return { ...call, ...mergeFacts, cwd, resolvedPaths }; }
    const memoryPaths = deps.scope && memoryCommandRule(deps.scope)?.argv?.[0];
    const memoryNames = new Set(Array.isArray(memoryPaths) ? memoryPaths.map(path => basename(path)) : []);
    let branchStable = true;
    const prPolicy = deps.scope?.pullRequestPolicy;
    const ownedUrls = prPolicy ? [...prPolicy.owned, ...prPolicy.legacyOwned ?? []] : [];
    const redirectedGithub = commands.some(cmd => cmd.githubEnvironment);
    for (const cmd of commands) {
      const stableHead = branchStable && !cmd.uncertain;
      const git = cmd.argv[0] === "git";
      let preservesBranch = readonlyProgram(cmd) && commandWritePaths(cmd).length === 0 || git && (["add", "commit", "fetch", "tag"].includes(cmd.argv[1]) || cmd.argv[1] === "stash" && cmd.argv[2] === "push");
      add(cmd.cwd, cwd);
      if (memoryNames.size) for (const path of memoryCommandCandidates(cmd)) {
        if (/[\\/]/.test(path)) {
          try { add(path, cmd.cwd); }
          catch { /* A path that cannot be resolved can still match the literal rule. */ }
        } else if (memoryNames.has(path)) {
          const searchPath = deps.scope?.env.variables.PATH ?? process.env.PATH;
          for (const dir of searchPath?.split(delimiter) ?? []) {
            const candidate = resolve(cmd.cwd, dir, path);
            try {
              if (!statSync(candidate).isFile()) continue;
              accessSync(candidate, constants.X_OK);
              resolvedPaths[memoryExecutableKey(cmd.cwd, path)] = realPath(candidate);
              break;
            } catch { /* Not an executable on this PATH element. */ }
          }
        }
      }
      const push = pushSpec(cmd.argv);
      if (push) {
        try {
          if (!/[:/]/.test(push.remote)) pushTargets[cmd.cwd + "\0" + push.remote] = read("git", ["-C", cmd.cwd, "remote", "get-url", "--push", "--all", push.remote]).trim().split("\n");
        } catch { /* An unresolved push remote never satisfies a remote-scoped grant. */ }
        if (push.refs.includes("HEAD") && stableHead) {
          try { pushHeads[cmd.cwd + "\0" + cmd.sequence] = read("git", ["-C", cmd.cwd, "symbolic-ref", "--quiet", "--short", "HEAD"]).trim(); }
          catch { /* A detached or unresolved HEAD is not an explicit branch destination. */ }
        }
      }
      const write = pullRequestWrite(cmd, deps.scope?.role === "keeper");
      if (stableHead && !redirectedGithub && !cmd.xargs && !cmd.cwdAlternative && ownedUrls.length && write && !write.typedReady && !write.fileSourced) {
        try {
          const target = write.node && !cmd.repository
            ? reviewNodeUrl(read("gh", reviewNodeQuery(write.node), cmd.cwd), write.node.kind)
            : cmd.argv[1] === "pr" && (!write.target || cmd.repository) && draftEditSelector(cmd.argv) !== null
              ? prUrl(JSON.parse(read(cmd.argv[0], ["pr", "view", ...(write.selector ? [write.selector] : []),
                  ...(cmd.repository ? ["--repo", cmd.repository] : []), "--json", "url"], cmd.cwd)).url)
              : undefined;
          if (target && ownedUrls.some(url => prUrl(url) === target)) {
            questOwnedPrs[prCallKey(cmd)] = target;
            preservesBranch = true;
          }
        } catch { /* An unresolved forge target is not proof of ownership. */ }
      }
      if (["gh", "dt"].includes(cmd.argv[0]) && cmd.argv[1] === "pr" && ["create", "edit", "comment"].includes(cmd.argv[2]) && stableHead && !redirectedGithub && (!deps.scope || deps.scope.github === "draft-pr-only" && deps.scope.preset !== "open")) {
        try {
          const branch = read("git", ["-C", cmd.cwd, "symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
          pushHeads[cmd.cwd + "\0" + cmd.sequence] = branch;
          if (deps.scope?.assignedBranch && branch === deps.scope.assignedBranch && cmd.argv[2] !== "create") {
            const selector = draftEditSelector(cmd.argv);
            if (selector === null) throw new Error("Ambiguous pull request selector");
            const identifier = selector ?? branch;
            const repository = cmd.repository ? ["--repo", cmd.repository] : [];
            const pr = JSON.parse(read(cmd.argv[0], ["pr", "view", identifier, ...repository, "--json", "isDraft,author,headRefName,headRepository,headRepositoryOwner"], cmd.cwd));
            const viewer = JSON.parse(read("gh", ["api", "user"], cmd.cwd));
            const remotes = read("git", ["-C", cmd.cwd, "remote", "get-url", "--push", "--all", "origin"]).trim().split("\n");
            const head = "github.com/" + pr.headRepositoryOwner?.login + "/" + pr.headRepository?.name;
            if (pr.headRefName === deps.scope.assignedBranch && typeof viewer.login === "string" && pr.author?.login === viewer.login && typeof pr.headRepositoryOwner?.login === "string" && typeof pr.headRepository?.name === "string" && remotes.length > 0 && remotes.every(url => normalizeRemote(url) === head)) {
              ownedPrs.push(draftEditKey(cmd));
              if (pr.isDraft === true) ownedDraftPrs.push(draftEditKey(cmd));
              preservesBranch = true;
            }
          }
        } catch { /* Missing ownership, draft or branch facts require a decision, not an inferred grant. */ }
      }
      branchStable &&= preservesBranch;
    }
  }
  return { ...call, ...mergeFacts, cwd, resolvedPaths, pushTargets, pushHeads, gitRoots, directories, ownedDraftPrs, ownedPrs, ...(Object.keys(questOwnedPrs).length ? { questOwnedPrs } : {}) };
}
