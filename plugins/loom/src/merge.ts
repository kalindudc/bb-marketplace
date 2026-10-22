// The merge queue: approved tickets merge one at a time per project, either into the integration branch (with the
// after_merge checks run on the merged result) or as one pull request each. Every host step is idempotent, so a ticket
// left in `merging` by a pause or a restart simply runs again. Merges run in the background, like checks.
import { delivers, workerOf, type CheckRun } from "./checks";
import { repoCheckout, type RepoCheckout } from "./checkouts";
import type { ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import { plural } from "./format";
import { afterMergeChangedText, afterMergeFailedText, andList, clip, conflictText, landBody, prBody } from "./prompts";
import { LoomError } from "./projects";
import { isMultiRepo, repoSettings, type RepoSettings } from "./repos";
import { recordingHost } from "./runs";
import type { Spec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { applyMove, endLiveRows, endThread, pauseProject, released, resolveEnvironment, specOf, toWorking, type EngineCtx } from "./workers";

const POLL_MS = 5 * 60_000;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------- the per-project guard

const guards = new WeakMap<Store, Set<number>>();

/** Takes the project's merge guard, or returns null when a merge, a land or a human block or cancel holds it. Call the returned function to release it. */
export function holdMerge(ctx: { store: Store }, projectId: number): (() => void) | null {
  const held = guards.get(ctx.store) ?? guards.set(ctx.store, new Set()).get(ctx.store)!;
  if (held.has(projectId)) return null;
  held.add(projectId);
  return () => void held.delete(projectId);
}

/** Whether a merge, a land or a human block or cancel holds the project's merge guard now. */
export function mergeHeld(ctx: { store: Store }, projectId: number): boolean {
  return guards.get(ctx.store)?.has(projectId) === true;
}

const runs = new WeakMap<Store, Set<Promise<void>>>();
const runsOf = (store: Store) => runs.get(store) ?? runs.set(store, new Set()).get(store)!;

function track(store: Store, promise: Promise<void>): Promise<void> {
  const tracked = runsOf(store);
  tracked.add(promise);
  void promise.then(
    () => tracked.delete(promise),
    () => tracked.delete(promise),
  );
  return promise;
}

/** Waits for every merge in flight, including the ones those start. For tests. */
export async function settleMerges(ctx: EngineCtx): Promise<void> {
  const tracked = runsOf(ctx.store);
  while (tracked.size > 0) await Promise.all([...tracked]);
}

// ---------------------------------------------------------------- the queue

/**
 * Starts the project's next merge in the background, or resumes the ticket left in merging. One ticket per project: a
 * merge in flight makes this a no-op. It returns once the ticket is in `merging`, so a spawn that follows in the same
 * pass sees it and waits.
 */
export function runMergeQueue(ctx: EngineCtx, project: ProjectRow, spec: Spec): Promise<void> {
  return track(ctx.store, launch(ctx, project.id, spec));
}

async function launch(ctx: EngineCtx, projectId: number, spec: Spec): Promise<void> {
  await endFinishedThreads(ctx, projectId);
  const release = holdMerge(ctx, projectId);
  if (release === null) return;
  let ticket: TicketRow | null;
  try {
    ticket = await begin(ctx, projectId, spec);
  } catch (error) {
    release();
    throw error;
  }
  if (ticket === null) {
    release();
    return;
  }
  const merging = ticket;
  track(
    ctx.store,
    (async () => {
      try {
        await mergeTicket(ctx, ctx.store.project(projectId)!, spec, merging);
      } catch (error) {
        ctx.bb.log("error", `Merging ${merging.key} failed: ${errText(error)}`);
      } finally {
        release();
        ctx.kick();
      }
    })(),
  );
}

// The ticket to merge: the one left in merging, else the oldest approved one whose repo has no worker worktree being created, moved to merging.
async function begin(ctx: EngineCtx, projectId: number, spec: Spec): Promise<TicketRow | null> {
  const { store } = ctx;
  if (store.project(projectId)?.state !== "running") return null;
  const left = store.tickets(projectId, ["merging"])[0];
  if (left !== undefined) return left;
  if (store.tickets(projectId, ["approved"]).length === 0) return null;
  const waiting = spec.merge.strategy === "integration" ? await provisioningRepos(ctx, projectId) : new Set<string | null>();
  const next = store
    .tickets(projectId, ["approved"])
    .filter((ticket) => !waiting.has(ticket.repo))
    .sort((a, b) => a.state_at - b.state_at || a.seq - b.seq)[0];
  if (next === undefined || store.project(projectId)?.state !== "running") return null;
  store.tx(() => {
    store.setTicketState(next.id, "merging", LOOM_ACTOR, { head: next.head_sha });
    store.updateTicket(next.id, { merge_before: null });
  });
  return store.ticket(next.id)!;
}

// bb creates a worker's worktree after `spawn` returns, branched from its repo's integration branch tip at that moment, so a merge into that repo waits for it.
async function provisioningRepos(ctx: EngineCtx, projectId: number): Promise<Set<string | null>> {
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

/** Ends the worker and reviewer threads of a ticket that is done, or blocked because its pull request closed. Replays what a crash after the ticket's move left undone. */
async function endFinishedThreads(ctx: EngineCtx, projectId: number): Promise<void> {
  for (const row of ctx.store.threads({ projectId, states: ["active"] })) {
    if (row.role === "planner" || row.ticket_id === null) continue;
    const state = ctx.store.ticket(row.ticket_id)?.state;
    if (state === "done") await endThread(ctx, row, "merged", { commit: false, move: null });
    else if (state === "blocked") await endThread(ctx, row, "blocked", { commit: false, move: null });
  }
}

// ---------------------------------------------------------------- one merge

class Unavailable extends Error {}

/** Merges one ticket in `merging`. Safe to run again: a host step that already happened reports itself as done. */
export async function mergeTicket(ctx: EngineCtx, project: ProjectRow, spec: Spec, seen: TicketRow): Promise<void> {
  const ticket = ctx.store.ticket(seen.id);
  if (ticket?.state !== "merging") return;
  try {
    const recorded: EngineCtx = { ...ctx, host: recordingHost(ctx.store, ctx.host, ticket, "merge") };
    if (spec.merge.strategy === "integration") await mergeIntoIntegration(recorded, project, spec, ticket);
    else await openPullRequest(recorded, project, spec, ticket);
  } catch (error) {
    // A host that cannot do its job pauses the project with the reason, instead of retrying every tick. The ticket stays in merging.
    pauseProject(ctx, project.id, error instanceof Unavailable ? error.message : `Merging ${ticket.key} stopped: ${errText(error)}`);
  }
}

// A repo without a checkout pauses the project with repoCheckout's message, which gives the clone command.
async function checkoutIn(ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string | null): Promise<RepoCheckout> {
  try {
    return await repoCheckout(ctx, project, spec, name);
  } catch (error) {
    throw error instanceof LoomError ? new Unavailable(error.message) : error;
  }
}

// The integration branch as the human reads it: on a multi-repo project, with the repo it is in.
const branchIn = (settings: RepoSettings) => (settings.name === null ? settings.branch! : `${settings.branch!} in the repo "${settings.name}"`);

/** The plugin's worktree of a repo's integration branch: keyed by the slug for the project's own repository, by `<slug>.<name>` for a named repo. */
async function loomWorktree(ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string | null = null): Promise<{ hostId: string; repo: string; worktree: string; settings: RepoSettings }> {
  const { hostId, path: repo, settings } = await checkoutIn(ctx, project, spec, name);
  const key = name === null ? project.slug : `${project.slug}.${name}`;
  const ready = await ctx.host.call(hostId, "ensureWorktree", { repo, key, branch: settings.branch! });
  if (ready.outcome === "ok") return { hostId, repo, worktree: ready.path, settings };
  throw new Unavailable(ready.reason === "branch_checked_out" ? `${branchIn(settings)} is checked out elsewhere; switch that checkout off it and resume` : ready.message);
}

// A message to the worker about its merge, which names the repo on a multi-repo project.
function inRepo(text: { summary: string; detail: string }, settings: RepoSettings): { summary: string; detail: string } {
  return settings.name === null ? text : { ...text, detail: `${text.detail}\n\nThis was the integration branch of the repo "${settings.name}", which your worktree is a checkout of.` };
}

async function mergeIntoIntegration(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<void> {
  const { hostId, worktree, settings } = await loomWorktree(ctx, project, spec, ticket.repo);
  const branch = settings.branch!;
  const target = branchIn(settings);
  const before = await rollbackPoint(ctx, hostId, worktree, settings, ticket);
  const merged = await ctx.host.call(hostId, "merge", { worktree, ref: ticket.head_sha!, message: `${ticket.key}: ${clip(ticket.title, 200)} (Loom)`, before });

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

function afterMergePost(run: CheckRun, branch: string, changed?: string): { kind: "check"; body: string; data: object } {
  const how = run.timedOut ? "timed out" : `exit ${run.exitCode}`;
  const verdict = changed === undefined ? `FAIL ${run.command} (${how}, ${(run.durationMs / 1000).toFixed(1)}s)` : `FAIL ${run.command} (${how}, ${(run.durationMs / 1000).toFixed(1)}s) but it changed the branch: ${changed}`;
  return {
    kind: "check",
    body: [`Checks after merging into ${branch} failed.`, verdict, "", clip(run.output.slice(-4000), 4000)].join("\n"),
    data: { passed: false, afterMerge: true, ...(changed === undefined ? {} : { changed }), runs: [{ command: run.command, exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs }], outside: [], protectedHits: [] },
  };
}

type MergePost = { kind: "merge" | "check"; body: string; data: object };

/** merging to done, with the merge post, in one transaction. */
function complete(ctx: EngineCtx, ticketId: number, post: MergePost): void {
  const { store } = ctx;
  store.tx(() => {
    const ticket = store.ticket(ticketId)!;
    store.setTicketState(ticketId, "done", LOOM_ACTOR, { ...post.data });
    store.updateTicket(ticketId, released);
    store.addPost({ project_id: ticket.project_id, ticket_id: ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: post.kind, body: post.body, data_json: JSON.stringify(post.data) });
  });
  store.changed(store.ticket(ticketId)!.project_id);
  ctx.kick();
}

/**
 * A merge that did not land goes back to the ticket's worker (or the queue when the worker is gone), in one transaction, so
 * the ticket leaves `merging` before the merge guard is released. A worker that is ending counts as gone: the only ways
 * it can be ending here leave the ticket alone, because block and cancel are refused while a ticket merges.
 */
async function sendBack(ctx: EngineCtx, ticketId: number, a: { post: MergePost; text: { summary: string; detail: string }; countFailure: boolean; reason: string }): Promise<void> {
  const { store } = ctx;
  let worker: ReturnType<typeof workerOf> | null = null;
  let failures = 0;
  const applied = store.tx(() => {
    const ticket = store.ticket(ticketId);
    if (ticket === null || ticket.state !== "merging") return false;
    store.addPost({ project_id: ticket.project_id, ticket_id: ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: a.post.kind, body: a.post.body, data_json: JSON.stringify(a.post.data) });
    if (a.countFailure) {
      failures = ticket.check_failures + 1;
      store.updateTicket(ticketId, { check_failures: failures });
    }
    worker = workerOf(store, ticket);
    if (worker.standing === "active") toWorking(ctx, store.ticket(ticketId)!, worker.row, { reason: a.reason });
    else applyMove(ctx, store.ticket(ticketId)!, { to: "queued", patch: released }, LOOM_ACTOR, { reason: "the worker is gone" });
    return true;
  });
  if (!applied) return;
  store.changed(store.ticket(ticketId)!.project_id);

  const ticket = store.ticket(ticketId)!;
  const { max_check_failures: limit } = specOf(store, store.project(ticket.project_id)!).budget;
  if (a.countFailure && failures >= limit) {
    const reason = `checks failed ${plural(failures, "time")}`;
    store.tx(() => {
      store.updateTicket(ticketId, { blocked_reason: reason });
      store.addPost({ project_id: ticket.project_id, ticket_id: ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
    });
    await endLiveRows(ctx, store.ticket(ticketId)!, "blocked");
    return;
  }
  const target = worker as ReturnType<typeof workerOf> | null;
  if (target?.standing === "active" && target.row.thread_id !== null && delivers(ctx, ticket.project_id)) {
    await ctx.bb.send(target.row.thread_id, a.text).catch((error) => ctx.bb.log("warn", `Could not message ${target.row.thread_id}: ${errText(error)}`));
  }
}

async function openPullRequest(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<void> {
  const { store } = ctx;
  const { hostId, path: repo, settings } = await checkoutIn(ctx, project, spec, ticket.repo);
  if (ticket.branch === null) throw new Unavailable(`${ticket.key} has no branch recorded, so a pull request cannot be opened. Requeue it.`);
  const { remote, base } = settings;
  const pushed = await ctx.host.call(hostId, "push", { repo, remote, src: ticket.head_sha!, branch: ticket.branch });
  if (pushed.outcome === "unavailable") throw new Unavailable(pushed.message);
  const approvals = store.reviews(ticket.id, ticket.review_round).filter((review) => review.verdict === "approved");
  const created = await ctx.host.call(hostId, "prCreate", {
    repo,
    remote,
    base,
    head: ticket.branch,
    title: clip(`${ticket.key}: ${ticket.title}`, 256),
    body: prBody({ ticket, approvals }),
    draft: spec.merge.draft,
  });
  if (created.outcome === "unavailable") throw new Unavailable(created.message);
  store.tx(() => {
    store.setTicketState(ticket.id, "pr_open", LOOM_ACTOR, { url: created.url });
    store.updateTicket(ticket.id, { pr_url: created.url, pr_checked_at: ctx.now() });
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "merge", body: `Opened pull request ${created.url}`, data_json: JSON.stringify({ outcome: "pr_opened", url: created.url }) });
  });
  store.changed(project.id);
}

// ---------------------------------------------------------------- pull requests

/** Reads the state of every open pull request not read in the last 5 minutes: merged completes the ticket, closed blocks it. */
export async function pollPullRequests(ctx: EngineCtx, project: ProjectRow): Promise<void> {
  const { store } = ctx;
  const due = store.tickets(project.id, ["pr_open"]).filter((ticket) => ticket.pr_url !== null && (ticket.pr_checked_at === null || ctx.now() - ticket.pr_checked_at >= POLL_MS));
  if (due.length === 0) return;
  const spec = specOf(store, project);
  // Each repo's checkout is read once per poll; a repo without one pauses the project and leaves its pull requests for the next poll.
  const checkouts = new Map<string | null, RepoCheckout | null>();
  const checkoutOfRepo = async (name: string | null): Promise<RepoCheckout | null> => {
    const cached = checkouts.get(name);
    if (cached !== undefined) return cached;
    const checkout = await repoCheckout(ctx, project, spec, name).catch((error: unknown) => {
      pauseProject(ctx, project.id, errText(error));
      return null;
    });
    checkouts.set(name, checkout);
    return checkout;
  };
  for (const seen of due) {
    const ticket = store.ticket(seen.id);
    if (ticket?.state !== "pr_open" || ticket.pr_url === null) continue;
    const checkout = await checkoutOfRepo(ticket.repo);
    if (checkout === null) continue;
    store.updateTicket(ticket.id, { pr_checked_at: ctx.now() });
    let state;
    try {
      state = await ctx.host.call(checkout.hostId, "prState", { repo: checkout.path, url: ticket.pr_url });
    } catch (error) {
      pauseProject(ctx, project.id, `Reading the pull request of ${ticket.key} stopped: ${errText(error)}`);
      continue;
    }
    if (state.outcome === "unavailable") {
      pauseProject(ctx, project.id, state.message);
      continue;
    }
    // The answer is about the pull request and attempt that were polled; the human may have blocked and requeued the ticket during the host call.
    const current = store.ticket(ticket.id);
    if (current?.state !== "pr_open" || current.pr_url !== ticket.pr_url || current.attempt !== ticket.attempt) continue;
    if (state.state === "MERGED") {
      complete(ctx, ticket.id, { kind: "merge", body: "The pull request was merged.", data: { outcome: "pr_merged", url: ticket.pr_url } });
    } else if (state.state === "CLOSED") {
      // The ticket moves to blocked in this same tick; ending its threads, which awaits, comes after.
      const reason = "the pull request was closed without merging";
      store.tx(() => {
        store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
        applyMove(ctx, current, { to: "blocked", patch: { ...released, blocked_reason: reason } }, LOOM_ACTOR, { reason });
      });
      store.changed(project.id);
      for (const row of store.threads({ ticketId: ticket.id, states: ["active"] })) await endThread(ctx, row, "blocked", { commit: false, move: null });
    }
  }
  await endFinishedThreads(ctx, project.id);
}

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
  store.setProjectState(projectId, "done", LOOM_ACTOR);
  store.changed(project.id);
  return true;
}

// ---------------------------------------------------------------- land

const unavailable = (message: string) => new LoomError("loom_unavailable", message);

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

/** Pushes a repo's integration branch as its Loom worktree has it, and opens its pull request when `open` holds none yet. Returns the pushed sha and the pull request's url. */
async function pushIntegration(ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string | null, open: string | null, a: LandArgs, body: string): Promise<{ sha: string; url: string }> {
  const { hostId, repo, worktree, settings } = await landWorktree(ctx, project, spec, name);
  const { remote, base } = settings;
  const head = (await ctx.host.call(hostId, "worktreeState", { worktree, base })).head;
  const pushed = await ctx.host.call(hostId, "push", { repo, remote, src: head, branch: settings.branch! });
  if (pushed.outcome === "unavailable") throw unavailable(pushed.message);
  if (open !== null) return { sha: head, url: open };
  const created = await ctx.host.call(hostId, "prCreate", { repo, remote, base, head: settings.branch!, title: clip(a.title ?? project.name, 256), body, draft: spec.merge.draft && !a.ready });
  if (created.outcome === "unavailable") throw unavailable(created.message);
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

  const fetched = await ctx.host.call(hostId, "fetchBranch", { worktree, remote, branch: base });
  if (fetched.outcome === "unavailable") throw unavailable(fetched.message);
  const merged = await ctx.host.call(hostId, "merge", { worktree, ref: fetched.sha, message: `Merge ${target} into ${branch} (Loom)` });
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

  const pushed = await ctx.host.call(hostId, "push", { repo, remote, src: merged.sha, branch: base });
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
