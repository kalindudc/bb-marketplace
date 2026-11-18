import { forgeProfileSchema, type ForgeProfile } from "../shared/placement-settings";
import { gitRefSchema, type HostInput, type HostOutput } from "../host-contract";
import { hostContext, assertRepository } from "./context";
import type { HostRegistry } from "./registry";
import { runProcess } from "./process";
import { forgeFailure, type ForgeResult } from "../shared/forge-command";

export async function draftPush(registry: HostRegistry, input: HostInput<"draftPush">, signal: AbortSignal): Promise<HostOutput<"draftPush">> {
  return registry.operation(input, signal, async combined => {
    const ctx = hostContext(registry, input, ["home-import"], combined);
    await assertRepository(ctx);
    const grant = ctx.endpoint.registration.draft;
    if (!grant) throw new Error("This endpoint has no draft pull request grant.");
    const tree = await ctx.git(["rev-parse", `${input.sha}^{tree}`]);
    if (tree !== input.tree) throw new Error("Broken contract: the home commit tree differs from the member head tree.");
    const remoteHead = await ctx.run(["ls-remote", "--symref", "--", grant.remote, "HEAD"], { timeoutMs: 120_000 });
    if (remoteHead.code !== 0) throw new Error(`Tavern could not read the push remote's default branch: ${remoteHead.stderr.slice(-4000)}`);
    const defaultBranch = remoteHead.stdout.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)?.[1];
    if (!defaultBranch) throw new Error("Tavern could not establish the push remote's default branch; no branch was pushed.");
    const result = await ctx.run(pushArguments(grant.branch, grant.base, input.sha, grant.remote, input.previous, [grant.sourceBase, defaultBranch]), { timeoutMs: 120_000 });
    return { pushed: result.code === 0, ...result, stdout: result.stdout.slice(-16000), stderr: result.stderr.slice(-16000), timedOut: false };
  });
}
export async function draftOpen(registry: HostRegistry, input: HostInput<"draftOpen">, signal: AbortSignal): Promise<HostOutput<"draftOpen">> {
  return registry.operation(input, signal, async combined => {
    const ctx = hostContext(registry, input, ["home-import"], combined);
    await assertRepository(ctx);
    const grant = ctx.endpoint.registration.draft;
    if (!grant) throw new Error("This endpoint has no draft pull request grant.");
    return openDraft(ctx.root, forgeProfileSchema.parse(input.profile), { remote: grant.remote, base: grant.base, head: grant.branch, title: input.title, body: input.body }, combined);
  });
}

export interface DraftInput { remote: string; base: string; head: string; title: string; body: string }
const githubOpen = 'existing=$(gh pr list --repo "$FORGE_REMOTE" --head "$FORGE_HEAD" --state open --json url --jq \'.[0].url // empty\') || exit $?; if [ -n "$existing" ]; then printf "%s\\n" "$existing"; else gh pr create --repo "$FORGE_REMOTE" --base "$FORGE_BASE" --head "$FORGE_HEAD" --title "$FORGE_TITLE" --body-file - --draft; fi';
export async function openDraft(root: string, profile: ForgeProfile, input: DraftInput, signal?: AbortSignal): Promise<ForgeResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries({ REMOTE: input.remote, BASE: input.base, HEAD: input.head, TITLE: input.title, DRAFT: "1" })) {
    env[`FORGE_${key}`] = value; env[`LOOM_${key}`] = value;
  }
  const run = (command: string, body: string) => runProcess("/bin/sh", ["-c", command], { cwd: root, env, input: body, timeoutMs: 120_000, maxBuffer: 1024 * 1024, signal });
  const opened = await run(profile.kind === "github" ? githubOpen : profile.open, input.body);
  if (opened.code !== 0 || opened.timedOut) return forgeFailure(opened);
  const url = opened.stdout.match(/https?:\/\/[^\s<>"']+/g)?.at(-1)?.replace(/[.,;:!?)\]}]+$/, "");
  if (!url) return forgeFailure(opened, true);
  if (profile.kind === "command" && profile.state) {
    env.FORGE_URL = env.LOOM_URL = url;
    env.FORGE_PR_NUMBER = env.LOOM_PR_NUMBER = url.match(/\d+/g)?.at(-1) ?? "";
    const result = await run(profile.state, "");
    if (result.code !== 0 || result.timedOut) return forgeFailure(result);
    const state = result.stdout.trim().split("\n").at(-1)?.split(/\s+/)[0];
    if (state !== "open" && state !== "merged" && state !== "closed") return forgeFailure(result, true);
    return { ok: true, url, state };
  }
  return { ok: true, url };
}
export function pushArguments(branch: string, base: string, sha: string, remote: string, previous: string | null, protectedBranches: string[] = []): string[] {
  gitRefSchema.parse("refs/heads/" + branch);
  if ([base, ...protectedBranches].some(value => branch === value || `refs/heads/${branch}` === value)) throw new Error("Tavern never pushes to the base branch.");
  return ["push", ...(previous ? [`--force-with-lease=refs/heads/${branch}:${previous}`] : []), "--", remote, `${sha}:refs/heads/${branch}`];
}
