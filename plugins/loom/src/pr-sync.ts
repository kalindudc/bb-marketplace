// The human's sync: read a project's open pull requests in the next pass instead of at their usual poll. A sync goes
// past each ticket's own wait after failed reads and past a forge host's wait after network failures, since the human
// may have just fixed what failed, but not past a rate limit, which another read would only make longer. The reads are
// the engine's ordinary poll (merge.ts), so what they find is settled exactly as a poll settles it.
import type { TicketRow } from "./db/store";
import { forgeHostOf, nextPollAt, pollWaitOf, type HostBackoff } from "./forge-waits";
import { formatDuration, plural } from "./format";
import { LoomError } from "./projects";
import { andList } from "./prompts";
import { repoSettings } from "./repos";
import type { TicketState } from "./states";
import { specOf, type EngineCtx } from "./workers";

/** How long a sync waits for the pass that reads its pull requests before it answers that they are still being read. */
export const SYNC_WAIT_MS = 30_000;

/**
 * What a sync found for one ticket: `merged` (`landed` on the push-only forge) and `blocked` are the poll's outcomes,
 * `fix` a fix round the feedback started, `moved` any other state the ticket is in now, `open` a pull request with
 * nothing new, and `failed` a read that got no answer or was not made. `waiting` was not read because its forge host
 * rate-limited Loom, and `reading` was still being read when the sync stopped waiting.
 */
export type PrSyncOutcome = "merged" | "landed" | "blocked" | "fix" | "moved" | "open" | "failed" | "waiting" | "reading";

export interface PrSyncTicket {
  key: string;
  state: TicketState;
  outcome: PrSyncOutcome;
  /** Why it is blocked, failed or waiting, or the fix round it started; null otherwise. */
  detail: string | null;
}

export interface PrSyncResult {
  slug: string;
  tickets: PrSyncTicket[];
  /** A few sentences for the page's toast and the CLI. */
  message: string;
  /** Whether a read failed, waits or is still going, or the project paused meanwhile, so the page shows a warning. */
  problem: boolean;
}

/** One sync: its tickets as they were when it was asked for, and the ones a rate limit kept it from asking for. */
export interface PrSyncRequest {
  slug: string;
  projectId: number;
  at: number;
  projectState: string;
  /** Each ticket's fix rounds and failed reads in a row when the sync was asked for, to tell what its read changed. */
  tickets: Array<{ id: number; key: string; rounds: number; failures: number; host: string | null }>;
  waiting: PrSyncTicket[];
}

/**
 * The engine's account of pull request reads, which a sync asks and reads: the tickets the human asked to read in the
 * next poll, the ones whose read is out now (a sync's or the usual poll's), and each open ticket's last answer, an
 * error or null when the read worked. In memory only, so a restart forgets a sync, and the usual poll goes on.
 */
export interface PrReads {
  asked: Set<number>;
  out: Set<number>;
  last: Map<number, { at: number; error: string | null }>;
}

export const newPrReads = (): PrReads => ({ asked: new Set(), out: new Set(), last: new Map() });
const readsOf = (ctx: EngineCtx): PrReads => ctx.prReads ?? (ctx.prReads = newPrReads());

/** A ticket's read goes out: whoever asked for it is answered by this read. */
export function readGoesOut(ctx: EngineCtx, ticketId: number): void {
  const reads = readsOf(ctx);
  reads.asked.delete(ticketId);
  reads.out.add(ticketId);
}

/** What the read of a ticket's pull request got: null when the forge answered, else why it did not. */
export function noteAnswer(ctx: EngineCtx, ticketId: number, error: string | null): void {
  readsOf(ctx).last.set(ticketId, { at: ctx.now(), error });
}

/** Forgets the reads of the project's tickets whose pull request is no longer open, and of tickets that are gone. */
export function forgetClosedReads(ctx: EngineCtx, projectId: number): PrReads {
  const reads = readsOf(ctx);
  const closed = (id: number) => {
    const ticket = ctx.store.ticket(id);
    return ticket === null || (ticket.project_id === projectId && ticket.state !== "pr_open");
  };
  for (const id of reads.asked) if (closed(id)) reads.asked.delete(id);
  for (const id of reads.last.keys()) if (closed(id)) reads.last.delete(id);
  return reads;
}

const UNANSWERED: readonly PrSyncOutcome[] = ["failed", "waiting", "reading"];
const clause = (text: string) => text.trim().replace(/\.+$/u, "");

/** Why no read goes to a forge host now: a rate limit, or the network wait after reads there could not reach it. */
function hostWait(host: string, backoff: HostBackoff, now: number): string {
  const left = formatDuration(backoff.until - now);
  return backoff.network === undefined ? `${host} rate-limited Loom's reads for ${left} more` : `Loom could not reach ${host} (${clause(backoff.message)}), so it tries again in ${left}`;
}

/**
 * Asks the next poll to read the project's open pull requests, or only `key`'s. Refused when the project is not running
 * or paused, when it has no pull request per ticket, or when there is no open pull request to read.
 */
export function requestSync(ctx: EngineCtx, slug: string, key?: string): PrSyncRequest {
  const { store } = ctx;
  const project = store.projectBySlug(slug);
  if (project === null) throw new LoomError("loom_not_found", `No Loom project named "${slug}".`, "Run `bb loom list` to see the projects.");
  if (project.state !== "running" && project.state !== "paused") throw new LoomError("loom_invalid_state", `Project ${slug} is ${project.state}; Loom reads pull requests only while a project is running or paused.`);
  const spec = specOf(store, project);
  if (spec.merge.strategy !== "pr") throw new LoomError("loom_invalid_state", `Project ${slug} merges into its integration branch, so it has no pull request per ticket to read.`);
  const followed = (ticket: TicketRow) => ticket.state === "pr_open" && (ticket.pr_url !== null || repoSettings(spec, ticket.repo).forge.kind === "none");
  let tickets: TicketRow[];
  if (key === undefined) {
    tickets = store.tickets(project.id, ["pr_open"]).filter(followed);
    if (tickets.length === 0) throw new LoomError("loom_invalid_state", `No pull request of ${slug} is open, so there is nothing to read.`);
  } else {
    const ticket = store.ticketByKey(key);
    if (ticket === null || ticket.project_id !== project.id) throw new LoomError("loom_not_found", `Project ${slug} has no ticket ${key}.`, `Run \`bb loom tickets ${slug}\` to see its tickets.`);
    if (!followed(ticket)) throw new LoomError("loom_invalid_state", `${key} has no open pull request for Loom to read: it is ${ticket.state.replace("_", " ")}.`);
    tickets = [ticket];
  }

  const now = ctx.now();
  const reads = readsOf(ctx);
  const request: PrSyncRequest = { slug, projectId: project.id, at: now, projectState: project.state, tickets: [], waiting: [] };
  for (const ticket of tickets) {
    const host = repoSettings(spec, ticket.repo).forge.kind === "none" ? null : forgeHostOf(ticket.pr_url);
    const entry = { id: ticket.id, key: ticket.key, rounds: ticket.pr_rounds, failures: pollWaitOf(ticket)?.failures ?? 0, host };
    // A read that is out now answers the sync, so asking for another would read the pull request twice.
    if (reads.out.has(ticket.id)) {
      request.tickets.push(entry);
      continue;
    }
    const backoff = host === null ? undefined : ctx.forgeBackoffs.get(host);
    if (backoff !== undefined && backoff.until > now) {
      if (backoff.network === undefined) {
        request.waiting.push({ key: ticket.key, state: ticket.state, outcome: "waiting", detail: hostWait(host!, backoff, now) });
        continue;
      }
      // The wait ends now and its streak stays, so a read that fails again waits longer and still pauses after an hour.
      ctx.forgeBackoffs.set(host!, { ...backoff, until: now });
    }
    reads.asked.add(ticket.id);
    request.tickets.push(entry);
  }
  return request;
}

/** What the request's tickets are now, once the pass that read them finished (`finished`) or the sync stopped waiting for it. */
export function syncResult(ctx: EngineCtx, request: PrSyncRequest, finished: boolean): PrSyncResult {
  const { store } = ctx;
  const now = ctx.now();
  const reads = readsOf(ctx);
  const project = store.project(request.projectId);
  const paused = request.projectState === "running" && project?.state === "paused" ? project.system_reason : null;
  const tickets: PrSyncTicket[] = request.tickets.map(({ id, key, rounds, failures, host }) => {
    const ticket = store.ticket(id)!;
    const of = (outcome: PrSyncOutcome, detail: string | null = null): PrSyncTicket => ({ key, state: ticket.state, outcome, detail });
    if (ticket.state === "done") return of(host === null ? "landed" : "merged");
    if (ticket.state === "blocked") return of("blocked", ticket.blocked_reason);
    if (ticket.state !== "pr_open") return ticket.pr_rounds > rounds ? of("fix", `fix round ${ticket.pr_rounds}`) : of("moved");
    const last = reads.last.get(id);
    const answer = last !== undefined && last.at >= request.at ? last : null;
    if (answer !== null && answer.error === null) return of("open");
    // A server error or timeout counts one more failure on the ticket; a read that worked clears them.
    const wait = pollWaitOf(ticket);
    const waits = (wait?.failures ?? 0) > failures;
    // The poll takes a ticket off `asked` as its read goes out.
    const unread = reads.asked.has(id);
    if (answer === null && !waits && (!finished || reads.out.has(id))) return of("reading");
    if (waits) return of("failed", `${clause(wait!.message)}; Loom reads it again in ${formatDuration(Math.max(0, nextPollAt(ticket)! - now))}`);
    const backoff = host === null ? undefined : ctx.forgeBackoffs.get(host);
    if (backoff !== undefined && backoff.until > now) return of(unread && backoff.network === undefined ? "waiting" : "failed", hostWait(host!, backoff, now));
    if (answer !== null) return of("failed", answer.error);
    return of("failed", paused ?? (unread ? "Loom did not get to it in this pass, so it reads it in the next one" : "the forge gave no answer"));
  });
  const all = [...tickets, ...request.waiting];
  const stopped = request.projectState === "running" && project?.state === "paused";
  const told = paused !== null && all.some((ticket) => ticket.detail === paused);
  const note = !stopped ? null : paused === null ? "The project was paused meanwhile." : told ? "Loom paused the project." : `Loom paused the project: ${clause(paused)}.`;
  const message = [syncMessage(all), ...(note === null ? [] : [note])].join(" ");
  return { slug: request.slug, tickets: all, message, problem: note !== null || all.some((ticket) => UNANSWERED.includes(ticket.outcome)) };
}

/** The sync in a few sentences: what the answers changed, then each read that failed, what waits, and what is still being read. */
export function syncMessage(tickets: readonly PrSyncTicket[]): string {
  if (tickets.length === 1) return `${oneSentence(tickets[0]!)}.`;
  const keys = (outcome: PrSyncOutcome) => tickets.filter((ticket) => ticket.outcome === outcome).map((ticket) => ticket.key);
  const sentences: string[] = [];
  const answered = tickets.filter((ticket) => !UNANSWERED.includes(ticket.outcome)).length;
  if (answered > 0) {
    const changes = [
      ...listed(keys("merged"), "merged", "merged"),
      ...listed(keys("landed"), "landed on its base branch", "landed on their base branches"),
      ...tickets.filter((ticket) => ticket.outcome === "blocked").map((ticket) => `${ticket.key} is blocked${ticket.detail === null ? "" : ` (${clause(ticket.detail)})`}`),
      ...tickets.filter((ticket) => ticket.outcome === "fix").map((ticket) => `${ticket.key}'s feedback started ${ticket.detail}`),
      ...tickets.filter((ticket) => ticket.outcome === "moved").map((ticket) => `${ticket.key} is ${ticket.state.replace("_", " ")} now`),
    ];
    const open = keys("open").length;
    const still = open === 0 ? [] : changes.length > 0 ? [`${open} ${open === 1 ? "is" : "are"} still open`] : [open === 1 ? "nothing new, it is still open" : `nothing new, all ${open} are still open`];
    sentences.push(`Read ${plural(answered, "pull request")}: ${andList([...changes, ...still])}.`);
  }
  for (const ticket of tickets.filter((each) => each.outcome === "failed")) sentences.push(`${oneSentence(ticket)}.`);
  // Each forge host waits for its own rate limit.
  const waiting = new Map<string, string[]>();
  for (const ticket of tickets.filter((each) => each.outcome === "waiting")) {
    const why = ticket.detail ?? "the forge rate-limited Loom";
    waiting.set(why, [...(waiting.get(why) ?? []), ticket.key]);
  }
  for (const [why, held] of waiting) sentences.push(`Not read: ${andList(held)}, because ${clause(why)}.`);
  const reading = keys("reading");
  if (reading.length > 0) sentences.push(`Loom is still reading ${andList(reading)}; the page updates when it is done.`);
  return sentences.join(" ");
}

const listed = (keys: string[], one: string, many: string) => (keys.length === 0 ? [] : [`${andList(keys)} ${keys.length === 1 ? one : many}`]);

function oneSentence(ticket: PrSyncTicket): string {
  const { key, detail } = ticket;
  switch (ticket.outcome) {
    case "merged":
      return `${key}'s pull request merged, so ${key} is done`;
    case "landed":
      return `${key}'s branch landed on its base branch, so ${key} is done`;
    case "blocked":
      return `${key} is blocked${detail === null ? "" : `: ${clause(detail)}`}`;
    case "fix":
      return `${key}'s pull request has new feedback, which started ${detail}`;
    case "moved":
      return `${key} is ${ticket.state.replace("_", " ")} now`;
    case "open":
      return `Read ${key}'s pull request: nothing new, it is still open`;
    case "failed":
      return `Could not read ${key}'s pull request: ${clause(detail ?? "the forge did not answer")}`;
    case "waiting":
      return `Did not read ${key}'s pull request, because ${clause(detail ?? "the forge rate-limited Loom")}`;
    case "reading":
      return `Loom is still reading ${key}'s pull request; the page updates when it is done`;
  }
}

/** Resolves true once `pass` settles, or false after `ms`. */
export function within(pass: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    pass.then(done, done);
  });
}
