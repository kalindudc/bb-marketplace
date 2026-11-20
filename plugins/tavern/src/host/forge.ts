import { forgeProfileSchema, type ForgeProfile } from "../shared/placement-settings";
import { gitRefSchema, type HostInput, type HostOutput } from "../host-contract";
import { gitOidSchema } from "../shared/placement";
import { z } from "zod";
import { normalizeRemote } from "../scope/remote";
import { hostContext, assertRepository } from "./context";
import type { HostRegistry } from "./registry";
import { runProcess } from "./process";
import { gitEnvironment, type GitKind } from "../shared/git-safety";
import { forgeFailure, type ForgeResult } from "../shared/forge-command";
import { assertEffectiveRemote } from "./remote";

export async function draftPush(registry: HostRegistry, input: HostInput<"draftPush">, signal: AbortSignal): Promise<HostOutput<"draftPush">> {
  return registry.operation(input, signal, async combined => {
    const ctx = hostContext(registry, input, ["home-import"], combined);
    await assertRepository(ctx);
    const grant = ctx.endpoint.registration.draft;
    if (!grant) throw new Error("This endpoint has no draft pull request grant.");
    const tree = await ctx.git(["rev-parse", `${input.sha}^{tree}`]);
    if (tree !== input.tree) throw new Error("Broken contract: the home commit tree differs from the member head tree.");
    await assertEffectiveRemote(ctx, grant.remote, "fetch");
    const remoteHead = await ctx.run(["ls-remote", "--symref", "--", grant.remote, "HEAD"], { timeoutMs: 120_000, networkRemote: true });
    if (remoteHead.code !== 0) throw new Error(`Tavern could not read the push remote's default branch: ${remoteHead.stderr.slice(-4000)}`);
    const defaultBranch = remoteHead.stdout.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)?.[1];
    if (!defaultBranch) throw new Error("Tavern could not establish the push remote's default branch; no branch was pushed.");
    await assertEffectiveRemote(ctx, grant.remote, "push");
    const result = await ctx.run(pushArguments(grant.branch, grant.base, input.sha, grant.remote, input.previous, [grant.sourceBase, defaultBranch]), { timeoutMs: 120_000, networkRemote: true });
    return { pushed: result.code === 0, ...result, stdout: result.stdout.slice(-16000), stderr: result.stderr.slice(-16000), timedOut: false };
  });
}
export async function draftOpen(registry: HostRegistry, input: HostInput<"draftOpen">, signal: AbortSignal): Promise<HostOutput<"draftOpen">> {
  return registry.operation(input, signal, async combined => {
    const ctx = hostContext(registry, input, ["source-read", "home-import"], combined);
    await assertRepository(ctx);
    const grant = ctx.endpoint.registration.draft;
    if (!grant) throw new Error("This endpoint has no draft pull request grant.");
    return openDraft(ctx.root, forgeProfileSchema.parse(input.profile), { remote: grant.remote, base: grant.base, head: grant.branch, title: input.title, body: input.body }, combined, ctx.endpoint.registration.git);
  });
}

export interface DraftInput { remote: string; base: string; head: string; title: string; body: string }
const githubOpen = 'existing=$(gh pr list --repo "$FORGE_REMOTE" --head "$FORGE_HEAD" --state open --json url --jq \'.[0].url // empty\') || exit $?; if [ -n "$existing" ]; then printf "%s\\n" "$existing"; else gh pr create --repo "$FORGE_REMOTE" --base "$FORGE_BASE" --head "$FORGE_HEAD" --title "$FORGE_TITLE" --body-file - --draft; fi';
function draftEnvironment(input: Omit<DraftInput, "body">) {
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries({ REMOTE: input.remote, BASE: input.base, HEAD: input.head, TITLE: input.title, DRAFT: "1" })) {
    extra[`FORGE_${key}`] = value; extra[`LOOM_${key}`] = value;
  }
  return extra;
}
async function runDraftCommand(root: string, command: string, extra: Record<string, string>, input: string, signal?: AbortSignal, kind?: GitKind) {
  return runProcess("/bin/sh", ["-c", command], { cwd: root, env: await gitEnvironment(root, { kind, extra, signal, childGit: true }), input, timeoutMs: 120_000, maxBuffer: 1024 * 1024, signal });
}
function pullRequestEnvironment(input?: { url: string; number: string; head: string; base: string; headCommit: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GH_PROMPT_DISABLED: "1" };
  if (input) for (const [key, value] of Object.entries({ URL: input.url, PR_NUMBER: input.number, HEAD: input.head, BASE: input.base, HEAD_COMMIT: input.headCommit })) {
    env[`FORGE_${key}`] = value; env[`LOOM_${key}`] = value;
  }
  return env;
}
function runPullRequestCommand(root: string, executable: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) {
  return runProcess(executable, args, { cwd: root, env, input: "", timeoutMs: 120_000, maxBuffer: 1024 * 1024, signal });
}
export function probeForgeHelp(root: string, script: string | null, field: "open" | "state" | "close", signal: AbortSignal, kind?: GitKind) {
  const command = `${script ?? "gh"} --help`;
  if (field === "close") {
    const env = pullRequestEnvironment({ url: "", number: "", head: "", base: "", headCommit: "" });
    return runPullRequestCommand(root, "/bin/sh", ["-c", command], env, signal);
  }
  const extra = draftEnvironment({ remote: "", base: "", head: "", title: "" });
  if (field === "state") extra.FORGE_URL = extra.LOOM_URL = extra.FORGE_PR_NUMBER = extra.LOOM_PR_NUMBER = "";
  return runDraftCommand(root, command, extra, "", signal, kind);
}
export async function openDraft(root: string, profile: ForgeProfile, input: DraftInput, signal?: AbortSignal, kind?: GitKind): Promise<ForgeResult> {
  const extra = draftEnvironment(input);
  const run = (command: string, body: string) => runDraftCommand(root, command, extra, body, signal, kind);
  const opened = await run(profile.kind === "github" ? githubOpen : profile.open, input.body);
  if (opened.code !== 0 || opened.timedOut) return forgeFailure(opened);
  const url = opened.stdout.match(/https?:\/\/[^\s<>"']+/g)?.at(-1)?.replace(/[.,;:!?)\]}]+$/, "");
  if (!url) return forgeFailure(opened, true);
  if (profile.kind === "command" && profile.state) {
    extra.FORGE_URL = extra.LOOM_URL = url;
    extra.FORGE_PR_NUMBER = extra.LOOM_PR_NUMBER = url.match(/\d+/g)?.at(-1) ?? "";
    const result = await run(profile.state, "");
    if (result.code !== 0 || result.timedOut) return forgeFailure(result);
    const state = result.stdout.trim().split("\n").at(-1)?.split(/\s+/)[0];
    if (state !== "open" && state !== "merged" && state !== "closed") return forgeFailure(result, true);
    return { ok: true, url, state };
  }
  return { ok: true, url };
}
const githubStateSchema = z.object({ state: z.enum(["OPEN", "CLOSED", "MERGED"]), headRefOid: gitOidSchema, headRefName: z.string(), baseRefName: z.string(), isDraft: z.boolean() });

export async function forgePullRequest(registry: HostRegistry, input: HostInput<"forgePullRequest">, signal: AbortSignal): Promise<HostOutput<"forgePullRequest">> {
  return registry.operation(input, signal, async combined => {
    const ctx = hostContext(registry, input, ["source-read"], combined);
    await assertRepository(ctx);
    const { profile, action, url, head, base, headCommit } = input;
    const target = new URL(url);
    if (target.username || target.password || !["https:", "http:"].includes(target.protocol)) throw new Error("This pull request URL is not a supported forge target.");
    const env = pullRequestEnvironment(profile.kind === "command"
      ? { url, number: target.pathname.match(/\d+/g)?.at(-1) ?? "", head, base, headCommit } : undefined);
    const run = async (executable: string, args: string[]) => {
      ctx.active();
      const result = await runPullRequestCommand(ctx.root, executable, args, env, combined);
      if (result.code !== 0 || result.timedOut) throw new Error(forgeFailure(result).lines);
      return result.stdout.trim();
    };
    if (profile.kind === "github") {
      const path = target.pathname.match(/^\/([\w.-]+\/[\w.-]+)\/pull\/[1-9][0-9]*\/?$/);
      if (!path || target.protocol !== "https:" || target.search || target.hash) throw new Error("This is not a GitHub pull request URL.");
      const repo = normalizeRemote(`${target.origin}/${path[1]}`).toLowerCase();
      const remotes = (await ctx.git(["remote", "-v"])).split("\n").flatMap(line => line.match(/\t(\S+) \((?:fetch|push)\)$/)?.[1] ?? []);
      if (!remotes.some(remote => normalizeRemote(remote).toLowerCase() === repo)) throw new Error("This pull request does not belong to a remote in the quest's source checkout.");
      const view = async () => {
        const gh = githubStateSchema.parse(JSON.parse(await run("gh", ["pr", "view", url, "--json", "state,headRefOid,headRefName,baseRefName,isDraft"])));
        if (gh.headRefName !== head || gh.baseRefName !== base) throw new Error("This pull request's branches no longer match the quest record.");
        return { headCommit: gh.headRefOid, state: gh.state === "OPEN" ? gh.isDraft ? "draft" as const : "ready" as const : gh.state === "MERGED" ? "merged" as const : "closed" as const };
      };
      const before = await view();
      if (action === "inspect" || before.state === "closed" || before.state === "merged") return before;
      if (before.headCommit !== headCommit || before.state !== input.state) throw new Error("The head or review state changed after it was checked; confirm the current pull request before taking another action.");
      if (action === "close") {
        await run("gh", ["pr", "close", url]);
        const after = await view();
        if (after.state !== "closed" && after.state !== "merged") throw new Error("The forge did not confirm that the pull request closed.");
        return after;
      }
      if (action === "comment") {
        if (!input.comment) throw new Error("A pull request comment needs its text.");
        await run("gh", ["pr", "comment", url, `--body=${input.comment}`]);
        return view();
      }
      const confirm = async () => {
        const after = await view();
        if (after.headCommit !== headCommit || after.state !== action) throw new Error("The forge did not confirm the expected head and review state. Check it before retrying.");
        return after;
      };
      if (action !== before.state) await run("gh", ["pr", "ready", ...(action === "draft" ? ["--undo"] : []), url]);
      const after = await confirm();
      if (action !== "ready" || !input.reviewers?.length) return after;
      await run("gh", ["pr", "edit", url, "--add-reviewer", input.reviewers.join(",")]);
      return confirm();
    }
    if (action !== "inspect" && action !== "close") throw new Error("The recorded forge does not support this pull request action.");
    const state = async () => {
      if (!profile.state) return input.state;
      const word = (await run("/bin/sh", ["-c", profile.state])).split("\n").at(-1)?.split(/\s+/)[0];
      if (word === "open") return input.state;
      if (word === "closed" || word === "merged" || word === "draft" || word === "ready") return word;
      throw new Error("The forge state command did not report open, merged or closed.");
    };
    const before = await state();
    if (action === "inspect" || before === "closed" || before === "merged") return { state: before };
    if (!profile.close) throw new Error("This forge has no close command.");
    if (before !== input.state) throw new Error("The pull request's review state changed after the card was shown.");
    await run("/bin/sh", ["-c", profile.close]);
    const after = profile.state ? await state() : "closed";
    if (after !== "closed" && after !== "merged") throw new Error("The forge did not confirm that the pull request closed.");
    return { state: after };
  });
}

export function pushArguments(branch: string, base: string, sha: string, remote: string, previous: string | null, protectedBranches: string[] = []): string[] {
  gitRefSchema.parse("refs/heads/" + branch);
  if ([base, ...protectedBranches].some(value => branch === value || `refs/heads/${branch}` === value)) throw new Error("Tavern never pushes to the base branch.");
  return ["push", ...(previous ? [`--force-with-lease=refs/heads/${branch}:${previous}`] : []), "--", remote, `${sha}:refs/heads/${branch}`];
}
