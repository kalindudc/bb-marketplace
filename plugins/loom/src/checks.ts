// The submit pipeline: the worker hands in, the plugin commits, checks scope and runs the commands, and only a
// pass moves the ticket on. Runs are keyed by ticket, so a ticket is never checked twice at once.
import { posix } from "node:path";
import { retriesOf } from "./backoff";
import { repoCheckout, ticketRepo } from "./checkouts";
import type { ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import { formatDuration, plural } from "./format";
import { GIT_INDEX_SETTING, GIT_INDEX_TIMEOUT_MS } from "./git-network";
import { waitableOf } from "./forge-waits";
import { isMultiRepo, repoSettings } from "./repos";
import { checkFailedText, clip, prUnchangedText } from "./prompts";
import { writeSub, type PrText, type Stack } from "./sub-state";
import { openFeedback, proposalOf, proposeText, textPending, unchangedFix } from "./pull-requests";
import { LoomError } from "./projects";
import type { EnvironmentInfo } from "./ports";
import { recordingHost } from "./runs";
import { scopeReport } from "./scope";
import type { Spec } from "./spec";
import { stackOf } from "./stack";
import { LOOM_ACTOR } from "./states";
import { bringHome, isRemote, worktreeBaseOf } from "./transport";
import { endThread, recordBranch, resolveEnvironment, ticketMoveFor, toWorking } from "./workers";
import { delivers, specOf, workerOf, type EngineCtx } from "./ctx";
import { moveTicket, tryMoveTicket, type TicketMove } from "./moves";

export interface CheckRun {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

const FAILURE_TAIL = 4000;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const inflightByStore = new WeakMap<Store, Map<number, Promise<void>>>();
const inflightOf = (store: Store) => inflightByStore.get(store) ?? inflightByStore.set(store, new Map()).get(store)!;

/** Waits for every run in flight, including runs those runs start. For tests. */
export async function settleChecks(ctx: EngineCtx): Promise<void> {
  const running = inflightOf(ctx.store);
  while (running.size > 0) await Promise.all([...running.values()]);
}

/**
 * The worker's loom_submit: validates, moves the ticket to checking, starts the checks and returns at once. `pr` is the
 * pull request's title and description as the worker proposes them, for the reviewers to judge with the work.
 */
export function submit(ctx: EngineCtx, threadId: string, summary: string, pr?: { title?: string; body?: string }): string {
  const { store } = ctx;
  const row = store.threadByThreadId(threadId);
  if (row === null || row.role !== "worker") throw new LoomError("loom_forbidden", "loom_submit is for a Loom worker thread.");
  const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
  if (row.state !== "active" || ticket === null || ticket.state !== "working" || ticket.worker_thread_id !== threadId) {
    throw new LoomError("loom_invalid_state", "You are not the live worker of a ticket in working state, so there is nothing to submit.");
  }
  const text = summary.trim();
  if (text === "") throw new LoomError("loom_invalid_input", "The summary is empty. Say what you did and how each acceptance criterion holds.");
  if (row.resume_json !== null) throw new LoomError("loom_invalid_state", "Call loom_resume first: it puts the ticket's earlier work in your worktree, and your submit must build on it.");
  const proposal = pr === undefined ? null : proposeText(specOf(store, store.project(ticket.project_id)!), ticket, pr, ctx.now());
  store.tx(() => {
    moveTicket(store, ticket.id, { name: "submit" }, threadId, { submit: true });
    const proposed = proposal === null ? "" : proposalText(pr!);
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "worker", author_thread_id: threadId, kind: "submit", body: `${text}${proposed}`, ...(proposal === null ? {} : { data_json: JSON.stringify({ pr: { title: pr!.title?.trim() ?? null, body: pr!.body?.trim() ?? null } }) }) });
    if (proposal !== null) store.updateTicket(ticket.id, writeSub("pr_proposal_json", proposal));
  });
  store.changed(ticket.project_id);
  // After checks that could not reach the project's machine, the next run waits its turn; the tick starts it once it is due.
  const wait = retriesOf(store).checks.waitMs(ticket.id, ctx.now());
  if (wait === 0) void runChecks(ctx, ticket.id).catch((error) => ctx.bb.log("error", `Checks of ${ticket.key} failed: ${errText(error)}`));
  else return `Submitted ${ticket.key}. The plugin's last run of the checks timed out or could not reach the project's machine, so it runs them in about ${formatDuration(wait)}. End your turn; the result arrives as a message.`;
  return `Submitted ${ticket.key}. The plugin is committing your work and running the checks now, so end your turn. The result arrives as a message: either what to fix, or a note that the ticket is waiting for review.`;
}

const proposalText = (pr: { title?: string; body?: string }) =>
  ["", "", ...(pr.title === undefined ? [] : [`Proposed pull request title: ${pr.title.trim()}`]), ...(pr.body === undefined ? [] : [`Proposed pull request description:\n${pr.body.trim()}`])].join("\n");

/** Runs the pipeline for a ticket in checking. Safe to call again for the same ticket: a run already in flight is shared. */
export function runChecks(ctx: EngineCtx, ticketId: number): Promise<void> {
  const running = inflightOf(ctx.store);
  const existing = running.get(ticketId);
  if (existing !== undefined) return existing;
  const run = pipeline(ctx, ticketId).finally(() => running.delete(ticketId));
  running.set(ticketId, run);
  return run;
}

/** Starts the checks of every ticket stranded in checking, by a restart or a lost run. Returns how many it started. */
export function resumeCheckingTickets(ctx: EngineCtx): number {
  const running = inflightOf(ctx.store);
  let started = 0;
  for (const project of ctx.store.projects()) {
    if (project.state === "archived") continue;
    for (const ticket of ctx.store.tickets(project.id, ["checking"])) {
      if (running.has(ticket.id) || retriesOf(ctx.store).checks.waitMs(ticket.id, ctx.now()) > 0) continue;
      started += 1;
      void runChecks(ctx, ticket.id).catch((error) => ctx.bb.log("error", `Checks of ${ticket.key} failed: ${errText(error)}`));
    }
  }
  return started;
}

interface Outcome {
  /** The commit that passed, on the project's checkout: the worker's own, or the one Loom brought home from its machine. */
  commitSha: string;
  tree: string;
  environment: EnvironmentInfo;
  /** A fix round that changed nothing: no checks, no review, nothing to push. */
  unchanged?: boolean;
  /** A fix round that changed only the pull request's proposed text: no checks, but a review of the text, and nothing to push. */
  textOnly?: boolean;
  runs: CheckRun[];
  failure: CheckRun | null;
  outside: string[];
  protectedHits: string[];
}

async function pipeline(ctx: EngineCtx, ticketId: number): Promise<void> {
  const { store } = ctx;
  const ticket = store.ticket(ticketId);
  if (ticket === null || ticket.state !== "checking") return;
  const spec = specOf(store, store.project(ticket.project_id)!);
  const worker = workerOf(ctx.store, ticket);
  if (worker.standing === "ending") return;
  if (worker.standing === "gone") {
    const move = ticketMoveFor("gone", ticket, spec);
    if (move !== null) tryMoveTicket(store, ticket.id, move, LOOM_ACTOR, { reason: "the worker is gone" });
    return;
  }

  let outcome: Outcome;
  try {
    outcome = await runPipeline({ ...ctx, host: recordingHost(ctx.store, ctx.host, ticket, "check") }, ticket, spec, worker.row);
    const project = store.project(ticket.project_id)!;
    if (outcome.failure === null && outcome.unchanged !== true && outcome.textOnly !== true && isRemote(project, outcome.environment)) {
      outcome = { ...outcome, commitSha: (await bringHome(ctx, project, spec, ticket, outcome.environment, "submit", outcome.tree)).sha };
    }
  } catch (error) {
    hostFailed(ctx, ticketId, error);
    return;
  }
  retriesOf(store).checks.reset(ticketId);
  await finish(ctx, ticketId, spec, outcome);
}

/**
 * The files a submit may not keep conflict markers in, relative to the repository's top level. Loom before 0.29.0 named
 * them relative to the project's checkout, which may be a subdirectory, so such a path is resolved from the checkout's
 * prefix once and stored again; one that still points outside the repository is dropped.
 */
async function markerPaths(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, stack: Stack): Promise<string[]> {
  const stored = stack.markers ?? [];
  const inside = (path: string) => !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  if (stored.every(inside)) return stored;
  const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
  const { prefix } = await ctx.host.call(checkout.hostId, "repoPrefix", { repo: checkout.path });
  const markers = [...new Set(stored.map((path) => (inside(path) ? path : posix.normalize(`${prefix}${path}`))).filter(inside))];
  ctx.store.updateTicket(ticket.id, writeSub("stack_json", { ...stack, markers }));
  return markers;
}

async function runPipeline(ctx: EngineCtx, ticket: TicketRow, spec: Spec, worker: ThreadRow): Promise<Outcome> {
  const environment = await resolveEnvironment(ctx, worker);
  if (environment?.path == null) throw new Error("the worker's worktree is not available");
  const { path: worktree, hostId } = environment;

  const commit = await ctx.host.call(hostId, "commitAll", { worktree, message: ticket.title });
  await recordBranch(ctx, worker);
  const repo = ticketRepo(spec, ticket);
  const project = ctx.store.project(ticket.project_id)!;
  const base = worktreeBaseOf(project, spec, ticket, environment);
  const stack = stackOf(ticket);
  // On another machine the commit the ticket is stacked on has another id, so the scope is measured from its tree.
  const baseTree = stack?.base == null || !isRemote(project, environment) ? null : await stackedTree(ctx, project, spec, ticket, stack.base);
  const state = await ctx.host.call(hostId, "worktreeState", { worktree, base, ...(baseTree === null ? {} : { baseTree }) });
  const kept = { commitSha: commit.sha, tree: state.tree, environment };
  const posts = ctx.store.posts(ticket.id);
  if (unchangedFix(posts, { sha: commit.sha, tree: state.tree })) {
    if (!textPending(ctx, ticket)) return { ...kept, unchanged: true, runs: [], failure: null, outside: [], protectedHits: [] };
    // The work is the commit the open feedback was sent for, which the checkout has whatever machine the worker is on.
    const sent = (JSON.parse(openFeedback(posts)!.data_json) as { head?: string | null }).head ?? ticket.head_sha!;
    return { ...kept, commitSha: sent, textOnly: true, runs: [], failure: null, outside: [], protectedHits: [] };
  }
  const report = scopeReport(state.changed, JSON.parse(ticket.scope_json) as string[], repo.protected);
  const outcome: Outcome = { ...kept, runs: [], failure: null, outside: report.outside, protectedHits: report.protectedHits };
  const refuse = (command: string, output: string) => {
    outcome.failure = { command, exitCode: 1, timedOut: false, durationMs: 0, output };
    outcome.runs.push(outcome.failure);
    return outcome;
  };

  if (state.onBase === false) {
    return refuse("scope check", "Your branch no longer has the commit Loom put first in it, which holds the work this ticket is stacked on, so Loom cannot tell your changes from that work. Do not rebase, reset or squash over that commit; call loom_block if you cannot get it back.");
  }
  if (report.protectedHits.length > 0) {
    return refuse("scope check", `This change touches protected paths, which a worker may never edit: ${report.protectedHits.join(", ")}. Revert them and submit again.`);
  }
  if (report.outside.length > 0 && spec.scope.enforce === "reject") {
    return refuse("scope check", `These files are outside the ticket's scope, and scope.enforce is "reject": ${report.outside.join(", ")}. Revert them, or call loom_block if the ticket needs a wider scope.`);
  }

  const markers = stack?.markers === undefined ? [] : await markerPaths(ctx, project, spec, ticket, stack);
  if (markers.length > 0) {
    const { files } = await ctx.host.call(hostId, "conflictMarkers", { worktree, paths: markers });
    if (files.length > 0) return refuse("conflict check", `These files still have the conflict markers Loom left when it brought your branch up to date: ${files.join(", ")}. Resolve them so both sides' changes hold, then submit again.`);
  }

  for (const command of [...(JSON.parse(ticket.verify_json) as string[]), ...repo.checks]) {
    const result = await ctx.host.call(hostId, "exec", { cwd: worktree, command, timeoutMs: spec.checks.timeout_minutes * 60_000 });
    const run: CheckRun = { command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, output: result.output };
    outcome.runs.push(run);
    if (run.exitCode !== 0 || run.timedOut) {
      outcome.failure = run;
      return outcome;
    }
  }

  // By tree: a machine that moved during the checks gives the same commit a new id.
  const after = await ctx.host.call(hostId, "worktreeState", { worktree, base });
  if (after.tree !== state.tree || after.dirty) {
    return refuse("worktree check", "The worktree changed while the checks ran; the checks must not write tracked files and you must not edit during checks.");
  }
  return outcome;
}

async function stackedTree(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, base: string): Promise<string> {
  const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
  const tip = await ctx.host.call(checkout.hostId, "refTip", { repo: checkout.path, ref: base });
  if (tip.outcome !== "ok") throw new Error(`the commit ${base.slice(0, 12)} this ticket is stacked on is not on the project's checkout: ${tip.message}`);
  return tip.tree;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function checkPost(outcome: Outcome, enforce: Spec["scope"]["enforce"]): { body: string; data: object } {
  if (outcome.textOnly === true) {
    const body = `No checks ran: the work is the commit the pull request has (${outcome.commitSha.slice(0, 12)}), and the fix changes only the pull request's proposed title or description.`;
    return { body, data: { passed: true, head: outcome.commitSha, runs: [], outside: [], protectedHits: [], textOnly: true } };
  }
  const passed = outcome.failure === null;
  const lines = [passed ? `Checks passed (${outcome.runs.length} ${outcome.runs.length === 1 ? "command" : "commands"}).` : "Checks failed."];
  for (const run of outcome.runs) {
    const how = run.timedOut ? "timed out" : `exit ${run.exitCode}`;
    lines.push(`${run.exitCode === 0 && !run.timedOut ? "pass" : "FAIL"} ${run.command} (${how}, ${seconds(run.durationMs)})`);
  }
  if (outcome.failure !== null) lines.push("", clip(outcome.failure.output.slice(-FAILURE_TAIL), FAILURE_TAIL));
  if (passed && outcome.outside.length > 0) lines.push("", `Outside the ticket's scope (scope.enforce is "${enforce}"): ${outcome.outside.join(", ")}`);
  const runs = outcome.runs.map(({ command, exitCode, timedOut, durationMs }) => ({ command, exitCode, timedOut, durationMs }));
  return { body: lines.join("\n"), data: { passed, head: outcome.commitSha, runs, outside: outcome.outside, protectedHits: outcome.protectedHits } };
}

async function finish(ctx: EngineCtx, ticketId: number, spec: Spec, outcome: Outcome): Promise<void> {
  const { store } = ctx;
  const failure = outcome.failure;
  let worker: ThreadRow | null = null;
  let blocked: { checkFailures: number } | null = null;

  const applied = store.tx(() => {
    const ticket = store.ticket(ticketId);
    if (ticket === null || ticket.state !== "checking") return false;
    const owner = workerOf(store, ticket);
    worker = owner.standing === "active" ? owner.row : null;
    // The proposal this submit brought came with the commit its checks passed with.
    const proposal = proposalOf(ticket);
    if (proposal?.head === null && failure === null) {
      const head = outcome.unchanged === true ? ticket.head_sha! : outcome.commitSha;
      store.updateTicket(ticket.id, writeSub("pr_proposal_json", { ...proposal, head }));
    }
    if (outcome.unchanged === true) {
      moveTicket(store, ticket.id, { name: "unchanged_fix" }, LOOM_ACTOR, { unchanged: true, fixRound: ticket.pr_rounds });
      const body = `The worker changed nothing for fix round ${ticket.pr_rounds}, so Loom pushed nothing; it keeps following the pull request.`;
      store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "merge", body, data_json: JSON.stringify({ outcome: "pr_unchanged", url: ticket.pr_url, round: ticket.pr_rounds }) });
      if (worker !== null) store.updateThread((worker as ThreadRow).id, { idle_count: 0 });
      return true;
    }
    const { body, data } = checkPost(outcome, spec.scope.enforce);
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "check", body, data_json: JSON.stringify(data) });
    if (failure === null) {
      const round = ticket.review_round + 1;
      const stack = stackOf(ticket);
      const resolved = stack?.markers === undefined ? {} : writeSub("stack_json", { ...stack, markers: undefined });
      // Nothing to push once approved, so Loom asks for no commit message.
      const text: PrText = { head: outcome.commitSha, by: "loom", title: null, body: null, commit: ticket.title };
      const textOnly = outcome.textOnly === true ? writeSub("pr_text_json", text) : {};
      const set = { head_sha: outcome.commitSha, head_tree: outcome.tree, review_round: round, ...resolved, ...textOnly };
      moveTicket(store, ticket.id, { name: "checked", set }, LOOM_ACTOR, { head: outcome.commitSha, round, ...(outcome.textOnly === true ? { textOnly: true } : {}) });
      if (worker !== null) store.updateThread((worker as ThreadRow).id, { idle_count: 0 });
      return true;
    }
    if (owner.standing === "ending") return true;
    const checkFailures = ticket.check_failures + 1;
    store.updateTicket(ticket.id, { check_failures: checkFailures });
    if (worker === null) {
      const move = ticketMoveFor("gone", ticket, spec);
      if (move !== null) tryMoveTicket(store, ticket.id, move, LOOM_ACTOR, { reason: "the worker is gone" });
    } else if (checkFailures >= spec.budget.max_check_failures) {
      blocked = { checkFailures };
    } else {
      toWorking(ctx, store.ticket(ticket.id)!, worker, { checkFailures });
    }
    return true;
  });
  if (!applied) return;

  const ticket = store.ticket(ticketId)!;
  const target = worker as ThreadRow | null;
  if (target?.thread_id != null && delivers(ctx, ticket.project_id) && outcome.unchanged === true) {
    await send(ctx, target.thread_id, prUnchangedText(ticket.key));
  } else if (target?.thread_id != null && delivers(ctx, ticket.project_id)) {
    if (failure === null && outcome.textOnly === true) {
      await send(ctx, target.thread_id, `[loom] ${ticket.key}: your fix changes only the pull request's proposed text, so no checks ran. The reviewers judge the text now; once they approve, Loom sets it on the pull request and pushes nothing. End your turn and wait for a message.`);
    } else if (failure === null) {
      const outside = outcome.outside.length > 0 ? ` These files are outside the ticket's scope: ${outcome.outside.join(", ")}.` : "";
      await send(ctx, target.thread_id, `[loom] ${ticket.key}: the checks passed. The ticket is waiting for review; end your turn and wait for a message.${outside}`);
    } else if (blocked === null) {
      await send(ctx, target.thread_id, checkFailedText(ticket.key, failure));
    }
  }
  if (blocked !== null && target !== null) {
    const { checkFailures } = blocked;
    const reason = `checks failed ${plural(checkFailures, "time")}`;
    const move: TicketMove = { name: "block", set: { check_failures: checkFailures, blocked_reason: reason } };
    if (await endThread(ctx, target, "blocked", { commit: true, move })) {
      store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
    }
  }
  store.changed(ticket.project_id);
}

/**
 * What Loom tells the worker and posts when its own step on the project's checkout, such as bringing the work home with
 * the tree rewrite, ran out of the repo's git index time limit: Loom's machine was slow, not the work, so the worker
 * submits the same work again and never blocks for it, and the post names the setting the human may raise.
 */
function indexTimeoutText(ticket: TicketRow, spec: Spec, error: string): string {
  const at = isMultiRepo(spec) && ticket.repo !== null ? `repo[${(spec.repo ?? []).findIndex((repo) => repo.name === ticket.repo)}].${GIT_INDEX_SETTING}` : `merge.${GIT_INDEX_SETTING}`;
  return `The checks could not run: Loom's own step on the project's machine ran out of time (${error}). This is not a failure of your work and counts against nothing: call loom_submit again with the same work, and do not block the ticket for it. If it keeps happening, the human raises ${at} in the spec (it is ${Math.round((repoSettings(spec, ticket.repo).gitIndexTimeoutMs ?? GIT_INDEX_TIMEOUT_MS) / 1000)} seconds now).`;
}

// A host call threw: the machine disconnected or the call timed out. No check failure is counted.
function hostFailed(ctx: EngineCtx, ticketId: number, failure: unknown): void {
  const error = errText(failure);
  const { store } = ctx;
  const ticket = store.ticket(ticketId);
  if (ticket === null || ticket.state !== "checking") return;
  const indexTimeout = error.includes(GIT_INDEX_SETTING);
  // A timeout or a host that did not answer is the machine being slow or away, so the next run waits 15 seconds, then longer;
  // any other failure is not helped by waiting.
  const retries = retriesOf(store).checks;
  if (indexTimeout || waitableOf(failure) !== null) retries.failed(ticket.id, ctx.now(), error);
  else retries.reset(ticket.id);
  const text = indexTimeout ? indexTimeoutText(ticket, specOf(store, store.project(ticket.project_id)!), error) : `The checks could not run: ${error}. Submit again.`;
  const worker = workerOf(store, ticket);
  store.tx(() => {
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body: text, ...(indexTimeout ? { data_json: JSON.stringify({ outcome: "index_timeout", setting: GIT_INDEX_SETTING }) } : {}) });
    if (worker.standing === "ending") return;
    if (worker.standing === "active") {
      toWorking(ctx, ticket, worker.row, { reason: indexTimeout ? "Loom's index step on the project's machine ran out of time" : "the checks could not run" });
      return;
    }
    const move = ticketMoveFor("gone", ticket, specOf(store, store.project(ticket.project_id)!));
    if (move !== null) tryMoveTicket(store, ticket.id, move, LOOM_ACTOR, { reason: "the worker is gone" });
  });
  if (worker.standing === "active" && worker.row.thread_id !== null && delivers(ctx, ticket.project_id)) void send(ctx, worker.row.thread_id, `[loom] ${ticket.key}: ${text}`);
}

async function send(ctx: EngineCtx, threadId: string, message: string | { summary: string; detail: string }): Promise<void> {
  try {
    await ctx.bb.send(threadId, message);
  } catch (error) {
    ctx.bb.log("warn", `Could not message ${threadId}: ${errText(error)}`);
  }
}
