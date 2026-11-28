import type { TavernEvent } from "../shared/schema";

export const nonAlertEventSql = `type NOT LIKE 'alert.%' AND (type <> 'authority.acted' OR coalesce(json_extract(data,'$.act'),'') NOT IN ('alertTestSend','alertTestConfirm'))`;

export const SUMMARY_POSTED = "summary.posted";

/** The event types whose arrival leaves a Keeper with something to act on or report on. */
export const NEWS = new Set([
  "tavern.members-interrupted",
  "report.filed",
  "journal.submitted",
  "journal.reviewed",
  "lead.summary",
  "lead.conclusion-requested",
  "lead.retirement-requested",
  "lead.outcome",
  SUMMARY_POSTED,
  "promise.due",
  "member.rest-reminder",
  "handback.resolved",
  "member.unreported",
  "member.unbriefed",
  "member.brief-refused",
  "ask.answered",
  "ask.cluster-run-ready",
  "ask.cluster-run-failed",
  "ask.defaulted",
  "route.corrected",
  "route.missed",
  "route.cancelled",
  "member.hired",
  "lead.plan-proposed",
  "lead.plan-approved",
  "lead.plan-refused",
  "member.failed",
  "member.stale",
  "member.permanent-quiet",
  "user.told-member",
  "decision.undone",
  "rule.confirmed",
  "rules.changed",
  "reanchor.requested",
  "quest.renamed",
  "quest.stopped",
  "quest.stop-failed",
  "quest.archive-failed",
  "hire.recovered",
  "hire.expired",
  "tick.failed",
  "scope.violation",
  "scope.repeated-refusal",
  "blocker.moved",
  "blocker.assigned",
  "scope.act-held",
  "scope.applied",
  "scope.declined",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
]);

/**
 * Whether one event is news for this Keeper: a type it acts on, not its own action, and not an archive the Keeper itself asked for.
 * Shared by the tick digest and the event-driven wake so both agree on what needs the Keeper.
 */
export function isNewsEvent(event: Pick<TavernEvent, "type" | "actor" | "data">, keeperId: string) {
  return (
    NEWS.has(event.type) &&
    !(event.type === "reanchor.requested" && event.data.actionRequired !== true) &&
    !(event.type === "ask.answered" && event.data.optionId === "confirm-run") &&
    !(event.actor.kind === "agent" && event.actor.threadId === keeperId) &&
    !(event.type === "thread.archived" && event.data.keeperArchiveRequested === true)
  );
}

/**
 * Events that wake a Keeper through the gated tick outside the sweep: a report filed, a party formed (hires dispatched),
 * or an ask answered. Narrower than NEWS so event-driven wakes stay purposeful and do not fight brief delivery.
 */
export const WAKE_NEWS = new Set(["handback.resolved", "report.filed", "journal.reviewed", "member.hired", "lead.plan-proposed", "lead.plan-approved", "lead.plan-refused", "ask.answered", "ask.defaulted", "scope.violation", "blocker.moved", "blocker.assigned"]);

/** Whether one event should wake this Keeper now (a hire it made itself does not need to wake it). */
export function isWakeEvent(event: Pick<TavernEvent, "type" | "actor" | "data">, keeperId: string) {
  if (event.type === "ask.answered" && event.data.optionId === "confirm-run" || event.type === "scope.violation" && event.data.mode === "watch") return false;
  return WAKE_NEWS.has(event.type) && !(event.actor.kind === "agent" && event.actor.threadId === keeperId);
}
