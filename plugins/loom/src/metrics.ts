// Flow and agent metrics as pure functions over a project's rows: no store, no clock. Times are epoch
// milliseconds and days are UTC. Flow figures come from the append-only event log, so they can be recomputed at any time.
import type { EventRow, PostRow, ReviewRow, ThreadRow, TicketRow } from "./db/store";
import type { Finding } from "./review";
import { IN_FLIGHT } from "./scheduler";
import { ROLES, TICKET_STATES, type Role, type TicketState } from "./states";

export interface Pct {
  p50: number | null;
  p85: number | null;
  n: number;
}

export interface ProjectMetrics {
  counts: Record<TicketState, number>;
  wip: number;
  throughput: { day: string; done: number }[];
  cycleTime: Pct;
  leadTime: Pct;
  wipAge: { key: string; state: TicketState; ageMs: number }[];
  firstPassApproval: { rate: number | null; n: number };
  reviewRounds: { mean: number | null; n: number };
  checks: { total: number; failed: number };
  blocks: number;
  humanInterventions: number;
  tokens: { total: number; perDoneTicket: number | null; byRole: Record<Role, number>; unreported: number };
  cumulativeFlow: Array<{ day: string } & Record<TicketState, number>>;
  activeMs: number;
  /** The part of activeMs inside the throughput window. */
  windowActiveMs: number;
  timeInState: { ms: Record<TicketState, number>; flowEfficiency: number | null; n: number };
  checksByCommand: Array<{ command: string; runs: number; failed: number; p50Ms: number | null }>;
  scopeFlags: { outside: number; protectedHits: number };
  findings: { total: number; blocking: number; shouldFix: number; rounds: number; changesRequested: number };
  tokensByTicket: Array<{ key: string; tokens: number }>;
  reliability: { failedAttempts: number; rateLimitRetries: number; timeouts: number; mergesSentBack: number };
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const WINDOW_DAYS = 14;
/** A ticket in one of these states has been approved by its reviewers. */
const APPROVED: readonly TicketState[] = ["approved", "merging", "pr_open", "done"];

/** Nearest-rank percentile; `p` runs from 0 to 100. Null when there are no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
}

const pct = (values: number[]): Pct => ({ p50: percentile(values, 50), p85: percentile(values, 85), n: values.length });
const dayStart = (time: number) => Math.floor(time / DAY_MS) * DAY_MS;
const dayLabel = (start: number) => new Date(start).toISOString().slice(0, 10);
const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
const lastOf = <T>(items: readonly T[], match: (item: T) => boolean): T | undefined => [...items].reverse().find(match);
const dataOf = (row: { data_json: string }) => JSON.parse(row.data_json) as Record<string, unknown>;
const zeroes = () => Object.fromEntries(TICKET_STATES.map((state) => [state, 0])) as Record<TicketState, number>;
const windowOf = (now: number, days: number) => Array.from({ length: days }, (_, index) => dayStart(now) - (days - 1 - index) * DAY_MS);
const TOP_TICKETS = 5;

interface Parsed {
  row: EventRow;
  data: Record<string, unknown>;
}

interface Run {
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/** Tickets moved to done on each UTC day of the window, oldest day first. */
export function throughputOf(events: EventRow[], now: number, days: number): { day: string; done: number }[] {
  const doneAt = events.filter((event) => event.kind === "ticket.state" && dataOf(event).to === "done").map((event) => event.at);
  return windowOf(now, days).map((start) => ({ day: dayLabel(start), done: doneAt.filter((at) => at >= start && at < start + DAY_MS).length }));
}

export function computeMetrics(a: { tickets: TicketRow[]; events: EventRow[]; posts: PostRow[]; threads: ThreadRow[]; reviews: ReviewRow[]; now: number; days?: number }): ProjectMetrics {
  const days = a.days ?? WINDOW_DAYS;
  const events: Parsed[] = [...a.events].sort((x, y) => x.id - y.id).map((row) => ({ row, data: dataOf(row) }));
  const ticketMoves = (ticketId: number) => events.filter((event) => event.row.kind === "ticket.state" && event.row.ticket_id === ticketId);

  const counts = zeroes();
  for (const ticket of a.tickets) counts[ticket.state] += 1;
  const done = a.tickets.filter((ticket) => ticket.state === "done");

  const firstWorking = new Map<number, number>();
  const doneAt = new Map<number, number>();
  const createdAt = new Map<number, number>();
  for (const ticket of a.tickets) {
    const moves = ticketMoves(ticket.id);
    const working = moves.find((event) => event.data.to === "working");
    if (working !== undefined) firstWorking.set(ticket.id, working.row.at);
    const finished = lastOf(moves, (event) => event.data.to === "done");
    if (finished !== undefined) doneAt.set(ticket.id, finished.row.at);
    createdAt.set(ticket.id, events.find((event) => event.row.kind === "ticket.created" && event.row.ticket_id === ticket.id)?.row.at ?? ticket.created_at);
  }

  const window = windowOf(a.now, days);
  const throughput = throughputOf(a.events, a.now, days);

  const cycle = done.flatMap((ticket) => (firstWorking.has(ticket.id) && doneAt.has(ticket.id) ? [doneAt.get(ticket.id)! - firstWorking.get(ticket.id)!] : []));
  const lead = done.flatMap((ticket) => (doneAt.has(ticket.id) ? [doneAt.get(ticket.id)! - createdAt.get(ticket.id)!] : []));

  const wipAge = a.tickets
    .filter((ticket) => IN_FLIGHT.includes(ticket.state) && firstWorking.has(ticket.id))
    .map((ticket) => ({ key: ticket.key, state: ticket.state, ageMs: a.now - firstWorking.get(ticket.id)! }))
    .sort((x, y) => y.ageMs - x.ageMs);

  // The first round that has any verdict decides whether a ticket passed review at the first attempt.
  let withVerdict = 0;
  let firstPass = 0;
  for (const ticket of a.tickets) {
    const decided = a.reviews.filter((review) => review.ticket_id === ticket.id && review.verdict !== "pending");
    if (decided.length === 0) continue;
    withVerdict += 1;
    const first = Math.min(...decided.map((review) => review.round));
    const clean = !decided.some((review) => review.round === first && review.verdict === "changes_requested");
    if (clean && APPROVED.includes(ticket.state)) firstPass += 1;
  }

  const checkData = a.posts.filter((post) => post.kind === "check").map(dataOf);

  const tokens = Object.fromEntries(ROLES.map((role) => [role, 0])) as Record<Role, number>;
  for (const thread of a.threads) tokens[thread.role] += thread.tokens ?? 0;
  const tokenTotal = ROLES.reduce((sum, role) => sum + tokens[role], 0);
  // A thread is sampled about once a minute and when it ends, so one with no tokens after that has a provider that reports none.
  const unreported = a.threads.filter((thread) => thread.tokens === null && (thread.state === "ended" || a.now - thread.started_at >= MINUTE_MS)).length;

  return {
    counts,
    wip: a.tickets.filter((ticket) => IN_FLIGHT.includes(ticket.state)).length,
    throughput,
    cycleTime: pct(cycle),
    leadTime: pct(lead),
    wipAge,
    firstPassApproval: { rate: withVerdict === 0 ? null : firstPass / withVerdict, n: withVerdict },
    reviewRounds: { mean: mean(done.map((ticket) => ticket.review_round)), n: done.length },
    checks: { total: checkData.length, failed: checkData.filter((data) => data.passed === false).length },
    blocks: events.filter((event) => event.row.kind === "ticket.state" && event.data.to === "blocked").length,
    humanInterventions: events.filter((event) => event.row.kind === "human.action" && event.data.action !== "start" && !(event.data.action === "approve" && event.data.pending !== true)).length,
    tokens: { total: tokenTotal, perDoneTicket: done.length === 0 ? null : tokenTotal / done.length, byRole: tokens, unreported },
    cumulativeFlow: cumulativeFlow(a.tickets, events, createdAt, window),
    activeMs: activeMs(events, a.now),
    windowActiveMs: activeMs(events, a.now, window[0]!),
    timeInState: timeInState(done, events, createdAt, doneAt),
    checksByCommand: checksByCommand(checkData),
    scopeFlags: { outside: checkData.filter((data) => nonEmpty(data.outside)).length, protectedHits: checkData.filter((data) => nonEmpty(data.protectedHits)).length },
    findings: findings(a.reviews),
    tokensByTicket: tokensByTicket(a.tickets, a.threads),
    reliability: {
      failedAttempts: a.tickets.reduce((sum, ticket) => sum + ticket.failures, 0),
      rateLimitRetries: events.filter((event) => event.row.kind === "turn.retry").length,
      timeouts: a.threads.filter((thread) => thread.end_reason === "timeout").length,
      mergesSentBack: events.filter((event) => event.row.kind === "ticket.state" && event.data.from === "merging" && (event.data.to === "working" || event.data.to === "queued")).length,
    },
  };
}

const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;

// Each done ticket is queued from its creation, then follows its own state events until its last move to done.
function timeInState(done: TicketRow[], events: Parsed[], createdAt: Map<number, number>, doneAt: Map<number, number>): ProjectMetrics["timeInState"] {
  const ms = zeroes();
  const measured = done.filter((ticket) => doneAt.has(ticket.id));
  for (const ticket of measured) {
    const end = doneAt.get(ticket.id)!;
    const moves = events.filter((event) => event.row.kind === "ticket.state" && event.row.ticket_id === ticket.id && event.row.at <= end);
    let state: TicketState = "queued";
    let since = createdAt.get(ticket.id)!;
    for (const move of moves) {
      ms[state] += Math.max(0, move.row.at - since);
      state = move.data.to as TicketState;
      since = move.row.at;
    }
  }
  const total = TICKET_STATES.reduce((sum, state) => sum + ms[state], 0);
  return { ms, flowEfficiency: measured.length === 0 || total === 0 ? null : ms.working / total, n: measured.length };
}

// The plugin's own refusals are runs too, under the commands "scope check" and "worktree check".
function checksByCommand(checkData: Record<string, unknown>[]): ProjectMetrics["checksByCommand"] {
  const byCommand = new Map<string, Run[]>();
  for (const run of checkData.flatMap((data) => (data.runs as Run[] | undefined) ?? [])) byCommand.set(run.command, [...(byCommand.get(run.command) ?? []), run]);
  return [...byCommand]
    .map(([command, runs]) => ({ command, runs: runs.length, failed: runs.filter((run) => run.exitCode !== 0 || run.timedOut).length, p50Ms: percentile(runs.map((run) => run.durationMs), 50) }))
    .sort((x, y) => y.runs - x.runs || x.command.localeCompare(y.command));
}

// A round is one ticket's review round; with more than one approval required, several reviews share a round.
function findings(reviews: ReviewRow[]): ProjectMetrics["findings"] {
  const decided = reviews.filter((review) => review.verdict !== "pending");
  const all = decided.flatMap((review) => JSON.parse(review.findings_json) as Finding[]);
  const roundOf = (review: ReviewRow) => `${review.ticket_id}:${review.round}`;
  return {
    total: all.length,
    blocking: all.filter((finding) => finding.severity === "blocking").length,
    shouldFix: all.filter((finding) => finding.severity === "should-fix").length,
    rounds: new Set(decided.map(roundOf)).size,
    changesRequested: new Set(decided.filter((review) => review.verdict === "changes_requested").map(roundOf)).size,
  };
}

function tokensByTicket(tickets: TicketRow[], threads: ThreadRow[]): ProjectMetrics["tokensByTicket"] {
  return tickets
    .map((ticket) => ({ key: ticket.key, tokens: threads.filter((thread) => thread.ticket_id === ticket.id).reduce((sum, thread) => sum + (thread.tokens ?? 0), 0) }))
    .filter((entry) => entry.tokens > 0)
    .sort((x, y) => y.tokens - x.tokens || x.key.localeCompare(y.key))
    .slice(0, TOP_TICKETS);
}

// Each ticket starts as queued at its creation, then follows its own state events; a project pause moves no ticket.
function cumulativeFlow(tickets: TicketRow[], events: Parsed[], createdAt: Map<number, number>, window: number[]): ProjectMetrics["cumulativeFlow"] {
  const timelines = tickets.map((ticket) => [
    { at: createdAt.get(ticket.id)!, state: "queued" as TicketState },
    ...events.filter((event) => event.row.kind === "ticket.state" && event.row.ticket_id === ticket.id).map((event) => ({ at: event.row.at, state: event.data.to as TicketState })),
  ]);
  return window.map((start) => {
    const end = start + DAY_MS;
    const row = { day: dayLabel(start), ...Object.fromEntries(TICKET_STATES.map((state) => [state, 0])) } as { day: string } & Record<TicketState, number>;
    for (const timeline of timelines) {
      const state = lastOf(timeline, (entry) => entry.at < end)?.state;
      if (state !== undefined) row[state] += 1;
    }
    return row;
  });
}

// Running spans are cut at `from`, so a span that began before it counts only its part after it.
function activeMs(events: Parsed[], now: number, from = -Infinity): number {
  let total = 0;
  let since: number | null = null;
  const span = (end: number) => Math.max(0, end - Math.max(since!, from));
  for (const event of events) {
    if (event.row.kind !== "project.state") continue;
    if (since !== null) total += span(event.row.at);
    since = event.data.to === "running" ? event.row.at : null;
  }
  return since === null ? total : total + span(now);
}
