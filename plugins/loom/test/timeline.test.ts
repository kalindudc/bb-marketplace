import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import { runMergeQueue, settleMerges } from "../src/merge";
import { SpawnRefusedError } from "../src/ports";
import { spawnReviewers } from "../src/review";
import { ticketTimeline } from "../src/timeline";
import { specOf } from "../src/workers";
import { makeCtx, reachApproved, seedProject, startWorker, ticketOf, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const timeline = () => {
  const ticket = ticketOf(h, "CSV-1");
  return ticketTimeline({ posts: h.store.posts(ticket.id), threads: h.store.threadsForTicket(ticket.id), runs: h.store.runs(ticket.id) });
};

describe("ticketTimeline", () => {
  it("lists a merged ticket's steps in pipeline order, with their results and threads", async () => {
    await seedProject(h, (doc) => (doc.checks.after_merge = ["npm run e2e"]));
    const worker = await reachApproved(h);
    const reviewer = h.store.threads({ ticketId: ticketOf(h, "CSV-1").id, role: "reviewer" })[0]!;
    const project = h.store.projectBySlug("csv")!;
    await runMergeQueue(h.ctx, project, specOf(h.store, project));
    await settleMerges(h.ctx);

    const entries = timeline();
    expect(entries.map((entry) => [entry.stage, entry.kind, entry.title])).toEqual([
      ["work", "worker", "Worker, attempt 1"],
      ["work", "submit", "Submitted for checks"],
      ["checks", "run", "git commit"],
      ["checks", "run", "git status"],
      ["checks", "run", "npm test"],
      ["checks", "run", "git status"],
      ["checks", "check", "Checks passed (1 command)."],
      ["review", "reviewer", "Reviewer, round 1"],
      ["review", "review", "Approved (round 1): Looks good"],
      ["merge", "run", "prepare the Loom worktree"],
      ["merge", "run", "git status"],
      ["merge", "run", "git merge"],
      ["merge", "run", "npm run e2e"],
      ["merge", "run", "git status"],
      ["merge", "merge", "Merged m1 into loom/csv."],
    ]);
    const byKind = (kind: string) => entries.find((entry) => entry.kind === kind)!;
    expect([byKind("check").ok, byKind("review").ok, byKind("merge").ok]).toEqual([true, true, true]);
    expect(byKind("worker")).toMatchObject({ threadId: worker.thread_id, detail: "merged after 0s", ok: null, run: null });
    expect(byKind("submit")).toMatchObject({ detail: "Done", threadId: worker.thread_id });
    expect(byKind("review").threadId).toBe(reviewer.thread_id);
    expect(byKind("check").detail).toContain("pass npm test (exit 0, 0.0s)");
    const runs = h.store.runs(ticketOf(h, "CSV-1").id);
    expect(entries.filter((entry) => entry.kind === "run").map((entry) => entry.run?.id)).toEqual(runs.map((run) => run.id));
    expect(entries.find((entry) => entry.kind === "run")).toMatchObject({ ok: true, threadId: null, run: { kind: "git", running: false, exitCode: null, timedOut: false } });
    expect(entries.find((entry) => entry.title === "npm test")!.run).toMatchObject({ kind: "command", exitCode: 0, durationMs: 12 });
  });

  it("marks a running run, one a restart cut short, a failed check and a block, and titles a worker without an attempt", async () => {
    await seedProject(h);
    const ticket = ticketOf(h, "CSV-1");
    const row = h.store.addThread({ project_id: ticket.project_id, ticket_id: ticket.id, role: "worker", state: "active", thread_id: "thr_old" });
    const cut = h.store.startRun({ project_id: ticket.project_id, ticket_id: ticket.id, stage: "check", kind: "command", label: "npm test" });
    h.store.endOpenRuns("Loom restarted before this step finished.");
    h.clock.advance(1000);
    h.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "check", body: "Checks failed.\nFAIL npm test (exit 1, 0.1s)", data_json: JSON.stringify({ passed: false }) });
    h.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "block", body: "Checks failed 3 times." });
    h.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "human", author_thread_id: null, kind: "reply", body: "Hello" });
    h.clock.advance(1000);
    const open = h.store.startRun({ project_id: ticket.project_id, ticket_id: ticket.id, stage: "check", kind: "command", label: "npm run lint" });

    const entries = timeline();
    expect(entries.map((entry) => entry.kind)).toEqual(["worker", "run", "check", "block", "run"]);
    expect(entries[0]).toMatchObject({ title: "Worker", detail: "working", threadId: "thr_old" });
    expect(entries[0]!.at).toBe(row.started_at);
    expect(entries[1]).toMatchObject({ ok: null, run: { id: cut, running: false } });
    expect(entries[2]).toMatchObject({ stage: "checks", ok: false, title: "Checks failed.", detail: "FAIL npm test (exit 1, 0.1s)" });
    expect(entries[3]).toMatchObject({ stage: "other", ok: false, title: "Checks failed 3 times.", detail: null });
    expect(entries[4]).toMatchObject({ ok: null, run: { id: open, running: true, durationMs: null } });
  });

  it("puts a check after the merge in the merge stage, and a conflict as failed", async () => {
    await seedProject(h);
    const ticket = ticketOf(h, "CSV-1");
    const post = (kind: "check" | "merge", body: string, data: object) =>
      h.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind, body, data_json: JSON.stringify(data) });
    post("merge", "Merging into loom/csv conflicted in: a.ts.", { outcome: "conflict", files: ["a.ts"] });
    post("check", "Checks after merging into loom/csv failed.", { passed: false, afterMerge: true });
    expect(timeline().map((entry) => [entry.stage, entry.kind, entry.ok])).toEqual([
      ["merge", "merge", false],
      ["merge", "check", false],
    ]);
  });

  it("shows a worker that bb refused to start as an attempt that could not start, with bb's message under Work", async () => {
    await seedProject(h);
    h.bb.spawnError = () => new SpawnRefusedError(400, "HTTP 400: Provider pi only supports full permission mode.");
    await startWorker(h);
    expect(ticketOf(h, "CSV-1").state).toBe("blocked");
    expect(timeline().map(({ stage, kind, title, detail, ok, threadId }) => ({ stage, kind, title, detail, ok, threadId }))).toEqual([
      { stage: "work", kind: "worker", title: "Worker, attempt 1", detail: "could not start", ok: false, threadId: null },
      { stage: "work", kind: "system", title: "Could not start a worker: HTTP 400: Provider pi only supports full permission mode.", detail: null, ok: false, threadId: null },
    ]);
  });

  it("shows a worker whose reviewer bb refused as submitted, and the refusal and the block under Review", async () => {
    await seedProject(h);
    const worker = await startWorker(h);
    h.clock.advance(27_000);
    Object.assign(h.host.worktree(`/wt/${worker.environment_id}`), { dirty: true, changed: ["src/model/a.ts"] });
    submit(h.ctx, worker.thread_id!, "Done");
    await settleChecks(h.ctx);
    h.clock.advance(1_000);
    h.bb.spawnError = () => new SpawnRefusedError(400, "HTTP 400: Unsupported provider claude");
    const project = h.store.projectBySlug("csv")!;
    await spawnReviewers(h.ctx, project, specOf(h.store, project));
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "blocked" });

    const steps = timeline().filter((entry) => entry.kind !== "run");
    expect(steps.map(({ stage, kind, title, detail, ok }) => ({ stage, kind, title, detail, ok }))).toEqual([
      { stage: "work", kind: "worker", title: "Worker, attempt 1", detail: "submitted after 27s", ok: null },
      { stage: "work", kind: "submit", title: "Submitted for checks", detail: "Done", ok: null },
      { stage: "checks", kind: "check", title: "Checks passed (1 command).", detail: expect.stringContaining("pass npm test"), ok: true },
      { stage: "review", kind: "reviewer", title: "Reviewer, round 1", detail: "could not start", ok: false },
      { stage: "review", kind: "system", title: "Could not start a reviewer: HTTP 400: Unsupported provider claude", detail: null, ok: false },
      { stage: "review", kind: "block", title: "bb refused to start a reviewer: HTTP 400: Unsupported provider claude", detail: null, ok: false },
    ]);
  });

  it("keeps a worker's own ending when its checks failed or a review sent the work back", async () => {
    await seedProject(h);
    const worker = await startWorker(h);
    const ticket = ticketOf(h, "CSV-1");
    const post = (kind: "submit" | "check" | "review", data: object, author: string | null = null) =>
      h.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: author === null ? "loom" : "worker", author_thread_id: author, kind, body: kind, data_json: JSON.stringify(data) });
    post("submit", {}, worker.thread_id);
    post("check", { passed: true });
    post("review", { verdict: "changes_requested" });
    h.clock.advance(60_000);
    h.store.updateThread(worker.id, { state: "ended", ended_at: h.clock.now(), end_reason: "timeout" });
    expect(timeline()[0]).toMatchObject({ kind: "worker", detail: "timeout after 1m" });
  });
});
