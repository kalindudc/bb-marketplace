import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/schema";
import { Store, type NewTicket } from "../src/db/store";
import { toLite } from "../src/scheduler";
import { AUTHOR_KINDS, POST_KINDS, PROJECT_STATES, REVIEW_VERDICTS, ROLES, THREAD_STATES, TICKET_STATES, canMoveProject, canMoveTicket } from "../src/states";
import { Clock, makeDb } from "./helpers";

let db: Database.Database;
let clock: Clock;
let store: Store;

beforeEach(() => {
  db = makeDb();
  clock = new Clock();
  store = new Store(db, clock.now);
});

const newProject = (slug = "csv") => ({ slug, name: "CSV export", key: slug.toUpperCase(), bb_project_id: "proj_1" });
const newTicket = (projectId: number, seq: number, over: Partial<NewTicket> = {}): NewTicket => ({
  project_id: projectId,
  seq,
  key: `CSV-${seq}`,
  ref: `ticket-${seq}`,
  title: `Ticket ${seq}`,
  body: "Do the work.",
  acceptance_json: "[]",
  verify_json: "[]",
  scope_json: '["src/**"]',
  deps_json: "[]",
  priority: 2,
  ...over,
});

const eventKinds = (projectId: number) => store.events(projectId).map((event) => event.kind);

describe("state maps", () => {
  it("allows only the documented project moves", () => {
    expect(canMoveProject("draft", "ready")).toBe(true);
    expect(canMoveProject("draft", "running")).toBe(false);
    expect(canMoveProject("running", "paused")).toBe(true);
    expect(canMoveProject("paused", "running")).toBe(true);
    expect(canMoveProject("paused", "done")).toBe(true);
    expect(canMoveProject("done", "running")).toBe(false);
    expect(canMoveProject("archived", "draft")).toBe(false);
    for (const state of PROJECT_STATES) if (state !== "archived") expect(canMoveProject(state, "archived")).toBe(true);
  });

  it("allows only the documented ticket moves", () => {
    expect(canMoveTicket("queued", "working")).toBe(true);
    expect(canMoveTicket("queued", "review")).toBe(false);
    expect(canMoveTicket("review", "approved")).toBe(true);
    expect(canMoveTicket("merging", "pr_open")).toBe(true);
    expect(canMoveTicket("blocked", "queued")).toBe(true);
    expect(canMoveTicket("blocked", "review")).toBe(true);
    expect(canMoveTicket("blocked", "pr_open")).toBe(true);
    expect(canMoveTicket("blocked", "working")).toBe(false);
    expect(canMoveTicket("working", "blocked")).toBe(true);
    expect(canMoveTicket("blocked", "blocked")).toBe(false);
    expect(canMoveTicket("working", "cancelled")).toBe(true);
    expect(canMoveTicket("blocked", "cancelled")).toBe(true);
    expect(canMoveTicket("done", "cancelled")).toBe(false);
    expect(canMoveTicket("done", "blocked")).toBe(false);
    expect(canMoveTicket("cancelled", "queued")).toBe(false);
  });
});

describe("schema", () => {
  it("events refuse UPDATE and DELETE", () => {
    const project = store.createProject(newProject(), "human");
    expect(() => db.prepare("UPDATE events SET kind = 'x'").run()).toThrow("events is append-only");
    expect(() => db.prepare("DELETE FROM events WHERE project_id = ?").run(project.id)).toThrow("events is append-only");
  });

  it("a CHECK constraint refuses an unknown ticket state", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    expect(() => db.prepare("UPDATE tickets SET state = 'flying' WHERE id = ?").run(ticket.id)).toThrow(/CHECK/);
  });

  it("the CHECK lists accept every constant in states.ts", () => {
    const project = store.createProject(newProject(), "human");
    for (const state of PROJECT_STATES) db.prepare("UPDATE projects SET state = ? WHERE id = ?").run(state, project.id);
    for (const state of TICKET_STATES) {
      db.prepare("INSERT INTO tickets (project_id, seq, key, ref, title, body, state, created_by, created_at, updated_at, state_at) VALUES (?, ?, ?, ?, 't', 'b', ?, 'x', 0, 0, 0)").run(project.id, TICKET_STATES.indexOf(state), `K-${state}`, state, state);
    }
    const ticket = store.createTicket(newTicket(project.id, 99), "human");
    for (const kind of POST_KINDS) {
      for (const author of AUTHOR_KINDS) {
        db.prepare("INSERT INTO posts (project_id, ticket_id, author_kind, kind, body, at) VALUES (?, ?, ?, ?, 'x', 0)").run(project.id, ticket.id, author, kind);
      }
    }
    for (const role of ROLES) {
      for (const state of THREAD_STATES) db.prepare("INSERT INTO threads (project_id, role, state, started_at) VALUES (?, ?, ?, 0)").run(project.id, role, state);
    }
    for (const verdict of REVIEW_VERDICTS) db.prepare("INSERT INTO reviews (ticket_id, round, verdict, at) VALUES (?, 1, ?, 0)").run(ticket.id, verdict);
  });
});

describe("projects", () => {
  it("creates a draft project with one event", () => {
    const project = store.createProject({ ...newProject(), host_id: "host_1", section_id: "sec_1", planner_thread_id: "thr_1" }, "thr_1");
    expect(project).toMatchObject({ slug: "csv", key: "CSV", state: "draft", host_id: "host_1", section_id: "sec_1", planner_thread_id: "thr_1", approved_version: null, created_at: clock.t });
    expect(store.project(project.id)).toEqual(project);
    expect(store.projectBySlug("csv")).toEqual(project);
    expect(store.projectBySlug("nope")).toBeNull();
    expect(store.events(project.id)).toMatchObject([{ kind: "project.created", actor: "thr_1", ticket_id: null }]);
  });

  it("an invalid move throws and names both states, and writes no event", () => {
    const project = store.createProject(newProject(), "human");
    expect(() => store.setProjectState(project.id, "running", "human")).toThrow(/draft.*running/);
    expect(store.project(project.id)?.state).toBe("draft");
    expect(eventKinds(project.id)).toEqual(["project.created"]);
  });

  it("writes exactly one event per state change, in the same transaction", () => {
    const project = store.createProject(newProject(), "human");
    clock.advance(1000);
    const ready = store.setProjectState(project.id, "ready", "human", "approved");
    expect(ready).toMatchObject({ state: "ready", updated_at: clock.t, system_reason: "approved" });
    const events = store.events(project.id);
    expect(events.map((event) => event.kind)).toEqual(["project.created", "project.state"]);
    expect(JSON.parse(events[1]!.data_json)).toEqual({ from: "draft", to: "ready", reason: "approved" });

    expect(() =>
      store.tx(() => {
        store.setProjectState(project.id, "running", "human");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.project(project.id)?.state).toBe("ready");
    expect(eventKinds(project.id)).toEqual(["project.created", "project.state"]);
  });

  it("updateProject patches columns without an event", () => {
    const project = store.createProject(newProject(), "human");
    clock.advance(5);
    store.updateProject(project.id, { section_id: "sec_9", pending_version: 2 });
    expect(store.project(project.id)).toMatchObject({ section_id: "sec_9", pending_version: 2, updated_at: clock.t });
    expect(eventKinds(project.id)).toEqual(["project.created"]);
  });

  it("refuses a duplicate slug or key", () => {
    store.createProject(newProject(), "human");
    expect(() => store.createProject(newProject(), "human")).toThrow(/UNIQUE/);
  });

  it("lists events after an id with a limit", () => {
    const project = store.createProject(newProject(), "human");
    store.event(project.id, null, "a", "human");
    store.event(project.id, null, "b", "human");
    store.event(project.id, null, "c", "human");
    const all = store.events(project.id);
    expect(store.events(project.id, all[1]!.id).map((event) => event.kind)).toEqual(["b", "c"]);
    expect(store.events(project.id, 0, 2)).toHaveLength(2);
  });
});

describe("spec versions", () => {
  it("numbers versions from 1 and finds the latest", () => {
    const project = store.createProject(newProject(), "human");
    expect(store.addSpecVersion(project.id, "a = 1", "{}", "h1", "thr_1")).toBe(1);
    expect(store.addSpecVersion(project.id, "a = 2", "{}", "h2", "thr_1")).toBe(2);
    expect(store.specVersion(project.id, 1)).toMatchObject({ toml: "a = 1", hash: "h1", proposed_by: "thr_1" });
    expect(store.latestSpecVersion(project.id)).toMatchObject({ version: 2, toml: "a = 2", hash: "h2" });
    expect(store.specVersion(project.id, 9)).toBeNull();
    expect(eventKinds(project.id)).toEqual(["project.created", "spec.proposed", "spec.proposed"]);
  });
});

describe("tickets", () => {
  it("creates a queued ticket with an event", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    expect(ticket).toMatchObject({ key: "CSV-1", state: "queued", attempt: 0, created_by: "human", state_at: clock.t });
    expect(store.ticketByKey("CSV-1")).toEqual(ticket);
    expect(store.ticketByKey("CSV-9")).toBeNull();
    expect(store.events(project.id).at(-1)).toMatchObject({ kind: "ticket.created", ticket_id: ticket.id });
  });

  it("an invalid ticket move throws and names both states", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    expect(() => store.setTicketState(ticket.id, "approved", "loom")).toThrow(/queued.*approved/);
    expect(store.ticket(ticket.id)?.state).toBe("queued");
  });

  it("writes exactly one event per state change and stamps state_at", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    const before = store.events(project.id).length;
    clock.advance(2000);
    const blocked = store.setTicketState(ticket.id, "blocked", "human", { reason: "needs a decision" });
    expect(blocked).toMatchObject({ state: "blocked", state_at: clock.t, updated_at: clock.t });
    const events = store.events(project.id);
    expect(events).toHaveLength(before + 1);
    expect(JSON.parse(events.at(-1)!.data_json)).toEqual({ from: "queued", to: "blocked", reason: "needs a decision" });
    expect(events.at(-1)).toMatchObject({ kind: "ticket.state", ticket_id: ticket.id, actor: "human" });
  });

  it("filters by state", () => {
    const project = store.createProject(newProject(), "human");
    const first = store.createTicket(newTicket(project.id, 1), "human");
    store.createTicket(newTicket(project.id, 2), "human");
    store.setTicketState(first.id, "cancelled", "human");
    expect(store.tickets(project.id).map((ticket) => ticket.key)).toEqual(["CSV-1", "CSV-2"]);
    expect(store.tickets(project.id, ["queued"]).map((ticket) => ticket.key)).toEqual(["CSV-2"]);
    expect(store.tickets(project.id, ["queued", "cancelled"])).toHaveLength(2);
  });

  it("stores the ticket's repo, and null when the ticket names none", () => {
    const project = store.createProject(newProject(), "human");
    const web = store.createTicket(newTicket(project.id, 1, { repo: "web" }), "human");
    const own = store.createTicket(newTicket(project.id, 2), "human");
    const explicit = store.createTicket(newTicket(project.id, 3, { repo: null }), "human");
    expect(store.ticket(web.id)?.repo).toBe("web");
    expect(own.repo).toBeNull();
    expect(explicit.repo).toBeNull();
  });

  it("reads a ticket saved before the repo column existed as null, the project's own repo", () => {
    const old = new Database(":memory:");
    const added = MIGRATIONS.indexOf("ALTER TABLE tickets ADD COLUMN repo TEXT");
    expect(added).toBeGreaterThan(0);
    for (const sql of MIGRATIONS.slice(0, added)) old.exec(sql);
    old.prepare("INSERT INTO tickets (project_id, seq, key, ref, title, body, state, created_by, created_at, updated_at, state_at) VALUES (1, 1, 'CSV-1', 'one', 't', 'b', 'queued', 'x', 0, 0, 0)").run();
    for (const sql of MIGRATIONS.slice(added)) old.exec(sql);
    expect(new Store(old, clock.now).ticketByKey("CSV-1")).toMatchObject({ key: "CSV-1", repo: null });
  });

  it("keeps a fix round's message stored before hand-backs existed as the ticket's hand-back, which has its worker slot", () => {
    const old = new Database(":memory:");
    const renamed = MIGRATIONS.indexOf("ALTER TABLE tickets RENAME COLUMN pr_deliver_json TO handback_json");
    expect(renamed).toBeGreaterThan(0);
    for (const sql of MIGRATIONS.slice(0, renamed)) old.exec(sql);
    const message = JSON.stringify({ thread: "thr_w1", text: { summary: "Fix it", detail: "The review." } });
    old.prepare("INSERT INTO tickets (project_id, seq, key, ref, title, body, state, created_by, created_at, updated_at, state_at, pr_deliver_json) VALUES (1, 1, 'CSV-1', 'one', 't', 'b', 'working', 'x', 0, 0, 0, ?)").run(message);
    for (const sql of MIGRATIONS.slice(renamed)) old.exec(sql);
    const ticket = new Store(old, clock.now).ticketByKey("CSV-1")!;
    expect(ticket.handback_json).toBe(message);
    expect(toLite(ticket)).toMatchObject({ holds: true, waitsSince: null });
  });

  it("keeps the spec reviews saved before skipped reviews existed, with their ids, and takes a skipped one after them", () => {
    const old = new Database(":memory:");
    const rebuilt = MIGRATIONS.findIndex((sql) => sql.startsWith("CREATE TABLE spec_reviews_next"));
    expect(rebuilt).toBeGreaterThan(0);
    for (const sql of MIGRATIONS.slice(0, rebuilt)) old.exec(sql);
    old.prepare("INSERT INTO spec_reviews (project_id, version, round, state, spawn_token, thread_id, summary, started_at, ended_at, wait_json) VALUES (1, 1, 1, 'approved', 'tok1', 'thr_r1', 'Holds.', 5, 6, NULL)").run();
    old.prepare("INSERT INTO spec_reviews (project_id, version, round, state, spawn_token, started_at) VALUES (1, 2, 1, 'reviewing', 'tok2', 7)").run();
    for (const sql of MIGRATIONS.slice(rebuilt)) old.exec(sql);
    const kept = new Store(old, clock.now);
    expect(kept.specReviews(1)).toMatchObject([
      { id: 1, version: 1, state: "approved", thread_id: "thr_r1", summary: "Holds.", started_at: 5, ended_at: 6, skip_json: null },
      { id: 2, version: 2, state: "reviewing", thread_id: null },
    ]);
    expect(kept.openSpecReviews().map((row) => row.id)).toEqual([2]);
    expect(kept.skipSpecReview({ project_id: 1, version: 3, round: 1, spawn_token: "tok3", summary: "Only the forge.", skip: { against: 2, paths: ["merge.forge.feedback"] } })).toMatchObject({ id: 3, state: "skipped", ended_at: clock.now(), skip_json: JSON.stringify({ against: 2, paths: ["merge.forge.feedback"] }) });
    expect(kept.endSpecReview(3, "failed")).toBe(false);
  });

  it("updateTicket patches columns without an event", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    const before = store.events(project.id).length;
    store.updateTicket(ticket.id, { blocked_reason: "why", attempt: 2 });
    expect(store.ticket(ticket.id)).toMatchObject({ blocked_reason: "why", attempt: 2 });
    expect(store.events(project.id)).toHaveLength(before);
  });
});

describe("posts", () => {
  const post = (projectId: number, ticketId: number, parentId: number | null, body = "hello") => ({
    project_id: projectId,
    ticket_id: ticketId,
    parent_id: parentId,
    author_kind: "human" as const,
    author_thread_id: null,
    kind: "reply" as const,
    body,
  });

  it("stores a post with an event and lists posts in id order", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    const root = store.addPost(post(project.id, ticket.id, null, "root"));
    const reply = store.addPost(post(project.id, ticket.id, root.id, "reply"));
    expect(reply).toMatchObject({ parent_id: root.id, data_json: "{}", at: clock.t });
    expect(store.posts(ticket.id).map((row) => row.body)).toEqual(["root", "reply"]);
    expect(store.events(project.id).at(-1)).toMatchObject({ kind: "post.added", ticket_id: ticket.id, actor: "human" });
  });

  it("refuses a reply whose parent is on another ticket", () => {
    const project = store.createProject(newProject(), "human");
    const one = store.createTicket(newTicket(project.id, 1), "human");
    const two = store.createTicket(newTicket(project.id, 2), "human");
    const parent = store.addPost(post(project.id, one.id, null));
    const before = store.events(project.id).length;
    expect(() => store.addPost(post(project.id, two.id, parent.id))).toThrow(/another ticket/);
    expect(() => store.addPost(post(project.id, two.id, 999))).toThrow(/another ticket|not found/);
    expect(store.posts(two.id)).toHaveLength(0);
    expect(store.events(project.id)).toHaveLength(before);
  });
});

describe("threads", () => {
  it("finds a row by thread id and by spawn token, and updates it", () => {
    const project = store.createProject(newProject(), "human");
    const planner = store.addThread({ thread_id: "thr_1", project_id: project.id, role: "planner", state: "active" });
    const spawning = store.addThread({ spawn_token: "tok_1", project_id: project.id, role: "worker", state: "spawning" });
    expect(store.threadByThreadId("thr_1")).toEqual(planner);
    expect(store.threadByThreadId("nope")).toBeNull();
    expect(store.threadBySpawnToken("tok_1")).toEqual(spawning);
    expect(spawning).toMatchObject({ thread_id: null, started_at: clock.t, idle_count: 0 });
    store.updateThread(spawning.id, { thread_id: "thr_2", state: "active" });
    expect(store.threadByThreadId("thr_2")).toMatchObject({ id: spawning.id, state: "active" });
  });

  it("reads a row by id and filters rows by project, ticket, role and state", () => {
    const project = store.createProject(newProject(), "human");
    const other = store.createProject(newProject("other"), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "planner");
    const planner = store.addThread({ thread_id: "thr_1", project_id: project.id, role: "planner", state: "active" });
    const worker = store.addThread({ thread_id: "thr_2", project_id: project.id, ticket_id: ticket.id, role: "worker", state: "active" });
    const ended = store.addThread({ thread_id: "thr_3", project_id: project.id, ticket_id: ticket.id, role: "worker", state: "ended" });
    const foreign = store.addThread({ thread_id: "thr_4", project_id: other.id, role: "planner", state: "active" });
    expect(store.thread(worker.id)).toEqual(worker);
    expect(store.thread(9999)).toBeNull();
    expect(store.threads({ projectId: project.id }).map((row) => row.id)).toEqual([planner.id, worker.id, ended.id]);
    expect(store.threads({ ticketId: ticket.id }).map((row) => row.id)).toEqual([worker.id, ended.id]);
    expect(store.threads({ projectId: project.id, role: "worker", states: ["active"] }).map((row) => row.id)).toEqual([worker.id]);
    expect(store.threads({ states: ["active", "ended"], role: "planner" }).map((row) => row.id)).toEqual([planner.id, foreign.id]);
    expect(store.threads({ states: ["spawning"] })).toEqual([]);
  });

  it("claims an active row once: the second claim loses, and a row that is not active cannot be claimed", () => {
    const project = store.createProject(newProject(), "human");
    const row = store.addThread({ thread_id: "thr_1", project_id: project.id, role: "worker", state: "active" });
    clock.advance(5000);
    expect(store.claimThread(row.id, "abandoned")).toBe(true);
    expect(store.claimThread(row.id, "timeout")).toBe(false);
    expect(store.thread(row.id)).toMatchObject({ state: "ending", end_reason: "abandoned", ended_at: clock.t });
    const spawning = store.addThread({ spawn_token: "tok", project_id: project.id, role: "worker", state: "spawning" });
    expect(store.claimThread(spawning.id, "failed")).toBe(false);
    expect(store.thread(spawning.id)?.state).toBe("spawning");
    expect(store.claimThread(9999, "gone")).toBe(false);
  });
});

describe("reviews", () => {
  const seed = () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "planner");
    const row = store.addThread({ thread_id: "thr_r1", project_id: project.id, ticket_id: ticket.id, role: "reviewer", state: "active" });
    return { project, ticket, row };
  };

  it("adds a pending review for a round and lists reviews by ticket and round", () => {
    const { ticket, row } = seed();
    const first = store.addReview({ ticket_id: ticket.id, round: 1, thread_row_id: row.id });
    const second = store.addReview({ ticket_id: ticket.id, round: 2, thread_row_id: row.id });
    expect(first).toMatchObject({ ticket_id: ticket.id, round: 1, thread_row_id: row.id, verdict: "pending", summary: null, findings_json: "[]", at: clock.t });
    expect(store.reviews(ticket.id).map((review) => review.id)).toEqual([first.id, second.id]);
    expect(store.reviews(ticket.id, 2).map((review) => review.id)).toEqual([second.id]);
    expect(store.review(first.id)).toEqual(first);
    expect(store.review(9999)).toBeNull();
  });

  it("stores a verdict with its findings and an event, and refuses a review that is not pending", () => {
    const { project, ticket, row } = seed();
    const review = store.addReview({ ticket_id: ticket.id, round: 1, thread_row_id: row.id });
    const findings = [{ severity: "blocking" as const, title: "Off by one", detail: "The loop skips the last order.", file: "src/model/a.ts", line: 12 }];
    const done = store.setVerdict(review.id, "changes_requested", "Needs a fix", findings);
    expect(done).toMatchObject({ verdict: "changes_requested", summary: "Needs a fix" });
    expect(JSON.parse(done.findings_json)).toEqual(findings);
    expect(store.events(project.id).filter((event) => event.kind === "review.verdict").map((event) => JSON.parse(event.data_json))).toEqual([{ review: review.id, round: 1, verdict: "changes_requested" }]);
    expect(() => store.setVerdict(review.id, "approved", "late", [])).toThrow(/not pending/);
    expect(() => store.setVerdict(9999, "approved", "x", [])).toThrow(/does not exist/);
    expect(store.review(review.id)).toMatchObject({ verdict: "changes_requested", summary: "Needs a fix" });
  });

  it("lists a ticket's events in order, optionally only some kinds", () => {
    const { project, ticket } = seed();
    store.setTicketState(ticket.id, "working", "loom");
    store.setTicketState(ticket.id, "checking", "loom");
    expect(store.ticketEvents(ticket.id).map((event) => event.kind)).toEqual(["ticket.created", "ticket.state", "ticket.state"]);
    expect(store.ticketEvents(ticket.id, ["ticket.created"]).map((event) => event.kind)).toEqual(["ticket.created"]);
    expect(store.ticketEvents(ticket.id + 1)).toEqual([]);
    expect(project.id).toBeGreaterThan(0);
  });
});

describe("project-wide readers", () => {
  const seed = () => {
    const project = store.createProject(newProject(), "human");
    const other = store.createProject(newProject("other"), "human");
    const one = store.createTicket(newTicket(project.id, 1), "planner");
    const two = store.createTicket(newTicket(project.id, 2), "planner");
    const elsewhere = store.createTicket(newTicket(other.id, 1, { key: "OTHER-1", ref: "other-1" }), "planner");
    return { project, other, one, two, elsewhere };
  };
  const post = (projectId: number, ticketId: number) => store.addPost({ project_id: projectId, ticket_id: ticketId, parent_id: null, author_kind: "human", author_thread_id: null, kind: "reply", body: "hi" });

  it("reads the posts, threads, reviews and events of one project", () => {
    const { project, one, two, elsewhere } = seed();
    const a = post(project.id, one.id);
    const b = post(project.id, two.id);
    post(elsewhere.project_id, elsewhere.id);
    expect(store.postsForProject(project.id).map((row) => row.id)).toEqual([a.id, b.id]);

    const worker = store.addThread({ thread_id: "thr_w", project_id: project.id, ticket_id: one.id, role: "worker", state: "active" });
    store.addThread({ thread_id: "thr_x", project_id: elsewhere.project_id, ticket_id: elsewhere.id, role: "worker", state: "active" });
    expect(store.threadsForProject(project.id).map((row) => row.id)).toEqual([worker.id]);
    expect(store.threadsForTicket(one.id).map((row) => row.id)).toEqual([worker.id]);
    expect(store.threadsForTicket(two.id)).toEqual([]);

    const review = store.addReview({ ticket_id: one.id, round: 1, thread_row_id: worker.id });
    store.addReview({ ticket_id: elsewhere.id, round: 1, thread_row_id: null });
    expect(store.reviewsForProject(project.id).map((row) => row.id)).toEqual([review.id]);

    expect(store.projectEvents(project.id).every((event) => event.project_id === project.id)).toBe(true);
    expect(store.projectEvents(project.id).map((event) => event.id)).toEqual(store.events(project.id).map((event) => event.id));
  });

  it("reads the newest events first, optionally only those before an id", () => {
    const { project } = seed();
    const all = store.projectEvents(project.id);
    const newest = store.eventsNewest(project.id, 2);
    expect(newest.map((event) => event.id)).toEqual(all.slice(-2).reverse().map((event) => event.id));
    const older = store.eventsNewest(project.id, 2, newest[1]!.id);
    expect(older.map((event) => event.id)).toEqual(all.slice(-4, -2).reverse().map((event) => event.id));
    expect(store.eventsNewest(project.id, 50, all[0]!.id)).toEqual([]);
  });
});

describe("setOnEvent", () => {
  it("calls the hook with the project id after each event, outside a transaction", () => {
    const seen: Array<number | null> = [];
    store.setOnEvent((projectId) => seen.push(projectId));
    const project = store.createProject(newProject(), "human");
    expect(seen).toEqual([project.id]);
    store.event(project.id, null, "custom", "human");
    expect(seen).toEqual([project.id, project.id]);
  });

  it("holds the calls until the outermost transaction commits, and drops them when it rolls back", () => {
    const project = store.createProject(newProject(), "human");
    const seen: Array<{ projectId: number | null; events: number }> = [];
    store.setOnEvent((projectId) => seen.push({ projectId, events: projectId === null ? 0 : store.events(projectId).length }));
    const before = store.events(project.id).length;

    store.tx(() => {
      store.event(project.id, null, "a", "human");
      store.tx(() => store.event(project.id, null, "b", "human"));
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([
      { projectId: project.id, events: before + 2 },
      { projectId: project.id, events: before + 2 },
    ]);

    seen.length = 0;
    expect(() =>
      store.tx(() => {
        store.event(project.id, null, "c", "human");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(seen).toEqual([]);
    expect(store.events(project.id)).toHaveLength(before + 2);
  });

  it("drops the calls of a nested transaction that rolled back, and keeps the rest, when the outer one commits", () => {
    const project = store.createProject(newProject(), "human");
    const seen: Array<number | null> = [];
    store.setOnEvent((projectId) => seen.push(projectId));
    const other = store.createProject(newProject("other"), "human");
    seen.length = 0;

    store.tx(() => {
      store.event(project.id, null, "before", "human");
      try {
        store.tx(() => {
          store.event(other.id, null, "rolled.back", "human");
          store.changed(other.id);
          throw new Error("inner");
        });
      } catch {}
      store.event(project.id, null, "after", "human");
    });
    expect(seen).toEqual([project.id, project.id]);
    expect(eventKinds(other.id)).toEqual(["project.created"]);
  });

  it("drops the calls of a nested transaction that rolled back even when the outer one starts with none", () => {
    const project = store.createProject(newProject(), "human");
    const seen: Array<number | null> = [];
    store.setOnEvent((projectId) => seen.push(projectId));
    store.tx(() => {
      try {
        store.tx(() => {
          store.event(project.id, null, "rolled.back", "human");
          throw new Error("inner");
        });
      } catch {}
    });
    expect(seen).toEqual([]);
    expect(eventKinds(project.id)).toEqual(["project.created"]);
  });

  it("can be removed", () => {
    const seen: Array<number | null> = [];
    store.setOnEvent((projectId) => seen.push(projectId));
    store.setOnEvent(null);
    store.createProject(newProject(), "human");
    expect(seen).toEqual([]);
  });
});

describe("project repos", () => {
  it("the migration creates the project_repos table, keyed by project and name", () => {
    const columns = (db.prepare("PRAGMA table_info(project_repos)").all() as Array<{ name: string; pk: number }>).map((column) => [column.name, column.pk]);
    expect(columns).toEqual([
      ["project_id", 1],
      ["name", 2],
      ["pr_url", 0],
      ["landed_sha", 0],
      ["landed_at", 0],
    ]);
  });

  it("creates a repo's row on its first update and patches it after, with one project.landed event naming the repo each time", () => {
    const project = store.createProject(newProject(), "human");
    const other = store.createProject(newProject("tsv"), "human");
    expect(store.projectRepos(project.id)).toEqual([]);
    expect(store.projectRepo(project.id, "web")).toBeNull();

    const first = store.updateProjectRepo(project.id, "web", { pr_url: "https://github.com/acme/web/pull/1", landed_sha: "m1", landed_at: clock.t }, "human", { url: "https://github.com/acme/web/pull/1", sha: "m1", created: true });
    expect(first).toEqual({ project_id: project.id, name: "web", pr_url: "https://github.com/acme/web/pull/1", landed_sha: "m1", landed_at: clock.t });
    clock.advance(10);
    const second = store.updateProjectRepo(project.id, "web", { landed_sha: "m2", landed_at: clock.t }, "human", { url: "https://github.com/acme/web/pull/1", sha: "m2", created: false });
    expect(second).toEqual({ ...first, landed_sha: "m2", landed_at: clock.t });
    store.updateProjectRepo(project.id, "api", { landed_sha: "m3", landed_at: clock.t }, "human", { direct: true, pushed: "upstream/trunk", sha: "m3" });
    store.updateProjectRepo(other.id, "web", { landed_sha: "x1" }, "human");

    expect(store.projectRepos(project.id).map((row) => [row.name, row.landed_sha])).toEqual([
      ["api", "m3"],
      ["web", "m2"],
    ]);
    expect(store.projectRepo(other.id, "web")).toMatchObject({ landed_sha: "x1", pr_url: null, landed_at: null });
    const landed = store.eventsOfKind(project.id, "project.landed");
    expect(landed.map((event) => [event.actor, JSON.parse(event.data_json)])).toEqual([
      ["human", { repo: "web", url: "https://github.com/acme/web/pull/1", sha: "m1", created: true }],
      ["human", { repo: "web", url: "https://github.com/acme/web/pull/1", sha: "m2", created: false }],
      ["human", { repo: "api", direct: true, pushed: "upstream/trunk", sha: "m3" }],
    ]);
  });

  it("writes the row and its event in one transaction: a rollback keeps neither", () => {
    const project = store.createProject(newProject(), "human");
    expect(() =>
      store.tx(() => {
        store.updateProjectRepo(project.id, "web", { landed_sha: "m1" }, "human");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.projectRepos(project.id)).toEqual([]);
    expect(eventKinds(project.id)).toEqual(["project.created"]);
  });
});

describe("planning", () => {
  const session = (thread_id: string) => ({ thread_id, bb_project_id: "proj_1", title: `Plan ${thread_id}` });

  it("the migration creates the planning table", () => {
    const columns = (db.prepare("PRAGMA table_info(planning)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(["id", "thread_id", "bb_project_id", "title", "started_at", "ended_at", "end_reason"]);
  });

  it("adds a session, reads it by thread id, and lists the open ones newest first without the ended ones", () => {
    const first = store.addPlanning(session("thr_p1"));
    expect(first).toMatchObject({ thread_id: "thr_p1", bb_project_id: "proj_1", title: "Plan thr_p1", started_at: clock.t, ended_at: null, end_reason: null });
    clock.advance(10);
    store.addPlanning(session("thr_p2"));
    store.addPlanning(session("thr_p3"));
    expect(store.planning("thr_p1")).toEqual(first);
    expect(store.planning("thr_nope")).toBeNull();
    expect(store.endPlanning("thr_p2", "archived")).toBe(true);
    expect(store.openPlanning().map((row) => row.thread_id)).toEqual(["thr_p3", "thr_p1"]);
    expect(store.planning("thr_p2")).toMatchObject({ ended_at: clock.t, end_reason: "archived" });
  });

  it("ends a session once: the second end returns false and keeps the first reason", () => {
    store.addPlanning(session("thr_p1"));
    expect(store.endPlanning("thr_p1", "archived")).toBe(true);
    expect(store.endPlanning("thr_p1", "deleted")).toBe(false);
    expect(store.endPlanning("thr_nope", "deleted")).toBe(false);
    expect(store.planning("thr_p1")?.end_reason).toBe("archived");
  });

  it("tells the hook null after adding a session and after an end that ended one, after the outermost commit inside a transaction", () => {
    const seen: Array<number | null> = [];
    store.setOnEvent((projectId) => seen.push(projectId));
    store.addPlanning(session("thr_p1"));
    expect(seen).toEqual([null]);
    store.endPlanning("thr_p1", "archived");
    expect(seen).toEqual([null, null]);
    store.endPlanning("thr_p1", "archived");
    expect(seen).toEqual([null, null]);

    seen.length = 0;
    store.tx(() => {
      store.addPlanning(session("thr_p2"));
      store.tx(() => store.endPlanning("thr_p2", "gone"));
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([null, null]);
  });
});

describe("changed", () => {
  it("calls the hook for a row-only change like it does for an event: at once outside a transaction, after the outermost commit inside one", () => {
    const project = store.createProject(newProject(), "human");
    const seen: Array<number | null> = [];
    store.setOnEvent((projectId) => seen.push(projectId));

    store.changed(project.id);
    expect(seen).toEqual([project.id]);

    seen.length = 0;
    store.tx(() => {
      store.changed(project.id);
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([project.id]);
  });

  it("is dropped when its transaction rolls back", () => {
    const project = store.createProject(newProject(), "human");
    const seen: Array<number | null> = [];
    store.setOnEvent((projectId) => seen.push(projectId));
    expect(() =>
      store.tx(() => {
        store.changed(project.id);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(seen).toEqual([]);
  });
});

describe("runs", () => {
  const start = (projectId: number, ticketId: number, label = "npm test") => store.startRun({ project_id: projectId, ticket_id: ticketId, stage: "check", kind: "command", label });

  it("starts an open run with no output, and finishes it with its result, measuring the output it leaves out", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    const id = start(project.id, ticket.id);
    expect(store.runs(ticket.id)).toEqual([
      { id, project_id: project.id, ticket_id: ticket.id, stage: "check", kind: "command", label: "npm test", started_at: clock.t, ended_at: null, duration_ms: null, ok: null, exit_code: null, timed_out: 0, output_chars: 0 },
    ]);
    clock.advance(40);
    store.finishRun(id, { ok: false, output: "boom", exitCode: 2, timedOut: true, durationMs: 12 });
    expect(store.runs(ticket.id)[0]).toMatchObject({ ended_at: clock.t, duration_ms: 12, ok: 0, exit_code: 2, timed_out: 1, output_chars: 4 });
    expect(store.runs(ticket.id)[0]).not.toHaveProperty("output");

    const git = store.startRun({ project_id: project.id, ticket_id: ticket.id, stage: "merge", kind: "git", label: "git merge" });
    clock.advance(25);
    store.finishRun(git, { ok: true, output: "Merged as m1." });
    expect(store.runs(ticket.id).map((run) => run.id)).toEqual([id, git]);
    expect(store.runs(ticket.id)[1]).toMatchObject({ duration_ms: 25, ok: 1, exit_code: null, timed_out: 0, output_chars: 13 });
  });

  it("returns a run's output, and null for an unknown id", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    const id = start(project.id, ticket.id);
    expect(store.runOutput(id)).toBe("");
    store.finishRun(id, { ok: true, output: "all good" });
    expect(store.runOutput(id)).toBe("all good");
    expect(store.runOutput(999)).toBeNull();
  });

  it("ends only the open runs, with the note as output and no result, and returns their count", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    const done = start(project.id, ticket.id, "npm run lint");
    store.finishRun(done, { ok: true, output: "fine", exitCode: 0 });
    const open = start(project.id, ticket.id, "npm test");
    clock.advance(5);
    expect(store.endOpenRuns("Loom restarted before this step finished.")).toBe(1);
    expect(store.runs(ticket.id)[1]).toMatchObject({ ended_at: clock.t, ok: null });
    expect(store.runOutput(open)).toBe("Loom restarted before this step finished.");
    expect(store.runs(ticket.id)[0]).toMatchObject({ ok: 1 });
    expect(store.runOutput(done)).toBe("fine");
    expect(store.endOpenRuns("again")).toBe(0);
  });

  it("tells the hook the project id after a run starts and after it finishes", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    const seen: Array<number | null> = [];
    store.setOnEvent((projectId) => seen.push(projectId));
    const id = start(project.id, ticket.id);
    expect(seen).toEqual([project.id]);
    store.finishRun(id, { ok: true, output: "" });
    expect(seen).toEqual([project.id, project.id]);
  });
});

describe("spec reviews", () => {
  it("adds a reviewing row, binds its thread, ends it once, and appends both events", () => {
    const project = store.createProject(newProject(), "human");
    const row = store.addSpecReview({ project_id: project.id, version: 2, round: 1, spawn_token: "tok_s1" });
    expect(row).toMatchObject({ project_id: project.id, version: 2, round: 1, state: "reviewing", thread_id: null, idle_count: 0, findings_json: "[]", started_at: clock.t, ended_at: null });
    expect(store.specReviewBySpawnToken("tok_s1")?.id).toBe(row.id);
    expect(store.openSpecReviews().map((review) => review.id)).toEqual([row.id]);

    store.updateSpecReview(row.id, { thread_id: "thr_s1", idle_count: 1 });
    expect(store.specReviewByThreadId("thr_s1")).toMatchObject({ id: row.id, idle_count: 1 });

    clock.advance(10);
    expect(store.endSpecReview(row.id, "changes_requested", { summary: "Too big", findings: [{ title: "Drop the settings page", detail: "Nothing asks for it." }] })).toBe(true);
    expect(store.endSpecReview(row.id, "approved", { summary: "late" })).toBe(false);
    expect(store.specReview(row.id)).toMatchObject({ state: "changes_requested", summary: "Too big", ended_at: clock.t });
    expect(JSON.parse(store.specReview(row.id)!.findings_json)).toHaveLength(1);
    expect(store.openSpecReviews()).toEqual([]);
    expect(store.specReviews(project.id)).toHaveLength(1);

    const events = store.events(project.id).filter((event) => event.kind.startsWith("spec.review."));
    expect(events.map((event) => [event.kind, event.actor, JSON.parse(event.data_json)])).toEqual([
      ["spec.review.started", "loom", { version: 2, round: 1 }],
      ["spec.review.ended", "loom", { version: 2, round: 1, state: "changes_requested", findings: 1 }],
    ]);
  });

  it("refuses an unknown state", () => {
    const project = store.createProject(newProject(), "human");
    const row = store.addSpecReview({ project_id: project.id, version: 1, round: 1, spawn_token: "tok_s1" });
    expect(() => db.prepare("UPDATE spec_reviews SET state = 'pending' WHERE id = ?").run(row.id)).toThrow(/CHECK/);
  });
});

describe("check durations", () => {
  it("keeps each run once, the newest runs of each check by repository, and reads them newest first", () => {
    const run = (name: string, index: number, durationMs = index * 1000) => ({ name, key: `check:${name}${index}`, durationMs, at: index });
    store.addCheckDurations("https://github.com/acme/shop", [1, 2, 3, 4].map((index) => run("test", index)), 3);
    store.addCheckDurations("https://github.com/acme/shop", [run("test", 4, 99_000), run("lint", 1)], 3);
    store.addCheckDurations("https://github.com/acme/api", [run("test", 9)], 3);
    expect(store.checkDurations("https://github.com/acme/shop", ["test", "lint", "e2e"], 5)).toEqual(
      new Map([
        ["test", [4000, 3000, 2000]],
        ["lint", [1000]],
      ]),
    );
    expect(store.checkDurations("https://github.com/acme/shop", ["test"], 2)).toEqual(new Map([["test", [4000, 3000]]]));
  });
});

describe("rollout marks", () => {
  it("keeps a ticket's rollout on its row, and null for a ticket without one", () => {
    const project = store.createProject(newProject(), "human");
    const plain = store.createTicket(newTicket(project.id, 1), "human");
    const staged = store.createTicket(newTicket(project.id, 2, { rollout_json: JSON.stringify({ stage: "expand", requires_live: ["CSV-1"] }) }), "human");
    expect(plain.rollout_json).toBeNull();
    expect(JSON.parse(staged.rollout_json!)).toEqual({ stage: "expand", requires_live: ["CSV-1"] });
  });

  it("claims one run per target until it finishes, is let go or its claim expires, and keeps only the claimed run's result", () => {
    const project = store.createProject(newProject(), "human");
    expect(store.claimRolloutRun(project.id, "CSV-1", "run-a", clock.now() - 1000)).toBe(true);
    expect(store.claimRolloutRun(project.id, "CSV-1", "run-b", clock.now() - 1000)).toBe(false);
    expect(store.finishRolloutRun(project.id, "CSV-1", "run-b", { exitCode: 0, output: "" })).toBe(false);
    clock.advance(5000);
    expect(store.claimRolloutRun(project.id, "CSV-1", "run-b", clock.now() - 1000)).toBe(true);
    expect(store.finishRolloutRun(project.id, "CSV-1", "run-a", { exitCode: 0, output: "late" })).toBe(false);
    expect(store.finishRolloutRun(project.id, "CSV-1", "run-b", { exitCode: 1, output: "503" })).toBe(true);
    expect(store.rolloutMark(project.id, "CSV-1")).toMatchObject({ checked_at: clock.now(), check_exit: 1, check_output: "503", run_token: null, run_at: null });
    expect(store.claimRolloutRun(project.id, "CSV-1", "run-c", clock.now() - 1000)).toBe(true);
    store.releaseRolloutRun(project.id, "CSV-1", "run-c");
    expect(store.rolloutMark(project.id, "CSV-1")).toMatchObject({ check_exit: 1, run_token: null });
  });

  it("marks a target live with one event, records check runs with none, and undoes a mark", () => {
    const project = store.createProject(newProject(), "human");
    const ticket = store.createTicket(newTicket(project.id, 1), "human");
    const run = (token: string, result: { exitCode: number | null; output: string }) => {
      store.claimRolloutRun(project.id, "CSV-1", token, 0);
      store.finishRolloutRun(project.id, "CSV-1", token, result);
    };
    run("one", { exitCode: 1, output: "503" });
    run("two", { exitCode: null, output: "Loom could not run it: the machine is away" });
    expect(store.rolloutMark(project.id, "CSV-1")).toMatchObject({ live_at: null, checked_at: clock.now(), check_exit: null, check_output: "Loom could not run it: the machine is away" });
    clock.advance(1000);
    store.markLive(project.id, ticket.id, "CSV-1", { by: "verify", evidence: "200 OK" }, "loom");
    store.markLive(project.id, null, "traffic-low", { by: "human", evidence: "Checked the dashboard" }, "human");
    expect(store.rolloutMarks(project.id).map((row) => [row.target, row.live_by, row.live_at, row.evidence])).toEqual([
      ["CSV-1", "verify", clock.now(), "200 OK"],
      ["traffic-low", "human", clock.now(), "Checked the dashboard"],
    ]);
    store.markNotLive(project.id, null, "traffic-low", "human", "Wrong dashboard");
    expect(store.rolloutMark(project.id, "traffic-low")).toMatchObject({ live_at: null, live_by: null, evidence: null, undone_at: clock.now() });
    const rollout = store.events(project.id).filter((event) => event.kind.startsWith("rollout."));
    expect(rollout.map((event) => [event.kind, event.ticket_id, event.actor, JSON.parse(event.data_json)])).toEqual([
      ["rollout.live", ticket.id, "loom", { target: "CSV-1", by: "verify", evidence: "200 OK" }],
      ["rollout.live", null, "human", { target: "traffic-low", by: "human", evidence: "Checked the dashboard" }],
      ["rollout.unlive", null, "human", { target: "traffic-low", note: "Wrong dashboard" }],
    ]);
  });

  it("refuses an unknown way of going live", () => {
    const project = store.createProject(newProject(), "human");
    expect(() => db.prepare("INSERT INTO rollout_marks (project_id, target, live_by) VALUES (?, 'x', 'magic')").run(project.id)).toThrow(/CHECK/);
  });
});
