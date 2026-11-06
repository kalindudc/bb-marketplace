// How Loom waits out a forge host when calls to it fail for the whole host; forge-gate.ts keeps these backoffs for every
// forge call. A network failure, such as a name that did not resolve, stops every call to that forge host, in every
// project, for 5, 10, 20, then 30 minutes, and a rate limit stops them for 15 minutes, doubling to an hour, or longer
// when the forge names a later time. Neither pauses the project: after an hour of network failures the ticket whose read
// failed says so once more. No read goes out sooner than the usual 5 minutes after the last. A failure of one ticket's
// step waits on the ticket (retry.ts).
import type { TicketRow } from "./db/store";
import type { Transient } from "./failures";
import { formatDuration, plural } from "./format";
import { RETRY_LIMIT_MS, retryDelayMs, retryOf } from "./retry-wait";
import type { RetryWait } from "./sub-state";

export const POLL_MS = 5 * 60_000;
const LONGEST_POLL_MS = 30 * 60_000;
const FIRST_BACKOFF_MS = 15 * 60_000;
const LONGEST_BACKOFF_MS = 60 * 60_000;
// gh's messages often end with a full stop, and a command's with a colon before its empty output; the texts below add their own.
const clause = (message: string) => message.trim().replace(/[.:]+$/u, "");

// The failure rules live in failures.ts; these names stay importable from here.
export { Unavailable, hostCallTransient, transientOf, waitableOf, type Transient } from "./failures";
/** Who a read that failed was waiting on, when Loom's call to the machine that runs it got no answer. */
export const PROJECT_MACHINE = "the project's machine";

/** The wait after one more failure of a step that keeps its own wait, such as a pull request edit, on retry.ts's steps. */
export function nextMergeWait(previous: RetryWait | null, a: Transient & { now: number; message: string }): RetryWait {
  const failures = (previous?.failures ?? 0) + 1;
  const until = a.now + retryDelayMs(failures, { ...(a.retryAfterMs === undefined ? {} : { retryAfterMs: a.retryAfterMs }), rateLimited: a.transient === "rate_limit" });
  return { failures, since: previous?.since ?? a.now, until, message: a.message };
}

/** 5 minutes; after failed reads in a row to a forge host it could not reach, 5, 10, 20, then at most 30 minutes. */
export function pollDelayMs(failures: number): number {
  return Math.min(LONGEST_POLL_MS, POLL_MS * 2 ** Math.max(0, failures - 1));
}

/** When Loom reads the ticket's pull request next: 5 minutes after its last read, or later while the read or the settling of a closed one waits after a failure; null before Loom read it. */
export function nextPollAt(ticket: Pick<TicketRow, "pr_checked_at" | "retry_json">): number | null {
  return ticket.pr_checked_at === null ? null : Math.max(ticket.pr_checked_at + POLL_MS, (retryOf(ticket, "read") ?? retryOf(ticket, "settle"))?.until ?? 0);
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
  /** The streak has gone on for an hour and a ticket said so. */
  noted?: boolean;
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
  return { until: a.now + delayMs, delayMs, message: a.message, network, ...(ongoing !== undefined && previous?.noted === true ? { noted: true } : {}) };
}

/** The ticket post that starts a host's streak of network failures: one per host and streak, whichever project's read failed first. */
export function networkWaitText(host: string, backoff: NetworkBackoff): string {
  return `Reading the pull request failed because Loom could not reach ${host}: ${clause(backoff.message)}. That looks like a network or name lookup problem on this machine rather than the pull request, so Loom reads no pull request on ${host}, in any project, for ${formatDuration(backoff.delayMs)}, waiting longer after each failure up to ${formatDuration(LONGEST_POLL_MS)}. It never pauses the project or blocks a ticket for it.`;
}

/** Whether the host's streak of network failures has gone on for an hour and no ticket has said so yet. */
export const networkWaitLong = (backoff: NetworkBackoff, now: number): boolean => backoff.noted !== true && now - backoff.network.since >= RETRY_LIMIT_MS;

/** The ticket post once the host's reads have failed with network errors for an hour. */
export function networkWaitLongText(host: string, backoff: NetworkBackoff, now: number): string {
  const { failures, since } = backoff.network;
  return `Loom still cannot reach ${host} to read pull requests: its reads failed ${plural(failures, "time")} in a row over ${formatDuration(now - since)}, with none working in between: ${clause(backoff.message)}. Loom keeps trying every ${formatDuration(LONGEST_POLL_MS)} and does not pause the project; check this machine's network if it goes on.`;
}
