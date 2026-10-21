import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { Store, type NewTicket } from "../src/db/store";
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
  it("numbers versions from 1, replaces one in place, and finds the latest", () => {
    const project = store.createProject(newProject(), "human");
    expect(store.addSpecVersion(project.id, "a = 1", "{}", "h1", "thr_1")).toBe(1);
    expect(store.addSpecVersion(project.id, "a = 2", "{}", "h2", "thr_1")).toBe(2);
    expect(store.specVersion(project.id, 1)).toMatchObject({ toml: "a = 1", hash: "h1", proposed_by: "thr_1" });
    store.replaceSpecVersion(project.id, 2, "a = 3", '{"a":3}', "h3", "thr_1");
    expect(store.latestSpecVersion(project.id)).toMatchObject({ version: 2, toml: "a = 3", spec_json: '{"a":3}', hash: "h3" });
    expect(store.specVersion(project.id, 9)).toBeNull();
    expect(eventKinds(project.id)).toEqual(["project.created", "spec.proposed", "spec.proposed", "spec.revised"]);
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
