import { describe, expect, it } from "vitest";
import type { EventRow, PostRow, ReviewRow, ThreadRow, TicketRow } from "../src/db/store";
import { feedText } from "../src/feed-text";
import { computeMetrics, percentile, type ProjectMetrics } from "../src/metrics";
import { TICKET_STATES, type TicketState } from "../src/states";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const D1 = Date.UTC(2026, 0, 1);
const at = (day: number, hour = 0, minute = 0) => D1 + (day - 1) * DAY + hour * HOUR + minute * 60_000;

let nextId = 0;
const id = () => (nextId += 1);

const ticket = (n: number, state: TicketState, over: Partial<TicketRow> = {}): TicketRow => ({
  id: n,
  project_id: 1,
  seq: n,
  key: `CSV-${n}`,
  ref: `t${n}`,
  title: `Ticket ${n}`,
  body: "",
  acceptance_json: "[]",
  verify_json: "[]",
  scope_json: "[]",
  deps_json: "[]",
  priority: 2,
  state,
  attempt: 1,
  failures: 0,
  check_failures: 0,
  review_round: 0,
  branch: null,
  environment_id: null,
  worker_thread_id: null,
  head_sha: null,
  merge_before: null,
  pr_url: null,
  pr_checked_at: null,
  blocked_reason: null,
  created_by: "human",
  created_at: at(1),
  updated_at: at(1),
  state_at: at(1),
  ...over,
});

const event = (time: number, kind: string, ticketId: number | null, data: object = {}, actor = "loom"): EventRow => ({
  id: id(),
  project_id: 1,
  ticket_id: ticketId,
  at: time,
  kind,
  actor,
  data_json: JSON.stringify(data),
});
const created = (ticketId: number, time: number) => event(time, "ticket.created", ticketId, { key: `CSV-${ticketId}`, ref: `t${ticketId}` }, "human");
const moved = (ticketId: number, time: number, from: TicketState, to: TicketState, data: object = {}) => event(time, "ticket.state", ticketId, { from, to, ...data });
const human = (time: number, action: string, data: object = {}) => event(time, "human.action", null, { action, slug: "csv", ...data }, "human");
const projectMoved = (time: number, from: string, to: string) => event(time, "project.state", null, { from, to }, "human");

const post = (ticketId: number, kind: PostRow["kind"], data: object = {}): PostRow => ({
  id: id(),
  project_id: 1,
  ticket_id: ticketId,
  parent_id: null,
  author_kind: "loom",
  author_thread_id: null,
  kind,
  body: "",
  data_json: JSON.stringify(data),
  at: at(1),
});

const review = (ticketId: number, round: number, verdict: ReviewRow["verdict"]): ReviewRow => ({ id: id(), ticket_id: ticketId, round, thread_row_id: null, verdict, summary: null, findings_json: "[]", at: at(1) });

const thread = (role: ThreadRow["role"], tokens: number | null): ThreadRow => ({
  id: id(),
  thread_id: null,
  spawn_token: null,
  project_id: 1,
  ticket_id: null,
  role,
  state: "ended",
  environment_id: null,
  idle_count: 0,
  rate_limit_retries: 0,
  tokens,
  tokens_at: null,
  review_round: 0,
  started_at: at(1),
  clock_at: null,
  ended_at: null,
  end_reason: null,
});

interface Input {
  tickets?: TicketRow[];
  events?: EventRow[];
  posts?: PostRow[];
  threads?: ThreadRow[];
  reviews?: ReviewRow[];
  now?: number;
  days?: number;
}
const compute = (input: Input = {}): ProjectMetrics => computeMetrics({ tickets: [], events: [], posts: [], threads: [], reviews: [], now: at(6, 12), ...input });

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const ten = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 85)).toBe(9);
    expect(percentile(ten, 100)).toBe(10);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("counts, work in progress and work item age", () => {
  it("counts every state, including empty ones, and the in-flight states as WIP", () => {
    const tickets = [
      ticket(1, "queued"),
      ticket(2, "working"),
      ticket(3, "checking"),
      ticket(4, "review"),
      ticket(5, "approved"),
      ticket(6, "merging"),
      ticket(7, "pr_open"),
      ticket(8, "done"),
      ticket(9, "blocked"),
      ticket(10, "cancelled"),
      ticket(11, "queued"),
    ];
    const metrics = compute({ tickets });
    expect(Object.keys(metrics.counts)).toEqual([...TICKET_STATES]);
    expect(metrics.counts).toMatchObject({ queued: 2, working: 1, done: 1, blocked: 1, cancelled: 1 });
    expect(metrics.wip).toBe(6);
  });

  it("ages each in-flight ticket from its first working event, oldest first", () => {
    const tickets = [ticket(1, "review"), ticket(2, "working"), ticket(3, "queued")];
    const events = [
      created(1, at(1)),
      created(2, at(1)),
      created(3, at(1)),
      moved(2, at(5, 6), "queued", "working"),
      moved(1, at(4), "queued", "working"),
      moved(1, at(4, 2), "working", "checking"),
      moved(1, at(4, 3), "checking", "review"),
      moved(1, at(5), "review", "working"),
    ];
    const metrics = compute({ tickets, events });
    expect(metrics.wipAge).toEqual([
      { key: "CSV-1", state: "review", ageMs: at(6, 12) - at(4) },
      { key: "CSV-2", state: "working", ageMs: at(6, 12) - at(5, 6) },
    ]);
  });
});

describe("throughput", () => {
  it("counts done tickets per UTC day over 14 days, oldest day first", () => {
    const events = [
      moved(1, at(3, 23, 59), "merging", "done"),
      moved(2, at(4), "merging", "done"),
      moved(3, at(4, 10), "merging", "done"),
      moved(4, at(-20), "merging", "done"),
      moved(5, at(6, 11), "review", "approved"),
    ];
    const { throughput } = compute({ events });
    expect(throughput).toHaveLength(14);
    expect(throughput[0]!.day).toBe("2025-12-24");
    expect(throughput.at(-1)!.day).toBe("2026-01-06");
    expect(Object.fromEntries(throughput.filter((row) => row.done > 0).map((row) => [row.day, row.done]))).toEqual({ "2026-01-03": 1, "2026-01-04": 2 });
  });

  it("honours a shorter window", () => {
    expect(compute({ days: 3 }).throughput.map((row) => row.day)).toEqual(["2026-01-04", "2026-01-05", "2026-01-06"]);
  });
});

describe("cycle time and lead time", () => {
  it("measures cycle time from the first working event and lead time from creation, with nearest-rank percentiles", () => {
    const tickets = [ticket(1, "done"), ticket(2, "done"), ticket(3, "done"), ticket(4, "working")];
    const events = [
      created(1, at(1)),
      created(2, at(1)),
      created(3, at(1)),
      created(4, at(1)),
      moved(1, at(1, 1), "queued", "working"),
      moved(1, at(1, 2), "merging", "done"),
      moved(2, at(2), "queued", "working"),
      moved(2, at(2, 2), "working", "checking"),
      moved(2, at(2, 3), "review", "working"),
      moved(2, at(2, 5), "merging", "done"),
      moved(3, at(3), "queued", "working"),
      moved(3, at(3, 9), "merging", "done"),
      moved(4, at(3), "queued", "working"),
    ];
    const metrics = compute({ tickets, events });
    expect(metrics.cycleTime).toEqual({ p50: 5 * HOUR, p85: 9 * HOUR, n: 3 });
    expect(metrics.leadTime).toEqual({ p50: DAY + 5 * HOUR, p85: 2 * DAY + 9 * HOUR, n: 3 });
  });

  it("reports nothing before any ticket is done", () => {
    expect(compute({ tickets: [ticket(1, "working")], events: [created(1, at(1))] }).cycleTime).toEqual({ p50: null, p85: null, n: 0 });
  });
});

describe("first-pass approval and review rounds", () => {
  it("counts approved or done tickets whose first verdict round had no changes requested, out of tickets with a verdict", () => {
    const tickets = [ticket(1, "done", { review_round: 1 }), ticket(2, "done", { review_round: 2 }), ticket(3, "review", { review_round: 1 }), ticket(4, "approved", { review_round: 1 }), ticket(5, "queued")];
    const reviews = [
      review(1, 1, "approved"),
      review(2, 1, "changes_requested"),
      review(2, 2, "approved"),
      review(3, 1, "changes_requested"),
      review(4, 1, "approved"),
      review(4, 1, "pending"),
      review(5, 1, "pending"),
    ];
    const metrics = compute({ tickets, reviews });
    expect(metrics.firstPassApproval).toEqual({ rate: 2 / 4, n: 4 });
    expect(metrics.reviewRounds).toEqual({ mean: 1.5, n: 2 });
  });

  it("is null before any verdict", () => {
    const metrics = compute({ tickets: [ticket(1, "review")], reviews: [review(1, 1, "pending")] });
    expect(metrics.firstPassApproval).toEqual({ rate: null, n: 0 });
    expect(metrics.reviewRounds).toEqual({ mean: null, n: 0 });
  });
});

describe("checks, blocks and human interventions", () => {
  it("counts check posts and the failed ones", () => {
    const posts = [post(1, "check", { passed: true, runs: [] }), post(1, "check", { passed: false, runs: [] }), post(2, "check", { passed: false, afterMerge: true }), post(1, "review"), post(1, "note")];
    expect(compute({ posts }).checks).toEqual({ total: 3, failed: 2 });
  });

  it("counts moves to blocked", () => {
    const events = [moved(1, at(2), "working", "blocked"), moved(1, at(3), "blocked", "queued"), moved(2, at(3), "review", "blocked"), moved(2, at(3), "review", "working")];
    expect(compute({ events }).blocks).toBe(2);
  });

  it("leaves out start and the approve of a draft, and counts every other human action", () => {
    const events = [
      human(at(1), "approve", { pending: false }),
      human(at(1), "start"),
      human(at(2), "pause"),
      human(at(2), "resume"),
      human(at(3), "approve", { pending: true }),
      human(at(3), "post", { key: "CSV-1" }),
      human(at(4), "requeue", { key: "CSV-1" }),
      human(at(4), "cancel", { key: "CSV-2" }),
      created(1, at(1)),
      event(at(1), "post.added", 1, { post: 1 }, "human"),
    ];
    expect(compute({ events }).humanInterventions).toBe(6);
  });
});

describe("tokens", () => {
  it("sums the sampled tokens, by role and per done ticket", () => {
    const threads = [thread("planner", 1000), thread("worker", 4000), thread("worker", null), thread("reviewer", 2000)];
    const tickets = [ticket(1, "done"), ticket(2, "done"), ticket(3, "working")];
    expect(compute({ threads, tickets }).tokens).toEqual({ total: 7000, perDoneTicket: 3500, byRole: { planner: 1000, worker: 4000, reviewer: 2000 } });
  });

  it("has no per-ticket figure before a ticket is done", () => {
    expect(compute({ threads: [thread("worker", 500)] }).tokens).toMatchObject({ total: 500, perDoneTicket: null });
  });
});

describe("cumulative flow", () => {
  it("counts a ticket as queued from its creation until it is first worked on", () => {
    const tickets = [ticket(1, "working")];
    const events = [created(1, at(1, 9)), moved(1, at(3, 10), "queued", "working")];
    const flow = compute({ tickets, events, now: at(5, 12), days: 5 }).cumulativeFlow;
    expect(flow.map((row) => [row.day, row.queued, row.working])).toEqual([
      ["2026-01-01", 1, 0],
      ["2026-01-02", 1, 0],
      ["2026-01-03", 0, 1],
      ["2026-01-04", 0, 1],
      ["2026-01-05", 0, 1],
    ]);
  });

  it("does not count a ticket before it exists and keeps every state key on every row", () => {
    const tickets = [ticket(1, "done"), ticket(2, "queued")];
    const events = [created(1, at(1)), moved(1, at(1, 5), "queued", "working"), moved(1, at(2), "merging", "done"), created(2, at(3, 1))];
    const flow = compute({ tickets, events, now: at(3, 12), days: 3 }).cumulativeFlow;
    expect(flow.map((row) => [row.working, row.done, row.queued])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 1, 1],
    ]);
    for (const row of flow) expect(Object.keys(row)).toEqual(["day", ...TICKET_STATES]);
  });

  it("keeps a ticket in its state across the days a project was paused", () => {
    const tickets = [ticket(1, "working")];
    const events = [created(1, at(1)), moved(1, at(1, 1), "queued", "working"), projectMoved(at(1, 2), "running", "paused"), projectMoved(at(4), "paused", "running")];
    const flow = compute({ tickets, events, now: at(4, 6), days: 4 }).cumulativeFlow;
    expect(flow.map((row) => row.working)).toEqual([1, 1, 1, 1]);
  });
});

describe("active time", () => {
  it("adds up the running spans and leaves out the paused ones", () => {
    const events = [
      projectMoved(at(1), "draft", "ready"),
      projectMoved(at(1, 1), "ready", "running"),
      projectMoved(at(1, 5), "running", "paused"),
      projectMoved(at(2, 5), "paused", "running"),
      projectMoved(at(2, 8), "running", "done"),
    ];
    expect(compute({ events }).activeMs).toBe(4 * HOUR + 3 * HOUR);
  });

  it("counts a project that is still running up to now", () => {
    const events = [projectMoved(at(6, 6), "ready", "running")];
    expect(compute({ events, now: at(6, 9) }).activeMs).toBe(3 * HOUR);
  });

  it("is zero for a project that never ran", () => {
    expect(compute({ events: [projectMoved(at(1), "draft", "ready")] }).activeMs).toBe(0);
  });
});

describe("feedText", () => {
  const keys = new Map([[1, "CSV-1"], [2, "CSV-2"]]);
  const text = (row: EventRow) => feedText(row, keys);

  it("says why a ticket moved", () => {
    expect(text(moved(1, at(1), "review", "working", { round: 2 }))).toBe("CSV-1 moved from review to working: changes requested in round 2.");
    expect(text(moved(1, at(1), "checking", "working", { checkFailures: 2 }))).toBe("CSV-1 moved from checking to working: the checks failed (2 so far).");
    expect(text(moved(1, at(1), "working", "blocked", { reason: "Needs a decision." }))).toBe("CSV-1 moved from working to blocked: Needs a decision.");
    expect(text(moved(2, at(1), "queued", "working", { attempt: 3 }))).toBe("CSV-2 moved from queued to working: attempt 3.");
    expect(text(moved(2, at(1), "queued", "cancelled"))).toBe("CSV-2 moved from queued to cancelled.");
  });

  it("has one sentence for each other kind of event", () => {
    expect(text(created(1, at(1)))).toBe("CSV-1 was created.");
    expect(text(event(at(1), "post.added", 1, { post: 4, kind: "reply", author: "human", parent: null }, "human"))).toBe("The human added a reply to CSV-1.");
    expect(text(event(at(1), "post.added", 1, { post: 5, kind: "check", author: "loom", parent: null }, "loom"))).toBe("Loom added a check to CSV-1.");
    expect(text(event(at(1), "review.verdict", 1, { review: 1, round: 2, verdict: "approved" }, "reviewer"))).toBe("A reviewer approved CSV-1 in round 2.");
    expect(text(event(at(1), "review.verdict", 1, { review: 1, round: 1, verdict: "changes_requested" }, "reviewer"))).toBe("A reviewer asked for changes on CSV-1 in round 1.");
    expect(text(human(at(1), "requeue", { key: "CSV-1" }))).toBe("The human ran requeue on CSV-1.");
    expect(text(human(at(1), "pause", { now: true }))).toBe("The human ran pause.");
    expect(text(projectMoved(at(1), "running", "paused"))).toBe("The project moved from running to paused.");
    expect(text(event(at(1), "project.state", null, { from: "running", to: "paused", reason: "The deadline 2026-01-01 has passed." }))).toBe("The project moved from running to paused: The deadline 2026-01-01 has passed.");
    expect(text(event(at(1), "spec.proposed", null, { version: 2, hash: "x" }, "thr_1"))).toBe("Spec version 2 was proposed.");
    expect(text(event(at(1), "spec.revised", null, { version: 1, hash: "x" }, "thr_1"))).toBe("Spec version 1 was revised.");
    expect(text(event(at(1), "spec.approved", null, { version: 2, pending: true }, "human"))).toBe("Spec version 2 was approved.");
    expect(text(event(at(1), "project.created", null, { slug: "csv" }, "thr_1"))).toBe("The project was created.");
    expect(text(event(at(1), "ticket.edited", 2, { fields: ["title", "scope"] }, "thr_1"))).toBe("CSV-2 was edited: title, scope.");
    expect(text(event(at(1), "turn.retry", 1, { thread: "thr_9", attempt: 2, sendAt: at(1, 1) }))).toBe("CSV-1's worker hit a rate limit; retry 2 is scheduled.");
    expect(text(event(at(1), "project.landed", null, { url: "https://github.com/a/b/pull/1", sha: "abc", created: true }, "human"))).toBe("The integration branch was landed: https://github.com/a/b/pull/1.");
  });

  it("names an event kind it does not know", () => {
    expect(text(event(at(1), "something.new", null))).toBe("something.new by loom.");
  });
});
