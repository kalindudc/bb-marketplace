import { beforeEach, describe, expect, it } from "vitest";
import { resumeCheckingTickets, runChecks, settleChecks, submit } from "../src/checks";
import { PAUSE_NOW_REASON } from "../src/states";
import { blockTicket, endThread, resumeEnding } from "../src/workers";
import { makeCtx, seedMachineProject, seedProject, seedRepoProject, startLateWorker, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const WORKTREE = "/wt/env_1";
const project = () => h.store.projectBySlug("csv")!;
const posts = (key = "CSV-1") => h.store.posts(ticketOf(h, key).id);
const lastCheck = (key = "CSV-1") => posts(key).filter((post) => post.kind === "check").at(-1)!;
const runs = (key = "CSV-1") => h.store.runs(ticketOf(h, key).id);
const checkData = (key = "CSV-1") => JSON.parse(lastCheck(key).data_json) as { passed: boolean; head?: string; runs: Array<{ command: string; exitCode: number | null }>; outside: string[]; protectedHits: string[] };

/** A started worker that changed `changed` and called loom_submit; the checks have finished. */
async function submitted(edit?: (doc: Doc) => void, changed = ["src/model/a.ts"]) {
  await seedProject(h, edit);
  const row = await startWorker(h);
  h.host.worktree(WORKTREE).dirty = true;
  h.host.worktree(WORKTREE).changed = changed;
  const reply = submit(h.ctx, "thr_w1", "Mapped orders to rows");
  await settleChecks(h.ctx);
  return { row, reply };
}

describe("submit", () => {
  it("moves the ticket to checking at once, records the summary and returns without waiting for the checks", async () => {
    await seedProject(h);
    await startWorker(h);
    h.host.worktree(WORKTREE).dirty = true;
    const reply = submit(h.ctx, "thr_w1", "  Mapped orders  ");
    expect(ticketOf(h, "CSV-1").state).toBe("checking");
    expect(posts().at(-1)).toMatchObject({ kind: "submit", author_kind: "worker", author_thread_id: "thr_w1", body: "Mapped orders" });
    expect(reply).toContain("end your turn");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
  });

  it("refuses a thread that is not the live worker of a ticket in working, an empty summary, and a second submit", async () => {
    await seedProject(h);
    await startWorker(h);
    expect(() => submit(h.ctx, "thr_plan", "x")).toThrow(/Loom worker/);
    expect(() => submit(h.ctx, "thr_nobody", "x")).toThrow(/Loom worker/);
    expect(() => submit(h.ctx, "thr_w1", "   ")).toThrow(/summary is empty/);
    submit(h.ctx, "thr_w1", "first");
    expect(() => submit(h.ctx, "thr_w1", "second")).toThrow(/not the live worker/);
    await settleChecks(h.ctx);
  });

  it("refuses a worker whose row is no longer active", async () => {
    await seedProject(h);
    const row = await startWorker(h);
    await endThread(h.ctx, row, "gone", { commit: false });
    expect(() => submit(h.ctx, "thr_w1", "late")).toThrow(/not the live worker/);
  });
});

describe("a passing submit", () => {
  it("commits, reads the changed files, runs the ticket's verify and then the project checks, and moves to review with head_sha", async () => {
    await submitted((doc) => (doc.ticket[0].verify = ["npm run lint"]));
    expect(h.host.calls.map((call) => call.method)).toEqual(["commitAll", "worktreeState", "exec", "exec", "worktreeState"]);
    expect(h.host.callsTo("commitAll")).toEqual([{ worktree: WORKTREE, message: "CSV-1: Order rows" }]);
    expect(h.host.callsTo("worktreeState")[0]).toEqual({ worktree: WORKTREE, base: "loom/csv" });
    expect(h.host.callsTo("exec")).toEqual([
      { cwd: WORKTREE, command: "npm run lint", timeoutMs: 15 * 60_000 },
      { cwd: WORKTREE, command: "npm test", timeoutMs: 15 * 60_000 },
    ]);
    expect(h.host.calls.every((call) => call.hostId === "host_1")).toBe(true);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", head_sha: "c1", branch: "wt-thr_w1", check_failures: 0 });
    expect(checkData()).toMatchObject({ passed: true, outside: [], protectedHits: [] });
    expect(checkData().runs.map((run) => run.command)).toEqual(["npm run lint", "npm test"]);
    expect(lastCheck().body).toContain("Checks passed");
    expect(lastCheck().body).toContain("npm test (exit 0");
    expect(h.bb.sent("thr_w1").at(-1)).toMatch(/^\[loom\] CSV-1: the checks passed.*review/s);
    expect(runs().map((run) => [run.stage, run.label, run.ok])).toEqual([
      ["check", "git commit", 1],
      ["check", "git status", 1],
      ["check", "npm run lint", 1],
      ["check", "npm test", 1],
      ["check", "git status", 1],
    ]);
  });

  it("counts a review round on every pass: 1 first, then 2 after a changes-requested resubmit", async () => {
    await submitted();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", review_round: 1 });
    const move = h.store.events(project().id).filter((event) => event.kind === "ticket.state" && event.ticket_id === ticketOf(h, "CSV-1").id).at(-1)!;
    expect(JSON.parse(move.data_json)).toMatchObject({ to: "review", round: 1, head: "c1" });

    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");
    h.host.worktree(WORKTREE).dirty = true;
    submit(h.ctx, "thr_w1", "second try");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", review_round: 2, head_sha: "c2" });
  });

  it("compares against the remote base on the pr strategy", async () => {
    await submitted((doc) => (doc.merge = { strategy: "pr" }));
    expect(h.host.callsTo("worktreeState")[0]!.base).toBe("origin/main");
  });

  it("resets the worker's idle count", async () => {
    await seedProject(h);
    const row = await startWorker(h);
    h.store.updateThread(row.id, { idle_count: 1 });
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(h.store.thread(row.id)?.idle_count).toBe(0);
  });

  it("flags files outside the scope in the post and still passes under enforce = warn", async () => {
    await submitted(undefined, ["src/model/a.ts", "package.json"]);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    expect(checkData()).toMatchObject({ passed: true, outside: ["package.json"] });
    expect(lastCheck().body).toContain("Outside the ticket's scope");
    expect(lastCheck().body).toContain("package.json");
  });
});

describe("a failing submit", () => {
  it("returns the ticket to working, sends the failing command's output and counts a check failure", async () => {
    const { row } = await submitted((doc) => (doc.ticket[0].verify = ["npm run lint"]));
    // second round: lint fails
    h.host.execResults = [{ exitCode: 2, output: "src/a.ts:1 error no-unused-vars" }];
    h.host.worktree(WORKTREE).dirty = true;
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");
    h.clock.advance(60_000);
    submit(h.ctx, "thr_w1", "fixed");
    await settleChecks(h.ctx);

    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    expect(h.host.callsTo("exec").map((call) => call.command)).toEqual(["npm run lint", "npm test", "npm run lint"]);
    expect(lastCheck().body).toContain("Checks failed");
    expect(lastCheck().body).toContain("no-unused-vars");
    expect(checkData()).toMatchObject({ passed: false });
    const message = h.bb.sent("thr_w1").at(-1)!;
    expect(message).toMatch(/^\[loom\] CSV-1: the check "npm run lint" exited with 2/);
    expect(message).toContain("no-unused-vars");
    expect(h.store.thread(row.id)).toMatchObject({ clock_at: h.clock.t, idle_count: 0 });
    const failed = runs().at(-1)!;
    expect(failed).toMatchObject({ stage: "check", kind: "command", label: "npm run lint", ok: 0, exit_code: 2 });
    expect(h.store.runOutput(failed.id)).toBe("src/a.ts:1 error no-unused-vars");
  });

  it("reports a timed out command", async () => {
    await seedProject(h);
    await startWorker(h);
    h.host.worktree(WORKTREE).dirty = true;
    h.host.execResults = [{ exitCode: null, timedOut: true, output: "still running" }];
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(h.bb.sent("thr_w1").at(-1)).toContain("timed out");
  });

  it("fails without running any command when a protected path changed", async () => {
    await submitted((doc) => (doc.scope = { protected: ["db/migrations/**"] }), ["src/model/a.ts", "db/migrations/001.sql"]);
    expect(h.host.callsTo("exec")).toEqual([]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    expect(checkData()).toMatchObject({ passed: false, protectedHits: ["db/migrations/001.sql"] });
    expect(h.bb.sent("thr_w1").at(-1)).toContain("db/migrations/001.sql");
  });

  it("fails a change outside the scope under enforce = reject", async () => {
    await submitted((doc) => (doc.scope = { enforce: "reject" }), ["src/model/a.ts", "package.json"]);
    expect(h.host.callsTo("exec")).toEqual([]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    expect(checkData()).toMatchObject({ passed: false, outside: ["package.json"] });
    expect(h.bb.sent("thr_w1").at(-1)).toContain("package.json");
  });

  it("fails when a check command wrote a tracked file, or moved HEAD, while it ran", async () => {
    await seedProject(h);
    await startWorker(h);
    h.host.worktree(WORKTREE).dirty = true;
    h.host.onExec = (_input, worktree) => void (worktree.dirty = true);
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    expect(lastCheck().body).toContain("The worktree changed while the checks ran");
    expect(h.bb.sent("thr_w1").at(-1)).toContain("must not write tracked files");

    h.host.onExec = (_input, worktree) => void ((worktree.dirty = false), (worktree.head = "somebody-else"));
    h.host.worktree(WORKTREE).dirty = true;
    submit(h.ctx, "thr_w1", "again");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 2 });
    expect(ticketOf(h, "CSV-1").head_sha).toBeNull();
  });

  it("blocks the ticket and ends the worker once max_check_failures runs failed", async () => {
    await seedProject(h, (doc) => (doc.budget = { max_check_failures: 2 }));
    const row = await startWorker(h);
    h.host.execResults = [{ exitCode: 1, output: "boom" }, { exitCode: 1, output: "boom again" }];
    h.host.worktree(WORKTREE).dirty = true;
    submit(h.ctx, "thr_w1", "one");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    h.host.worktree(WORKTREE).dirty = true;
    submit(h.ctx, "thr_w1", "two");
    await settleChecks(h.ctx);

    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", check_failures: 2, blocked_reason: "checks failed 2 times", worker_thread_id: null });
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "blocked" });
    expect(h.bb.callsTo("archive")).toEqual([["thr_w1"]]);
    expect(project().triage_pending).toBe(1);
    expect(posts().at(-1)).toMatchObject({ kind: "block", author_kind: "loom" });
  });
});

describe("a ticket in one repo of a multi-repo project", () => {
  /** A started worker on `key` that changed `changed` and called loom_submit; the checks have finished. */
  async function submittedIn(key: string, changed: string[], edit?: (doc: Doc) => void) {
    await seedRepoProject(h, edit);
    const row = await startWorker(h, key);
    const worktree = h.host.worktree(`/wt/${row.environment_id}`);
    worktree.dirty = true;
    worktree.changed = changed;
    submit(h.ctx, row.thread_id!, "Done");
    await settleChecks(h.ctx);
    return row;
  }

  it("runs the ticket's verify commands and then its repo's checks, and no other repo's, in the worker's worktree against the integration branch", async () => {
    await submittedIn("CSV-1", ["src/model/a.ts"], (doc) => (doc.ticket[0].verify = ["npm run lint"]));
    expect(h.host.callsTo("exec")).toEqual([
      { cwd: WORKTREE, command: "npm run lint", timeoutMs: 15 * 60_000 },
      { cwd: WORKTREE, command: "npm run web-test", timeoutMs: 15 * 60_000 },
    ]);
    expect(h.host.callsTo("worktreeState")[0]).toEqual({ worktree: WORKTREE, base: "loom/csv" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", head_sha: "c1" });
    expect(checkData().runs.map((run) => run.command)).toEqual(["npm run lint", "npm run web-test"]);
  });

  it("runs the top-level checks for a repo that sets none, and compares against that repo's remote base on the pr strategy", async () => {
    await submittedIn("CSV-2", ["src/export/a.ts"], (doc) => (doc.merge = { strategy: "pr" }));
    expect(h.host.callsTo("exec").map((call) => call.command)).toEqual(["npm test"]);
    expect(h.host.callsTo("worktreeState")[0]).toEqual({ worktree: WORKTREE, base: "upstream/trunk" });
    expect(ticketOf(h, "CSV-2").state).toBe("review");
  });

  it("fails the scope check, without running a command, on a path that only the ticket's repo protects", async () => {
    await submittedIn("CSV-1", ["src/model/a.ts", "web.lock"]);
    expect(h.host.callsTo("exec")).toEqual([]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    expect(checkData()).toMatchObject({ passed: false, protectedHits: ["web.lock"] });
    expect(h.bb.sent("thr_w1").at(-1)).toContain("web.lock");
  });

  it("still fails a top-level protected path in a repo that adds none, and lets a path another repo protects through as outside the scope", async () => {
    await submittedIn("CSV-2", ["src/export/a.ts", "web.lock"]);
    expect(ticketOf(h, "CSV-2").state).toBe("review");
    expect(checkData("CSV-2")).toMatchObject({ passed: true, outside: ["web.lock"], protectedHits: [] });

    h.store.setTicketState(ticketOf(h, "CSV-2").id, "working", "loom");
    h.host.worktree(WORKTREE).dirty = true;
    h.host.worktree(WORKTREE).changed = ["src/export/a.ts", "db/001.sql"];
    submit(h.ctx, "thr_w1", "again");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", check_failures: 1 });
    expect(checkData("CSV-2")).toMatchObject({ passed: false, protectedHits: ["db/001.sql"] });
  });
});

describe("host errors and lost runs", () => {
  it("returns the ticket to working without a counted failure, and tells the worker to submit again", async () => {
    await seedProject(h);
    await startWorker(h);
    h.host.worktree(WORKTREE).dirty = true;
    h.host.errors.exec = new Error("host disconnected");
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 0 });
    expect(posts().at(-1)).toMatchObject({ kind: "system", body: "The checks could not run: host disconnected. Submit again." });
    expect(h.bb.sent("thr_w1").at(-1)).toBe("[loom] CSV-1: The checks could not run: host disconnected. Submit again.");

    h.host.errors.exec = null;
    submit(h.ctx, "thr_w1", "again");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
  });

  it("requeues the ticket when the host fails and the worker is gone", async () => {
    await seedProject(h);
    const row = await startWorker(h);
    h.host.worktree(WORKTREE).dirty = true;
    h.host.errors.commitAll = new Error("timed out");
    submit(h.ctx, "thr_w1", "done");
    h.store.updateThread(row.id, { state: "ended", ended_at: h.clock.t });
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", check_failures: 0, worker_thread_id: null });
  });

  it("requeues a ticket in checking whose worker is gone, without running anything", async () => {
    await seedProject(h);
    const row = await startWorker(h);
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    h.store.updateThread(row.id, { state: "ended", ended_at: h.clock.t });
    await runChecks(h.ctx, ticketOf(h, "CSV-1").id);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0 });
    expect(h.host.calls).toEqual([]);
  });

  it("drops the result when the worker's end already put the ticket back in the queue", async () => {
    await seedProject(h);
    const row = await startWorker(h);
    h.host.worktree(WORKTREE).dirty = true;
    h.host.onExec = () => {
      h.store.updateThread(row.id, { state: "ended", ended_at: h.clock.t });
      h.store.setTicketState(ticketOf(h, "CSV-1").id, "queued", "loom");
    };
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("queued");
    expect(posts().filter((post) => post.kind === "check")).toEqual([]);
    expect(h.bb.sent("thr_w1")).toEqual([]);
  });

  it("keeps a passing result when the worker is still being ended, and tells nobody", async () => {
    await seedProject(h);
    const row = await startWorker(h);
    h.host.worktree(WORKTREE).dirty = true;
    h.host.onExec = () => void h.store.claimThread(row.id, "gone");
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", head_sha: "c1" });
    expect(h.bb.sent("thr_w1")).toEqual([]);
  });

  it("runs a ticket stranded in checking again, as the tick and a restart do, and commits only once", async () => {
    await seedProject(h);
    await startWorker(h);
    h.host.worktree(WORKTREE).dirty = true;
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    expect(resumeCheckingTickets(h.ctx)).toBe(1);
    expect(resumeCheckingTickets(h.ctx)).toBe(0);
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", head_sha: "c1" });
    expect(resumeCheckingTickets(h.ctx)).toBe(0);

    // a restart after the commit but before the checks finished: the commit is a no-op the second time
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    resumeCheckingTickets(h.ctx);
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    expect(h.host.callsTo("commitAll")).toHaveLength(2);
  });

  it("never runs one ticket twice at once", async () => {
    await seedProject(h);
    await startWorker(h);
    h.host.worktree(WORKTREE).dirty = true;
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    const id = ticketOf(h, "CSV-1").id;
    await Promise.all([runChecks(h.ctx, id), runChecks(h.ctx, id)]);
    expect(h.host.callsTo("commitAll")).toHaveLength(1);
  });
});

describe("a worker whose environment bb attached after spawn returned", () => {
  it("can submit: the pipeline finds the environment through the thread and keeps it on the row and the ticket", async () => {
    await seedProject(h);
    const row = await startLateWorker(h);
    expect(row.environment_id).toBeNull();
    h.host.worktree("/wt/late").dirty = true;
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);

    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", head_sha: "c1", branch: "late-branch", environment_id: "env_late" });
    expect(h.host.callsTo("commitAll")).toEqual([{ worktree: "/wt/late", message: "CSV-1: Order rows" }]);
    expect(h.host.callsTo("exec").every((call) => call.cwd === "/wt/late")).toBe(true);
    expect(h.store.thread(row.id)!.environment_id).toBe("env_late");
  });

  it("still fails as a host error, without a counted failure, when bb has no environment for the thread yet", async () => {
    await seedProject(h);
    h.bb.provisionEnvironment = false;
    await startWorker(h);
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 0 });
    expect(posts().at(-1)).toMatchObject({ kind: "system", body: "The checks could not run: the worker's worktree is not available. Submit again." });
  });
});

describe("a worker that is still ending", () => {
  /** A checking ticket whose worker was claimed for a block but has not stopped yet. */
  async function endingWorker() {
    await seedProject(h);
    const row = await startWorker(h);
    h.bb.stopConfirms = false;
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    await endThread(h.ctx, row, "blocked", { commit: true });
    expect(h.store.thread(row.id)!.state).toBe("ending");
    return row;
  }
  const finishEnding = async (row: { id: number }) => {
    h.bb.stopConfirms = true;
    await resumeEnding(h.ctx, h.store.thread(row.id)!);
  };

  it("keeps a stranded checking ticket reserved, runs nothing, and leaves the move to the ending", async () => {
    const row = await endingWorker();
    const calls = h.host.calls.length;
    expect(resumeCheckingTickets(h.ctx)).toBe(1);
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "checking", worker_thread_id: "thr_w1" });
    expect(h.host.calls).toHaveLength(calls);
    expect(posts().filter((post) => post.kind === "check")).toEqual([]);

    await finishEnding(row);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", worker_thread_id: null });
    expect(h.store.thread(row.id)!.state).toBe("ended");
  });

  it("records a failed check but leaves the ticket, the failure count and the worker alone", async () => {
    await seedProject(h);
    const row = await startWorker(h);
    h.bb.stopConfirms = false;
    h.host.worktree(WORKTREE).dirty = true;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const call = h.host.call.bind(h.host);
    h.host.call = async (host, method, input) => {
      if (method === "exec") {
        entered();
        await held;
        return { exitCode: 1, timedOut: false, durationMs: 0, output: "failed" } as never;
      }
      return call(host, method, input);
    };
    submit(h.ctx, "thr_w1", "done");
    await started;
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "needs input", needs: "a decision", actor: "human" });
    expect(h.store.thread(row.id)!.state).toBe("ending");
    release();
    await settleChecks(h.ctx);

    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "checking", check_failures: 0, worker_thread_id: "thr_w1" });
    expect(lastCheck().body).toContain("Checks failed");
    expect(h.bb.sent("thr_w1")).toEqual([]);

    await finishEnding(row);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", worker_thread_id: null });
  });

  it("records a host error but leaves the ticket and the worker alone, and tells nobody", async () => {
    await seedProject(h);
    const row = await startWorker(h);
    h.bb.stopConfirms = false;
    h.host.worktree(WORKTREE).dirty = true;
    h.host.errors.exec = new Error("host disconnected");
    submit(h.ctx, "thr_w1", "done");
    await endThread(h.ctx, row, "blocked", { commit: false });
    await settleChecks(h.ctx);

    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "checking", check_failures: 0, worker_thread_id: "thr_w1" });
    expect(posts().at(-1)).toMatchObject({ kind: "system", body: "The checks could not run: host disconnected. Submit again." });
    expect(h.bb.sent("thr_w1")).toEqual([]);

    await finishEnding(row);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", worker_thread_id: null });
  });
});

describe("a project that is not running", () => {
  const pause = (reason?: string) => void h.store.setProjectState(project().id, "paused", "human", reason);

  async function started() {
    await seedProject(h);
    await startWorker(h);
    h.host.worktree(WORKTREE).dirty = true;
  }

  it("keeps a failed result on the ticket without messaging a worker that pause --now stopped", async () => {
    await started();
    h.host.execResults = [{ exitCode: 1, output: "src/a.ts: boom" }];
    h.host.onExec = () => pause(PAUSE_NOW_REASON);
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);

    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    expect(lastCheck().body).toContain("src/a.ts: boom");
    expect(h.bb.sent("thr_w1")).toEqual([]);
  });

  it("sends nothing for a passing result or a host error either, and a paused project that is not --now holds them too", async () => {
    await started();
    h.host.onExec = () => pause();
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    expect(h.bb.sent("thr_w1")).toEqual([]);

    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");
    h.host.onExec = null;
    h.host.errors.commitAll = new Error("host disconnected");
    submit(h.ctx, "thr_w1", "again");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(posts().at(-1)).toMatchObject({ kind: "system" });
    expect(h.bb.sent("thr_w1")).toEqual([]);
  });
});

describe("a worker on a machine of its own", () => {
  async function submittedOnBox() {
    await seedMachineProject(h);
    const row = await startWorker(h);
    const worktree = h.host.worktree(`/wt/${row.environment_id}`);
    worktree.dirty = true;
    worktree.changed = ["src/model/a.ts"];
    return { row, worktree };
  }

  it("brings the passed commit home, and reviews the home commit with its tree", async () => {
    const { row } = await submittedOnBox();
    expect(h.bb.environments.get(row.environment_id!)!.hostId).toBe("host_box1");
    submit(h.ctx, row.thread_id!, "Mapped orders to rows");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", head_sha: "home1", head_tree: "c1" });
    expect(checkData()).toMatchObject({ passed: true, head: "home1" });
    expect(h.host.refs.get("refs/heads/loom/csv/csv-1-home")).toBe("home1");
    expect(h.host.refs.get("refs/loom/csv/csv-1/reviewed")).toBe("home1");
    expect(h.host.calls.filter((call) => call.method === "exportChanges").map((call) => call.hostId)).toEqual(["host_box1"]);
    expect(h.host.calls.filter((call) => call.method === "importCommit").map((call) => call.hostId)).toEqual(["host_1"]);
    expect(runs().map((run) => run.label)).not.toContain("importCommit");
  });

  it("passes the worktree check when the machine moved during the checks and gave the same tree a new commit", async () => {
    const { row, worktree } = await submittedOnBox();
    h.host.onExec = () => {
      worktree.head = "c1-moved";
      h.host.trees.set("c1-moved", "c1");
    };
    submit(h.ctx, row.thread_id!, "Mapped orders to rows");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", head_tree: "c1" });
    expect(checkData().passed).toBe(true);
  });

  it("brings home only the tree the checks passed: a commit made after them is refused, and no ref moves", async () => {
    const { row } = await submittedOnBox();
    h.host.scripted.exportChanges = [{ base: "base000", head: "c2", tree: "t2", message: "late\n", author: { name: "Worker", email: "worker@example.com", date: "1800000000 +0000" }, changes: [{ status: "A", path: "src/model/late.ts", mode: "100644", blob: "b2", size: 3 }] }];
    submit(h.ctx, row.thread_id!, "Mapped orders to rows");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 0, head_sha: null, head_tree: null });
    expect(posts().at(-1)!.body).toBe("The checks could not run: the worktree changed after the checks passed: its tree is t2, not the checked c1. Submit again.");
    expect(h.host.callsTo("readBlob")).toEqual([]);
    expect(h.host.callsTo("importCommit")).toEqual([]);
    expect(h.host.refs.size).toBe(0);
  });

  it("brings nothing home when the checks fail", async () => {
    const { row } = await submittedOnBox();
    h.host.execResults.push({ exitCode: 1, output: "1 failing" });
    submit(h.ctx, row.thread_id!, "Mapped orders to rows");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", head_sha: null, head_tree: null });
    expect(h.host.callsTo("importCommit")).toEqual([]);
  });

  it("is a host failure, counting no check failure, when the commit cannot be brought home", async () => {
    const { row } = await submittedOnBox();
    h.host.scripted.importCommit = [{ outcome: "unavailable", message: "git fetch from origin failed: offline" }];
    submit(h.ctx, row.thread_id!, "Mapped orders to rows");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 0 });
    expect(posts().at(-1)!.body).toBe("The checks could not run: git fetch from origin failed: offline. Submit again.");
  });
});
