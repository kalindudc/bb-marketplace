// The integration strategy's merge: each approved ticket merges into the project's integration branch in Loom's own
// worktree, and the after_merge checks run on the merged result.
import type { CheckRun } from "./checks";
import type { ProjectRow, ThreadRow, TicketRow } from "./db/store";
import { Unavailable } from "./forge-waits";
import { afterMergeChangedText, afterMergeFailedText, branchName, clip, conflictText, mergeSubject } from "./prompts";
import type { RepoSettings } from "./repos";
import type { Spec } from "./spec";
import { resolveEnvironment } from "./workers";
import { type EngineCtx } from "./ctx";
import { branchIn, checkoutIn, complete, endFinishedThreads, inRepo, sendBack, type MergePost } from "./merge-common";

const PROVISION_MS = 10 * 60_000;
// bb creates a worker's worktree after `spawn` returns, branched from its repo's integration branch tip at that moment, so a merge into that repo waits for it.
export async function provisioningRepos(ctx: EngineCtx, projectId: number): Promise<Set<string | null>> {
  const repos = new Set<string | null>();
  for (const row of ctx.store.threads({ projectId, role: "worker", states: ["spawning", "active"] })) {
    const repo = row.ticket_id === null ? null : (ctx.store.ticket(row.ticket_id)?.repo ?? null);
    if (!repos.has(repo) && (await worktreeCreating(ctx, row))) repos.add(repo);
  }
  return repos;
}

async function worktreeCreating(ctx: EngineCtx, row: ThreadRow): Promise<boolean> {
  if (row.state === "spawning") return true;
  const environment = await resolveEnvironment(ctx, row);
  if (ctx.store.thread(row.id)!.environment_id === null) return true;
  return environment?.status === "creating" || environment?.status === "provisioning";
}

/** The plugin's worktree of a repo's integration branch: keyed by the slug for the project's own repository, by `<slug>.<name>` for a named repo. */
export async function loomWorktree(ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string | null = null): Promise<{ hostId: string; repo: string; worktree: string; settings: RepoSettings }> {
  const { hostId, path: repo, settings } = await checkoutIn(ctx, project, spec, name);
  const key = name === null ? project.slug : `${project.slug}.${name}`;
  const path = settings.worktree === null ? undefined : await provisionedPath(ctx, hostId, repo, project, settings);
  const ready = await ctx.host.call(hostId, "ensureWorktree", { repo, key, branch: settings.branch!, ...(path === undefined ? {} : { path }) });
  if (ready.outcome === "ok") return { hostId, repo, worktree: ready.path, settings };
  throw new Unavailable(ready.reason === "branch_checked_out" ? `${branchIn(settings)} is checked out elsewhere; switch that checkout off it and resume` : ready.message);
}

/** Runs the spec's worktree command, or a plugin's CLI command, before each merge and land, and returns the absolute path it printed last. */
async function provisionedPath(ctx: EngineCtx, hostId: string, repo: string, project: ProjectRow, settings: RepoSettings): Promise<string> {
  const worktree = settings.worktree!;
  // The spec checks a plugin id against ^[a-z0-9][a-z0-9-]*$, so it needs no quoting.
  const command = worktree.plugin === undefined ? worktree.command : `bb plugin run ${worktree.plugin} ${worktree.command}`;
  const env = { LOOM_PROJECT_SLUG: project.slug, LOOM_BRANCH: settings.branch!, LOOM_BASE: settings.base };
  const result = await ctx.host.call(hostId, "exec", { cwd: repo, command, timeoutMs: PROVISION_MS, env });
  const output = result.output.trim();
  if (result.timedOut || result.exitCode !== 0) {
    const how = result.timedOut ? `took longer than ${PROVISION_MS / 60_000} minutes` : `failed (exit ${result.exitCode})`;
    throw new Unavailable(`The integration worktree command \`${command}\` ${how}: ${clip(output.slice(-1500), 1500)}`);
  }
  const last = output.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1) ?? "";
  if (!last.startsWith("/")) throw new Unavailable(`The integration worktree command \`${command}\` must print the worktree's absolute path on its last line, but printed: ${clip(output.slice(-500), 500)}`);
  return last;
}

// Loom's own worktree has its half-done merges aborted when Loom prepares it, so only something outside Loom leaves one there.
export const unfinishedInLoomWorktree = (worktree: string) => `The Loom worktree ${worktree} has a merge that is not finished; resume, and Loom aborts it before it merges again.`;

export async function mergeIntoIntegration(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<void> {
  const { hostId, worktree, settings } = await loomWorktree(ctx, project, spec, ticket.repo);
  const branch = settings.branch!;
  const target = branchIn(settings);
  const before = await rollbackPoint(ctx, hostId, worktree, settings, ticket);
  const merged = await ctx.host.call(hostId, "merge", { worktree, ref: ticket.head_sha!, message: `${mergeSubject([branchName(ticket)], branch)}\n\n${clip(ticket.title, 200)}`, before });
  if (merged.outcome === "unfinished") throw new Unavailable(unfinishedInLoomWorktree(worktree));

  if (merged.outcome === "conflict") {
    await sendBack(ctx, ticket.id, {
      post: { kind: "merge", body: `Merging into ${target} conflicted in: ${merged.files.join(", ")}.`, data: { outcome: "conflict", files: merged.files } },
      text: inRepo(conflictText(ticket.key, branch, merged.files), settings),
      countFailure: false,
      reason: "the merge conflicted",
    });
    return;
  }

  for (const command of settings.afterMerge) {
    const result = await ctx.host.call(hostId, "exec", { cwd: worktree, command, timeoutMs: spec.checks.timeout_minutes * 60_000 });
    const run: CheckRun = { command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, output: result.output };
    const failure = result.exitCode === 0 && !result.timedOut ? await changedBranch(ctx, hostId, worktree, settings, merged.sha, run, ticket.key) : { post: afterMergePost(run, target), text: inRepo(afterMergeFailedText(ticket.key, run), settings) };
    if (failure === null) continue;
    await ctx.host.call(hostId, "resetHard", { worktree, sha: merged.before });
    await sendBack(ctx, ticket.id, { ...failure, countFailure: true, reason: "the after_merge checks failed" });
    return;
  }

  complete(ctx, ticket.id, { kind: "merge", body: `Merged ${merged.sha.slice(0, 12)} into ${target}${merged.already ? " (already merged)" : ""}.`, data: { outcome: "merged", sha: merged.sha, before: merged.before, already: merged.already, branch } });
  await endFinishedThreads(ctx, project.id);
}

// The point to roll the merge back to, persisted before the merge so that a rerun after a crash has it: the history cannot tell whose merge is at HEAD.
async function rollbackPoint(ctx: EngineCtx, hostId: string, worktree: string, settings: RepoSettings, ticket: TicketRow): Promise<string> {
  if (ticket.merge_before !== null) return ticket.merge_before;
  const { head } = await ctx.host.call(hostId, "worktreeState", { worktree, base: settings.base });
  ctx.store.updateTicket(ticket.id, { merge_before: head });
  return head;
}

// A check that passed must still have left the integration branch at the merge that was reviewed, with no tracked file edited.
async function changedBranch(ctx: EngineCtx, hostId: string, worktree: string, settings: RepoSettings, merged: string, run: CheckRun, key: string): Promise<{ post: MergePost; text: { summary: string; detail: string } } | null> {
  const after = await ctx.host.call(hostId, "worktreeState", { worktree, base: settings.base, trackedOnly: true });
  const changes = [...(after.head === merged ? [] : [`moved HEAD from ${merged.slice(0, 12)} to ${after.head.slice(0, 12)}`]), ...(after.dirty ? ["left tracked files modified"] : [])];
  if (changes.length === 0) return null;
  const changed = changes.join(" and ");
  return { post: afterMergePost(run, branchIn(settings), changed), text: inRepo(afterMergeChangedText(key, run, changed), settings) };
}

export function afterMergePost(run: CheckRun, branch: string, changed?: string): { kind: "check"; body: string; data: object } {
  const how = run.timedOut ? "timed out" : `exit ${run.exitCode}`;
  const verdict = changed === undefined ? `FAIL ${run.command} (${how}, ${(run.durationMs / 1000).toFixed(1)}s)` : `FAIL ${run.command} (${how}, ${(run.durationMs / 1000).toFixed(1)}s) but it changed the branch: ${changed}`;
  return {
    kind: "check",
    body: [`Checks after merging into ${branch} failed.`, verdict, "", clip(run.output.slice(-4000), 4000)].join("\n"),
    data: { passed: false, afterMerge: true, ...(changed === undefined ? {} : { changed }), runs: [{ command: run.command, exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs }], outside: [], protectedHits: [] },
  };
}
