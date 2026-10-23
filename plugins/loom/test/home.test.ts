import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homeView } from "../src/home";
import type { TicketState } from "../src/states";
import { FakePort, makeHost, specToml, type Doc } from "./helpers";

const T0 = Date.UTC(2026, 0, 10, 12);
const MINUTE = 60_000;
const DAY = 86_400_000;
const WALK: TicketState[] = ["working", "checking", "review", "approved", "merging", "done"];

let host: ReturnType<typeof makeHost>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  host = makeHost({ port: new FakePort() });
});
afterEach(() => {
  vi.useRealTimers();
});

const later = (ms = MINUTE) => vi.setSystemTime(Date.now() + ms);
const named = (slug: string, key: string, name: string, edit?: (doc: Doc) => void) => (doc: Doc) => {
  doc.project = { ...doc.project, slug, key, name };
  edit?.(doc);
};
const propose = (slug: string, key: string, name: string, edit?: (doc: Doc) => void) =>
  host.projects.propose({ toml: specToml(named(slug, key, name, edit)), threadId: `thr_${slug}`, bbProjectId: "proj_1", hostId: "host_env" });
const project = (slug: string) => host.store.projectBySlug(slug)!;
const running = async (slug: string, key: string, name: string, edit?: (doc: Doc) => void) => {
  await propose(slug, key, name, edit);
  await host.projects.approve(slug, "human");
  host.store.setProjectState(project(slug).id, "running", "human");
  return project(slug);
};
const ticket = (key: string) => host.store.ticketByKey(key)!;
const finish = (key: string) => {
  for (const state of WALK) host.store.setTicketState(ticket(key).id, state, "loom");
};
const view = () => homeView({ store: host.store, projects: host.projects, now: Date.now() });

describe("homeView needs you", () => {
  it("leaves out a draft while its spec review runs or has findings, and names a review that did not finish", async () => {
    await propose("docs", "DOC", "Docs site");
    const docs = project("docs");
    const row = host.store.addSpecReview({ project_id: docs.id, version: 1, round: 1, spawn_token: "tok_docs" });
    expect(view().needsYou).toEqual([]);
    host.store.endSpecReview(row.id, "changes_requested", { summary: "Too big", findings: [{ title: "a", detail: "b" }] });
    expect(view().needsYou).toEqual([]);
    const retry = host.store.addSpecReview({ project_id: docs.id, version: 1, round: 2, spawn_token: "tok_docs_2" });
    host.store.endSpecReview(retry.id, "failed", { reason: "the reviewer's thread was archived or deleted" });
    expect(view().needsYou.map((item) => [item.kind, item.text])).toEqual([["approve", "draft v1's spec review did not finish: the reviewer's thread was archived or deleted"]]);
    const passed = host.store.addSpecReview({ project_id: docs.id, version: 1, round: 2, spawn_token: "tok_docs_3" });
    host.store.endSpecReview(passed.id, "approved", { summary: "Fits." });
    expect(view().needsYou.map((item) => [item.kind, item.text])).toEqual([["approve", "has a draft spec v1 with 2 tickets"]]);
  });

  it("has one item per blocked ticket, draft, pending version, project Loom paused and finished integration project, newest first", async () => {
    await running("csv", "CSV", "CSV export");
    await propose("docs", "DOC", "Docs site");
    await running("api", "API", "Public API");
    await running("bill", "BILL", "Billing API");
    await running("srch", "SRCH", "Search revamp");
    host.store.updateProject(project("srch").id, { pr_url: "https://github.com/acme/shop/pull/9" });

    later();
    host.store.setTicketState(ticket("CSV-1").id, "blocked", "loom", { reason: "needs the staging DB credentials" });
    host.store.updateTicket(ticket("CSV-1").id, { blocked_reason: "needs the staging DB credentials" });
    host.store.setTicketState(ticket("CSV-2").id, "blocked", "loom");
    later();
    await propose("api", "API", "Public API", (doc) => (doc.project.goal = "Serve the public API with rate limits for every caller."));
    later();
    host.store.setProjectState(project("bill").id, "paused", "loom", "The token budget is used up: 900 of 900 tokens.");
    later();
    finish("SRCH-1");
    finish("SRCH-2");

    const needs = view().needsYou;
    expect(needs.map((item) => [item.kind, item.slug, item.key, item.text])).toEqual([
      ["land", "srch", null, "finished all 2 tickets; land the integration branch"],
      ["paused", "bill", null, "The token budget is used up: 900 of 900 tokens."],
      ["pending", "api", null, "spec v2 waits for your approval"],
      ["blocked", "csv", "CSV-1", "needs the staging DB credentials"],
      ["blocked", "csv", "CSV-2", "blocked"],
      ["approve", "docs", null, "has a draft spec v1 with 2 tickets"],
    ]);
    expect(needs[0]!.project).toBe("Search revamp");
    expect(needs[0]!.at).toBe(Date.now());
    expect(needs.at(-1)!.at).toBe(T0);
  });

  it("gives no item for a pause with --now, a finished pull-request project, a landed project or an unfinished one, and leaves archived projects out", async () => {
    await running("csv", "CSV", "CSV export");
    await host.engine.pause("csv", "human", true);
    await running("prs", "PRS", "Per-ticket PRs", (doc) => (doc.merge = { strategy: "pr" }));
    finish("PRS-1");
    finish("PRS-2");
    await running("half", "HALF", "Half done");
    finish("HALF-1");
    host.store.setTicketState(ticket("HALF-2").id, "cancelled", "human");
    await running("open", "OPEN", "Still open");
    finish("OPEN-1");
    await running("old", "OLD", "Old project");
    host.store.setTicketState(ticket("OLD-1").id, "blocked", "loom");
    host.store.setProjectState(project("old").id, "archived", "human");
    await running("gone", "GONE", "Landed");
    finish("GONE-1");
    finish("GONE-2");
    host.store.setProjectState(project("gone").id, "done", "human");

    const home = view();
    expect(home.needsYou.map((item) => [item.kind, item.slug])).toEqual([["land", "half"]]);
    expect(home.needsYou[0]!.text).toBe("finished all 1 ticket; land the integration branch");
    expect(home.totals.projects).toBe(5);
  });
});

describe("homeView totals and projects", () => {
  it("counts projects and live agents, and sums the worker and reviewer limits of running and paused projects as slots", async () => {
    await running("csv", "CSV", "CSV export", (doc) => (doc.agents = { ...doc.agents, max_workers: 3, max_reviewers: 1 }));
    await running("api", "API", "Public API");
    await running("bill", "BILL", "Billing API");
    host.store.setProjectState(project("bill").id, "paused", "human");
    await propose("docs", "DOC", "Docs site");
    host.store.addThread({ project_id: project("csv").id, role: "worker", state: "active", thread_id: "thr_w1", ticket_id: ticket("CSV-1").id });
    host.store.addThread({ project_id: project("csv").id, role: "reviewer", state: "active", thread_id: "thr_r1", ticket_id: ticket("CSV-1").id });
    host.store.addThread({ project_id: project("api").id, role: "worker", state: "ended", thread_id: "thr_w2", ticket_id: ticket("API-1").id });

    const { totals } = view();
    expect(totals).toMatchObject({ projects: 4, running: 2, paused: 1, workers: 1, reviewers: 1, planners: 4, slots: 3 + 1 + 2 + 2 + 2 + 2 });
  });

  it("counts a paused project's slots, because its workers and reviewers keep running until they finish", async () => {
    await running("csv", "CSV", "CSV export");
    host.store.setProjectState(project("csv").id, "paused", "human");
    host.store.addThread({ project_id: project("csv").id, role: "worker", state: "active", thread_id: "thr_w1", ticket_id: ticket("CSV-1").id });
    expect(view().totals).toMatchObject({ running: 0, paused: 1, workers: 1, reviewers: 0, slots: 4 });
  });

  it("sums each project's 14-day throughput by day, the last 7 days, and the tokens per done ticket", async () => {
    await running("csv", "CSV", "CSV export");
    await running("api", "API", "Public API");
    vi.setSystemTime(T0 - 2 * DAY);
    finish("CSV-1");
    vi.setSystemTime(T0 - DAY);
    finish("API-1");
    vi.setSystemTime(T0);
    finish("CSV-2");
    const worker = host.store.addThread({ project_id: project("csv").id, role: "worker", state: "ended", thread_id: "thr_w1", ticket_id: ticket("CSV-1").id });
    host.store.updateThread(worker.id, { tokens: 9000 });

    const home = view();
    expect(home.totals.doneByDay).toHaveLength(14);
    expect(home.totals.doneByDay.slice(-4)).toEqual([0, 1, 1, 1]);
    expect(home.totals.doneLast7).toBe(3);
    expect(home.totals).toMatchObject({ tokens: 9000, perDoneTicket: 3000 });
    const byProject = Object.fromEntries(home.projects.map((row) => [row.slug, row]));
    expect(byProject.csv!.throughput.slice(-3)).toEqual([1, 0, 1]);
    expect(byProject.api!.throughput.slice(-3)).toEqual([0, 1, 0]);
    expect(home.totals.doneByDay).toEqual(byProject.csv!.throughput.map((done, index) => done + byProject.api!.throughput[index]!));
  });

  it("gives each project its progress, its workers and reviewers at work, tokens against its budget and the time of its last event", async () => {
    await running("csv", "CSV", "CSV export", (doc) => (doc.budget = { max_tokens: 50_000 }));
    await propose("docs", "DOC", "Docs site");
    finish("CSV-1");
    host.store.setTicketState(ticket("CSV-2").id, "working", "loom");
    const csvId = project("csv").id;
    const worker = host.store.addThread({ project_id: csvId, role: "worker", state: "active", thread_id: "thr_w1", ticket_id: ticket("CSV-2").id });
    host.store.updateThread(worker.id, { tokens: 1200 });
    host.store.addThread({ project_id: csvId, role: "reviewer", state: "spawning", ticket_id: ticket("CSV-1").id });
    host.store.addThread({ project_id: csvId, role: "worker", state: "ending", thread_id: "thr_w0", ticket_id: ticket("CSV-1").id });
    host.store.addThread({ project_id: csvId, role: "worker", state: "ended", thread_id: "thr_w9", ticket_id: ticket("CSV-1").id });
    later();
    host.store.event(csvId, null, "something.new", "loom");

    const [csv, docs] = view().projects;
    expect(csv).toMatchObject({ slug: "csv", name: "CSV export", state: "running", progress: { done: 1, total: 2, inFlight: 1, blocked: 0 }, agents: 3, tokens: 1200, maxTokens: 50_000, lastEventAt: Date.now() });
    expect(csv!.throughput).toHaveLength(14);
    expect(host.store.threadsForProject(project("docs").id).map((row) => [row.role, row.state])).toEqual([["planner", "active"]]);
    expect(docs).toMatchObject({ slug: "docs", state: "draft", progress: { done: 0, total: 0, inFlight: 0, blocked: 0 }, agents: 0, tokens: 0, maxTokens: null, lastEventAt: T0 });
    expect(view().now).toBe(Date.now());
  });
});
