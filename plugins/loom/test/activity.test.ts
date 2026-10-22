import { beforeEach, describe, expect, it } from "vitest";
import { stripAnsi, ticketActivity, type ChecksItem, type MergeItem, type ReviewItem } from "../src/activity";
import { settleChecks, submit } from "../src/checks";
import { runMergeQueue, settleMerges } from "../src/merge";
import { SpawnRefusedError } from "../src/ports";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import type { AuthorKind, PostKind } from "../src/states";
import { editTicket } from "../src/triage";
import { blockTicket, endThread, requeueTicket, specOf } from "../src/workers";
import { checkOutHead, makeCtx, reachReview, seedProject, startWorker, ticketOf, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const activity = () => {
  const ticket = ticketOf(h, "CSV-1");
  return ticketActivity({ state: ticket.state, posts: h.store.posts(ticket.id), threads: h.store.threadsForTicket(ticket.id), runs: h.store.runs(ticket.id) });
};

const add = (kind: PostKind, body: string, data: object = {}, author: { kind: AuthorKind; thread: string | null } = { kind: "loom", thread: null }) => {
  const ticket = ticketOf(h, "CSV-1");
  return h.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: author.kind, author_thread_id: author.thread, kind, body, data_json: JSON.stringify(data) });
};

const checkRun = (kind: "command" | "git", label: string) => {
  const ticket = ticketOf(h, "CSV-1");
  return h.store.startRun({ project_id: ticket.project_id, ticket_id: ticket.id, stage: "check", kind, label });
};

describe("ticketActivity", () => {
  it("puts a merged ticket's submit, checks, review and merge in its one attempt, with every recorded step", async () => {
    await seedProject(h, (doc) => (doc.checks.after_merge = ["npm run e2e"]));
    const worker = await reachReview(h);
    const project = h.store.projectBySlug("csv")!;
    await spawnReviewers(h.ctx, project, specOf(h.store, project));
    const ticket = ticketOf(h, "CSV-1");
    const reviewer = h.store.threads({ ticketId: ticket.id, role: "reviewer" })[0]!;
    checkOutHead(h, reviewer);
    const note = add("note", "Checked the row mapper.", {}, { kind: "reviewer", thread: reviewer.thread_id });
    await approve(h.ctx, reviewer.thread_id!, "Looks good");
    await settleReviews(h.ctx);
    await runMergeQueue(h.ctx, project, specOf(h.store, project));
    await settleMerges(h.ctx);

    const { brief, before, attempts } = activity();
    const posts = h.store.posts(ticket.id);
    expect(brief).toMatchObject({ postId: posts[0]!.id, edits: 0, fields: [] });
    expect(before).toEqual([]);
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt).toMatchObject({ n: 1, threadId: worker.thread_id, outcome: "merged", line: "Merged m1 into loom/csv.", pipeline: { work: "pass", checks: ["pass"], review: ["pass"], merge: ["pass"] } });
    expect(attempt.claimPostId).toBe(posts.find((post) => post.kind === "claim")!.id);
    expect(attempt.endedAt).not.toBeNull();
    expect(attempt.items.map((item) => item.type)).toEqual(["post", "checks", "review", "merge"]);
    expect(attempt.items[0]).toEqual({ type: "post", postId: posts.find((post) => post.kind === "submit")!.id });

    const runs = h.store.runs(ticket.id);
    const checks = attempt.items[1] as ChecksItem;
    expect(checks).toMatchObject({ postId: posts.find((post) => post.kind === "check")!.id, status: "passed", afterMerge: false, changed: null, outside: [] });
    expect(checks.steps.map((step) => step.label)).toEqual(["git commit", "git status", "npm test", "git status"]);
    expect(checks.steps.map((step) => step.runId)).toEqual(runs.filter((run) => run.stage === "check").map((run) => run.id));
    expect(checks.steps[0]).toMatchObject({ kind: "git", ok: true, exitCode: null, running: false });
    expect(checks.steps[2]).toMatchObject({ kind: "command", ok: true, exitCode: 0, durationMs: 12, running: false, output: null });

    const review = attempt.items[2] as ReviewItem;
    expect(review).toEqual({ type: "review", postId: posts.find((post) => post.kind === "review")!.id, reviewId: h.store.reviews(ticket.id)[0]!.id, notePostIds: [note.id] });

    const merge = attempt.items[3] as MergeItem;
    expect(merge).toMatchObject({ postId: posts.find((post) => post.kind === "merge")!.id, outcome: "merged", into: "loom/csv", running: false });
    expect(merge.steps.map((step) => step.label)).toEqual(["prepare the Loom worktree", "git status", "git merge", "npm run e2e", "git status"]);
    expect(merge.steps.map((step) => step.runId)).toEqual(runs.filter((run) => run.stage === "merge").map((run) => run.id));
  });

  it("keeps a worker's block, the planner's requeue note and an edit with the attempt that blocked, and counts the brief's edits", async () => {
    await seedProject(h);
    const first = await startWorker(h);
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "The export needs the v2 API key. It is not in the vault", needs: "the staging key", actor: first.thread_id! });
    expect(ticketOf(h, "CSV-1").state).toBe("blocked");
    const block = h.store.posts(ticketOf(h, "CSV-1").id).find((post) => post.kind === "block")!;
    const answer = h.projects.post("CSV-1", { body: "Ask the planner.", parentId: block.id, author: "human" });
    await requeueTicket(h.ctx, "CSV-1", { note: "The key is in staging.", actor: "thr_plan", author: "planner", threadId: "thr_plan" });
    const requeue = h.store.posts(ticketOf(h, "CSV-1").id).at(-1)!;
    editTicket(h.ctx, "CSV-1", { body: "Serve the file with the v2 API." }, "thr_plan");
    const edit = h.store.posts(ticketOf(h, "CSV-1").id).at(-1)!;
    const second = await startWorker(h);

    const { brief, attempts } = activity();
    expect(brief).toMatchObject({ edits: 1, fields: ["body"] });
    expect(attempts.map((attempt) => [attempt.n, attempt.outcome, attempt.threadId])).toEqual([
      [1, "blocked", first.thread_id],
      [2, "in_progress", second.thread_id],
    ]);
    expect(attempts[0]).toMatchObject({ line: "Asked the planner: The export needs the v2 API key.", pipeline: { work: "fail", checks: [], review: [], merge: [] } });
    expect(attempts[0]!.endedAt).not.toBeNull();
    expect(attempts[0]!.items).toEqual([
      { type: "post", postId: block.id },
      { type: "post", postId: requeue.id },
      { type: "post", postId: edit.id },
    ]);
    expect(JSON.stringify(attempts)).not.toContain(`"postId":${answer.id}`);
    expect(requeue).toMatchObject({ kind: "reply", author_kind: "planner", parent_id: null });
    expect(attempts[1]).toMatchObject({ endedAt: null, line: null, pipeline: { work: "running", checks: [], review: [], merge: [] }, items: [] });
  });

  it("takes an old check's steps from its post, with the failed command's output from the post's tail and no colour codes", async () => {
    await seedProject(h);
    const worker = await startWorker(h);
    add("submit", "Done", {}, { kind: "worker", thread: worker.thread_id });
    const tail = "\u001b[31m1 failing\u001b[39m\n\u001b]8;;https://example.com/docs\u0007see the docs\u001b]8;;\u0007";
    const check = add("check", `Checks failed.\npass npm run lint (exit 0, 1.0s)\nFAIL npm test (exit 1, 0.3s)\n\n${tail}`, {
      passed: false,
      runs: [
        { command: "npm run lint", exitCode: 0, timedOut: false, durationMs: 1000 },
        { command: "npm test", exitCode: 1, timedOut: false, durationMs: 300 },
      ],
      outside: [],
      protectedHits: [],
    });

    const { items, pipeline } = activity().attempts[0]!;
    expect(items[1]).toMatchObject({ type: "checks", postId: check.id, status: "failed", afterMerge: false });
    expect((items[1] as ChecksItem).steps.map(({ label, kind, ok, exitCode, durationMs, runId, output }) => ({ label, kind, ok, exitCode, durationMs, runId, output }))).toEqual([
      { label: "npm run lint", kind: "command", ok: true, exitCode: 0, durationMs: 1000, runId: null, output: null },
      { label: "npm test", kind: "command", ok: false, exitCode: 1, durationMs: 300, runId: null, output: "1 failing\nsee the docs" },
    ]);
    expect(pipeline.checks).toEqual(["fail"]);
    expect(stripAnsi("33m 800ms\u001b[0m done\u001b]0;title\u001b\\")).toBe("33m 800ms done");
  });

  it("splits a pipeline that a restart cut short from its rerun under the same submit", async () => {
    await seedProject(h);
    const worker = await startWorker(h);
    const submitted = add("submit", "Done", {}, { kind: "worker", thread: worker.thread_id });
    const commit1 = checkRun("git", "git commit");
    h.store.finishRun(commit1, { ok: true, output: "Committed c1." });
    const cut = checkRun("command", "npm test");
    h.store.endOpenRuns("Loom restarted before this step finished.");
    h.clock.advance(1000);
    const commit2 = checkRun("git", "git commit");
    h.store.finishRun(commit2, { ok: true, output: "Nothing new to commit; HEAD is c1." });
    const test2 = checkRun("command", "npm test");
    h.store.finishRun(test2, { ok: true, output: "ok", exitCode: 0, durationMs: 900 });
    const check = add("check", "Checks passed (1 command).\npass npm test (exit 0, 0.9s)", { passed: true, runs: [{ command: "npm test", exitCode: 0, timedOut: false, durationMs: 900 }], outside: [], protectedHits: [] });

    const { items, pipeline } = activity().attempts[0]!;
    expect(items.map((item) => (item.type === "checks" ? [item.status, item.postId, item.steps.map((step) => step.runId)] : [item.type]))).toEqual([
      ["post"],
      ["unfinished", null, [commit1, cut]],
      ["passed", check.id, [commit2, test2]],
    ]);
    expect(items[0]).toEqual({ type: "post", postId: submitted.id });
    expect((items[1] as ChecksItem).steps[1]).toMatchObject({ ok: null, running: false, durationMs: null });
    expect(pipeline.checks).toEqual(["none", "pass"]);
  });

  it("shows a check that is running as a card right after its submit, even before its first step", async () => {
    await seedProject(h);
    const worker = await startWorker(h);
    const ticket = ticketOf(h, "CSV-1");
    h.store.setTicketState(ticket.id, "checking", worker.thread_id!);
    const submitted = add("submit", "Done", {}, { kind: "worker", thread: worker.thread_id });
    expect(activity().attempts[0]!.items).toEqual([{ type: "post", postId: submitted.id }, expect.objectContaining({ type: "checks", postId: null, status: "running", steps: [] })]);

    const open = checkRun("command", "npm test");
    const note = add("note", "Waiting for the checks.", {}, { kind: "worker", thread: worker.thread_id });
    const { items, pipeline } = activity().attempts[0]!;
    expect(items.map((item) => item.type)).toEqual(["post", "checks", "post"]);
    expect(items[1]).toMatchObject({ type: "checks", postId: null, status: "running", steps: [{ runId: open, running: true, ok: null, durationMs: null }] });
    expect(items[2]).toEqual({ type: "post", postId: note.id });
    expect(pipeline.checks).toEqual(["running"]);
  });

  it("says why an after-merge check failed when its command passed but changed the branch, and marks a conflict as a failed merge", async () => {
    await seedProject(h);
    await startWorker(h);
    const conflict = add("merge", "Merging into loom/csv conflicted in: a.ts.", { outcome: "conflict", files: ["a.ts"] });
    const check = add("check", "Checks after merging into loom/csv failed.\nFAIL npm run e2e (exit 0, 0.5s) but it changed the branch: left tracked files modified\n\nwrote dist/app.js", {
      passed: false,
      afterMerge: true,
      changed: "left tracked files modified",
      runs: [{ command: "npm run e2e", exitCode: 0, timedOut: false, durationMs: 500 }],
      outside: [],
      protectedHits: [],
    });

    const { items, pipeline } = activity().attempts[0]!;
    expect(items[0]).toEqual({ type: "merge", postId: conflict.id, at: conflict.at, outcome: "conflict", into: null, running: false, steps: [] });
    expect(items[1]).toMatchObject({ type: "checks", postId: check.id, afterMerge: true, status: "failed", changed: "left tracked files modified" });
    const steps = (items[1] as ChecksItem).steps;
    expect(steps.map((step) => step.label)).toEqual(["npm run e2e"]);
    expect(steps.every((step) => step.ok === true)).toBe(true);
    expect(steps[0]!.output).toBe("wrote dist/app.js");
    expect(pipeline).toEqual({ work: "running", checks: [], review: [], merge: ["fail", "fail"] });
  });

  it("calls an attempt that bb refused to start blocked, and says it could not start", async () => {
    await seedProject(h);
    h.bb.spawnError = () => new SpawnRefusedError(400, "HTTP 400: Provider pi only supports full permission mode.");
    await startWorker(h);
    expect(ticketOf(h, "CSV-1").state).toBe("blocked");

    const refusal = h.store.posts(ticketOf(h, "CSV-1").id).find((post) => post.kind === "system")!;
    const attempt = activity().attempts[0]!;
    expect(attempt).toMatchObject({ n: 1, threadId: null, outcome: "blocked", line: "The worker could not start.", pipeline: { work: "fail", checks: [], review: [], merge: [] } });
    expect(attempt.endedAt).not.toBeNull();
    expect(attempt.items).toEqual([{ type: "post", postId: refusal.id }]);
  });

  it("keeps the passed checks of an attempt whose reviewer bb refused, and says why it blocked", async () => {
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
    expect(ticketOf(h, "CSV-1").state).toBe("blocked");

    expect(activity().attempts[0]).toMatchObject({
      outcome: "blocked",
      line: "Blocked: bb refused to start a reviewer: HTTP 400: Unsupported provider claude",
      pipeline: { work: "pass", checks: ["pass"], review: [], merge: [] },
    });
  });

  it("says how the worker ended when nothing blocked its attempt", async () => {
    await seedProject(h);
    const worker = await startWorker(h);
    h.clock.advance(60_000);
    await endThread(h.ctx, worker, "timeout", { commit: true });
    expect(ticketOf(h, "CSV-1").state).toBe("queued");

    expect(activity().attempts[0]).toMatchObject({ outcome: "ended", line: "The worker ended: timeout.", startedAt: worker.started_at, endedAt: h.clock.now(), pipeline: { work: "fail" } });
  });
});
