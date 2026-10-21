import { beforeEach, describe, expect, it } from "vitest";
import type { TicketSpec } from "../src/spec";
import { addTickets, boardText, cancelTicket, editTicket, maybeSendTriage, onPlannerIdle } from "../src/triage";
import { blockTicket, requeueTicket } from "../src/workers";
import { makeCtx, seedProject, startWorker, ticketOf, workerRows, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const block = (key: string, reason: string, needs = "") => blockTicket(h.ctx, ticketOf(h, key), { reason, needs, actor: "human" });
const round = () => maybeSendTriage(h.ctx, project());
const newTicket = (over: Partial<TicketSpec> = {}): TicketSpec => ({
  ref: "csv-docs",
  title: "Document the export",
  body: "Write the docs.",
  acceptance: ["WHEN the docs are built THE SYSTEM SHALL list the export"],
  verify: [],
  scope: ["docs/**"],
  depends_on: [],
  priority: 2,
  ...over,
});
const messageToPlanner = () => h.bb.callsTo("send").filter(([id]) => id === "thr_plan").map(([, message]) => message as { summary: string; detail: string });

describe("triage rounds", () => {
  it("batches every blocked ticket into one message and counts the round", async () => {
    await seedProject(h);
    await block("CSV-1", "No API key", "A test key");
    await block("CSV-2", "Waiting on legal");
    expect(project().triage_pending).toBe(1);

    expect(await round()).toBe(true);
    const sent = messageToPlanner();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.summary).toBe("[loom] Triage round 1 for csv: 2 tickets are blocked.");
    for (const text of [
      "CSV-1",
      "No API key",
      "Needs: A test key",
      "CSV-2",
      "Waiting on legal",
      "blocked 2",
      "Answer only through the tools",
      "loom_requeue",
      "Last posts:",
    ]) {
      expect(sent[0]!.detail).toContain(text);
    }
    expect(project()).toMatchObject({ triage_pending: 0, triage_round: 1, triage_sent_at: h.clock.t });
    expect(await round()).toBe(false);
    expect(messageToPlanner()).toHaveLength(1);
  });

  it("waits while the planner is busy, and sends once it is idle", async () => {
    await seedProject(h);
    await block("CSV-1", "No API key");
    h.bb.threads.get("thr_plan")!.status = "active";
    expect(await round()).toBe(false);
    expect(project().triage_pending).toBe(1);
    h.bb.threads.get("thr_plan")!.status = "idle";
    expect(await round()).toBe(true);
  });

  it("sends nothing when triage is off, the planner row is not active, or the planner thread is unknown", async () => {
    await seedProject(h, (doc) => (doc.agents = { triage: false }));
    await block("CSV-1", "No API key");
    expect(await round()).toBe(false);

    h = makeCtx();
    await seedProject(h);
    await block("CSV-1", "No API key");
    h.store.updateThread(h.store.threadByThreadId("thr_plan")!.id, { state: "ended" });
    expect(await round()).toBe(false);

    h = makeCtx();
    await seedProject(h);
    await block("CSV-1", "No API key");
    h.bb.threads.delete("thr_plan");
    expect(await round()).toBe(false);
    expect(h.bb.callsTo("send")).toEqual([]);
  });

  it("allows one round in flight, clears it when the planner goes idle, and gives up on a round older than 30 minutes", async () => {
    await seedProject(h);
    await block("CSV-1", "No API key");
    expect(await round()).toBe(true);

    await block("CSV-2", "Waiting on legal");
    expect(await round()).toBe(false);

    onPlannerIdle(h.ctx, h.store.threadByThreadId("thr_plan")!);
    expect(project().triage_sent_at).toBeNull();
    expect(await round()).toBe(true);
    expect(project().triage_round).toBe(2);
    expect(messageToPlanner()[1]!.detail).toContain("CSV-2");

    await requeueTicket(h.ctx, "CSV-1", { note: "", actor: "human", author: "human" });
    await block("CSV-1", "Again");
    h.clock.advance(29 * 60_000);
    expect(await round()).toBe(false);
    h.clock.advance(2 * 60_000);
    expect(await round()).toBe(true);
    expect(project().triage_round).toBe(3);
  });

  it("clears a pending round with nothing to say when no ticket is blocked any more", async () => {
    await seedProject(h);
    h.store.updateProject(project().id, { triage_pending: 1 });
    expect(await round()).toBe(false);
    expect(project().triage_pending).toBe(0);
    expect(h.bb.callsTo("send")).toEqual([]);
  });

  it("tells the planner why a project the plugin paused is paused", async () => {
    await seedProject(h, undefined, "paused");
    h.store.updateProject(project().id, { triage_pending: 1, system_reason: "The deadline 2030-01-01 has passed." });
    expect(await round()).toBe(true);
    expect(messageToPlanner()[0]!.detail).toContain("paused (The deadline 2030-01-01 has passed.)");
  });

  it("keeps the digest to the last three posts of each blocked ticket", async () => {
    await seedProject(h);
    const ticket = ticketOf(h, "CSV-1");
    for (let n = 1; n <= 5; n++) h.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "human", author_thread_id: null, kind: "reply", body: `reply number ${n}` });
    await block("CSV-1", "stuck");
    await round();
    const detail = messageToPlanner()[0]!.detail;
    expect(detail).toContain("reply number 5");
    expect(detail).toContain("reply number 4");
    expect(detail).not.toContain("reply number 3");
  });
});

describe("addTickets", () => {
  it("continues the keys from the highest seq, resolves dependencies on the batch and on existing tickets, and writes a brief post for each", async () => {
    await seedProject(h);
    const created = addTickets(h.ctx, project().id, [newTicket({ ref: "a", depends_on: ["CSV-1"] }), newTicket({ ref: "b", depends_on: ["a", "csv-export"], scope: ["web/**"] })], "thr_plan");
    expect(created.map((ticket) => [ticket.key, ticket.seq, ticket.state, ticket.deps_json])).toEqual([
      ["CSV-3", 3, "queued", '["CSV-1"]'],
      ["CSV-4", 4, "queued", '["CSV-3","CSV-2"]'],
    ]);
    const brief = h.store.posts(created[0]!.id)[0]!;
    expect(brief).toMatchObject({ kind: "brief", author_kind: "planner", author_thread_id: "thr_plan" });
    expect(brief.body).toContain("Acceptance criteria:\n1. WHEN the docs are built");
    expect(h.store.events(project().id).some((event) => event.kind === "ticket.created" && event.actor === "thr_plan")).toBe(true);
  });

  it("refuses a dependency cycle inside the batch, and saves nothing", async () => {
    await seedProject(h);
    expect(() => addTickets(h.ctx, project().id, [newTicket({ ref: "a", depends_on: ["b"] }), newTicket({ ref: "b", depends_on: ["a"] })], "thr_plan")).toThrow(/dependency cycle a -> b -> a/);
    expect(h.store.tickets(project().id)).toHaveLength(2);
  });

  it("refuses unknown dependencies, repeated refs and refs that already exist", async () => {
    await seedProject(h);
    const attempt = (tickets: TicketSpec[]) => () => addTickets(h.ctx, project().id, tickets, "thr_plan");
    expect(attempt([newTicket({ depends_on: ["CSV-77"] })])).toThrow(/CSV-77/);
    expect(attempt([newTicket(), newTicket({ title: "again" })])).toThrow(/used twice/);
    expect(attempt([newTicket({ ref: "csv-model" })])).toThrow(/already a ticket/);
    expect(h.store.tickets(project().id)).toHaveLength(2);
  });

  it("refuses a scope under a protected path and a ticket nothing would check", async () => {
    await seedProject(h, (doc: Doc) => {
      doc.scope = { protected: ["db/**"] };
      doc.checks = { commands: [] };
      doc.ticket.forEach((ticket: Doc) => (ticket.verify = ["npm test"]));
    });
    expect(() => addTickets(h.ctx, project().id, [newTicket({ scope: ["db/migrations/**"], verify: ["x"] })], "thr_plan")).toThrow(/protected path/);
    expect(() => addTickets(h.ctx, project().id, [newTicket()], "thr_plan")).toThrow(/nothing would check/);
  });
});

describe("editTicket", () => {
  it("changes only the fields in the patch, on a queued or a blocked ticket, and records what changed", async () => {
    await seedProject(h);
    const before = ticketOf(h, "CSV-2");
    const edited = editTicket(h.ctx, "CSV-2", { title: "Export endpoint v2", priority: 0 }, "thr_plan");
    expect(edited).toMatchObject({ title: "Export endpoint v2", priority: 0, body: before.body, acceptance_json: before.acceptance_json, verify_json: before.verify_json, scope_json: before.scope_json, deps_json: before.deps_json });
    expect(h.store.posts(before.id).at(-1)).toMatchObject({ kind: "system", author_kind: "planner", author_thread_id: "thr_plan" });
    expect(h.store.posts(before.id).at(-1)!.body).toContain("title, priority");
    expect(h.store.events(project().id).some((event) => event.kind === "ticket.edited")).toBe(true);

    await block("CSV-2", "stuck");
    expect(editTicket(h.ctx, "CSV-2", { depends_on: [], scope: ["src/other/**"] }, "thr_plan")).toMatchObject({ deps_json: "[]", scope_json: '["src/other/**"]', state: "blocked" });
  });

  it("refuses a ticket that is working, checking, in review or finished", async () => {
    await seedProject(h);
    await startWorker(h);
    expect(() => editTicket(h.ctx, "CSV-1", { title: "x" }, "thr_plan")).toThrow(/CSV-1 is working; only a queued or blocked ticket/);
    for (const state of ["checking", "review"] as const) {
      h.store.setTicketState(ticketOf(h, "CSV-1").id, state, "loom");
      expect(() => editTicket(h.ctx, "CSV-1", { title: "x" }, "thr_plan")).toThrow(/only a queued or blocked/);
    }
    expect(() => editTicket(h.ctx, "CSV-77", { title: "x" }, "thr_plan")).toThrow(/No ticket/);
  });

  it("refuses a dependency on itself, on an unknown ticket, or one that closes a cycle across the board", async () => {
    await seedProject(h);
    expect(() => editTicket(h.ctx, "CSV-2", { depends_on: ["CSV-2"] }, "thr_plan")).toThrow(/cannot depend on itself/);
    expect(() => editTicket(h.ctx, "CSV-2", { depends_on: ["CSV-9"] }, "thr_plan")).toThrow(/CSV-9/);
    expect(() => editTicket(h.ctx, "CSV-1", { depends_on: ["CSV-2"] }, "thr_plan")).toThrow(/dependency cycle/);
    expect(ticketOf(h, "CSV-1").deps_json).toBe("[]");
  });

  it("refuses a patch that would leave the ticket with nothing to check, or put it under a protected path", async () => {
    await seedProject(h, (doc: Doc) => {
      doc.scope = { protected: ["db/**"] };
      doc.checks = { commands: [] };
      doc.ticket.forEach((ticket: Doc) => (ticket.verify = ["npm test"]));
    });
    expect(() => editTicket(h.ctx, "CSV-1", { verify: [] }, "thr_plan")).toThrow(/nothing would check/);
    expect(() => editTicket(h.ctx, "CSV-1", { scope: ["db/x.sql"] }, "thr_plan")).toThrow(/protected path/);
  });
});

describe("cancelTicket", () => {
  it("cancels a queued ticket with a post, and records who asked", async () => {
    await seedProject(h);
    const cancelled = await cancelTicket(h.ctx, "CSV-2", "No longer needed", "thr_plan");
    expect(cancelled.state).toBe("cancelled");
    expect(h.store.posts(cancelled.id).at(-1)).toMatchObject({ kind: "system", author_kind: "planner", body: "Cancelled: No longer needed" });
  });

  it("cancels a ticket in review and ends its worker", async () => {
    await seedProject(h);
    await startWorker(h);
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "review", "loom");
    const cancelled = await cancelTicket(h.ctx, "CSV-1", "Dropped", "human");
    expect(cancelled).toMatchObject({ state: "cancelled", worker_thread_id: null });
    expect(workerRows(h, "CSV-1")).toMatchObject([{ state: "ended", end_reason: "cancelled" }]);
    expect(h.bb.callsTo("archive")).toEqual([["thr_w1"]]);
    expect(h.store.posts(cancelled.id).at(-1)).toMatchObject({ author_kind: "human" });
  });

  it("refuses a ticket that is merging, finished or already cancelled", async () => {
    await seedProject(h);
    const id = ticketOf(h, "CSV-1").id;
    for (const state of ["working", "checking", "review", "approved", "merging"] as const) h.store.setTicketState(id, state, "loom");
    await expect(cancelTicket(h.ctx, "CSV-1", "x", "human")).rejects.toMatchObject({ code: "loom_invalid_state", message: "CSV-1 is merging; try again when the merge finishes." });
    await cancelTicket(h.ctx, "CSV-2", "x", "human");
    await expect(cancelTicket(h.ctx, "CSV-2", "x", "human")).rejects.toMatchObject({ code: "loom_invalid_state" });
  });
});

describe("boardText", () => {
  it("lists every ticket with its state, priority, dependencies and age, or only the states asked for", async () => {
    await seedProject(h);
    await block("CSV-1", "stuck");
    h.clock.advance(5 * 60_000);
    const all = boardText(h.ctx, project().id);
    expect(all).toContain("Board for csv: 2 tickets");
    expect(all).toContain("CSV-1  blocked");
    expect(all).toContain("CSV-2  queued");
    expect(all).toContain("(after CSV-1)");
    expect(all).toContain("5m in state");
    const only = boardText(h.ctx, project().id, ["blocked"]);
    expect(only).toContain("CSV-1");
    expect(only).not.toContain("CSV-2");
    expect(boardText(h.ctx, project().id, ["done"])).toContain("No tickets");
  });
});
