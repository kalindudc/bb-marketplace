// The merge queue: approved tickets merge one at a time per project, either into the integration branch (with the
// after_merge checks run on the merged result) or as one pull request each. Every host step is idempotent, so a ticket
// left in `merging` by a pause or a restart simply runs again. Merges run in the background, like checks.
import { delivers, workerOf, type CheckRun } from "./checks";
import type { ProjectRow, Store, TicketRow } from "./db/store";
import { plural } from "./format";
import { afterMergeChangedText, afterMergeFailedText, clip, conflictText, landBody, prBody } from "./prompts";
import { LoomError } from "./projects";
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

// The ticket to merge: the one left in merging, else the oldest approved one, moved to merging.
async function begin(ctx: EngineCtx, projectId: number, spec: Spec): Promise<TicketRow | null> {
  const { store } = ctx;
  if (store.project(projectId)?.state !== "running") return null;
  const left = store.tickets(projectId, ["merging"])[0];
  if (left !== undefined) return left;
  if (store.tickets(projectId, ["approved"]).length === 0) return null;
  if (spec.merge.strategy === "integration" && (await provisioning(ctx, projectId))) return null;
  const next = [...store.tickets(projectId, ["approved"])].sort((a, b) => a.state_at - b.state_at || a.seq - b.seq)[0];
  if (next === undefined || store.project(projectId)?.state !== "running") return null;
  store.tx(() => {
    store.setTicketState(next.id, "merging", LOOM_ACTOR, { head: next.head_sha });
    store.updateTicket(next.id, { merge_before: null });
  });
  return store.ticket(next.id)!;
}

// bb creates a worker's worktree after `spawn` returns, branched from the integration branch's tip at that moment, so a merge waits for it.
async function provisioning(ctx: EngineCtx, projectId: number): Promise<boolean> {
  for (const row of ctx.store.threads({ projectId, role: "worker", states: ["spawning", "active"] })) {
    if (row.state === "spawning") return true;
    const environment = await resolveEnvironment(ctx, row);
    if (ctx.store.thread(row.id)!.environment_id === null) return true;
    if (environment?.status === "creating" || environment?.status === "provisioning") return true;
  }
  return false;
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

async function checkoutOf(ctx: EngineCtx, project: ProjectRow): Promise<{ hostId: string; repo: string }> {
  const repo = project.host_id === null ? null : await ctx.bb.projectCheckout(project.bb_project_id, project.host_id);
  if (project.host_id === null || repo === null) throw new Unavailable(`The bb project has no checkout on the machine ${project.host_id ?? "(unknown)"}; add the repository there and resume.`);
  return { hostId: project.host_id, repo };
}

async function loomWorktree(ctx: EngineCtx, project: ProjectRow, spec: Spec): Promise<{ hostId: string; repo: string; worktree: string }> {
  const { hostId, repo } = await checkoutOf(ctx, project);
  const branch = spec.merge.branch!;
  const ready = await ctx.host.call(hostId, "ensureWorktree", { repo, key: project.slug, branch });
  if (ready.outcome === "ok") return { hostId, repo, worktree: ready.path };
  throw new Unavailable(ready.reason === "branch_checked_out" ? `${branch} is checked out elsewhere; switch that checkout off it and resume` : ready.message);
}

async function mergeIntoIntegration(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<void> {
  const branch = spec.merge.branch!;
  const { hostId, worktree } = await loomWorktree(ctx, project, spec);
  const before = await rollbackPoint(ctx, hostId, worktree, spec, ticket);
  const merged = await ctx.host.call(hostId, "merge", { worktree, ref: ticket.head_sha!, message: `${ticket.key}: ${clip(ticket.title, 200)} (Loom)`, before });

  if (merged.outcome === "conflict") {
    const text = conflictText(ticket.key, branch, merged.files);
    await sendBack(ctx, ticket.id, {
      post: { kind: "merge", body: `Merging into ${branch} conflicted in: ${merged.files.join(", ")}.`, data: { outcome: "conflict", files: merged.files } },
      text,
      countFailure: false,
      reason: "the merge conflicted",
    });
    return;
  }

  for (const command of spec.checks.after_merge) {
    const result = await ctx.host.call(hostId, "exec", { cwd: worktree, command, timeoutMs: spec.checks.timeout_minutes * 60_000 });
    const run: CheckRun = { command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, output: result.output };
    const failure = result.exitCode === 0 && !result.timedOut ? await changedBranch(ctx, hostId, worktree, spec, merged.sha, run, ticket.key) : { post: afterMergePost(run, branch), text: afterMergeFailedText(ticket.key, run) };
    if (failure === null) continue;
    await ctx.host.call(hostId, "resetHard", { worktree, sha: merged.before });
    await sendBack(ctx, ticket.id, { ...failure, countFailure: true, reason: "the after_merge checks failed" });
    return;
  }

  complete(ctx, ticket.id, { kind: "merge", body: `Merged ${merged.sha.slice(0, 12)} into ${branch}${merged.already ? " (already merged)" : ""}.`, data: { outcome: "merged", sha: merged.sha, before: merged.before, already: merged.already, branch } });
  await endFinishedThreads(ctx, project.id);
}

// The point to roll the merge back to, persisted before the merge so that a rerun after a crash has it: the history cannot tell whose merge is at HEAD.
async function rollbackPoint(ctx: EngineCtx, hostId: string, worktree: string, spec: Spec, ticket: TicketRow): Promise<string> {
  if (ticket.merge_before !== null) return ticket.merge_before;
  const { head } = await ctx.host.call(hostId, "worktreeState", { worktree, base: spec.project.base });
  ctx.store.updateTicket(ticket.id, { merge_before: head });
  return head;
}

// A check that passed must still have left the integration branch at the merge that was reviewed, with no tracked file edited.
async function changedBranch(ctx: EngineCtx, hostId: string, worktree: string, spec: Spec, merged: string, run: CheckRun, key: string): Promise<{ post: MergePost; text: { summary: string; detail: string } } | null> {
  const after = await ctx.host.call(hostId, "worktreeState", { worktree, base: spec.project.base, trackedOnly: true });
  const changes = [...(after.head === merged ? [] : [`moved HEAD from ${merged.slice(0, 12)} to ${after.head.slice(0, 12)}`]), ...(after.dirty ? ["left tracked files modified"] : [])];
  if (changes.length === 0) return null;
  const changed = changes.join(" and ");
  return { post: afterMergePost(run, spec.merge.branch!, changed), text: afterMergeChangedText(key, run, changed) };
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
  const { hostId, repo } = await checkoutOf(ctx, project);
  if (ticket.branch === null) throw new Unavailable(`${ticket.key} has no branch recorded, so a pull request cannot be opened. Requeue it.`);
  const { remote } = spec.merge;
  const pushed = await ctx.host.call(hostId, "push", { repo, remote, src: ticket.head_sha!, branch: ticket.branch });
  if (pushed.outcome === "unavailable") throw new Unavailable(pushed.message);
  const approvals = store.reviews(ticket.id, ticket.review_round).filter((review) => review.verdict === "approved");
  const created = await ctx.host.call(hostId, "prCreate", {
    repo,
    remote,
    base: spec.project.base,
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
  let checkout: { hostId: string; repo: string };
  try {
    checkout = await checkoutOf(ctx, project);
  } catch (error) {
    pauseProject(ctx, project.id, errText(error));
    return;
  }
  for (const seen of due) {
    const ticket = store.ticket(seen.id);
    if (ticket?.state !== "pr_open" || ticket.pr_url === null) continue;
    store.updateTicket(ticket.id, { pr_checked_at: ctx.now() });
    let state;
    try {
      state = await ctx.host.call(checkout.hostId, "prState", { repo: checkout.repo, url: ticket.pr_url });
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

function completeProject(ctx: EngineCtx, projectId: number): boolean {
  const { store } = ctx;
  const project = store.project(projectId);
  if (project === null || (project.state !== "running" && project.state !== "paused")) return false;
  const tickets = store.tickets(projectId);
  if (tickets.length === 0 || !tickets.every((ticket) => ticket.state === "done" || ticket.state === "cancelled")) return false;
  store.setProjectState(projectId, "done", LOOM_ACTOR);
  store.changed(project.id);
  return true;
}

// ---------------------------------------------------------------- land

const unavailable = (message: string) => new LoomError("loom_unavailable", message);

/**
 * The human's step on the integration strategy: push the integration branch and open one pull request to the base
 * branch, or push the new commits to the one already open. It holds the merge guard throughout, so no merge can move
 * the branch between reading its sha and pushing exactly that sha.
 */
export async function land(ctx: EngineCtx, slug: string, a: { actor: string; title?: string; ready: boolean }): Promise<{ url: string; done: boolean }> {
  const { store } = ctx;
  const seen = store.projectBySlug(slug);
  if (seen === null) throw new LoomError("loom_not_found", `No Loom project named "${slug}".`, "Run `bb loom list` to see the projects.");
  const spec = specOf(store, seen);
  if (spec.merge.strategy !== "integration") throw new LoomError("loom_invalid_state", "Cannot land: this project opens a pull request per ticket, so there is nothing to land.", "Its pull requests are opened and followed automatically.");
  if (seen.state !== "running" && seen.state !== "paused" && seen.state !== "done") throw new LoomError("loom_invalid_state", `Project ${slug} is ${seen.state}; only a running, paused or finished project can be landed.`);

  const release = holdMerge(ctx, seen.id);
  if (release === null) throw new LoomError("loom_invalid_state", "Cannot land: a merge is running; try again in a moment.");
  try {
    const tickets = store.tickets(seen.id);
    if (tickets.some((ticket) => ticket.state === "merging")) throw new LoomError("loom_invalid_state", "Cannot land: a ticket is merging; try again when the merge finishes.");
    const done = tickets.filter((ticket) => ticket.state === "done");
    if (done.length === 0) throw new LoomError("loom_invalid_state", "Cannot land: no ticket is done yet, so the integration branch has nothing to land.");

    const project = store.project(seen.id)!;
    const sha = await guarded(async () => {
      const { hostId, repo, worktree } = await loomWorktree(ctx, project, spec).catch((error) => {
        throw error instanceof Unavailable ? unavailable(error.message) : error;
      });
      const head = (await ctx.host.call(hostId, "worktreeState", { worktree, base: spec.project.base })).head;
      const pushed = await ctx.host.call(hostId, "push", { repo, remote: spec.merge.remote, src: head, branch: spec.merge.branch! });
      if (pushed.outcome === "unavailable") throw unavailable(pushed.message);
      if (project.pr_url === null) {
        const created = await ctx.host.call(hostId, "prCreate", {
          repo,
          remote: spec.merge.remote,
          base: spec.project.base,
          head: spec.merge.branch!,
          title: clip(a.title ?? project.name, 256),
          body: landBody({ project, spec, done }),
          draft: spec.merge.draft && !a.ready,
        });
        if (created.outcome === "unavailable") throw unavailable(created.message);
        store.updateProject(project.id, { pr_url: created.url });
      }
      return head;
    });

    const url = store.project(project.id)!.pr_url!;
    store.event(project.id, null, "project.landed", a.actor, { url, sha, created: project.pr_url === null });
    completeProject(ctx, project.id);
    store.changed(project.id);
    return { url, done: store.project(project.id)!.state === "done" };
  } finally {
    release();
  }
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
