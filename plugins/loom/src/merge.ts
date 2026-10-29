// The merge queue: approved tickets merge one at a time per project, either into the integration branch (with the
// after_merge checks run on the merged result) or as one pull request each. Every host step is idempotent, so a ticket
// left in `merging` by a pause, a restart or a failure worth waiting out simply runs again. Merges run in the background,
// like checks.
import { workerOf, type CheckRun } from "./checks";
import { repoCheckout, type RepoCheckout } from "./checkouts";
import type { ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import { plural } from "./format";
import {
  backedOffUntil,
  backoffText,
  forgeHostOf,
  hostCallTransient,
  mergeWaitExpired,
  mergeWaitOf,
  mergeWaitReason,
  mergeWaits,
  mergeWaitText,
  networkWaitReason,
  networkWaitText,
  nextBackoff,
  nextMergeWait,
  nextNetworkBackoff,
  nextPollAt,
  nextPollWait,
  pollWaitOf,
  pollWaitReason,
  pollWaitText,
  PROJECT_MACHINE,
  SERVER_ERROR_LIMIT_MS,
  transientOf,
  Unavailable,
  waitableOf,
  type Transient,
} from "./forge-waits";
import { afterMergeChangedText, afterMergeFailedText, andList, clip, conflictText, dependsOnLines, landBody, prDivergedText, restackConflictText, restackFailedText, restackMarkersText, restackRefusedText, unfinishedMergeText, withRestoredNote, workerPrBody } from "./prompts";
import { appliedOf, applyPrText, closedPrReset, followFeedback, inFixRound, openedText, proposalOf, prRollout, prTextFor, prTextReady, reviewersToAsk, syncPrText, targetText, templatePr, wantedText, type PrApplied, type PrText } from "./pull-requests";
import { githubPull, prNumber, PR_BATCH_MAX, type HostInput, type HostOutput as HostOutputOf } from "./host-contract";
import type { EnvironmentInfo } from "./ports";
import { readMeta, type PrMeta } from "./pr-meta";
import { LoomError } from "./projects";
import { followsFeedback, freshBaseOf, gitNetwork, isMultiRepo, prSettings, repoSettings, type RepoSettings } from "./repos";
import { forgetClosedReads, noteAnswer, readGoesOut } from "./pr-sync";
import { recordingHost } from "./runs";
import { refreshDue, refreshedMeta, refreshedText, type Refresh } from "./fresh";
import type { ForgeSpec, Spec } from "./spec";
import { EMPTY_STACK, holdKey, holdOf, prBaseOf, restackOf, restackWithBase, stackBranch, stacking, stackOf, type Hold, type Restack, type Stack } from "./stack";
import { isForeign, readTip, TIP_WHAT, tipOutgrowsStack, tipRef, withMarkers, type Tip } from "./tips";
import { LOOM_ACTOR } from "./states";
import { isWaking, releasedWorker, restoredSinceSubmit } from "./release";
import { deliverHandBacks, handBack } from "./slots";
import { carryTo, homeBranch, isRemote, reviewedRef, workBaseOf } from "./transport";
import { applyMove, baseOf, endLiveRows, endThread, pauseProject, released, resolveEnvironment, specOf, type EngineCtx } from "./workers";

const AFTER_OPEN_MS = 5 * 60_000;
const PROVISION_MS = 10 * 60_000;
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
    store.setTicketState(next.id, "merging", LOOM_ACTOR, next.state === "pr_open" ? { head: next.head_sha, restack: true, ...(refresh === null ? {} : { refresh }) } : { head: next.head_sha });
    store.updateTicket(next.id, { merge_before: null, merge_wait_json: null, merge_step_json: null });
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
      if (ticket.state === "approved") return prTextReady(spec, ticket) && !held(ticket) && !(restacks(ticket) && comingBack(ticket));
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
      store.updateTicket(ticket.id, { stack_json: JSON.stringify({ ...(known ?? EMPTY_STACK), held: key } satisfies Stack) });
      if (hold !== null) addMergePost(ctx, ticket, { body: holdText(spec, ticket, hold), data: { outcome: "held", why: hold.why, keys: hold.keys } });
    });
    store.changed(projectId);
  }
}

function holdText(spec: Spec, ticket: TicketRow, hold: Hold): string {
  return `${ticket.key} passed review. ${holdOpens(spec, ticket, hold)}`;
}

/** When a held pull request opens, in a sentence. */
function holdOpens(spec: Spec, ticket: TicketRow, hold: Hold, fresh = ""): string {
  const keys = andList(hold.keys);
  if (hold.why === "merge") return `Its ${fresh}pull request opens once all but one of ${keys} have merged, because a pull request builds on one other branch.`;
  if (hold.why === "push") return `Its ${fresh}pull request opens once ${keys} has a pull request again.`;
  const { remote, base } = repoSettings(spec, ticket.repo);
  return `Its ${fresh}pull request opens on ${keys}'s branch once Loom has merged ${remote}/${base}, which has the dependencies that merged since, into that branch.`;
}

function addMergePost(ctx: EngineCtx, ticket: TicketRow, post: { body: string; data: object }): void {
  ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "merge", body: post.body, data_json: JSON.stringify(post.data) });
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
    store.updateTicket(ticket.id, { merge_wait_json: JSON.stringify(wait) });
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

/** A host's unavailable answer as an Unavailable, keeping whether it is worth waiting out; `message` replaces its own. */
const unavailableOf = (answer: { message: string } & Partial<Transient>, message = answer.message) => new Unavailable(message, transientOf(answer));

// A repo without a checkout pauses the project with repoCheckout's message, which gives the clone command.
async function checkoutIn(ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string | null): Promise<RepoCheckout> {
  try {
    return await repoCheckout(ctx, project, spec, name);
  } catch (error) {
    throw error instanceof LoomError ? new Unavailable(error.message) : error;
  }
}

export async function checkoutOf(ctx: EngineCtx, project: ProjectRow): Promise<{ hostId: string; repo: string }> {
  const repo = project.host_id === null ? null : await ctx.bb.projectCheckout(project.bb_project_id, project.host_id);
  if (project.host_id === null || repo === null) throw new Unavailable(`The bb project has no checkout on the machine ${project.host_id ?? "(unknown)"}; add the repository there and resume.`);
  return { hostId: project.host_id, repo };
}

// The integration branch as the human reads it: on a multi-repo project, with the repo it is in.
const branchIn = (settings: RepoSettings) => (settings.name === null ? settings.branch! : `${settings.branch!} in the repo "${settings.name}"`);

/** The plugin's worktree of a repo's integration branch: keyed by the slug for the project's own repository, by `<slug>.<name>` for a named repo. */
async function loomWorktree(ctx: EngineCtx, project: ProjectRow, spec: Spec, name: string | null = null): Promise<{ hostId: string; repo: string; worktree: string; settings: RepoSettings }> {
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
const unfinishedInLoomWorktree = (worktree: string) => `The Loom worktree ${worktree} has a merge that is not finished; resume, and Loom aborts it before it merges again.`;

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
 * the ticket leaves `merging` before the merge guard is released. The worker gets it as a hand-back, once a worker slot is
 * free. A worker that is ending counts as gone: the only ways it can be ending here leave the ticket alone, because block
 * and cancel are refused while a ticket merges.
 */
async function sendBack(ctx: EngineCtx, ticketId: number, a: { post: MergePost; text: { summary: string; detail: string }; countFailure: boolean; reason: string }): Promise<void> {
  const { store } = ctx;
  let failures = 0;
  const applied = store.tx(() => {
    const ticket = store.ticket(ticketId);
    if (ticket === null || ticket.state !== "merging") return false;
    store.addPost({ project_id: ticket.project_id, ticket_id: ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: a.post.kind, body: a.post.body, data_json: JSON.stringify(a.post.data) });
    if (a.countFailure) {
      failures = ticket.check_failures + 1;
      store.updateTicket(ticketId, { check_failures: failures });
    }
    const worker = workerOf(store, ticket);
    if (worker.standing === "active" && worker.row.thread_id !== null) handBack(ctx, store.ticket(ticketId)!, worker.row, worker.row.thread_id, a.text, { reason: a.reason });
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
      store.updateTicket(ticketId, { blocked_reason: reason, handback_json: null });
      store.addPost({ project_id: ticket.project_id, ticket_id: ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
    });
    await endLiveRows(ctx, store.ticket(ticketId)!, "blocked");
    return;
  }
  await deliverHandBacks(ctx, ticket.project_id);
}

async function openPullRequest(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow): Promise<void> {
  const { store } = ctx;
  const checkout = await checkoutIn(ctx, project, spec, ticket.repo);
  const { hostId, path: repo, settings } = checkout;
  const branch = ticket.pr_branch ?? ticket.branch;
  if (branch === null) throw new Unavailable(`${ticket.key} has no branch recorded, so a pull request cannot be opened. Requeue it.`);
  const { remote, base } = settings;
  const fix = inFixRound(ticket);
  // A ticket the queue took from pr_open only catches up with what it is stacked on or with its base, or opens a new pull
  // request for one Loom let go of; no worker wrote anything for it.
  const taken = fix ? catchUpOf(ctx, ticket) : null;
  const catchUp = taken !== null;
  const refresh = taken?.refresh ?? null;
  const text = prTextFor(spec, ticket) ?? { head: ticket.head_sha!, by: "loom" as const, title: null, body: null, commit: `${ticket.key}: ${ticket.title}` };

  // While the worker fixed it, the human may have merged or closed the pull request, perhaps into the branch it is stacked on.
  if (fix && ticket.pr_url !== null && settings.forge.kind !== "none") {
    const state = await fixRoundState(ctx, checkout, ticket.pr_url);
    if (state.outcome === "unavailable") throw unavailableOf(state);
    store.updateTicket(ticket.id, { pr_meta_json: JSON.stringify(readMeta(ticket, { at: ctx.now(), ...state.meta, state: state.state })) });
    if (state.state === "MERGED" && state.meta.base !== null && state.meta.base !== base) {
      await blockMergedElsewhere(ctx, ticket, settings, state.meta.base);
      return;
    }
    if (state.state === "MERGED") {
      const body = catchUp ? `The pull request merged before Loom brought it up to date, so ${ticket.key} is done.` : `The pull request merged before Loom pushed fix round ${ticket.pr_rounds}, so the fix stays on ${ticket.branch ?? branch}.`;
      complete(ctx, ticket.id, { kind: "merge", body, data: { outcome: "pr_merged", url: ticket.pr_url, unpushed: true } });
      await endFinishedThreads(ctx, project.id);
      return;
    }
    if (state.state === "CLOSED") {
      if (await closedPullRequest(ctx, project, store.ticket(ticket.id)!, state.meta.base)) await openPullRequest(ctx, project, spec, store.ticket(ticket.id)!);
      return;
    }
  }

  let current = ticket;
  let caughtUp: string | null = null;
  // Whether a merge Loom made for this push ran the ticket's checks.
  let checked = false;
  // A merge an earlier run put in the worker's worktree is finished first, so nothing builds on the head it replaces.
  const step = stepOf(ticket);
  if (step !== null) {
    const finished = await finishStep(ctx, project, spec, ticket, step, checkout, text);
    if (finished === null) return;
    current = finished;
    caughtUp = step.what;
    checked = true;
  }
  // A refresh takes the base tip it was counted against through the restack a stacked ticket uses; a merge step finished above was its merge.
  const need = refresh !== null && step === null ? restackWithBase(store.tickets(project.id), current, refresh.tip) : stacking(spec) ? restackOf(store.tickets(project.id), current) : null;
  if (need !== null) {
    const result = await restack(ctx, project, spec, current, need, checkout, text);
    if (result === null) return;
    if (result !== "skipped") {
      current = result.ticket;
      caughtUp = caughtUp === null ? result.what : `${caughtUp} and ${result.what}`;
      checked ||= result.checked;
    }
  }
  if (catchUp && caughtUp === null && current.pr_url !== null && !baseMoved(ctx, settings, current)) {
    toPrOpen(ctx, current.id, refresh === null ? {} : refreshedMeta(store.ticket(current.id)!), null, { url: current.pr_url, restack: true });
    return;
  }

  let src = current.head_sha!;
  let created = true;
  if (prSettings(spec).squash) {
    const build = async (head: TicketRow) => {
      const message = catchUp ? `${head.key}: merge ${caughtUp ?? "its new base"} (Loom)` : text.commit;
      return ctx.host.call(hostId, "prCommit", { repo, remote, branch, base: await workBaseOf(ctx, project, spec, head, head.head_sha!), head: head.head_sha!, message, ...(head.pushed_sha === null ? {} : { pushed: head.pushed_sha }), ...gitNetwork(settings) });
    };
    let built = await build(current);
    // Someone else pushed to the branch: their commits are merged in first, again if the branch moves meanwhile.
    for (let taken = 0; built.outcome === "diverged" && taken < TIP_TAKES; taken += 1) {
      const took = await takeAtPush(ctx, project, spec, current, checkout, text);
      if (took === null) return;
      if (took.head_sha !== current.head_sha) {
        caughtUp = caughtUp === null ? TIP_WHAT : `${caughtUp} and ${TIP_WHAT}`;
        checked = true;
      }
      current = took;
      built = await build(current);
    }
    if (built.outcome === "unavailable") throw unavailableOf(built);
    if (built.outcome === "diverged") {
      await sendBack(ctx, current.id, {
        post: { kind: "merge", body: `The pull request's branch ${branch} got commits Loom did not push while Loom merged the earlier ones (its tip is ${built.tip.slice(0, 12)}), so Loom pushed nothing.`, data: { outcome: "diverged", tip: built.tip, branch } },
        text: prDivergedText(current.key),
        countFailure: false,
        reason: "the pull request's branch has commits Loom did not push",
      });
      return;
    }
    src = built.sha;
    created = built.created;
  }
  const pushedNow = created || src !== current.pushed_sha;
  if (pushedNow) {
    const pushed = await ctx.host.call(hostId, "push", { repo, remote, src, branch, ...gitNetwork(settings) });
    if (pushed.outcome === "unavailable") throw unavailableOf(pushed);
  }
  const at = ctx.now();
  const recorded: Partial<TicketRow> = { pr_branch: branch, pushed_sha: src, pushed_at: at, pr_checked_at: at, pr_status_json: null, pr_poll_json: null };
  const commits = prSettings(spec).squash ? ` as 1 commit (${src.slice(0, 12)})` : "";
  const prBase = stacking(spec) ? prBaseOf(store.tickets(project.id), current, base) : base;

  if (settings.forge.kind === "none" || (fix && current.pr_url !== null)) {
    const where = `${remote}/${branch}`;
    const target = current.pr_url ?? where;
    // The title and description the fix round sets once it is pushed, when they change.
    const want = fix ? wantedText(ctx, current, text) : null;
    const post: MergePost | null = !fix
      ? { kind: "merge", body: `Pushed ${branch} to ${remote}${commits}. Open its pull request there${prBase === base ? "" : ` on ${prBase}`}; Loom completes the ticket when ${remote}/${base} contains ${src.slice(0, 12)}.`, data: { outcome: "branch_pushed", pushed: where, sha: src, base: prBase } }
      : catchUp
        ? pushedNow
          ? refresh !== null
            ? { kind: "merge", body: refreshedText(current.key, refresh, `${remote}/${base}`, caughtUp ?? `${remote}/${base}`, src, checked), data: { outcome: "pr_pushed", url: current.pr_url, pushed: where, sha: src, restack: true, refresh } }
            : { kind: "merge", body: `Pushed ${current.key}'s branch, up to date with ${caughtUp ?? "its new base"}, to ${target}${commits}.`, data: { outcome: "pr_pushed", url: current.pr_url, pushed: where, sha: src, restack: true } }
          : null
        : pushedNow
          ? { kind: "merge", body: `Pushed fix round ${current.pr_rounds} to ${target}${commits}.`, data: { outcome: "pr_pushed", url: current.pr_url, pushed: where, sha: src, round: current.pr_rounds } }
          : want !== null
            ? { kind: "merge", body: `Fix round ${current.pr_rounds} changes only the pull request's text, so Loom pushed nothing to ${target}.`, data: { outcome: "pr_unchanged", url: current.pr_url, sha: src, round: current.pr_rounds, text: true } }
            : { kind: "merge", body: `Fix round ${current.pr_rounds} changed nothing the pull request does not already have, so Loom pushed nothing to ${target}.`, data: { outcome: "pr_unchanged", url: current.pr_url, sha: src, round: current.pr_rounds } };
    // The push's after_push runs as soon as Loom knows whether the pull request moves in this pass: once, after the move and
    // on the new base, when it moves, so CI starts once; else at once, on the base the pull request has, also when the move
    // waits or pauses, so no push loses its run. A move that succeeds on a later run then gets its own.
    const has = current.pr_base ?? base;
    const hook = (moved: boolean) =>
      current.pr_url === null ? Promise.resolve() : afterPush(ctx, { hostId, repo, settings, head: branch, base: moved ? prBase : has, sha: src, url: current.pr_url, projectId: project.id, ticketId: current.id, pushed: pushedNow, moved });
    let retargeted: Retargeted | null = null;
    if (current.pr_url !== null && prBase !== has) {
      try {
        retargeted = await retarget(ctx, { hostId, repo, settings, ticket: current, base: prBase });
      } catch (error) {
        await hook(false);
        throw error;
      }
    }
    const moved = retargeted?.moved === true;
    const asked = fix && !catchUp && pushedNow ? await askForReviews(ctx, { hostId, repo, settings, ticket: current }) : null;
    const data = settings.forge.kind === "none" ? { pushed: where } : catchUp ? { url: current.pr_url, restack: true } : { url: current.pr_url, fixRound: current.pr_rounds };
    const posts = [post, retargeted?.post ?? null, asked].filter((each): each is MergePost => each !== null);
    toPrOpen(ctx, current.id, { ...recorded, ...(moved ? { pr_base: prBase } : {}), ...(refresh === null ? {} : refreshedMeta(store.ticket(current.id)!)) }, posts, data);
    // Recorded in the same synchronous stretch as the move to pr_open, before any command runs.
    await hook(moved);
    if (want !== null) await applyPrText(ctx, spec, store.ticket(current.id)!, checkout, want);
    return;
  }

  const dependsOn = dependsOnLines(spec, store.tickets(project.id), current);
  const rollout = prRollout(ctx, spec, current);
  // loom_pr's title and body win over the ones the reviewers saw proposed; either missing leaves Loom's template. A
  // replacement for a closed stacked pull request falls back, field by field, on the text it kept (keptText).
  const proposal = proposalOf(current);
  const kept = fix ? appliedOf(current) : null;
  const title = text.title ?? proposal?.title ?? kept?.title ?? null;
  const body = text.body ?? proposal?.body ?? kept?.body ?? null;
  const template = templatePr(ctx, current, dependsOn, rollout);
  const own = kept !== null || (title !== null && body !== null);
  const pr = own ? { title: title ?? template.title, body: body === null ? template.body : workerPrBody(current.key, body, dependsOn, rollout) } : template;
  const opened = await ctx.host.call(hostId, "prCreate", { repo, remote, base: prBase, head: branch, title: clip(pr.title, 256), body: clip(pr.body, 60_000), draft: spec.merge.draft, forge: openForge(settings.forge) });
  if (opened.outcome === "unavailable") throw unavailableOf(opened);
  const on = prBase === base ? "" : ` on ${prBase}`;
  const applied = openedText(ctx, spec, current, clip(pr.title, 256), own ? body : null);
  toPrOpen(ctx, current.id, { ...recorded, pr_url: opened.url, pr_base: prBase, pr_meta_json: null, pr_applied_json: applied, pr_proposal_json: null }, { kind: "merge", body: `Opened pull request ${opened.url}${on}${commits}.`, data: { outcome: "pr_opened", url: opened.url, sha: src, base: prBase } }, { url: opened.url, opened: true });
  await afterOpen(ctx, { hostId, repo, settings, head: branch, base: prBase, url: opened.url, projectId: project.id, ticketId: current.id });
}

/** Whether the queue took this ticket from pr_open to catch up, and the refresh it was due then: its move to merging says so. */
function catchUpOf(ctx: EngineCtx, ticket: TicketRow): { refresh: Refresh | null } | null {
  const last = ctx.store.ticketEvents(ticket.id, ["ticket.state"]).at(-1);
  const data = last === undefined ? null : (JSON.parse(last.data_json) as { to?: string; restack?: boolean; refresh?: Refresh });
  return data?.to === "merging" && data.restack === true ? { refresh: data.refresh ?? null } : null;
}

// A catch-up that merged nothing may still have to move the pull request to another base, when the dependency it built on merged.
function baseMoved(ctx: EngineCtx, settings: RepoSettings, ticket: TicketRow): boolean {
  if (ticket.pr_url === null) return false;
  return prBaseOf(ctx.store.tickets(ticket.project_id), ticket, settings.base) !== (ticket.pr_base ?? settings.base);
}

/** A restack that brought the branch up to date: the ticket as it is now, what it took, and whether it merged something and ran the checks on it, false when the head had it all already. */
type Restacked = { ticket: TicketRow; what: string; checked: boolean };

/**
 * Brings a stacked ticket's branch up to date before Loom pushes it: builds the commit it must take, merges that into the
 * ticket's head on the project's checkout, keeps the merge as a MergeStep, and only then puts it in the worker's worktree
 * and runs the ticket's checks on it, with no new review, so a merge whose answer got lost is finished on the next run. A
 * worker on another machine gets the merge as linear commits (restackOnMachine). Returns the ticket as it is now and what
 * it took; "skipped" when its dependencies conflict with each other, so it is pushed as it is; null when the ticket went
 * back to its worker, or to the queue when the worker is gone.
 */
async function restack(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, need: Restack, checkout: RepoCheckout, text: PrText): Promise<Restacked | "skipped" | null> {
  const { store } = ctx;
  const { hostId, path: repo, settings } = checkout;
  const takesBase = need.withBase || need.baseTip !== undefined;
  const what = andList([...Object.keys(need.deps).map((key) => `${key}'s pull request`), ...(takesBase ? [`${settings.remote}/${settings.base}`] : [])]);
  const worker = workerOf(store, ticket);
  if (worker.standing !== "active") {
    await sendBack(ctx, ticket.id, { post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and its worker is gone, so a new worker takes it.`, data: { outcome: "restack_waits" } }, text: { summary: "", detail: "" }, countFailure: false, reason: "the worker is gone" });
    return null;
  }
  const environment = await resolveEnvironment(ctx, worker.row);
  if (environment?.path == null) throw new Unavailable(`${ticket.key}'s worker has no worktree, so Loom cannot bring its branch up to date with ${what}. Resume once bb shows the worktree again.`);
  const branch = stackBranch(project.slug, ticket.key);
  const built = await ctx.host.call(hostId, "stackBase", {
    repo,
    branch,
    commits: need.baseTip === undefined ? need.commits : [...need.commits, need.baseTip],
    ...(need.withBase && need.baseTip === undefined ? { base: { remote: settings.remote, branch: settings.base } } : {}),
    message: `Loom: ${what} for ${ticket.key}`,
    ...gitNetwork(settings),
  });
  if (built.outcome === "unavailable") throw unavailableOf(built);
  const known = stackOf(ticket) ?? EMPTY_STACK;
  if (built.outcome === "conflict") {
    store.tx(() => {
      store.updateTicket(ticket.id, { stack_json: JSON.stringify({ ...known, conflict: { on: need.deps, files: built.files } } satisfies Stack) });
      addMergePost(ctx, ticket, { body: `Loom cannot bring ${ticket.key} up to date: ${what} conflict with each other in ${built.files.join(", ")}. It stays as it is until one of them changes.`, data: { outcome: "restack_conflict", files: built.files } });
    });
    store.changed(project.id);
    return "skipped";
  }
  const { conflict: _gone, ...rest } = known;
  const stack: Stack = { ...rest, deps: need.deps, base: built.sha, synced: takesBase ? ctx.now() : known.synced };
  if (isRemote(project, environment)) return restackOnMachine(ctx, { project, spec, ticket, what, checkout, text, environment: { ...environment, path: environment.path }, built: built.sha, stack });

  const merged = await ctx.host.call(hostId, "mergeOnto", { repo, head: ticket.head_sha!, ref: built.sha, message: `Merge ${what} into ${ticket.key} (Loom)`, refs: [] });
  if (merged.outcome === "conflict") {
    await sendBack(ctx, ticket.id, {
      post: { kind: "merge", body: `Merging ${what} into ${ticket.key}'s branch conflicted in: ${merged.files.join(", ")}.`, data: { outcome: "conflict", files: merged.files, restack: true } },
      text: withRestoredNote(restackConflictText(ticket.key, what, branch, merged.files), restoredSinceSubmit(store.posts(ticket.id))),
      countFailure: false,
      reason: "bringing the branch up to date conflicted",
    });
    return null;
  }
  if (merged.already) {
    store.updateTicket(ticket.id, { stack_json: JSON.stringify(stack) });
    return { ticket: store.ticket(ticket.id)!, what, checked: false };
  }
  const step: MergeStep = { kind: "restack", from: ticket.head_sha!, sha: merged.sha, tree: null, remote: false, what, checkBase: built.sha, stack, refs: [], data: { deps: need.deps, base: built.tip ?? need.baseTip ?? null } };
  const finished = await startStep(ctx, project, spec, ticket, step, checkout, text);
  return finished === null ? null : { ticket: finished, what, checked: true };
}

/**
 * restack for a worker on another machine, where a merge commit must never go: merges on the project's checkout with
 * merge-tree, carries the result into the worker's worktree as linear commits, replacing the reviewed work there, which
 * the checkout keeps, and runs the checks there, as a MergeStep. A conflict is carried in with its markers and goes back
 * to the worker; so does a worktree that holds other work than the reviewed one, which Loom leaves alone.
 */
async function restackOnMachine(
  ctx: EngineCtx,
  a: { project: ProjectRow; spec: Spec; ticket: TicketRow; what: string; checkout: RepoCheckout; text: PrText; environment: EnvironmentInfo & { path: string }; built: string; stack: Stack },
): Promise<Restacked | null> {
  const { store } = ctx;
  const { project, spec, ticket, what, environment, stack } = a;
  const refs = [`refs/heads/${homeBranch(project.slug, ticket.key)}`, reviewedRef(project.slug, ticket.key)];
  const merged = await ctx.host.call(a.checkout.hostId, "mergeOnto", { repo: a.checkout.path, head: ticket.head_sha!, ref: a.built, message: `Merge ${what} into ${ticket.key} (Loom)`, refs });
  if (merged.outcome === "merged" && merged.already) {
    store.updateTicket(ticket.id, { stack_json: JSON.stringify(stack) });
    return { ticket: store.ticket(ticket.id)!, what, checked: false };
  }
  if (merged.outcome === "conflict") {
    const carried: Stack = { ...stack, markers: merged.files };
    if (!(await carryOrRefuse(ctx, project, spec, { ...ticket, stack_json: JSON.stringify(carried) }, merged.sha, environment, what))) return null;
    store.updateTicket(ticket.id, { stack_json: JSON.stringify(carried) });
    await sendBack(ctx, ticket.id, {
      post: { kind: "merge", body: `Merging ${what} into ${ticket.key}'s branch conflicted in: ${merged.files.join(", ")}. Loom put the result, with conflict markers, in the worker's worktree.`, data: { outcome: "conflict", files: merged.files, restack: true } },
      text: restackMarkersText(ticket.key, what, merged.files),
      countFailure: false,
      reason: "bringing the branch up to date conflicted",
    });
    return null;
  }
  const step: MergeStep = { kind: "restack", from: ticket.head_sha!, sha: merged.sha, tree: merged.tree, remote: true, what, checkBase: freshBaseOf(spec, ticket.repo), stack, refs: [], data: { deps: stack.deps, base: a.built } };
  const finished = await startStep(ctx, project, spec, ticket, step, a.checkout, a.text);
  return finished === null ? null : { ticket: finished, what, checked: true };
}

/**
 * Carries a merge into the worktree of a worker on another machine, as the head it replaces there. A worktree that holds
 * other work, or a merge of the worker's own that is not finished, goes back to the worker untouched, and false is
 * returned; a failure worth waiting out throws, for the merge to run again.
 */
async function carryOrRefuse(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, sha: string, environment: EnvironmentInfo & { path: string }, what: string): Promise<boolean> {
  try {
    await carryTo(ctx, project, spec, ticket, sha, environment, ticket.head_tree === null ? {} : { replaces: ticket.head_tree });
    return true;
  } catch (error) {
    if (waitableOf(error) !== null) throw error;
    ctx.store.updateTicket(ticket.id, { merge_step_json: null });
    await sendBack(ctx, ticket.id, {
      post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and Loom could not put it in the worker's worktree: ${errText(error)}`, data: { outcome: "restack_waits" } },
      text: restackRefusedText(ticket.key, what, errText(error)),
      countFailure: false,
      reason: "the worker's worktree holds work Loom has not seen",
    });
    return false;
  }
}

/**
 * MergeStep: a merge Loom put in, or is putting in, the ticket's worker's worktree to bring its branch up to date (a
 * restack) or to take commits someone else pushed to its pull request branch (a tip), with the checks that must pass on
 * it before it becomes the ticket's head. It is kept on the ticket until they finish, so a run of the merge after a
 * failure worth waiting out, a pause or a restart finishes the same merge instead of merging again from the older head,
 * and nothing is pushed or accounted for before its checks pass; then, checked, until Loom pushes it.
 */
interface MergeStep {
  kind: "restack" | "tip";
  /** The ticket's head when Loom merged; the step holds only while head_sha is still this. */
  from: string;
  sha: string;
  /** The merge's tree, which a worker on another machine is checked by; null for a merge made in a worker's own worktree. */
  tree: string | null;
  /** The worker is on another machine, which gets the merge as linear commits. */
  remote: boolean;
  /** What the merge took, for the posts and the message of the commit Loom pushes. */
  what: string;
  /** What the checks measure the worktree against. */
  checkBase: string;
  /** A restack's stack: what the ticket's branch is built on once the merge is in. */
  stack?: Stack;
  /** A tip's pull request branch tip, which Loom accounts for as pushed once the worker's worktree builds on it. */
  tip?: string;
  /** Refs on the checkout to point at the merge once it is in the worktree. */
  refs: string[];
  /** The restacked post's data, besides the sha and the runs. */
  data: Record<string, unknown>;
  /** Its checks passed and it is the ticket's head; it stays until Loom pushes it, so a push that failed is made on the next run. */
  checked?: boolean;
}

function stepOf(ticket: TicketRow): MergeStep | null {
  const step = ticket.merge_step_json === null ? null : (JSON.parse(ticket.merge_step_json) as MergeStep);
  return step !== null && step.from === ticket.head_sha ? step : null;
}

async function startStep(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, step: MergeStep, checkout: RepoCheckout, text: PrText): Promise<TicketRow | null> {
  ctx.store.updateTicket(ticket.id, { merge_step_json: JSON.stringify(step) });
  return finishStep(ctx, project, spec, ctx.store.ticket(ticket.id)!, step, checkout, text);
}

/**
 * Puts a step's merge in the worker's worktree, when it is not there yet, points its refs at it and runs the ticket's
 * checks on it, with no new review. Their passing makes it the ticket's head, and for a tip makes the tip the commit Loom
 * accounts for; a failed check, or a worktree that holds other work or a merge of the worker's own that is not finished,
 * ends the step and goes back to the worker. A failure worth waiting out throws and keeps the step. Returns the ticket as
 * it is now; null when it went back to its worker, or to the queue when the worker is gone.
 */
async function finishStep(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, step: MergeStep, checkout: RepoCheckout, text: PrText): Promise<TicketRow | null> {
  const { store } = ctx;
  if (step.checked === true) return store.ticket(ticket.id)!;
  const { what } = step;
  const worker = workerOf(store, ticket);
  const back = async (a: Parameters<typeof sendBack>[2], patch: Partial<TicketRow> = {}) => {
    store.updateTicket(ticket.id, { merge_step_json: null, ...patch });
    await sendBack(ctx, ticket.id, a);
    return null;
  };
  if (worker.standing !== "active") {
    return back({ post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and its worker is gone, so a new worker takes it.`, data: { outcome: "restack_waits" } }, text: { summary: "", detail: "" }, countFailure: false, reason: "the worker is gone" });
  }
  const found = await resolveEnvironment(ctx, worker.row);
  if (found?.path == null) throw new Unavailable(`${ticket.key}'s worker has no worktree, so Loom cannot bring its branch up to date with ${what}. Resume once bb shows the worktree again.`);
  const environment = { ...found, path: found.path };

  if (step.remote) {
    const carried = step.stack === undefined ? ticket : { ...ticket, stack_json: JSON.stringify(step.stack) };
    if (!(await carryOrRefuse(ctx, project, spec, carried, step.sha, environment, what))) return null;
  } else {
    const state = await ctx.host.call(environment.hostId, "worktreeState", { worktree: environment.path, base: step.checkBase });
    if (state.unfinishedMerge === true) {
      return back({
        post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and the worker's worktree has a merge the worker has not finished, so Loom left it as it is.`, data: { outcome: "unfinished" } },
        text: unfinishedMergeText(ticket.key, what),
        countFailure: false,
        reason: "the worker's worktree has a merge it has not finished",
      });
    }
    // The worktree has the merge already, or still the head it was made from; anything else is work Loom has not seen.
    const placed = state.head === step.sha && !state.dirty;
    if (!placed && (state.head !== step.from || state.dirty)) {
      const why = state.dirty ? "it has uncommitted changes" : `its HEAD is ${state.head.slice(0, 12)}, not the approved ${step.from.slice(0, 12)}`;
      return back({ post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and Loom left the worker's worktree as it is: ${why}.`, data: { outcome: "restack_waits" } }, text: restackRefusedText(ticket.key, what, why), countFailure: false, reason: "the worker's worktree holds work Loom has not seen" });
    }
    if (!placed) await ctx.host.call(environment.hostId, "resetHard", { worktree: environment.path, sha: step.sha });
  }
  if (step.refs.length > 0) await ctx.host.call(checkout.hostId, "pointRefs", { repo: checkout.path, sha: step.sha, refs: step.refs });

  const { runs, failure } = await checksOnMerge(ctx, { spec, ticket, settings: checkout.settings, environment, base: step.checkBase, expect: step.remote ? { tree: step.tree! } : { head: step.sha } });
  // The worktree of a worker on another machine builds on the tip now, so the next merge of the branch uses it as its base.
  const accounted = step.tip !== undefined && step.remote ? { pushed_sha: step.tip, pushed_at: ctx.now() } : {};
  const stacked = step.stack === undefined ? {} : { stack_json: JSON.stringify(step.stack) };
  if (failure !== null) {
    // A worktree bb restored since the worker last ran has none of the files git ignores, so its first failed check counts no failure.
    const restored = !step.remote && restoredSinceSubmit(store.posts(ticket.id));
    const reason = step.kind === "tip" ? "the checks failed after merging the pull request branch's new commits" : "the checks failed after bringing the branch up to date";
    return back({ post: afterMergePost(failure.run, `${ticket.key}'s branch`, failure.changed), text: withRestoredNote(restackFailedText(ticket.key, what, failure.run, failure.changed), restored), countFailure: !restored, reason }, { ...accounted, ...stacked });
  }
  const passed = runs.length === 0 ? "" : `; its checks passed (${plural(runs.length, "command")})`;
  const where = step.remote ? " on the project's machine, and carried it to the worker's" : "";
  const took = step.tip === undefined ? what : `${what} (${step.tip.slice(0, 12)})`;
  store.tx(() => {
    store.updateTicket(ticket.id, {
      head_sha: step.sha,
      head_tree: step.remote ? step.tree : null,
      merge_step_json: JSON.stringify({ ...step, from: step.sha, checked: true } satisfies MergeStep),
      ...accounted,
      ...stacked,
      ...(text.by === "worker" ? { pr_text_json: JSON.stringify({ ...text, head: step.sha } satisfies PrText) } : {}),
    });
    addMergePost(ctx, ticket, { body: `Merged ${took} into ${ticket.key}'s branch as ${step.sha.slice(0, 12)}${where}${passed}.`, data: { outcome: "restacked", sha: step.sha, ...step.data, runs: runs.map(({ command, exitCode, timedOut, durationMs }) => ({ command, exitCode, timedOut, durationMs })) } });
  });
  store.changed(project.id);
  return store.ticket(ticket.id)!;
}

/** How often one push merges the pull request branch's new commits before it gives up, when the branch keeps moving meanwhile. */
const TIP_TAKES = 3;

/**
 * Merges the commits someone else pushed to a ticket's pull request branch into its head before Loom pushes, with the
 * commit Loom last pushed there as the merge base, and runs the ticket's checks on the result in the worker's worktree,
 * with no new review, as a restack does, as a MergeStep. On the checkout's machine the worktree's branch moves to the merge; a worker on
 * another machine gets it as linear commits, and the checkout keeps the merge. A stacked ticket whose branch got base
 * branch commits that the commit it is stacked on lacks takes the base branch first. Returns the ticket as it is now;
 * null when it went back to its worker, or to the queue when the worker is gone.
 */
async function takeAtPush(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, checkout: RepoCheckout, text: PrText): Promise<TicketRow | null> {
  const { store } = ctx;
  const { hostId, path: repo, settings } = checkout;
  const what = TIP_WHAT;
  const worker = workerOf(store, ticket);
  if (worker.standing !== "active") {
    await sendBack(ctx, ticket.id, { post: { kind: "merge", body: `${ticket.key} must take ${what} before Loom pushes it, and its worker is gone, so a new worker takes it.`, data: { outcome: "restack_waits" } }, text: { summary: "", detail: "" }, countFailure: false, reason: "the worker is gone" });
    return null;
  }
  const found = await resolveEnvironment(ctx, worker.row);
  if (found?.path == null) throw new Unavailable(`${ticket.key}'s worker has no worktree, so Loom cannot merge ${what} into its branch. Resume once bb shows the worktree again.`);
  const environment = { ...found, path: found.path };
  let tip: Tip | null;
  try {
    tip = await readTip(ctx, project, checkout, ticket);
  } catch (error) {
    throw new Unavailable(`Reading ${ticket.key}'s pull request branch stopped: ${errText(error)}`, waitableOf(error));
  }
  if (tip === null) throw new Unavailable(`${ticket.key}'s pull request branch is gone from ${settings.remote}, so Loom cannot push to it. Requeue the ticket for a new pull request, or cancel it.`);

  let current = ticket;
  if (stacking(spec) && (await tipOutgrowsStack(ctx, checkout, current, tip))) {
    const result = await restack(ctx, project, spec, current, restackWithBase(store.tickets(project.id), current), checkout, text);
    if (result === null) return null;
    if (result !== "skipped") current = result.ticket;
  }
  if (!(await isForeign(ctx, checkout, current, tip))) return current;

  const merged = await ctx.host.call(hostId, "mergeOnto", {
    repo,
    head: current.head_sha!,
    ref: tip.sha,
    ...(current.pushed_sha === null ? {} : { base: current.pushed_sha }),
    message: `Merge ${what} into ${current.key} (Loom)`,
    refs: [],
  });
  if (merged.outcome === "merged" && merged.already) return current;
  const remote = isRemote(project, environment);
  const home = `refs/heads/${homeBranch(project.slug, current.key)}`;

  if (merged.outcome === "conflict" && !remote) {
    await sendBack(ctx, current.id, {
      post: { kind: "merge", body: `Merging ${what} into ${current.key}'s branch conflicted in: ${merged.files.join(", ")}.`, data: { outcome: "conflict", files: merged.files, tip: tip.sha } },
      text: withRestoredNote(restackConflictText(current.key, what, tipRef(project.slug, current.key), merged.files), restoredSinceSubmit(store.posts(current.id))),
      countFailure: false,
      reason: "merging the pull request branch's new commits conflicted",
    });
    return null;
  }
  if (merged.outcome === "conflict") {
    const carried = { ...current, stack_json: JSON.stringify(withMarkers(current, merged.files)) };
    if (!(await carryOrRefuse(ctx, project, spec, carried, merged.sha, environment, what))) return null;
    await ctx.host.call(hostId, "pointRefs", { repo, sha: merged.sha, refs: [home] });
    // The worktree builds on the tip now, so the next merge of the branch uses it as its base. Recorded only here, with the
    // markers, once nothing can fail before the ticket goes back to the worker.
    store.updateTicket(current.id, { pushed_sha: tip.sha, pushed_at: ctx.now(), stack_json: carried.stack_json });
    await sendBack(ctx, current.id, {
      post: { kind: "merge", body: `Merging ${what} into ${current.key}'s branch conflicted in: ${merged.files.join(", ")}. Loom put the result, with conflict markers, in the worker's worktree.`, data: { outcome: "conflict", files: merged.files, tip: tip.sha } },
      text: restackMarkersText(current.key, what, merged.files),
      countFailure: false,
      reason: "merging the pull request branch's new commits conflicted",
    });
    return null;
  }
  const step: MergeStep = {
    kind: "tip",
    from: current.head_sha!,
    sha: merged.sha,
    tree: remote ? merged.tree : null,
    remote,
    what,
    checkBase: remote ? freshBaseOf(spec, current.repo) : baseOf(spec, current),
    tip: tip.sha,
    refs: remote ? [home, reviewedRef(project.slug, current.key)] : [],
    data: { tip: tip.sha },
  };
  return startStep(ctx, project, spec, current, step, checkout, text);
}

/**
 * Runs the ticket's checks in its worker's worktree on a merge Loom put there, with no new review, and returns the first
 * that failed, or passed but changed the worktree; null when all passed. The worktree must still have the merge: HEAD's
 * id on the checkout's machine, its tree on another, which may give a carried commit a new id.
 */
async function checksOnMerge(
  ctx: EngineCtx,
  a: { spec: Spec; ticket: TicketRow; settings: RepoSettings; environment: EnvironmentInfo & { path: string }; base: string; expect: { head: string } | { tree: string } },
): Promise<{ runs: CheckRun[]; failure: { run: CheckRun; changed?: string } | null }> {
  const { environment } = a;
  const commands = [...(JSON.parse(a.ticket.verify_json) as string[]), ...a.settings.checks];
  const runs: CheckRun[] = [];
  for (const command of commands) {
    const result = await ctx.host.call(environment.hostId, "exec", { cwd: environment.path, command, timeoutMs: a.spec.checks.timeout_minutes * 60_000 });
    const run: CheckRun = { command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, output: result.output };
    runs.push(run);
    if (result.exitCode !== 0 || result.timedOut) return { runs, failure: { run } };
    const after = await ctx.host.call(environment.hostId, "worktreeState", { worktree: environment.path, base: a.base, trackedOnly: true });
    const moved =
      "head" in a.expect
        ? after.head === a.expect.head
          ? []
          : [`moved HEAD from ${a.expect.head.slice(0, 12)} to ${after.head.slice(0, 12)}`]
        : after.tree === a.expect.tree
          ? []
          : [`changed HEAD's tree from ${a.expect.tree.slice(0, 12)} to ${after.tree.slice(0, 12)}`];
    const changes = [...moved, ...(after.dirty ? ["left tracked files modified"] : [])];
    if (changes.length > 0) return { runs, failure: { run, changed: changes.join(" and ") } };
  }
  return { runs, failure: null };
}

/** What a retarget did: its post, and whether the pull request moved; false when the post asks the human to move it. */
type Retargeted = { post: MergePost; moved: boolean };

/**
 * Moves an open pull request to the branch it now builds on: through gh, or a command forge's retarget command. A failure
 * worth waiting out throws, for the merge to run again. Any other failure of the retarget command asks the human to move
 * it, since the push already stands; gh's pauses the project, as opening a pull request does. On a forge Loom cannot move
 * it through, the post asks the human to.
 */
async function retarget(ctx: EngineCtx, a: { hostId: string; repo: string; settings: RepoSettings; ticket: TicketRow; base: string }): Promise<Retargeted> {
  const url = a.ticket.pr_url!;
  const { forge } = a.settings;
  const command = forge.kind === "command" ? forge.retarget : undefined;
  if (forge.kind !== "gh" && command === undefined) {
    return { moved: false, post: { kind: "merge", body: `The pull request ${url} now builds on ${a.base}. Loom cannot change its base through this forge, so change it to ${a.base} by hand.`, data: { outcome: "retarget_by_hand", url, base: a.base } } };
  }
  const moved = await ctx.host.call(a.hostId, "prRetarget", { repo: a.repo, url, base: a.base, forge: command === undefined ? { kind: "gh" } : { kind: "command", retarget: command } });
  if (moved.outcome === "ok") return { moved: true, post: { kind: "merge", body: `Moved the pull request ${url} to ${a.base}.`, data: { outcome: "retargeted", url, base: a.base } } };
  if (command === undefined || moved.transient !== undefined) throw unavailableOf(moved, `Moving ${a.ticket.key}'s pull request to ${a.base} stopped: ${moved.message}`);
  return {
    moved: false,
    post: {
      kind: "merge",
      body: `The pull request ${url} now builds on ${a.base}, but the retarget command \`${command}\` did not move it: ${moved.message}\n\nChange its base to ${a.base} by hand.`,
      data: { outcome: "retarget_failed", url, base: a.base },
    },
  };
}

/**
 * After a fix round's push, asks the people whose reviews and review threads the round answered to review the pull
 * request again, and returns the post that says so. Only through gh. A failure is posted and blocks nothing: the fix is pushed.
 */
async function askForReviews(ctx: EngineCtx, a: { hostId: string; repo: string; settings: RepoSettings; ticket: TicketRow }): Promise<MergePost | null> {
  const url = a.ticket.pr_url;
  if (a.settings.forge.kind !== "gh" || url === null) return null;
  const reviewers = reviewersToAsk(ctx.store.posts(a.ticket.id)).slice(0, 20);
  if (reviewers.length === 0) return null;
  // A host from before this call refuses it; that is one more failure to post.
  const asked: HostOutputOf<"prRequestReview"> = await ctx.host
    .call(a.hostId, "prRequestReview", { repo: a.repo, url, reviewers })
    .catch((error: unknown) => ({ outcome: "unavailable" as const, message: errText(error) }));
  const requested = asked.outcome === "ok" ? asked.requested : [];
  const failed = asked.outcome === "ok" ? asked.failed : reviewers.map((login) => ({ login, message: asked.message }));
  const lines =
    asked.outcome === "ok"
      ? [...(requested.length > 0 ? [`Asked ${andList(requested)} to review the pull request again.`] : []), ...failed.map((miss) => `Loom could not ask ${miss.login} to review it again: ${miss.message}`)]
      : [`Loom could not ask ${andList(reviewers)} to review the pull request again: ${asked.message}`];
  const data = { outcome: requested.length > 0 ? "review_requested" : "review_request_failed", url, round: a.ticket.pr_rounds, requested, failed };
  return { kind: "merge", body: lines.join("\n\n"), data };
}

/** merging to pr_open, with what Loom pushed and its posts, in one transaction; a checked MergeStep is pushed now. */
function toPrOpen(ctx: EngineCtx, ticketId: number, patch: Partial<TicketRow>, post: MergePost | null | MergePost[], data: object): void {
  const { store } = ctx;
  const posts = post === null ? [] : Array.isArray(post) ? post : [post];
  store.tx(() => {
    const ticket = store.ticket(ticketId)!;
    store.setTicketState(ticketId, "pr_open", LOOM_ACTOR, data);
    store.updateTicket(ticketId, { ...patch, merge_step_json: null });
    for (const each of posts) store.addPost({ project_id: ticket.project_id, ticket_id: ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: each.kind, body: each.body, data_json: JSON.stringify(each.data) });
  });
  store.changed(store.ticket(ticketId)!.project_id);
}

/** A pull request closed without merging blocks its ticket and ends its threads; a requeue opens a new one. */
async function blockClosed(ctx: EngineCtx, ticket: TicketRow): Promise<void> {
  await blockPullRequest(ctx, ticket, "the pull request was closed without merging", null);
}

/** What Loom lets go of with a closed stacked pull request: the pull request, and what it read of it. The branch and the commit Loom pushed there stay, for the next one. */
const reopenReset = { pr_url: null, pr_base: null, pr_meta_json: null, pr_status_json: null, pr_seen_json: "[]", pr_ask_json: null, pr_poll_json: null, handback_json: null } as const;

/**
 * The PrApplied a replacement pull request opens with: the text the old one was to end up with (targetText), the approved
 * edit still waiting if there is one. The old pull request's edit and retry state, and its Rollout record, stay behind.
 */
function keptText(ctx: EngineCtx, ticket: TicketRow): string {
  const text = targetText(ctx, ticket);
  return JSON.stringify({ title: text.title, body: text.body, live: [], at: ctx.now() } satisfies PrApplied);
}

/**
 * A pull request read as closed, by a poll or before a push. One Loom opened on another ticket's branch, which the forge
 * closed because that branch went away, as when the pull request it was stacked on merged and its branch was deleted,
 * does not block: Loom lets go of it, posts why, and the ticket stays open with no pull request, for the merge queue to
 * bring its branch up to date and open a new one on the branch it builds on now (prBaseOf). True when Loom let go of it;
 * the ticket is then where it was, in pr_open or still merging. Any other closed pull request blocks the ticket, since a
 * person closed it. While a ticket that is not done still owns the gone branch, its own read settles first, and this
 * ticket waits in pr_open for its next read. A failed read of the remote throws, as a failed host step does.
 */
async function closedPullRequest(ctx: EngineCtx, project: ProjectRow, ticket: TicketRow, target: string | null): Promise<boolean> {
  const { store } = ctx;
  const spec = specOf(store, project);
  const settings = repoSettings(spec, ticket.repo);
  const { remote, base } = settings;
  const branch = ticket.pr_base;
  if (!stacking(spec) || branch === null || branch === base || (target !== null && target !== branch)) {
    await blockClosed(ctx, ticket);
    return false;
  }
  const owner = store.tickets(project.id).find((other) => other.id !== ticket.id && other.repo === ticket.repo && other.pr_branch === branch) ?? null;
  if (owner?.state !== "done") {
    const checkout = await checkoutIn(ctx, project, spec, ticket.repo);
    const read = await ctx.host.call(checkout.hostId, "remoteBranch", { repo: checkout.path, remote, branch });
    if (read.outcome === "unavailable") throw unavailableOf(read, `Reading whether ${branch} is still on ${remote} stopped: ${read.message}`);
    if (read.sha !== null) {
      await blockClosed(ctx, ticket);
      return false;
    }
    if (owner !== null && owner.state !== "cancelled") {
      if (ticket.state === "merging") toPrOpen(ctx, ticket.id, {}, null, { url: ticket.pr_url, waits: owner.key });
      return false;
    }
  }
  const why = owner?.state === "done" ? `${owner.key}'s pull request, whose branch ${branch} it built on, merged` : `the branch it built on, ${branch}, left ${remote}`;
  store.tx(() => {
    const current = store.ticket(ticket.id)!;
    store.updateTicket(current.id, { ...reopenReset, pr_applied_json: keptText(ctx, current) });
    const after = store.ticket(current.id)!;
    const tickets = store.tickets(project.id);
    const hold = holdOf(tickets, after);
    const next = hold === null ? `Its new pull request opens on ${prBaseOf(tickets, after, base)}${restackOf(tickets, after) === null ? "" : ` once Loom has brought its branch up to date`}.` : holdOpens(spec, after, hold, "new ");
    addMergePost(ctx, current, {
      body: `The pull request ${ticket.pr_url} closed when ${why}. A person did not close it, so Loom let go of it instead of blocking ${current.key}, and keeps its branch. ${next}`,
      data: { outcome: "pr_let_go", url: ticket.pr_url, branch, ticket: owner?.key ?? null },
    });
  });
  store.changed(project.id);
  ctx.kick();
  return true;
}

/** A poll's closed read: closedPullRequest, with a failed read of the remote waited out or pausing the project as a failed poll would. */
async function settleClosed(ctx: EngineCtx, project: ProjectRow, settings: RepoSettings, ticket: TicketRow, target: string | null): Promise<void> {
  try {
    await closedPullRequest(ctx, project, ticket, target);
  } catch (error) {
    const message = `Reading the pull request of ${ticket.key} stopped: ${errText(error)}`;
    noteAnswer(ctx, ticket.id, message);
    if (waitableOf(error) === null) pauseProject(ctx, project.id, message);
    else waitOutServerError(ctx, ticket, errText(error), error instanceof Unavailable ? settings.remote : PROJECT_MACHINE);
  }
}

/**
 * A pull request merged into a branch other than its repo's base, such as the branch of the pull request it was stacked
 * on, did not bring its change to the base. Its ticket blocks as a closed one does, and the reason names the branch and
 * the ticket whose pull request branch it is.
 */
async function blockMergedElsewhere(ctx: EngineCtx, ticket: TicketRow, settings: RepoSettings, branch: string): Promise<void> {
  const { base } = settings;
  const owner = ctx.store.tickets(ticket.project_id).find((other) => other.id !== ticket.id && other.repo === ticket.repo && other.pr_branch === branch) ?? null;
  const into = owner === null ? `the branch ${branch}` : `${owner.key}'s branch (${branch})`;
  const next = owner !== null && owner.state !== "done" && owner.state !== "cancelled" ? `Merge ${owner.key}'s pull request first, then put this change on ${base} again.` : `Put this change on ${base} again.`;
  const reason = `Its pull request merged into ${into}, not ${base}, so its change is not on ${base}. ${next}`;
  const post: MergePost = {
    kind: "merge",
    body: `The pull request ${ticket.pr_url} merged into ${into}, not ${base}, so Loom did not complete ${ticket.key}.`,
    data: { outcome: "merged_elsewhere", url: ticket.pr_url, branch, base, ticket: owner?.key ?? null },
  };
  await blockPullRequest(ctx, ticket, reason, post);
}

// The move comes first, so nothing slips in before the threads end.
async function blockPullRequest(ctx: EngineCtx, ticket: TicketRow, reason: string, post: MergePost | null): Promise<void> {
  const { store } = ctx;
  store.tx(() => {
    const current = store.ticket(ticket.id)!;
    if (post !== null) store.addPost({ project_id: current.project_id, ticket_id: current.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: post.kind, body: post.body, data_json: JSON.stringify(post.data) });
    store.addPost({ project_id: current.project_id, ticket_id: current.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
    applyMove(ctx, current, { to: "blocked", patch: { ...released, ...closedPrReset, blocked_reason: reason } }, LOOM_ACTOR, { reason });
  });
  store.changed(ticket.project_id);
  for (const row of store.threads({ ticketId: ticket.id, states: ["active"] })) await endThread(ctx, row, "blocked", { commit: false, move: null });
}

const openForge = (forge: ForgeSpec): HostInput<"prCreate">["forge"] => (forge.kind === "command" ? { kind: "command", open: forge.open! } : { kind: "gh" });
const stateForge = (forge: ForgeSpec): HostInput<"prState">["forge"] => (forge.kind === "command" ? { kind: "command", state: forge.state! } : { kind: "gh" });

/** A forge hook's run: where, for which pull request and ticket, and the branches its LOOM_HEAD and LOOM_BASE name. */
type HookArgs = { hostId: string; repo: string; settings: RepoSettings; head: string; base: string; url: string; projectId: number; ticketId: number | null };

/** Runs the forge's after_open commands once a pull request is open; LOOM_BASE is the branch it opened on. */
async function afterOpen(ctx: EngineCtx, a: HookArgs): Promise<void> {
  await forgeHooks(ctx, a, "after_open", a.settings.forge.after_open ?? [], {});
}

/** What an after_push run was for, as its event records it. */
type PushRun = { sha?: string; url?: string; base?: string; pushed?: boolean; moved?: boolean };

/**
 * Runs the forge's after_push commands once Loom pushed to an open pull request, such as a fix round's, a catch-up's or a
 * land's, or moved one to another base (`moved`), such as to start its CI again or mark it ready; LOOM_BASE is the branch
 * it builds on now. A push and a move in one step run them once. They run at most once per push and once per move: the
 * event recorded before the commands run says what they ran for, so a merge that runs again after a failure, and pushes
 * the same commit or moves the pull request to the same base again, runs none for what they already ran for. With
 * neither a new push nor a move, nothing runs.
 */
export async function afterPush(ctx: EngineCtx, a: HookArgs & { sha: string; pushed: boolean; moved: boolean }): Promise<void> {
  const commands = a.settings.forge.after_push ?? [];
  if (commands.length === 0) return;
  const kind = a.ticketId === null ? "project.after_push" : "ticket.after_push";
  const events = a.ticketId === null ? ctx.store.projectEvents(a.projectId).filter((event) => event.kind === kind) : ctx.store.ticketEvents(a.ticketId, [kind]);
  const runs = events.map((event) => JSON.parse(event.data_json) as PushRun).filter((run) => run.url === a.url && run.sha === a.sha);
  const pushed = a.pushed && !runs.some((run) => run.pushed !== false);
  const moved = a.moved && !runs.some((run) => run.moved === true && run.base === a.base);
  if (!pushed && !moved) return;
  ctx.store.event(a.projectId, a.ticketId, kind, LOOM_ACTOR, { sha: a.sha, url: a.url, branch: a.head, base: a.base, pushed, moved } satisfies PushRun & { branch: string });
  await forgeHooks(ctx, a, "after_push", commands, { LOOM_SHA: a.sha }, pushed);
}

/**
 * Runs a forge's after_open or after_push commands. A failure is posted and blocks nothing: the pull request stays as it
 * is, and no command runs again, since a second run could repeat what the first did, such as starting CI. A host call
 * that got no answer stops the rest, which would not get one either, in the same post.
 */
async function forgeHooks(ctx: EngineCtx, a: HookArgs, hook: "after_open" | "after_push", commands: readonly string[], more: Record<string, string>, pushed = false): Promise<void> {
  for (const [index, command] of commands.entries()) {
    let problem: string | null;
    let rest: string[] = [];
    try {
      const env = { LOOM_URL: a.url, LOOM_PR_NUMBER: prNumber(a.url), LOOM_HEAD: a.head, LOOM_BASE: a.base, ...more };
      const result = await ctx.host.call(a.hostId, "exec", { cwd: a.repo, command, timeoutMs: AFTER_OPEN_MS, env });
      const output = result.output.trim() === "" ? "" : `\n\n${clip(result.output.slice(-2000), 2000)}`;
      problem = result.timedOut ? `timed out after ${AFTER_OPEN_MS / 60_000} minutes${output}` : result.exitCode !== 0 ? `failed (exit ${result.exitCode})${output}` : null;
    } catch (error) {
      if (hostCallTransient(error) === null) problem = `could not run: ${errText(error)}`;
      else {
        rest = commands.slice(index + 1);
        problem = `got no answer from the project's machine, so Loom cannot tell whether it ran, and does not run it again: ${errText(error)}`;
      }
    }
    if (problem === null) continue;
    const skipped = rest.length === 0 ? "" : ` Loom did not run ${andList(rest.map((each) => `\`${each}\``))} after it either.`;
    const state = hook === "after_open" ? "is open" : pushed ? "has the push" : `builds on ${a.base}`;
    const body = `The ${hook} command \`${command}\` ${problem}${skipped}\n\nThe pull request ${a.url} ${state}; nothing else changed.`;
    const data = { outcome: `${hook}_failed`, command, url: a.url };
    // A land's pull request belongs to no ticket, so its failure is an event and a log line instead of a post.
    if (a.ticketId === null) {
      ctx.store.event(a.projectId, null, `project.${hook}_failed`, LOOM_ACTOR, data);
      ctx.bb.log("warn", body);
    } else {
      ctx.store.addPost({ project_id: a.projectId, ticket_id: a.ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "merge", body, data_json: JSON.stringify(data) });
    }
    ctx.store.changed(a.projectId);
    if (rest.length > 0) return;
  }
}

// ---------------------------------------------------------------- pull requests

type Feedback = Extract<HostOutputOf<"prFeedback">, { outcome: "ok" }>;

/**
 * One read of a pull request: its state, the PrMeta fields Loom stores (null for the push-only forge, which has no pull
 * request), and its feedback when Loom follows it; or why it failed, with `transient` for a forge failure worth waiting out.
 */
type PrRead =
  | { outcome: "ok"; state: "OPEN" | "MERGED" | "CLOSED"; meta: Pick<PrMeta, "draft" | "review" | "base" | "mergeable"> | null; feedback: Feedback | null; text?: PrTextRead }
  | { outcome: "unavailable"; message: string; transient?: "server" | "rate_limit" | "network"; retryAfterMs?: number };

/** The title and description a read gave; null when it gave neither, as a state command or a host from before Loom read them. */
type PrTextRead = { title: string | null; body: string | null } | null;
const textRead = (read: { title?: string | null; body?: string | null }): PrTextRead => (read.title === undefined && read.body === undefined ? null : { title: read.title ?? null, body: read.body ?? null });

/** The due GitHub pull requests of one repository, with the checkout gh runs in; `forgeHost` keys the host's backoff. */
interface Batch {
  checkout: RepoCheckout;
  host: string;
  forgeHost: string;
  owner: string;
  name: string;
  tickets: Array<{ id: number; number: number }>;
}

/**
 * Reads every open pull request whose next read is due, every 5 minutes unless it waits longer: merged completes the
 * ticket, closed blocks it, and so does one merged into a branch other than its repo's base. GitHub's are read PR_BATCH_MAX
 * at a time in one call per repository; a command forge's and the push-only forge's one at a time. Each due ticket gets
 * one read, never repeated in the same poll. A server error or timeout makes each ticket it read wait longer and pauses
 * the project only after an hour of them; a network failure or a rate limit stops every read to that forge host, in this
 * poll and every project's, for a while (forge-waits.ts). A command forge's host is its pull request URL's. Any other
 * failure pauses the project. A pull request the human synced (pr-sync.ts) is due now, whatever its own wait says.
 */
export async function pollPullRequests(ctx: EngineCtx, project: ProjectRow): Promise<void> {
  const { store } = ctx;
  const spec = specOf(store, project);
  const forgeOf = (ticket: TicketRow) => repoSettings(spec, ticket.repo).forge;
  const reads = forgetClosedReads(ctx, project.id);
  const due = store.tickets(project.id, ["pr_open"]).filter((ticket) => (ticket.pr_url !== null || forgeOf(ticket).kind === "none") && (ticket.pr_checked_at === null || ctx.now() >= nextPollAt(ticket)! || reads.asked.has(ticket.id)));
  if (due.length === 0) return;
  const synced = due.some((ticket) => reads.asked.has(ticket.id));
  try {
    await readDue(ctx, project, spec, due);
  } finally {
    for (const ticket of due) reads.out.delete(ticket.id);
    // A read that found nothing new writes no event, so the page that asked for it is told here.
    if (synced) store.changed(project.id);
  }
}

/** The read is going out: the ticket is not due again until its next wait, and a sync of it is answered by this read. */
function markRead(ctx: EngineCtx, ticketId: number): void {
  ctx.store.updateTicket(ticketId, { pr_checked_at: ctx.now() });
  readGoesOut(ctx, ticketId);
}

async function readDue(ctx: EngineCtx, project: ProjectRow, spec: Spec, due: TicketRow[]): Promise<void> {
  const { store } = ctx;
  const forgeOf = (ticket: TicketRow) => repoSettings(spec, ticket.repo).forge;
  const follows = prSettings(spec).maxFixRounds > 0;
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
  const batches = new Map<string, Batch>();
  for (const seen of due) {
    const ticket = store.ticket(seen.id);
    if (ticket?.state !== "pr_open") continue;
    const forge = forgeOf(ticket);
    if (ticket.pr_url === null && forge.kind !== "none") continue;
    // Left due, so it is read in the first poll after the backoff ends.
    const host = forge.kind === "none" ? null : forgeHostOf(ticket.pr_url);
    if (backedOffUntil(ctx.forgeBackoffs, host, ctx.now()) !== null) continue;
    const checkout = await checkoutOfRepo(ticket.repo);
    if (checkout === null) continue;
    if (forge.kind === "gh") {
      const pull = githubPull(ticket.pr_url!);
      if (pull === null) {
        const message = `${ticket.key}'s pull request ${ticket.pr_url} is not a GitHub pull request URL, so gh cannot read it.`;
        markRead(ctx, ticket.id);
        noteAnswer(ctx, ticket.id, message);
        pauseProject(ctx, project.id, message);
        continue;
      }
      const key = `${host}/${pull.owner}/${pull.name}`;
      const batch = batches.get(key) ?? batches.set(key, { checkout, host: pull.host, forgeHost: host!, owner: pull.owner, name: pull.name, tickets: [] }).get(key)!;
      batch.tickets.push({ id: ticket.id, number: pull.number });
      continue;
    }
    markRead(ctx, ticket.id);
    let read: PrRead;
    try {
      read = await readOne(ctx, checkout, ticket, forge, follows);
    } catch (error) {
      const message = `Reading the pull request of ${ticket.key} stopped: ${errText(error)}`;
      noteAnswer(ctx, ticket.id, message);
      // A host call that got no answer is waited out like a server error; the project's machine, not the forge, failed.
      if (hostCallTransient(error) !== null) waitOutServerError(ctx, ticket, errText(error), PROJECT_MACHINE);
      else pauseProject(ctx, project.id, message);
      continue;
    }
    await settleRead(ctx, project, checkout.settings, ticket, read, host);
  }
  for (const batch of batches.values()) {
    for (let start = 0; start < batch.tickets.length; start += PR_BATCH_MAX) {
      // A rate limit or network failure in an earlier chunk, or another repository's, leaves the rest due for the first poll after the backoff ends.
      if (backedOffUntil(ctx.forgeBackoffs, batch.forgeHost, ctx.now()) !== null) break;
      await readBatch(ctx, project, spec, batch, batch.tickets.slice(start, start + PR_BATCH_MAX), follows);
    }
  }
  await endFinishedThreads(ctx, project.id);
}

function addWaitPost(ctx: EngineCtx, ticket: TicketRow, body: string, data: object): void {
  ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body, data_json: JSON.stringify(data) });
}

/** A read the forge answered with a server error or that timed out: the ticket's next read waits longer, and an hour of them pauses the project. */
function waitOutServerError(ctx: EngineCtx, ticket: TicketRow, message: string, forge = "GitHub"): void {
  const { store } = ctx;
  const now = ctx.now();
  const previous = pollWaitOf(ticket);
  const wait = nextPollWait(previous, { now, message });
  store.tx(() => {
    store.updateTicket(ticket.id, { pr_poll_json: JSON.stringify(wait) });
    if (previous === null) addWaitPost(ctx, ticket, pollWaitText(wait, forge), { prReadFailed: true, failures: wait.failures });
  });
  store.changed(ticket.project_id);
  ctx.bb.log("warn", `Reading ${ticket.key}'s pull request failed ${plural(wait.failures, "time")} in a row: ${message}`);
  if (now - wait.since >= SERVER_ERROR_LIMIT_MS) pauseProject(ctx, ticket.project_id, pollWaitReason(ticket, wait, now, forge));
}

/** A read the forge host rate-limited: no read goes to that host, from any project, until the backoff ends. */
function backOff(ctx: EngineCtx, ticket: TicketRow, host: string, failure: { message: string; retryAfterMs?: number }, forge = "GitHub"): void {
  const now = ctx.now();
  const backoff = nextBackoff(ctx.forgeBackoffs.get(host), { now, message: failure.message, retryAfterMs: failure.retryAfterMs });
  ctx.forgeBackoffs.set(host, backoff);
  addWaitPost(ctx, ticket, backoffText(host, backoff, now, forge), { rateLimited: true, host, until: backoff.until });
  ctx.bb.log("warn", `${host} rate-limited Loom's pull request reads, so none goes there until ${new Date(backoff.until).toISOString()}: ${failure.message}`);

}

/**
 * A read that never reached the forge host, such as one whose name did not resolve. That is the machine, not the pull
 * request, so the whole host waits: no read goes there, from any project, for 5, 10, 20, then 30 minutes, and one failed
 * call is one failure however many pull requests it asked for. The ticket whose read starts the streak gets its one post,
 * and an hour of failures with no read there working in between pauses the project whose read failed.
 */
function waitOutNetworkError(ctx: EngineCtx, ticket: TicketRow, host: string, message: string): void {
  const now = ctx.now();
  const backoff = nextNetworkBackoff(ctx.forgeBackoffs.get(host), { now, message });
  ctx.forgeBackoffs.set(host, backoff);
  const { failures, since } = backoff.network;
  if (failures === 1) {
    addWaitPost(ctx, ticket, networkWaitText(host, backoff), { networkFailed: true, host, until: backoff.until });
    ctx.store.changed(ticket.project_id);
  }
  ctx.bb.log("warn", `Reading pull requests on ${host} failed ${plural(failures, "time")} in a row with a network error, so none goes there until ${new Date(backoff.until).toISOString()}: ${message}`);
  if (now - since >= SERVER_ERROR_LIMIT_MS) pauseProject(ctx, ticket.project_id, networkWaitReason(host, backoff, now));
}

/**
 * What a pull request whose fix round is ready looks like now: one GitHub read of it, or a command forge's feedback command,
 * which can name its base, else its state command, which cannot. Its draft flag, review, base and mergeability are kept like a poll's.
 */
async function fixRoundState(ctx: EngineCtx, checkout: RepoCheckout, url: string): Promise<{ outcome: "ok"; state: "OPEN" | "MERGED" | "CLOSED"; meta: Pick<PrMeta, "draft" | "review" | "base" | "mergeable"> } | ({ outcome: "unavailable"; message: string } & Partial<Transient>)> {
  const { hostId, path: repo, settings } = checkout;
  const { forge } = settings;
  const pull = forge.kind === "gh" ? githubPull(url) : null;
  if (pull !== null) {
    const answer = await ctx.host.call(hostId, "prBatch", { repo, host: pull.host, owner: pull.owner, name: pull.name, numbers: [pull.number], feedback: false });
    if (answer.outcome === "unavailable") return answer;
    const read = answer.pulls.find((each) => each.number === pull.number);
    if (read === undefined) {
      const miss = answer.missing[0];
      return { outcome: "unavailable", message: miss?.message ?? `gh found no pull request at ${url}.`, ...(miss === undefined ? {} : transientOf(miss)) };
    }
    return { outcome: "ok", state: read.state, meta: { draft: read.draft, review: read.review, base: read.base, mergeable: read.mergeable ?? null } };
  }
  if (forge.kind === "command" && forge.feedback !== undefined) {
    const read = await ctx.host.call(hostId, "prFeedback", { repo, url, forge: { kind: "command", feedback: forge.feedback } });
    if (read.outcome === "unavailable") return read;
    return { outcome: "ok", state: read.state, meta: { draft: read.draft ?? null, review: read.review ?? null, base: read.base ?? null, mergeable: read.mergeable ?? null } };
  }
  const state = await ctx.host.call(hostId, "prState", { repo, url, forge: stateForge(forge) });
  return state.outcome === "ok" ? { outcome: "ok", state: state.state, meta: { draft: null, review: null, base: null, mergeable: null } } : state;
}

/** A command forge's pull request through its feedback or state command, or the push-only forge's pushed commit. */
async function readOne(ctx: EngineCtx, checkout: RepoCheckout, ticket: TicketRow, forge: ForgeSpec, follows: boolean): Promise<PrRead> {
  const { hostId, path: repo, settings } = checkout;
  if (forge.kind === "none") {
    // The push-only forge has no pull request to ask: the ticket is done once the remote base contains the commit Loom pushed.
    const landed = await ctx.host.call(hostId, "landedOn", { repo, remote: settings.remote, base: settings.base, sha: ticket.pushed_sha ?? ticket.head_sha!, ...gitNetwork(settings) });
    return landed.outcome === "ok" ? { outcome: "ok", state: landed.landed ? "MERGED" : "OPEN", meta: null, feedback: null } : landed;
  }
  if (follows && followsFeedback(forge)) {
    const read = await ctx.host.call(hostId, "prFeedback", { repo, url: ticket.pr_url!, forge: forge.kind === "command" ? { kind: "command", feedback: forge.feedback! } : { kind: "gh" } });
    if (read.outcome !== "ok") return read;
    return { outcome: "ok", state: read.state, meta: { draft: read.draft ?? null, review: read.review ?? null, base: read.base ?? null, mergeable: read.mergeable ?? null }, feedback: read, text: textRead(read) };
  }
  // The state command prints one word, so it tells nothing else about the pull request.
  const state = await ctx.host.call(hostId, "prState", { repo, url: ticket.pr_url!, forge: stateForge(forge) });
  return state.outcome === "ok" ? { outcome: "ok", state: state.state, meta: { draft: null, review: null, base: null }, feedback: null } : state;
}

/** Reads up to PR_BATCH_MAX of one repository's due GitHub pull requests in one call, then settles each ticket on its own. */
async function readBatch(ctx: EngineCtx, project: ProjectRow, spec: Spec, batch: Batch, chunk: Batch["tickets"], follows: boolean): Promise<void> {
  const { store } = ctx;
  // Each ticket as it is when the call goes out: settleRead compares the ticket with it once the answer is in.
  const polled = chunk.flatMap(({ id, number }) => {
    const ticket = store.ticket(id);
    return ticket?.state === "pr_open" ? [{ ticket, number }] : [];
  });
  if (polled.length === 0) return;
  for (const { ticket } of polled) markRead(ctx, ticket.id);
  const { checkout, host, owner, name } = batch;
  let answer: HostOutputOf<"prBatch">;
  try {
    answer = await ctx.host.call(checkout.hostId, "prBatch", { repo: checkout.path, host, owner, name, numbers: [...new Set(polled.map((each) => each.number))], feedback: follows });
  } catch (error) {
    const what = polled.length === 1 ? `the pull request of ${polled[0]!.ticket.key}` : `the pull requests of ${andList(polled.map(({ ticket }) => ticket.key))}`;
    const message = `Reading ${what} stopped: ${errText(error)}`;
    for (const { ticket } of polled) noteAnswer(ctx, ticket.id, message);
    if (hostCallTransient(error) !== null) for (const { ticket } of polled) waitOutServerError(ctx, ticket, errText(error), PROJECT_MACHINE);
    else pauseProject(ctx, project.id, message);
    return;
  }
  if (answer.outcome === "unavailable") {
    // A rate limit or a network failure stops the whole host once; a server error or timeout makes each ticket of the call wait out its own.
    if (answer.transient === "rate_limit") backOff(ctx, polled[0]!.ticket, batch.forgeHost, answer);
    else if (answer.transient === "network") waitOutNetworkError(ctx, polled[0]!.ticket, batch.forgeHost, answer.message);
    else if (answer.transient === "server") for (const { ticket } of polled) waitOutServerError(ctx, ticket, answer.message);
    else {
      for (const { ticket } of polled) noteAnswer(ctx, ticket.id, answer.message);
      pauseProject(ctx, project.id, answer.message);
    }
    return;
  }
  // Answered ones first: a read that worked clears the host's backoff, so a rate limit in the same answer must come after it.
  const answered = (number: number) => answer.pulls.some((each) => each.number === number);
  const missOf = (number: number) => answer.missing.find((each) => each.number === number);
  const limited = polled.filter(({ number }) => missOf(number)?.transient === "rate_limit");
  const offline = polled.filter(({ number }) => missOf(number)?.transient === "network");
  for (const { ticket, number } of [...polled.filter((each) => answered(each.number)), ...polled.filter((each) => !answered(each.number))]) {
    if (limited.some((each) => each.ticket.id === ticket.id) || offline.some((each) => each.ticket.id === ticket.id)) continue;
    const pull = answer.pulls.find((each) => each.number === number);
    const read: PrRead =
      pull === undefined
        ? missedRead(ticket, missOf(number))
        : { outcome: "ok", state: pull.state, meta: { draft: pull.draft, review: pull.review, base: pull.base, mergeable: pull.mergeable ?? null }, feedback: pull.feedback, text: textRead(pull) };
    await settleRead(ctx, project, repoSettings(spec, ticket.repo), ticket, read, batch.forgeHost);
  }
  // However many pull requests of the one answer GitHub rate-limited, it is one limit: one backoff, one post, the longest wait it named.
  if (limited.length > 0) {
    const misses = limited.map(({ number }) => missOf(number)!);
    const waits = misses.flatMap((each) => (each.retryAfterMs === undefined ? [] : [each.retryAfterMs]));
    backOff(ctx, limited[0]!.ticket, batch.forgeHost, { message: misses[0]!.message, ...(waits.length === 0 ? {} : { retryAfterMs: Math.max(...waits) }) });
  } else if (offline.length > 0) {
    waitOutNetworkError(ctx, offline[0]!.ticket, batch.forgeHost, missOf(offline[0]!.number)!.message);
  }
}

/** A pull request a batch answer left out: gone when GitHub says so, or a failure to wait out like a whole failed read. */
function missedRead(ticket: TicketRow, miss: Extract<HostOutputOf<"prBatch">, { outcome: "ok" }>["missing"][number] | undefined): PrRead {
  if (miss === undefined) return { outcome: "unavailable", message: `Reading the pull request of ${ticket.key} stopped: gh found no pull request at ${ticket.pr_url}.` };
  const { message, ...transient } = miss;
  return { outcome: "unavailable", message: `Reading the pull request of ${ticket.key} stopped: ${message}`, ...(transient.transient === undefined ? {} : { transient: transient.transient }), ...(transient.retryAfterMs === undefined ? {} : { retryAfterMs: transient.retryAfterMs }) };
}

/**
 * Acts on one read of the ticket's pull request: merged completes the ticket, unless it merged into a branch other than
 * the repo's base, closed blocks it, and open follows its feedback and keeps its text up to date (syncPrText). A
 * successful read stores the PrMeta first.
 */
async function settleRead(ctx: EngineCtx, project: ProjectRow, settings: RepoSettings, polled: TicketRow, read: PrRead, host: string | null): Promise<void> {
  const { store } = ctx;
  noteAnswer(ctx, polled.id, read.outcome === "ok" ? null : read.message);
  if (read.outcome === "unavailable") {
    const forge = settings.forge.kind === "gh" ? "GitHub" : (host ?? "the forge");
    if (read.transient === "rate_limit" && host !== null) backOff(ctx, polled, host, read, forge);
    else if (read.transient === "network" && host !== null) waitOutNetworkError(ctx, polled, host, read.message);
    // The push-only forge has no forge host to back off, so even its rate limit waits on the ticket.
    else if (read.transient !== undefined) waitOutServerError(ctx, polled, read.message, forge);
    else pauseProject(ctx, project.id, read.message);
    return;
  }
  if (host !== null) ctx.forgeBackoffs.delete(host);
  if (polled.pr_poll_json !== null) store.updateTicket(polled.id, { pr_poll_json: null });
  // The answer is about the pull request and attempt that were polled; the human may have blocked and requeued the ticket during the host call.
  const seen = store.ticket(polled.id);
  if (seen?.state !== "pr_open" || seen.pr_url !== polled.pr_url || seen.attempt !== polled.attempt || seen.pushed_sha !== polled.pushed_sha) return;
  if (read.meta !== null) store.updateTicket(seen.id, { pr_meta_json: JSON.stringify(readMeta(seen, { at: ctx.now(), ...read.meta, state: read.state })) });
  const current = store.ticket(seen.id)!;
  const base = read.meta?.base ?? null;
  if (read.state === "MERGED" && settings.forge.kind === "none") {
    const target = `${settings.remote}/${settings.base}`;
    complete(ctx, current.id, { kind: "merge", body: `The branch landed on ${target}.`, data: { outcome: "branch_landed", pushed: target } });
  } else if (read.state === "MERGED" && base !== null && base !== settings.base) {
    await blockMergedElsewhere(ctx, current, settings, base);
  } else if (read.state === "MERGED") {
    complete(ctx, current.id, { kind: "merge", body: "The pull request was merged.", data: { outcome: "pr_merged", url: current.pr_url } });
  } else if (read.state === "CLOSED") {
    await settleClosed(ctx, project, settings, current, base);
  } else {
    if (read.feedback !== null) await followFeedback(ctx, store.project(project.id)!, current, read.feedback);
    await syncPrText(ctx, store.project(project.id)!, current.id, read.text ?? null);
  }
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
  // Queued with the move, so no restart can finish a project without a record.
  store.tx(() => {
    store.setProjectState(projectId, "done", LOOM_ACTOR);
    store.queueRecord(projectId);
  });
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
    if (url === null) {
      const pushed = `${spec.merge.remote}/${spec.merge.branch!}`;
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
  const merged = await ctx.host.call(hostId, "merge", { worktree, ref: fetched.sha, message: `Merge ${target} into ${branch} (Loom)` });
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
