import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard, ChangesView, HomeView, PlanningSession, ProjectInsights, ProjectSummary, ProjectTimeline, ProjectView, TicketDetail, ThreadInfo } from "../src/contract";
import type { SpecVersionView } from "../src/spec-view";
import type { BbPluginApi, NewThreadRequest } from "@get-bb/plugin-sdk";
import { notesMessage } from "../src/prompts";
import { agentRows, boardCards, registerRpc, specSummary, watchChanges } from "../src/rpc";
import { START_FAILED, specOf } from "../src/workers";
import { withRepos } from "./fixtures";
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
  it("changes and changePatch read a project's changes from its host, and validate the commits", async () => {
    await approved();
    const view = await call<ChangesView>("changes", { slug: "csv" });
    expect(view).toMatchObject({ slug: "csv", branch: "loom/csv", unavailable: null });
    expect(view.sources.map((source) => source.id)).toEqual(["branch", "commit:CSV-1", "commit:CSV-2"]);
    const [base, head] = ["a".repeat(40), "b".repeat(40)];
    expect(await call("changePatch", { slug: "csv", path: "src/a.ts", base, head })).toMatchObject({ truncated: false });
    expect(host.hostPort.callsTo("filePatch")).toEqual([{ repo: "/repo", base, head, path: "src/a.ts", maxBytes: 400_000 }]);
    await expect(call("changePatch", { slug: "csv", path: "src/a.ts", base: "main", head })).rejects.toThrow();
  });

  it("changes and changePatch read each repo of a multi-repo project in its own checkout, and changePatch takes the repo", async () => {
    fake.addBbProject("proj_web", { host_env: "/src/web" });
    fake.addBbProject("proj_api", { host_env: "/src/api" });
    await approved(withRepos);
    const view = await call<ChangesView>("changes", { slug: "csv" });
    expect(view.repos.map((repo) => [repo.name, repo.remoteBase, repo.unavailable])).toEqual([
      ["web", "origin/main", null],
      ["api", "upstream/trunk", null],
    ]);
    expect(view.sources.map((source) => [source.id, source.repo])).toEqual([
      ["branch:web", "web"],
      ["branch:api", "api"],
      ["commit:CSV-1", "web"],
      ["commit:CSV-2", "api"],
    ]);
    const [base, head] = ["a".repeat(40), "b".repeat(40)];
    expect(await call("changePatch", { slug: "csv", path: "src/a.ts", base, head, repo: "api" })).toMatchObject({ truncated: false });
    expect(host.hostPort.callsTo("filePatch")).toEqual([{ repo: "/src/api", base, head, path: "src/a.ts", maxBytes: 400_000 }]);
    await expect(call("changePatch", { slug: "csv", path: "src/a.ts", base, head })).rejects.toThrow("needs the repo it is read in: one of web, api");
    await expect(call("changePatch", { slug: "csv", path: "src/a.ts", base, head, repo: "ios" })).rejects.toThrow('has no repo "ios"; its repos are web, api.');
    // A working ticket's patch ignores the repo, so only the contract refuses a name that is not a [[repo]] name.
    expect(await call("changePatch", { slug: "csv", path: "src/a.ts", key: "CSV-1", repo: "web" })).toEqual({ patch: null, message: "CSV-1 has no worktree now." });
    await expect(call("changePatch", { slug: "csv", path: "src/a.ts", key: "CSV-1", repo: "Web App" })).rejects.toThrow();
    expect(host.hostPort.callsTo("filePatch")).toHaveLength(1);
  });

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
    expect(view.spec).toMatchObject({ version: 1, pendingVersion: null });
    expect(view.spec).not.toHaveProperty("pendingToml");
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

  it("a draft's board holds its tickets with the keys approval will give them, in the same queue order", async () => {
    await propose(board);
    const view = await call<ProjectView>("project", { slug: "csv" });
    expect(view.board.map((entry) => [entry.key, entry.state, entry.title])).toEqual([
      ["CSV-1", "queued", "Model"],
      ["CSV-2", "queued", "Export"],
      ["CSV-3", "queued", "Model docs"],
      ["CSV-4", "queued", "Docs"],
      ["CSV-5", "queued", "Guide"],
    ]);
    expect(Object.fromEntries(view.board.map((entry) => [entry.key, { ready: entry.ready, waitingOn: entry.waitingOn }]))).toEqual({
      "CSV-1": { ready: true, waitingOn: [] },
      "CSV-2": { ready: false, waitingOn: ["CSV-1"] },
      "CSV-3": { ready: false, waitingOn: ["CSV-1"] },
      "CSV-4": { ready: true, waitingOn: [] },
      "CSV-5": { ready: false, waitingOn: ["CSV-4"] },
    });
    expect(view.board[1]).toMatchObject({ deps: ["CSV-1"], attempt: 0, threadId: null, prUrl: null, blockedReason: null });
  });

  it("project carries the next step: approve for a draft, start for a ready project", async () => {
    await propose();
    const draft = await call<ProjectView>("project", { slug: "csv" });
    expect(draft.next).toMatchObject({ stage: 1, action: { control: "approve", version: 1, label: "Approve v1 · create 2 tickets" } });
    await host.projects.approve("csv", "human");
    const ready = await call<ProjectView>("project", { slug: "csv" });
    expect(ready.next).toMatchObject({ stage: 3 });
    expect(ready.next!.action).toEqual({ control: "start", label: "Start project · 1 worker", confirm: "Click again to start 1 worker" });
  });

  it("a revised draft's next step, board and approval all take the newest version, and the older one is refused", async () => {
    await propose();
    await propose(board);
    const draft = await call<ProjectView>("project", { slug: "csv" });
    expect(draft.spec.version).toBe(2);
    expect(draft.next!.action).toMatchObject({ control: "approve", version: 2, label: "Approve v2 · create 5 tickets" });
    expect(draft.board.map((entry) => entry.title)).toEqual(["Model", "Export", "Model docs", "Docs", "Guide"]);
    await expect(call("control", { slug: "csv", action: "approve", version: 1, confirm: true })).rejects.toThrow("Spec version 1 is not the one waiting for approval (version 2)");
    const ready = await call<ProjectView>("control", { slug: "csv", action: "approve", version: draft.next!.action!.version, confirm: true });
    expect(ready.overview).toMatchObject({ state: "ready", approvedVersion: 2 });
    expect(ready.board.map((entry) => entry.key)).toEqual(["CSV-1", "CSV-2", "CSV-3", "CSV-4", "CSV-5"]);
    expect(host.projects.spec("csv", 1).status).toBe("superseded");
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
    expect(ticket.threads).toEqual([expect.objectContaining({ threadId: "thr_w1", role: "worker", attempt: 1, reviewRound: 0, state: "active" })]);
    expect(ticket).toMatchObject({ depsDone: [], replyTo: "worker", stoppedFrom: null });
    expect(ticket.activity).toMatchObject({ brief: { postId: brief.id }, before: [], attempts: [{ n: 1, threadId: "thr_w1", outcome: "in_progress", endedAt: null }] });
    await expect(call("ticket", { key: "CSV-99" })).rejects.toThrow(/No ticket/);
  });

  it("ticket says how each review stands: its verdict, a reviewer that could not start, one that ended without a verdict, or pending", async () => {
    await running();
    const ticket = host.store.ticketByKey("CSV-1")!;
    const reviewer = (state: "active" | "ended", threadId: string | null, endReason: string | null) => {
      const row = host.store.addThread({ project_id: ticket.project_id, ticket_id: ticket.id, role: "reviewer", state, thread_id: threadId });
      if (state === "ended") host.store.updateThread(row.id, { ended_at: row.started_at, end_reason: endReason });
      return host.store.addReview({ ticket_id: ticket.id, round: 1, thread_row_id: row.id });
    };
    reviewer("ended", null, "failed");
    reviewer("ended", "thr_r2", "abandoned");
    reviewer("active", "thr_r3", null);
    host.store.setVerdict(reviewer("ended", "thr_r4", "verdict").id, "changes_requested", "Off by one", []);
    const detail = await call<TicketDetail>("ticket", { key: "CSV-1" });
    expect(detail.reviews.map((review) => [review.verdict, review.status])).toEqual([
      ["pending", "reviewer could not start"],
      ["pending", "ended without a verdict"],
      ["pending", "pending"],
      ["changes_requested", "changes requested"],
    ]);
    expect(detail.reviews.map((review) => review.threadId)).toEqual([null, "thr_r2", "thr_r3", "thr_r4"]);
  });

  it("ticket puts a recorded run into its check card with the size of its output", async () => {
    await running();
    await host.engine.tick();
    const ticket = host.store.ticketByKey("CSV-1")!;
    host.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "worker", author_thread_id: "thr_w1", kind: "submit", body: "Done" });
    const id = host.store.startRun({ project_id: ticket.project_id, ticket_id: ticket.id, stage: "check", kind: "command", label: "npm test" });
    host.store.finishRun(id, { ok: false, output: "1 failing", exitCode: 1, durationMs: 300 });
    const detail = await call<TicketDetail>("ticket", { key: "CSV-1" });
    expect(detail.activity.attempts[0]!.items[1]).toMatchObject({
      type: "checks",
      postId: null,
      status: "unfinished",
      steps: [{ label: "npm test", runId: id, ok: false, exitCode: 1, durationMs: 300, outputChars: 9 }],
    });
  });

  it("ticket says who hears a reply, and where a blocked ticket stopped", async () => {
    await running();
    await host.engine.tick();
    const blocked = await call<TicketDetail>("ticketAction", { key: "CSV-1", action: "block", note: "Wrong approach", confirm: true });
    expect(blocked).toMatchObject({ state: "blocked", replyTo: "planner", stoppedFrom: "working" });
    const queued = await call<TicketDetail>("ticket", { key: "CSV-2" });
    expect(queued).toMatchObject({ state: "queued", deps: ["CSV-1"], depsDone: [], replyTo: null, stoppedFrom: null });
  });

  it("runOutput returns a run's output, and null for an unknown id", async () => {
    await running();
    const ticket = host.store.ticketByKey("CSV-1")!;
    const id = host.store.startRun({ project_id: ticket.project_id, ticket_id: ticket.id, stage: "merge", kind: "git", label: "git merge" });
    host.store.finishRun(id, { ok: true, output: "Merged as m1; the branch was at base000." });
    expect(await call("runOutput", { id })).toEqual({ output: "Merged as m1; the branch was at base000." });
    const coloured = host.store.startRun({ project_id: ticket.project_id, ticket_id: ticket.id, stage: "check", kind: "command", label: "npm test" });
    host.store.finishRun(coloured, { ok: false, output: "\u001b[31m1 failing\u001b[39m", exitCode: 1 });
    expect(await call("runOutput", { id: coloured })).toEqual({ output: "1 failing" });
    expect(await call("runOutput", { id: 999 })).toBeNull();
  });

  it("insights returns the story, the numbers and the activity of the whole project, and a window of it", async () => {
    await approved();
    await call("control", { slug: "csv", action: "start", confirm: true });
    const view = await call<ProjectInsights>("insights", { slug: "csv" });
    expect(view).toMatchObject({ state: "running", strategy: "integration", window: "all", range: null, presets: { run: false, day: false } });
    expect(view.groups.map((group) => group.title)).toEqual(["Planning", "Running now"]);
    expect(view.groups[0]!.items).toContainEqual(expect.objectContaining({ type: "created", by: ["from the spec you approved"], tickets: [expect.objectContaining({ key: "CSV-1" }), expect.objectContaining({ key: "CSV-2" })] }));
    expect(view.figures.map((figure) => figure.label)).toEqual(["Running time", "A ticket takes", "Right first time", "Tokens"]);
    expect(view.numbers.maxWorkers).toBe(2);
    expect(view.activity.marks.filter((mark) => mark.kind === "milestone").map((mark) => mark.text)).toEqual(["Spec version 1 was approved."]);

    const project = host.store.projectBySlug("csv")!;
    const created = host.store.projectEvents(project.id)[0]!.at;
    const ranged = await call<ProjectInsights>("insights", { slug: "csv", window: { from: created, to: created } });
    expect(ranged.range).toEqual({ from: created, to: created });
    expect(ranged.groups.flatMap((group) => group.lines).every((line) => line.at === created)).toBe(true);
    expect((await call<ProjectInsights>("insights", { slug: "csv", window: "run" })).range).toMatchObject({ to: expect.any(Number) });
    await expect(call("insights", { slug: "csv", window: "week" })).rejects.toThrow();
    await expect(call("insights", { slug: "csv", window: { from: 1 } })).rejects.toThrow();
    await expect(call("insights", { slug: "nope" })).rejects.toThrow(/No Loom project/);
  });

  it("insights of a draft shows planning, with no ticket yet", async () => {
    await propose();
    const view = await call<ProjectInsights>("insights", { slug: "csv" });
    expect(view.state).toBe("draft");
    expect(view.headline).toBe("Planning: no ticket exists until you approve the spec.");
    expect(view.current).toEqual([]);
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

  it("control approves a pending version through the engine, which requeues a ticket whose worker never started", async () => {
    await approved();
    host.store.setTicketState(ticketId("CSV-1"), "working", "loom");
    host.store.setTicketState(ticketId("CSV-1"), "blocked", "loom", { reason: START_FAILED });
    for (const state of ["working", "checking", "review", "blocked"] as const) host.store.setTicketState(ticketId("CSV-2"), state, "loom");
    host.store.updateTicket(ticketId("CSV-2"), { head_sha: "abc1234", review_round: 1, blocked_reason: "bb refused to start a reviewer: HTTP 400: Unsupported provider claude" });
    await propose((doc) => (doc.project.goal = "Let people export their orders as a CSV file, with filters."));
    const pending = await call<ProjectView>("project", { slug: "csv" });
    expect(pending.next?.action).toMatchObject({ control: "approve", version: 2, label: "Approve v2 · requeue 2 tickets" });
    expect(pending.next?.text).toContain("sends CSV-2 back to review, because bb refused to start its reviewer");
    const view = await call<ProjectView>("control", { slug: "csv", action: "approve", version: 2, confirm: true });
    expect(view.board.find((card) => card.key === "CSV-1")?.state).toBe("queued");
    expect(view.board.find((card) => card.key === "CSV-2")).toMatchObject({ state: "review", reviewRound: 2 });
    expect(humanEvents().at(-1)).toMatchObject({ action: "approve", pending: true });
  });

  it("control refuses what the engine refuses, with its message and no event", async () => {
    await approved();
    await expect(call("control", { slug: "csv", action: "pause", confirm: true })).rejects.toThrow(/needs a running project/);
    await expect(call("control", { slug: "csv", action: "land", confirm: true })).rejects.toThrow(/can be landed/);
    await expect(call("control", { slug: "csv", action: "landDirect", confirm: true })).rejects.toThrow(/can be landed/);
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

  it("control land and landDirect take a repo on a multi-repo project, and refuse an unknown one or a repo with another action", async () => {
    fake.addBbProject("proj_web", { host_env: "/src/web" });
    fake.addBbProject("proj_api", { host_env: "/src/api" });
    await running((doc) => {
      doc.repo = [
        { name: "web", project: "proj_web" },
        { name: "api", project: "proj_api", base: "trunk", remote: "upstream" },
      ];
      doc.ticket[0].repo = "web";
      doc.ticket[1].repo = "api";
      doc.ticket[1].depends_on = [];
    });
    for (const key of ["CSV-1", "CSV-2"]) for (const state of ["working", "checking", "review", "approved", "merging", "done"] as const) host.store.setTicketState(ticketId(key), state, "loom");

    await expect(call("control", { slug: "csv", action: "land", repo: "mobile", confirm: true })).rejects.toThrow('Project csv has no repo "mobile"; its repos are web, api.');
    await expect(call("control", { slug: "csv", action: "pause", repo: "web", confirm: true })).rejects.toThrow("A repo goes only with land and landDirect, not with pause.");
    await expect(call("control", { slug: "csv", action: "land", repo: "", confirm: true })).rejects.toThrow();
    expect(host.hostPort.callsTo("push")).toEqual([]);

    const view = await call<ProjectView>("control", { slug: "csv", action: "land", repo: "api", confirm: true });
    expect(view.overview.state).toBe("running");
    expect(host.hostPort.callsTo("push")).toEqual([{ repo: "/src/api", remote: "upstream", src: "base000", branch: "loom/csv" }]);
    expect(host.store.projectRepos(host.store.projectBySlug("csv")!.id).map((row) => row.name)).toEqual(["api"]);

    await call("control", { slug: "csv", action: "landDirect", repo: "web", confirm: true });
    expect(host.hostPort.callsTo("push").at(-1)).toEqual({ repo: "/src/web", remote: "origin", src: "base000", branch: "main" });
    expect(host.store.projectBySlug("csv")!.state).toBe("done");
    expect(humanEvents().filter((event) => event.action === "land")).toEqual([
      { actor: "human", action: "land", slug: "csv", repo: "api" },
      { actor: "human", action: "land", slug: "csv", repo: "web", direct: true },
    ]);
  });
});

describe("repos", () => {
  const PR = (n: number) => `https://github.com/acme/shop/pull/${n}`;
  const withRepos = (doc: Doc) => {
    doc.repo = [
      { name: "web", project: "proj_web" },
      { name: "api", project: "proj_api", base: "trunk", remote: "upstream" },
    ];
    doc.ticket[0].repo = "web";
    doc.ticket[1].repo = "api";
    doc.ticket[1].depends_on = [];
  };
  const addProjects = () => {
    fake.addBbProject("proj_web", { host_env: "/src/web" }, { name: "shop-web" });
    fake.addBbProject("proj_api", { host_env: "/src/api" }, { name: "shop-api" });
  };
  const toDone = (key: string) => {
    for (const state of ["working", "checking", "review", "approved", "merging", "done"] as const) host.store.setTicketState(ticketId(key), state, "loom");
  };
  const names = (repos: Array<{ bbProjectId: string; bbProjectName: string | null }>) => repos.map((repo) => [repo.bbProjectId, repo.bbProjectName]);

  it("project names each repo's bb project, and every card and ticket carries its repo", async () => {
    addProjects();
    await running(withRepos);
    const view = await call<ProjectView>("project", { slug: "csv" });
    expect(view.overview.repos).toEqual([
      { name: "web", bbProjectId: "proj_web", bbProjectName: "shop-web", base: "main", branch: "loom/csv", prUrl: null, landedAt: null, toLand: false },
      { name: "api", bbProjectId: "proj_api", bbProjectName: "shop-api", base: "trunk", branch: "loom/csv", prUrl: null, landedAt: null, toLand: false },
    ]);
    expect(view.spec.summary.repos).toEqual([
      { name: "web", bbProjectId: "proj_web", bbProjectName: "shop-web" },
      { name: "api", bbProjectId: "proj_api", bbProjectName: "shop-api" },
    ]);
    expect(view.board.map((card) => [card.key, card.repo])).toEqual([
      ["CSV-1", "web"],
      ["CSV-2", "api"],
    ]);
    expect((await call<TicketDetail>("ticket", { key: "CSV-2" })).repo).toBe("api");

    toDone("CSV-1");
    toDone("CSV-2");
    expect((await call<ProjectView>("project", { slug: "csv" })).next).toMatchObject({ stage: 5, text: expect.stringContaining('the repos "web" and "api" have merged work that is not landed yet') });
    const landed = await call<ProjectView>("control", { slug: "csv", action: "land", repo: "web", confirm: true });
    expect(landed.overview.repos.map((repo) => [repo.name, repo.prUrl, repo.toLand, repo.bbProjectName])).toEqual([
      ["web", PR(1), false, "shop-web"],
      ["api", null, true, "shop-api"],
    ]);
    expect(landed.next).toMatchObject({ text: expect.stringContaining('the repo "api" has merged work that is not landed yet'), action: { control: "land", label: "Land · 1 repo" } });
  });

  it("a single-repo project has one repo in the Loom project's bb project, and its cards and tickets none", async () => {
    await approved();
    const view = await call<ProjectView>("project", { slug: "csv" });
    expect(view.overview.repos).toEqual([{ name: null, bbProjectId: "proj_1", bbProjectName: "shop", base: "main", branch: "loom/csv", prUrl: null, landedAt: null, toLand: false }]);
    expect(view.spec.summary.repos).toEqual([]);
    expect(view.board.map((card) => card.repo)).toEqual([null, null]);
    expect((await call<TicketDetail>("ticket", { key: "CSV-1" })).repo).toBeNull();
  });

  it("a draft's summary and cards carry the repos before approval", async () => {
    addProjects();
    await propose(withRepos);
    const view = await call<ProjectView>("project", { slug: "csv" });
    expect(names(view.spec.summary.repos)).toEqual([
      ["proj_web", "shop-web"],
      ["proj_api", "shop-api"],
    ]);
    expect(view.board.map((card) => [card.key, card.repo])).toEqual([
      ["CSV-1", "web"],
      ["CSV-2", "api"],
    ]);
    expect(names(view.overview.repos)).toEqual(names(view.spec.summary.repos));
  });

  it("projects and home name the repos' bb projects too, and every view leaves a name null when bb cannot list its projects", async () => {
    addProjects();
    await running(withRepos);
    expect(names((await call<ProjectSummary[]>("projects"))[0]!.repos)).toEqual([
      ["proj_web", "shop-web"],
      ["proj_api", "shop-api"],
    ]);
    expect(names((await call<HomeView>("home")).projects[0]!.repos)).toEqual([
      ["proj_web", "shop-web"],
      ["proj_api", "shop-api"],
    ]);

    fake.bbProjects = new Error("bb is restarting");
    const unnamed = [
      ["proj_web", null],
      ["proj_api", null],
    ];
    const view = await call<ProjectView>("project", { slug: "csv" });
    expect(names(view.overview.repos)).toEqual(unnamed);
    expect(names(view.spec.summary.repos)).toEqual(unnamed);
    expect(names((await call<ProjectSummary[]>("projects"))[0]!.repos)).toEqual(unnamed);
    expect(names((await call<HomeView>("home")).projects[0]!.repos)).toEqual(unnamed);
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

  it("threadInfo describes an open planning conversation until it proposes, and is null once one without a spec ends", async () => {
    const { threadId } = await host.projects.startPlanning({ request: request(), merge: "integration", reviewer: "" });
    expect(await call<ThreadInfo | null>("threadInfo", { threadId })).toEqual({ role: "planner", slug: null, key: null, state: "planning" });
    await host.projects.propose({ toml: specToml(), threadId, bbProjectId: "proj_1", hostId: "host_env" });
    expect(await call<ThreadInfo | null>("threadInfo", { threadId })).toEqual({ role: "planner", slug: "csv", key: null, state: "draft" });

    const other = await host.projects.startPlanning({ request: request(), merge: "integration", reviewer: "" });
    host.projects.planningGone(other.threadId, "archived");
    expect(await call("threadInfo", { threadId: other.threadId })).toBeNull();
  });

  it("startPlanning passes the service's refusal on with its message", async () => {
    await expect(start({ request: request({ input: [{ type: "text", text: "  ", mentions: [] }] }) })).rejects.toThrow(/Describe what should exist/);
  });

  it("bbProjects lists bb's standard projects for the repo picker, with the machines that have a checkout", async () => {
    fake.addBbProject("proj_api", {}, { name: "shop-api" });
    fake.addBbProject("proj_personal", {}, { name: "Personal", kind: "personal" });
    expect(await call("bbProjects", null)).toEqual([
      { id: "proj_1", name: "shop", hostIds: ["host_local", "host_1"] },
      { id: "proj_api", name: "shop-api", hostIds: [] },
    ]);
    fake.bbProjects = new Error("bb is restarting");
    await expect(call("bbProjects", null)).rejects.toThrow(/could not read bb's projects to list the repos: bb is restarting/);
  });

  it("startPlanning lists the picked repos in the kickoff, refuses an unknown or personal one naming it, and takes at most 10", async () => {
    fake.addBbProject("proj_api", { host_local: "/api" }, { name: "shop-api" });
    fake.addBbProject("proj_personal", {}, { name: "Personal", kind: "personal" });
    const kickoffs = () => fake.callsTo("spawnPlanner").map(([args]) => (args as { kickoff: string }).kickoff);
    await start({ repos: ["proj_api"] });
    expect(kickoffs()[0]).toContain("besides this thread's own project: shop-api (proj_api).");

    await expect(start({ repos: ["proj_gone"] })).rejects.toThrow(/bb has no project "proj_gone"/);
    await expect(start({ repos: ["proj_personal"] })).rejects.toThrow(/"proj_personal" is bb's personal project/);
    await expect(start({ repos: Array.from({ length: 11 }, (_, n) => `proj_${n}`) })).rejects.toThrow();
    await expect(start({ repos: [""] })).rejects.toThrow();
    expect(kickoffs()).toHaveLength(1);

    await start();
    expect(kickoffs()[1]).not.toContain("picked");
  });

  it("project on a draft carries a summary of the spec: tickets, checks, reviewer and warnings", async () => {
    await propose((doc) => (doc.agents.reviewer = { provider: "claude", model: "sonnet" }));
    const { spec } = await call<ProjectView>("project", { slug: "csv" });
    expect(spec.summary).toEqual({
      tickets: [
        { ref: "csv-model", title: "Order rows", dependsOn: [] },
        { ref: "csv-export", title: "Export endpoint", dependsOn: ["csv-model"] },
      ],
      repos: [],
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

describe("spec versions", () => {
  const revise = () =>
    propose((doc) => {
      doc.project.goal = "Let people export their orders and customers as CSV files.";
      doc.ticket[1].acceptance[1] = "WHEN there are no orders THE SYSTEM SHALL return an empty file";
    });

  it("specVersion returns the newest version with its parsed spec, its status, every version and what it changed", async () => {
    await propose();
    await revise();
    const view = await call<SpecVersionView>("specVersion", { slug: "csv" });
    expect(view).toMatchObject({ slug: "csv", version: 2, status: "draft", warnings: [], overlaps: [], notes: [] });
    expect(view.versions).toEqual([
      { version: 1, status: "superseded" },
      { version: 2, status: "draft" },
    ]);
    expect(view.changes).toEqual({ changed: ["project.goal", "ticket[csv-export].acceptance[1]"], removed: [] });
    expect(view.spec.project.goal).toBe("Let people export their orders and customers as CSV files.");
    expect(view.toml).toContain("orders and customers");

    const first = await call<SpecVersionView>("specVersion", { slug: "csv", version: 1 });
    expect(first).toMatchObject({ version: 1, status: "superseded", changes: null });
    await expect(call("specVersion", { slug: "csv", version: 9 })).rejects.toThrow(/no spec version 9/);
  });

  it("specVersion lists Loom's reviews of this version and the ones before, leaving out replaced ones", async () => {
    await propose();
    const id = host.store.projectBySlug("csv")!.id;
    const first = host.store.addSpecReview({ project_id: id, version: 1, round: 1, spawn_token: "t1" });
    host.store.endSpecReview(first.id, "changes_requested", { summary: "Too wide.", findings: [{ path: "ticket[csv-export]", title: "Split it", detail: "Two changes." }] });
    await revise();
    const replaced = host.store.addSpecReview({ project_id: id, version: 2, round: 2, spawn_token: "t2" });
    host.store.endSpecReview(replaced.id, "superseded", { reason: "replaced" });
    host.store.addSpecReview({ project_id: id, version: 2, round: 2, spawn_token: "t3" });

    const view = await call<SpecVersionView>("specVersion", { slug: "csv" });
    expect(view.reviews).toMatchObject([
      { version: 1, round: 1, state: "changes_requested", summary: "Too wide.", findings: [{ path: "ticket[csv-export]", title: "Split it", detail: "Two changes." }] },
      { version: 2, round: 2, state: "reviewing", findings: [], endedAt: null },
    ]);
    expect((await call<SpecVersionView>("specVersion", { slug: "csv", version: 1 })).reviews.map((row) => row.version)).toEqual([1]);
  });

  it("plannerView, messagePlanner and dismissAsk read the planner's work, message it as the human, and set its asks aside", async () => {
    await approved();
    await expect(call("plannerView", { threadId: "thr_nobody" })).resolves.toBeNull();
    const view = await call<{ steps: Array<{ kind: string }>; ask: unknown }>("plannerView", { threadId: "thr_plan" });
    expect(view.steps.map((step) => step.kind)).toEqual(["started", "turn"]);

    const messaged = await call<{ steps: Array<{ kind: string; text?: string }> }>("messagePlanner", { threadId: "thr_plan", text: "Is CSV-2 still needed?", confirm: true });
    expect(messaged.steps.at(-1)).toMatchObject({ kind: "message", text: "Is CSV-2 still needed?" });
    expect(fake.sent("thr_plan").at(-1)).toBe("Is CSV-2 still needed?");
    await expect(call("messagePlanner", { threadId: "thr_plan", text: "x", confirm: true }, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow("for the human");

    const project = host.store.projectBySlug("csv")!;
    host.store.event(project.id, null, "planner.asked", "thr_plan", { why: "", steps: [{ action: "other", text: "Check the alert." }] });
    const ask = host.store.eventsOfKind(project.id, "planner.asked")[0]!.id;
    expect((await call<{ ask: unknown }>("plannerView", { threadId: "thr_plan" })).ask).toMatchObject({ id: ask, open: true });
    expect((await call<{ ask: unknown }>("dismissAsk", { slug: "csv", ask, confirm: true })).ask).toBeNull();
    expect(humanEvents().at(-1)).toEqual({ actor: "human", action: "dismissAsk", slug: "csv", ask });
  });

  it("specVersion compares a draft with the version before, or with the base it is given", async () => {
    await propose();
    await revise();
    await propose((doc) => {
      doc.project.goal = "Let people export their orders and customers as CSV files, by date.";
      doc.ticket[1].acceptance[1] = "WHEN there are no orders THE SYSTEM SHALL return an empty file";
    });
    const view = await call<SpecVersionView>("specVersion", { slug: "csv" });
    expect(view.compared).toMatchObject({ version: 2, status: "superseded" });
    expect(view.compared!.spec.project.goal).toBe("Let people export their orders and customers as CSV files.");
    const first = await call<SpecVersionView>("specVersion", { slug: "csv", version: 3, base: 1 });
    expect(first.compared).toMatchObject({ version: 1, status: "superseded" });
    // `changes` stays what the version changed from the one before, whatever it is compared with.
    expect(first.changes).toEqual({ changed: ["project.goal"], removed: [] });
    expect((await call<SpecVersionView>("specVersion", { slug: "csv", version: 1 })).compared).toBeNull();
    await expect(call("specVersion", { slug: "csv", version: 2, base: 2 })).rejects.toThrow("Compare v2 with an older version, v1 to v1.");
  });

  it("specVersion compares a pending version with the version in force, not with a superseded one", async () => {
    await approved();
    await revise();
    await propose((doc) => {
      doc.project.goal = "Let people export their orders and customers as CSV files, by date.";
      doc.ticket[1].acceptance[1] = "WHEN there are no orders THE SYSTEM SHALL return an empty file";
    });
    const view = await call<SpecVersionView>("specVersion", { slug: "csv" });
    expect(view).toMatchObject({ version: 3, status: "pending" });
    expect(view.compared).toMatchObject({ version: 1, status: "approved" });
    expect(view.compared!.spec.project.goal).toBe("Let people export their orders as a CSV file from the admin page.");
  });

  it("specVersion names the overlapping tickets by ref, with the view's warnings", async () => {
    await propose(board);
    const view = await call<SpecVersionView>("specVersion", { slug: "csv" });
    expect(view.overlaps).toEqual([
      { a: "model", b: "model-docs", paths: ["src/model/**", "src/model/readme.md"] },
      { a: "docs", b: "guide", paths: ["docs/**", "docs/guide/**"] },
    ]);
    expect(view.warnings).toHaveLength(2);
  });

  it("specVersion reads the sent notes and whether the planner's next version changed their part", async () => {
    await propose();
    const project = host.store.projectBySlug("csv")!;
    const notes = [
      { version: 1, paths: ["project.goal"], body: "Say who exports." },
      { version: 1, paths: ["ticket[csv-model].title"], body: "Name the rows." },
      { version: 1, paths: ["spec"], body: "Keep it small." },
    ];
    host.store.event(project.id, null, "human.action", "human", { action: "notes", slug: "csv", notes });
    await revise();
    const view = await call<SpecVersionView>("specVersion", { slug: "csv" });
    expect(view.notes).toEqual([
      { ...notes[0], sentAt: expect.any(Number), answeredIn: 2, changed: true },
      { ...notes[1], sentAt: expect.any(Number), answeredIn: 2, changed: false },
      // Any change answers a note on the whole spec.
      { ...notes[2], sentAt: expect.any(Number), answeredIn: 2, changed: true },
    ]);
  });
});

describe("sendNotes", () => {
  const notes = [{ version: 1, paths: ["ticket[csv-export].acceptance[1]"], body: "Say what the header row holds." }];
  const send = (input: Record<string, unknown> = {}, options?: Parameters<typeof call>[2]) => call<SpecVersionView>("sendNotes", { slug: "csv", notes, confirm: true, ...input }, options);

  it("sends the notes to the planner as one message and logs them as a human action", async () => {
    await propose();
    const view = await send();
    expect(view.notes[0]).toMatchObject({ version: 1, answeredIn: null, changed: false });
    const message = notesMessage({ slug: "csv", version: 1, status: "draft", notes });
    expect(fake.sent("thr_plan")).toEqual([message]);
    expect(message.startsWith("[loom] The human reviewed spec v1 (draft) of csv on the Loom page and left 1 note.")).toBe(true);
    expect(message).toContain("1. ticket[csv-export].acceptance[1]\n   Say what the header row holds.");
    expect(humanEvents().at(-1)).toEqual({ actor: "human", action: "notes", slug: "csv", notes });
  });

  it("asks to confirm notes written on an older version, and marks them when sent", async () => {
    await propose();
    await propose((doc) => (doc.project.goal = "Let people export their orders and customers as CSV files."));
    await expect(send()).rejects.toThrow("1 note was written on v1, and v2 is newer. Read v2, then send it again or confirm.");
    expect(fake.sent("thr_plan")).toEqual([]);
    await send({ includeOlder: true });
    expect(fake.sent("thr_plan")[0]).toContain("[loom] The human reviewed spec v2 (draft) of csv");
    expect(fake.sent("thr_plan")[0]).toContain("1. ticket[csv-export].acceptance[1] (written on v1)\n");
  });

  it("sends a suggested value as TOML before the note's text, and a suggestion with no text on its own", async () => {
    await propose();
    const suggested = [
      { version: 1, paths: ["merge.strategy"], body: "Review each part as its own pull request.", suggest: { from: '"integration"', to: '"pr"' } },
      { version: 1, paths: ["agents.max_workers"], body: "", suggest: { from: "2", to: "1" } },
    ];
    await send({ notes: suggested });
    const [message] = fake.sent("thr_plan");
    expect(message).toContain("A suggested value is written as TOML; use it unless it breaks the spec, and then say why.");
    expect(message).toContain('1. merge.strategy\n   Suggested value: "pr" (now "integration")\n   Review each part as its own pull request.\n\n2. agents.max_workers\n   Suggested value: 1 (now 2)');
    expect(message!.endsWith("Suggested value: 1 (now 2)")).toBe(true);
    expect(humanEvents().at(-1)).toEqual({ actor: "human", action: "notes", slug: "csv", notes: suggested });
    expect(notesMessage({ slug: "csv", version: 1, status: "draft", notes })).not.toContain("Suggested value");
  });

  it("refuses a missing version, a missing confirm, another plugin and a planner that ended, and sends nothing", async () => {
    await propose();
    await expect(send({ notes: [{ ...notes[0], version: 9 }] })).rejects.toThrow("Project csv has no spec version 9.");
    await expect(send({ confirm: undefined })).rejects.toThrow();
    await expect(send({ notes: [{ ...notes[0], body: "   " }] })).rejects.toThrow();
    await expect(send({ notes: [{ ...notes[0], suggest: { from: "2", to: " " } }] })).rejects.toThrow();
    await expect(send({}, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow(/human/);
    host.projects.threadGone("thr_plan", "archived");
    await expect(send()).rejects.toThrow("Project csv has no planner thread to send notes to.");
    expect(fake.sent("thr_plan")).toEqual([]);
    expect(humanEvents()).toEqual([]);
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

describe("rewind", () => {
  // makeHost hands the store Date.now when it runs, so the clock is faked before the host is built.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fake = new FakePort();
    host = makeHost({ port: fake });
    registerRpc(host.bb, { projects: host.projects, engine: host.engine, store: host.store, now: Date.now });
  });
  const later = () => vi.setSystemTime(Date.now() + 1000);
  const newest = () => host.store.projectEvents(host.store.projectBySlug("csv")!.id).at(-1)!;

  it("project at an event shows the board as it was then, and the live view and controls stay as they are", async () => {
    await approved();
    later();
    await call("control", { slug: "csv", action: "start", confirm: true });
    const before = newest();
    later();
    await host.engine.tick();

    const past = await call<ProjectView>("project", { slug: "csv", at: before.id });
    expect(past.board.find((card) => card.key === "CSV-1")).toMatchObject({ state: "queued", attempt: 0, threadId: null });
    expect(past.overview).toMatchObject({ state: "running", ticketCounts: { queued: 2 }, goal: "Let people export their orders as a CSV file from the admin page." });
    expect(past).toMatchObject({ at: before.id, now: before.at });

    const live = await call<ProjectView>("project", { slug: "csv" });
    expect(live.at).toBeNull();
    expect(live.board.find((card) => card.key === "CSV-1")).toMatchObject({ state: "working", attempt: 1 });
    expect(live.board.map((card) => card.state)).toEqual(host.store.tickets(host.store.projectBySlug("csv")!.id).map((ticket) => ticket.state));
    const paused = await call<ProjectView>("control", { slug: "csv", action: "pause", confirm: true });
    expect(paused).toMatchObject({ at: null, overview: { state: "paused" } });
  });

  it("project before the start shows a ready project with only the planner's thread", async () => {
    await approved();
    const ready = newest().id;
    later();
    await call("control", { slug: "csv", action: "start", confirm: true });
    later();
    await host.engine.tick();

    const past = await call<ProjectView>("project", { slug: "csv", at: ready });
    expect(past.overview.state).toBe("ready");
    expect(past.agents.map((row) => row.role)).toEqual(["planner"]);
    expect((await call<ProjectView>("project", { slug: "csv" })).agents.map((row) => row.role)).toEqual(["worker", "planner"]);
  });

  it("ticket at an event leaves out the posts after it and takes no reply, and refuses a ticket that did not exist yet", async () => {
    await propose();
    const drafted = newest().id;
    later();
    await host.projects.approve("csv", "human");
    later();
    await call("control", { slug: "csv", action: "start", confirm: true });
    later();
    await host.engine.tick();
    const moment = newest();
    later();
    host.projects.post("CSV-1", { body: "Use the v2 API", author: "human" });

    const past = await call<TicketDetail>("ticket", { key: "CSV-1", at: moment.id });
    expect(past.posts.map((post) => post.kind)).toEqual(["brief", "claim"]);
    expect(past).toMatchObject({ state: "working", attempt: 1, replyTo: null, at: moment.id, now: moment.at });
    const live = await call<TicketDetail>("ticket", { key: "CSV-1" });
    expect(live.at).toBeNull();
    expect(live.replyTo).toBe("worker");
    expect(live.posts.map((post) => post.body)).toContain("Use the v2 API");
    await expect(call("ticket", { key: "CSV-1", at: drafted })).rejects.toThrow("CSV-1 did not exist yet at that moment.");
  });

  it("insights at an event read only what happened up to it", async () => {
    await running();
    const moment = newest();
    later();
    for (const to of ["working", "checking", "review", "approved", "merging", "done"] as const) host.store.setTicketState(ticketId("CSV-1"), to, "loom");

    const past = await call<ProjectInsights>("insights", { slug: "csv", at: moment.id });
    expect(past.now).toBe(moment.at);
    expect(past.groups.flatMap((group) => group.lines).every((line) => line.id <= moment.id)).toBe(true);
    expect(past.numbers.reached).toBe(0);
    expect(past.activity.marks.some((mark) => mark.kind === "done")).toBe(false);
    const live = await call<ProjectInsights>("insights", { slug: "csv" });
    expect(live.numbers.reached).toBe(1);
    expect(live.activity.marks.filter((mark) => mark.kind === "done").map((mark) => mark.key)).toEqual(["CSV-1"]);
  });

  it("timeline lists the events and moments in order, a bar for a started ticket and the human's start", async () => {
    await approved();
    later();
    await call("control", { slug: "csv", action: "start", confirm: true });
    later();
    await host.engine.tick();

    const timeline = await call<ProjectTimeline>("timeline", { slug: "csv" });
    const ids = timeline.events.map(([id]) => id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids.at(-1)).toBe(newest().id);
    expect(timeline.tickets.map((bar) => bar.key)).toEqual(["CSV-1"]);
    expect(timeline.moments.map((moment) => moment.id)).toEqual([...timeline.moments.map((moment) => moment.id)].sort((a, b) => a - b));
    expect(timeline.moments.flatMap((moment) => moment.lines).filter((line) => line.kind === "you").map((line) => line.text)).toEqual(["You ran start."]);
  });

  it("project at an event shows each repo's land as it was then", async () => {
    fake.addBbProject("proj_web", { host_env: "/src/web" }, { name: "shop-web" });
    fake.addBbProject("proj_api", { host_env: "/src/api" });
    await running((doc) => {
      doc.repo = [
        { name: "web", project: "proj_web" },
        { name: "api", project: "proj_api" },
      ];
      doc.ticket[0].repo = "web";
      doc.ticket[1].repo = "api";
      doc.ticket[1].depends_on = [];
    });
    later();
    for (const state of ["working", "checking", "review", "approved", "merging", "done"] as const) host.store.setTicketState(ticketId("CSV-1"), state, "loom");
    const merged = newest();
    later();
    await call("control", { slug: "csv", action: "land", confirm: true });
    const landedAt = Date.now();

    const past = await call<ProjectView>("project", { slug: "csv", at: merged.id });
    expect(past.overview.repos.map((repo) => [repo.name, repo.bbProjectName, repo.prUrl, repo.landedAt, repo.toLand])).toEqual([
      ["web", "shop-web", null, null, true],
      ["api", "api", null, null, false],
    ]);
    expect(past.next).toMatchObject({ title: "Running." });
    const live = await call<ProjectView>("project", { slug: "csv" });
    expect(live.overview.repos.map((repo) => [repo.name, repo.prUrl, repo.landedAt, repo.toLand])).toEqual([
      ["web", "https://github.com/acme/shop/pull/1", landedAt, false],
      ["api", null, null, false],
    ]);
  });

  it("refuses a moment before the project's first event", async () => {
    host.store.createProject({ slug: "other", name: "Other", key: "OTH", bb_project_id: "p" }, "human");
    const other = host.store.projectEvents(host.store.projectBySlug("other")!.id)[0]!.id;
    later();
    await approved();
    await expect(call("project", { slug: "csv", at: other })).rejects.toThrow(`Event ${other} is before csv started.`);
  });
});
