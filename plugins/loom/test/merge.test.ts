import { beforeEach, describe, expect, it } from "vitest";
import { heldCheckResult } from "../src/prompts";
import { finishIfComplete, holdMerge, land, mergeTicket, pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { readyTickets, toLite } from "../src/scheduler";
import type { HostOutput } from "../src/host-contract";
import { blockTicket, endThread, requeueTicket, specOf } from "../src/workers";
import { makeCtx, reachApproved, seedProject, seedRepoProject, specToml, startWorker, ticketOf, withDocsTicket, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const WORKTREE = "/data/worktrees/csv";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const posts = (key = "CSV-1") => h.store.posts(ticketOf(h, key).id);
const lastPost = (kind: string, key = "CSV-1") => posts(key).filter((post) => post.kind === kind).at(-1)!;
const archived = () => h.bb.callsTo("archive").map(([id]) => id);
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const withAfterMerge = (doc: Doc) => (doc.checks.after_merge = ["npm run e2e"]);
const mergeRuns = (key = "CSV-1") => h.store.runs(ticketOf(h, key).id).filter((run) => run.stage === "merge");
const hostCallsSince = (mark: number) => h.host.calls.slice(mark);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

describe("the integration merge", () => {
  it("merges exactly head_sha in the Loom worktree, runs after_merge there, and completes the ticket", async () => {
    await seedProject(h, withAfterMerge);
    const worker = await reachApproved(h);
    const reviewer = h.store.threads({ ticketId: ticketOf(h, "CSV-1").id, role: "reviewer" })[0]!;
    const mark = h.host.calls.length;
    await queue();

    expect(hostCallsSince(mark).map((call) => [call.method, call.input])).toEqual([
      ["ensureWorktree", { repo: "/repo", key: "csv", branch: "loom/csv" }],
      ["worktreeState", { worktree: WORKTREE, base: "main" }],
      ["merge", { worktree: WORKTREE, ref: "c1", message: "CSV-1: Order rows (Loom)", before: "base000" }],
      ["exec", { cwd: WORKTREE, command: "npm run e2e", timeoutMs: 15 * 60_000 }],
      ["worktreeState", { worktree: WORKTREE, base: "main", trackedOnly: true }],
    ]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "done", worker_thread_id: null, environment_id: null });
    expect(lastPost("merge")).toMatchObject({ author_kind: "loom" });
    expect(JSON.parse(lastPost("merge").data_json)).toMatchObject({ outcome: "merged", sha: "m1", before: "base000", already: false });
    expect(lastPost("merge").body).toContain("m1");
    expect(mergeRuns().map((run) => [run.label, run.ok])).toEqual([
      ["prepare the Loom worktree", 1],
      ["git status", 1],
      ["git merge", 1],
      ["npm run e2e", 1],
      ["git status", 1],
    ]);
    expect(h.store.runOutput(mergeRuns()[2]!.id)).toContain("m1");
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "merged" });
    expect(h.store.thread(reviewer.id)!.state).toBe("ended");
    expect(archived()).toContain(worker.thread_id);
    expect(h.kicks.count).toBeGreaterThan(0);
    expect(readyTickets(h.store.tickets(project().id).map(toLite)).map((ticket) => ticket.key)).toEqual(["CSV-2"]);
  });

  it("merges without after_merge commands when the spec has none", async () => {
    await seedProject(h);
    await reachApproved(h);
    const mark = h.host.calls.length;
    await queue();
    expect(hostCallsSince(mark).map((call) => call.method)).toEqual(["ensureWorktree", "worktreeState", "merge"]);
    expect(ticketOf(h, "CSV-1").state).toBe("done");
  });

  it("sends a conflict back to a live worker with the files, leaving after_merge unrun", async () => {
    await seedProject(h, withAfterMerge);
    const worker = await reachApproved(h);
    h.clock.advance(60_000);
    h.host.scripted.merge = [{ outcome: "conflict", files: ["src/model/a.ts", "src/model/b.ts"] }];
    const mark = h.host.calls.length;
    await queue();

    expect(hostCallsSince(mark).map((call) => call.method)).toEqual(["ensureWorktree", "worktreeState", "merge"]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 0, worker_thread_id: worker.thread_id });
    expect(h.store.thread(worker.id)).toMatchObject({ clock_at: h.clock.t, idle_count: 0 });
    const sent = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(sent).toContain("conflicts in 2 files");
    expect(sent).toContain("- src/model/a.ts\n- src/model/b.ts");
    expect(sent).toContain("git merge loom/csv");
    expect(JSON.parse(lastPost("merge").data_json)).toMatchObject({ outcome: "conflict", files: ["src/model/a.ts", "src/model/b.ts"] });
    expect(heldCheckResult(posts())).toMatchObject({ kind: "merge" });
    const merge = mergeRuns().find((run) => run.label === "git merge")!;
    expect(merge.ok).toBe(0);
    expect(h.store.runOutput(merge.id)).toBe("Conflicts in:\nsrc/model/a.ts\nsrc/model/b.ts");
  });

  it("queues the ticket again on a conflict when the worker is gone", async () => {
    await seedProject(h);
    const worker = await reachApproved(h);
    await endThread(h.ctx, worker, "gone", { commit: false });
    h.host.scripted.merge = [{ outcome: "conflict", files: ["a.ts"] }];
    await queue();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", worker_thread_id: null, environment_id: null });
  });

  it("rolls back a failed after_merge check, counts a check failure and sends the output to the worker", async () => {
    await seedProject(h, withAfterMerge);
    const worker = await reachApproved(h);
    h.host.execResults = [{ exitCode: 1, output: "FAILED e2e: expected 3 rows" }];
    await queue();

    expect(h.host.callsTo("resetHard")).toEqual([{ worktree: WORKTREE, sha: "base000" }]);
    expect(h.host.worktree(WORKTREE).head).toBe("base000");
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    const sent = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(sent).toContain('"npm run e2e" exited with 1');
    expect(sent).toContain("FAILED e2e: expected 3 rows");
    const check = lastPost("check");
    expect(JSON.parse(check.data_json)).toMatchObject({ passed: false });
    expect(check.body).toContain("FAILED e2e");
  });

  it("blocks the ticket when after_merge failures reach max_check_failures", async () => {
    await seedProject(h, (doc) => {
      withAfterMerge(doc);
      doc.budget = { max_check_failures: 1 };
    });
    const worker = await reachApproved(h);
    h.host.execResults = [{ exitCode: 1, output: "FAILED" }];
    await queue();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "checks failed 1 time", worker_thread_id: null });
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "blocked" });
    expect(project().triage_pending).toBe(1);
  });

  it("rolls back to the point the host reports when a rerun finds the merge already made and after_merge fails", async () => {
    await seedProject(h, withAfterMerge);
    await reachApproved(h);
    h.host.scripted.merge = [{ outcome: "merged", sha: "m9", before: "b0", already: true }];
    h.host.execResults = [{ exitCode: 2, output: "boom" }];
    await queue();
    expect(h.host.callsTo("resetHard")).toEqual([{ worktree: WORKTREE, sha: "b0" }]);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
  });

  it("rolls back and sends the ticket back when an after_merge command exits 0 but moved HEAD, and runs no later command", async () => {
    await seedProject(h, (doc) => (doc.checks.after_merge = ["npm run build", "npm run e2e"]));
    const worker = await reachApproved(h);
    h.host.onExec = (_input, worktree) => void (worktree.head = "x1");
    const mark = h.host.calls.length;
    await queue();

    expect(hostCallsSince(mark).filter((call) => call.method === "exec").map((call) => (call.input as { command: string }).command)).toEqual(["npm run build"]);
    expect(h.host.callsTo("resetHard")).toEqual([{ worktree: WORKTREE, sha: "base000" }]);
    expect(h.host.worktree(WORKTREE).head).toBe("base000");
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    const check = lastPost("check");
    expect(check.body).toContain("FAIL npm run build (exit 0");
    expect(check.body).toContain("changed the branch");
    expect(JSON.parse(check.data_json)).toMatchObject({ passed: false, afterMerge: true });
    expect(posts().filter((post) => post.kind === "merge")).toEqual([]);
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("changed the branch");
  });

  it("rolls back when an after_merge command exits 0 but left tracked files modified", async () => {
    await seedProject(h, withAfterMerge);
    await reachApproved(h);
    h.host.onExec = (_input, worktree) => void (worktree.dirty = true);
    await queue();

    expect(h.host.callsTo("resetHard")).toEqual([{ worktree: WORKTREE, sha: "base000" }]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    expect(lastPost("check").body).toContain("changed the branch");
    expect(h.host.worktree(WORKTREE)).toMatchObject({ head: "base000", dirty: false });
  });

  it("blocks the ticket when the after_merge command that changed the branch was the last failure the budget allows", async () => {
    await seedProject(h, (doc) => {
      withAfterMerge(doc);
      doc.budget = { max_check_failures: 1 };
    });
    await reachApproved(h);
    h.host.onExec = (_input, worktree) => void (worktree.head = "x1");
    await queue();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "checks failed 1 time" });
    expect(h.host.worktree(WORKTREE).head).toBe("base000");
  });

  it("persists the rollback point before merging and hands it to the host when the merge runs again", async () => {
    await seedProject(h, withAfterMerge);
    await reachApproved(h);
    h.host.execResults = [new Error("host disconnected")];
    await queue();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "merging", merge_before: "base000" });
    expect(h.host.callsTo("merge")[0]).toMatchObject({ before: "base000" });

    h.store.setProjectState(project().id, "running", "human");
    h.host.execResults = [{ exitCode: 1, output: "FAILED e2e" }];
    await queue();
    expect(h.host.callsTo("merge")[1]).toMatchObject({ before: "base000" });
    expect(h.host.callsTo("resetHard")).toEqual([{ worktree: WORKTREE, sha: "base000" }]);
    expect(h.host.worktree(WORKTREE).head).toBe("base000");
    expect(ticketOf(h, "CSV-1").state).toBe("working");
  });

  it("starts each merge attempt with a fresh rollback point", async () => {
    await seedProject(h, withAfterMerge);
    await reachApproved(h);
    h.host.execResults = [{ exitCode: 1, output: "FAILED e2e" }];
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("working");

    h.store.updateTicket(ticketOf(h, "CSV-1").id, { merge_before: "stale00" });
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "review", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "approved", "loom");
    await queue();
    expect(h.host.callsTo("merge").at(-1)).toMatchObject({ before: "base000" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "done", merge_before: "base000" });
  });

  it("never rolls back another ticket's merge when its own target was already merged", async () => {
    await seedProject(h, withAfterMerge);
    await reachApproved(h, "CSV-1");
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(h.host.worktree(WORKTREE).head).toBe("m1");

    await reachApproved(h, "CSV-2");
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { head_sha: ticketOf(h, "CSV-1").head_sha });
    h.host.execResults = [{ exitCode: 1, output: "FAILED e2e" }];
    await queue();

    expect(h.host.callsTo("merge").at(-1)).toMatchObject({ before: "m1" });
    expect(h.host.callsTo("resetHard")).toEqual([{ worktree: WORKTREE, sha: "m1" }]);
    expect(h.host.worktree(WORKTREE).head).toBe("m1");
    expect(ticketOf(h, "CSV-2").state).toBe("working");
  });

  it("finishes a ticket left in merging by an unavailable host after resume, with one merge commit and no restart", async () => {
    await seedProject(h, withAfterMerge);
    await reachApproved(h);
    h.host.execResults = [new Error("host disconnected")];
    await queue();
    expect(project()).toMatchObject({ state: "paused", system_reason: "Merging CSV-1 stopped: host disconnected", triage_pending: 1 });
    expect(ticketOf(h, "CSV-1").state).toBe("merging");

    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("merging");
    expect(h.host.callsTo("merge")).toHaveLength(1);

    h.store.setProjectState(project().id, "running", "human");
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(h.host.callsTo("merge")).toHaveLength(2);
    expect(h.host.merges.get(WORKTREE)).toHaveLength(1);
  });

  it("pauses with the host's message when the worktree or the branch cannot be used", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.host.scripted.ensureWorktree = [{ outcome: "unavailable", reason: "branch_checked_out", message: "fatal: 'loom/csv' is already used by worktree at '/repo'" }];
    await queue();
    expect(project()).toMatchObject({ state: "paused", system_reason: "loom/csv is checked out elsewhere; switch that checkout off it and resume" });
    expect(ticketOf(h, "CSV-1").state).toBe("merging");
    expect(mergeRuns().map((run) => [run.label, run.ok])).toEqual([["prepare the Loom worktree", 0]]);
    expect(h.store.runOutput(mergeRuns()[0]!.id)).toBe("fatal: 'loom/csv' is already used by worktree at '/repo'");

    h.store.setProjectState(project().id, "running", "human");
    h.host.scripted.ensureWorktree = [{ outcome: "unavailable", reason: "git", message: "The Loom worktree at /x is on main, not loom/csv." }];
    await queue();
    expect(project()).toMatchObject({ state: "paused", system_reason: "The Loom worktree at /x is on main, not loom/csv." });
  });

  it("pauses when the bb project has no checkout on the host", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.bb.checkout = null;
    await queue();
    expect(project().state).toBe("paused");
    expect(project().system_reason).toContain("no checkout");
  });

  it("merges one ticket at a time, the oldest approved first, and never while paused", async () => {
    await seedProject(h, withDocsTicket);
    await reachApproved(h, "CSV-3");
    h.clock.advance(1000);
    await reachApproved(h, "CSV-1");
    h.store.setProjectState(project().id, "paused", "human");
    await queue();
    expect(ticketOf(h, "CSV-3").state).toBe("approved");

    h.store.setProjectState(project().id, "running", "human");
    await queue();
    expect([ticketOf(h, "CSV-3").state, ticketOf(h, "CSV-1").state]).toEqual(["done", "approved"]);
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(h.host.callsTo("merge").map((call) => call.ref)).toEqual([ticketOf(h, "CSV-3").head_sha, ticketOf(h, "CSV-1").head_sha]);
  });

  it("starts one merge when the queue runs twice at once", async () => {
    await seedProject(h);
    await reachApproved(h);
    void runMergeQueue(h.ctx, project(), spec());
    void runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);
    expect(h.host.callsTo("merge")).toHaveLength(1);
    expect(holdMerge(h.ctx, project().id)).not.toBeNull();
  });

  it("waits while a worker of the project is still being provisioned, then merges", async () => {
    await seedProject(h, withDocsTicket);
    await reachApproved(h, "CSV-1");
    h.bb.provisionEnvironment = false;
    const late = await startWorker(h, "CSV-3");
    expect(late.environment_id).toBeNull();

    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("approved");

    h.bb.threads.get(late.thread_id!)!.environmentId = "env_slow";
    h.bb.environments.set("env_slow", { path: "/wt/slow", branchName: "slow", hostId: "host_1", status: "provisioning" });
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("approved");

    h.bb.environments.get("env_slow")!.status = "ready";
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
  });

  it("waits while a worker row is still spawning", async () => {
    await seedProject(h, withDocsTicket);
    await reachApproved(h, "CSV-1");
    const spawning = h.store.addThread({ project_id: project().id, ticket_id: ticketOf(h, "CSV-3").id, role: "worker", state: "spawning", spawn_token: "tok" });
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("approved");
    h.store.updateThread(spawning.id, { state: "ended" });
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
  });

  it("runs a ticket left in merging by a restart again", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "merging", "loom");
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
  });

  it("ends the threads of a done ticket on the next pass if a crash cut that short", async () => {
    await seedProject(h);
    const worker = await reachApproved(h);
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "merging", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "done", "loom");
    await queue();
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "merged" });
  });

  it("does nothing for a ticket that is no longer merging", async () => {
    await seedProject(h);
    await reachApproved(h);
    await mergeTicket(h.ctx, project(), spec(), ticketOf(h, "CSV-1"));
    expect(h.host.callsTo("merge")).toEqual([]);
  });
});

describe("the integration merge on a multi-repo project", () => {
  const WEB = "/data/worktrees/csv.web";
  const API = "/data/worktrees/csv.api";
  const withRepoAfterMerge = (doc: Doc) => {
    doc.checks.after_merge = ["npm run e2e"];
    doc.repo[0].after_merge = ["npm run web-e2e"];
  };
  const withWebDocsTicket = (doc: Doc) =>
    doc.ticket.push({ ref: "web-docs", title: "Web docs", body: "Write the docs.", acceptance: ["WHEN the docs are built THE SYSTEM SHALL list the export"], scope: ["docs/**"], repo: "web" });

  it("merges each ticket into its own repo's integration branch, in the Loom worktree keyed <slug>.<name>, and runs that repo's after_merge", async () => {
    await seedRepoProject(h, withRepoAfterMerge);
    await reachApproved(h, "CSV-1");
    let mark = h.host.calls.length;
    await queue();

    expect(hostCallsSince(mark).map((call) => [call.hostId, call.method, call.input])).toEqual([
      ["host_1", "ensureWorktree", { repo: "/src/web", key: "csv.web", branch: "loom/csv" }],
      ["host_1", "worktreeState", { worktree: WEB, base: "main" }],
      ["host_1", "merge", { worktree: WEB, ref: ticketOf(h, "CSV-1").head_sha, message: "CSV-1: Order rows (Loom)", before: "base000" }],
      ["host_1", "exec", { cwd: WEB, command: "npm run web-e2e", timeoutMs: 15 * 60_000 }],
      ["host_1", "worktreeState", { worktree: WEB, base: "main", trackedOnly: true }],
    ]);
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(lastPost("merge").body).toBe('Merged m1 into loom/csv in the repo "web".');

    await reachApproved(h, "CSV-2");
    mark = h.host.calls.length;
    await queue();
    expect(hostCallsSince(mark).map((call) => [call.method, call.input])).toEqual([
      ["ensureWorktree", { repo: "/src/api", key: "csv.api", branch: "loom/csv" }],
      ["worktreeState", { worktree: API, base: "trunk" }],
      ["merge", { worktree: API, ref: ticketOf(h, "CSV-2").head_sha, message: "CSV-2: Export endpoint (Loom)", before: "base000" }],
      ["exec", { cwd: API, command: "npm run e2e", timeoutMs: 15 * 60_000 }],
      ["worktreeState", { worktree: API, base: "trunk", trackedOnly: true }],
    ]);
    expect(ticketOf(h, "CSV-2").state).toBe("done");
    expect(h.host.worktree(WEB).head).toBe("m1");
    expect(h.host.worktree(API).head).toBe("m2");
  });

  it("names the repo when the merge conflicts", async () => {
    await seedRepoProject(h);
    const worker = await reachApproved(h, "CSV-1");
    h.host.scripted.merge = [{ outcome: "conflict", files: ["src/model/a.ts"] }];
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(lastPost("merge").body).toBe('Merging into loom/csv in the repo "web" conflicted in: src/model/a.ts.');
    const sent = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(sent).toContain("git merge loom/csv`");
    expect(sent).toContain('the repo "web"');
  });

  it("names the repo when its after_merge check fails or changes the branch, and rolls back that repo's worktree", async () => {
    await seedRepoProject(h, withRepoAfterMerge);
    const worker = await reachApproved(h, "CSV-1");
    h.host.execResults = [{ exitCode: 1, output: "FAILED web-e2e" }];
    await queue();
    expect(h.host.callsTo("resetHard")).toEqual([{ worktree: WEB, sha: "base000" }]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    expect(lastPost("check").body).toContain('Checks after merging into loom/csv in the repo "web" failed.');
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain('the repo "web"');

    await reachApproved(h, "CSV-2");
    h.host.onExec = (_input, worktree) => void (worktree.head = "x1");
    await queue();
    expect(h.host.callsTo("resetHard").at(-1)).toEqual({ worktree: API, sha: "base000" });
    expect(lastPost("check", "CSV-2").body).toContain('Checks after merging into loom/csv in the repo "api" failed.');
    expect(lastPost("check", "CSV-2").body).toContain("changed the branch");
  });

  it("names the repo whose integration branch is checked out elsewhere, and pauses with the clone command for a repo without a checkout", async () => {
    await seedRepoProject(h);
    await reachApproved(h, "CSV-2");
    h.host.scripted.ensureWorktree = [{ outcome: "unavailable", reason: "branch_checked_out", message: "fatal: 'loom/csv' is already used by worktree at '/src/api'" }];
    await queue();
    expect(project()).toMatchObject({ state: "paused", system_reason: 'loom/csv in the repo "api" is checked out elsewhere; switch that checkout off it and resume' });

    h.store.setProjectState(project().id, "running", "human");
    h.bb.checkouts.set("proj_api", {});
    await queue();
    expect(project().state).toBe("paused");
    expect(project().system_reason).toBe(
      'Repo "api" (bb project proj_api) has no checkout on the machine host_1 that this Loom project uses. Clone it there with `bb project source add proj_api --clone --machine host_1`, then resume.',
    );
    expect(ticketOf(h, "CSV-2").state).toBe("merging");
  });

  it("merges an approved ticket of another repo while a worker's worktree in one repo is still being created", async () => {
    await seedRepoProject(h, withWebDocsTicket);
    await reachApproved(h, "CSV-1");
    h.clock.advance(1000);
    await reachApproved(h, "CSV-2");
    h.bb.provisionEnvironment = false;
    const late = await startWorker(h, "CSV-3");
    expect(ticketOf(h, "CSV-3").repo).toBe("web");

    await queue();
    expect([ticketOf(h, "CSV-1").state, ticketOf(h, "CSV-2").state]).toEqual(["approved", "done"]);
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("approved");

    h.bb.threads.get(late.thread_id!)!.environmentId = "env_slow";
    h.bb.environments.set("env_slow", { path: "/wt/slow", branchName: "slow", hostId: "host_1", status: "ready" });
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(h.host.callsTo("merge").map((call) => call.worktree)).toEqual([API, WEB]);
  });
});

describe("the pull request strategy", () => {
  const pr = (edit?: (doc: Doc) => void) => (doc: Doc) => {
    // Loom's template, the branch as it is, and no fix rounds: these tests cover pushing, opening and polling; test/pull-requests.test.ts covers the rest.
    doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0 };
    edit?.(doc);
  };

  it("pushes head_sha to the ticket's branch and opens one draft pull request with the ticket, criteria and review summary", async () => {
    await seedProject(h, pr());
    const worker = await reachApproved(h);
    const branch = ticketOf(h, "CSV-1").branch;
    const mark = h.host.calls.length;
    await queue();

    const [pushed, created] = hostCallsSince(mark);
    expect(pushed).toMatchObject({ method: "push", input: { repo: "/repo", remote: "origin", src: "c1", branch } });
    expect(created!.method).toBe("prCreate");
    const input = created!.input as { repo: string; remote: string; base: string; head: string; title: string; body: string; draft: boolean };
    expect(input).toMatchObject({ repo: "/repo", remote: "origin", base: "main", head: branch, title: "CSV-1: Order rows", draft: true });
    expect(input.body).toContain("Build the row mapper.");
    expect(input.body).toContain("1. WHEN an order is mapped THE SYSTEM SHALL return one row");
    expect(input.body).toContain("Looks good");
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pr_url: "https://github.com/acme/shop/pull/1", pr_checked_at: h.clock.t });
    expect(lastPost("merge").body).toContain("https://github.com/acme/shop/pull/1");
    expect(h.store.thread(worker.id)!.state).toBe("active");
    expect(mergeRuns().map((run) => [run.label, run.ok])).toEqual([
      ["git push", 1],
      ["open the pull request", 1],
    ]);
    expect(h.store.runOutput(mergeRuns()[1]!.id)).toBe("Opened https://github.com/acme/shop/pull/1.");
  });

  it("pushes and opens each ticket's pull request in that ticket's repo, with its remote and base, and reads both of one GitHub repository in one call", async () => {
    await seedRepoProject(h, pr());
    await reachApproved(h, "CSV-2");
    await queue();
    const apiBranch = ticketOf(h, "CSV-2").branch;
    expect(h.host.callsTo("push")).toEqual([{ repo: "/src/api", remote: "upstream", src: ticketOf(h, "CSV-2").head_sha, branch: apiBranch }]);
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ repo: "/src/api", remote: "upstream", base: "trunk", head: apiBranch, title: "CSV-2: Export endpoint" });
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "pr_open", pr_url: "https://github.com/acme/shop/pull/1" });

    await reachApproved(h, "CSV-1");
    await queue();
    expect(h.host.callsTo("push")[1]).toMatchObject({ repo: "/src/web", remote: "origin", branch: ticketOf(h, "CSV-1").branch });
    expect(h.host.callsTo("prCreate")[1]).toMatchObject({ repo: "/src/web", remote: "origin", base: "main" });

    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("prBatch")).toEqual([{ repo: "/src/web", host: "github.com", owner: "acme", name: "shop", numbers: [2, 1], feedback: false }]);
    expect(h.host.calls.filter((call) => call.method === "prBatch").every((call) => call.hostId === "host_1")).toBe(true);
    expect(h.host.callsTo("prState")).toEqual([]);
  });

  it("pauses when a ticket's repo has no checkout, and still polls the pull requests of the other repos", async () => {
    await seedRepoProject(h, pr());
    await reachApproved(h, "CSV-1");
    await reachApproved(h, "CSV-2");
    await queue();
    await queue();
    expect([ticketOf(h, "CSV-1").state, ticketOf(h, "CSV-2").state]).toEqual(["pr_open", "pr_open"]);
    h.host.prStates.set(ticketOf(h, "CSV-2").pr_url!, "MERGED");
    h.bb.checkouts.set("proj_web", {});
    h.clock.advance(5 * 60_000);
    const checked = ticketOf(h, "CSV-1").pr_checked_at;
    await pollPullRequests(h.ctx, project());

    expect(project()).toMatchObject({ state: "paused", system_reason: expect.stringContaining('Repo "web" (bb project proj_web) has no checkout') });
    expect(h.host.callsTo("prBatch")).toEqual([{ repo: "/src/api", host: "github.com", owner: "acme", name: "shop", numbers: [2], feedback: false }]);
    expect(ticketOf(h, "CSV-2").state).toBe("done");
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pr_checked_at: checked });
  });

  it("pauses with the clone command when the ticket's repo has no checkout to push from", async () => {
    await seedRepoProject(h, pr());
    await reachApproved(h, "CSV-2");
    h.bb.checkouts.set("proj_api", {});
    await queue();
    expect(project()).toMatchObject({ state: "paused", system_reason: expect.stringContaining("`bb project source add proj_api --clone --machine host_1`") });
    expect(ticketOf(h, "CSV-2").state).toBe("merging");
    expect(h.host.callsTo("push")).toEqual([]);
  });

  it("opens a ready pull request when merge.draft is false", async () => {
    await seedProject(h, pr((doc) => (doc.merge = { strategy: "pr", draft: false, remote: "upstream", describe: "loom", squash: false, max_fix_rounds: 0 })));
    await reachApproved(h);
    await queue();
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ remote: "upstream", draft: false });
    expect(h.host.callsTo("push")[0]).toMatchObject({ remote: "upstream" });
  });

  it("pauses with the host's message when the push or gh is unavailable, and opens the pull request after resume", async () => {
    await seedProject(h, pr());
    await reachApproved(h);
    h.host.scripted.push = [{ outcome: "unavailable", message: "git push to origin failed: no route to host" }];
    await queue();
    expect(project()).toMatchObject({ state: "paused", system_reason: "git push to origin failed: no route to host" });
    expect(ticketOf(h, "CSV-1").state).toBe("merging");
    expect(mergeRuns().map((run) => [run.label, run.ok])).toEqual([["git push", 0]]);

    h.store.setProjectState(project().id, "running", "human");
    h.host.scripted.prCreate = [{ outcome: "unavailable", message: "The gh CLI is not installed on this machine, or it is not on PATH." }];
    await queue();
    expect(project()).toMatchObject({ state: "paused", system_reason: expect.stringContaining("gh CLI") });

    h.store.setProjectState(project().id, "running", "human");
    await queue();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open" });
    expect(h.host.callsTo("push")).toHaveLength(3);
  });

  it("keeps the url that gh returned for a pull request that already existed", async () => {
    await seedProject(h, pr());
    await reachApproved(h);
    h.host.scripted.prCreate = [{ outcome: "ok", url: "https://github.com/acme/shop/pull/42" }];
    await queue();
    expect(ticketOf(h, "CSV-1").pr_url).toBe("https://github.com/acme/shop/pull/42");
  });

  it("polls an open pull request at most every 5 minutes", async () => {
    await seedProject(h, pr());
    await reachApproved(h);
    await queue();
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("prBatch")).toEqual([]);

    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("prBatch")).toEqual([{ repo: "/repo", host: "github.com", owner: "acme", name: "shop", numbers: [1], feedback: false }]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pr_checked_at: h.clock.t });
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("prBatch")).toHaveLength(1);
  });

  it("completes the ticket when the pull request is merged, and ends its threads", async () => {
    await seedProject(h, pr());
    const worker = await reachApproved(h);
    await queue();
    h.host.prStates.set("https://github.com/acme/shop/pull/1", "MERGED");
    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    await settleMerges(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "merged" });
    expect(lastPost("merge").body).toContain("merged");
  });

  it("blocks the ticket, flags triage and ends its worker when the pull request is closed", async () => {
    await seedProject(h, pr());
    const worker = await reachApproved(h);
    await queue();
    h.host.prStates.set("https://github.com/acme/shop/pull/1", "CLOSED");
    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "the pull request was closed without merging" });
    expect(project().triage_pending).toBe(1);
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "blocked" });
  });

  describe("an answer that arrives after the ticket moved on", () => {
    const hold = () => {
      const answer = deferred<"OPEN" | "MERGED" | "CLOSED">();
      const reached = deferred<void>();
      const original = h.host.call.bind(h.host);
      h.host.call = (async (hostId: string, method: string, input: unknown) => {
        if (method !== "prBatch") return original(hostId, method as "push", input as never);
        reached.resolve();
        const state = await answer.promise;
        return { outcome: "ok", pulls: [{ number: 1, state, draft: false, review: null, base: "main", feedback: null }], missing: [] } satisfies HostOutput<"prBatch">;
      }) as typeof h.host.call;
      return { gate: { resolve: (read: { outcome: "ok"; state: "OPEN" | "MERGED" | "CLOSED" }) => answer.resolve(read.state) }, reached };
    };
    const pollOpen = async () => {
      await seedProject(h, pr());
      await reachApproved(h);
      await queue();
      h.clock.advance(5 * 60_000);
      const { gate, reached } = hold();
      const polling = pollPullRequests(h.ctx, project());
      await reached.promise;
      return { gate, polling };
    };

    it("does not block a ticket that was blocked and requeued during the host call", async () => {
      const { gate, polling } = await pollOpen();
      await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "replace this PR", needs: "", actor: "human" });
      await requeueTicket(h.ctx, "CSV-1", { note: "try again", actor: "human", author: "human" });
      expect(ticketOf(h, "CSV-1").state).toBe("queued");
      const triage = project().triage_pending;

      gate.resolve({ outcome: "ok", state: "CLOSED" });
      await polling;
      expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", blocked_reason: null });
      expect(posts().filter((post) => post.kind === "block").map((post) => post.body)).toEqual(["replace this PR"]);
      expect(project().triage_pending).toBe(triage);
    });

    it.each([
      ["CLOSED", { pr_url: "https://github.com/acme/shop/pull/9" }],
      ["CLOSED", { attempt: 5 }],
      ["MERGED", { pr_url: "https://github.com/acme/shop/pull/9" }],
      ["MERGED", { attempt: 5 }],
    ] as const)("ignores a %s answer when the ticket now has another pull request or attempt (%o)", async (answer, change) => {
      const { gate, polling } = await pollOpen();
      h.store.updateTicket(ticketOf(h, "CSV-1").id, change);
      gate.resolve({ outcome: "ok", state: answer });
      await polling;
      expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", blocked_reason: null });
      expect(posts().filter((post) => post.kind === "block")).toEqual([]);
    });

    it("moves a closed pull request's ticket to blocked before it ends the worker, so nothing can slip in between", async () => {
      const { gate, polling } = await pollOpen();
      const worker = h.store.threads({ ticketId: ticketOf(h, "CSV-1").id, role: "worker" })[0]!;
      h.bb.stopConfirms = false;
      gate.resolve({ outcome: "ok", state: "CLOSED" });
      await polling;
      expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "the pull request was closed without merging", worker_thread_id: null, environment_id: null });
      expect(project().triage_pending).toBe(1);
      expect(h.store.thread(worker.id)!.state).toBe("ending");
    });

    it("ends the threads left on a blocked ticket by a crash after the move", async () => {
      await seedProject(h, pr());
      const worker = await reachApproved(h);
      await queue();
      h.store.setTicketState(ticketOf(h, "CSV-1").id, "blocked", "loom");
      await queue();
      expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "blocked" });
    });
  });

  it("pauses the project when gh fails to read the pull request for a reason waiting does not fix, and tries again in 5 minutes", async () => {
    await seedProject(h, pr());
    await reachApproved(h);
    await queue();
    h.host.scripted.prBatch = [{ outcome: "unavailable", message: "gh api graphql failed: HTTP 401: Bad credentials" }];
    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(project()).toMatchObject({ state: "paused", system_reason: "gh api graphql failed: HTTP 401: Bad credentials" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pr_checked_at: h.clock.t, pr_poll_json: null });
    expect(h.host.callsTo("prBatch")).toHaveLength(1);
  });

  describe("when GitHub fails to answer a read", () => {
    const BAD_GATEWAY = { outcome: "unavailable", message: "gh api graphql failed: gh: HTTP 502", transient: "server" } as const;
    const RATE_LIMITED = { outcome: "unavailable", message: "gh api graphql failed: GraphQL: API rate limit exceeded for user ID 1234567.", transient: "rate_limit" } as const;
    const MINUTE = 60_000;
    /** The pull requests of each GitHub read, one entry per call. */
    const calls = () => h.host.callsTo("prBatch").map((input) => input.numbers.map((number) => `https://${input.host}/${input.owner}/${input.name}/pull/${number}`));
    const reads = () => calls().flat();
    const pollIn = async (minutes: number, of = project()) => {
      h.clock.advance(minutes * MINUTE);
      await pollPullRequests(h.ctx, of);
    };
    const waitOf = (key = "CSV-1") => JSON.parse(ticketOf(h, key).pr_poll_json ?? "null") as { failures: number; since: number; message: string } | null;
    const systemPosts = (key = "CSV-1") => posts(key).filter((post) => post.kind === "system").map((post) => post.body);
    const openOne = async () => {
      await seedProject(h, pr());
      await reachApproved(h);
      await queue();
    };
    /** CSV-1's pull request is /pull/2 and CSV-2's /pull/1, both on github.com. */
    const openTwo = async () => {
      await seedRepoProject(h, pr());
      await reachApproved(h, "CSV-2");
      await queue();
      await reachApproved(h, "CSV-1");
      await queue();
    };
    /** Another running project on the same forge host, with one open pull request that is due. */
    const otherProject = async () => {
      h.bb.addThread("thr_plan2", "idle");
      const toml = specToml((doc) => {
        doc.project = { slug: "inv", name: "Invoices", key: "INV", goal: "Send each customer an invoice by email.", summary: "Send each customer an invoice by email." };
        pr()(doc);
      });
      await h.projects.propose({ toml, threadId: "thr_plan2", bbProjectId: "proj_1", hostId: "host_1" });
      await h.projects.approve("inv", "human");
      const other = h.store.projectBySlug("inv")!;
      h.store.setProjectState(other.id, "running", "human");
      h.store.updateTicket(ticketOf(h, "INV-1").id, { state: "pr_open", pr_url: "https://github.com/acme/billing/pull/9", pr_checked_at: null });
      return () => h.store.projectBySlug("inv")!;
    };

    it("does not pause on a server error: each failure makes the next read wait longer, 5, 10, 20, then 30 minutes", async () => {
      await openOne();
      h.host.scripted.prBatch = Array.from({ length: 4 }, () => BAD_GATEWAY);
      await pollIn(5);
      const first = h.clock.t;
      expect(project().state).toBe("running");
      expect(waitOf()).toEqual({ failures: 1, since: first, message: BAD_GATEWAY.message });
      expect(systemPosts()).toEqual([
        "Reading the pull request failed with what looks like a temporary GitHub error: gh api graphql failed: gh: HTTP 502. Loom reads it again in 5m, waiting longer after each failure up to 30m, and pauses the project only if the reads keep failing for 1h.",
      ]);

      const expected: Array<[number, number]> = [
        [4, 1],
        [1, 2],
        [9, 2],
        [1, 3],
        [19, 3],
        [1, 4],
        [29, 4],
      ];
      for (const [minutes, count] of expected) {
        await pollIn(minutes);
        expect(reads(), `after ${minutes} more minutes`).toHaveLength(count);
      }
      expect(project().state).toBe("running");
      expect(waitOf()).toMatchObject({ failures: 4, since: first });
      expect(systemPosts()).toHaveLength(1);
      expect(h.bb.calls.filter((call) => call.method === "log" && String(call.args[1]).includes("failed 4 times in a row"))).toHaveLength(1);
    });

    it("pauses the project once the reads have failed for an hour, naming the pull request, the error and how long", async () => {
      await openOne();
      h.host.scripted.prBatch = Array.from({ length: 5 }, () => BAD_GATEWAY);
      for (const minutes of [5, 5, 10, 20, 30]) await pollIn(minutes);
      expect(reads()).toHaveLength(5);
      expect(project()).toMatchObject({
        state: "paused",
        system_reason: "Reading the pull request https://github.com/acme/shop/pull/1 of CSV-1 failed 5 times in a row over 1h 5m: gh api graphql failed: gh: HTTP 502. Resume once GitHub answers again.",
        triage_pending: 1,
      });
      expect(ticketOf(h, "CSV-1").state).toBe("pr_open");
    });

    it("clears the wait on the next read that succeeds, so the one after comes 5 minutes later and a new failure starts over", async () => {
      await openOne();
      h.host.scripted.prBatch = [BAD_GATEWAY, BAD_GATEWAY];
      await pollIn(5);
      await pollIn(5);
      await pollIn(10);
      expect(reads()).toHaveLength(3);
      expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pr_poll_json: null });
      await pollIn(5);
      expect(reads()).toHaveLength(4);

      h.host.scripted.prBatch = [BAD_GATEWAY];
      await pollIn(5);
      expect(waitOf()).toEqual({ failures: 1, since: h.clock.t, message: BAD_GATEWAY.message });
      expect(systemPosts()).toHaveLength(2);
    });

    it("stops every read to the host for 15 minutes after a rate limit, in every project, without pausing", async () => {
      await openTwo();
      const other = await otherProject();
      h.host.scripted.prBatch = [RATE_LIMITED];
      await pollIn(5);
      // Both pull requests of acme/shop go in one call, so one rate limit covers them both and posts once, on the first.
      expect(calls()).toEqual([["https://github.com/acme/shop/pull/2", "https://github.com/acme/shop/pull/1"]]);
      expect(project().state).toBe("running");
      expect(h.ctx.forgeBackoffs.get("github.com")).toEqual({ until: h.clock.t + 15 * MINUTE, delayMs: 15 * MINUTE, message: RATE_LIMITED.message });
      expect(systemPosts("CSV-1")).toEqual([
        "GitHub rate-limited Loom's read of the pull request: gh api graphql failed: GraphQL: API rate limit exceeded for user ID 1234567. Loom reads no pull request on github.com, in any project, for 15m, and does not pause the project.",
      ]);
      expect(systemPosts("CSV-2")).toEqual([]);

      await pollPullRequests(h.ctx, other());
      await pollIn(5);
      await pollIn(5, other());
      await pollIn(4);
      expect(calls()).toHaveLength(1);
      expect(other().state).toBe("running");

      await pollIn(1);
      expect(calls()).toEqual([
        ["https://github.com/acme/shop/pull/2", "https://github.com/acme/shop/pull/1"],
        ["https://github.com/acme/shop/pull/2", "https://github.com/acme/shop/pull/1"],
      ]);
      expect(h.ctx.forgeBackoffs.has("github.com")).toBe(false);
      await pollPullRequests(h.ctx, other());
      expect(calls().at(-1)).toEqual(["https://github.com/acme/billing/pull/9"]);
      expect(systemPosts("CSV-1")).toHaveLength(1);
    });

    it("waits out a server error GitHub gave for one pull request of an answer, and keeps a rate limit's backoff after the others read fine", async () => {
      await openTwo();
      const ok = { number: 2, state: "OPEN", draft: false, review: null, base: "main", feedback: null } as const;
      h.host.scripted.prBatch = [{ outcome: "ok", pulls: [ok], missing: [{ number: 1, message: "GitHub did not answer for pull request #1 in acme/shop: Something went wrong", transient: "server" }] }];
      await pollIn(5);
      expect(project().state).toBe("running");
      expect(waitOf("CSV-2")).toMatchObject({ failures: 1 });
      expect(waitOf("CSV-1")).toBeNull();

      h.host.scripted.prBatch = [{ outcome: "ok", pulls: [ok], missing: [{ number: 1, message: "API rate limit exceeded", transient: "rate_limit" }] }];
      await pollIn(10);
      expect(project().state).toBe("running");
      expect(h.ctx.forgeBackoffs.get("github.com")).toMatchObject({ until: h.clock.t + 15 * MINUTE });
    });

    it("backs off once for an answer that rate-limited several pull requests, with the longest wait GitHub named", async () => {
      await openTwo();
      h.host.scripted.prBatch = [
        {
          outcome: "ok",
          pulls: [],
          missing: [
            { number: 2, message: "API rate limit exceeded", transient: "rate_limit" },
            { number: 1, message: "API rate limit exceeded", transient: "rate_limit", retryAfterMs: 20 * MINUTE },
          ],
        },
      ];
      await pollIn(5);
      expect(h.ctx.forgeBackoffs.get("github.com")).toMatchObject({ delayMs: 15 * MINUTE, until: h.clock.t + 20 * MINUTE });
      expect([...systemPosts("CSV-1"), ...systemPosts("CSV-2")]).toHaveLength(1);
      expect(project().state).toBe("running");
    });

    it("makes each pull request of a read that hit a server error wait out its own failures", async () => {
      await openTwo();
      h.host.scripted.prBatch = [BAD_GATEWAY];
      await pollIn(5);
      expect(project().state).toBe("running");
      expect([waitOf("CSV-1"), waitOf("CSV-2")]).toEqual([
        { failures: 1, since: h.clock.t, message: BAD_GATEWAY.message },
        { failures: 1, since: h.clock.t, message: BAD_GATEWAY.message },
      ]);
      expect([systemPosts("CSV-1"), systemPosts("CSV-2")].map((each) => each.length)).toEqual([1, 1]);
    });

    it("doubles the backoff to at most an hour while the limits go on, and waits until the time GitHub names", async () => {
      await openOne();
      h.host.scripted.prBatch = [RATE_LIMITED, RATE_LIMITED, RATE_LIMITED, RATE_LIMITED];
      const delays: number[] = [];
      for (const minutes of [5, 15, 30, 60]) {
        await pollIn(minutes);
        delays.push(h.ctx.forgeBackoffs.get("github.com")!.delayMs / MINUTE);
      }
      expect(delays).toEqual([15, 30, 60, 60]);
      expect(reads()).toHaveLength(4);
      expect(project().state).toBe("running");
      expect(systemPosts()).toHaveLength(4);

      await pollIn(60);
      expect(h.ctx.forgeBackoffs.has("github.com")).toBe(false);
      h.host.scripted.prBatch = [{ ...RATE_LIMITED, retryAfterMs: 40 * MINUTE }];
      await pollIn(5);
      expect(h.ctx.forgeBackoffs.get("github.com")).toMatchObject({ until: h.clock.t + 40 * MINUTE, delayMs: 15 * MINUTE });
      await pollIn(39);
      expect(reads()).toHaveLength(6);
      await pollIn(1);
      expect(reads()).toHaveLength(7);
    });
  });

  it("polls a paused project too", async () => {
    await seedProject(h, pr());
    await reachApproved(h);
    await queue();
    h.store.setProjectState(project().id, "paused", "human");
    h.host.prStates.set("https://github.com/acme/shop/pull/1", "MERGED");
    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(ticketOf(h, "CSV-1").state).toBe("done");
  });
});

describe("reading open pull requests in batches", () => {
  const pr = (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0 });
  /** CSV-1 to CSV-n, none depending on another. */
  const withTickets = (n: number) => (doc: Doc) => {
    pr(doc);
    doc.ticket[1].depends_on = [];
    for (let index = 3; index <= n; index += 1) doc.ticket.push({ ref: `csv-part-${index}`, title: `Part ${index}`, body: "Build it.", acceptance: ["WHEN it runs THE SYSTEM SHALL work"], scope: [`src/part${index}/**`] });
  };
  const seq = (key: string) => Number(key.split("-")[1]);
  /** Every ticket's pull request is open, due, at the URL `url` gives for its number. */
  const openAll = (url: (n: number) => string) => {
    for (const ticket of h.store.tickets(project().id)) {
      for (const to of ["working", "checking", "review", "approved", "merging", "pr_open"] as const) h.store.setTicketState(ticket.id, to, "loom");
      h.store.updateTicket(ticket.id, { pr_url: url(seq(ticket.key)), pr_branch: `loom/csv/${ticket.key.toLowerCase()}`, pushed_sha: `sq${seq(ticket.key)}`, pr_checked_at: null });
    }
  };
  const meta = (key: string) => JSON.parse(ticketOf(h, key).pr_meta_json!) as Record<string, unknown>;

  it("reads 12 pull requests of one GitHub repository in two calls of 10 and 2, and stores what it read on each ticket", async () => {
    await seedProject(h, withTickets(12));
    openAll((n) => `https://github.com/acme/shop/pull/${100 + n}`);
    h.host.prMeta.set("https://github.com/acme/shop/pull/103", { draft: true, review: "APPROVED", base: "main" });
    await pollPullRequests(h.ctx, project());

    expect(h.host.calls.map((call) => call.method)).toEqual(["prBatch", "prBatch"]);
    expect(h.host.callsTo("prBatch")).toEqual([
      { repo: "/repo", host: "github.com", owner: "acme", name: "shop", numbers: [101, 102, 103, 104, 105, 106, 107, 108, 109, 110], feedback: false },
      { repo: "/repo", host: "github.com", owner: "acme", name: "shop", numbers: [111, 112], feedback: false },
    ]);
    expect(meta("CSV-3")).toEqual({ at: h.clock.t, draft: true, review: "APPROVED", base: "main", state: "OPEN" });
    expect(meta("CSV-12")).toEqual({ at: h.clock.t, draft: false, review: null, base: null, state: "OPEN" });
    expect(h.store.tickets(project().id).every((ticket) => ticket.state === "pr_open" && ticket.pr_checked_at === h.clock.t)).toBe(true);
  });

  it("makes one call per GitHub repository: 12 pull requests in 4 repositories take 4 calls", async () => {
    await seedProject(h, withTickets(12));
    openAll((n) => `https://github.com/acme/repo${n % 4}/pull/${n}`);
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("prBatch").map((call) => `${call.owner}/${call.name}: ${call.numbers.join(",")}`)).toEqual(["acme/repo1: 1,5,9", "acme/repo2: 2,6,10", "acme/repo3: 3,7,11", "acme/repo0: 4,8,12"]);
    expect(h.host.calls).toHaveLength(4);
  });

  it("settles each pull request of a call on its own: merged, closed, missing and open", async () => {
    await seedProject(h, withTickets(4));
    openAll((n) => `https://github.com/acme/shop/pull/${n}`);
    h.host.prStates.set("https://github.com/acme/shop/pull/1", "MERGED");
    h.host.prStates.set("https://github.com/acme/shop/pull/2", "CLOSED");
    h.host.missingPrs.add("https://github.com/acme/shop/pull/3");
    await pollPullRequests(h.ctx, project());

    expect(h.host.callsTo("prBatch")).toHaveLength(1);
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(meta("CSV-1")).toMatchObject({ state: "MERGED" });
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "blocked", blocked_reason: "the pull request was closed without merging" });
    expect(meta("CSV-2")).toMatchObject({ state: "CLOSED" });
    expect(ticketOf(h, "CSV-3")).toMatchObject({ state: "pr_open", pr_meta_json: null });
    expect(project()).toMatchObject({ state: "paused", system_reason: "Reading the pull request of CSV-3 stopped: gh found no pull request #3 in acme/shop: Could not resolve to a PullRequest with the number of 3." });
    expect(ticketOf(h, "CSV-4").state).toBe("pr_open");
    expect(meta("CSV-4")).toMatchObject({ state: "OPEN" });
  });

  it("pauses with the error when the call fails, and settles none of its pull requests", async () => {
    await seedProject(h, withTickets(2));
    openAll((n) => `https://github.com/acme/shop/pull/${n}`);
    h.host.prStates.set("https://github.com/acme/shop/pull/1", "MERGED");
    h.host.scripted.prBatch = [new Error("host disconnected")];
    await pollPullRequests(h.ctx, project());
    expect(project()).toMatchObject({ state: "paused", system_reason: "Reading the pull requests of CSV-1 and CSV-2 stopped: host disconnected" });
    expect(h.store.tickets(project().id).map((ticket) => [ticket.state, ticket.pr_meta_json, ticket.pr_checked_at])).toEqual([
      ["pr_open", null, h.clock.t],
      ["pr_open", null, h.clock.t],
    ]);
  });

  it("pauses on a gh forge's pull request URL that is not GitHub's, and still reads the others", async () => {
    await seedProject(h, withTickets(2));
    openAll((n) => (n === 1 ? "https://review.example.com/shop/1" : `https://github.com/acme/shop/pull/${n}`));
    await pollPullRequests(h.ctx, project());
    expect(project()).toMatchObject({ state: "paused", system_reason: "CSV-1's pull request https://review.example.com/shop/1 is not a GitHub pull request URL, so gh cannot read it." });
    expect(h.host.callsTo("prBatch")).toEqual([expect.objectContaining({ numbers: [2] })]);
  });

  it("reads a command forge's pull requests one at a time, and stores no draft flag, review or base for its state command", async () => {
    await seedProject(h, (doc) => {
      withTickets(2)(doc);
      doc.merge.forge = { kind: "command", open: "review open", state: "review state" };
    });
    openAll((n) => `https://review.example.com/shop/${n}`);
    h.host.prStates.set("https://review.example.com/shop/2", "MERGED");
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("prState").map((call) => call.url)).toEqual(["https://review.example.com/shop/1", "https://review.example.com/shop/2"]);
    expect(h.host.callsTo("prBatch")).toEqual([]);
    expect(meta("CSV-1")).toEqual({ at: h.clock.t, draft: null, review: null, base: null, state: "OPEN" });
    expect(ticketOf(h, "CSV-2").state).toBe("done");
  });
});

describe("finishIfComplete", () => {
  it("moves a running or paused pull request project to done once every ticket is done or cancelled", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0 }));
    expect(finishIfComplete(h.ctx, project())).toBe(false);
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "cancelled", "human");
    expect(finishIfComplete(h.ctx, project())).toBe(false);
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "cancelled", "human");
    h.store.setProjectState(project().id, "paused", "human");
    expect(finishIfComplete(h.ctx, project())).toBe(true);
    expect(project().state).toBe("done");
    expect(finishIfComplete(h.ctx, project())).toBe(false);
  });

  it("leaves an integration project for land to finish", async () => {
    await seedProject(h);
    for (const key of ["CSV-1", "CSV-2"]) h.store.setTicketState(ticketOf(h, key).id, "cancelled", "human");
    expect(finishIfComplete(h.ctx, project())).toBe(false);
    expect(project().state).toBe("running");
  });
});

describe("land", () => {
  const mergeOne = async (key: string) => {
    await reachApproved(h, key);
    await queue();
    expect(ticketOf(h, key).state).toBe("done");
  };
  const landArgs = { actor: "human", ready: false };

  it("pushes the integration branch's sha and opens one draft pull request with the goal and the done tickets, then stores its url", async () => {
    await seedProject(h, withDocsTicket);
    await mergeOne("CSV-1");
    const mark = h.host.calls.length;
    const result = await land(h.ctx, "csv", landArgs);

    expect(result).toEqual({ url: "https://github.com/acme/shop/pull/1", done: false });
    const [ensured, state, pushed, created] = hostCallsSince(mark);
    expect(ensured).toMatchObject({ method: "ensureWorktree", input: { repo: "/repo", key: "csv", branch: "loom/csv" } });
    expect(state).toMatchObject({ method: "worktreeState", input: { worktree: WORKTREE, base: "main" } });
    expect(pushed).toMatchObject({ method: "push", input: { repo: "/repo", remote: "origin", src: "m1", branch: "loom/csv" } });
    const input = created!.input as { base: string; head: string; title: string; body: string; draft: boolean };
    expect(input).toMatchObject({ base: "main", head: "loom/csv", title: "CSV export", draft: true });
    expect(input.body).toContain("Let people export their orders as a CSV file");
    expect(input.body).toContain("- CSV-1 Order rows");
    expect(input.body).not.toContain("CSV-2");
    expect(project().pr_url).toBe("https://github.com/acme/shop/pull/1");
    expect(h.store.events(project().id).filter((event) => event.kind === "project.landed").map((event) => [event.actor, JSON.parse(event.data_json)])).toEqual([
      ["human", expect.objectContaining({ url: "https://github.com/acme/shop/pull/1", sha: "m1", created: true })],
    ]);
  });

  it("only pushes the new commits on a second run, and honours --title and --ready on the first", async () => {
    await seedProject(h, withDocsTicket);
    await mergeOne("CSV-1");
    await land(h.ctx, "csv", { actor: "human", ready: true, title: "Export orders as CSV" });
    expect(h.host.callsTo("prCreate")).toHaveLength(1);
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ title: "Export orders as CSV", draft: false });

    await mergeOne("CSV-3");
    const again = await land(h.ctx, "csv", landArgs);
    expect(again).toMatchObject({ url: "https://github.com/acme/shop/pull/1" });
    expect(h.host.callsTo("prCreate")).toHaveLength(1);
    expect(h.host.callsTo("push").map((call) => call.src)).toEqual(["m1", "m2"]);
  });

  it("pushes the sha it read while it held the merge guard, so no merge can move the branch in between", async () => {
    await seedProject(h);
    await mergeOne("CSV-1");
    let guardedDuringPush: boolean | null = null;
    const call = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: unknown) => {
      if (method === "push") guardedDuringPush = holdMerge(h.ctx, project().id) === null;
      return call(hostId, method as never, input as never);
    }) as typeof h.host.call;
    await land(h.ctx, "csv", landArgs);
    expect(guardedDuringPush).toBe(true);
    expect(holdMerge(h.ctx, project().id)).not.toBeNull();
  });

  it("moves the project to done when every ticket is done or cancelled", async () => {
    await seedProject(h);
    await mergeOne("CSV-1");
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "cancelled", "human");
    expect(await land(h.ctx, "csv", landArgs)).toMatchObject({ done: true });
    expect(project().state).toBe("done");
  });

  it("is refused while a ticket is merging, while a merge holds the guard, with no done ticket, and on the pull request strategy", async () => {
    await seedProject(h, withDocsTicket);
    await expect(land(h.ctx, "csv", landArgs)).rejects.toThrow(/no ticket is done yet/);
    await mergeOne("CSV-1");
    await reachApproved(h, "CSV-3");
    h.store.setTicketState(ticketOf(h, "CSV-3").id, "merging", "loom");
    await expect(land(h.ctx, "csv", landArgs)).rejects.toThrow(/a ticket is merging/);
    h.store.setTicketState(ticketOf(h, "CSV-3").id, "done", "loom");

    const release = holdMerge(h.ctx, project().id)!;
    await expect(land(h.ctx, "csv", landArgs)).rejects.toThrow(/a merge is running/);
    release();
    await expect(land(h.ctx, "nope", landArgs)).rejects.toThrow(/No Loom project/);

    const other = makeCtx();
    await seedProject(other, (doc) => (doc.merge = { strategy: "pr" }));
    await expect(land(other.ctx, "csv", landArgs)).rejects.toThrow(/pull request per ticket/);
  });

  it("reports the host's message when the push or the pull request is unavailable, and keeps the project's url empty", async () => {
    await seedProject(h);
    await mergeOne("CSV-1");
    h.host.scripted.push = [{ outcome: "unavailable", message: "git push to origin failed: rejected" }];
    await expect(land(h.ctx, "csv", landArgs)).rejects.toThrow("git push to origin failed: rejected");
    h.host.scripted.prCreate = [{ outcome: "unavailable", message: "The gh CLI is not installed on this machine, or it is not on PATH." }];
    await expect(land(h.ctx, "csv", landArgs)).rejects.toThrow(/gh CLI/);
    expect(project().pr_url).toBeNull();
    expect(holdMerge(h.ctx, project().id)).not.toBeNull();
  });

  describe("--direct", () => {
    const direct = { ...landArgs, direct: true };
    const landed = () => h.store.events(project().id).filter((event) => event.kind === "project.landed").map((event) => JSON.parse(event.data_json));
    const guardFree = () => {
      const release = holdMerge(h.ctx, project().id);
      release?.();
      return release !== null;
    };

    it("fetches the base branch, runs after_merge and pushes the integration branch's head to the base branch, with no pull request", async () => {
      await seedProject(h, withAfterMerge);
      await mergeOne("CSV-1");
      const mark = h.host.calls.length;
      const result = await land(h.ctx, "csv", direct);

      expect(result).toEqual({ url: null, pushed: "origin/main", sha: "m1", done: false });
      expect(hostCallsSince(mark).map((call) => call.method)).toEqual(["ensureWorktree", "fetchBranch", "merge", "exec", "worktreeState", "push"]);
      expect(h.host.callsTo("fetchBranch")).toEqual([{ worktree: WORKTREE, remote: "origin", branch: "main" }]);
      expect(h.host.callsTo("exec").at(-1)).toMatchObject({ cwd: WORKTREE, command: "npm run e2e" });
      expect(h.host.callsTo("worktreeState").at(-1)).toEqual({ worktree: WORKTREE, base: "main", trackedOnly: true });
      expect(h.host.callsTo("push")).toEqual([{ repo: "/repo", remote: "origin", src: "m1", branch: "main" }]);
      expect(h.host.callsTo("prCreate")).toEqual([]);
      expect(project().pr_url).toBeNull();
      expect(landed()).toEqual([{ direct: true, pushed: "origin/main", sha: "m1" }]);
      expect(guardFree()).toBe(true);
    });

    it("merges a base branch that moved, checks the merge and pushes it, and finishes a project whose tickets are all done or cancelled", async () => {
      await seedProject(h, withAfterMerge);
      await mergeOne("CSV-1");
      h.store.setTicketState(ticketOf(h, "CSV-2").id, "cancelled", "human");
      h.host.remoteBase = "up1";
      const mark = h.host.calls.length;
      const result = await land(h.ctx, "csv", direct);

      expect(result).toEqual({ url: null, pushed: "origin/main", sha: "m2", done: true });
      expect(hostCallsSince(mark).find((call) => call.method === "merge")!.input).toEqual({ worktree: WORKTREE, ref: "up1", message: "Merge origin/main into loom/csv (Loom)" });
      expect(hostCallsSince(mark).map((call) => call.method)).toEqual(["ensureWorktree", "fetchBranch", "merge", "exec", "worktreeState", "push"]);
      expect(h.host.callsTo("push").at(-1)).toMatchObject({ src: "m2", branch: "main" });
      expect(project().state).toBe("done");
    });

    it("waits while a worker's worktree is still being created from the integration branch", async () => {
      await seedProject(h, withDocsTicket);
      await mergeOne("CSV-1");
      h.store.addThread({ project_id: project().id, ticket_id: ticketOf(h, "CSV-3").id, role: "worker", state: "spawning", spawn_token: "tok" });
      const merges = h.host.callsTo("merge").length;
      await expect(land(h.ctx, "csv", direct)).rejects.toThrow("Cannot land yet: a worker's worktree is still being created from loom/csv; try again in a moment.");
      expect(h.host.callsTo("merge")).toHaveLength(merges);
      expect(h.host.callsTo("push")).toEqual([]);
      expect(guardFree()).toBe(true);
    });

    it("refuses a base branch that conflicts, naming the files", async () => {
      await seedProject(h, withAfterMerge);
      await mergeOne("CSV-1");
      h.host.scripted.merge = [{ outcome: "conflict", files: ["src/a.ts"] }];
      await expect(land(h.ctx, "csv", direct)).rejects.toThrow("Cannot land on origin/main: it conflicts with loom/csv in src/a.ts.");
      expect(h.host.callsTo("push")).toEqual([]);
      expect(landed()).toEqual([]);
      expect(guardFree()).toBe(true);
    });

    it("refuses when an after_merge check fails on the merge, and resets the integration branch", async () => {
      await seedProject(h, withAfterMerge);
      await mergeOne("CSV-1");
      h.host.remoteBase = "up1";
      h.host.execResults = [{ exitCode: 1, output: "1 test failed" }];
      const refused = land(h.ctx, "csv", direct);
      await expect(refused).rejects.toThrow("Cannot land on origin/main: npm run e2e failed (exit 1). Nothing was pushed, and loom/csv is back at m1.");
      await expect(refused).rejects.toThrow("1 test failed");
      expect(h.host.callsTo("resetHard").at(-1)).toEqual({ worktree: WORKTREE, sha: "m1" });
      expect(h.host.worktree(WORKTREE).head).toBe("m1");
      expect(h.host.callsTo("push")).toEqual([]);
      expect(landed()).toEqual([]);
      expect(guardFree()).toBe(true);
    });

    it("refuses when a check that passed moved the integration branch", async () => {
      await seedProject(h, withAfterMerge);
      await mergeOne("CSV-1");
      h.host.onExec = (_input, worktree) => void (worktree.head = "x9");
      await expect(land(h.ctx, "csv", direct)).rejects.toThrow("npm run e2e changed the branch (moved HEAD or left tracked files modified)");
      expect(h.host.callsTo("push")).toEqual([]);
    });

    it("reports the host's message when the fetch or the push is unavailable", async () => {
      await seedProject(h);
      await mergeOne("CSV-1");
      h.host.scripted.fetchBranch = [{ outcome: "unavailable", message: "git fetch from origin failed: no route" }];
      await expect(land(h.ctx, "csv", direct)).rejects.toThrow("git fetch from origin failed: no route");
      h.host.scripted.push = [{ outcome: "unavailable", message: "git push to origin failed: ! [rejected] (fetch first)" }];
      await expect(land(h.ctx, "csv", direct)).rejects.toThrow("git push to origin failed: ! [rejected] (fetch first)");
      expect(landed()).toEqual([]);
      expect(guardFree()).toBe(true);
    });
  });
});

describe("land on a multi-repo project", () => {
  const WEB = "/data/worktrees/csv.web";
  const API = "/data/worktrees/csv.api";
  const PR = (n: number) => `https://github.com/acme/shop/pull/${n}`;
  const landArgs = { actor: "human", ready: false };
  const direct = { ...landArgs, direct: true };
  const acceptance = ["WHEN the guide is built THE SYSTEM SHALL list the export"];
  const withWebDocsTicket = (doc: Doc) => doc.ticket.push({ ref: "web-docs", title: "Web docs", body: "Write the docs.", acceptance, scope: ["docs/**"], repo: "web" });
  const withApiDocsTicket = (doc: Doc) => doc.ticket.push({ ref: "api-docs", title: "API docs", body: "Write the docs.", acceptance, scope: ["docs/**"], repo: "api" });
  const withGuideTicket = (doc: Doc) => doc.ticket.push({ ref: "guide", title: "Guide", body: "Write the guide.", acceptance, scope: ["guide/**"], repo: "docs" });
  const mergeOne = async (key: string) => {
    await reachApproved(h, key);
    await queue();
    expect(ticketOf(h, key).state).toBe("done");
  };
  const repoRows = () => Object.fromEntries(h.store.projectRepos(project().id).map((row) => [row.name, row]));
  const landed = () => h.store.eventsOfKind(project().id, "project.landed").map((event) => JSON.parse(event.data_json));
  const guardFree = () => {
    const release = holdMerge(h.ctx, project().id);
    release?.();
    return release !== null;
  };
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (thrown: unknown) => thrown as { code: string; message: string; hint?: string },
    );
    expect(error).not.toBeNull();
    return { code: error!.code, message: error!.message, hint: error!.hint };
  };

  it("pushes each repo with merged work in the spec's order and opens one pull request per repo, whose body lists only that repo's tickets", async () => {
    await seedRepoProject(h, withWebDocsTicket);
    await mergeOne("CSV-2");
    await mergeOne("CSV-1");
    const mark = h.host.calls.length;
    const result = await land(h.ctx, "csv", landArgs);

    expect(result).toEqual({
      repos: [
        { repo: "web", url: PR(1), sha: "m2" },
        { repo: "api", url: PR(2), sha: "m1" },
      ],
      unlanded: [],
      done: false,
    });
    const calls = hostCallsSince(mark).map((call) => [call.method, call.input]);
    expect(calls.map(([method, input]) => (method === "prCreate" ? [method, { ...(input as object), body: "…" }] : [method, input]))).toEqual([
      ["ensureWorktree", { repo: "/src/web", key: "csv.web", branch: "loom/csv" }],
      ["worktreeState", { worktree: WEB, base: "main" }],
      ["push", { repo: "/src/web", remote: "origin", src: "m2", branch: "loom/csv" }],
      ["prCreate", { repo: "/src/web", remote: "origin", base: "main", head: "loom/csv", title: "CSV export", body: "…", draft: true, forge: { kind: "gh" } }],
      ["ensureWorktree", { repo: "/src/api", key: "csv.api", branch: "loom/csv" }],
      ["worktreeState", { worktree: API, base: "trunk" }],
      ["push", { repo: "/src/api", remote: "upstream", src: "m1", branch: "loom/csv" }],
      ["prCreate", { repo: "/src/api", remote: "upstream", base: "trunk", head: "loom/csv", title: "CSV export", body: "…", draft: true, forge: { kind: "gh" } }],
    ]);

    const [web, api] = h.host.callsTo("prCreate").map((call) => call.body);
    expect(web).toContain("Let people export their orders as a CSV file");
    expect(web).toContain("- CSV-1 Order rows");
    expect(web).not.toContain("CSV-2");
    expect(web).not.toContain("CSV-3");
    expect(web).toContain('This pull request lands the project\'s work in the repo "web". The project also changes the repos "api" and "docs", which land on their own.');
    expect(api).toContain("- CSV-2 Export endpoint");
    expect(api).not.toContain("CSV-1");
    expect(api).toContain('the repo "api". The project also changes the repos "web" and "docs"');

    expect(project().pr_url).toBeNull();
    expect(repoRows()).toEqual({
      api: { project_id: project().id, name: "api", pr_url: PR(2), landed_sha: "m1", landed_at: h.clock.t },
      web: { project_id: project().id, name: "web", pr_url: PR(1), landed_sha: "m2", landed_at: h.clock.t },
    });
    expect(landed()).toEqual([
      { repo: "web", url: PR(1), sha: "m2", created: true },
      { repo: "api", url: PR(2), sha: "m1", created: true },
    ]);
    expect(guardFree()).toBe(true);
  });

  it("pushes later merges to each repo's pull request, opening no new one, and honours --title and --ready on the first land", async () => {
    await seedRepoProject(h, withWebDocsTicket);
    await mergeOne("CSV-1");
    await mergeOne("CSV-2");
    await land(h.ctx, "csv", { actor: "human", ready: true, title: "Export orders as CSV" });
    expect(h.host.callsTo("prCreate").map((call) => [call.repo, call.title, call.draft])).toEqual([
      ["/src/web", "Export orders as CSV", false],
      ["/src/api", "Export orders as CSV", false],
    ]);

    h.clock.advance(1000);
    await mergeOne("CSV-3");
    const again = await land(h.ctx, "csv", landArgs);
    expect(again).toEqual({
      repos: [
        { repo: "web", url: PR(1), sha: "m3" },
        { repo: "api", url: PR(2), sha: "m2" },
      ],
      unlanded: [],
      done: true,
    });
    expect(h.host.callsTo("prCreate")).toHaveLength(2);
    expect(h.host.callsTo("push").map((call) => [call.repo, call.src])).toEqual([
      ["/src/web", "m1"],
      ["/src/api", "m2"],
      ["/src/web", "m3"],
      ["/src/api", "m2"],
    ]);
    expect(repoRows().web).toMatchObject({ pr_url: PR(1), landed_sha: "m3", landed_at: h.clock.t });
    expect(landed().slice(2)).toEqual([
      { repo: "web", url: PR(1), sha: "m3", created: false },
      { repo: "api", url: PR(2), sha: "m2", created: false },
    ]);
  });

  it("holds the merge guard through every repo's push", async () => {
    await seedRepoProject(h);
    await mergeOne("CSV-1");
    await mergeOne("CSV-2");
    const held: boolean[] = [];
    const call = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: unknown) => {
      if (method === "push" || method === "prCreate") held.push(holdMerge(h.ctx, project().id) === null);
      return call(hostId, method as never, input as never);
    }) as typeof h.host.call;
    await land(h.ctx, "csv", landArgs);
    expect(held).toEqual([true, true, true, true]);
    expect(guardFree()).toBe(true);
  });

  it("lands only the repo --repo names, and names the repos still to land", async () => {
    await seedRepoProject(h);
    await mergeOne("CSV-1");
    await mergeOne("CSV-2");
    const result = await land(h.ctx, "csv", { ...landArgs, repo: "api" });
    expect(result).toEqual({ repos: [{ repo: "api", url: PR(1), sha: "m2" }], unlanded: ["web"], done: false });
    expect(h.host.callsTo("push")).toEqual([{ repo: "/src/api", remote: "upstream", src: "m2", branch: "loom/csv" }]);
    expect(Object.keys(repoRows())).toEqual(["api"]);
    expect(project().state).toBe("running");

    expect(await land(h.ctx, "csv", { ...landArgs, repo: "web" })).toEqual({ repos: [{ repo: "web", url: PR(2), sha: "m1" }], unlanded: [], done: true });
    expect(project().state).toBe("done");
  });

  it("refuses an unknown repo with the list of repos, a repo with no done ticket, and --repo on a single-repo project", async () => {
    await seedRepoProject(h);
    await mergeOne("CSV-1");
    expect(await failure(land(h.ctx, "csv", { ...landArgs, repo: "mobile" }))).toMatchObject({ code: "loom_invalid_input", message: 'Project csv has no repo "mobile"; its repos are web, api, docs.' });
    expect(await failure(land(h.ctx, "csv", { ...landArgs, repo: "docs" }))).toMatchObject({
      code: "loom_invalid_state",
      message: 'Cannot land the repo "docs": none of its tickets is done yet, so its integration branch has nothing to land.',
    });
    expect(h.host.callsTo("push")).toEqual([]);
    expect(guardFree()).toBe(true);

    const single = makeCtx();
    await seedProject(single);
    expect(await failure(land(single.ctx, "csv", { ...landArgs, repo: "web" }))).toMatchObject({
      code: "loom_invalid_input",
      message: "Cannot land one repo: csv has no [[repo]] tables, so it lands as one repository.",
      hint: "Run `bb loom land csv` without --repo.",
    });
  });

  it("with --direct, merges each repo's remote base in, runs that repo's after_merge and pushes to that repo's remote base", async () => {
    await seedRepoProject(h, (doc) => {
      doc.checks.after_merge = ["npm run e2e"];
      doc.repo[0].after_merge = ["npm run web-e2e"];
    });
    await mergeOne("CSV-1");
    await mergeOne("CSV-2");
    h.host.remoteBase = "up1";
    const mark = h.host.calls.length;
    const result = await land(h.ctx, "csv", direct);

    expect(result).toEqual({
      repos: [
        { repo: "web", url: null, pushed: "origin/main", sha: "m3" },
        { repo: "api", url: null, pushed: "upstream/trunk", sha: "m4" },
      ],
      unlanded: [],
      done: true,
    });
    expect(hostCallsSince(mark).map((call) => [call.method, call.input])).toEqual([
      ["ensureWorktree", { repo: "/src/web", key: "csv.web", branch: "loom/csv" }],
      ["fetchBranch", { worktree: WEB, remote: "origin", branch: "main" }],
      ["merge", { worktree: WEB, ref: "up1", message: "Merge origin/main into loom/csv (Loom)" }],
      ["exec", { cwd: WEB, command: "npm run web-e2e", timeoutMs: 15 * 60_000 }],
      ["worktreeState", { worktree: WEB, base: "main", trackedOnly: true }],
      ["push", { repo: "/src/web", remote: "origin", src: "m3", branch: "main" }],
      ["ensureWorktree", { repo: "/src/api", key: "csv.api", branch: "loom/csv" }],
      ["fetchBranch", { worktree: API, remote: "upstream", branch: "trunk" }],
      ["merge", { worktree: API, ref: "up1", message: "Merge upstream/trunk into loom/csv (Loom)" }],
      ["exec", { cwd: API, command: "npm run e2e", timeoutMs: 15 * 60_000 }],
      ["worktreeState", { worktree: API, base: "trunk", trackedOnly: true }],
      ["push", { repo: "/src/api", remote: "upstream", src: "m4", branch: "trunk" }],
    ]);
    expect(h.host.callsTo("prCreate")).toEqual([]);
    expect(repoRows()).toMatchObject({ web: { pr_url: null, landed_sha: "m3" }, api: { pr_url: null, landed_sha: "m4" } });
    expect(landed()).toEqual([
      { repo: "web", direct: true, pushed: "origin/main", sha: "m3" },
      { repo: "api", direct: true, pushed: "upstream/trunk", sha: "m4" },
    ]);
    expect(project().state).toBe("done");
  });

  it("stops at the repo that fails, keeps the repos landed before it, and lands the rest on the next run", async () => {
    await seedRepoProject(h, withGuideTicket);
    for (const key of ["CSV-1", "CSV-2", "CSV-3"]) await mergeOne(key);
    h.host.scripted.push = [{ outcome: "ok" }, { outcome: "unavailable", message: "git push to upstream failed: rejected" }];
    expect(await failure(land(h.ctx, "csv", landArgs))).toEqual({
      code: "loom_unavailable",
      message: `Landed web (${PR(1)}); api and docs did not land. The repo "api" failed: git push to upstream failed: rejected`,
      hint: "Fix that, then run `bb loom land csv` again to land every repo with merged work.",
    });
    expect(h.host.callsTo("push").map((call) => call.repo)).toEqual(["/src/web", "/src/api"]);
    expect(Object.keys(repoRows())).toEqual(["web"]);
    expect(repoRows().web).toMatchObject({ pr_url: PR(1), landed_sha: "m1" });
    expect(landed()).toEqual([{ repo: "web", url: PR(1), sha: "m1", created: true }]);
    expect(project().state).toBe("running");
    expect(guardFree()).toBe(true);

    expect(await land(h.ctx, "csv", landArgs)).toEqual({
      repos: [
        { repo: "web", url: PR(1), sha: "m1" },
        { repo: "api", url: PR(2), sha: "m2" },
        { repo: "docs", url: PR(3), sha: "m3" },
      ],
      unlanded: [],
      done: true,
    });
  });

  it("reports a failure with nothing landed, and the one repo --repo named", async () => {
    await seedRepoProject(h);
    await mergeOne("CSV-1");
    await mergeOne("CSV-2");
    h.host.scripted.push = [{ outcome: "unavailable", message: "git push to origin failed: rejected" }];
    expect(await failure(land(h.ctx, "csv", landArgs))).toMatchObject({ message: 'No repo landed; web and api did not land. The repo "web" failed: git push to origin failed: rejected' });
    h.host.scripted.prCreate = [{ outcome: "unavailable", message: "The gh CLI is not installed on this machine, or it is not on PATH." }];
    expect(await failure(land(h.ctx, "csv", { ...landArgs, repo: "web" }))).toEqual({
      code: "loom_unavailable",
      message: 'The repo "web" did not land: The gh CLI is not installed on this machine, or it is not on PATH.',
      hint: "Fix that, then run `bb loom land csv --repo web`.",
    });
    expect(repoRows()).toEqual({});
    expect(landed()).toEqual([]);
  });

  it("with --direct, lands the repos before one whose worker's worktree is still being created, and names that repo", async () => {
    await seedRepoProject(h, withApiDocsTicket);
    await mergeOne("CSV-1");
    await mergeOne("CSV-2");
    h.store.addThread({ project_id: project().id, ticket_id: ticketOf(h, "CSV-3").id, role: "worker", state: "spawning", spawn_token: "tok" });
    expect(await failure(land(h.ctx, "csv", direct))).toEqual({
      code: "loom_invalid_state",
      message: 'Landed web (origin/main at m1); api did not land. The repo "api" failed: Cannot land yet: a worker\'s worktree is still being created from loom/csv; try again in a moment.',
      hint: "Fix that, then run `bb loom land csv --direct --repo api`.",
    });
    expect(h.host.callsTo("push")).toEqual([{ repo: "/src/web", remote: "origin", src: "m1", branch: "main" }]);
    expect(h.host.callsTo("fetchBranch")).toEqual([{ worktree: WEB, remote: "origin", branch: "main" }]);
    expect(Object.keys(repoRows())).toEqual(["web"]);
    expect(guardFree()).toBe(true);
  });

  it("with --direct, resets only the repo whose after_merge fails, and keeps the repo pushed before it", async () => {
    await seedRepoProject(h, (doc) => (doc.repo[1].after_merge = ["npm run api-e2e"]));
    await mergeOne("CSV-1");
    await mergeOne("CSV-2");
    h.host.remoteBase = "up1";
    h.host.execResults = [{ exitCode: 1, output: "1 api test failed" }];
    const error = await failure(land(h.ctx, "csv", direct));
    expect(error.code).toBe("loom_invalid_state");
    expect(error.message).toContain('Landed web (origin/main at m3); api did not land. The repo "api" failed: Cannot land on upstream/trunk: npm run api-e2e failed (exit 1). Nothing was pushed, and loom/csv is back at m2.');
    expect(error.message).toContain("1 api test failed");
    expect(h.host.callsTo("resetHard")).toEqual([{ worktree: API, sha: "m2" }]);
    expect(h.host.callsTo("push")).toEqual([{ repo: "/src/web", remote: "origin", src: "m3", branch: "main" }]);
    expect(repoRows()).toMatchObject({ web: { landed_sha: "m3" } });
    expect(repoRows().api).toBeUndefined();
  });

  it("names the repo in a direct land that conflicts, with a hint to land that repo as a pull request", async () => {
    await seedRepoProject(h);
    await mergeOne("CSV-1");
    h.host.scripted.merge = [{ outcome: "conflict", files: ["src/model/a.ts"] }];
    expect(await failure(land(h.ctx, "csv", direct))).toEqual({
      code: "loom_invalid_state",
      message: 'The repo "web" did not land: Cannot land on origin/main: it conflicts with loom/csv in src/model/a.ts.',
      hint: "Land it as a pull request with `bb loom land csv --repo web` and resolve the conflict there.",
    });
  });

  it("finishes the project only when every repo with merged work has landed since its newest merge", async () => {
    await seedRepoProject(h, withWebDocsTicket);
    await mergeOne("CSV-1");
    await mergeOne("CSV-2");
    expect(await land(h.ctx, "csv", landArgs)).toMatchObject({ unlanded: [], done: false });

    h.clock.advance(1000);
    await mergeOne("CSV-3");
    expect(await land(h.ctx, "csv", { ...landArgs, repo: "api" })).toMatchObject({ unlanded: ["web"], done: false });
    expect(project().state).toBe("running");
    expect(await land(h.ctx, "csv", { ...landArgs, repo: "web" })).toMatchObject({ unlanded: [], done: true });
    expect(project().state).toBe("done");
  });

  it("finishes a project whose tickets were all cancelled with no push, and still refuses one with work left and none merged", async () => {
    await seedRepoProject(h);
    const nothingDone = { code: "loom_invalid_state", message: "Cannot land: no ticket is done yet, so the integration branch has nothing to land." };
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "cancelled", "human");
    expect(await failure(land(h.ctx, "csv", landArgs))).toMatchObject(nothingDone);
    expect(project().state).toBe("running");

    h.store.setTicketState(ticketOf(h, "CSV-2").id, "cancelled", "human");
    h.store.setProjectState(project().id, "paused", "human");
    expect(await failure(land(h.ctx, "csv", { ...landArgs, repo: "web" }))).toMatchObject(nothingDone);
    const release = holdMerge(h.ctx, project().id)!;
    expect(await failure(land(h.ctx, "csv", landArgs))).toMatchObject({ message: "Cannot land: a merge is running; try again in a moment." });
    release();
    const mark = h.host.calls.length;
    expect(await land(h.ctx, "csv", landArgs)).toEqual({ repos: [], unlanded: [], done: true });
    expect(hostCallsSince(mark)).toEqual([]);
    expect(project().state).toBe("done");
    expect(landed()).toEqual([]);
    expect(guardFree()).toBe(true);
    expect(await land(h.ctx, "csv", direct)).toEqual({ repos: [], unlanded: [], done: true });

    const single = makeCtx();
    await seedProject(single);
    for (const key of ["CSV-1", "CSV-2"]) single.store.setTicketState(ticketOf(single, key).id, "cancelled", "human");
    expect(await failure(land(single.ctx, "csv", landArgs))).toMatchObject(nothingDone);
    expect(single.store.projectBySlug("csv")!.state).toBe("running");
  });

  it("does not wait on a repo whose tickets were all cancelled", async () => {
    await seedRepoProject(h);
    await mergeOne("CSV-1");
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "cancelled", "human");
    expect(await land(h.ctx, "csv", landArgs)).toEqual({ repos: [{ repo: "web", url: PR(1), sha: "m1" }], unlanded: [], done: true });
    expect(project().state).toBe("done");
  });
});
