import type { TavernEvent } from "../shared/schema";

/** The event types whose arrival leaves a Keeper with something to act on or report on. */
export const NEWS = new Set([
  "report.filed",
  "promise.due",
  "member.unreported",
  "member.unbriefed",
  "member.briefed",
  "member.brief-refused",
  "ask.answered",
  "ask.defaulted",
  "route.corrected",
  "route.missed",
  "route.cancelled",
  "member.hired",
  "member.failed",
  "member.stale",
  "user.told-member",
  "decision.undone",
  "rule.confirmed",
  "rules.changed",
  "reanchor.requested",
  "quest.stopped",
  "quest.stop-failed",
  "quest.archive-failed",
  "hire.recovered",
  "hire.expired",
  "tick.failed",
  "scope.violation",
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
    !(event.actor.kind === "agent" && event.actor.threadId === keeperId) &&
    !(event.type === "thread.archived" && event.data.keeperArchiveRequested === true)
  );
}

/**
 * Events that wake a Keeper through the gated tick outside the sweep: a report filed, a party formed (hires dispatched),
 * or an ask answered. Narrower than NEWS so event-driven wakes stay purposeful and do not fight brief delivery.
 */
export const WAKE_NEWS = new Set(["report.filed", "member.hired", "ask.answered", "ask.defaulted"]);

/** Whether one event should wake this Keeper now (a hire it made itself does not need to wake it). */
export function isWakeEvent(event: Pick<TavernEvent, "type" | "actor" | "data">, keeperId: string) {
  return WAKE_NEWS.has(event.type) && !(event.actor.kind === "agent" && event.actor.threadId === keeperId);
}
