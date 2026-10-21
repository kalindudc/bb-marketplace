import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard, FeedRow, HomeView, PlanningSession, ProjectSummary, ProjectView, TicketDetail, ThreadInfo } from "../src/contract";
import type { ProjectMetrics } from "../src/metrics";
import type { BbPluginApi, NewThreadRequest } from "@get-bb/plugin-sdk";
import { agentRows, boardCards, registerRpc, specSummary, watchChanges } from "../src/rpc";
import { specOf } from "../src/workers";
import { FakePort, makeCtx, makeHost, seedProject, specToml, startWorker, type Doc } from "./helpers";

let host: ReturnType<typeof makeHost>;
let fake: FakePort;

beforeEach(() => {
  fake = new FakePort();
  host = makeHost({ port: fake });
  registerRpc(host.bb, { projects: host.projects, engine: host.engine, store: host.store, now: Date.now });
});
afterEach(() => {
  vi.useRealTimers();
});

const call = <T>(method: string, input?: unknown, options?: { experimental_caller?: { kind: "client" } | { kind: "plugin"; pluginId: string } }) => host.harness.behavior.callRpc(method, input, options) as Promise<T>;
const propose = (edit?: (doc: Doc) => void) => host.projects.propose({ toml: specToml(edit), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_env" });
const approved = async (edit?: (doc: Doc) => void) => {
  await propose(edit);
  await host.projects.approve("csv", "human");
};
const running = async (edit?: (doc: Doc) => void) => {
  await approved(edit);
  await call("control", { slug: "csv", action: "start", confirm: true });
};
const ticketId = (key: string) => host.store.ticketByKey(key)!.id;
const humanEvents = () =>
  host.store
    .events(host.store.projectBySlug("csv")!.id)
    .filter((event) => event.kind === "human.action")
    .map((event) => ({ actor: event.actor, ...(JSON.parse(event.data_json) as { action: string }) }));

// CSV-1 and CSV-4 are ready; CSV-2 waits on CSV-1; CSV-3's scope sits inside CSV-1's; CSV-5's sits inside CSV-4's.
const board = (doc: Doc) => {
  const acceptance = ["WHEN the thing runs THE SYSTEM SHALL do it"];
  doc.ticket = [
    { ref: "model", title: "Model", body: "Build it.", acceptance, scope: ["src/model/**"] },
    { ref: "export", title: "Export", body: "Serve it.", acceptance, scope: ["src/export/**"], depends_on: ["model"] },
    { ref: "model-docs", title: "Model docs", body: "Write it.", acceptance, scope: ["src/model/readme.md"] },
    { ref: "docs", title: "Docs", body: "Write the docs.", acceptance, scope: ["docs/**"] },
    { ref: "guide", title: "Guide", body: "Write the guide.", acceptance, scope: ["docs/guide/**"] },
  ];
};

describe("reads", () => {
  it("projects lists the project summaries", async () => {
    expect(await call("projects")).toEqual([]);
    await approved();
    const listed = await call<ProjectSummary[]>("projects");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ slug: "csv", name: "CSV export", key: "CSV", state: "ready", strategy: "integration", ticketCount: 2, ticketCounts: { queued: 2 } });
  });

  it("project returns the overview, the board, the metrics and the spec", async () => {
    await approved();
    const view = await call<ProjectView>("project", { slug: "csv" });
    expect(view.overview).toMatchObject({ slug: "csv", state: "ready" });
    expect(view.board.map((card) => [card.key, card.state, card.ready])).toEqual([
      ["CSV-1", "queued", true],
      ["CSV-2", "queued", false],
    ]);
    expect(view.board[0]).toMatchObject({ title: "Order rows", priority: 2, attempt: 0, reviewRound: 0, deps: [], threadId: null, prUrl: null });
    expect(view.metrics.counts.queued).toBe(2);
    expect(view.metrics.cumulativeFlow).toHaveLength(14);
    expect(view.spec).toMatchObject({ version: 1, pendingVersion: null, pendingToml: null });
    expect(view.spec.toml).toContain('slug = "csv"');
    expect(view.prUrl).toBeNull();
    expect(typeof view.now).toBe("number");
    await expect(call("project", { slug: "nope" })).rejects.toThrow(/No Loom project/);
  });

  it("project carries a pending spec version beside the approved one", async () => {
    await approved();
    await propose((doc) => (doc.project.goal = "Let people export their orders as a CSV file, with filters."));
    const { spec } = await call<ProjectView>("project", { slug: "csv" });
    expect(spec).toMatchObject({ version: 1, pendingVersion: 2 });
    expect(spec.pendingToml).toContain("with filters");
  });

  it("project shows the draft spec of a project that is not approved yet", async () => {
    await propose();
    const { spec } = await call<ProjectView>("project", { slug: "csv" });
    expect(spec).toMatchObject({ version: 1, pendingVersion: null });
  });

  it("waitingOn names an unmet dependency, an overlapping in-flight ticket and an overlapping ticket picked first", async () => {
    await approved(board);
    const first = await call<ProjectView>("project", { slug: "csv" });
    const waiting = (cards: BoardCard[]) => Object.fromEntries(cards.map((card) => [card.key, { ready: card.ready, waitingOn: card.waitingOn }]));
    expect(waiting(first.board)).toEqual({
      "CSV-1": { ready: true, waitingOn: [] },
      "CSV-2": { ready: false, waitingOn: ["CSV-1"] },
      "CSV-3": { ready: false, waitingOn: ["CSV-1"] },
      "CSV-4": { ready: true, waitingOn: [] },
      "CSV-5": { ready: false, waitingOn: ["CSV-4"] },
    });

    host.store.setTicketState(ticketId("CSV-1"), "working", "loom");
    const second = await call<ProjectView>("project", { slug: "csv" });
    expect(waiting(second.board)).toEqual({
      "CSV-1": { ready: false, waitingOn: [] },
      "CSV-2": { ready: false, waitingOn: ["CSV-1"] },
      "CSV-3": { ready: false, waitingOn: ["CSV-1"] },
      "CSV-4": { ready: true, waitingOn: [] },
      "CSV-5": { ready: false, waitingOn: ["CSV-4"] },
    });

    host.store.setTicketState(ticketId("CSV-4"), "working", "loom");
    const third = await call<ProjectView>("project", { slug: "csv" });
    expect(third.board.find((card) => card.key === "CSV-5")).toMatchObject({ ready: false, waitingOn: ["CSV-4"] });
  });

  it("every queued ticket that is not ready has a reason", async () => {
    await approved(board);
    host.store.setTicketState(ticketId("CSV-1"), "working", "loom");
    const { board: cards } = await call<ProjectView>("project", { slug: "csv" });
    for (const card of cards.filter((entry) => entry.state === "queued" && !entry.ready)) expect(card.waitingOn.length).toBeGreaterThan(0);
  });

  it("a card links to the live worker thread", async () => {
    await running();
    await host.engine.tick();
    const { board: cards } = await call<ProjectView>("project", { slug: "csv" });
    expect(cards.find((card) => card.key === "CSV-1")).toMatchObject({ state: "working", attempt: 1, threadId: "thr_w1" });
  });

  it("ticket returns the brief with its reply thread, reviews and threads", async () => {
    await running();
    await host.engine.tick();
    const brief = host.store.posts(ticketId("CSV-1"))[0]!;
    const reply = host.projects.post("CSV-1", { body: "Use the v2 API", parentId: brief.id, author: "human" });
    host.projects.post("CSV-1", { body: "Done that", parentId: reply.id, author: "worker", threadId: "thr_w1" });
    const ticket = await call<TicketDetail>("ticket", { key: "CSV-1" });
    expect(ticket).toMatchObject({ slug: "csv", projectState: "running", key: "CSV-1", title: "Order rows", state: "working", attempt: 1, scope: ["src/model/**"], reviews: [] });
    expect(ticket.acceptance).toEqual(["WHEN an order is mapped THE SYSTEM SHALL return one row"]);
    expect(ticket.posts.map((post) => [post.kind, post.depth, post.parentId])).toEqual([
      ["brief", 0, null],
      ["reply", 1, brief.id],
      ["reply", 2, reply.id],
      ["claim", 0, null],
    ]);
    expect(ticket.threads).toEqual([expect.objectContaining({ threadId: "thr_w1", role: "worker", state: "active" })]);
    await expect(call("ticket", { key: "CSV-99" })).rejects.toThrow(/No ticket/);
  });

  it("feed returns the newest events oldest first, and only newer ones after an id", async () => {
    await approved();
    const all = await call<{ rows: FeedRow[]; lastId: number }>("feed", { slug: "csv" });
    expect(all.rows.map((row) => row.kind)).toEqual(expect.arrayContaining(["project.created", "spec.approved", "ticket.created", "project.state"]));
    expect(all.rows.map((row) => row.id)).toEqual([...all.rows.map((row) => row.id)].sort((a, b) => a - b));
    expect(all.lastId).toBe(all.rows.at(-1)!.id);
    expect(all.rows.find((row) => row.kind === "ticket.created")).toMatchObject({ ticketKey: "CSV-1", text: "CSV-1 was created." });

    await call("control", { slug: "csv", action: "start", confirm: true });
    const later = await call<{ rows: FeedRow[]; lastId: number }>("feed", { slug: "csv", afterId: all.lastId });
    expect(later.rows.map((row) => row.text)).toEqual(["The project moved from ready to running.", "The human ran start."]);
    expect(later.lastId).toBeGreaterThan(all.lastId);
    expect(await call("feed", { slug: "csv", afterId: later.lastId })).toEqual({ rows: [], lastId: later.lastId });
  });

  it("feed keeps only the newest 200 events", async () => {
    await approved();
    const project = host.store.projectBySlug("csv")!;
    for (let n = 0; n < 250; n += 1) host.store.event(project.id, null, "custom", "loom", { n });
    const { rows } = await call<{ rows: FeedRow[]; lastId: number }>("feed", { slug: "csv" });
    expect(rows).toHaveLength(200);
    expect(rows.at(-1)).toMatchObject({ text: "custom by loom." });
  });

  it("project has the health strip once the spec is approved, and none for a draft", async () => {
    await propose();
    expect((await call<ProjectView>("project", { slug: "csv" })).health).toBeNull();
    await host.projects.approve("csv", "human");
    const { health } = await call<ProjectView>("project", { slug: "csv" });
    expect(health).toMatchObject({ progress: { done: 0, total: 2, inFlight: 0, blocked: 0, queued: 2 }, budget: null, deadline: null, capacity: { workers: 0, maxWorkers: 2, reviewers: 0, maxReviewers: 2, readyWaiting: 0 } });
  });

  it("project lists its agents, the live ones first, with the spec's model and the worker's timeout", async () => {
    await running();
    await host.engine.tick();
    const project = host.store.projectBySlug("csv")!;
    const reviewer = host.store.addThread({ project_id: project.id, role: "reviewer", state: "active", thread_id: "thr_r9", ticket_id: ticketId("CSV-2") });
    host.store.updateThread(reviewer.id, { state: "ended", ended_at: Date.now(), end_reason: "verdict", tokens: 400, review_round: 1 });
    const { agents } = await call<ProjectView>("project", { slug: "csv" });
    const worker = host.store.threadByThreadId("thr_w1")!;
    expect(agents.map((row) => [row.role, row.threadId, row.state])).toEqual([
      ["worker", "thr_w1", "active"],
      ["planner", "thr_plan", "active"],
      ["reviewer", "thr_r9", "ended"],
    ]);
    expect(agents[0]).toMatchObject({ ticketKey: "CSV-1", ticketTitle: "Order rows", model: "claude / sonnet", timeoutAt: worker.clock_at! + 120 * 60_000, endReason: null });
    expect(agents[1]).toMatchObject({ ticketKey: null, model: null, timeoutAt: null });
    expect(agents[2]).toMatchObject({ ticketKey: "CSV-2", model: "codex / gpt", endReason: "verdict", tokens: 400, reviewRound: 1, timeoutAt: null });
  });

  it("metrics returns the project's metrics over a 7, 14 or 30 day window, and refuses any other window", async () => {
    await approved();
    expect((await call<ProjectMetrics>("metrics", { slug: "csv", days: 30 })).throughput).toHaveLength(30);
    expect((await call<ProjectMetrics>("metrics", { slug: "csv", days: 7 })).cumulativeFlow).toHaveLength(7);
    await expect(call("metrics", { slug: "csv", days: 9 })).rejects.toThrow();
    await expect(call("metrics", { slug: "csv" })).rejects.toThrow();
    await expect(call("metrics", { slug: "nope", days: 14 })).rejects.toThrow(/No Loom project/);
  });

  it("home returns the totals, what needs the human and the project rows", async () => {
    await propose();
    const home = await call<HomeView>("home");
    expect(Object.keys(home).sort()).toEqual(["needsYou", "now", "projects", "totals"]);
    expect(home.totals).toMatchObject({ projects: 1, running: 0, planners: 1, slots: 0 });
    expect(home.needsYou).toEqual([expect.objectContaining({ kind: "approve", slug: "csv", text: "has a draft spec v1 with 2 tickets" })]);
    expect(home.projects).toEqual([expect.objectContaining({ slug: "csv", state: "draft", agents: 0, maxTokens: null })]);
  });

  it("threadInfo names the role, project, ticket and state of a Loom thread, and is null for any other", async () => {
    await running();
    await host.engine.tick();
    expect(await call<ThreadInfo | null>("threadInfo", { threadId: "thr_plan" })).toEqual({ role: "planner", slug: "csv", key: null, state: "running" });
    expect(await call<ThreadInfo | null>("threadInfo", { threadId: "thr_w1" })).toEqual({ role: "worker", slug: "csv", key: "CSV-1", state: "working" });
    expect(await call("threadInfo", { threadId: "thr_unknown" })).toBeNull();
  });
});

describe("agentRows", () => {
  it("shows a timeout only for a worker whose ticket is being worked on, and no model for a part the spec leaves out", async () => {
    const h = makeCtx();
    await seedProject(h, (doc) => (doc.agents = { worker: { provider: "claude" }, reviewer: {} }));
    const row = await startWorker(h);
    const project = h.store.projectBySlug("csv")!;
    const spec = specOf(h.store, project);
    const rows = () => agentRows(h.store.threadsForProject(project.id), h.store.tickets(project.id), spec);
    const worker = () => rows().find((entry) => entry.role === "worker")!;
    expect(worker()).toMatchObject({ model: "claude", timeoutAt: h.store.thread(row.id)!.clock_at! + 120 * 60_000 });
    h.store.setTicketState(row.ticket_id!, "checking", "loom");
    expect(worker().timeoutAt).toBeNull();
    h.store.addThread({ project_id: project.id, role: "reviewer", state: "active", thread_id: "thr_r1", ticket_id: row.ticket_id });
    expect(rows().find((entry) => entry.role === "reviewer")!.model).toBeNull();
    expect(agentRows(h.store.threadsForProject(project.id), h.store.tickets(project.id), null).every((entry) => entry.model === null && entry.timeoutAt === null)).toBe(true);
  });
});

describe("changes", () => {
  it("are refused without confirm: true, and with extra keys", async () => {
    await approved();
    await expect(call("control", { slug: "csv", action: "start" })).rejects.toThrow();
    await expect(call("control", { slug: "csv", action: "start", confirm: false })).rejects.toThrow();
    await expect(call("control", { slug: "csv", action: "start", confirm: true, extra: 1 })).rejects.toThrow();
    await expect(call("reply", { key: "CSV-1", body: "hi" })).rejects.toThrow();
    await expect(call("ticketAction", { key: "CSV-1", action: "cancel", note: "no" })).rejects.toThrow();
    await expect(call("ticketAction", { key: "CSV-1", action: "cancel", note: "", confirm: true })).rejects.toThrow();
    await expect(call("control", { slug: "csv", action: "land2", confirm: true })).rejects.toThrow();
    expect(host.store.projectBySlug("csv")!.state).toBe("ready");
    expect(humanEvents()).toEqual([]);
  });

  it("are refused when another plugin calls, but reads still work", async () => {
    await approved();
    const plugin = { experimental_caller: { kind: "plugin" as const, pluginId: "other" } };
    await expect(call("control", { slug: "csv", action: "start", confirm: true }, plugin)).rejects.toThrow(/human/);
    await expect(call("reply", { key: "CSV-1", body: "hi", confirm: true }, plugin)).rejects.toThrow(/human/);
    await expect(call("ticketAction", { key: "CSV-1", action: "cancel", note: "no", confirm: true }, plugin)).rejects.toThrow(/human/);
    expect(host.store.projectBySlug("csv")!.state).toBe("ready");
    expect(humanEvents()).toEqual([]);
    expect(await call("projects", null, plugin)).toHaveLength(1);
  });

  it("control runs the lifecycle as the human, one human.action event each, and returns the refreshed view", async () => {
    await propose();
    const approvedView = await call<ProjectView>("control", { slug: "csv", action: "approve", confirm: true });
    expect(approvedView.overview.state).toBe("ready");
    expect(approvedView.board).toHaveLength(2);
    expect((await call<ProjectView>("control", { slug: "csv", action: "start", confirm: true })).overview.state).toBe("running");
    expect((await call<ProjectView>("control", { slug: "csv", action: "pause", confirm: true })).overview.state).toBe("paused");
    expect((await call<ProjectView>("control", { slug: "csv", action: "resume", confirm: true })).overview.state).toBe("running");
    expect((await call<ProjectView>("control", { slug: "csv", action: "pauseNow", confirm: true })).overview.state).toBe("paused");
    expect((await call<ProjectView>("control", { slug: "csv", action: "archive", confirm: true })).overview.state).toBe("archived");
    expect(humanEvents()).toEqual([
      { actor: "human", action: "approve", slug: "csv", pending: false },
      { actor: "human", action: "start", slug: "csv" },
      { actor: "human", action: "pause", slug: "csv" },
      { actor: "human", action: "resume", slug: "csv" },
      { actor: "human", action: "pause", slug: "csv", now: true },
      { actor: "human", action: "archive", slug: "csv" },
    ]);
  });

  it("control approves a pending spec version, and refuses a version that is not the pending one", async () => {
    await approved();
    await propose((doc) => (doc.project.goal = "Let people export their orders as a CSV file, with filters."));
    await expect(call("control", { slug: "csv", action: "approve", version: 5, confirm: true })).rejects.toThrow(/not the one waiting/);
    const view = await call<ProjectView>("control", { slug: "csv", action: "approve", version: 2, confirm: true });
    expect(view.spec).toMatchObject({ version: 2, pendingVersion: null });
    expect(humanEvents()).toEqual([{ actor: "human", action: "approve", slug: "csv", pending: true }]);
  });

  it("control refuses what the engine refuses, with its message and no event", async () => {
    await approved();
    await expect(call("control", { slug: "csv", action: "pause", confirm: true })).rejects.toThrow(/needs a running project/);
    await expect(call("control", { slug: "csv", action: "land", confirm: true })).rejects.toThrow(/can be landed/);
    expect(humanEvents()).toEqual([]);
  });

  it("ticketAction cancel ends a live worker and writes one human.action event", async () => {
    await running();
    await host.engine.tick();
    const view = await call<TicketDetail>("ticketAction", { key: "CSV-1", action: "cancel", note: "Not needed", confirm: true });
    expect(view).toMatchObject({ key: "CSV-1", state: "cancelled" });
    expect(view.posts.at(-1)).toMatchObject({ authorKind: "human", body: "Cancelled: Not needed" });
    expect(host.store.threadByThreadId("thr_w1")?.state).toBe("ended");
    expect(fake.callsTo("stop")).toEqual([["thr_w1"]]);
    expect(fake.callsTo("archive")).toEqual([["thr_w1"]]);
    expect(humanEvents().filter((event) => event.action !== "start")).toEqual([{ actor: "human", action: "cancel", slug: "csv", key: "CSV-1" }]);
  });

  it("ticketAction block and requeue go through the engine, with the note as the reason or as a reply", async () => {
    await running();
    await host.engine.tick();
    const blocked = await call<TicketDetail>("ticketAction", { key: "CSV-1", action: "block", note: "Wrong approach", confirm: true });
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "Wrong approach" });
    const requeued = await call<TicketDetail>("ticketAction", { key: "CSV-1", action: "requeue", note: "Use the v2 API", confirm: true });
    expect(requeued.state).toBe("queued");
    expect(requeued.posts.at(-1)).toMatchObject({ kind: "reply", authorKind: "human", body: "Use the v2 API" });
    expect(humanEvents().map((event) => event.action)).toEqual(["start", "block", "requeue"]);
    await expect(call("ticketAction", { key: "CSV-2", action: "requeue", note: "go", confirm: true })).rejects.toThrow(/only a blocked ticket/);
  });

  it("reply adds the human's post under its parent and delivers it to a live worker as the CLI does", async () => {
    await running();
    await host.engine.tick();
    const brief = host.store.posts(ticketId("CSV-1"))[0]!;
    const view = await call<TicketDetail>("reply", { key: "CSV-1", body: "Use the v2 API", parentId: brief.id, confirm: true });
    expect(view.posts.find((post) => post.body === "Use the v2 API")).toMatchObject({ authorKind: "human", kind: "reply", parentId: brief.id, depth: 1 });
    expect(fake.callsTo("send")).toEqual([["thr_w1", { summary: "[loom] Reply on CSV-1 from the human", detail: "Use the v2 API (answering #" + brief.id + ")" }]]);
    expect(humanEvents().at(-1)).toEqual({ actor: "human", action: "post", slug: "csv", key: "CSV-1" });
    await expect(call("reply", { key: "CSV-1", body: "x", parentId: 9999, confirm: true })).rejects.toThrow(/another ticket or does not exist/);
  });
});

describe("planning", () => {
  const request = (over: Partial<NewThreadRequest> = {}): NewThreadRequest => ({
    projectId: "proj_1",
    providerId: "codex",
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "auto",
    executionInputSources: {},
    environment: { type: "project-default" },
    input: [{ type: "text", text: "Let people export their orders as CSV.", mentions: [] }],
    ...over,
  });
  const start = (input: Record<string, unknown> = {}, options?: Parameters<typeof call>[2]) => call<{ threadId: string }>("startPlanning", { request: request(), merge: "integration", reviewer: "codex, gpt-5", confirm: true, ...input }, options);

  it("startPlanning starts one planner and returns its thread id, and planning and planningSession return the session", async () => {
    expect(await start()).toEqual({ threadId: "thr_p1" });
    expect(fake.callsTo("spawnPlanner")).toHaveLength(1);
    const session = { threadId: "thr_p1", title: "Let people export their orders as CSV.", startedAt: expect.any(Number), slug: null, projectState: null };
    expect(await call<PlanningSession[]>("planning", null)).toEqual([session]);
    expect(await call<PlanningSession | null>("planningSession", { threadId: "thr_p1" })).toEqual(session);
    expect(await call("planningSession", { threadId: "thr_nope" })).toBeNull();
  });

  it("startPlanning is refused without confirm, with a request that has no projectId, and from another plugin", async () => {
    await expect(start({ confirm: undefined })).rejects.toThrow();
    const { projectId: _, ...noProject } = request();
    await expect(start({ request: noProject })).rejects.toThrow();
    await expect(start({ request: "not a request" })).rejects.toThrow();
    await expect(start({}, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow(/human/);
    expect(fake.callsTo("spawnPlanner")).toEqual([]);
    expect(host.store.openPlanning()).toEqual([]);
  });

  it("startPlanning passes the service's refusal on with its message", async () => {
    await expect(start({ request: request({ input: [{ type: "text", text: "  ", mentions: [] }] }) })).rejects.toThrow(/Describe what should exist/);
  });

  it("project on a draft carries a summary of the spec: tickets, checks, reviewer and warnings", async () => {
    await propose((doc) => (doc.agents.reviewer = { provider: "claude", model: "sonnet" }));
    const { spec } = await call<ProjectView>("project", { slug: "csv" });
    expect(spec.summary).toEqual({
      tickets: [
        { ref: "csv-model", title: "Order rows", dependsOn: [] },
        { ref: "csv-export", title: "Export endpoint", dependsOn: ["csv-model"] },
      ],
      checks: ["npm test"],
      reviewer: "claude / sonnet",
      warnings: [expect.stringContaining("same provider and model as the worker")],
    });
  });

  it("specSummary has no reviewer when neither provider nor model is set, and turns parse errors into warnings", () => {
    expect(specSummary(specToml((doc) => (doc.agents = {}))).reviewer).toBeNull();
    expect(specSummary(specToml((doc) => (doc.agents.reviewer = { model: "gpt" }))).reviewer).toBe("gpt");
    const broken = specSummary("[project");
    expect(broken).toMatchObject({ tickets: [], checks: [], reviewer: null });
    expect(broken.warnings[0]).toMatch(/^TOML: /);
  });
});

describe("live updates", () => {
  const signals = () => host.harness.realtimeSignals.filter((signal) => signal.channel === "loom:changed");

  it("publishes one loom:changed message per project for a burst of events", () => {
    vi.useFakeTimers();
    const stop = watchChanges(host.bb, host.store);
    const project = host.store.createProject({ slug: "csv", name: "CSV", key: "CSV", bb_project_id: "p" }, "human");
    host.store.event(project.id, null, "a", "human");
    host.store.event(project.id, null, "b", "human");
    expect(signals()).toEqual([]);
    vi.advanceTimersByTime(299);
    expect(signals()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(signals()).toEqual([{ channel: "loom:changed", payload: { slug: "csv" } }]);

    host.store.event(project.id, null, "c", "human");
    vi.advanceTimersByTime(300);
    expect(signals()).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(signals()).toHaveLength(2);
    stop();
  });

  it("throttles each project on its own", () => {
    vi.useFakeTimers();
    const stop = watchChanges(host.bb, host.store);
    const one = host.store.createProject({ slug: "one", name: "One", key: "ONE", bb_project_id: "p" }, "human");
    vi.advanceTimersByTime(100);
    const two = host.store.createProject({ slug: "two", name: "Two", key: "TWO", bb_project_id: "p" }, "human");
    host.store.event(one.id, null, "a", "human");
    host.store.event(two.id, null, "a", "human");
    vi.advanceTimersByTime(300);
    expect(signals().map((signal) => (signal.payload as { slug: string }).slug).sort()).toEqual(["one", "two"]);
    stop();
  });

  it("delivers a change that lands inside a window with that window's message, and the next one in its own", () => {
    vi.useFakeTimers();
    const stop = watchChanges(host.bb, host.store);
    const project = host.store.createProject({ slug: "csv", name: "CSV", key: "CSV", bb_project_id: "p" }, "human");
    vi.advanceTimersByTime(250);
    host.store.changed(project.id);
    vi.advanceTimersByTime(50);
    expect(signals()).toHaveLength(1);

    vi.advanceTimersByTime(10);
    host.store.changed(project.id);
    vi.advanceTimersByTime(299);
    expect(signals()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(signals()).toHaveLength(2);
    stop();
  });

  it("publishes one { slug: null } message for a burst of changes outside any project", () => {
    vi.useFakeTimers();
    const stop = watchChanges(host.bb, host.store);
    host.store.addPlanning({ thread_id: "thr_p1", bb_project_id: "proj_1", title: "Plan" });
    host.store.endPlanning("thr_p1", "archived");
    expect(signals()).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(signals()).toEqual([{ channel: "loom:changed", payload: { slug: null } }]);
    stop();
  });

  it("publishes a row-only change that no event accompanies", () => {
    vi.useFakeTimers();
    const project = host.store.createProject({ slug: "csv", name: "CSV", key: "CSV", bb_project_id: "p" }, "human");
    const stop = watchChanges(host.bb, host.store);
    host.store.changed(project.id);
    vi.advanceTimersByTime(300);
    expect(signals()).toEqual([{ channel: "loom:changed", payload: { slug: "csv" } }]);
    stop();
  });

  it("publishes again when a slow spawn binds the worker's thread after the events were already sent", async () => {
    vi.useFakeTimers();
    const h = makeCtx();
    const project = await seedProject(h);
    const publish = vi.fn();
    const stop = watchChanges({ realtime: { publish } } as unknown as BbPluginApi, h.store);
    let release!: () => void;
    let reserved!: () => void;
    const started = new Promise<void>((resolve) => (reserved = resolve));
    const spawn = h.bb.spawnThread.bind(h.bb);
    h.bb.spawnThread = async (args) => {
      reserved();
      await new Promise<void>((resolve) => (release = resolve));
      return spawn(args);
    };
    const spawning = startWorker(h);
    await started;
    await vi.advanceTimersByTimeAsync(300);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(boardCards(h.store.tickets(project.id), h.store.threadsForProject(project.id))[0]!.threadId).toBeNull();

    publish.mockClear();
    release();
    await spawning;
    await vi.advanceTimersByTimeAsync(300);
    expect(h.store.ticketByKey("CSV-1")!.worker_thread_id).toBe("thr_w1");
    expect(publish.mock.calls).toEqual([["loom:changed", { slug: "csv" }]]);
    stop();
  });

  it("stops publishing once disposed, even for a timer already waiting", () => {
    vi.useFakeTimers();
    const stop = watchChanges(host.bb, host.store);
    const project = host.store.createProject({ slug: "csv", name: "CSV", key: "CSV", bb_project_id: "p" }, "human");
    stop();
    vi.advanceTimersByTime(1000);
    host.store.event(project.id, null, "a", "human");
    vi.advanceTimersByTime(1000);
    expect(signals()).toEqual([]);
  });
});
