// The merge queue: approved tickets merge one at a time per project, either into the integration branch (with the
// after_merge checks run on the merged result) or as one pull request each. Every host step is idempotent, so a ticket
// left in `merging` by a pause, a restart or a failure worth waiting out simply runs again. Merges run in the background,
// like checks, under the project's merge guard.
import { workerOf, specOf, type EngineCtx } from "./ctx";
import type { ProjectRow, Store, TicketRow } from "./db/store";
import { plural } from "./format";
import { Unavailable, mergeWaitExpired, mergeWaitOf, mergeWaitReason, mergeWaitText, mergeWaits, nextMergeWait, type Transient, waitableOf } from "./forge-waits";
import { prTextReady } from "./pr-text";
import { LoomError } from "./projects";
import { repoSettings } from "./repos";
import { recordingHost } from "./runs";
import { refreshDue } from "./fresh";
import type { Spec } from "./spec";
import { EMPTY_STACK, holdKey, holdOf, restackOf, stackOf, stacking, type Hold } from "./stack";
import { LOOM_ACTOR } from "./states";
import { writeSub } from "./sub-state";
import { isWaking, releasedWorker } from "./release";
import { pauseProject } from "./workers";
import { moveTicket } from "./moves";
import { addMergePost, addWaitPost, endFinishedThreads, errText, holdOpens } from "./merge-common";
import { loomWorktree, mergeIntoIntegration, provisioningRepos } from "./merge-integration";
import { openPullRequest } from "./pr-open";

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

const mergeRuns = new WeakMap<Store, Set<Promise<void>>>();
const runsOf = (store: Store) => mergeRuns.get(store) ?? mergeRuns.set(store, new Set()).get(store)!;

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

// The ticket to merge: the one left in merging, unless its merge waits after a failure worth waiting out, when the queue
// waits too; else the first candidate whose repo has no worker worktree being created, moved to merging. The tick runs
// every 15 seconds, so a wait that ends is picked up then.
async function begin(ctx: EngineCtx, projectId: number, spec: Spec): Promise<TicketRow | null> {
  const { store } = ctx;
  if (store.project(projectId)?.state !== "running") return null;
  const left = store.tickets(projectId, ["merging"])[0];
  if (left !== undefined) return mergeWaits(left, ctx.now()) ? null : left;
  postHolds(ctx, projectId, spec);
  if (candidates(ctx, projectId, spec).length === 0) return null;
  const waiting = spec.merge.strategy === "integration" ? await provisioningRepos(ctx, projectId) : new Set<string | null>();
  const next = candidates(ctx, projectId, spec).find((ticket) => !waiting.has(ticket.repo));
  if (next === undefined || store.project(projectId)?.state !== "running") return null;
  store.tx(() => {
    const refresh = next.state === "pr_open" ? refreshDue(spec, next) : null;
    moveTicket(store, next.id, { name: "merge" }, LOOM_ACTOR, next.state === "pr_open" ? { head: next.head_sha, restack: true, ...(refresh === null ? {} : { refresh }) } : { head: next.head_sha });
  });
  return store.ticket(next.id)!;
}

/**
 * The tickets the merge queue may take: approved ones whose pull request text is ready and whose pull request no open
 * dependency holds; open pull requests whose branch must catch up, on a project that stacks with what they are stacked
 * on, and on a repo that sets refresh_behind with their base when they are due a refresh (fresh.ts), while their worker
 * is there to run the checks in its worktree; and an open ticket whose closed pull request Loom let go of, for a new one.
 * A ticket whose branch must catch up waits while its released worker comes back (wakeForRestacks); one whose worker is
 * gone for good goes to a new worker when the merge needs one. Oldest first, except that a refresh with nothing else to
 * take goes after every other merge, so a batch of them never holds up a first pull request or a restack a stack needs.
 */
function candidates(ctx: EngineCtx, projectId: number, spec: Spec): TicketRow[] {
  const { store } = ctx;
  const tickets = store.tickets(projectId);
  const stack = stacking(spec);
  const held = (ticket: TicketRow) => stack && holdOf(tickets, ticket) !== null;
  const restacks = (ticket: TicketRow) => stack && restackOf(tickets, ticket) !== null;
  // A worker coming back from a release has no worktree yet (advanceWakes).
  const present = (ticket: TicketRow) => {
    const worker = workerOf(store, ticket);
    return worker.standing === "active" && !isWaking(worker.row);
  };
  const comingBack = (ticket: TicketRow) => releasedWorker(store, ticket) !== null || isWaking(workerOf(store, ticket).row);
  const goneForGood = (ticket: TicketRow) => workerOf(store, ticket).standing === "gone" && !comingBack(ticket);
  const onlyRefresh = (ticket: TicketRow) => ticket.state === "pr_open" && !reopens(spec, ticket) && !restacks(ticket);
  return tickets
    .filter((ticket) => {
      // A worker coming back after its worktree went missing mid-merge (worktreeGone) is waited for outside the queue.
      if (ticket.state === "approved") return prTextReady(spec, ticket) && !held(ticket) && !(restacks(ticket) && comingBack(ticket)) && !isWaking(workerOf(store, ticket).row);
      if (ticket.state !== "pr_open" || held(ticket)) return false;
      if (reopens(spec, ticket)) return !restacks(ticket) || present(ticket) || goneForGood(ticket);
      return (restacks(ticket) || refreshDue(spec, ticket) !== null) && present(ticket);
    })
    .sort((a, b) => Number(onlyRefresh(a)) - Number(onlyRefresh(b)) || a.state_at - b.state_at || a.seq - b.seq);
}

/** An open ticket with no pull request on a forge that has them: Loom let go of a closed one (closedPullRequest), and the merge queue opens a new one. */
const reopens = (spec: Spec, ticket: TicketRow) => ticket.state === "pr_open" && ticket.pr_url === null && ticket.pushed_sha !== null && repoSettings(spec, ticket.repo).forge.kind !== "none";

/** Posts, once per hold, why an approved ticket's pull request waits on its open dependencies. */
function postHolds(ctx: EngineCtx, projectId: number, spec: Spec): void {
  if (!stacking(spec)) return;
  const { store } = ctx;
  const tickets = store.tickets(projectId);
  for (const ticket of tickets) {
    if (ticket.state !== "approved") continue;
    const hold = holdOf(tickets, ticket);
    const known = stackOf(ticket);
    const key = hold === null ? undefined : holdKey(hold);
    if (key === known?.held || (known === null && hold === null)) continue;
    store.tx(() => {
      store.updateTicket(ticket.id, writeSub("stack_json", { ...(known ?? EMPTY_STACK), held: key }));
      if (hold !== null) addMergePost(ctx, ticket, { body: holdText(spec, ticket, hold), data: { outcome: "held", why: hold.why, keys: hold.keys } });
    });
    store.changed(projectId);
  }
}

function holdText(spec: Spec, ticket: TicketRow, hold: Hold): string {
  return `${ticket.key} passed review. ${holdOpens(spec, ticket, hold)}`;
}

/**
 * Merges one ticket in `merging`. Safe to run again: a host step that already happened reports itself as done. A failure
 * worth waiting out keeps the ticket in merging until its wait ends (waitOutMerge); any other failure pauses the project
 * with the reason, instead of retrying every tick, and the ticket stays in merging too.
 */
export async function mergeTicket(ctx: EngineCtx, project: ProjectRow, spec: Spec, seen: TicketRow): Promise<void> {
  const ticket = ctx.store.ticket(seen.id);
  if (ticket?.state !== "merging") return;
  try {
    const recorded: EngineCtx = { ...ctx, host: recordingHost(ctx.store, ctx.host, ticket, "merge") };
    if (spec.merge.strategy === "integration") await mergeIntoIntegration(recorded, project, spec, ticket);
    else await openPullRequest(recorded, project, spec, ticket);
  } catch (error) {
    const failure = waitableOf(error);
    if (failure !== null) return waitOutMerge(ctx, ticket, errText(error), failure);
    endMergeWait(ctx, ticket.id);
    pauseProject(ctx, project.id, error instanceof Unavailable ? error.message : `Merging ${ticket.key} stopped: ${errText(error)}`);
    return;
  }
  endMergeWait(ctx, ticket.id);
}

/**
 * A merge that failed in a way worth waiting out: the ticket stays in merging and the queue waits, 1, 2, 5, 10, then 15
 * minutes, and at least 15 after a rate limit. The first failure of a streak posts on the ticket; an hour of them pauses
 * the project and ends the wait, so a resume merges at once.
 */
function waitOutMerge(ctx: EngineCtx, seen: TicketRow, message: string, failure: Transient): void {
  const { store } = ctx;
  const now = ctx.now();
  const ticket = store.ticket(seen.id)!;
  const what = `Merging ${ticket.key}`;
  // The ticket moved on before the step after it failed; the next launch replays that step (endFinishedThreads).
  if (ticket.state !== "merging") return ctx.bb.log("warn", `${what}: a step after the merge failed with what looks like a temporary error: ${message}`);
  const previous = mergeWaitOf(ticket);
  const wait = nextMergeWait(previous, { now, message, ...failure });
  ctx.bb.log("warn", `${what} failed ${plural(wait.failures, "time")} in a row with what looks like a temporary error: ${message}`);
  if (mergeWaitExpired(wait, now)) {
    endMergeWait(ctx, ticket.id);
    pauseProject(ctx, ticket.project_id, mergeWaitReason(what, wait, now));
    return;
  }
  store.tx(() => {
    store.updateTicket(ticket.id, writeSub("merge_wait_json", wait));
    if (previous === null) addWaitPost(ctx, ticket, mergeWaitText(what, wait, now), { mergeFailed: true, failures: wait.failures, until: wait.until });
  });
  store.changed(ticket.project_id);
}

function endMergeWait(ctx: EngineCtx, ticketId: number): void {
  const ticket = ctx.store.ticket(ticketId);
  if (ticket === null || ticket.merge_wait_json === null) return;
  ctx.store.updateTicket(ticketId, { merge_wait_json: null });
  ctx.store.changed(ticket.project_id);
}

/**
 * Before the human blocks or cancels a ticket left in merging, whose merge is not running since the caller holds the
 * merge guard: on the integration strategy, a merge the ticket made in its integration branch before its after_merge
 * checks passed is taken out again, back to the point persisted before it, which nothing else can have moved since, as
 * merges and lands wait while a ticket is in merging. Its wait and its merge step end.
 */
export async function stopMerge(ctx: EngineCtx, ticket: TicketRow): Promise<void> {
  const { store } = ctx;
  const project = store.project(ticket.project_id)!;
  const spec = specOf(store, project);
  if (spec.merge.strategy === "integration" && ticket.merge_before !== null) {
    const before = ticket.merge_before;
    try {
      const { hostId, worktree, settings } = await loomWorktree(ctx, project, spec, ticket.repo);
      const { head } = await ctx.host.call(hostId, "worktreeState", { worktree, base: settings.base });
      if (head !== before) await ctx.host.call(hostId, "resetHard", { worktree, sha: before });
    } catch (error) {
      throw new LoomError("loom_unavailable", `Loom could not take ${ticket.key}'s merge back out of its integration branch: ${errText(error)}`, "Try again once the project's machine answers.");
    }
  }
  store.updateTicket(ticket.id, { merge_wait_json: null, merge_step_json: null, merge_before: null });
  store.changed(ticket.project_id);
}
