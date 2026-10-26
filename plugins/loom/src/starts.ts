// Starting an agent thread: what a failed start means, and how long Loom waits before it tries again. A start that bb
// or the environment provider says cannot happen now waits and counts nothing; any other failed start also waits, and
// counts as a failed attempt only once it has failed START_GRACE times in a row. An unavailable provider blocks the
// ticket once it has been unavailable for UNAVAILABLE_LIMIT_MS.
import type { TicketRow } from "./db/store";
import { formatDuration } from "./format";
import { SpawnRefusedError, SpawnUnavailableError } from "./ports";

/**
 * Why a thread did not start. `unavailable`: bb or the environment provider said it cannot start one now. `refused`: bb
 * refused the request itself, so it would fail again. `failed`: anything else bb or the provider reported, a provisioning
 * failure included. `broken`: Loom could not build the request, so waiting would not help.
 */
export interface StartProblem {
  kind: "unavailable" | "refused" | "failed" | "broken";
  message: string;
}

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function startProblemOf(error: unknown): StartProblem {
  if (error instanceof SpawnUnavailableError) return { kind: "unavailable", message: errText(error) };
  if (error instanceof SpawnRefusedError) return { kind: "refused", message: errText(error) };
  return { kind: "failed", message: errText(error) };
}

/** A thread whose environment bb could not provision; `detail` is the cause bb recorded, such as the provider's message. */
export const provisioningFailure = (failure: { message: string; detail?: string | null }): StartProblem => ({
  kind: "failed",
  message: failure.detail != null && failure.detail.trim() !== "" ? failure.detail.trim() : failure.message,
});

/** Failed starts in a row that count no attempt; from the next one on, each counts against budget.max_attempts. */
export const START_GRACE = 3;
/** How long a ticket waits for an environment provider that says it is unavailable before it blocks, so triage hears of it. */
export const UNAVAILABLE_LIMIT_MS = 60 * 60_000;
const FIRST_RETRY_MS = 60_000;
const LONGEST_RETRY_MS = 15 * 60_000;

/** One minute after the first failed start, doubling to at most 15 minutes. */
export function retryDelayMs(tries: number): number {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, tries - 1));
}

/** A ticket waiting to start its worker, or one of its reviewers, again; kept on the ticket until a thread starts. */
export interface StartWait {
  role: "worker" | "reviewer";
  /** The thread row the next try starts again, so a wait keeps one attempt and one claim on the ticket. */
  row: number | null;
  /** Failed starts in a row. */
  tries: number;
  /** When the first of them failed. */
  since: number;
  /** The earliest time Loom tries again. */
  until: number;
  kind: "unavailable" | "failed";
  reason: string;
  /** Failures in a row, not counting the starts an unavailable provider refused. */
  failedInRow: number;
  /** Whether this failed start counted as a failed attempt. */
  counted: boolean;
  /** When the provider first said it was unavailable in this streak; null while it has not. */
  unavailableSince: number | null;
  /** The provider has been unavailable for UNAVAILABLE_LIMIT_MS, so the wait is over and the ticket blocks. */
  expired: boolean;
}

/** Why a wait on an unavailable provider is over: for how long it was unavailable, and its message. */
export function unavailableReason(wait: StartWait): string {
  return `the environment provider was unavailable for ${formatDuration(UNAVAILABLE_LIMIT_MS)}: ${wait.reason}`;
}

export function waitOf(ticket: Pick<TicketRow, "start_wait_json">, role?: StartWait["role"]): StartWait | null {
  if (ticket.start_wait_json === null) return null;
  const wait = JSON.parse(ticket.start_wait_json) as StartWait;
  return role === undefined || wait.role === role ? wait : null;
}

/** The wait after one more failed start; a wait for the other role starts a new streak. */
export function nextWait(previous: StartWait | null, a: { role: StartWait["role"]; row: number | null; problem: StartProblem; now: number }): StartWait {
  const same = previous !== null && previous.role === a.role;
  const tries = same ? previous.tries + 1 : 1;
  const kind = a.problem.kind === "unavailable" ? "unavailable" : "failed";
  // Only failures count, and only once they have run past the grace; a wait on an unavailable provider never does.
  const failedInRow = (same ? previous.failedInRow : 0) + (kind === "failed" ? 1 : 0);
  const unavailableSince = kind === "unavailable" ? ((same ? previous.unavailableSince : null) ?? a.now) : same ? (previous.unavailableSince ?? null) : null;
  const expired = kind === "unavailable" && a.now - unavailableSince! >= UNAVAILABLE_LIMIT_MS;
  return { role: a.role, row: a.row, tries, since: same ? previous.since : a.now, until: a.now + retryDelayMs(tries), kind, reason: a.problem.message, failedInRow, counted: failedInRow > START_GRACE, unavailableSince, expired };
}

/** Whether a start of `role` for this ticket waits now. */
export function startWaits(ticket: Pick<TicketRow, "start_wait_json">, role: StartWait["role"], now: number): boolean {
  const wait = waitOf(ticket, role);
  return wait !== null && wait.until > now;
}

/** The ticket post for a failed start, or null when the wait goes on for the reason the ticket already shows. */
export function waitPost(who: string, wait: StartWait, previous: StartWait | null, now: number): string | null {
  if (previous !== null && previous.role === wait.role && previous.reason === wait.reason && previous.counted === wait.counted) return null;
  const again = `Loom tries again in ${formatDuration(wait.until - now)}`;
  if (wait.kind === "unavailable") return `Could not start ${who}: ${wait.reason}. ${again}; waiting for the environment provider counts no attempt, and the ticket blocks if it stays unavailable for ${formatDuration(UNAVAILABLE_LIMIT_MS)}.`;
  if (wait.counted) return `Could not start ${who}: ${wait.reason}. ${again}; it has failed ${wait.tries} times in a row, so this counts as a failed attempt.`;
  return `Could not start ${who}: ${wait.reason}. ${again}; a start that fails ${START_GRACE + 1} times in a row counts as a failed attempt.`;
}
