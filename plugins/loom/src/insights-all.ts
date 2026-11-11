// Insights across projects, as pure functions over each project's rows: tickets done per week and per day, cycle times
// pooled before their percentiles, review rounds, first-pass approval, time blocked, and tokens by project, repo and
// model. One project is the same read with one project in scope, so the page has one way to read insights at two scopes.
// Times are epoch milliseconds; days are UTC, as metrics.ts counts them.
import type { EventRow, ProjectRow, ReviewRow, ThreadRow, TicketRow } from "./db/store";
import { percentile } from "./metrics";
import type { Role } from "./states";

const DAY_MS = 86_400_000;

export type InsightsWeeks = 4 | 12;

export interface InsightsFigures {
  /** Tickets whose last move to done falls in the range. */
  done: number;
  /** The same count over the stretch of equal length just before the range. */
  donePrevious: number;
  /** From a ticket's first move to working to its move to done, over the tickets done in the range, pooled before the percentiles. */
  cycle: { p50: number | null; p85: number | null; n: number };
  /** Review rounds per ticket done in the range. */
  rounds: { mean: number | null; n: number };
  /** Of the tickets done in the range with a review verdict, the share whose first reviewed round asked for no change. */
  firstPass: { rate: number | null; n: number };
  /** Time tickets spent blocked inside the range. */
  blockedMs: number;
  /** The ticket blocked the longest inside the range. */
  longest: { key: string; ms: number } | null;
  /**
   * Tokens of the agent threads that started in the range. Loom keeps one running total per thread and no usage over
   * time, so a thread counts where it started, all of it: this is not what the range used.
   */
  tokens: number;
  /** Agent threads that started in the range. */
  threads: number;
  /** Of those, the ones that report no tokens yet: their usage is unknown, not zero. */
  unreported: number;
  /** Tokens per ticket done, over the threads that reported; null with nothing done or nothing reported. */
  perDone: number | null;
}

export interface InsightsProjectRow extends InsightsFigures {
  slug: string;
  key: string;
  name: string;
  state: ProjectRow["state"];
  finished: boolean;
  /** Tickets done in each week of the window, oldest first. */
  weekly: number[];
}

export interface InsightsModelRow {
  /** "provider / model"; null for threads Loom did not record a model for, those from before it did and planners. */
  model: string | null;
  role: Role;
  threads: number;
  tokens: number;
  /** Of `threads`, those that report no tokens yet. */
  unreported: number;
  /** For workers: the first-pass rate of the tickets whose first worker ran on this model; null for other roles. */
  firstPass: { rate: number | null; n: number } | null;
}

export interface InsightsRepoRow {
  /** The [[repo]] name; null on a single-repo project. */
  repo: string | null;
  /** The repo's name to show: its [[repo]] name, else the name of the project's bb project; null when bb could not say. */
  name: string | null;
  slug: string;
  key: string;
  tokens: number;
  /** Threads of the repo's tickets that started in the range, and those of them that report no tokens yet. */
  threads: number;
  unreported: number;
  /** Done in the range, of the tickets not cancelled in the repo. */
  done: number;
  total: number;
}

export interface InsightsAllView {
  now: number;
  weeks: InsightsWeeks;
  /** The window the charts draw: from the start of its first day to now. */
  window: { from: number; to: number };
  /** The stretch the figures and tables count, when a person chose one inside the window; null for the whole window. */
  range: { from: number; to: number } | null;
  /** The start of each week and day of the window, oldest first. */
  weekStarts: number[];
  dayStarts: number[];
  totals: InsightsFigures;
  /** Tickets done on each day of the window across the projects in scope, oldest first. */
  daily: number[];
  /** The projects in scope that are not finished, most done first, and every finished one in scope as one row. */
  projects: InsightsProjectRow[];
  finished: (InsightsFigures & { count: number; weekly: number[] }) | null;
  byModel: InsightsModelRow[];
  byRepo: InsightsRepoRow[];
  /** Threads in scope with no recorded model, so the page can say the per-model split is partial. */
  unrecorded: number;
  /** Every project, for choosing the scope. */
  choices: Array<{ slug: string; key: string; name: string; finished: boolean }>;
  /** Loom keeps no prices per model, so it cannot estimate a cost yet. */
  cost: null;
}

export interface InsightsRows {
  project: ProjectRow;
  tickets: readonly TicketRow[];
  events: readonly EventRow[];
  threads: readonly ThreadRow[];
  reviews: readonly ReviewRow[];
}

interface Move {
  ticketId: number;
  at: number;
  from: string | null;
  to: string;
}

const dayStart = (time: number) => Math.floor(time / DAY_MS) * DAY_MS;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[]) => (values.length === 0 ? null : sum(values) / values.length);
const isFinished = (project: ProjectRow) => project.state === "done" || project.state === "archived";

function movesOf(events: readonly EventRow[]): Move[] {
  return events
    .filter((event) => event.kind === "ticket.state" && event.ticket_id !== null)
    .sort((a, b) => a.id - b.id)
    .map((event) => {
      const data = JSON.parse(event.data_json) as { from?: string; to?: string };
      return { ticketId: event.ticket_id!, at: event.at, from: data.from ?? null, to: data.to ?? "" };
    });
}

/** Each project's moves, read once: the figures for several ranges all start from these. */
interface Parsed {
  rows: InsightsRows;
  byTicket: Map<number, Move[]>;
  /** Each ticket's moves to done, oldest first. */
  doneAt: Map<number, number[]>;
}

function parse(rows: InsightsRows): Parsed {
  const byTicket = new Map<number, Move[]>();
  const doneAt = new Map<number, number[]>();
  for (const move of movesOf(rows.events)) {
    byTicket.set(move.ticketId, [...(byTicket.get(move.ticketId) ?? []), move]);
    if (move.to === "done") doneAt.set(move.ticketId, [...(doneAt.get(move.ticketId) ?? []), move.at]);
  }
  return { rows, byTicket, doneAt };
}

/** The tickets whose last move to done before `to` falls at or after `from`, with when. */
function doneIn(parsed: Parsed, from: number, to: number): Array<{ ticket: TicketRow; at: number }> {
  const out: Array<{ ticket: TicketRow; at: number }> = [];
  for (const ticket of parsed.rows.tickets) {
    const times = parsed.doneAt.get(ticket.id);
    if (times === undefined) continue;
    let at: number | undefined;
    for (const time of times) if (time < to) at = time;
    if (at !== undefined && at >= from) out.push({ ticket, at });
  }
  return out;
}

function blockedIn(parsed: Parsed, from: number, to: number): Array<{ key: string; ms: number }> {
  const out: Array<{ key: string; ms: number }> = [];
  for (const ticket of parsed.rows.tickets) {
    const moves = parsed.byTicket.get(ticket.id) ?? [];
    let ms = 0;
    let since: number | null = null;
    for (const move of moves) {
      if (since !== null) ms += Math.max(0, Math.min(move.at, to) - Math.max(since, from));
      since = move.to === "blocked" ? move.at : null;
    }
    if (since !== null) ms += Math.max(0, to - Math.max(since, from));
    if (ms > 0) out.push({ key: ticket.key, ms });
  }
  return out;
}

/** Whether the ticket's first reviewed round asked for no change, or null when no round has a verdict. */
function passedFirst(reviews: readonly ReviewRow[], ticketId: number): boolean | null {
  const decided = reviews.filter((review) => review.ticket_id === ticketId && review.verdict !== "pending");
  if (decided.length === 0) return null;
  const first = Math.min(...decided.map((review) => review.round));
  return !decided.some((review) => review.round === first && review.verdict === "changes_requested");
}

interface Pooled {
  done: number;
  donePrevious: number;
  cycles: number[];
  rounds: number[];
  passes: boolean[];
  blocked: Array<{ key: string; ms: number }>;
  tokens: number;
  threads: number;
  unreported: number;
}

/** A thread bb started; a row whose spawn never went through has no usage to report. */
const spawned = (thread: ThreadRow) => thread.thread_id !== null;
const unreported = (thread: ThreadRow) => spawned(thread) && thread.tokens === null;

function pool(parsed: readonly Parsed[], from: number, to: number, previousFrom: number, now: number): Pooled {
  const out: Pooled = { done: 0, donePrevious: 0, cycles: [], rounds: [], passes: [], blocked: [], tokens: 0, threads: 0, unreported: 0 };
  for (const each of parsed) {
    const done = doneIn(each, from, to);
    out.done += done.length;
    out.donePrevious += doneIn(each, previousFrom, from).length;
    for (const { ticket, at } of done) {
      const working = (each.byTicket.get(ticket.id) ?? []).find((move) => move.to === "working");
      if (working !== undefined && working.at <= at) out.cycles.push(at - working.at);
      out.rounds.push(ticket.review_round);
      const passed = passedFirst(each.rows.reviews, ticket.id);
      if (passed !== null) out.passes.push(passed);
    }
    out.blocked.push(...blockedIn(each, from, Math.min(to, now)));
    for (const thread of each.rows.threads) {
      if (thread.started_at < from || thread.started_at >= to) continue;
      out.tokens += thread.tokens ?? 0;
      if (spawned(thread)) out.threads += 1;
      if (unreported(thread)) out.unreported += 1;
    }
  }
  return out;
}

function figuresOf(pooled: Pooled): InsightsFigures {
  const longest = [...pooled.blocked].sort((a, b) => b.ms - a.ms || a.key.localeCompare(b.key, undefined, { numeric: true }))[0] ?? null;
  return {
    done: pooled.done,
    donePrevious: pooled.donePrevious,
    cycle: { p50: percentile(pooled.cycles, 50), p85: percentile(pooled.cycles, 85), n: pooled.cycles.length },
    rounds: { mean: mean(pooled.rounds), n: pooled.rounds.length },
    firstPass: { rate: pooled.passes.length === 0 ? null : pooled.passes.filter(Boolean).length / pooled.passes.length, n: pooled.passes.length },
    blockedMs: sum(pooled.blocked.map((entry) => entry.ms)),
    longest,
    tokens: pooled.tokens,
    threads: pooled.threads,
    unreported: pooled.unreported,
    perDone: pooled.done === 0 || pooled.threads === pooled.unreported ? null : pooled.tokens / pooled.done,
  };
}

function countByBucket(parsed: readonly Parsed[], starts: readonly number[], size: number, to: number): number[] {
  return starts.map((start) => sum(parsed.map((each) => doneIn(each, start, Math.min(start + size, to)).length)));
}

function byModelOf(parsed: readonly Parsed[], from: number, to: number): InsightsModelRow[] {
  const rows = new Map<string, InsightsModelRow>();
  const passes = new Map<string, boolean[]>();
  for (const each of parsed) {
    for (const thread of each.rows.threads) {
      if (thread.started_at < from || thread.started_at >= to) continue;
      const model = thread.model ?? null;
      const id = `${model ?? ""}\u0000${thread.role}`;
      const row = rows.get(id) ?? { model, role: thread.role, threads: 0, tokens: 0, unreported: 0, firstPass: null };
      row.threads += 1;
      row.tokens += thread.tokens ?? 0;
      if (unreported(thread)) row.unreported += 1;
      rows.set(id, row);
    }
    // A ticket's first worker decides which model its first-pass result counts for.
    for (const { ticket } of doneIn(each, from, to)) {
      const passed = passedFirst(each.rows.reviews, ticket.id);
      if (passed === null) continue;
      const first = each.rows.threads.filter((thread) => thread.ticket_id === ticket.id && thread.role === "worker").sort((a, b) => a.started_at - b.started_at || a.id - b.id)[0];
      if (first === undefined) continue;
      const id = `${first.model ?? ""}\u0000worker`;
      passes.set(id, [...(passes.get(id) ?? []), passed]);
    }
  }
  for (const [id, results] of passes) {
    const row = rows.get(id);
    if (row !== undefined) row.firstPass = { rate: results.filter(Boolean).length / results.length, n: results.length };
  }
  for (const row of rows.values()) if (row.role === "worker" && row.firstPass === null) row.firstPass = { rate: null, n: 0 };
  return [...rows.values()].sort((a, b) => b.tokens - a.tokens || b.threads - a.threads || (a.model ?? "~").localeCompare(b.model ?? "~"));
}

function byRepoOf(parsed: readonly Parsed[], from: number, to: number, names: ReadonlyMap<string, string>): InsightsRepoRow[] {
  const out: InsightsRepoRow[] = [];
  for (const each of parsed) {
    const repos = [...new Set(each.rows.tickets.map((ticket) => ticket.repo))];
    const done = new Set(doneIn(each, from, to).map((entry) => entry.ticket.id));
    for (const repo of repos) {
      const tickets = each.rows.tickets.filter((ticket) => ticket.repo === repo);
      const ids = new Set(tickets.map((ticket) => ticket.id));
      const started = each.rows.threads.filter((thread) => thread.ticket_id !== null && ids.has(thread.ticket_id) && thread.started_at >= from && thread.started_at < to);
      const tokens = sum(started.map((thread) => thread.tokens ?? 0));
      out.push({ repo, name: repo ?? names.get(each.rows.project.bb_project_id) ?? null, slug: each.rows.project.slug, key: each.rows.project.key, tokens, threads: started.filter(spawned).length, unreported: started.filter(unreported).length, done: tickets.filter((ticket) => done.has(ticket.id)).length, total: tickets.filter((ticket) => ticket.state !== "cancelled").length });
    }
  }
  return out.filter((row) => row.total > 0 || row.threads > 0).sort((a, b) => b.tokens - a.tokens || b.done - a.done || a.key.localeCompare(b.key) || (a.repo ?? "").localeCompare(b.repo ?? ""));
}

/**
 * Insights over `weeks` weeks to `now`, for the projects named in `slugs` (every project when it is empty or absent).
 * `range` narrows the figures and tables to a stretch inside the window; the charts keep the whole window. `names` are
 * bb's project names by id, for single-repo projects.
 */
export function insightsAll(all: readonly InsightsRows[], a: { now: number; weeks: InsightsWeeks; range?: { from: number; to: number } | null; slugs?: readonly string[]; names?: ReadonlyMap<string, string> }): InsightsAllView {
  const days = a.weeks * 7;
  const dayStarts = Array.from({ length: days }, (_, index) => dayStart(a.now) - (days - 1 - index) * DAY_MS);
  const weekStarts = dayStarts.filter((_, index) => index % 7 === 0);
  const windowFrom = dayStarts[0]!;
  const end = a.now + 1;
  const range = a.range == null ? null : { from: Math.max(windowFrom, a.range.from), to: Math.min(end, Math.max(a.range.from, a.range.to)) };
  const from = range?.from ?? windowFrom;
  const to = range?.to ?? end;
  const previousFrom = from - (to - from);
  const wanted = a.slugs === undefined || a.slugs.length === 0 ? null : new Set(a.slugs);
  const scoped = all.filter((rows) => wanted === null || wanted.has(rows.project.slug)).map(parse);

  const row = (each: Parsed): InsightsProjectRow => ({
    slug: each.rows.project.slug,
    key: each.rows.project.key,
    name: each.rows.project.name,
    state: each.rows.project.state,
    finished: isFinished(each.rows.project),
    weekly: countByBucket([each], weekStarts, 7 * DAY_MS, end),
    ...figuresOf(pool([each], from, to, previousFrom, a.now)),
  });
  const open = scoped.filter((each) => !isFinished(each.rows.project));
  const closed = scoped.filter((each) => isFinished(each.rows.project));
  const projects = open.map(row).sort((x, y) => y.done - x.done || y.tokens - x.tokens || x.key.localeCompare(y.key));

  return {
    now: a.now,
    weeks: a.weeks,
    window: { from: windowFrom, to: a.now },
    range,
    weekStarts,
    dayStarts,
    totals: figuresOf(pool(scoped, from, to, previousFrom, a.now)),
    daily: countByBucket(scoped, dayStarts, DAY_MS, end),
    projects,
    finished: closed.length === 0 ? null : { count: closed.length, weekly: countByBucket(closed, weekStarts, 7 * DAY_MS, end), ...figuresOf(pool(closed, from, to, previousFrom, a.now)) },
    byModel: byModelOf(scoped, from, to),
    byRepo: byRepoOf(scoped, from, to, a.names ?? new Map()),
    unrecorded: scoped.reduce((total, each) => total + each.rows.threads.filter((thread) => thread.started_at >= from && thread.started_at < to && (thread.model ?? null) === null).length, 0),
    choices: all.map((rows) => ({ slug: rows.project.slug, key: rows.project.key, name: rows.project.name, finished: isFinished(rows.project) })),
    cost: null,
  };
}
