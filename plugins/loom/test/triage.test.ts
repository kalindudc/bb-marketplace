import { beforeEach, describe, expect, it } from "vitest";
import type { TicketSpec } from "../src/spec";
import { addTickets, boardText, cancelTicket, editTicket, maybeSendTriage, onPlannerIdle } from "../src/triage";
import { blockTicket, requeueTicket } from "../src/workers";
import { GIT_WORKTREE_PROVIDER, makeCtx, seedProject, startWorker, ticketOf, workerRows, type Doc, type EngineHarness } from "./helpers";

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

  it("sends no round for a pause the plugin made for anything but the budget or the deadline, and still sends one for blocked tickets", async () => {
    await seedProject(h, undefined, "paused");
    h.store.updateProject(project().id, { triage_pending: 1, system_reason: "Reading the pull request of CSV-1 stopped: host plugin call exceeded its deadline" });
    expect(await round()).toBe(false);
    expect(project().triage_pending).toBe(0);
    expect(h.bb.callsTo("send")).toEqual([]);

    await block("CSV-1", "No API key");
    expect(await round()).toBe(true);
    expect(messageToPlanner()[0]!.summary).toBe("[loom] Triage round 1 for csv: 1 ticket is blocked.");
  });

  it("says what a new spec version can change when the budget paused the project", async () => {
    await seedProject(h, undefined, "paused");
    h.store.updateProject(project().id, { triage_pending: 1, system_reason: "The token budget is used up: 900 of 800 tokens." });
    expect(await round()).toBe(true);
    const sent = messageToPlanner()[0]!;
    expect(sent.summary).toBe("[loom] Triage round 1 for csv: Loom paused the project. The token budget is used up: 900 of 800 tokens.");
    expect(sent.detail).toContain("budget.max_tokens");
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

  it("keeps the old values of the edited fields on the event, so a rewind can show the ticket as it was", async () => {
    await seedProject(h);
    const before = ticketOf(h, "CSV-2");
    editTicket(h.ctx, "CSV-2", { title: "Export endpoint v2", scope: ["src/other/**"] }, "thr_plan");
    const event = h.store.events(project().id).filter((row) => row.kind === "ticket.edited").at(-1)!;
    expect(JSON.parse(event.data_json)).toEqual({ fields: ["title", "scope"], before: { title: before.title, scope_json: before.scope_json } });
  });

  it("sets and clears a ticket's environment inputs patch, and refuses one in a repo with no environment provider", async () => {
    h.bb.environmentProviderList = [GIT_WORKTREE_PROVIDER, { ...GIT_WORKTREE_PROVIDER, id: "example-pool", pluginId: "example", acceptsEmptyInputs: false, inputs: { type: "object" } }];
    await seedProject(h, (doc) => (doc.environment = { provider: "example-pool", inputs: { paths: ["a", "b"] } }));
    expect(editTicket(h.ctx, "CSV-2", { environment: { inputs: { paths: ["a"] } } }, "thr_plan").environment_json).toBe('{"paths":["a"]}');
    expect(editTicket(h.ctx, "CSV-2", { environment: { inputs: {} } }, "thr_plan").environment_json).toBeNull();
    expect(() => editTicket(h.ctx, "CSV-2", { environment: { inputs: { at: "{ticket}" } } }, "thr_plan")).toThrow("patch.environment.inputs: {ticket} is not a Loom placeholder");
    const created = addTickets(h.ctx, project().id, [newTicket({ environment: { inputs: { paths: ["docs"] } } })], "thr_plan");
    expect(created[0]!.environment_json).toBe('{"paths":["docs"]}');

    h = makeCtx();
    await seedProject(h);
    expect(() => editTicket(h.ctx, "CSV-2", { environment: { inputs: { paths: ["a"] } } }, "thr_plan")).toThrow("patch.environment: the ticket's repo starts its threads in git worktrees, with no environment inputs to patch");
    expect(() => addTickets(h.ctx, project().id, [newTicket({ environment: { inputs: { paths: ["docs"] } } })], "thr_plan")).toThrow("tickets[0].environment: the ticket's repo starts its threads in git worktrees");
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

describe("repos on the board tools", () => {
  const withRepos = (doc: Doc) => {
    doc.repo = [
      { name: "web", project: "proj_web", protected: ["config/**"] },
      { name: "api", project: "proj_api", checks: [] },
    ];
    doc.ticket[0].repo = "web";
    doc.ticket[1].repo = "api";
    doc.ticket[1].verify = ["npm run api-test"];
  };
  const seedMulti = (edit?: (doc: Doc) => void) =>
    seedProject(h, (doc) => {
      withRepos(doc);
      edit?.(doc);
    });
  const add = (tickets: TicketSpec[]) => () => addTickets(h.ctx, project().id, tickets, "thr_plan");
  const failure = (fn: () => unknown): Error => {
    try {
      fn();
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected a refusal");
  };

  beforeEach(() => {
    h.bb.addBbProject("proj_web", { host_1: "/src/web" });
    h.bb.addBbProject("proj_api", { host_1: "/src/api" });
  });

  describe("addTickets", () => {
    it("stores each new ticket's repo on a multi-repo project, and null on a single-repo one", async () => {
      await seedMulti();
      const created = addTickets(h.ctx, project().id, [newTicket({ repo: "web" }), newTicket({ ref: "api-docs", repo: "api", verify: ["npm run api-test"] })], "thr_plan");
      expect(created.map((ticket) => [ticket.key, ticket.repo])).toEqual([
        ["CSV-3", "web"],
        ["CSV-4", "api"],
      ]);

      h = makeCtx();
      await seedProject(h);
      expect(addTickets(h.ctx, project().id, [newTicket()], "thr_plan")[0]!.repo).toBeNull();
    });

    it("refuses the whole batch when a ticket on a multi-repo project has no repo or one the spec does not list, and lists the repos", async () => {
      await seedMulti();
      const error = failure(add([newTicket({ ref: "a", repo: "web" }), newTicket({ ref: "b" }), newTicket({ ref: "c", repo: "docs" })]));
      expect(error.message).toContain("1. tickets[1].repo: is required, because this project lists [[repo]] tables. Set it to one of: web, api.");
      expect(error.message).toContain('2. tickets[2].repo: "docs" is not one of this project\'s repos. Use one of: web, api.');
      expect(h.store.tickets(project().id)).toHaveLength(2);
    });

    it("refuses a ticket that names a repo on a single-repo project", async () => {
      await seedProject(h);
      const error = failure(add([newTicket({ repo: "web" })]));
      expect(error.message).toContain('1. tickets[0].repo: "web" names a repo, but this project has no [[repo]] table, so every ticket runs in the project\'s own repository. Remove repo from the ticket.');
      expect(h.store.tickets(project().id)).toHaveLength(2);
    });

    it("refuses a scope under its repo's protected globs or under [scope].protected, and allows the same scope in another repo", async () => {
      await seedMulti((doc) => (doc.scope = { protected: ["db/**"] }));
      expect(failure(add([newTicket({ scope: ["config/app.ts"], repo: "web" })])).message).toContain('1. tickets[0].scope: "config/app.ts" falls under the protected path "config/**" of repo "web". Take it out of the scope.');
      expect(failure(add([newTicket({ scope: ["db/x.sql"], repo: "web" })])).message).toContain('1. tickets[0].scope: "db/x.sql" falls under the protected path "db/**". Take it out of the scope.');
      expect(failure(add([newTicket({ scope: ["db/x.sql"], repo: "api", verify: ["x"] })])).message).toContain('"db/x.sql" falls under the protected path "db/**".');
      expect(add([newTicket({ scope: ["config/app.ts"], repo: "api", verify: ["x"] })])()[0]!.repo).toBe("api");
    });

    it("uses the repo's own checks: a ticket with no verify commands is refused in a repo whose checks are empty, and accepted in one that inherits checks.commands", async () => {
      await seedMulti();
      expect(failure(add([newTicket({ repo: "api" })])).message).toContain('1. tickets[0].verify: nothing would check this ticket, because it has no verify commands and the checks of repo "api", which replace checks.commands, are empty. Add a verify command.');
      expect(add([newTicket({ repo: "web" })])()[0]!.repo).toBe("web");
    });
  });

  describe("editTicket", () => {
    it("moves a queued or a blocked ticket with no branch to another repo, records the old repo, and keeps it when the patch names the same repo", async () => {
      await seedMulti((doc) => (doc.ticket[0].verify = ["npm test"]));
      expect(editTicket(h.ctx, "CSV-1", { repo: "api" }, "thr_plan")).toMatchObject({ repo: "api", state: "queued" });
      const event = h.store.events(project().id).filter((row) => row.kind === "ticket.edited").at(-1)!;
      expect(JSON.parse(event.data_json)).toEqual({ fields: ["repo"], before: { repo: "web" } });
      expect(h.store.posts(ticketOf(h, "CSV-1").id).at(-1)!.body).toBe("The planner edited this ticket: repo.");

      await block("CSV-2", "stuck");
      expect(ticketOf(h, "CSV-2").branch).toBeNull();
      expect(editTicket(h.ctx, "CSV-2", { repo: "web" }, "thr_plan")).toMatchObject({ repo: "web", state: "blocked" });
      expect(editTicket(h.ctx, "CSV-2", { repo: "web", title: "Renamed" }, "thr_plan")).toMatchObject({ repo: "web", title: "Renamed" });
    });

    it("refuses to move a ticket that has a branch or is in another state, and says to cancel it and add a new ticket in the other repo", async () => {
      await seedMulti();
      await startWorker(h, "CSV-1");
      const working = failure(() => editTicket(h.ctx, "CSV-1", { repo: "api" }, "thr_plan"));
      expect(working).toMatchObject({ code: "loom_invalid_state" });
      expect(working.message).toBe(
        'CSV-1 is working; its repo can change only while it is queued or blocked and has no branch, because a branch lives in one repository. Cancel CSV-1 with loom_cancel_ticket and add a new ticket in repo "api" with loom_add_tickets.',
      );

      await block("CSV-1", "stuck");
      const branch = ticketOf(h, "CSV-1").branch;
      expect(branch).not.toBeNull();
      const blocked = failure(() => editTicket(h.ctx, "CSV-1", { repo: "api", title: "x" }, "thr_plan"));
      expect(blocked.message).toContain(`CSV-1 has the branch ${branch}; its repo can change only while it is queued or blocked and has no branch`);
      expect(blocked.message).toContain('Cancel CSV-1 with loom_cancel_ticket and add a new ticket in repo "api"');
      expect(ticketOf(h, "CSV-1")).toMatchObject({ repo: "web", title: "Order rows" });
      expect(editTicket(h.ctx, "CSV-1", { repo: "web", title: "Same repo" }, "thr_plan").title).toBe("Same repo");
    });

    it("validates the new repo like addTickets does", async () => {
      await seedMulti();
      expect(failure(() => editTicket(h.ctx, "CSV-1", { repo: "docs" }, "thr_plan")).message).toContain('1. patch.repo: "docs" is not one of this project\'s repos. Use one of: web, api.');

      h = makeCtx();
      await seedProject(h);
      await startWorker(h, "CSV-1");
      await block("CSV-1", "stuck");
      const single = failure(() => editTicket(h.ctx, "CSV-1", { repo: "web" }, "thr_plan"));
      expect(single.message).toContain('1. patch.repo: "web" names a repo, but this project has no [[repo]] table');
      expect(ticketOf(h, "CSV-1").repo).toBeNull();
    });

    it("checks the whole scope and the verify commands again against the new repo", async () => {
      await seedMulti((doc) => {
        doc.repo[1].protected = ["src/model/**"];
        doc.repo[1].checks = ["npm run api-test"];
      });
      expect(failure(() => editTicket(h.ctx, "CSV-1", { repo: "api" }, "thr_plan")).message).toContain('1. patch.scope: "src/model/**" falls under the protected path "src/model/**" of repo "api".');
      expect(failure(() => editTicket(h.ctx, "CSV-2", { repo: "web", scope: ["config/x.ts"] }, "thr_plan")).message).toContain('"config/x.ts" falls under the protected path "config/**" of repo "web"');

      h = makeCtx();
      h.bb.addBbProject("proj_web", { host_1: "/src/web" });
      h.bb.addBbProject("proj_api", { host_1: "/src/api" });
      await seedMulti();
      expect(failure(() => editTicket(h.ctx, "CSV-1", { repo: "api" }, "thr_plan")).message).toContain('1. patch.verify: nothing would check this ticket, because it has no verify commands and the checks of repo "api", which replace checks.commands, are empty.');
      expect(editTicket(h.ctx, "CSV-1", { repo: "api", verify: ["npm run api-test"] }, "thr_plan")).toMatchObject({ repo: "api", verify_json: '["npm run api-test"]' });
    });
  });

  describe("boardText", () => {
    it("shows each ticket's repo and lists the repos on a multi-repo project", async () => {
      await seedMulti();
      const board = boardText(h.ctx, project().id);
      expect(board).toContain("Board for csv (repos web, api): 2 tickets");
      expect(board).toContain("CSV-1  queued     P2  repo web  Order rows");
      expect(board).toContain("CSV-2  queued     P2  repo api  Export endpoint  (after CSV-1)");
    });

    it("shows no repo on a single-repo project", async () => {
      await seedProject(h);
      const board = boardText(h.ctx, project().id);
      expect(board).toContain("Board for csv: 2 tickets");
      expect(board).toContain("CSV-1  queued     P2  Order rows");
      expect(board).not.toContain("repo");
    });
  });
});

describe("merge_after on the board tools", () => {
  it("adds tickets that merge after refs in the batch and tickets on the board, and refuses unknown refs, its own ref and a merge order cycle", async () => {
    await seedProject(h);
    const created = addTickets(h.ctx, project().id, [newTicket({ ref: "a", merge_after: ["CSV-2"] }), newTicket({ ref: "b", scope: ["web/**"], merge_after: ["a", "csv-model"] })], "thr_plan");
    expect(created.map((ticket) => ticket.merge_after_json)).toEqual(['["CSV-2"]', '["CSV-3","CSV-1"]']);
    const attempt = (tickets: TicketSpec[]) => () => addTickets(h.ctx, project().id, tickets, "thr_plan");
    expect(attempt([newTicket({ ref: "c", merge_after: ["nope"] })])).toThrow(/merge_after: "nope" is not a ref in this batch or a ticket on this board/);
    expect(attempt([newTicket({ ref: "c", merge_after: ["c"] })])).toThrow(/merge_after: "c" is this ticket's own ref/);
    expect(attempt([newTicket({ ref: "c", merge_after: ["d"] }), newTicket({ ref: "d", scope: ["web/**"], depends_on: ["c"] })])).toThrow(/merge order cycle c -> d -> c|merge order cycle d -> c -> d/);
    expect(h.store.tickets(project().id)).toHaveLength(4);
  });

  it("changes the merge order of a ticket whose pull request is open, but no other field of it, and not of a finished ticket", async () => {
    await seedProject(h);
    const docs = addTickets(h.ctx, project().id, [newTicket({ ref: "docs" })], "thr_plan")[0]!;
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { state: "pr_open" });
    expect(editTicket(h.ctx, "CSV-2", { merge_after: [docs.key] }, "thr_plan").merge_after_json).toBe(`["${docs.key}"]`);
    expect(() => editTicket(h.ctx, "CSV-2", { title: "x", merge_after: [] }, "thr_plan")).toThrow(/CSV-2 is pr_open; only a queued or blocked ticket/);
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { state: "done" });
    expect(() => editTicket(h.ctx, "CSV-2", { merge_after: [] }, "thr_plan")).toThrow(/CSV-2 is done, so its merge order no longer matters/);
  });

  it("sets merge_after by key or ref, and refuses itself, an unknown ticket and a cycle with depends_on", async () => {
    await seedProject(h);
    const added = addTickets(h.ctx, project().id, [newTicket({ ref: "docs" })], "thr_plan")[0]!;
    expect(editTicket(h.ctx, added.key, { merge_after: ["csv-export", "CSV-1"] }, "thr_plan").merge_after_json).toBe('["CSV-2","CSV-1"]');
    expect(() => editTicket(h.ctx, "CSV-3", { merge_after: ["CSV-3"] }, "thr_plan")).toThrow(/cannot merge after itself/);
    expect(() => editTicket(h.ctx, "CSV-3", { merge_after: ["CSV-9"] }, "thr_plan")).toThrow(/"CSV-9" is not a ticket on this board/);
    // CSV-2 depends on CSV-1, so CSV-1 merging after CSV-2 is a loop.
    expect(() => editTicket(h.ctx, "CSV-1", { merge_after: ["CSV-2"] }, "thr_plan")).toThrow(/merge order cycle/);
    expect(ticketOf(h, "CSV-1").merge_after_json).toBe("[]");
    const event = h.store.events(project().id).filter((each) => each.kind === "ticket.edited").at(-1)!;
    expect(JSON.parse(event.data_json)).toMatchObject({ fields: ["merge_after"], before: { merge_after_json: "[]" } });
  });
});

describe("rollout on the board tools", () => {
  const staged = (doc: Doc) => {
    doc.merge = { strategy: "pr" };
    doc.rollout = { stage: [{ name: "expand", goal: "The model is live" }, { name: "migrate", goal: "Callers use it" }], milestone: [{ ref: "traffic-low", title: "Old traffic is near zero", stage: "migrate" }] };
    doc.ticket[0].rollout = { stage: "expand" };
  };

  it("adds tickets whose rollout names refs in the batch, tickets on the board and milestones, and refuses what does not resolve or runs backwards", async () => {
    await seedProject(h, staged);
    const created = addTickets(h.ctx, project().id, [newTicket({ ref: "a", rollout: { stage: "migrate", requires_live: ["csv-model", "traffic-low"] } }), newTicket({ ref: "b", scope: ["web/**"], rollout: { requires_live: ["a"], verify: "true" } })], "thr_plan");
    expect(created.map((ticket) => ticket.rollout_json)).toEqual([JSON.stringify({ stage: "migrate", requires_live: ["CSV-1", "traffic-low"] }), JSON.stringify({ requires_live: ["CSV-3"], verify: "true" })]);
    const attempt = (tickets: TicketSpec[]) => () => addTickets(h.ctx, project().id, tickets, "thr_plan");
    expect(attempt([newTicket({ ref: "c", rollout: { stage: "cleanup" } })])).toThrow(/tickets\[0\]\.rollout\.stage: "cleanup" is not one of this project's \[\[rollout\.stage\]\] names: expand, migrate/);
    expect(attempt([newTicket({ ref: "c", rollout: { requires_live: ["nope"] } })])).toThrow(/requires_live: "nope" is not a ticket on this board, a ref in this batch or a \[\[rollout\.milestone\]\] ref/);
    expect(attempt([newTicket({ ref: "c", rollout: { stage: "expand", requires_live: ["traffic-low"] } })])).toThrow(/"traffic-low" is in the stage "migrate", which comes after "expand"/);
    expect(attempt([newTicket({ ref: "traffic-low" })])).toThrow(/"traffic-low" is the ref of one of this project's \[\[rollout\.milestone\]\] tables/);
    expect(attempt([newTicket({ ref: "c", rollout: { requires_live: ["d"] } }), newTicket({ ref: "d", scope: ["web/**"], depends_on: ["c"] })])).toThrow(/rollout order cycle (c -> d -> c|d -> c -> d) through depends_on, merge_after and requires_live/);
    expect(h.store.tickets(project().id)).toHaveLength(4);
  });

  it("refuses rollout on the integration strategy", async () => {
    await seedProject(h);
    expect(() => addTickets(h.ctx, project().id, [newTicket({ rollout: { dark: true } })], "thr_plan")).toThrow(/tickets\[0\]\.rollout: deploy order is advice .* merge\.strategy is "integration"/);
    expect(() => editTicket(h.ctx, "CSV-1", { rollout: { dark: true } }, "thr_plan")).toThrow(/rollout: deploy order is advice/);
  });

  it("changes the rollout of a ticket whose pull request is open or that is done, but not of a cancelled one", async () => {
    await seedProject(h, staged);
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { state: "pr_open" });
    expect(editTicket(h.ctx, "CSV-2", { rollout: { stage: "migrate", requires_live: ["CSV-1"] } }, "thr_plan").rollout_json).toBe(JSON.stringify({ stage: "migrate", requires_live: ["CSV-1"] }));
    expect(editTicket(h.ctx, "CSV-2", { rollout: { stage: "migrate", requires_live: ["CSV-1"] }, merge_after: [] }, "thr_plan").state).toBe("pr_open");
    expect(() => editTicket(h.ctx, "CSV-2", { title: "x", rollout: {} }, "thr_plan")).toThrow(/CSV-2 is pr_open; only a queued or blocked ticket/);
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { state: "done" });
    expect(editTicket(h.ctx, "CSV-2", { rollout: {} }, "thr_plan").rollout_json).toBeNull();
    expect(() => editTicket(h.ctx, "CSV-2", { merge_after: [] }, "thr_plan")).toThrow(/CSV-2 is done, so its merge order no longer matters/);
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { state: "cancelled" });
    expect(() => editTicket(h.ctx, "CSV-2", { rollout: {} }, "thr_plan")).toThrow(/CSV-2 is cancelled, so its rollout no longer matters/);
  });

  it("refuses moving a provider to a stage after a ticket that requires it, unless that ticket is cancelled", async () => {
    await seedProject(h, (doc) => {
      staged(doc);
      doc.rollout.stage.push({ name: "contract", goal: "The old path is gone" });
      doc.ticket[1].rollout = { stage: "migrate", requires_live: ["csv-model"] };
    });
    expect(() => editTicket(h.ctx, "CSV-1", { rollout: { stage: "contract" } }, "thr_plan")).toThrow(
      /rollout\.stage: CSV-2 requires CSV-1 live and is in the stage "migrate", which comes before "contract"\. Keep CSV-1 in "migrate" or an earlier stage, or move CSV-2 later first\./,
    );
    expect(ticketOf(h, "CSV-1").rollout_json).toBe(JSON.stringify({ stage: "expand" }));
    expect(editTicket(h.ctx, "CSV-1", { rollout: { stage: "migrate" } }, "thr_plan").rollout_json).toBe(JSON.stringify({ stage: "migrate" }));
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { state: "cancelled" });
    expect(editTicket(h.ctx, "CSV-1", { rollout: { stage: "contract" } }, "thr_plan").rollout_json).toBe(JSON.stringify({ stage: "contract" }));
  });

  it("refuses a rollout patch that names itself, an unknown ticket, a later stage or a cycle", async () => {
    await seedProject(h, staged);
    expect(() => editTicket(h.ctx, "CSV-1", { rollout: { requires_live: ["csv-model"] } }, "thr_plan")).toThrow(/cannot require itself to be live/);
    expect(() => editTicket(h.ctx, "CSV-1", { rollout: { requires_live: ["CSV-9"] } }, "thr_plan")).toThrow(/"CSV-9" is not a ticket on this board/);
    expect(() => editTicket(h.ctx, "CSV-1", { rollout: { stage: "expand", requires_live: ["traffic-low"] } }, "thr_plan")).toThrow(/comes after "expand"/);
    // CSV-2 depends on CSV-1, so CSV-1 needing CSV-2 live first is a loop.
    expect(() => editTicket(h.ctx, "CSV-1", { rollout: { requires_live: ["CSV-2"] } }, "thr_plan")).toThrow(/rollout order cycle/);
    expect(ticketOf(h, "CSV-1").rollout_json).toBe(JSON.stringify({ stage: "expand" }));
  });
});
