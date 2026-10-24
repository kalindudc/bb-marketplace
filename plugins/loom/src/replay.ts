// A project as it was at one event, rebuilt from its rows and the append-only event log, and the timeline the page
// scrubs through. Pure functions over rows, so the views of a past moment run the same code as the live ones.
import type { EventRow, PostRow, ProjectRow, ReviewRow, RunRow, Store, ThreadRow, TicketRow } from "./db/store";
import { feedText } from "./feed-text";
import type { ProjectOverview } from "./projects";
import { LoomError } from "./projects";
import type { Spec } from "./spec";
import type { ProjectState, Role, TicketState } from "./states";

export interface ProjectRows {
  project: ProjectRow;
  tickets: TicketRow[];
  threads: ThreadRow[];
  events: EventRow[];
  posts: PostRow[];
  reviews: ReviewRow[];
  runs: RunRow[];
}

/** The rows as they were at event `eventId` (N), at time `at` (T). */
export interface PastRows extends ProjectRows {
  eventId: number;
  at: number;
  /** The spec in force: the approved version, else the newest proposed one. */
  specVersion: number;
}

export interface TicketBar {
  key: string;
  title: string;
  from: number;
  to: number;
  parts: Array<{ from: number; to: number; state: TicketState }>;
  /** When checks, a review or a merge sent the ticket back to work, or a merge sent it back to the queue. */
  sentBack: number[];
  final: "done" | "cancelled" | null;
}

export type MomentKind = "you" | "trouble" | "milestone" | "done" | "move";

/** A change the board, the header or the health strip shows. Posts and edits only add text, so they are not moments. */
export interface Moment {
  /** The moment's last event, which the page rewinds to, and its time. */
  id: number;
  at: number;
  /** The kind of its most telling line. */
  kind: MomentKind;
  /** One sentence per event, as the Feed writes it; `key` is the ticket it is about. */
  lines: Array<{ kind: MomentKind; text: string; key: string | null }>;
}

export interface SessionBar {
  key: string | null;
  role: Exclude<Role, "planner">;
  label: string;
  from: number;
  to: number;
  endReason: string | null;
}

export interface ProjectTimeline {
  /** The project's state now. */
  state: ProjectState;
  start: number;
  end: number;
  /** The last event of each distinct time, in id order. */
  events: Array<[id: number, at: number]>;
  project: Array<{ from: number; to: number; state: ProjectState }>;
  /** In order; the timeline steps through these. */
  moments: Moment[];
  ticketCount: number;
  tickets: TicketBar[];
  sessions: SessionBar[];
  /** Tickets that ever blocked or were sent back to work. */
  trouble: string[];
}

interface Parsed {
  row: EventRow;
  data: Record<string, unknown>;
}

const parse = (events: readonly EventRow[]): Parsed[] => events.map((row) => ({ row, data: JSON.parse(row.data_json) as Record<string, unknown> }));
const numberIn = (data: Record<string, unknown>, field: string) => (typeof data[field] === "number" ? (data[field] as number) : undefined);
const lastOf = <T>(items: readonly T[], match: (item: T) => boolean): T | undefined => [...items].reverse().find(match);
const lastNumber = (events: readonly Parsed[], field: string) => lastOf(events, (event) => numberIn(event.data, field) !== undefined)?.data[field] as number | undefined;
const ofKind = (events: readonly Parsed[], kind: string) => events.filter((event) => event.row.kind === kind);

export function rowsOf(store: Store, project: ProjectRow): ProjectRows {
  const tickets = store.tickets(project.id);
  return {
    project,
    tickets,
    threads: store.threadsForProject(project.id),
    events: store.projectEvents(project.id),
    posts: store.postsForProject(project.id),
    reviews: store.reviewsForProject(project.id),
    runs: tickets.flatMap((ticket) => store.runs(ticket.id)),
  };
}

/** The rows at the project's newest event at or below `eventId`, moved on to the last event of that millisecond, because one transaction can write several rows at one time. */
export function rewind(rows: ProjectRows, eventId: number): PastRows {
  let index = rows.events.filter((event) => event.id <= eventId).length - 1;
  if (index < 0) throw new LoomError("loom_not_found", `Event ${eventId} is before ${rows.project.slug} started.`);
  const at = rows.events[index]!.at;
  while (rows.events[index + 1]?.at === at) index += 1;
  const events = rows.events.slice(0, index + 1);
  const later = rows.events.slice(index + 1);
  const past = parse(events);

  const projectMove = ofKind(past, "project.state").at(-1);
  const state = (projectMove?.data.to as ProjectState | undefined) ?? "draft";
  const approved = lastNumber(ofKind(past, "spec.approved"), "version") ?? null;
  const proposed = ofKind(past, "spec.proposed").flatMap((event) => numberIn(event.data, "version") ?? []);
  const newest = proposed.length === 0 ? null : Math.max(...proposed);
  // A direct land carries no url, and the stored pr_url stays from an earlier land.
  const landed = lastOf(ofKind(past, "project.landed"), (event) => typeof event.data.url === "string");
  const project: ProjectRow = {
    ...rows.project,
    state,
    system_reason: (projectMove?.data.reason as string | undefined) ?? null,
    approved_version: approved,
    pending_version: newest !== null && approved !== null && newest > approved && state !== "draft" ? newest : null,
    pr_url: (landed?.data.url as string | undefined) ?? null,
  };

  const threads = rows.threads
    .filter((row) => row.started_at <= at)
    .map((row): ThreadRow => (row.ended_at !== null && row.ended_at <= at ? row : { ...row, state: row.thread_id === null ? "spawning" : "active", ended_at: null, end_reason: null, tokens: 0, tokens_at: null }));

  const created = new Map(ofKind(past, "ticket.created").map((event) => [event.row.ticket_id, event.row.at]));
  const moves = ofKind(past, "ticket.state");
  const movedLater = new Set(later.filter((event) => event.kind === "ticket.state").map((event) => event.ticket_id));
  const tickets = rows.tickets
    .filter((ticket) => created.has(ticket.id))
    .map((ticket): TicketRow => {
      const own = moves.filter((event) => event.row.ticket_id === ticket.id);
      const last = own.at(-1);
      const ticketState = (last?.data.to as TicketState | undefined) ?? "queued";
      // A ticket that has not moved since the moment still has the failure count and block reason it had then.
      const settled = !movedLater.has(ticket.id);
      const worker = threads.find((row) => row.role === "worker" && row.ticket_id === ticket.id && row.state === "active");
      return {
        ...ticket,
        state: ticketState,
        state_at: last?.row.at ?? created.get(ticket.id)!,
        attempt: lastNumber(own, "attempt") ?? 0,
        review_round: lastNumber(own, "round") ?? 0,
        failures: settled ? ticket.failures : (lastNumber(own, "failures") ?? 0),
        blocked_reason: ticketState !== "blocked" ? null : settled ? ticket.blocked_reason : ((last!.data.reason as string | undefined) ?? ticket.blocked_reason),
        pr_url: ticketState === "pr_open" || ticketState === "done" ? ticket.pr_url : null,
        worker_thread_id: worker?.thread_id ?? null,
      };
    });
  for (const edit of parse(later.filter((event) => event.kind === "ticket.edited")).reverse()) {
    const ticket = tickets.find((row) => row.id === edit.row.ticket_id);
    const before = edit.data.before;
    if (ticket !== undefined && typeof before === "object" && before !== null) Object.assign(ticket, before);
  }

  const lastPost = Math.max(0, ...ofKind(past, "post.added").flatMap((event) => numberIn(event.data, "post") ?? []));
  const decided = new Set(ofKind(past, "review.verdict").flatMap((event) => numberIn(event.data, "review") ?? []));
  return {
    project,
    tickets,
    threads,
    events,
    posts: rows.posts.filter((post) => post.id <= lastPost),
    reviews: rows.reviews.filter((review) => review.at <= at).map((review): ReviewRow => (decided.has(review.id) ? review : { ...review, verdict: "pending", summary: null, findings_json: "[]" })),
    runs: rows.runs
      .filter((run) => run.started_at <= at)
      .map((run): RunRow => (run.ended_at !== null && run.ended_at <= at ? run : { ...run, ended_at: null, ok: null, exit_code: null, duration_ms: null, timed_out: 0 })),
    eventId: events.at(-1)!.id,
    at,
    // A project's first event can come a millisecond before its first spec version.
    specVersion: approved ?? newest ?? 1,
  };
}

/** The overview fields that change over time, at the moment `past` shows; `spec` is the version in force then. */
export function overviewAt(
  past: PastRows,
  spec: Spec,
): Pick<ProjectOverview, "state" | "approvedVersion" | "pendingVersion" | "reason" | "ticketCount" | "ticketCounts" | "goal" | "base" | "strategy" | "branch"> {
  const ticketCounts: Partial<Record<TicketState, number>> = {};
  for (const ticket of past.tickets) ticketCounts[ticket.state] = (ticketCounts[ticket.state] ?? 0) + 1;
  return {
    state: past.project.state,
    approvedVersion: past.project.approved_version,
    pendingVersion: past.project.pending_version,
    reason: past.project.system_reason,
    ticketCount: past.tickets.length,
    ticketCounts,
    goal: spec.project.goal,
    base: spec.project.base,
    strategy: spec.merge.strategy,
    branch: spec.merge.branch ?? null,
  };
}

const FINAL: readonly TicketState[] = ["done", "cancelled"];
const MOMENT_EVENTS = new Set(["project.created", "project.state", "project.landed", "spec.proposed", "spec.approved", "ticket.created", "ticket.state", "review.verdict", "human.action"]);
/** Events this close to the one before come from one action or one engine pass. */
const MOMENT_GAP_MS = 2_000;
/** Most telling first. */
const MOMENT_RANK: readonly MomentKind[] = ["you", "trouble", "milestone", "done", "move"];

const sentBack = (from: unknown, to: unknown) => (to === "working" && (from === "review" || from === "checking" || from === "merging")) || (from === "merging" && to === "queued");
const troubleMove = (from: unknown, to: unknown) => to === "blocked" || sentBack(from, to);

function lineKind(event: Parsed): MomentKind {
  const { kind } = event.row;
  if (kind === "human.action") return "you";
  if (kind === "ticket.state") return troubleMove(event.data.from, event.data.to) ? "trouble" : event.data.to === "done" ? "done" : "move";
  return kind.startsWith("project.") || kind.startsWith("spec.") ? "milestone" : "move";
}

function momentsOf(events: readonly Parsed[], keys: Map<number, string>): Moment[] {
  type Line = Moment["lines"][number] & { created: boolean };
  const moments: Array<{ id: number; at: number; kind: MomentKind; lines: Line[] }> = [];
  for (const event of events) {
    // Your replies are posts, and posts only add text.
    if (!MOMENT_EVENTS.has(event.row.kind) || (event.row.kind === "human.action" && event.data.action === "post")) continue;
    const kind = lineKind(event);
    const key = event.row.ticket_id === null ? null : (keys.get(event.row.ticket_id) ?? null);
    const line = { kind, text: feedText(event.row, keys, { you: true }), key, created: event.row.kind === "ticket.created" };
    const open = moments.at(-1);
    if (open !== undefined && event.row.at - open.at < MOMENT_GAP_MS) {
      open.id = event.row.id;
      open.at = event.row.at;
      open.lines.push(line);
      if (MOMENT_RANK.indexOf(kind) < MOMENT_RANK.indexOf(open.kind)) open.kind = kind;
      continue;
    }
    moments.push({ id: event.row.id, at: event.row.at, kind, lines: [line] });
  }
  return moments.map(({ id, at, kind, lines }) => {
    const created = lines.filter((line) => line.created).length;
    const first = lines.findIndex((line) => line.created);
    // A spec's tickets are created in one burst, so one line counts them, where the first one was.
    const shown = created <= 2 ? lines : lines.flatMap((line, index) => (!line.created ? [line] : index === first ? [{ ...line, text: `${created} tickets were created.`, key: null }] : []));
    return { id, at, kind, lines: shown.map((line) => ({ kind: line.kind, text: line.text, key: line.key })) };
  });
}

/** The whole project over time. A running or paused project's timeline runs to `now`; any other ends at its last event. */
export function projectTimeline(rows: ProjectRows, now: number): ProjectTimeline {
  const events = parse(rows.events);
  const start = rows.events[0]?.at ?? now;
  const end = rows.project.state === "running" || rows.project.state === "paused" ? now : (rows.events.at(-1)?.at ?? now);
  const keyOf = new Map(rows.tickets.map((ticket) => [ticket.id, ticket.key]));

  const project: ProjectTimeline["project"] = [];
  let state: ProjectState = "draft";
  let since = start;
  for (const move of ofKind(events, "project.state")) {
    project.push({ from: since, to: move.row.at, state });
    state = move.data.to as ProjectState;
    since = move.row.at;
  }
  project.push({ from: since, to: end, state });

  const moves = ofKind(events, "ticket.state");
  const tickets = rows.tickets.flatMap((ticket): TicketBar[] => {
    const own = moves.filter((event) => event.row.ticket_id === ticket.id);
    const first = own.findIndex((event) => event.data.to === "working");
    if (first < 0) return [];
    const span = own.slice(first);
    const finished = lastOf(span, (event) => FINAL.includes(event.data.to as TicketState));
    const to = finished?.row.at ?? end;
    const parts = span.flatMap((move, index) => {
      const part = move.data.to as TicketState;
      return FINAL.includes(part) ? [] : [{ from: move.row.at, to: span[index + 1]?.row.at ?? to, state: part }];
    });
    const back = span.filter((move) => sentBack(move.data.from, move.data.to)).map((move) => move.row.at);
    const final = (finished?.data.to ?? null) as TicketBar["final"];
    return [{ key: ticket.key, title: ticket.title, from: span[0]!.row.at, to, parts, sentBack: back, final }];
  });

  const sessions = rows.threads.flatMap((row): SessionBar[] => {
    if (row.role === "planner" || row.thread_id === null) return [];
    const label = row.role === "reviewer" ? `round ${row.review_round}` : row.attempt === null ? "" : `attempt ${row.attempt}`;
    return [{ key: row.ticket_id === null ? null : (keyOf.get(row.ticket_id) ?? null), role: row.role, label, from: row.started_at, to: row.ended_at ?? end, endReason: row.end_reason }];
  });

  const troubled = new Set(moves.filter((move) => troubleMove(move.data.from, move.data.to)).map((move) => move.row.ticket_id));

  return {
    state: rows.project.state,
    start,
    end,
    events: rows.events.flatMap((event, index): Array<[number, number]> => (rows.events[index + 1]?.at === event.at ? [] : [[event.id, event.at]])),
    project,
    moments: momentsOf(events, keyOf),
    ticketCount: rows.tickets.length,
    tickets,
    sessions,
    trouble: rows.tickets.filter((ticket) => troubled.has(ticket.id)).map((ticket) => ticket.key),
  };
}
