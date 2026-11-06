// The publish gate: with merge.publish, a pull request stays a draft until it can ship, for the commit Loom pushed, and
// Loom then marks it ready itself through the ready path in drafts.ts. Until then nobody is asked to review it.
import { checkWaitOf, type CheckWait } from "./check-wait";
import type { Store, TicketRow } from "./db/store";
import { plural } from "./format";
import { andList } from "./prompts";
import { rolloutOf } from "./rollout";
import { readSub } from "./sub-state";
import type { Spec } from "./spec";

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
  const waits: string[] = [];
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
