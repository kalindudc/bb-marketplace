import { beforeEach, describe, expect, it } from "vitest";
import { heldCheckResult } from "../src/prompts";
import { finishIfComplete, holdMerge, land, mergeTicket, pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { readyTickets, toLite } from "../src/scheduler";
import type { HostOutput } from "../src/host-contract";
import { blockTicket, endThread, requeueTicket, specOf } from "../src/workers";
import { makeCtx, reachApproved, seedProject, startWorker, ticketOf, withDocsTicket, type Doc, type EngineHarness } from "./helpers";

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

describe("the pull request strategy", () => {
  const pr = (edit?: (doc: Doc) => void) => (doc: Doc) => {
    doc.merge = { strategy: "pr" };
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
      ["gh pr create", 1],
    ]);
    expect(h.store.runOutput(mergeRuns()[1]!.id)).toBe("Opened https://github.com/acme/shop/pull/1.");
  });

  it("opens a ready pull request when merge.draft is false", async () => {
    await seedProject(h, pr((doc) => (doc.merge = { strategy: "pr", draft: false, remote: "upstream" })));
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
    expect(h.host.callsTo("prState")).toEqual([]);

    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("prState")).toEqual([{ repo: "/repo", url: "https://github.com/acme/shop/pull/1" }]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pr_checked_at: h.clock.t });
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("prState")).toHaveLength(1);
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
      const gate = deferred<HostOutput<"prState">>();
      const reached = deferred<void>();
      const original = h.host.call.bind(h.host);
      h.host.call = (async (hostId: string, method: string, input: unknown) => {
        if (method !== "prState") return original(hostId, method as "push", input as never);
        reached.resolve();
        return gate.promise;
      }) as typeof h.host.call;
      return { gate, reached };
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

  it("pauses the project when gh cannot be reached while polling, and tries again in 5 minutes", async () => {
    await seedProject(h, pr());
    await reachApproved(h);
    await queue();
    h.host.scripted.prState = [{ outcome: "unavailable", message: "gh pr view failed: HTTP 502" }];
    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(project()).toMatchObject({ state: "paused", system_reason: "gh pr view failed: HTTP 502" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pr_checked_at: h.clock.t });
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

describe("finishIfComplete", () => {
  it("moves a running or paused pull request project to done once every ticket is done or cancelled", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr" }));
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
    expect(again.url).toBe("https://github.com/acme/shop/pull/1");
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
});
