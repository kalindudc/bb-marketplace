import { describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { EngineHarness } from "./helpers";
import { LoomError } from "../src/projects";
import { projectTimeline, rewind, rowsOf } from "../src/replay";
import { approve, requestChanges, settleReviews, spawnReviewers } from "../src/review";
import { endThread, requeueTicket, specOf } from "../src/workers";
import { checkOutHead, makeCtx, seedProject, specToml, startWorker, ticketOf } from "./helpers";

const MINUTE = 60_000;
const projectOf = (h: EngineHarness) => h.store.projectBySlug("csv")!;
const rowsNow = (h: EngineHarness) => rowsOf(h.store, projectOf(h));
const lastEvent = (h: EngineHarness) => h.store.projectEvents(projectOf(h).id).at(-1)!;
const reviewerOf = (h: EngineHarness, key = "CSV-1") => h.store.threads({ ticketId: ticketOf(h, key).id, role: "reviewer" }).at(-1)!;

/** A worker that submits a minute after it starts and reaches review a minute later. */
async function toReview(h: EngineHarness, key = "CSV-1") {
  const row = await startWorker(h, key);
  const worktree = h.host.worktree(`/wt/${row.environment_id}`);
  worktree.dirty = true;
  worktree.changed = ["src/model/a.ts"];
  h.clock.advance(MINUTE);
  submit(h.ctx, row.thread_id!, "Done");
  h.clock.advance(MINUTE);
  await settleChecks(h.ctx);
  return row;
}

const note = (h: EngineHarness, key: string, body: string) =>
  h.store.addPost({ project_id: projectOf(h).id, ticket_id: ticketOf(h, key).id, parent_id: null, author_kind: "human", author_thread_id: null, kind: "note", body });

describe("rewind", () => {
  it("shows a ticket in review as it was, with its worker live and its review still pending", async () => {
    const h = makeCtx();
    const project = await seedProject(h);
    h.clock.advance(MINUTE);
    const worker = await toReview(h);
    const reviewAt = h.store.ticketEvents(ticketOf(h, "CSV-1").id, ["ticket.state"]).at(-1)!.at;
    h.clock.advance(MINUTE);
    await spawnReviewers(h.ctx, project, specOf(h.store, project));
    h.clock.advance(MINUTE);
    note(h, "CSV-1", "Looking at it.");
    const moment = lastEvent(h).id;
    h.clock.advance(MINUTE);
    checkOutHead(h, reviewerOf(h));
    await approve(h.ctx, reviewerOf(h).thread_id!, "Looks good");
    await settleReviews(h.ctx);
    h.clock.advance(MINUTE);
    h.store.updateThread(worker.id, { state: "ended", ended_at: h.clock.t, end_reason: "merged", tokens: 1200, tokens_at: h.clock.t });

    const past = rewind(rowsNow(h), moment);
    const ticket = past.tickets.find((row) => row.key === "CSV-1")!;
    expect(ticket).toMatchObject({ state: "review", state_at: reviewAt, review_round: 1 });
    expect(past.threads.find((row) => row.id === worker.id)).toMatchObject({ state: "active", ended_at: null, end_reason: null, tokens: 0, tokens_at: null });
    expect(past.reviews).toHaveLength(1);
    expect(past.reviews[0]).toMatchObject({ verdict: "pending", summary: null, findings_json: "[]" });
    expect(ticketOf(h, "CSV-1").state).toBe("approved");
  });

  it("leaves out a ticket created after the moment", async () => {
    const h = makeCtx();
    await seedProject(h, (doc) => (doc.ticket = [doc.ticket[0]]));
    const moment = lastEvent(h).id;
    h.clock.advance(MINUTE);
    h.store.createTicket({ project_id: projectOf(h).id, seq: 2, key: "CSV-2", ref: "csv-export", title: "Export endpoint", body: "Serve the file.", acceptance_json: "[]", verify_json: "[]", scope_json: "[]", deps_json: "[]", priority: 2 }, "thr_plan");

    expect(rewind(rowsNow(h), moment).tickets.map((row) => row.key)).toEqual(["CSV-1"]);
    expect(rewind(rowsNow(h), lastEvent(h).id).tickets.map((row) => row.key)).toEqual(["CSV-1", "CSV-2"]);
  });

  it("follows the project from draft to ready to running, and shows a pending version only once one is proposed", async () => {
    const h = makeCtx();
    await h.projects.propose({ toml: specToml(), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    const drafted = lastEvent(h).id;
    h.clock.advance(MINUTE);
    await h.projects.approve("csv", "human");
    const approved = lastEvent(h).id;
    h.clock.advance(MINUTE);
    h.store.setProjectState(projectOf(h).id, "running", "human");
    const started = lastEvent(h).id;
    h.clock.advance(MINUTE);
    await h.projects.propose({ toml: specToml((doc) => (doc.project.goal = "Export orders, with filters.")), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    const revised = lastEvent(h).id;

    const at = (id: number) => {
      const { project, specVersion } = rewind(rowsNow(h), id);
      return { state: project.state, approved: project.approved_version, pending: project.pending_version, specVersion };
    };
    expect(at(drafted)).toEqual({ state: "draft", approved: null, pending: null, specVersion: 1 });
    expect(at(approved)).toEqual({ state: "ready", approved: 1, pending: null, specVersion: 1 });
    expect(at(started)).toEqual({ state: "running", approved: 1, pending: null, specVersion: 1 });
    expect(at(revised)).toEqual({ state: "running", approved: 1, pending: 2, specVersion: 1 });
    expect(rewind(rowsNow(h), drafted).tickets).toEqual([]);
  });

  it("undoes an edit made after the moment from the old values the event keeps, and leaves an edit without them as it is", async () => {
    const h = makeCtx();
    await seedProject(h);
    const moment = lastEvent(h).id;
    const edit = (key: string, data: object) => {
      const ticket = ticketOf(h, key);
      h.store.tx(() => {
        h.store.updateTicket(ticket.id, { title: `New ${ticket.title}` });
        h.store.event(ticket.project_id, ticket.id, "ticket.edited", "thr_plan", data);
      });
    };
    h.clock.advance(MINUTE);
    edit("CSV-1", { fields: ["title"], before: { title: "Order rows" } });
    h.clock.advance(MINUTE);
    edit("CSV-1", { fields: ["title"], before: { title: "New Order rows" } });
    edit("CSV-2", { fields: ["title"] });

    const past = rewind(rowsNow(h), moment);
    expect(past.tickets.map((row) => row.title)).toEqual(["Order rows", "New Export endpoint"]);
    expect(ticketOf(h, "CSV-1").title).toBe("New New Order rows");
  });

  it("counts no failures after a requeue, before the ticket's next move", async () => {
    const h = makeCtx();
    await seedProject(h, (doc) => (doc.budget = { max_attempts: 1 }));
    h.clock.advance(MINUTE);
    const worker = await startWorker(h);
    h.clock.advance(MINUTE);
    await endThread(h.ctx, worker, "failed", { commit: false });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", failures: 1 });
    const failed = lastEvent(h).id;
    h.clock.advance(MINUTE);
    await requeueTicket(h.ctx, "CSV-1", { note: "", actor: "human", author: "human" });
    const requeued = lastEvent(h).id;
    h.clock.advance(MINUTE);
    await startWorker(h);
    h.clock.advance(MINUTE);
    await endThread(h.ctx, workerRowsOf(h).at(-1)!, "failed", { commit: false });
    expect(ticketOf(h, "CSV-1").failures).toBe(1);

    expect(rewind(rowsNow(h), failed).tickets[0]).toMatchObject({ state: "blocked", failures: 1 });
    expect(rewind(rowsNow(h), requeued).tickets[0]).toMatchObject({ state: "queued", failures: 0 });
  });

  it("snaps to the last event of the same millisecond", async () => {
    const h = makeCtx();
    const project = await seedProject(h);
    h.clock.advance(MINUTE);
    h.store.event(project.id, null, "test.first", "human");
    const first = lastEvent(h);
    h.store.event(project.id, null, "test.second", "human");
    const second = lastEvent(h);
    h.clock.advance(MINUTE);
    h.store.event(project.id, null, "test.third", "human");

    const past = rewind(rowsNow(h), first.id);
    expect(past.eventId).toBe(second.id);
    expect(past.at).toBe(first.at);
    expect(past.events.at(-1)!.kind).toBe("test.second");
  });

  it("drops the posts, runs and events after the moment, and shows a run still running then without a result", async () => {
    const h = makeCtx();
    const project = await seedProject(h);
    const ticket = ticketOf(h, "CSV-1");
    h.clock.advance(MINUTE);
    const run = h.store.startRun({ project_id: project.id, ticket_id: ticket.id, stage: "check", kind: "command", label: "npm test" });
    note(h, "CSV-1", "Running the tests.");
    const moment = lastEvent(h).id;
    h.clock.advance(MINUTE);
    h.store.finishRun(run, { ok: true, output: "ok", exitCode: 0 });
    note(h, "CSV-1", "They passed.");
    h.clock.advance(MINUTE);
    h.store.startRun({ project_id: project.id, ticket_id: ticket.id, stage: "check", kind: "command", label: "npm run lint" });

    const past = rewind(rowsNow(h), moment);
    expect(past.events.every((event) => event.id <= moment)).toBe(true);
    expect(past.posts.map((post) => post.body)).toContain("Running the tests.");
    expect(past.posts.map((post) => post.body)).not.toContain("They passed.");
    expect(past.runs).toHaveLength(1);
    expect(past.runs[0]).toMatchObject({ id: run, ended_at: null, ok: null, exit_code: null, duration_ms: null });
  });

  it("returns the stored ticket states at the newest event, and refuses a moment before the project started", async () => {
    const h = makeCtx();
    await seedProject(h);
    h.clock.advance(MINUTE);
    await toReview(h);
    h.clock.advance(MINUTE);
    await startWorker(h, "CSV-2");

    const past = rewind(rowsNow(h), lastEvent(h).id);
    expect(past.tickets.map((row) => [row.key, row.state, row.state_at, row.attempt, row.review_round, row.failures])).toEqual(
      h.store.tickets(projectOf(h).id).map((row) => [row.key, row.state, row.state_at, row.attempt, row.review_round, row.failures]),
    );
    expect(past.at).toBe(lastEvent(h).at);
    expect(() => rewind(rowsNow(h), 0)).toThrow(LoomError);
    try {
      rewind(rowsNow(h), 0);
    } catch (error) {
      expect((error as LoomError).code).toBe("loom_not_found");
      expect((error as LoomError).message).toBe("Event 0 is before csv started.");
    }
  });
});

const workerRowsOf = (h: EngineHarness, key = "CSV-1") => h.store.threads({ ticketId: ticketOf(h, key).id, role: "worker" });

describe("projectTimeline", () => {
  it("draws a ticket while it is in flight with when it was sent back, a bar per session, the moments and the tickets in trouble", async () => {
    const h = makeCtx();
    const project = await seedProject(h);
    h.store.event(project.id, null, "human.action", "human", { action: "start", slug: "csv" });
    h.clock.advance(MINUTE);
    const start = h.clock.t;
    await toReview(h);
    h.clock.advance(MINUTE);
    await spawnReviewers(h.ctx, project, specOf(h.store, project));
    h.clock.advance(MINUTE);
    checkOutHead(h, reviewerOf(h));
    await requestChanges(h.ctx, reviewerOf(h).thread_id!, "Fix it", [{ severity: "blocking", title: "Wrong header", detail: "The header row is missing." }]);
    await settleReviews(h.ctx);
    h.clock.advance(MINUTE);
    const now = h.clock.t;

    const timeline = projectTimeline(rowsNow(h), now);
    const events = h.store.projectEvents(project.id);
    expect(timeline.start).toBe(events[0]!.at);
    expect(timeline.end).toBe(now);
    expect(timeline.events.map(([id]) => id)).toEqual([...timeline.events.map(([id]) => id)].sort((a, b) => a - b));
    expect(new Set(timeline.events.map(([, at]) => at)).size).toBe(timeline.events.length);
    expect(timeline.events.at(-1)![0]).toBe(events.at(-1)!.id);

    const bar = timeline.tickets.find((entry) => entry.key === "CSV-1")!;
    expect(bar).toMatchObject({ title: "Order rows", from: start, to: now });
    expect(bar.parts.map((part) => part.state)).toEqual(["working", "checking", "review", "working"]);
    expect(bar.parts[0]).toEqual({ from: start, to: start + MINUTE, state: "working" });
    expect(bar.sentBack).toEqual([bar.parts[3]!.from]);
    expect(bar.final).toBeNull();
    expect(timeline.tickets.map((entry) => entry.key)).toEqual(["CSV-1"]);
    expect(timeline.ticketCount).toBe(2);
    expect(timeline.state).toBe("running");

    expect(timeline.sessions.map((session) => [session.key, session.role, session.label])).toEqual([
      ["CSV-1", "worker", "attempt 1"],
      ["CSV-1", "reviewer", "round 1"],
    ]);
    expect(timeline.sessions[0]!.to).toBe(now);
    expect(timeline.sessions[1]).toMatchObject({ endReason: "verdict" });

    expect(timeline.project.map((band) => band.state)).toEqual(["draft", "ready", "running"]);
    expect(timeline.project.at(-1)!.to).toBe(now);
    expect(timeline.trouble).toEqual(["CSV-1"]);

    const { moments } = timeline;
    expect(moments.map((moment) => moment.id)).toEqual([...moments.map((moment) => moment.id)].sort((a, b) => a - b));
    const you = moments.find((moment) => moment.lines.some((line) => line.text === "You ran start."))!;
    expect(you.kind).toBe("you");
    const sentBackMoment = moments.find((moment) => moment.lines.some((line) => line.kind === "trouble"))!;
    expect(sentBackMoment.lines.find((line) => line.kind === "trouble")).toEqual({ kind: "trouble", text: "CSV-1 moved from review to working: changes requested in round 1.", key: "CSV-1" });
    expect(sentBackMoment.kind).toBe("trouble");
    expect(moments.at(-1)!.id).toBe(events.filter((event) => event.kind !== "post.added").at(-1)!.id);
    expect(moments.flatMap((moment) => moment.lines).some((line) => line.text.includes("added a"))).toBe(false);
  });

  it("groups events less than 2 seconds apart into one moment, counts a burst of new tickets in one line, and leaves posts out, your replies too", () => {
    const at = 1_000_000;
    const event = (id: number, offset: number, kind: string, data: Record<string, unknown>, ticket: number | null = null) => ({ id, project_id: 1, ticket_id: ticket, at: at + offset, kind, actor: "human", data_json: JSON.stringify(data) });
    const rows = {
      project: { id: 1, state: "running" },
      tickets: [1, 2, 3].map((id) => ({ id, key: `CSV-${id}`, title: `Ticket ${id}` })),
      threads: [],
      posts: [],
      reviews: [],
      runs: [],
      events: [
        event(1, 0, "spec.approved", { version: 1 }),
        event(2, 0, "ticket.created", {}, 1),
        event(3, 0, "ticket.created", {}, 2),
        event(4, 0, "ticket.created", {}, 3),
        event(5, 1_500, "human.action", { action: "start" }),
        event(6, 3_000, "project.state", { from: "ready", to: "running" }),
        event(7, 60_000, "post.added", { author: "worker", kind: "note", post: 1 }, 1),
        event(10, 90_000, "human.action", { action: "post", key: "CSV-1" }, 1),
        event(8, 120_000, "ticket.state", { from: "queued", to: "blocked", reason: "it needs a key" }, 2),
        event(9, 120_500, "ticket.state", { from: "queued", to: "working", attempt: 1 }, 1),
      ],
    } as unknown as Parameters<typeof projectTimeline>[0];
    const { moments } = projectTimeline(rows, at + 200_000);
    expect(moments.map((moment) => [moment.id, moment.at, moment.kind])).toEqual([
      [6, at + 3_000, "you"],
      [9, at + 120_500, "trouble"],
    ]);
    expect(moments[0]!.lines).toEqual([
      { kind: "milestone", text: "Spec version 1 was approved.", key: null },
      { kind: "move", text: "3 tickets were created.", key: null },
      { kind: "you", text: "You ran start.", key: null },
      { kind: "milestone", text: "The project moved from ready to running.", key: null },
    ]);
    expect(moments[1]!.lines.map((line) => [line.kind, line.key])).toEqual([
      ["trouble", "CSV-2"],
      ["move", "CSV-1"],
    ]);
  });

  it("ends a finished project's timeline at its last event", async () => {
    const h = makeCtx();
    const project = await seedProject(h);
    h.clock.advance(MINUTE);
    h.store.setProjectState(project.id, "done", "human");
    expect(projectTimeline(rowsNow(h), h.clock.t + 10 * MINUTE).end).toBe(lastEvent(h).at);
  });
});
