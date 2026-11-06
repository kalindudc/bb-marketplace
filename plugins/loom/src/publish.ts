// The publish gate: with merge.publish, a pull request stays a draft until it can ship, for the commit Loom pushed, and
// Loom then marks it ready itself through the ready path in drafts.ts. Until then nobody is asked to review it. A repo's
// review gate (review-gate.ts runs it) is one of the things it waits for; its state is read here from its ticket events.
import { checkWaitOf, type CheckWait } from "./check-wait";
import type { EventRow, Store, TicketRow } from "./db/store";
import { plural } from "./format";
import { andList } from "./prompts";
import { rolloutOf } from "./rollout";
import { readSub } from "./sub-state";
import { repoSettings } from "./repos";
import type { ForgeSpec, Spec } from "./spec";

const dataOf = (event: EventRow) => JSON.parse(event.data_json) as Record<string, unknown>;

/** Loom ran review_start for `sha`, the head of the push of the ticket's own work `own`; recorded before the command runs. */
export const GATE_STARTED = "ticket.gate_started";
/** review_start failed; a failure that looks temporary lets Loom start it again, GATE_START_TRIES times in all. */
export const GATE_START_FAILED = "ticket.gate_start_failed";
/** review_read said the gate is done or failed, with its findings and how many new ones went to the worker. */
export const GATE_DONE = "ticket.gate_done";
/** The gate did not finish within GATE_TIMEOUT_MINUTES. */
export const GATE_TIMED_OUT = "ticket.gate_timed_out";
/** The gate found more after review_rounds of its fix rounds, so Loom stopped sending them. */
export const GATE_CAPPED = "ticket.gate_capped";
/** A fix round the gate's findings started. */
export const GATE_ROUND = "ticket.gate_round";

export const GATE_TIMEOUT_MINUTES = 90;
const GATE_START_TRIES = 3;
const GATE_ROUNDS = 3;

/** A repo's review gate: its two commands and how many fix rounds it may start. */
export type ReviewGate = { start: string; read: string; rounds: number };

/** The repo's review gate; null when the forge has none. */
export function gateOf(forge: ForgeSpec): ReviewGate | null {
  if (forge.review_start === undefined || forge.review_read === undefined || forge.kind === "none") return null;
  return { start: forge.review_start, read: forge.review_read, rounds: forge.review_rounds ?? GATE_ROUNDS };
}

/** The gate of the ticket's repo when it runs: on a project that publishes its drafts. */
export function runningGate(spec: Spec, ticket: TicketRow) {
  return publishRule(spec) === null ? null : gateOf(repoSettings(spec, ticket.repo).forge);
}

/** The head of the newest push of the ticket's own work to its pull request: its opening or a fix round's push. */
export function ownPush(store: Store, ticket: TicketRow): string | null {
  const posts = store.posts(ticket.id);
  for (let index = posts.length - 1; index >= 0; index -= 1) {
    if (posts[index]!.kind !== "merge") continue;
    const data = JSON.parse(posts[index]!.data_json) as { outcome?: string; url?: string; sha?: string; round?: number };
    if (data.url !== ticket.pr_url || data.sha === undefined) continue;
    if (data.outcome === "pr_opened" || (data.outcome === "pr_pushed" && data.round !== undefined)) return data.sha;
  }
  return null;
}

type RunEnd = { kind: "clean" } | { kind: "findings" } | { kind: "failed"; message: string } | { kind: "capped" } | { kind: "retry" };
export interface GateRun {
  sha: string;
  own: string;
  at: number;
  end: RunEnd | null;
}

/** The newest gate run for the push of the ticket's own work `own`, from its events; null when none started for it. */
export function runFor(store: Store, ticket: TicketRow, own: string): GateRun | null {
  const events = store.ticketEvents(ticket.id, [GATE_STARTED, GATE_START_FAILED, GATE_DONE, GATE_TIMED_OUT, GATE_CAPPED]).filter((event) => dataOf(event).url === ticket.pr_url && dataOf(event).own === own);
  const started = events.filter((event) => event.kind === GATE_STARTED).at(-1);
  if (started === undefined) return null;
  const after = events.filter((event) => event.id > started.id);
  const last = after.at(-1);
  const run = { sha: String(dataOf(started).sha), own, at: started.at };
  if (last === undefined) return { ...run, end: null };
  const data = dataOf(last);
  if (last.kind === GATE_CAPPED) return { ...run, end: { kind: "capped" } };
  if (last.kind === GATE_TIMED_OUT) return { ...run, end: { kind: "failed", message: `it did not finish within ${GATE_TIMEOUT_MINUTES} minutes` } };
  if (last.kind === GATE_START_FAILED) {
    const tries = events.filter((event) => event.kind === GATE_START_FAILED).length;
    return { ...run, end: data.transient === true && tries < GATE_START_TRIES ? { kind: "retry" } : { kind: "failed", message: String(data.message) } };
  }
  if (data.state === "failed") return { ...run, end: { kind: "failed", message: String(data.message ?? "the gate says it failed") } };
  // Clean only when the gate lists nothing for the head; findings it lists still hold the draft, whether sent now or before.
  return { ...run, end: Array.isArray(data.findings) && data.findings.length > 0 ? { kind: "findings" } : { kind: "clean" } };
}

/** Why the gate holds the ticket's draft back from being published, in words; null when it is clean, or there is no gate. */
export function gateWait(store: Store, spec: Spec, ticket: TicketRow): string | null {
  const gate = runningGate(spec, ticket);
  if (gate === null || ticket.pr_url === null) return null;
  const own = ownPush(store, ticket);
  const run = own === null ? null : runFor(store, ticket, own);
  if (run === null || run.end?.kind === "retry") return "its review gate has not started yet";
  if (run.end === null) return `its review gate is still running on ${run.sha.slice(0, 12)}`;
  if (run.end.kind === "failed") return `its review gate failed: ${run.end.message}`;
  if (run.end.kind === "capped") return `its review gate still has findings after ${plural(gate.rounds, "round")}`;
  if (run.end.kind === "findings") return "its review gate's findings are not fixed yet";
  return null;
}

/** What merge.publish waits for, with what it leaves unset: both conditions. */
export function publishRule(spec: Spec): { checks: boolean; live: boolean } | null {
  const publish = spec.merge.publish;
  if (publish === undefined || spec.merge.strategy !== "pr") return null;
  const when = publish.when ?? ["checks", "live"];
  return { checks: when.includes("checks"), live: when.includes("live") };
}

/**
 * Why the ticket's draft is not ready to publish yet, in words; empty when it is, or when the spec does not publish. The
 * checks Loom read must be of the commit it pushed, none pending or failed, and a pull request that reports no check
 * waits out the check settle time after the push. What the ticket's rollout requires must be live.
 */
export function publishWaits(store: Store, spec: Spec, ticket: TicketRow, now: number, wait: CheckWait): string[] {
  const rule = publishRule(spec);
  if (rule === null) return [];
  const gate = gateWait(store, spec, ticket);
  const waits: string[] = gate === null ? [] : [gate];
  if (rule.checks) {
    const status = readSub(ticket, "pr_status_json");
    if (status === null || status.head !== ticket.pushed_sha) waits.push("Loom has not read the checks of the commit it pushed yet");
    else if (status.failed > 0) waits.push(`${plural(status.failed, "check")} failed`);
    else if (status.pending > 0) waits.push(`${plural(status.pending, "check")} ${status.pending === 1 ? "is" : "are"} still running`);
    else if (status.passed === 0 && now < (ticket.pushed_at ?? now) + wait.settleMs) waits.push("no check has reported yet");
  }
  if (rule.live) {
    const step = rolloutOf(spec, store.tickets(ticket.project_id), store.rolloutMarks(ticket.project_id), now)?.stages.flatMap((stage) => stage.steps).find((each) => each.key === ticket.key);
    const waiting = (step?.requires ?? []).filter((need) => !need.live && !need.cancelled && !need.unknown).map((need) => need.target);
    if (waiting.length > 0) waits.push(`${andList(waiting)} ${waiting.length === 1 ? "is" : "are"} not live yet`);
  }
  return waits;
}

/** What a draft Loom is to publish still waits for, for the board, the ticket and the Merge order tab; null for any other pull request. */
export function publishWaitOf(store: Store, spec: Spec, ticket: TicketRow, now: number, wait: CheckWait): string | null {
  if (publishRule(spec) === null || ticket.state !== "pr_open" || ticket.pr_url === null || ticket.keep_draft === 1) return null;
  if (readSub(ticket, "pr_meta_json")?.draft === false) return null;
  const waits = publishWaits(store, spec, ticket, now, wait);
  return waits.length === 0 ? null : waits.join("; ");
}

/** publishWaitOf for each of the spec's project's tickets, by ticket key, as the Merge order tab shows it. */
export function publishWaitsOf(store: Store, spec: Spec, now: number, wait: CheckWait = checkWaitOf({})): Map<string, string | null> {
  const project = store.projectBySlug(spec.project.slug);
  if (project === null || publishRule(spec) === null) return new Map();
  return new Map(store.tickets(project.id).map((ticket) => [ticket.key, publishWaitOf(store, spec, ticket, now, wait)] as const));
}
