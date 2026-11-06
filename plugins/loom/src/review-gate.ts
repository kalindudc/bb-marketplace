// The review gate: an outside review, such as a review bot's private review, that runs on a draft before Loom publishes
// it. review_start runs once for each push that changed the ticket's own work (its opening and its fix rounds, never a
// restack or a refresh), review_read is polled for that commit, and its new findings come back to the worker as a fix
// round. A failed or timed-out gate holds the publish and says so; it never pauses the project. Each run is ticket events,
// which publish.ts reads to say whether the gate holds the draft.
import { repoCheckout } from "./checkouts";
import { delivers, specOf, type EngineCtx } from "./ctx";
import type { EventRow, ProjectRow, TicketRow } from "./db/store";
import { MARKED_READY } from "./drafts";
import { hostCallTransient } from "./forge-waits";
import { plural } from "./format";
import type { HostOutput } from "./host-contract";
import { loomPost } from "./posts";
import type { FeedbackItem } from "./prompts";
import { GATE_CAPPED, GATE_DONE, GATE_ROUND, GATE_STARTED, GATE_START_FAILED, GATE_TIMED_OUT, GATE_TIMEOUT_MINUTES, ownPush, runFor, runningGate, type GateRun, type ReviewGate } from "./publish";
import { gateFixRound } from "./pull-requests";
import { repoSettings } from "./repos";
import type { Spec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { readSub } from "./sub-state";

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const dataOf = (event: EventRow) => JSON.parse(event.data_json) as Record<string, unknown>;

/**
 * At each read of a draft Loom is to publish: starts the repo's review gate for the newest push of the ticket's own work,
 * once, or reads the run that is open and acts on what it says. Only while the project runs and the pull request is a
 * draft Loom has not published.
 */
export async function followGate(ctx: EngineCtx, project: ProjectRow, ticketId: number): Promise<void> {
  const { store } = ctx;
  const ticket = store.ticket(ticketId);
  if (ticket === null || ticket.state !== "pr_open" || ticket.pr_url === null || ticket.pushed_sha === null || !delivers(ctx, project.id)) return;
  const spec = specOf(store, project);
  const gate = runningGate(spec, ticket);
  if (gate === null || readSub(ticket, "pr_meta_json")?.draft === false) return;
  if (store.ticketEvents(ticket.id, [MARKED_READY]).some((event) => dataOf(event).url === ticket.pr_url)) return;
  const own = ownPush(store, ticket);
  if (own === null) return;
  const run = runFor(store, ticket, own);
  if (run === null || run.end?.kind === "retry") return await startGate(ctx, project, spec, ticket, gate.start, own);
  if (run.end === null) await readGate(ctx, project, spec, ticket, gate, run);
}

async function startGate(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, command: string, own: string): Promise<void> {
  const { store } = ctx;
  const url = ticket.pr_url!;
  const sha = ticket.pushed_sha!;
  const settings = repoSettings(spec, ticket.repo);
  // Recorded before the command runs, so a restart or a lost answer never asks for the same review twice.
  store.event(project.id, ticket.id, GATE_STARTED, LOOM_ACTOR, { url, sha, own, round: ticket.pr_rounds });
  store.changed(project.id);
  let answer: HostOutput<"prReviewStart">;
  try {
    const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
    answer = await ctx.host.call(checkout.hostId, "prReviewStart", { repo: checkout.path, url, sha, head: ticket.pr_branch ?? ticket.branch!, base: ticket.pr_base ?? settings.base, command });
  } catch (error) {
    // The call may have reached the gate; its read will tell, or the run times out.
    ctx.bb.log("warn", `Starting ${ticket.key}'s review gate got no answer, so Loom reads the gate for ${sha.slice(0, 12)} as started: ${errText(error)}`);
    return;
  }
  if (answer.outcome === "ok") return;
  store.event(project.id, ticket.id, GATE_START_FAILED, LOOM_ACTOR, { url, sha, own, message: answer.message, transient: answer.transient !== undefined });
  const run = runFor(store, ticket, own);
  if (run?.end?.kind === "failed") gateFailed(ctx, ticket, `Loom could not start the review gate for ${sha.slice(0, 12)}: ${answer.message}`);
  else store.changed(project.id);
}

async function readGate(ctx: EngineCtx, project: ProjectRow, spec: Spec, ticket: TicketRow, gate: ReviewGate, run: GateRun): Promise<void> {
  const { store } = ctx;
  const url = ticket.pr_url!;
  const base = { url, sha: run.sha, own: run.own };
  let answer: HostOutput<"prReviewRead">;
  try {
    const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
    answer = await ctx.host.call(checkout.hostId, "prReviewRead", { repo: checkout.path, url, sha: run.sha, command: gate.read });
  } catch (error) {
    answer = { outcome: "unavailable", message: errText(error), ...hostCallTransient(error) };
  }
  const current = store.ticket(ticket.id);
  if (current === null || current.state !== "pr_open" || current.pr_url !== url) return;
  if (answer.outcome === "unavailable" || answer.state === "pending") {
    if (ctx.now() - run.at >= GATE_TIMEOUT_MINUTES * 60_000) {
      store.event(project.id, ticket.id, GATE_TIMED_OUT, LOOM_ACTOR, base);
      gateFailed(ctx, current, `The review gate for ${run.sha.slice(0, 12)} did not finish within ${GATE_TIMEOUT_MINUTES} minutes${answer.outcome === "unavailable" ? `; its last read failed: ${answer.message}` : ""}.`);
    } else if (answer.outcome === "unavailable" && answer.transient === undefined) {
      store.event(project.id, ticket.id, GATE_DONE, LOOM_ACTOR, { ...base, state: "failed", message: answer.message, findings: [], sent: 0 });
      gateFailed(ctx, current, `Loom could not read the review gate for ${run.sha.slice(0, 12)}: ${answer.message}`);
    }
    return;
  }
  const findings = answer.findings.map((each) => ({ id: each.id, title: each.title, severity: each.severity }));
  if (answer.state === "failed") {
    store.event(project.id, ticket.id, GATE_DONE, LOOM_ACTOR, { ...base, state: "failed", message: answer.message ?? null, findings, sent: 0 });
    gateFailed(ctx, current, `The review gate for ${run.sha.slice(0, 12)} failed${answer.message === undefined ? "" : `: ${answer.message}`}.`);
    return;
  }
  if (answer.findings.length === 0) {
    store.event(project.id, ticket.id, GATE_DONE, LOOM_ACTOR, { ...base, state: "done", findings, sent: 0 });
    store.changed(project.id);
    return;
  }
  // Keyed by the push the run reviews: a finding is sent once per run, and again when it survives the next push of the ticket's own work.
  const keyOf = (id: string) => `gate:${run.own.slice(0, 12)}:${id}`;
  const seen = new Set(readSub(current, "pr_seen_json"));
  const fresh = answer.findings.filter((each, index) => !seen.has(keyOf(each.id)) && answer.findings.findIndex((other) => other.id === each.id) === index);
  const used = store.ticketEvents(ticket.id, [GATE_ROUND]).filter((event) => dataOf(event).url === url).length;
  // Sent already in this run, as when a restart came between the fix round and this record: they still hold the draft.
  if (fresh.length === 0) {
    store.event(project.id, ticket.id, GATE_DONE, LOOM_ACTOR, { ...base, state: "done", findings, sent: 0 });
    store.changed(project.id);
    return;
  }
  if (used >= gate.rounds) {
    store.tx(() => {
      store.event(project.id, ticket.id, GATE_DONE, LOOM_ACTOR, { ...base, state: "done", findings, sent: 0 });
      store.event(project.id, ticket.id, GATE_CAPPED, LOOM_ACTOR, base);
      loomPost(store, current, {
        kind: "merge",
        body: `The review gate still found ${plural(answer.findings.length, "thing")} to fix on ${run.sha.slice(0, 12)} after ${plural(gate.rounds, "fix round")} of its own, the most review_rounds allows, so Loom sends no more and keeps ${url} a draft: ${answer.findings.map((each) => each.title).join("; ")}. Read the findings on the gate, then mark it ready on the forge yourself, or requeue the ticket with a note.`,
        data: { outcome: "gate_capped", url, sha: run.sha, findings },
      });
    });
    store.changed(project.id);
    return;
  }
  const items: FeedbackItem[] = fresh.map((each) => ({ key: keyOf(each.id), kind: "finding", author: "the review gate", bot: false, body: `${each.title}\n\n${each.body}`.trim(), url: null, state: each.severity, path: each.path, line: each.line }));
  if (!(await gateFixRound(ctx, current, items))) return;
  store.event(project.id, ticket.id, GATE_ROUND, LOOM_ACTOR, { ...base, findings: fresh.length });
  store.event(project.id, ticket.id, GATE_DONE, LOOM_ACTOR, { ...base, state: "done", findings, sent: fresh.length });
}

/** A gate that failed holds the publish: one post that says why and what the human can do. */
function gateFailed(ctx: EngineCtx, ticket: TicketRow, why: string): void {
  loomPost(ctx.store, ticket, {
    kind: "merge",
    body: `${why} Loom keeps ${ticket.pr_url} a draft. A fix round's push starts the gate again; or mark it ready on the forge yourself.`,
    data: { outcome: "gate_failed", url: ticket.pr_url },
  });
  ctx.store.changed(ticket.project_id);
}
