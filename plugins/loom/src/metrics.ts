// Flow and agent metrics as pure functions over a project's rows: no store, no clock. Times are epoch
// milliseconds and days are UTC. Flow figures come from the append-only event log, so they can be recomputed at any time.
import type { EventRow, PostRow, ReviewRow, ThreadRow, TicketRow } from "./db/store";
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
  tokens: { total: number; perDoneTicket: number | null; byRole: Record<Role, number> };
  cumulativeFlow: Array<{ day: string } & Record<TicketState, number>>;
  activeMs: number;
}

const DAY_MS = 86_400_000;
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

interface Parsed {
  row: EventRow;
  data: Record<string, unknown>;
}

export function computeMetrics(a: { tickets: TicketRow[]; events: EventRow[]; posts: PostRow[]; threads: ThreadRow[]; reviews: ReviewRow[]; now: number; days?: number }): ProjectMetrics {
  const days = a.days ?? WINDOW_DAYS;
  const events: Parsed[] = [...a.events].sort((x, y) => x.id - y.id).map((row) => ({ row, data: dataOf(row) }));
  const ticketMoves = (ticketId: number) => events.filter((event) => event.row.kind === "ticket.state" && event.row.ticket_id === ticketId);

  const counts = Object.fromEntries(TICKET_STATES.map((state) => [state, 0])) as Record<TicketState, number>;
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

  const window = Array.from({ length: days }, (_, index) => dayStart(a.now) - (days - 1 - index) * DAY_MS);
  const throughput = window.map((start) => ({
    day: dayLabel(start),
    done: events.filter((event) => event.row.kind === "ticket.state" && event.data.to === "done" && event.row.at >= start && event.row.at < start + DAY_MS).length,
  }));

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
    tokens: { total: tokenTotal, perDoneTicket: done.length === 0 ? null : tokenTotal / done.length, byRole: tokens },
    cumulativeFlow: cumulativeFlow(a.tickets, events, createdAt, window),
    activeMs: activeMs(events, a.now),
  };
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

function activeMs(events: Parsed[], now: number): number {
  let total = 0;
  let since: number | null = null;
  for (const event of events) {
    if (event.row.kind !== "project.state") continue;
    if (since !== null) total += event.row.at - since;
    since = event.data.to === "running" ? event.row.at : null;
  }
  return since === null ? total : total + (now - since);
}
