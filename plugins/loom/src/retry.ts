// What Loom does when a ticket's step fails, by what failures.ts says the failure is. The step waits and tries again
// after 1, 2, 5 and 10 minutes, then every 15 (at least 15 after a rate limit, and never before the time the forge named),
// with the wait kept on the ticket (retry_json) so a restart goes on with it. A failure of this ticket blocks the ticket
// once it has failed for an hour, or after five tries when no rule recognized it, or at once when waiting cannot help.
// A failure of a forge or the project's machine never blocks or pauses: the ticket keeps waiting, and says so once more
// after an hour. Only a failure of the whole project, such as a missing sign-in or a forge command that breaks its
// contract, pauses the project, and its reason says what the human must fix. Other tickets keep going in every case but
// the last.
import type { TicketRow } from "./db/store";
import { ForgeContractError, classify, type Failure } from "./failures";
import { plural } from "./format";
import { loomPost } from "./posts";
import { decide, nextRetry, retryOf, type RetryDecision } from "./retry-wait";
import { LOOM_ACTOR } from "./states";
import { readSub, writeSub, type RetryStep } from "./sub-state";
import { endLiveRows } from "./workers";
import type { EngineCtx } from "./ctx";

const clause = (message: string) => message.trim().replace(/[.:]+$/u, "");

/**
 * Settles a failure of the ticket's `step`: the ticket waits, blocks, or its project pauses. `stop` runs before a block,
 * as a merge's must be taken out first; if it fails, the ticket waits instead. Other tickets are never touched.
 */
export async function stepFailed(ctx: EngineCtx, ticket: TicketRow, step: RetryStep, error: unknown, a: { what: string; head?: string; pr?: string; floorMs?: number; stop?: () => Promise<void> }): Promise<RetryDecision["do"]> {
  const failure = isFailure(error) ? error : classify(error);
  const now = ctx.now();
  const previous = readSub(ticket, "retry_json");
  const decision = decide(previous, { step, what: a.what, now, failure, ...(a.head === undefined ? {} : { head: a.head }), ...(a.pr === undefined ? {} : { pr: a.pr }), ...(a.floorMs === undefined ? {} : { floorMs: a.floorMs }) });
  const count = decision.do === "wait" ? ` ${plural(decision.wait.failures, "time")} in a row` : "";
  ctx.bb.log("warn", `${a.what} failed${count} (${failure.kind}, ${failure.scope}): ${failure.reason}`);
  if (decision.do === "pause") {
    endRetry(ctx, ticket.id, step);
    pauseProject(ctx, ticket.project_id, decision.reason);
    return "pause";
  }
  if (decision.do === "block") {
    try {
      await a.stop?.();
    } catch (stopped) {
      const wait = nextRetry(previous, { step, now, failure: { ...failure, kind: "temporary", scope: "host" }, ...(a.head === undefined ? {} : { head: a.head }) });
      ctx.bb.log("warn", `${a.what}: Loom could not stop the step to block ${ticket.key}, so it waits: ${errOf(stopped)}`);
      ctx.store.updateTicket(ticket.id, writeSub("retry_json", wait));
      return "wait";
    }
    await blockFor(ctx, ticket, decision.reason);
    return "block";
  }
  ctx.store.tx(() => {
    ctx.store.updateTicket(ticket.id, writeSub("retry_json", decision.wait));
    if (decision.post !== null) loomPost(ctx.store, ticket, { kind: "system", body: decision.post, data: { retry: step, kind: failure.kind, scope: failure.scope, failures: decision.wait.failures, until: decision.wait.until } });
    // A fault Loom cannot fix, or an outage of an hour: the planner's next triage round names it, and nothing blocks.
    if (decision.post !== null && decision.wait.noted === true) ctx.store.updateProject(ticket.project_id, { triage_pending: 1 });
  });
  ctx.store.changed(ticket.project_id);
  return "wait";
}

const errOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && !(value instanceof Error) && "kind" in value && "scope" in value && "reason" in value;

/** The step worked, or no longer waits: its wait ends. */
export function endRetry(ctx: EngineCtx, ticketId: number, step: RetryStep): void {
  const ticket = ctx.store.ticket(ticketId);
  if (ticket === null || retryOf(ticket, step) === null) return;
  ctx.store.updateTicket(ticketId, { retry_json: null });
  ctx.store.changed(ticket.project_id);
}

/** Loom blocks the ticket with the reason: it posts it, ends the ticket's live threads, and the planner's triage hears of it. */
async function blockFor(ctx: EngineCtx, ticket: TicketRow, reason: string): Promise<void> {
  ctx.store.tx(() => {
    ctx.store.updateTicket(ticket.id, { blocked_reason: reason, retry_json: null });
    loomPost(ctx.store, ticket, { kind: "block", body: reason, data: { reason, needs: "" } });
  });
  await endLiveRows(ctx, ctx.store.ticket(ticket.id)!, "blocked");
  ctx.store.changed(ticket.project_id);
}

/**
 * A forge call whose answer the host contract refused, wherever Loom made it: the project pauses with the fix, since the
 * forge's own command printed it (forge-gate.ts). True when it did; false for any other error, which the caller settles.
 */
export function forgeBroke(ctx: EngineCtx, projectId: number, what: string, error: unknown): boolean {
  if (!(error instanceof ForgeContractError)) return false;
  projectFailed(ctx, projectId, { reason: `${what} stopped: ${error.message}`, fix: classify(error).fix! });
  return true;
}

/** Pauses the project for a failure of the whole project, such as an exhausted budget, with the reason the human reads. */
export function projectFailed(ctx: EngineCtx, projectId: number, failure: Pick<Failure, "reason" | "fix">): void {
  pauseProject(ctx, projectId, failure.fix === undefined ? failure.reason : `${clause(failure.reason)}. ${failure.fix}`);
}

/** Pauses a running project with a reason the human reads, and flags it so the planner hears why. */
function pauseProject(ctx: EngineCtx, projectId: number, reason: string): void {
  const { store } = ctx;
  const project = store.project(projectId);
  if (project?.state !== "running") return;
  store.tx(() => {
    store.setProjectState(projectId, "paused", LOOM_ACTOR, reason);
    store.updateProject(projectId, { triage_pending: 1 });
  });
  store.changed(project.id);
}
