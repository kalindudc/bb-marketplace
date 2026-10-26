// How Loom waits out GitHub when a pull request read fails in a way worth waiting out. A server error or a timeout makes
// that ticket's next read wait longer, 5 minutes after the first failure and doubling to 30, and pauses the project only
// once its reads have failed for an hour. A rate limit stops every read to that forge host, in every project, for 15
// minutes, doubling to an hour, or longer when GitHub names a later time. No wait here ever reads sooner than the usual
// 5 minutes, and nothing reads again within one poll.
import type { TicketRow } from "./db/store";
import { formatDuration, plural } from "./format";

export const POLL_MS = 5 * 60_000;
const LONGEST_POLL_MS = 30 * 60_000;
/** How long a pull request's reads may keep failing with server errors before Loom pauses the project. */
export const SERVER_ERROR_LIMIT_MS = 60 * 60_000;
const FIRST_BACKOFF_MS = 15 * 60_000;
const LONGEST_BACKOFF_MS = 60 * 60_000;
// gh's messages often end with a full stop, and the texts below add their own.
const clause = (message: string) => message.trim().replace(/\.+$/u, "");

/** PollWait: the ticket's pull request reads failed with a server error `failures` times in a row, the first at `since`. */
export interface PollWait {
  failures: number;
  since: number;
  message: string;
}

export const pollWaitOf = (ticket: Pick<TicketRow, "pr_poll_json">): PollWait | null => (ticket.pr_poll_json === null ? null : (JSON.parse(ticket.pr_poll_json) as PollWait));

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

/** The ticket post that starts a streak of failed reads; later failures in it post nothing. */
export function pollWaitText(wait: PollWait): string {
  return `Reading the pull request failed with what looks like a temporary GitHub error: ${clause(wait.message)}. Loom reads it again in ${formatDuration(pollDelayMs(wait.failures))}, waiting longer after each failure up to ${formatDuration(LONGEST_POLL_MS)}, and pauses the project only if the reads keep failing for ${formatDuration(SERVER_ERROR_LIMIT_MS)}.`;
}

/** Why the project pauses once the reads have failed for SERVER_ERROR_LIMIT_MS. */
export function pollWaitReason(ticket: Pick<TicketRow, "key" | "pr_url">, wait: PollWait, now: number): string {
  return `Reading the pull request ${ticket.pr_url ?? ""} of ${ticket.key} failed ${plural(wait.failures, "time")} in a row over ${formatDuration(now - wait.since)}: ${clause(wait.message)}. Resume once GitHub answers again.`;
}

/** HostBackoff: no read goes to the forge host before `until`, after it rate-limited Loom; `delayMs` doubles with each limit until a read succeeds. */
export interface HostBackoff {
  until: number;
  delayMs: number;
  message: string;
}

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

/** 15 minutes for the first rate limit, doubling to an hour while no read succeeds in between, and never before the time GitHub named. */
export function nextBackoff(previous: HostBackoff | undefined, a: { now: number; message: string; retryAfterMs?: number }): HostBackoff {
  const delayMs = previous === undefined ? FIRST_BACKOFF_MS : Math.min(LONGEST_BACKOFF_MS, previous.delayMs * 2);
  return { until: a.now + Math.max(delayMs, a.retryAfterMs ?? 0), delayMs, message: a.message };
}

/** The ticket post for a rate limit: one per backoff, since no read reaches the host again before it ends. */
export function backoffText(host: string, backoff: HostBackoff, now: number): string {
  return `GitHub rate-limited Loom's read of the pull request: ${clause(backoff.message)}. Loom reads no pull request on ${host}, in any project, for ${formatDuration(backoff.until - now)}, and does not pause the project.`;
}
