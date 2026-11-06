// Landing a project on the integration strategy: push its integration branch to its base or open its pull request, repo
// by repo, and finish the project once every repo is landed.
import type { ProjectRow, Store, TicketRow } from "./db/store";
import { Unavailable } from "./forge-waits";
import { andList, clip, landBody, mergeSubject } from "./prompts";
import { LoomError } from "./projects";
import { gitNetwork, integrationBranchOf, isMultiRepo, repoSettings } from "./repos";
import type { Spec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { specOf, type EngineCtx } from "./ctx";
import { errText, openForge, unavailable } from "./merge-common";
import { holdMerge } from "./merge-queue";
import { loomWorktree, provisioningRepos, unfinishedInLoomWorktree } from "./merge-integration";
import { afterOpen, afterPush } from "./pr-hooks";

/** On the pull request strategy, a running or paused project whose tickets are all done or cancelled is done. Integration projects finish in `land`. */
export function finishIfComplete(ctx: EngineCtx, project: ProjectRow): boolean {
  if (specOf(ctx.store, project).merge.strategy !== "pr") return false;
  return completeProject(ctx, project.id);
}

// A multi-repo integration project also needs every repo with merged work landed since its newest merge.
function completeProject(ctx: EngineCtx, projectId: number): boolean {
  const { store } = ctx;
  const project = store.project(projectId);
  if (project === null || (project.state !== "running" && project.state !== "paused")) return false;
  const tickets = store.tickets(projectId);
  if (tickets.length === 0 || !tickets.every((ticket) => ticket.state === "done" || ticket.state === "cancelled")) return false;
  if (unlandedRepos(store, projectId, specOf(store, project)).length > 0) return false;
  // Queued with the move, so no restart can finish a project without a record.
  store.tx(() => {
    store.setProjectState(projectId, "done", LOOM_ACTOR);
    store.queueRecord(projectId);
  });
  store.changed(project.id);
  return true;
}

/** One repo a multi-repo land landed: its pull request, or with `direct` the remote base branch it pushed to. */
export type RepoLanded = { repo: string; url: string; sha: string } | { repo: string; url: null; pushed: string; sha: string };

/**
 * The human's step on the integration strategy: push the integration branch and open one pull request to the base
 * branch, or push the new commits to the one already open. It holds the merge guard throughout, so no merge can move
 * the branch between reading its sha and pushing exactly that sha. With `direct`, it pushes to the base branch instead
 * and opens no pull request. A multi-repo project lands each repo with a done ticket, or only `repo`, and its result
 * has one entry per repo landed and names the repos whose merged work is still to land.
 */
export type LandResult = { url: string; done: boolean } | { url: null; pushed: string; sha: string; done: boolean } | { repos: RepoLanded[]; unlanded: string[]; done: boolean };

type LandArgs = { actor: string; title?: string; ready: boolean; direct?: boolean; repo?: string };

export async function land(ctx: EngineCtx, slug: string, a: LandArgs): Promise<LandResult> {
  const { store } = ctx;
  const seen = store.projectBySlug(slug);
  if (seen === null) throw new LoomError("loom_not_found", `No Loom project named "${slug}".`, "Run `bb loom list` to see the projects.");
  const spec = specOf(store, seen);
  if (spec.merge.strategy !== "integration") throw new LoomError("loom_invalid_state", "Cannot land: this project opens a pull request per ticket, so there is nothing to land.", "Its pull requests are opened and followed automatically.");
  if (seen.state !== "running" && seen.state !== "paused" && seen.state !== "done") throw new LoomError("loom_invalid_state", `Project ${slug} is ${seen.state}; only a running, paused or finished project can be landed.`);
  const multi = isMultiRepo(spec);
  if (a.repo !== undefined) {
    if (!multi) throw new LoomError("loom_invalid_input", `Cannot land one repo: ${slug} has no [[repo]] tables, so it lands as one repository.`, `Run \`bb loom land ${slug}\` without --repo.`);
    const names = spec.repo!.map((repo) => repo.name);
    if (!names.includes(a.repo)) throw new LoomError("loom_invalid_input", `Project ${slug} has no repo "${a.repo}"; its repos are ${names.join(", ")}.`);
  }

  const release = holdMerge(ctx, seen.id);
  if (release === null) throw new LoomError("loom_invalid_state", "Cannot land: a merge is running; try again in a moment.");
  try {
    const tickets = store.tickets(seen.id);
    if (tickets.some((ticket) => ticket.state === "merging")) throw new LoomError("loom_invalid_state", "Cannot land: a ticket is merging; try again when the merge finishes.");
    const done = tickets.filter((ticket) => ticket.state === "done");
    const project = store.project(seen.id)!;
    // Every ticket cancelled leaves no repo with work to land, so the land only finishes the project.
    if (multi && a.repo === undefined && tickets.length > 0 && tickets.every((ticket) => ticket.state === "cancelled")) {
      completeProject(ctx, project.id);
      store.changed(project.id);
      return { repos: [], unlanded: [], done: store.project(project.id)!.state === "done" };
    }
    if (done.length === 0) throw new LoomError("loom_invalid_state", "Cannot land: no ticket is done yet, so the integration branch has nothing to land.");

    if (multi) return await landRepos(ctx, project, spec, done, a);
    if (a.direct === true) {
      const pushed = `${spec.merge.remote}/${spec.project.base}`;
      const sha = await guarded(() => pushToBase(ctx, project, spec, null));
      store.event(project.id, null, "project.landed", a.actor, { direct: true, pushed, sha });
      completeProject(ctx, project.id);
      store.changed(project.id);
      return { url: null, pushed, sha, done: store.project(project.id)!.state === "done" };
    }
    const { sha, url } = await guarded(() => pushIntegration(ctx, project, spec, null, project.pr_url, a, landBody({ project, spec, done })));
    if (url === null) {
      const pushed = `${spec.merge.remote}/${integrationBranchOf(spec)!}`;
      store.event(project.id, null, "project.landed", a.actor, { pushed, sha });
      completeProject(ctx, project.id);
      store.changed(project.id);
      return { url: null, pushed, sha, done: store.project(project.id)!.state === "done" };
    }
    if (project.pr_url === null) store.updateProject(project.id, { pr_url: url });
    store.event(project.id, null, "project.landed", a.actor, { url, sha, created: project.pr_url === null });
    completeProject(ctx, project.id);
    store.changed(project.id);
    return { url, done: store.project(project.id)!.state === "done" };
  } finally {
    release();
  }
}

// Each repo with a done ticket, in the spec's order, or only the one asked for. The first repo that fails stops the land, and the repos before it stay landed.
async function landRepos(ctx: EngineCtx, project: ProjectRow, spec: Spec, done: TicketRow[], a: LandArgs): Promise<LandResult> {
  const { store } = ctx;
  const withWork = new Set(done.map((ticket) => ticket.repo));
  if (a.repo !== undefined && !withWork.has(a.repo)) throw new LoomError("loom_invalid_state", `Cannot land the repo "${a.repo}": none of its tickets is done yet, so its integration branch has nothing to land.`);
  const names = a.repo !== undefined ? [a.repo] : spec.repo!.map((repo) => repo.name).filter((name) => withWork.has(name));
  const landed: RepoLanded[] = [];
  for (const [index, name] of names.entries()) {
    try {
      landed.push(await landRepo(ctx, project, spec, name, done, a));
    } catch (error) {
      throw stoppedLand(project.slug, a, landed, names.slice(index), error instanceof LoomError ? error : unavailable(errText(error)));
    }
  }
  completeProject(ctx, project.id);
  store.changed(project.id);
  return { repos: landed, unlanded: unlandedRepos(store, project.id, spec), done: store.project(project.id)!.state === "done" };
}

async function landRepo(ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string, done: TicketRow[], a: LandArgs): Promise<RepoLanded> {
  const { store } = ctx;
  if (a.direct === true) {
    const { remote, base } = repoSettings(spec, name);
    const pushed = `${remote}/${base}`;
    const sha = await guarded(() => pushToBase(ctx, project, spec, name));
    store.updateProjectRepo(project.id, name, { landed_sha: sha, landed_at: ctx.now() }, a.actor, { direct: true, pushed, sha });
    return { repo: name, url: null, pushed, sha };
  }
  const open = store.projectRepo(project.id, name)?.pr_url ?? null;
  const { sha, url } = await guarded(() => pushIntegration(ctx, project, spec, name, open, a, landBody({ project, spec, done, repo: name })));
  if (url === null) {
    const settings = repoSettings(spec, name);
    const pushed = `${settings.remote}/${settings.branch!}`;
    store.updateProjectRepo(project.id, name, { landed_sha: sha, landed_at: ctx.now() }, a.actor, { pushed, sha });
    return { repo: name, url: null, pushed, sha };
  }
  store.updateProjectRepo(project.id, name, { pr_url: url, landed_sha: sha, landed_at: ctx.now() }, a.actor, { url, sha, created: open === null });
  return { repo: name, url, sha };
}

// The error of a multi-repo land that stopped at a repo, naming the repos it landed and the ones it did not.
function stoppedLand(slug: string, a: LandArgs, landed: RepoLanded[], rest: string[], error: LoomError): LoomError {
  const failed = rest[0]!;
  const where = (entry: RepoLanded) => `${entry.repo} (${entry.url === null ? `${entry.pushed} at ${entry.sha.slice(0, 12)}` : entry.url})`;
  const summary = landed.length === 0 && rest.length === 1 ? "" : `${landed.length === 0 ? "No repo landed" : `Landed ${andList(landed.map(where))}`}; ${andList(rest)} did not land. `;
  const again = `bb loom land ${slug}${a.direct === true ? " --direct" : ""}`;
  const hint = rest.length === 1 ? `Fix that, then run \`${again} --repo ${failed}\`.` : `Fix that, then run \`${again}\` again to land every repo with merged work.`;
  return new LoomError(error.code, `${summary}The repo "${failed}" ${summary === "" ? "did not land" : "failed"}: ${error.message}`, error.hint ?? hint);
}

/** The repos of a multi-repo integration project with a done ticket newer than their last land, in the spec's order; empty on any other project. */
export function unlandedRepos(store: Store, projectId: number, spec: Spec): string[] {
  if (spec.merge.strategy !== "integration" || !isMultiRepo(spec)) return [];
  const landedAt = new Map(store.projectRepos(projectId).map((row) => [row.name, row.landed_at]));
  const mergedAt = new Map<string, number>();
  for (const ticket of store.tickets(projectId, ["done"])) {
    if (ticket.repo !== null) mergedAt.set(ticket.repo, Math.max(mergedAt.get(ticket.repo) ?? 0, ticket.state_at));
  }
  // A land in the same millisecond as the merge before it counts as after it: the merge guard keeps the two apart, and a merge that follows a land takes several host calls.
  return spec.repo!.map((repo) => repo.name).filter((name) => mergedAt.has(name) && (landedAt.get(name) ?? -1) < mergedAt.get(name)!);
}

const landWorktree = (ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string | null) =>
  loomWorktree(ctx, project, spec, name).catch((error: unknown) => {
    throw error instanceof Unavailable ? unavailable(error.message) : error;
  });

/** Pushes a repo's integration branch as its Loom worktree has it, and opens its pull request when `open` holds none yet. Returns the pushed sha and the pull request's url, null on the push-only forge. */
async function pushIntegration(ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string | null, open: string | null, a: LandArgs, body: string): Promise<{ sha: string; url: string | null }> {
  const { hostId, repo, worktree, settings } = await landWorktree(ctx, project, spec, name);
  const { remote, base } = settings;
  const head = (await ctx.host.call(hostId, "worktreeState", { worktree, base })).head;
  const pushed = await ctx.host.call(hostId, "push", { repo, remote, src: head, branch: settings.branch!, ...gitNetwork(settings) });
  if (pushed.outcome === "unavailable") throw unavailable(pushed.message);
  if (settings.forge.kind === "none") return { sha: head, url: null };
  if (open !== null) {
    await afterPush(ctx, { hostId, repo, settings, head: settings.branch!, base, sha: head, url: open, projectId: project.id, ticketId: null, pushed: true, moved: false });
    return { sha: head, url: open };
  }
  const created = await ctx.host.call(hostId, "prCreate", { repo, remote, base, head: settings.branch!, title: clip(a.title ?? project.name, 256), body, draft: spec.merge.draft && !a.ready, forge: openForge(settings.forge) });
  if (created.outcome === "unavailable") throw unavailable(created.message);
  await afterOpen(ctx, { hostId, repo, settings, head: settings.branch!, base, url: created.url, projectId: project.id, ticketId: null });
  return { sha: head, url: created.url };
}

/**
 * The direct land of one repo (null for the project's own): fetch its base branch into its Loom worktree, merge it in
 * when it moved, run its after_merge on exactly what will be pushed, and push that to its base branch without force. A
 * failed check resets the merge. Returns the pushed sha. Its errors leave the repo for a multi-repo land's error to name.
 */
async function pushToBase(ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string | null): Promise<string> {
  const { hostId, repo, worktree, settings } = await landWorktree(ctx, project, spec, name);
  const { remote, base } = settings;
  const branch = settings.branch!;
  const target = `${remote}/${base}`;
  if ((await provisioningRepos(ctx, project.id)).has(name)) throw new LoomError("loom_invalid_state", `Cannot land yet: a worker's worktree is still being created from ${branch}; try again in a moment.`);

  const fetched = await ctx.host.call(hostId, "fetchBranch", { worktree, remote, branch: base, ...gitNetwork(settings) });
  if (fetched.outcome === "unavailable") throw unavailable(fetched.message);
  const merged = await ctx.host.call(hostId, "merge", { worktree, ref: fetched.sha, message: mergeSubject([target], branch) });
  if (merged.outcome === "unfinished") throw new LoomError("loom_invalid_state", `Cannot land on ${target}: ${unfinishedInLoomWorktree(worktree)}`);
  if (merged.outcome === "conflict") {
    const asPr = `bb loom land ${project.slug}${name === null ? "" : ` --repo ${name}`}`;
    throw new LoomError("loom_invalid_state", `Cannot land on ${target}: it conflicts with ${branch} in ${merged.files.join(", ")}.`, `Land it as a pull request with \`${asPr}\` and resolve the conflict there.`);
  }

  for (const command of settings.afterMerge) {
    const result = await ctx.host.call(hostId, "exec", { cwd: worktree, command, timeoutMs: spec.checks.timeout_minutes * 60_000 });
    let how: string | null = result.timedOut ? "timed out" : result.exitCode !== 0 ? `failed (exit ${result.exitCode})` : null;
    if (how === null) {
      const after = await ctx.host.call(hostId, "worktreeState", { worktree, base, trackedOnly: true });
      if (after.head !== merged.sha || after.dirty) how = "changed the branch (moved HEAD or left tracked files modified)";
    }
    if (how === null) continue;
    await ctx.host.call(hostId, "resetHard", { worktree, sha: merged.before });
    const output = result.output.trim() === "" ? "" : `\n\n${clip(result.output.slice(-2000), 2000)}`;
    throw new LoomError("loom_invalid_state", `Cannot land on ${target}: ${command} ${how}. Nothing was pushed, and ${branch} is back at ${merged.before.slice(0, 12)}.${output}`);
  }

  const pushed = await ctx.host.call(hostId, "push", { repo, remote, src: merged.sha, branch: base, ...gitNetwork(settings) });
  if (pushed.outcome === "unavailable") throw unavailable(pushed.message);
  return merged.sha;
}

// A host call that throws (a disconnected machine) reaches the human as an unavailable error with its message.
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LoomError) throw error;
    throw unavailable(errText(error));
  }
}
