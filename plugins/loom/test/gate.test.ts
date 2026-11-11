import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectView } from "../src/contract";
import { registerRpc } from "../src/rpc";
import { makeHost, specToml, type Doc } from "./helpers";
import { phased } from "./phase-fixtures";

let host: ReturnType<typeof makeHost>;
beforeEach(() => {
  host = makeHost();
  registerRpc(host.bb, { projects: host.projects, engine: host.engine, store: host.store, now: Date.now });
});

const call = <T>(method: string, input?: unknown) => host.harness.behavior.callRpc(method, input) as Promise<T>;
const propose = (edit?: (doc: Doc) => void) => host.projects.propose({ toml: specToml((d) => { phased(d); edit?.(d); }), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_env" });
const acceptance = ["WHEN it runs THE SYSTEM SHALL do it"];

/** Phase 1 closed with CSV-1 merged and CSV-2 cancelled; v2 fills phase 2 with three tickets and changes two other things. */
async function atTheGate(state: "running" | "paused" = "running", maxWorkers = 4, holdUntil: number | null = null) {
  await propose();
  await host.projects.approve("csv", "human");
  const project = host.store.projectBySlug("csv")!;
  host.store.setProjectState(project.id, "running", "human");
  if (state === "paused") host.store.setProjectState(project.id, "paused", "human");
  const [one, two] = host.store.tickets(project.id);
  host.store.updateTicket(one!.id, { state: "done", pr_url: "https://github.com/acme/shop/pull/861", pr_status_json: JSON.stringify({ at: 1_000, head: "h1", passed: 4, failed: 0, pending: 0 }) });
  host.store.event(project.id, one!.id, "ticket.state", "loom", { from: "pr_open", to: "done", sha: "7d1e3a9f00" });
  const thread = host.store.addThread({ project_id: project.id, ticket_id: one!.id, role: "reviewer", state: "ended", thread_id: "thr_rev" });
  const review = host.store.addReview({ ticket_id: one!.id, round: 2, thread_row_id: thread.id });
  host.store.setVerdict(review.id, "approved", "Looks right.", []);
  host.store.updateTicket(two!.id, { state: "cancelled" });
  host.store.addPost({ project_id: project.id, ticket_id: two!.id, parent_id: null, author_kind: "planner", author_thread_id: "thr_plan", kind: "system", body: "Cancelled: no archived market serves traffic, so there is nothing to backfill." });
  host.store.event(project.id, null, "phase.done", "loom", { ref: "skeleton", title: "Skeleton", index: 1, done: 1, cancelled: 1, next: "polish" });
  await propose((d) => {
    d.phase[0].report = "CSV-1 landed; CSV-2 was cancelled.";
    d.phase[2].outline = ["Turn the flag on by default"];
    d.agents = { ...d.agents, max_workers: maxWorkers };
    d.ticket.push(
      { ref: "stream", title: "Stream rows", body: "Stream.", acceptance, scope: ["src/stream/**"], phase: "polish", depends_on: ["csv-model"] },
      { ref: "resume", title: "Resume a broken export", body: "Resume.", acceptance, scope: ["src/resume/**"], phase: "polish", depends_on: ["stream"] },
      { ref: "gzip", title: "Gzip the stream", body: "Gzip.", acceptance, scope: ["src/gzip/**"], phase: "polish", merge_after: ["stream"] },
    );
  });
  if (holdUntil !== null) host.store.updateProject(project.id, { hold_until: holdUntil });
  return call<ProjectView>("project", { slug: "csv" });
}

const undefinedAt = (value: unknown, path = "$"): string[] =>
  value === undefined ? [path] : Array.isArray(value) ? value.flatMap((item, index) => undefinedAt(item, `${path}[${index}]`)) : value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, item]) => undefinedAt(item, `${path}.${key}`)) : [];

describe("the phase gate's data", () => {
  it("records the finished phase beside the proposed one, with the keys approval gives and what starts", async () => {
    const view = await atTheGate();
    const gate = view.gate!;
    expect(gate).toMatchObject({ version: 2, inForce: 1, startNow: 2, wait: 1, maxWorkers: { after: 4 } });
    expect(gate.finished).toMatchObject({ index: 0, title: "Skeleton", doneWhen: ["A CSV can be downloaded"], report: "CSV-1 landed; CSV-2 was cancelled." });
    expect(gate.finished!.tickets).toEqual([
      expect.objectContaining({ key: "CSV-1", state: "done", prUrl: "https://github.com/acme/shop/pull/861", mergeSha: "7d1e3a9f00", checks: { passed: 4, failed: 0, pending: 0, at: 1_000 }, review: expect.objectContaining({ verdict: "approved", round: 2, threadId: "thr_rev" }), cancel: null }),
      expect.objectContaining({ key: "CSV-2", state: "cancelled", mergeSha: null, cancel: expect.objectContaining({ reason: "no archived market serves traffic, so there is nothing to backfill.", by: "planner" }) }),
    ]);
    expect(gate.proposed).toMatchObject({ index: 1, title: "Polish", maxTickets: 8 });
    expect(gate.proposed.tickets.filter((ticket) => ticket.starts).map((ticket) => ticket.key)).toEqual(["CSV-3", "CSV-5"]);
    expect(gate.proposed.tickets.map((ticket) => [ticket.key, ticket.ref, ticket.dependsOn, ticket.mergeAfter, ticket.ready])).toEqual([
      ["CSV-3", "stream", ["CSV-1"], [], true],
      ["CSV-4", "resume", ["CSV-3"], [], false],
      ["CSV-5", "gzip", [], ["CSV-3"], true],
    ]);
    // The proposed phase and its tickets are on their own side; the rest of the version is counted here.
    const paths = gate.changes.map((change) => change.path);
    expect(paths).toEqual(expect.arrayContaining(["phase[0].report", "phase[2].outline", "agents.max_workers"]));
    expect(paths.some((path) => path.startsWith("phase[1]") || path.startsWith("ticket["))).toBe(false);
    expect(undefinedAt(gate)).toEqual([]);
  });

  it("starts only what the free slots take, in the scheduler's order, when more tickets are ready", async () => {
    const view = await atTheGate("running", 1);
    const gate = view.gate!;
    expect(gate).toMatchObject({ startNow: 1, wait: 2 });
    expect(gate.proposed.tickets.map((ticket) => [ticket.key, ticket.ready, ticket.starts])).toEqual([
      ["CSV-3", true, true],
      ["CSV-4", false, false],
      ["CSV-5", true, false],
    ]);
  });

  it("starts nothing while a rate-limit hold is in the future, as the engine does, and names when it ends", async () => {
    const until = Date.now() + 10 * 60_000;
    const view = await atTheGate("running", 4, until);
    expect(view.gate).toMatchObject({ startNow: 0, wait: 3, holdUntil: until });
    expect(view.gate!.proposed.tickets.map((ticket) => [ticket.key, ticket.ready, ticket.starts])).toEqual([
      ["CSV-3", true, false],
      ["CSV-4", false, false],
      ["CSV-5", true, false],
    ]);
  });

  it("starts the same tickets again once the hold has ended", async () => {
    const view = await atTheGate("running", 4, Date.now() - 1_000);
    expect(view.gate).toMatchObject({ startNow: 2, wait: 1, holdUntil: null });
    expect(view.gate!.proposed.tickets.filter((ticket) => ticket.starts).map((ticket) => ticket.key)).toEqual(["CSV-3", "CSV-5"]);
  });

  it("starts nothing while the project is paused, and has no gate for a version that fills no phase", async () => {
    const paused = await atTheGate("paused");
    expect(paused.gate).toMatchObject({ startNow: 0, wait: 3 });
    // Paused, the ready tickets stay ready but none starts.
    expect(paused.gate!.proposed.tickets.map((ticket) => [ticket.key, ticket.ready, ticket.starts])).toEqual([
      ["CSV-3", true, false],
      ["CSV-4", false, false],
      ["CSV-5", true, false],
    ]);
    await propose((d) => (d.project.summary = "Only the summary changes."));
    const plain = await call<ProjectView>("project", { slug: "csv" });
    expect(plain.spec.pendingVersion).toBe(3);
    expect(plain.gate).toBeNull();
  });
});
