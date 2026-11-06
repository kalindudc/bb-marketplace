// The wait of a ticket's step that failed, and what a failure means for the ticket (retry.ts acts on it): the step waits
// and tries again after 1, 2, 5 and 10 minutes, then every 15, at least 15 after a rate limit and never before the
// time the forge named. A leaf module, so the forge waits can read a ticket's wait without an import cycle.
import type { TicketRow } from "./db/store";
import type { Failure } from "./failures";
import { formatDuration, plural } from "./format";
import { readSub, type RetryStep, type RetryWait } from "./sub-state";

const MINUTE = 60_000;
const STEPS_MS = [1, 2, 5, 10, 15].map((minutes) => minutes * MINUTE);
export const LONGEST_RETRY_MS = STEPS_MS.at(-1)!;
const RATE_LIMIT_MS = 15 * MINUTE;
/** How long a ticket's step may keep failing before the ticket blocks, or a forge's or machine's before the ticket says so again. */
export const RETRY_LIMIT_MS = 60 * MINUTE;
/** Tries of a step whose failure no rule recognized, before the ticket blocks. */
export const UNRECOGNIZED_TRIES = 5;

// gh's messages often end with a full stop, and a command's with a colon before its empty output; the texts below add their own.
const clause = (message: string) => message.trim().replace(/[.:]+$/u, "");

/** The ticket's wait for `step`; a wait from before steps were named is a merge's. */
export function retryOf(ticket: Pick<TicketRow, "retry_json">, step: RetryStep): RetryWait | null {
  const wait = readSub(ticket, "retry_json");
  return wait !== null && (wait.step ?? "merge") === step ? wait : null;
}

/** Whether the ticket's `step` waits now. */
export const retryWaits = (ticket: Pick<TicketRow, "retry_json">, step: RetryStep, now: number): boolean => (retryOf(ticket, step)?.until ?? 0) > now;

/** The delay after the `failures`th failure in a row. */
export function retryDelayMs(failures: number, failure: Pick<Failure, "retryAfterMs" | "rateLimited"> = {}): number {
  const step = STEPS_MS[Math.min(failures, STEPS_MS.length) - 1]!;
  return failure.rateLimited === true ? Math.max(step, RATE_LIMIT_MS, failure.retryAfterMs ?? 0) : Math.max(step, failure.retryAfterMs ?? 0);
}

/**
 * The wait after one more failure of `step`. A streak goes on from a wait of the same step (and head, when it has one)
 * that ended at most one longest step before this failure; any other wait is over, so this failure starts a new streak.
 * `floorMs` is the step's own pace, such as a pull request's read every 5 minutes, which no wait runs sooner than.
 */
export function nextRetry(previous: RetryWait | null, a: { step: RetryStep; now: number; failure: Failure; head?: string; floorMs?: number }): RetryWait {
  const ongoing = previous !== null && (previous.step ?? "merge") === a.step && previous.head === a.head && a.now - previous.until <= LONGEST_RETRY_MS ? previous : null;
  const failures = (ongoing?.failures ?? 0) + 1;
  const delay = Math.max(a.floorMs ?? 0, a.failure.kind === "lasting" ? LONGEST_RETRY_MS : retryDelayMs(failures, a.failure));
  return {
    step: a.step,
    ...(a.head === undefined ? {} : { head: a.head }),
    failures,
    since: ongoing?.since ?? a.now,
    until: a.now + delay,
    message: a.failure.reason,
    kind: a.failure.kind,
    scope: a.failure.scope,
    ...(ongoing?.noted === true ? { noted: true } : {}),
  };
}

export type RetryDecision = { do: "wait"; wait: RetryWait; post: string | null } | { do: "block"; reason: string } | { do: "pause"; reason: string };

/** What a failure of `what` (such as "Merging CSV-1") means for its ticket, given the ticket's wait so far. */
export function decide(previous: RetryWait | null, a: { step: RetryStep; what: string; now: number; failure: Failure; head?: string; floorMs?: number }): RetryDecision {
  const { failure, what, now } = a;
  const said = clause(failure.reason);
  if (failure.scope === "project") return { do: "pause", reason: `${what} stopped: ${said}. ${failure.fix ?? "Fix it, then resume the project."}` };
  if (failure.kind === "lasting" && failure.scope === "ticket") return { do: "block", reason: `${what} failed, and trying again would not help: ${said}.` };
  const wait = nextRetry(previous, a);
  const over = now - wait.since;
  const again = formatDuration(wait.until - now);
  if (failure.scope === "ticket") {
    const tried = !failure.known && wait.failures >= UNRECOGNIZED_TRIES;
    if (over >= RETRY_LIMIT_MS || tried) return { do: "block", reason: `${what} failed ${plural(wait.failures, "time")} in a row over ${formatDuration(over)}: ${said}. Loom blocked this ticket; the rest of the project keeps running.` };
    if (wait.failures > 1) return { do: "wait", wait, post: null };
    const bound = failure.known ? `and blocks this ticket only if it keeps failing for ${formatDuration(RETRY_LIMIT_MS)}` : `and, since it does not recognize this error, blocks this ticket if ${UNRECOGNIZED_TRIES} tries in a row fail`;
    const opener = failure.kind === "unknown" ? `${what} got no answer, so Loom cannot tell whether it ran: ${said}. Each step first checks what is already done, so nothing is done twice.` : `${what} failed with what looks like a temporary error: ${said}.`;
    return { do: "wait", wait, post: `${opener} Loom tries again in ${again}, waiting longer after each failure up to ${formatDuration(LONGEST_RETRY_MS)}, ${bound}. The project keeps running.` };
  }
  const where = failure.scope === "forge" ? "the forge" : "the project's machine";
  if (wait.failures === 1 || (over >= RETRY_LIMIT_MS && wait.noted !== true)) {
    const late = wait.failures > 1;
    const posted = late ? { ...wait, noted: true } : wait;
    if (failure.kind === "lasting") return { do: "wait", wait: { ...posted, noted: true }, post: `${what} failed because of the state of the checkout on ${where}: ${said}. Someone has to put the checkout right; Loom tries again every ${formatDuration(LONGEST_RETRY_MS)} and does not pause the project or block the ticket for it.` };
    if (late) return { do: "wait", wait: posted, post: `${what} has failed ${plural(wait.failures, "time")} in a row over ${formatDuration(over)}, because of ${where}: ${said}. Loom keeps trying every ${formatDuration(LONGEST_RETRY_MS)}; a problem of ${where} never blocks this ticket or pauses the project.` };
    const opener = failure.kind === "unknown" ? `${what} got no answer from ${where}, so Loom cannot tell whether it ran: ${said}. Each step first checks what is already done, so nothing is done twice.` : `${what} failed because of ${where}: ${said}.`;
    return { do: "wait", wait: posted, post: `${opener} Loom tries again in ${again}, waiting longer after each failure up to ${formatDuration(LONGEST_RETRY_MS)}. A problem of ${where} never blocks this ticket or pauses the project.` };
  }
  return { do: "wait", wait, post: null };
}
