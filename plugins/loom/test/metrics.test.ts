import { describe, expect, it } from "vitest";
import type { EventRow, PostRow, ReviewRow, ThreadRow, TicketRow } from "../src/db/store";
import { feedText } from "../src/feed-text";
import { computeMetrics, percentile, throughputOf, type ProjectMetrics } from "../src/metrics";
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
  repo: null,
  pr_branch: null,
  pushed_sha: null,
  pushed_at: null,
  pr_ask_json: null,
  pr_text_json: null,
  pr_seen_json: "[]",
  pr_rounds: 0,
  pr_status_json: null,
  pr_deliver_json: null,
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

const review = (ticketId: number, round: number, verdict: ReviewRow["verdict"], findings: Array<"blocking" | "should-fix"> = []): ReviewRow => ({
  id: id(),
  ticket_id: ticketId,
  round,
  thread_row_id: null,
  verdict,
  summary: null,
  findings_json: JSON.stringify(findings.map((severity) => ({ severity, title: "A finding", detail: "Fix it." }))),
  at: at(1),
});

const thread = (role: ThreadRow["role"], tokens: number | null, over: Partial<ThreadRow> = {}): ThreadRow => ({
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
  attempt: null,
  started_at: at(1),
  clock_at: null,
  ended_at: null,
  end_reason: null,
  ...over,
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

  it("gives 7 days for a 7-day window, the same days throughputOf counts", () => {
    const events = [moved(1, at(3, 5), "merging", "done"), moved(2, at(6, 1), "merging", "done"), moved(3, at(6, 2), "review", "approved")];
    const { throughput } = compute({ events, days: 7 });
    expect(throughput).toHaveLength(7);
    expect(throughput.map((row) => [row.day, row.done])).toEqual([["2025-12-31", 0], ["2026-01-01", 0], ["2026-01-02", 0], ["2026-01-03", 1], ["2026-01-04", 0], ["2026-01-05", 0], ["2026-01-06", 1]]);
    expect(throughputOf(events, at(6, 12), 7)).toEqual(throughput);
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
    expect(compute({ threads, tickets }).tokens).toEqual({ total: 7000, perDoneTicket: 3500, byRole: { planner: 1000, worker: 4000, reviewer: 2000 }, unreported: 1 });
  });

  it("has no per-ticket figure before a ticket is done", () => {
    expect(compute({ threads: [thread("worker", 500)] }).tokens).toMatchObject({ total: 500, perDoneTicket: null });
  });

  it("counts the threads with no tokens that ended or have been live for a minute, as not reported", () => {
    const now = at(6, 12);
    const threads = [
      thread("reviewer", null, { state: "ended", started_at: now - 10_000, ended_at: now }),
      thread("planner", null, { state: "active", started_at: now - 60_000 }),
      thread("worker", null, { state: "active", started_at: now - 59_999 }),
      thread("worker", 0, { state: "ended" }),
      thread("worker", 300, { state: "active", started_at: now - 5 * 60_000 }),
    ];
    expect(compute({ threads, now }).tokens).toMatchObject({ total: 300, unreported: 2 });
    expect(compute().tokens.unreported).toBe(0);
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

  it("counts the running time inside the throughput window apart, cutting a span that starts before it", () => {
    const events = [
      projectMoved(at(1, 1), "ready", "running"),
      projectMoved(at(1, 5), "running", "paused"),
      projectMoved(at(4, 20), "paused", "running"),
      projectMoved(at(5, 3), "running", "paused"),
      projectMoved(at(6, 9), "paused", "running"),
    ];
    const metrics = compute({ events, now: at(6, 12), days: 2 });
    expect(metrics.activeMs).toBe(4 * HOUR + 7 * HOUR + 3 * HOUR);
    expect(metrics.windowActiveMs).toBe(3 * HOUR + 3 * HOUR);
  });
});

describe("time in state", () => {
  it("sums the time each done ticket spent in each state, from its creation to done, and the share spent working", () => {
    const tickets = [ticket(1, "done"), ticket(2, "working")];
    const events = [
      created(1, at(1)),
      moved(1, at(1, 1), "queued", "working"),
      moved(1, at(1, 4), "working", "checking"),
      moved(1, at(1, 5), "checking", "review"),
      moved(1, at(1, 7), "review", "approved"),
      moved(1, at(1, 7), "approved", "merging"),
      moved(1, at(1, 7), "merging", "done"),
      created(2, at(1)),
      moved(2, at(2), "queued", "working"),
    ];
    const { timeInState } = compute({ tickets, events });
    expect(timeInState.ms).toEqual({ queued: HOUR, working: 3 * HOUR, checking: HOUR, review: 2 * HOUR, approved: 0, merging: 0, pr_open: 0, done: 0, blocked: 0, cancelled: 0 });
    expect(timeInState.flowEfficiency).toBeCloseTo(3 / 7);
    expect(timeInState.n).toBe(1);
  });

  it("counts a second spell in a state, and has no flow efficiency before a ticket is done", () => {
    const tickets = [ticket(1, "done")];
    const events = [created(1, at(1)), moved(1, at(1, 1), "queued", "working"), moved(1, at(1, 2), "working", "blocked"), moved(1, at(1, 6), "blocked", "queued"), moved(1, at(1, 7), "queued", "working"), moved(1, at(1, 9), "merging", "done")];
    expect(compute({ tickets, events }).timeInState.ms).toMatchObject({ queued: 2 * HOUR, working: 3 * HOUR, blocked: 4 * HOUR });
    expect(compute({ tickets: [ticket(1, "working")], events: [created(1, at(1))] }).timeInState).toMatchObject({ flowEfficiency: null, n: 0 });
  });
});

describe("checks by command and scope flags", () => {
  const run = (command: string, durationMs: number, exitCode = 0, timedOut = false) => ({ command, exitCode, timedOut, durationMs });

  it("counts each command's runs and failures, with its p50 duration, most runs first", () => {
    const posts = [
      post(1, "check", { passed: false, runs: [run("npm test", 1000), run("npm run lint", 300, 1)], outside: ["README.md"], protectedHits: [] }),
      post(2, "check", { passed: false, runs: [run("npm test", 9000, 0, true)], outside: [], protectedHits: [] }),
      post(2, "check", { passed: false, runs: [run("scope check", 0, 1)], outside: [], protectedHits: [".github/workflows/ci.yml"] }),
      post(2, "check", { passed: false, afterMerge: true }),
      post(1, "note", { runs: [run("npm test", 5)] }),
    ];
    const metrics = compute({ posts });
    expect(metrics.checksByCommand).toEqual([
      { command: "npm test", runs: 2, failed: 1, p50Ms: 1000 },
      { command: "npm run lint", runs: 1, failed: 1, p50Ms: 300 },
      { command: "scope check", runs: 1, failed: 1, p50Ms: 0 },
    ]);
    expect(metrics.scopeFlags).toEqual({ outside: 1, protectedHits: 1 });
  });

  it("is empty before any check ran", () => {
    expect(compute()).toMatchObject({ checksByCommand: [], scopeFlags: { outside: 0, protectedHits: 0 } });
  });
});

describe("review findings", () => {
  it("counts the findings by severity over the reviews with a verdict, and the rounds that asked for changes", () => {
    const reviews = [
      review(1, 1, "changes_requested", ["blocking", "should-fix"]),
      review(1, 2, "approved"),
      review(2, 1, "changes_requested", ["should-fix"]),
      review(2, 2, "pending", ["blocking"]),
      review(3, 1, "approved"),
      review(3, 1, "approved"),
    ];
    expect(compute({ reviews }).findings).toEqual({ total: 3, blocking: 1, shouldFix: 2, rounds: 4, changesRequested: 2 });
  });
});

describe("tokens by ticket", () => {
  it("keeps the 5 tickets whose threads used the most tokens, and leaves out tickets with none", () => {
    const tickets = [1, 2, 3, 4, 5, 6, 7].map((n) => ticket(n, "working"));
    const threads = [
      thread("worker", 100, { ticket_id: 1 }),
      thread("reviewer", 250, { ticket_id: 1 }),
      thread("worker", 500, { ticket_id: 2 }),
      thread("worker", 200, { ticket_id: 3 }),
      thread("worker", 50, { ticket_id: 4 }),
      thread("worker", 400, { ticket_id: 5 }),
      thread("worker", 10, { ticket_id: 6 }),
      thread("worker", null, { ticket_id: 7 }),
      thread("planner", 9000),
    ];
    expect(compute({ tickets, threads }).tokensByTicket).toEqual([
      { key: "CSV-2", tokens: 500 },
      { key: "CSV-5", tokens: 400 },
      { key: "CSV-1", tokens: 350 },
      { key: "CSV-3", tokens: 200 },
      { key: "CSV-4", tokens: 50 },
    ]);
    expect(compute({ tickets: [ticket(1, "queued")], threads: [thread("worker", 0, { ticket_id: 1 })] }).tokensByTicket).toEqual([]);
  });
});

describe("reliability", () => {
  it("counts failed attempts, rate-limit retries, timed-out threads and merges sent back to work", () => {
    const tickets = [ticket(1, "working", { failures: 2 }), ticket(2, "queued", { failures: 1 })];
    const events = [
      event(at(1), "turn.retry", 1, { thread: "thr_1", attempt: 1, sendAt: at(1, 1) }),
      event(at(2), "turn.retry", 1, { thread: "thr_1", attempt: 2, sendAt: at(2, 1) }),
      moved(1, at(3), "merging", "working"),
      moved(2, at(3), "merging", "queued"),
      moved(2, at(4), "merging", "done"),
      moved(2, at(4), "working", "queued"),
    ];
    const threads = [thread("worker", 1, { end_reason: "timeout" }), thread("worker", 1, { end_reason: "abandoned" }), thread("reviewer", 1, { end_reason: "verdict" })];
    expect(compute({ tickets, events, threads }).reliability).toEqual({ failedAttempts: 3, rateLimitRetries: 2, timeouts: 1, mergesSentBack: 2 });
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
    const note = { version: 1, paths: ["project.goal"], body: "Shorter." };
    expect(text(human(at(1), "notes", { notes: [note, note] }))).toBe("The human sent 2 notes on the spec to the planner.");
    expect(text(human(at(1), "notes", { notes: [note] }))).toBe("The human sent 1 note on the spec to the planner.");
    expect(text(projectMoved(at(1), "running", "paused"))).toBe("The project moved from running to paused.");
    expect(text(event(at(1), "project.state", null, { from: "running", to: "paused", reason: "The deadline 2026-01-01 has passed." }))).toBe("The project moved from running to paused: The deadline 2026-01-01 has passed.");
    expect(text(event(at(1), "spec.proposed", null, { version: 2, hash: "x" }, "thr_1"))).toBe("Spec version 2 was proposed.");
    expect(text(event(at(1), "spec.revised", null, { version: 1, hash: "x" }, "thr_1"))).toBe("Spec version 1 was revised.");
    expect(text(event(at(1), "spec.approved", null, { version: 2, pending: true }, "human"))).toBe("Spec version 2 was approved.");
    expect(text(event(at(1), "project.created", null, { slug: "csv" }, "thr_1"))).toBe("The project was created.");
    expect(text(event(at(1), "ticket.edited", 2, { fields: ["title", "scope"] }, "thr_1"))).toBe("CSV-2 was edited: title, scope.");
    expect(text(event(at(1), "turn.retry", 1, { thread: "thr_9", attempt: 2, sendAt: at(1, 1) }))).toBe("CSV-1's worker hit a rate limit; retry 2 is scheduled.");
    expect(text(event(at(1), "project.landed", null, { url: "https://github.com/a/b/pull/1", sha: "abc", created: true }, "human"))).toBe("The integration branch was landed: https://github.com/a/b/pull/1.");
    expect(text(event(at(1), "project.landed", null, { direct: true, pushed: "origin/main", sha: "0123456789abcdef" }, "human"))).toBe("The integration branch was pushed to origin/main at 0123456789ab.");
    expect(text(event(at(1), "record.sent", null, { kind: "summary" }, "loom"))).toBe("The project's summary was sent to the done hook.");
    expect(text(event(at(1), "record.sent", null, { kind: "full", fallback: "the summary agent failed" }, "loom"))).toBe("The project's full record was sent to the done hook, because the summary agent failed.");
    expect(text(event(at(1), "record.failed", null, { kind: "full", reason: "it exited with 1" }, "loom"))).toBe("The done hook failed: it exited with 1.");
  });

  it("says what the spec review did, and names an approval that skipped it", () => {
    const ended = (data: Record<string, unknown>) => text(event(at(1), "spec.review.ended", null, { version: 2, round: 1, findings: 0, ...data }, "loom"));
    expect(text(event(at(1), "spec.review.started", null, { version: 2, round: 1 }, "loom"))).toBe("A spec reviewer started on spec version 2 (round 1).");
    expect(ended({ state: "approved" })).toBe("The spec review passed version 2 in round 1.");
    expect(ended({ state: "changes_requested", findings: 3 })).toBe("The spec review found 3 problems in version 2 in round 1.");
    expect(ended({ state: "changes_requested", findings: 1 })).toBe("The spec review found 1 problem in version 2 in round 1.");
    expect(ended({ state: "failed", reason: "the reviewer's thread was archived or deleted" })).toBe("The spec review of version 2 did not finish: the reviewer's thread was archived or deleted.");
    expect(ended({ state: "superseded" })).toBe("The spec review of version 2 stopped: a newer version or an approval replaced it.");
    expect(text(human(at(1), "approve", { pending: false, skipReview: true }))).toBe("The human approved the spec without a passed spec review.");
    expect(text(human(at(1), "approve", { pending: false }))).toBe("The human ran approve.");
  });

  it("names an event kind it does not know", () => {
    expect(text(event(at(1), "something.new", null))).toBe("something.new by loom.");
  });
});
