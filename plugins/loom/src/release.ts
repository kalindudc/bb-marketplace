// Releasing the environment of a worker whose ticket's pull request is open, and bringing the same thread back when the
// pull request needs it again. A pull request can wait days for a person, and an idle worker holds its environment all
// that time. Archiving its thread frees the environment; bb's restore later builds a new one on the worker's branch, so
// the worker comes back with its whole conversation. When bb cannot restore it, a new worker takes over from the branch.
import { workerOf } from "./checks";
import type { ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import { formatDuration } from "./format";
import { refreshDue } from "./fresh";
import { prTextReady } from "./pull-requests";
import { prSettings } from "./repos";
import { waitsForSlot } from "./scheduler";
import type { Spec } from "./spec";
import { holdOf, restackOf, stacking, upstreamOf } from "./stack";
import { nextWait, provisioningFailure, startProblemOf, startWaits, UNAVAILABLE_LIMIT_MS, unavailableReason, waitOf, type StartProblem, type StartWait } from "./starts";
import { LOOM_ACTOR } from "./states";
import { headCameHome, isRemote, worktreeBaseOf } from "./transport";
import { applyMove, endThread, released, specOf, type EngineCtx } from "./workers";

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A worker whose thread Loom archived to free its environment while its ticket's pull request is open. */
export const isReleased = (row: ThreadRow | null): row is ThreadRow => row !== null && row.role === "worker" && row.state === "ended" && row.end_reason === "released";

/** A released worker coming back: active again, its environment not restored yet. */
export const isWaking = (row: ThreadRow | null): boolean => row !== null && row.role === "worker" && row.state === "active" && row.released_at !== null;

/** The ticket's worker when Loom released it and its thread may come back; null otherwise. */
export function releasedWorker(store: Store, ticket: TicketRow): ThreadRow | null {
  const row = ticket.worker_thread_id === null ? null : store.threadByThreadId(ticket.worker_thread_id);
  return isReleased(row) ? row : null;
}

/**
 * Whether a pull request's branch must take its dependencies' new commits, or its base for a refresh (fresh.ts), which
 * the merge queue does in the worker's worktree; for an approved ticket, before its pull request opens.
 */
function restackDue(spec: Spec, tickets: readonly TicketRow[], ticket: TicketRow): boolean {
  return (stacking(spec) && holdOf(tickets, ticket) === null && restackOf(tickets, ticket) !== null) || refreshDue(spec, ticket) !== null;
}

// ---------------------------------------------------------------- releasing

/**
 * The tick's step on the pr strategy, unless the spec sets merge.release_workers = false: archives each idle worker
 * whose ticket's pull request is open, so bb frees its environment. Only a worker with nothing in flight goes: no fix
 * round waiting for it, no question waiting for the human, no catch-up due, and a worktree that holds exactly the
 * reviewed commit, so nothing in it can be lost. A worker on a machine of its own also stays while a dependency in its
 * repo is open: its machine cannot come back, and the restacks that dependency causes run in its worktree.
 */
export async function releaseIdleWorkers(ctx: EngineCtx, project: ProjectRow, spec: Spec): Promise<void> {
  if (spec.merge.strategy !== "pr" || !prSettings(spec).releaseWorkers) return;
  const { store, bb } = ctx;
  for (const seen of store.tickets(project.id, ["pr_open"])) {
    const tickets = store.tickets(project.id);
    const ticket = store.ticket(seen.id)!;
    if (ticket.state !== "pr_open" || ticket.handback_json !== null || ticket.head_sha === null || restackDue(spec, tickets, ticket)) continue;
    const worker = workerOf(store, ticket);
    if (worker.standing !== "active" || worker.row.thread_id === null || worker.row.released_at !== null) continue;
    const threadId = worker.row.thread_id;
    try {
      const thread = await bb.getThread(threadId);
      if (thread?.status !== "idle" || (await bb.waitingOnUser([threadId])).length > 0) continue;
      const environment = thread.environmentId === null ? null : await bb.getEnvironment(thread.environmentId);
      if (environment?.path == null) continue;
      if (isRemote(project, environment) && upstreamOf(tickets, ticket).open.length > 0) continue;
      const state = await ctx.host.call(environment.hostId, "worktreeState", { worktree: environment.path, base: worktreeBaseOf(project, spec, ticket, environment) });
      // By tree, since the reviewed commit of a worker on its own machine was brought home with another id. A merge the worker
      // began and did not finish can leave nothing uncommitted, and freeing the environment would lose it.
      if ((ticket.head_tree === null ? state.head !== ticket.head_sha : state.tree !== ticket.head_tree) || state.dirty || state.unfinishedMerge === true) continue;
    } catch (error) {
      bb.log("warn", `Could not tell whether ${ticket.key}'s worker is idle: ${errText(error)}`);
      continue;
    }
    if (store.ticket(ticket.id)?.state !== "pr_open") continue;
    await endThread(ctx, worker.row, "released", { commit: false, move: null });
  }
}

// ---------------------------------------------------------------- waking

/** Marks a released worker active again, without an environment yet; advanceWakes brings it back. Runs inside the transaction that gives it work. */
export function wakeRow(ctx: EngineCtx, row: ThreadRow): ThreadRow {
  ctx.store.updateThread(row.id, { state: "active", ended_at: null, end_reason: null, environment_id: null, clock_at: ctx.now(), idle_count: 0, rate_limit_retries: 0 });
  return ctx.store.thread(row.id)!;
}

/**
 * The tick's step on the pr strategy: wakes the released worker of each open pull request whose branch must catch up,
 * and of each approved ticket whose branch must before its pull request opens, for the merge queue. An approved ticket
 * is woken once its pull request's text is ready, so no ask for it goes to a thread on its way back.
 */
export async function wakeForRestacks(ctx: EngineCtx, project: ProjectRow, spec: Spec): Promise<void> {
  if (spec.merge.strategy !== "pr") return;
  const { store } = ctx;
  for (const seen of store.tickets(project.id, ["pr_open", "approved"])) {
    const woken = store.tx(() => {
      const ticket = store.ticket(seen.id)!;
      const row = releasedWorker(store, ticket);
      const waiting = ticket.state === "pr_open" || (ticket.state === "approved" && prTextReady(spec, ticket));
      if (!waiting || row === null || startWaits(ticket, "worker", ctx.now()) || !restackDue(spec, store.tickets(project.id), ticket)) return null;
      return wakeRow(ctx, row);
    });
    if (woken !== null) await advanceWake(ctx, woken);
  }
}

/**
 * The tick's step: moves each waking worker of the project on, and wakes again a released worker whose fix round waits
 * after a failed restore, once its wait is over and while it has a worker slot. A paused project finishes the restores in
 * flight and starts none.
 */
export async function advanceWakes(ctx: EngineCtx, projectId: number): Promise<void> {
  const { store } = ctx;
  const running = store.project(projectId)?.state === "running";
  for (const row of store.threads({ projectId, role: "worker", states: ["active", "ended"] })) {
    if (isWaking(row)) {
      await advanceWake(ctx, row);
      continue;
    }
    if (!running || !isReleased(row) || row.ticket_id === null) continue;
    const woken = store.tx(() => {
      const ticket = store.ticket(row.ticket_id!);
      const current = store.thread(row.id)!;
      if (ticket?.state !== "working" || ticket.worker_thread_id !== current.thread_id || !isReleased(current) || waitsForSlot(ticket) || startWaits(ticket, "worker", ctx.now())) return null;
      return wakeRow(ctx, current);
    });
    if (woken !== null) await advanceWake(ctx, woken);
  }
}

/**
 * One step of bringing a released worker back: unarchive its thread, ask bb to restore its environment, and once the
 * environment is ready, give the ticket the new environment. Each step is safe to run again; the tick runs the next one.
 */
export async function advanceWake(ctx: EngineCtx, seen: ThreadRow): Promise<void> {
  const { store, bb } = ctx;
  const row = store.thread(seen.id);
  if (row === null || !isWaking(row) || row.thread_id === null) return;
  const threadId = row.thread_id;
  const read = async () => {
    const thread = await bb.getThread(threadId);
    const environment = thread?.environmentId == null ? null : await bb.getEnvironment(thread.environmentId);
    return { thread, environment };
  };
  try {
    let { thread, environment } = await read();
    if (thread === null || thread.deletedAt !== null) return await cannotWake(ctx, row, "its thread was deleted");
    if (thread.archivedAt !== null) {
      await bb.unarchive(threadId);
      ({ thread, environment } = await read());
      if (thread === null) return await cannotWake(ctx, row, "its thread was deleted");
    }
    const failed = async () => {
      const failure = await bb.latestSystemError(threadId).catch(() => null);
      return failure?.code === "thread_provisioning_failed" ? provisioningFailure(failure) : null;
    };
    if (environment === null || environment.status === "destroyed") {
      if (thread.status === "error") {
        const problem = await failed();
        if (problem !== null) return await wakeFailed(ctx, row, problem);
      }
      if (thread.status !== "idle" && thread.status !== "error") return;
      // Unarchiving within the provider's grace period keeps the environment; past it, bb must build a new one.
      if (thread.canRestoreEnvironment !== true) return await cannotWake(ctx, row, "bb cannot restore its environment");
      try {
        await bb.restoreEnvironment(threadId);
      } catch (error) {
        return await wakeFailed(ctx, row, startProblemOf(error));
      }
      ({ thread, environment } = await read());
      if (thread === null) return;
    }
    if (environment?.status === "error" || (thread.status === "error" && environment?.status !== "ready")) {
      const problem = await failed();
      return await wakeFailed(ctx, row, problem ?? { kind: "failed", message: "bb could not restore its environment" });
    }
    if (environment == null || environment.path === null || environment.status === "creating" || environment.status === "provisioning" || thread.status === "starting" || thread.status === "pending") return;
    awake(ctx, row, thread.environmentId!, environment.branchName);
  } catch (error) {
    bb.log("warn", `Could not bring back the worker ${threadId}; Loom tries again: ${errText(error)}`);
  }
}

function awake(ctx: EngineCtx, row: ThreadRow, environmentId: string, branch: string | null): void {
  const { store } = ctx;
  store.tx(() => {
    const current = store.thread(row.id);
    if (!isWaking(current)) return;
    store.updateThread(row.id, { released_at: null, environment_id: environmentId, clock_at: ctx.now(), idle_count: 0 });
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    if (ticket === null || ticket.worker_thread_id !== row.thread_id) return;
    store.updateTicket(ticket.id, { environment_id: environmentId, ...(waitOf(ticket, "worker") === null ? {} : { start_wait_json: null }) });
    const body = `The worker's thread is back, with a new environment on ${branch === null ? "its branch" : `its branch ${branch}`}.`;
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body, data_json: JSON.stringify({ woken: true }) });
  });
  store.changed(row.project_id);
  ctx.kick();
}

/**
 * bb could not bring the environment back. The worker is released again and the ticket waits (StartWait) to try again;
 * a failure that happens START_GRACE times in a row, or one bb refuses outright, hands the ticket to a new worker.
 */
async function wakeFailed(ctx: EngineCtx, row: ThreadRow, problem: StartProblem): Promise<void> {
  const { store } = ctx;
  const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
  const previous = ticket === null ? null : waitOf(ticket, "worker");
  const wait = nextWait(previous, { role: "worker", row: row.id, problem, now: ctx.now() });
  if (wait.expired) return blockUnavailable(ctx, row, wait);
  if (problem.kind === "refused" || problem.kind === "broken" || wait.counted) return cannotWake(ctx, row, problem.message);
  store.tx(() => {
    store.updateThread(row.id, { state: "ended", ended_at: ctx.now(), end_reason: "released" });
    if (ticket === null || ticket.worker_thread_id !== row.thread_id) return;
    store.updateTicket(ticket.id, { start_wait_json: JSON.stringify(wait) });
    if (previous?.reason !== wait.reason) {
      const after = wait.kind === "unavailable" ? `the ticket blocks if the provider stays unavailable for ${formatDuration(UNAVAILABLE_LIMIT_MS)}` : "after 4 failures in a row a new worker takes over from the branch";
      const body = `Could not bring the worker's environment back: ${wait.reason}. Loom tries again in ${formatDuration(wait.until - ctx.now())}; ${after}.`;
      store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body });
    }
  });
  store.changed(row.project_id);
  await ctx.bb.archive(row.thread_id!).catch((error) => ctx.bb.log("warn", `Could not archive ${row.thread_id}: ${errText(error)}`));
}

/**
 * The released worker cannot come back: its thread is gone, or bb cannot restore its environment. A new worker takes
 * the ticket from its branch, as when a worker is gone, and reads the ticket and where the earlier worker's thread is.
 */
async function cannotWake(ctx: EngineCtx, row: ThreadRow, why: string): Promise<void> {
  const { store } = ctx;
  const seen = row.ticket_id === null ? null : store.ticket(row.ticket_id);
  // A worker's branch on a machine of its own went with the machine; its work is on the home branch.
  const home = seen !== null && (await headCameHome(ctx, store.project(seen.project_id)!, specOf(store, store.project(seen.project_id)!), seen));
  store.tx(() => {
    store.updateThread(row.id, { state: "ended", ended_at: ctx.now(), end_reason: "gone" });
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    if (ticket === null || ticket.worker_thread_id !== row.thread_id) return;
    const from = home ? "the work Loom brought home" : ticket.branch === null ? "the ticket's branch" : `its branch ${ticket.branch}`;
    const body = `The worker's thread cannot come back with an environment (${why}), so a new worker takes over from ${from}; it can read the earlier worker's conversation.`;
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body });
    if (ticket.state === "working" || ticket.state === "pr_open") {
      applyMove(ctx, ticket, { to: "queued", patch: { ...released, handback_json: null, start_wait_json: null } }, LOOM_ACTOR, { reason: "the worker's thread cannot come back" });
    }
  });
  store.changed(row.project_id);
  ctx.kick();
  const thread = await ctx.bb.getThread(row.thread_id!).catch(() => null);
  if (thread !== null && thread.archivedAt === null && thread.deletedAt === null) await ctx.bb.archive(row.thread_id!).catch((error) => ctx.bb.log("warn", `Could not archive ${row.thread_id}: ${errText(error)}`));
}

/** The provider stayed unavailable for the whole limit: the ticket blocks, so triage hears of it, and a requeue starts a new worker from the branch. */
async function blockUnavailable(ctx: EngineCtx, row: ThreadRow, wait: StartWait): Promise<void> {
  const { store } = ctx;
  const reason = `the worker could not come back: ${unavailableReason(wait)}`;
  store.tx(() => {
    store.updateThread(row.id, { state: "ended", ended_at: ctx.now(), end_reason: "gone" });
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    if (ticket === null || ticket.worker_thread_id !== row.thread_id) return;
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
    applyMove(ctx, ticket, { to: "blocked", patch: { ...released, blocked_reason: reason, handback_json: null, start_wait_json: null } }, LOOM_ACTOR, { reason: "the environment provider stayed unavailable" });
  });
  store.changed(row.project_id);
  ctx.kick();
  await ctx.bb.archive(row.thread_id!).catch((error) => ctx.bb.log("warn", `Could not archive ${row.thread_id}: ${errText(error)}`));
}

/** Whether the worker's worktree was restored since it last submitted, so a message to it says what that means. */
export function restoredSinceSubmit(posts: ReadonlyArray<{ kind: string; data_json: string }>): boolean {
  for (let index = posts.length - 1; index >= 0; index -= 1) {
    const post = posts[index]!;
    if (post.kind === "submit") return false;
    if (post.kind === "system" && (JSON.parse(post.data_json) as { woken?: boolean }).woken === true) return true;
  }
  return false;
}
