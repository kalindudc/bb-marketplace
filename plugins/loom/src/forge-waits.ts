// How Loom waits out a forge when a pull request read fails in a way worth waiting out. A server error or a timeout makes
// that ticket's next read wait longer, 5 minutes after the first failure and doubling to 30, and pauses the project only
// once its reads have failed for an hour. A network failure, such as a name that did not resolve, stops every read to that
// forge host, in every project, on the same 5 to 30 minute steps, and pauses only after an hour of them with no read there
// working in between. A rate limit stops every read to the host for 15 minutes, doubling to an hour, or longer when the
// forge names a later time. No wait here ever reads sooner than the usual 5 minutes, and nothing reads again within one poll.
// A merge that fails in a way worth waiting out, a host call that got no answer included, keeps its ticket in merging and
// runs again after 1, 2, 5 and 10 minutes, then every 15, and pauses the project only once it has failed for an hour.
import type { TicketRow } from "./db/store";
import type { Transient } from "./failures";
import { formatDuration, plural } from "./format";
import { readSub, type RetryWait, type PollWait } from "./sub-state";

export const POLL_MS = 5 * 60_000;
const LONGEST_POLL_MS = 30 * 60_000;
/** How long a pull request's reads may keep failing with server errors, or a host's with network errors, before Loom pauses the project. */
export const SERVER_ERROR_LIMIT_MS = 60 * 60_000;
const FIRST_BACKOFF_MS = 15 * 60_000;
const LONGEST_BACKOFF_MS = 60 * 60_000;
// gh's messages often end with a full stop, and a command's with a colon before its empty output; the texts below add their own.
const clause = (message: string) => message.trim().replace(/[.:]+$/u, "");

// The failure rules live in failures.ts; these names stay importable from here.
export { Unavailable, hostCallTransient, transientOf, waitableOf, type Transient } from "./failures";
/** Who a read that failed was waiting on, for pollWaitText and pollWaitReason, when Loom's call to the machine that runs it got no answer. */
export const PROJECT_MACHINE = "the project's machine";

const MERGE_RETRY_MS = [1, 2, 5, 10, 15].map((minutes) => minutes * 60_000);
const LONGEST_MERGE_RETRY_MS = MERGE_RETRY_MS.at(-1)!;

export const mergeWaitOf = (ticket: Pick<TicketRow, "merge_wait_json">): RetryWait | null => readSub(ticket, "merge_wait_json");

/** Whether the ticket's merge waits now. */
export const mergeWaits = (ticket: Pick<TicketRow, "merge_wait_json">, now: number): boolean => (mergeWaitOf(ticket)?.until ?? 0) > now;

/** The wait after one more failure: 1, 2, 5, 10, then 15 minutes; after a rate limit at least 15 minutes, and never before the time the forge named. */
export function nextMergeWait(previous: RetryWait | null, a: Transient & { now: number; message: string }): RetryWait {
  const failures = (previous?.failures ?? 0) + 1;
  const step = MERGE_RETRY_MS[Math.min(failures, MERGE_RETRY_MS.length) - 1]!;
  const delay = a.transient === "rate_limit" ? Math.max(step, FIRST_BACKOFF_MS, a.retryAfterMs ?? 0) : step;
  return { failures, since: previous?.since ?? a.now, until: a.now + delay, message: a.message };
}

/** Whether the failures have gone on long enough to pause the project. */
export const mergeWaitExpired = (wait: RetryWait, now: number): boolean => now - wait.since >= SERVER_ERROR_LIMIT_MS;

/** The ticket post that starts a streak of failed merges; later failures in it post nothing. `what` is the step, such as "Merging CSV-1". */
export function mergeWaitText(what: string, wait: RetryWait, now: number): string {
  return `${what} failed with what looks like a temporary error: ${clause(wait.message)}. Loom tries again in ${formatDuration(wait.until - now)}, waiting longer after each failure up to ${formatDuration(LONGEST_MERGE_RETRY_MS)}, and pauses the project only if it keeps failing for ${formatDuration(SERVER_ERROR_LIMIT_MS)}.`;
}

/** Why the project pauses once the step has failed for SERVER_ERROR_LIMIT_MS. */
export function mergeWaitReason(what: string, wait: RetryWait, now: number): string {
  return `${what} failed ${plural(wait.failures, "time")} in a row over ${formatDuration(now - wait.since)}: ${clause(wait.message)}. Resume once the project's machine and the forge answer again.`;
}

export const pollWaitOf = (ticket: Pick<TicketRow, "pr_poll_json">): PollWait | null => readSub(ticket, "pr_poll_json");

/** 5 minutes; after failed reads in a row, 5, 10, 20, then at most 30 minutes. */
export function pollDelayMs(failures: number): number {
  return Math.min(LONGEST_POLL_MS, POLL_MS * 2 ** Math.max(0, failures - 1));
}

/** When Loom reads the ticket's pull request next, by its own waits; null before Loom read it. */
export function nextPollAt(ticket: Pick<TicketRow, "pr_checked_at" | "pr_poll_json">): number | null {
  return ticket.pr_checked_at === null ? null : ticket.pr_checked_at + pollDelayMs(pollWaitOf(ticket)?.failures ?? 0);
}

/** The wait after one more failed read. */
export function nextPollWait(previous: PollWait | null, a: { now: number; message: string }): PollWait {
  return { failures: (previous?.failures ?? 0) + 1, since: previous?.since ?? a.now, message: a.message };
}

/** The ticket post that starts a streak of failed reads; later failures in it post nothing. `forge` names who answered, GitHub or a command forge's host. */
export function pollWaitText(wait: PollWait, forge = "GitHub"): string {
  const error = forge === PROJECT_MACHINE ? `error on ${forge}` : `${forge} error`;
  return `Reading the pull request failed with what looks like a temporary ${error}: ${clause(wait.message)}. Loom reads it again in ${formatDuration(pollDelayMs(wait.failures))}, waiting longer after each failure up to ${formatDuration(LONGEST_POLL_MS)}, and pauses the project only if the reads keep failing for ${formatDuration(SERVER_ERROR_LIMIT_MS)}.`;
}

/** Why the project pauses once the reads have failed for SERVER_ERROR_LIMIT_MS. */
export function pollWaitReason(ticket: Pick<TicketRow, "key" | "pr_url">, wait: PollWait, now: number, forge = "GitHub"): string {
  return `Reading the pull request ${ticket.pr_url ?? ""} of ${ticket.key} failed ${plural(wait.failures, "time")} in a row over ${formatDuration(now - wait.since)}: ${clause(wait.message)}. Resume once ${forge} answers again.`;
}

/**
 * HostBackoff: no read goes to the forge host before `until`. After a rate limit, `delayMs` doubles with each limit until a
 * read succeeds. After a network failure, `network` counts the failed reads to the host since the first, and `delayMs`
 * follows pollDelayMs.
 */
export interface HostBackoff {
  until: number;
  delayMs: number;
  message: string;
  network?: { failures: number; since: number };
}

/** The backoff of a host whose reads failed with network errors. */
export type NetworkBackoff = HostBackoff & { network: { failures: number; since: number } };

/** The engine's backoffs by forge host, shared by every project. */
export type HostBackoffs = Map<string, HostBackoff>;

/** The host of a pull request URL, which its gh reads go to. */
export function forgeHostOf(url: string | null): string | null {
  return url === null ? null : (/^https?:\/\/([^/\s]+)\//u.exec(url)?.[1]?.toLowerCase() ?? null);
}

/** When reads to the host may go again; null when they may now. */
export function backedOffUntil(backoffs: HostBackoffs, host: string | null, now: number): number | null {
  const until = host === null ? undefined : backoffs.get(host)?.until;
  return until !== undefined && until > now ? until : null;
}

/**
 * 15 minutes for the first rate limit, doubling to an hour while no read succeeds in between, and never before the time the
 * forge named. A rate limit is an answer, so it ends a streak of network failures and starts at 15 minutes after one.
 */
export function nextBackoff(previous: HostBackoff | undefined, a: { now: number; message: string; retryAfterMs?: number }): HostBackoff {
  const delayMs = previous === undefined || previous.network !== undefined ? FIRST_BACKOFF_MS : Math.min(LONGEST_BACKOFF_MS, previous.delayMs * 2);
  return { until: a.now + Math.max(delayMs, a.retryAfterMs ?? 0), delayMs, message: a.message };
}

/** The ticket post for a rate limit: one per backoff, since no read reaches the host again before it ends. */
export function backoffText(host: string, backoff: HostBackoff, now: number, forge = "GitHub"): string {
  return `${forge} rate-limited Loom's read of the pull request: ${clause(backoff.message)}. Loom reads no pull request on ${host}, in any project, for ${formatDuration(backoff.until - now)}, and does not pause the project.`;
}

/**
 * The backoff after one more read to the host failed with a network error: 5, 10, 20, then 30 minutes, as a ticket's server
 * errors wait. A streak whose wait ended more than 30 minutes before this failure is over, since nothing tried the host in
 * between, as when the machine slept, so the failure starts a new one.
 */
export function nextNetworkBackoff(previous: HostBackoff | undefined, a: { now: number; message: string }): NetworkBackoff {
  const ongoing = previous?.network !== undefined && a.now - previous.until <= LONGEST_POLL_MS ? previous.network : undefined;
  const network = { failures: (ongoing?.failures ?? 0) + 1, since: ongoing?.since ?? a.now };
  const delayMs = pollDelayMs(network.failures);
  return { until: a.now + delayMs, delayMs, message: a.message, network };
}

/** The ticket post that starts a host's streak of network failures: one per host and streak, whichever project's read failed first. */
export function networkWaitText(host: string, backoff: NetworkBackoff): string {
  return `Reading the pull request failed because Loom could not reach ${host}: ${clause(backoff.message)}. That looks like a network or name lookup problem on this machine rather than the pull request, so Loom reads no pull request on ${host}, in any project, for ${formatDuration(backoff.delayMs)}, waiting longer after each failure up to ${formatDuration(LONGEST_POLL_MS)}, and pauses the project only if the reads there keep failing for ${formatDuration(SERVER_ERROR_LIMIT_MS)}.`;
}

/** Why the project pauses once the host's reads have failed with network errors for SERVER_ERROR_LIMIT_MS. */
export function networkWaitReason(host: string, backoff: NetworkBackoff, now: number): string {
  const { failures, since } = backoff.network;
  return `Loom could not reach ${host} to read pull requests: its reads failed ${plural(failures, "time")} in a row over ${formatDuration(now - since)}, with none working in between: ${clause(backoff.message)}. Resume once this machine can reach ${host} again.`;
}
