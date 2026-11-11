import { beforeEach, describe, expect, it } from "vitest";
import type { EventRow, ProjectRow, ReviewRow, ThreadRow, TicketRow } from "../src/db/store";
import { insightsAll, type InsightsRows } from "../src/insights-all";
import type { ProjectState, TicketState } from "../src/states";
import { spawnReviewers } from "../src/review";
import { specOf } from "../src/ctx";
import { makeCtx, reachReview, seedProject, ticketOf, type EngineHarness } from "./helpers";

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Tuesday 10 Nov 2026, 14:40 UTC: the brief's fixture clock.
const NOW = Date.UTC(2026, 10, 10, 14, 40);
const daysAgo = (days: number, hours = 0) => NOW - days * DAY - hours * HOUR;

/** One project's rows, built from a few facts per ticket: only the fields Insights reads are filled. */
class Project {
  private next = 0;
  tickets: TicketRow[] = [];
  events: EventRow[] = [];
  threads: ThreadRow[] = [];
  reviews: ReviewRow[] = [];
  constructor(
    private readonly row: { id: number; slug: string; key: string; state?: ProjectState; bb?: string },
  ) {}

  ticket(n: number, state: TicketState, over: { repo?: string | null; rounds?: number } = {}): this {
    this.tickets.push({ id: this.row.id * 100 + n, key: `${this.row.key}-${n}`, repo: over.repo ?? null, state, review_round: over.rounds ?? 0 } as TicketRow);
    return this;
  }
  move(n: number, at: number, from: TicketState, to: TicketState): this {
    this.events.push({ id: ++this.next, project_id: this.row.id, ticket_id: this.row.id * 100 + n, at, kind: "ticket.state", actor: "loom", data_json: JSON.stringify({ from, to }) });
    return this;
  }
  /** Worked from `start` days ago to done `end` days ago. */
  done(n: number, start: number, end: number): this {
    return this.move(n, daysAgo(start), "queued", "working").move(n, daysAgo(end), "review", "done");
  }
  thread(role: ThreadRow["role"], at: number, tokens: number | null, over: { ticket?: number; model?: string | null } = {}): this {
    this.threads.push({ id: this.row.id * 1000 + ++this.next, thread_id: `thr_${this.next}`, ticket_id: over.ticket === undefined ? null : this.row.id * 100 + over.ticket, role, started_at: at, tokens, model: over.model ?? null } as ThreadRow);
    return this;
  }
  review(n: number, round: number, verdict: ReviewRow["verdict"]): this {
    this.reviews.push({ id: ++this.next, ticket_id: this.row.id * 100 + n, round, verdict } as ReviewRow);
    return this;
  }
  rows(): InsightsRows {
    const project = { id: this.row.id, slug: this.row.slug, key: this.row.key, name: `${this.row.key} project`, state: this.row.state ?? "running", bb_project_id: this.row.bb ?? `proj_${this.row.id}` } as ProjectRow;
    return { project, tickets: this.tickets, events: this.events, threads: this.threads, reviews: this.reviews };
  }
}

describe("insights across projects", () => {
  const csv = () =>
    new Project({ id: 1, slug: "csv", key: "CSV" })
      .ticket(1, "done", { rounds: 1 })
      .ticket(2, "done", { rounds: 3 })
      .ticket(3, "blocked")
      .done(1, 3, 2)
      .done(2, 10, 8)
      .move(3, daysAgo(1), "working", "blocked")
      .review(1, 1, "approved")
      .review(2, 1, "changes_requested")
      .review(2, 2, "approved")
      .thread("worker", daysAgo(3), 1_000, { ticket: 1, model: "claude / opus" })
      .thread("worker", daysAgo(10), 4_000, { ticket: 2, model: "claude / opus" })
      .thread("reviewer", daysAgo(2), 500, { ticket: 1, model: "codex / gpt" });
  const lane = () =>
    new Project({ id: 2, slug: "lane", key: "LANE" })
      .ticket(1, "done", { repo: "world" })
      .ticket(2, "pr_open", { repo: "ttc" })
      .ticket(3, "cancelled", { repo: "ttc" })
      .done(1, 20, 1)
      .thread("worker", daysAgo(20), 9_000, { ticket: 1 })
      .thread("worker", daysAgo(4), null, { ticket: 2 });
  const old = () => new Project({ id: 3, slug: "old", key: "OLD", state: "done" }).ticket(1, "done").done(1, 6, 5).thread("worker", daysAgo(6), 2_000, { ticket: 1 });

  it("pools cycle times across projects before taking percentiles, and counts done per week and per day", () => {
    const view = insightsAll([csv().rows(), lane().rows(), old().rows()], { now: NOW, weeks: 4 });
    expect(view.dayStarts).toHaveLength(28);
    expect(view.weekStarts).toHaveLength(4);
    expect(view.window).toEqual({ from: view.dayStarts[0], to: NOW });
    // CSV-1 1d, CSV-2 2d, LANE-1 19d, OLD-1 1d: the pooled median is 1d, which no project's own median says for LANE.
    expect(view.totals.done).toBe(4);
    expect(view.totals.cycle).toEqual({ p50: DAY, p85: 19 * DAY, n: 4 });
    expect(view.daily.reduce((a, b) => a + b, 0)).toBe(4);
    expect(view.daily.at(-2)).toBe(1);
    const byKey = Object.fromEntries(view.projects.map((row) => [row.key, row]));
    expect(byKey.CSV!.weekly).toEqual([0, 0, 1, 1]);
    expect(byKey.LANE!.weekly).toEqual([0, 0, 0, 1]);
    expect(byKey.CSV!.cycle).toEqual({ p50: DAY, p85: 2 * DAY, n: 2 });
  });

  it("keeps finished projects apart as one row, and lists every project as a choice", () => {
    const view = insightsAll([csv().rows(), lane().rows(), old().rows()], { now: NOW, weeks: 4 });
    expect(view.projects.map((row) => row.key)).toEqual(["CSV", "LANE"]);
    expect(view.finished).toMatchObject({ count: 1, done: 1, tokens: 2_000 });
    expect(view.finished!.weekly).toEqual([0, 0, 0, 1]);
    expect(view.choices).toEqual([
      { slug: "csv", key: "CSV", name: "CSV project", finished: false },
      { slug: "lane", key: "LANE", name: "LANE project", finished: false },
      { slug: "old", key: "OLD", name: "OLD project", finished: true },
    ]);
  });

  it("narrows the figures and tables to the projects chosen, and keeps the charts on them too", () => {
    const view = insightsAll([csv().rows(), lane().rows(), old().rows()], { now: NOW, weeks: 4, slugs: ["lane"] });
    expect(view.projects.map((row) => row.key)).toEqual(["LANE"]);
    expect(view.finished).toBeNull();
    expect(view.totals.done).toBe(1);
    expect(view.daily.reduce((a, b) => a + b, 0)).toBe(1);
    expect(view.choices).toHaveLength(3);
  });

  it("counts a chosen stretch in the figures, compares it with the stretch before, and keeps the charts on the whole window", () => {
    const from = daysAgo(3, 12);
    const view = insightsAll([csv().rows(), lane().rows()], { now: NOW, weeks: 4, range: { from, to: NOW } });
    expect(view.range).toEqual({ from, to: NOW });
    // In the last 3.5 days: CSV-1 and LANE-1. In the 3.5 days before: none.
    expect(view.totals.done).toBe(2);
    expect(view.totals.donePrevious).toBe(0);
    expect(view.daily.reduce((a, b) => a + b, 0)).toBe(3);
    // A stretch outside the window is cut to it.
    expect(insightsAll([csv().rows()], { now: NOW, weeks: 4, range: { from: 0, to: NOW } }).range!.from).toBe(insightsAll([csv().rows()], { now: NOW, weeks: 4 }).window.from);
  });

  it("says the previous window's count, review rounds and first-pass approval", () => {
    const twelve = insightsAll([csv().rows()], { now: NOW, weeks: 12 });
    expect(twelve.dayStarts).toHaveLength(84);
    const view = insightsAll([csv().rows()], { now: NOW, weeks: 4 });
    expect(view.totals.rounds).toEqual({ mean: 2, n: 2 });
    // CSV-1 passed its first round, CSV-2 did not.
    expect(view.totals.firstPass).toEqual({ rate: 0.5, n: 2 });
    const week = insightsAll([csv().rows()], { now: NOW, weeks: 4, range: { from: daysAgo(7), to: NOW } });
    expect(week).toMatchObject({ totals: { done: 1, donePrevious: 1 } });
  });

  it("adds up blocked time inside the range and names the ticket blocked longest", () => {
    const rows = csv().ticket(4, "queued").move(4, daysAgo(9), "working", "blocked").move(4, daysAgo(7), "blocked", "queued").rows();
    const view = insightsAll([rows], { now: NOW, weeks: 4 });
    expect(view.totals.blockedMs).toBe(3 * DAY);
    expect(view.totals.longest).toEqual({ key: "CSV-4", ms: 2 * DAY });
    // A range that starts in the middle of a block counts only its part.
    const cut = insightsAll([rows], { now: NOW, weeks: 4, range: { from: daysAgo(8), to: NOW } });
    expect(cut.totals.blockedMs).toBe(2 * DAY);
  });

  it("counts tokens where their thread started, by project, by model and by repo, and says which threads have no model or tokens", () => {
    const view = insightsAll([csv().rows(), lane().rows()], { now: NOW, weeks: 4, names: new Map([["proj_1", "orders-service"]]) });
    expect(view.totals.tokens).toBe(14_500);
    expect(view.totals.unreported).toBe(1);
    expect(view.totals.threads).toBe(5);
    expect(view.totals.perDone).toBe(14_500 / 3);
    expect(view.byModel).toEqual([
      { model: null, role: "worker", threads: 2, tokens: 9_000, unreported: 1, firstPass: { rate: null, n: 0 } },
      { model: "claude / opus", role: "worker", threads: 2, tokens: 5_000, unreported: 0, firstPass: { rate: 0.5, n: 2 } },
      { model: "codex / gpt", role: "reviewer", threads: 1, tokens: 500, unreported: 0, firstPass: null },
    ]);
    expect(view.unrecorded).toBe(2);
    expect(view.byRepo).toEqual([
      { repo: "world", name: "world", slug: "lane", key: "LANE", tokens: 9_000, threads: 1, unreported: 0, done: 1, total: 1 },
      { repo: null, name: "orders-service", slug: "csv", key: "CSV", tokens: 5_500, threads: 3, unreported: 0, done: 2, total: 3 },
      // Its one thread reports nothing: unknown, which the page shows as not recorded, never as 0.
      { repo: "ttc", name: "ttc", slug: "lane", key: "LANE", tokens: 0, threads: 1, unreported: 1, done: 0, total: 1 },
    ]);
  });

  it("never counts an unknown as zero: an old thread's tokens stay out of the window, and a new one with no report is unreported", () => {
    // The review's probe: 900,000 tokens from a thread that started before the window, and a new thread with no report.
    const rows = new Project({ id: 8, slug: "probe", key: "PRB" }).ticket(1, "working").thread("worker", daysAgo(60), 900_000, { ticket: 1 }).thread("worker", daysAgo(2), null, { ticket: 1 }).rows();
    const view = insightsAll([rows], { now: NOW, weeks: 4 });
    expect(view.totals).toMatchObject({ tokens: 0, threads: 1, unreported: 1, perDone: null });
    expect(view.byRepo).toMatchObject([{ tokens: 0, threads: 1, unreported: 1 }]);
    expect(view.byModel).toMatchObject([{ threads: 1, tokens: 0, unreported: 1 }]);
  });

  it("says nothing happened, rather than zero rates, for a project with no work in the window", () => {
    const view = insightsAll([new Project({ id: 9, slug: "new", key: "NEW" }).ticket(1, "queued").rows()], { now: NOW, weeks: 4 });
    expect(view.totals).toMatchObject({ done: 0, cycle: { p50: null, p85: null, n: 0 }, rounds: { mean: null, n: 0 }, firstPass: { rate: null, n: 0 }, blockedMs: 0, longest: null, perDone: null });
    expect(view.cost).toBeNull();
  });
});

describe("the model a thread was spawned with", () => {
  let h: EngineHarness;
  beforeEach(() => {
    h = makeCtx();
  });

  it("is recorded on the worker's and the reviewer's row from the spec's agents, and on no planner", async () => {
    const project = await seedProject(h);
    const worker = await reachReview(h);
    expect(h.store.thread(worker.id)!.model).toBe("claude / sonnet");
    await spawnReviewers(h.ctx, project, specOf(h.store, project));
    const reviewer = h.store.threads({ ticketId: ticketOf(h, "CSV-1").id, role: "reviewer" }).at(-1)!;
    expect(reviewer.model).toBe("codex / gpt");
    expect(h.store.threads({ projectId: project.id, role: "planner" }).map((row) => row.model ?? null)).toEqual(h.store.threads({ projectId: project.id, role: "planner" }).map(() => null));
  });
});
