// The submit pipeline: the worker hands in, the plugin commits, checks scope and runs the commands, and only a
// pass moves the ticket on. Runs are keyed by ticket, so a ticket is never checked twice at once.
import type { Store, ThreadRow, TicketRow } from "./db/store";
import { checkFailedText, clip } from "./prompts";
import { LoomError } from "./projects";
import { scopeReport } from "./scope";
import type { Spec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { applyMove, endThread, freshBase, recordBranch, resolveEnvironment, specOf, ticketMoveFor, toWorking, type EngineCtx } from "./workers";

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

// An `ending` worker is not gone: the endThread that claimed its row still owns the ticket's move, so the checks leave the ticket alone.
type WorkerStanding = { standing: "active" | "ending"; row: ThreadRow } | { standing: "gone"; row: null };

export function workerOf(store: Store, ticket: TicketRow): WorkerStanding {
  const row = ticket.worker_thread_id === null ? null : store.threadByThreadId(ticket.worker_thread_id);
  if (row !== null && row.state === "active") return { standing: "active", row };
  if (row !== null && row.state === "ending") return { standing: "ending", row };
  return { standing: "gone", row: null };
}

// A message to a worker that pause --now stopped would start it again, so results reach workers only while the project runs.
// Resume hands over a failed result that was held back.
export const delivers = (ctx: EngineCtx, projectId: number) => ctx.store.project(projectId)?.state === "running";

/** The worker's loom_submit: validates, moves the ticket to checking, starts the checks and returns at once. */
export function submit(ctx: EngineCtx, threadId: string, summary: string): string {
  const { store } = ctx;
  const row = store.threadByThreadId(threadId);
  if (row === null || row.role !== "worker") throw new LoomError("loom_forbidden", "loom_submit is for a Loom worker thread.");
  const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
  if (row.state !== "active" || ticket === null || ticket.state !== "working" || ticket.worker_thread_id !== threadId) {
    throw new LoomError("loom_invalid_state", "You are not the live worker of a ticket in working state, so there is nothing to submit.");
  }
  const text = summary.trim();
  if (text === "") throw new LoomError("loom_invalid_input", "The summary is empty. Say what you did and how each acceptance criterion holds.");
  store.tx(() => {
    store.setTicketState(ticket.id, "checking", threadId, { submit: true });
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "worker", author_thread_id: threadId, kind: "submit", body: text });
  });
  store.changed(ticket.project_id);
  void runChecks(ctx, ticket.id).catch((error) => ctx.bb.log("error", `Checks of ${ticket.key} failed: ${errText(error)}`));
  return `Submitted ${ticket.key}. The plugin is committing your work and running the checks now, so end your turn. The result arrives as a message: either what to fix, or a note that the ticket is waiting for review.`;
}

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
      if (running.has(ticket.id)) continue;
      started += 1;
      void runChecks(ctx, ticket.id).catch((error) => ctx.bb.log("error", `Checks of ${ticket.key} failed: ${errText(error)}`));
    }
  }
  return started;
}

interface Outcome {
  commitSha: string;
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
    if (move !== null) applyMove(ctx, ticket, move, LOOM_ACTOR, { reason: "the worker is gone" });
    return;
  }

  let outcome: Outcome;
  try {
    outcome = await runPipeline(ctx, ticket, spec, worker.row);
  } catch (error) {
    hostFailed(ctx, ticketId, errText(error));
    return;
  }
  await finish(ctx, ticketId, spec, outcome);
}

async function runPipeline(ctx: EngineCtx, ticket: TicketRow, spec: Spec, worker: ThreadRow): Promise<Outcome> {
  const environment = await resolveEnvironment(ctx, worker);
  if (environment?.path == null) throw new Error("the worker's worktree is not available");
  const { path: worktree, hostId } = environment;

  const commit = await ctx.host.call(hostId, "commitAll", { worktree, message: `${ticket.key}: ${ticket.title}` });
  await recordBranch(ctx, worker);
  const base = freshBase(spec);
  const state = await ctx.host.call(hostId, "worktreeState", { worktree, base });
  const report = scopeReport(state.changed, JSON.parse(ticket.scope_json) as string[], spec.scope.protected);
  const outcome: Outcome = { commitSha: commit.sha, runs: [], failure: null, outside: report.outside, protectedHits: report.protectedHits };
  const refuse = (command: string, output: string) => {
    outcome.failure = { command, exitCode: 1, timedOut: false, durationMs: 0, output };
    outcome.runs.push(outcome.failure);
    return outcome;
  };

  if (report.protectedHits.length > 0) {
    return refuse("scope check", `This change touches protected paths, which a worker may never edit: ${report.protectedHits.join(", ")}. Revert them and submit again.`);
  }
  if (report.outside.length > 0 && spec.scope.enforce === "reject") {
    return refuse("scope check", `These files are outside the ticket's scope, and scope.enforce is "reject": ${report.outside.join(", ")}. Revert them, or call loom_block if the ticket needs a wider scope.`);
  }

  for (const command of [...(JSON.parse(ticket.verify_json) as string[]), ...spec.checks.commands]) {
    const result = await ctx.host.call(hostId, "exec", { cwd: worktree, command, timeoutMs: spec.checks.timeout_minutes * 60_000 });
    const run: CheckRun = { command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, output: result.output };
    outcome.runs.push(run);
    if (run.exitCode !== 0 || run.timedOut) {
      outcome.failure = run;
      return outcome;
    }
  }

  const after = await ctx.host.call(hostId, "worktreeState", { worktree, base });
  if (after.head !== commit.sha || after.dirty) {
    return refuse("worktree check", "The worktree changed while the checks ran; the checks must not write tracked files and you must not edit during checks.");
  }
  return outcome;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function checkPost(outcome: Outcome, enforce: Spec["scope"]["enforce"]): { body: string; data: object } {
  const passed = outcome.failure === null;
  const lines = [passed ? `Checks passed (${outcome.runs.length} ${outcome.runs.length === 1 ? "command" : "commands"}).` : "Checks failed."];
  for (const run of outcome.runs) {
    const how = run.timedOut ? "timed out" : `exit ${run.exitCode}`;
    lines.push(`${run.exitCode === 0 && !run.timedOut ? "pass" : "FAIL"} ${run.command} (${how}, ${seconds(run.durationMs)})`);
  }
  if (outcome.failure !== null) lines.push("", clip(outcome.failure.output.slice(-FAILURE_TAIL), FAILURE_TAIL));
  if (passed && outcome.outside.length > 0) lines.push("", `Outside the ticket's scope (scope.enforce is "${enforce}"): ${outcome.outside.join(", ")}`);
  const runs = outcome.runs.map(({ command, exitCode, timedOut, durationMs }) => ({ command, exitCode, timedOut, durationMs }));
  return { body: lines.join("\n"), data: { passed, runs, outside: outcome.outside, protectedHits: outcome.protectedHits } };
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
    const { body, data } = checkPost(outcome, spec.scope.enforce);
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "check", body, data_json: JSON.stringify(data) });
    if (failure === null) {
      const round = ticket.review_round + 1;
      store.setTicketState(ticket.id, "review", LOOM_ACTOR, { head: outcome.commitSha, round });
      store.updateTicket(ticket.id, { head_sha: outcome.commitSha, review_round: round });
      if (worker !== null) store.updateThread((worker as ThreadRow).id, { idle_count: 0 });
      return true;
    }
    if (owner.standing === "ending") return true;
    const checkFailures = ticket.check_failures + 1;
    store.updateTicket(ticket.id, { check_failures: checkFailures });
    if (worker === null) {
      const move = ticketMoveFor("gone", ticket, spec);
      if (move !== null) applyMove(ctx, ticket, move, LOOM_ACTOR, { reason: "the worker is gone" });
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
  if (target?.thread_id != null && delivers(ctx, ticket.project_id)) {
    if (failure === null) {
      const outside = outcome.outside.length > 0 ? ` These files are outside the ticket's scope: ${outcome.outside.join(", ")}.` : "";
      await send(ctx, target.thread_id, `[loom] ${ticket.key}: the checks passed. The ticket is waiting for review; end your turn and wait for a message.${outside}`);
    } else if (blocked === null) {
      await send(ctx, target.thread_id, checkFailedText(ticket.key, failure));
    }
  }
  if (blocked !== null && target !== null) {
    const { checkFailures } = blocked;
    const reason = `checks failed ${checkFailures} times`;
    const move = { to: "blocked" as const, patch: { check_failures: checkFailures, blocked_reason: reason, worker_thread_id: null, environment_id: null } };
    if (await endThread(ctx, target, "blocked", { commit: true, move })) {
      store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: reason, data_json: JSON.stringify({ reason, needs: "" }) });
    }
  }
  store.changed(ticket.project_id);
}

// A host call threw: the machine disconnected or the call timed out. No check failure is counted.
function hostFailed(ctx: EngineCtx, ticketId: number, error: string): void {
  const { store } = ctx;
  const ticket = store.ticket(ticketId);
  if (ticket === null || ticket.state !== "checking") return;
  const text = `The checks could not run: ${error}. Submit again.`;
  const worker = workerOf(store, ticket);
  store.tx(() => {
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body: text });
    if (worker.standing === "ending") return;
    if (worker.standing === "active") {
      toWorking(ctx, ticket, worker.row, { reason: "the checks could not run" });
      return;
    }
    const move = ticketMoveFor("gone", ticket, specOf(store, store.project(ticket.project_id)!));
    if (move !== null) applyMove(ctx, ticket, move, LOOM_ACTOR, { reason: "the worker is gone" });
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
