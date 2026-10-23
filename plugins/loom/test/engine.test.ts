import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import { makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleChecks, submit } from "../src/checks";
import { holdMerge, settleMerges } from "../src/merge";
import { SpawnRefusedError, type SpawnArgs } from "../src/ports";
import { approve, settleReviews } from "../src/review";
import { ensureSpecReview, specVerdict } from "../src/spec-review";
import { PAUSE_NOW_REASON } from "../src/states";
import { editTicket } from "../src/triage";
import { checkOutHead, makeEngine, reachApproved, reachReview, seedProject, seedRepoProject, specToml, ticketOf, withDocsTicket, workerRows, type Doc } from "./helpers";

let h: ReturnType<typeof makeEngine>;

beforeEach(() => {
  h = makeEngine();
});

const project = () => h.store.projectBySlug("csv")!;
const spawned = () => h.bb.callsTo("spawnThread").map(([args]) => (args as SpawnArgs).metadata.ticket);
const wide = (doc: Doc) => {
  withDocsTicket(doc);
  doc.agents = { max_workers: 3 };
};

describe("start", () => {
  it("creates the integration branch in the project's checkout, then starts the project and kicks a tick", async () => {
    await seedProject(h, undefined, "ready");
    const started = await h.engine.start("csv", "human");
    expect(started.state).toBe("running");
    expect(h.host.callsTo("ensureBranch")).toEqual([{ repo: "/repo", branch: "loom/csv", from: "main" }]);
    expect(h.host.calls[0]!.hostId).toBe("host_1");
    expect(h.bb.callsTo("projectCheckout")).toEqual([["proj_1", "host_1"]]);
    expect(h.kick).toHaveBeenCalled();
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1"]);
  });

  it("is refused with loom_no_checkout when the bb project has no checkout on the host, and the project stays ready", async () => {
    await seedProject(h, undefined, "ready");
    h.bb.checkout = null;
    await expect(h.engine.start("csv", "human")).rejects.toMatchObject({
      code: "loom_no_checkout",
      message: "The project's repository (bb project proj_1) has no checkout on the machine host_1 that this Loom project uses. Clone it there with `bb project source add proj_1 --clone --machine host_1`, then start the project again.",
    });
    expect(project().state).toBe("ready");
    expect(h.host.calls).toEqual([]);
  });

  it("creates the integration branch in every repo of a multi-repo project, from that repo's base, on the project's machine", async () => {
    await seedRepoProject(h, undefined, "ready");
    const started = await h.engine.start("csv", "human");
    expect(started.state).toBe("running");
    expect(h.host.calls.map((call) => [call.hostId, call.method, call.input])).toEqual([
      ["host_1", "ensureBranch", { repo: "/src/web", branch: "loom/csv", from: "main" }],
      ["host_1", "ensureBranch", { repo: "/src/api", branch: "loom/csv", from: "trunk" }],
      ["host_1", "ensureBranch", { repo: "/src/docs", branch: "loom/csv", from: "main" }],
    ]);
    expect(h.host.branches).toEqual(new Set(["/src/web#loom/csv", "/src/api#loom/csv", "/src/docs#loom/csv"]));
  });

  it("refuses to start a multi-repo project while a repo has no checkout, naming the repo and its clone command, and creates no branch", async () => {
    await seedRepoProject(h, undefined, "ready");
    h.bb.checkouts.set("proj_api", {});
    await expect(h.engine.start("csv", "human")).rejects.toMatchObject({
      code: "loom_no_checkout",
      message: 'Repo "api" (bb project proj_api) has no checkout on the machine host_1 that this Loom project uses. Clone it there with `bb project source add proj_api --clone --machine host_1`, then start the project again.',
    });
    expect(project().state).toBe("ready");
    expect(h.host.calls).toEqual([]);

    h.bb.checkouts.set("proj_docs", {});
    const both = await h.engine.start("csv", "human").catch((error: Error) => error.message);
    expect(String(both).split("\n")).toEqual([expect.stringContaining('Repo "api"'), expect.stringContaining('Repo "docs"')]);
    expect(project().state).toBe("ready");

    h.bb.checkouts.set("proj_api", { host_1: "/src/api" });
    h.bb.checkouts.set("proj_docs", { host_1: "/src/docs" });
    expect((await h.engine.start("csv", "human")).state).toBe("running");
  });

  it("refuses to start, naming the repo, when its integration branch cannot be created", async () => {
    await seedRepoProject(h, undefined, "ready");
    h.host.scripted.ensureBranch = [{ sha: "base000", created: true }, new Error("git rev-parse failed: trunk")];
    await expect(h.engine.start("csv", "human")).rejects.toMatchObject({
      code: "loom_invalid_state",
      message: 'Could not create the integration branch loom/csv in the repo "api" from trunk: git rev-parse failed: trunk',
      hint: "Check that trunk exists in /src/api.",
    });
    expect(project().state).toBe("ready");
  });

  it("checks every repo's checkout on the pr strategy but creates no branch", async () => {
    await seedRepoProject(h, (doc) => (doc.merge = { strategy: "pr" }), "ready");
    h.bb.checkouts.set("proj_web", {});
    await expect(h.engine.start("csv", "human")).rejects.toMatchObject({ code: "loom_no_checkout", message: expect.stringContaining('Repo "web"') });
    h.bb.checkouts.set("proj_web", { host_1: "/src/web" });
    expect((await h.engine.start("csv", "human")).state).toBe("running");
    expect(h.host.callsTo("ensureBranch")).toEqual([]);
  });

  it("is refused, with the project left ready, when the branch cannot be created", async () => {
    await seedProject(h, undefined, "ready");
    h.host.errors.ensureBranch = new Error("git rev-parse failed: nope");
    await expect(h.engine.start("csv", "human")).rejects.toMatchObject({ code: "loom_invalid_state", message: expect.stringContaining("loom/csv") });
    expect(project().state).toBe("ready");
  });

  it("makes no branch for the pr strategy, and leaves a draft or running project to the project service's own error", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr" }), "ready");
    await h.engine.start("csv", "human");
    expect(h.host.callsTo("ensureBranch")).toEqual([]);
    await expect(h.engine.start("csv", "human")).rejects.toMatchObject({ code: "loom_invalid_state" });
    await expect(h.engine.start("nope", "human")).rejects.toMatchObject({ code: "loom_not_found" });
    expect(h.host.calls).toEqual([]);
  });
});

describe("tick: spawning", () => {
  it("starts workers for ready tickets up to max_workers, one per ticket, in the project's section", async () => {
    await seedProject(h, wide);
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1", "CSV-3"]);
    expect(h.bb.callsTo("spawnThread").every(([args]) => (args as SpawnArgs).sectionId === "sec_1")).toBe(true);
    expect(ticketOf(h, "CSV-2").state).toBe("queued");
    await h.engine.tick();
    expect(spawned()).toHaveLength(2);
  });

  it("recomputes readiness before each reservation: a scope edit that lands during one spawn keeps the next ticket queued", async () => {
    await seedProject(h, (doc) => (doc.ticket[1].depends_on = []));
    h.bb.afterSpawn = () => {
      h.bb.afterSpawn = null;
      editTicket(h.ctx, "CSV-2", { scope: ["src/model/**"] }, "thr_plan");
    };
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1"]);
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "queued", attempt: 0, worker_thread_id: null });
    expect(workerRows(h, "CSV-2")).toEqual([]);
  });

  it("recomputes the free slots before each reservation", async () => {
    await seedProject(h, (doc) => {
      withDocsTicket(doc);
      doc.ticket[1].depends_on = [];
    });
    h.bb.afterSpawn = () => {
      h.bb.afterSpawn = null;
      h.store.setTicketState(ticketOf(h, "CSV-3").id, "working", "loom");
    };
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1"]);
    expect(ticketOf(h, "CSV-2").state).toBe("queued");
  });

  it("tries a ticket whose spawn failed only once per pass", async () => {
    await seedProject(h, (doc) => (doc.budget = { max_attempts: 5 }));
    h.bb.spawnError = () => new Error("provider down");
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1"]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 1 });
  });

  it("honors max_workers and frees a slot when a ticket reaches review", async () => {
    await seedProject(h, (doc) => {
      wide(doc);
      doc.agents = { max_workers: 1 };
    });
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1"]);
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1"]);
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "review", "loom");
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1", "CSV-3"]);
  });

  it("repairs the project's section before it spawns", async () => {
    await seedProject(h);
    h.bb.sections.clear();
    await h.engine.tick();
    expect(h.bb.callsTo("spawnThread")[0]![0]).toMatchObject({ sectionId: "sec_2" });
    expect(project().section_id).toBe("sec_2");
  });

  it("does not tick paused, ready or archived projects", async () => {
    await seedProject(h, undefined, "paused");
    await h.engine.tick();
    expect(h.bb.callsTo("spawnThread")).toEqual([]);
    await h.engine.resume("csv", "human");
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1"]);
  });

  it("holds new spawns until hold_until has passed", async () => {
    await seedProject(h);
    h.store.updateProject(project().id, { hold_until: h.clock.t + 60_000 });
    await h.engine.tick();
    expect(h.bb.callsTo("spawnThread")).toEqual([]);
    h.clock.advance(61_000);
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1"]);
  });

  it("shares one pass between concurrent ticks, and runs another pass when a kick arrives during one", async () => {
    h.kick.mockRestore();
    await seedProject(h, wide);
    const passes = vi.spyOn(h.store, "projects");
    await Promise.all([h.engine.tick(), h.engine.tick(), h.engine.tick()]);
    expect(spawned()).toHaveLength(2);
    expect(passes.mock.calls.length).toBeLessThanOrEqual(3);

    passes.mockClear();
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { state: "queued" });
    let kicked = false;
    h.bb.afterSpawn = () => {
      if (!kicked) h.engine.kick();
      kicked = true;
    };
    h.store.setTicketState(ticketOf(h, "CSV-3").id, "checking", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-3").id, "review", "loom");
    await h.engine.tick();
    expect(passes.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does nothing after dispose", async () => {
    await seedProject(h);
    await h.engine.dispose();
    await h.engine.tick();
    expect(h.bb.callsTo("spawnThread")).toEqual([]);
  });
});

describe("pause and resume", () => {
  it("pause stops new work but leaves workers running", async () => {
    await seedProject(h, wide);
    await h.engine.tick();
    await h.engine.pause("csv", "human", false);
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "review", "loom");
    await h.engine.tick();
    expect(spawned()).toHaveLength(2);
    expect(h.bb.callsTo("stop")).toEqual([]);
  });

  it("pause --now stops every worker thread without ending its row, the idles from those stops send nothing, and resume sends each stopped worker a continue message", async () => {
    await seedProject(h, wide);
    await h.engine.tick();
    await h.engine.pause("csv", "human", true);
    expect(project()).toMatchObject({ state: "paused", system_reason: PAUSE_NOW_REASON });
    expect(h.bb.callsTo("stop").map(([id]) => id).sort()).toEqual(["thr_w1", "thr_w2"]);
    expect(h.bb.callsTo("archive")).toEqual([]);
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("active");

    await h.engine.onThreadIdle("thr_w1");
    await h.engine.onThreadIdle("thr_w1");
    await h.engine.onThreadIdle("thr_w2");
    expect(h.bb.sent("thr_w1")).toEqual([]);
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("active");

    h.clock.advance(30 * 60_000);
    await h.engine.resume("csv", "human");
    expect(h.bb.sent("thr_w1")).toEqual(["[loom] The project resumed; continue CSV-1."]);
    expect(h.bb.sent("thr_w2")).toEqual(["[loom] The project resumed; continue CSV-3."]);
    expect(workerRows(h, "CSV-1")[0]).toMatchObject({ clock_at: h.clock.t, idle_count: 0 });
  });

  it("resume sends nothing to a worker whose thread is still running, or whose ticket is not working", async () => {
    await seedProject(h, wide);
    await h.engine.tick();
    await h.engine.pause("csv", "human", false);
    h.store.setTicketState(ticketOf(h, "CSV-3").id, "checking", "loom");
    await h.engine.resume("csv", "human");
    expect(h.bb.sent("thr_w1")).toEqual([]);
    expect(h.bb.sent("thr_w2")).toEqual([]);

    await h.engine.pause("csv", "human", false);
    h.bb.threads.get("thr_w1")!.status = "idle";
    await h.engine.resume("csv", "human");
    expect(h.bb.sent("thr_w1")).toHaveLength(1);
  });

  it("a check result that finished while the project was paused --now is stored, not sent, and resume hands it to the stopped worker", async () => {
    await seedProject(h);
    await h.engine.tick();
    h.host.worktree("/wt/env_1").dirty = true;
    h.host.execResults = [{ exitCode: 1, output: "src/a.ts: boom" }];
    h.host.onExec = () => void h.store.setProjectState(project().id, "paused", "human", PAUSE_NOW_REASON);
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    h.bb.threads.get("thr_w1")!.status = "idle";

    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    expect(h.bb.sent("thr_w1")).toEqual([]);

    await h.engine.resume("csv", "human");
    const [message] = h.bb.sent("thr_w1");
    expect(h.bb.sent("thr_w1")).toHaveLength(1);
    expect(message).toContain("[loom] The project resumed; continue CSV-1.");
    expect(message).toContain("Checks failed");
    expect(message).toContain("src/a.ts: boom");
  });

  it("resume hands over a host error that was held while paused, and nothing once the worker submitted again", async () => {
    await seedProject(h);
    await h.engine.tick();
    h.host.worktree("/wt/env_1").dirty = true;
    h.host.errors.exec = new Error("host disconnected");
    h.host.errors.commitAll = new Error("host disconnected");
    submit(h.ctx, "thr_w1", "done");
    h.store.setProjectState(project().id, "paused", "human", PAUSE_NOW_REASON);
    await settleChecks(h.ctx);
    h.bb.threads.get("thr_w1")!.status = "idle";
    await h.engine.resume("csv", "human");
    expect(h.bb.sent("thr_w1")).toHaveLength(1);
    expect(h.bb.sent("thr_w1")[0]).toContain("The checks could not run: host disconnected. Submit again.");

    h.host.errors.exec = null;
    h.host.errors.commitAll = null;
    h.host.worktree("/wt/env_1").dirty = true;
    submit(h.ctx, "thr_w1", "again");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");
    await h.engine.pause("csv", "human", true);
    await h.engine.resume("csv", "human");
    expect(h.bb.sent("thr_w1").at(-1)).toBe("[loom] The project resumed; continue CSV-1.");
  });

  it("stops a worker that finishes spawning after pause --now", async () => {
    await seedProject(h);
    h.bb.afterSpawn = () => void h.store.setProjectState(project().id, "paused", "human", PAUSE_NOW_REASON);
    await h.engine.tick();
    expect(h.bb.callsTo("stop")).toEqual([["thr_w1"]]);
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("active");
  });
});

describe("timeouts", () => {
  it("ends a worker whose ticket has been working for longer than ticket_timeout_minutes, and starts a replacement in the same pass", async () => {
    await seedProject(h);
    await h.engine.tick();
    h.clock.advance(121 * 60_000);
    await h.engine.tick();
    expect(workerRows(h, "CSV-1").map((row) => [row.state, row.end_reason])).toEqual([["ended", "timeout"], ["active", null]]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", failures: 1, attempt: 2 });
    expect(spawned()).toEqual(["CSV-1", "CSV-1"]);
  });

  it("stops the pass when a pause lands during the token refresh, so nobody is timed out", async () => {
    await seedProject(h);
    await h.engine.tick();
    h.clock.advance(121 * 60_000);
    let paused = false;
    h.bb.threadTokens = async () => {
      if (!paused) {
        paused = true;
        await h.engine.pause("csv", "human", false);
      }
      return 0;
    };
    await h.engine.tick();
    expect(project().state).toBe("paused");
    expect(workerRows(h, "CSV-1")).toMatchObject([{ state: "active", end_reason: null }]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", failures: 0 });
    expect(h.bb.callsTo("stop")).toEqual([]);
    expect(spawned()).toEqual(["CSV-1"]);
  });

  it("stops timing workers out when a pause lands while one of them is being ended", async () => {
    await seedProject(h, wide);
    await h.engine.tick();
    h.clock.advance(121 * 60_000);
    const stop = h.bb.stop.bind(h.bb);
    let paused = false;
    h.bb.stop = async (threadId) => {
      await stop(threadId);
      if (!paused) {
        paused = true;
        await h.engine.pause("csv", "human", false);
      }
    };
    await h.engine.tick();
    expect(workerRows(h, "CSV-1").map((row) => row.end_reason)).toEqual(["timeout"]);
    expect(workerRows(h, "CSV-3").map((row) => [row.state, row.end_reason])).toEqual([["active", null]]);
    expect(spawned()).toEqual(["CSV-1", "CSV-3"]);
  });

  it("never times out a worker whose ticket waits in checking, review or later", async () => {
    await seedProject(h, wide);
    await h.engine.tick();
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "review", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-3").id, "checking", "loom");
    h.clock.advance(24 * 60 * 60_000);
    await h.engine.tick();
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("active");
    expect(workerRows(h, "CSV-3")[0]!.state).toBe("active");
    expect(h.bb.callsTo("stop")).toEqual([]);
  });

  it("does not count paused time: a pause longer than the timeout followed by resume times nobody out", async () => {
    await seedProject(h);
    await h.engine.tick();
    await h.engine.pause("csv", "human", true);
    h.clock.advance(5 * 60 * 60_000);
    await h.engine.resume("csv", "human");
    await h.engine.tick();
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("active");
    h.clock.advance(119 * 60_000);
    await h.engine.tick();
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("active");
    h.clock.advance(2 * 60_000);
    await h.engine.tick();
    expect(workerRows(h, "CSV-1")[0]!.end_reason).toBe("timeout");
  });

  it("restarts the clock when a failed check sends the ticket back to working", async () => {
    await seedProject(h);
    await h.engine.tick();
    h.clock.advance(100 * 60_000);
    h.host.worktree("/wt/env_1").dirty = true;
    h.host.execResults = [{ exitCode: 1, output: "fail" }];
    const { submit } = await import("../src/checks");
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    h.clock.advance(100 * 60_000);
    await h.engine.tick();
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("active");
  });
});

describe("budgets", () => {
  it("pauses the project when the token budget is used up, flags triage, and tells the planner why", async () => {
    await seedProject(h, (doc) => (doc.budget = { max_tokens: 1000 }));
    await h.engine.tick();
    h.bb.tokens.set("thr_w1", 1500);
    h.clock.advance(61_000);
    await h.engine.tick();
    expect(project()).toMatchObject({ state: "paused", system_reason: "The token budget is used up: 1500 of 1000 tokens.", triage_round: 1 });
    expect(workerRows(h, "CSV-1")[0]).toMatchObject({ tokens: 1500, state: "active" });
    const sent = h.bb.callsTo("send").filter(([id]) => id === "thr_plan");
    expect(sent).toHaveLength(1);
    expect((sent[0]![1] as { detail: string }).detail).toContain("token budget is used up");
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1"]);
  });

  it("reads each thread's tokens at most once a minute", async () => {
    await seedProject(h);
    await h.engine.tick();
    await h.engine.tick();
    expect(h.bb.callsTo("threadTokens").filter(([id]) => id === "thr_w1")).toHaveLength(1);
    h.clock.advance(59_000);
    await h.engine.tick();
    expect(h.bb.callsTo("threadTokens").filter(([id]) => id === "thr_w1")).toHaveLength(1);
    h.clock.advance(2_000);
    await h.engine.tick();
    expect(h.bb.callsTo("threadTokens").filter(([id]) => id === "thr_w1")).toHaveLength(2);
  });

  it("pauses at the deadline before it spawns anything", async () => {
    await seedProject(h, (doc) => (doc.budget = { deadline: "2020-01-01" }));
    await h.engine.tick();
    expect(project()).toMatchObject({ state: "paused", system_reason: "The deadline 2020-01-01 has passed." });
    expect(h.bb.callsTo("spawnThread")).toEqual([]);
  });
});

describe("rate limits and turn failures", () => {
  it("retries a rate-limited turn and holds new spawns until its reset", async () => {
    await seedProject(h, wide);
    await h.engine.tick();
    for (const state of ["checking", "review", "approved", "merging", "done"] as const) h.store.setTicketState(ticketOf(h, "CSV-1").id, state, "loom");
    const reset = h.clock.t + 5 * 60_000;
    await h.engine.onTurnFailed(
      makeTurnFailedEvent({
        threadId: "thr_w2",
        requestId: "req_1",
        errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null },
        rateLimits: { kind: "subscription-window", overageReason: null, overageStatus: null, providerId: "claude", reachedReason: null, status: "blocked", windows: [{ label: "5h", providerKey: null, resetsAtMs: reset, status: "blocked" }] },
      }),
    );
    expect(h.bb.callsTo("retryTurn")).toEqual([["thr_w2", "req_1", reset + 15_000]]);
    expect(project().hold_until).toBe(reset + 15_000);
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1", "CSV-3"]);
    h.clock.advance(5 * 60_000 + 16_000);
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1", "CSV-3", "CSV-2"]);
  });

  it("kicks the tick on thread.failed and leaves the row alone", async () => {
    await seedProject(h);
    await h.engine.tick();
    await h.engine.onThreadFailed("thr_w1");
    await h.engine.onThreadFailed("thr_unknown");
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("active");
    expect(h.bb.sent("thr_w1")).toEqual([]);
  });
});

describe("events", () => {
  it("clears triage_sent_at when the planner idles, even while the project is paused", async () => {
    await seedProject(h, undefined, "paused");
    h.store.updateProject(project().id, { triage_sent_at: h.clock.t });
    await h.engine.onThreadIdle("thr_plan");
    expect(project().triage_sent_at).toBeNull();
  });

  it("ignores an idle from an unknown thread, and gives an idle worker its nudge", async () => {
    await seedProject(h);
    await h.engine.tick();
    await h.engine.onThreadIdle("thr_unknown");
    await h.engine.onThreadIdle("thr_w1");
    expect(h.bb.sent("thr_w1")).toHaveLength(1);
  });

  it("requeues the ticket of a worker the human archived, and ends the planner row of a deleted planner thread", async () => {
    await seedProject(h);
    await h.engine.tick();
    await h.engine.onThreadGone("thr_w1", "archived");
    expect(workerRows(h, "CSV-1")[0]).toMatchObject({ state: "ended", end_reason: "gone" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0 });
    await h.engine.onThreadGone("thr_plan", "archived");
    expect(h.store.threadByThreadId("thr_plan")?.state).toBe("active");
    await h.engine.onThreadGone("thr_plan", "deleted");
    expect(h.store.threadByThreadId("thr_plan")).toMatchObject({ state: "ended", end_reason: "deleted" });
  });
});

describe("spec review", () => {
  const draft = async () => {
    await h.projects.propose({ toml: specToml(), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    await ensureSpecReview(h.ctx, "csv");
  };
  const review = () => h.store.specReviews(project().id)[0]!;

  it("refuses to approve a draft in review, with the override in the hint, and approves with skipReview, superseding the review", async () => {
    await draft();
    const refused = await h.engine.approve("csv", "human").catch((error: unknown) => error as { message: string; hint?: string });
    expect(refused).toMatchObject({ message: "Draft v1 of csv is still in its spec review (round 1 of 3)." });
    expect((refused as { hint?: string }).hint).toContain("bb loom approve csv --skip-review");
    expect(project().state).toBe("draft");

    const approved = await h.engine.approve("csv", "human", undefined, { skipReview: true });
    expect(approved).toMatchObject({ state: "ready", applied: "draft" });
    expect(review().state).toBe("superseded");
    expect(h.bb.callsTo("archive")).toContainEqual(["thr_w1"]);
  });

  it("approves a draft once its review passed, and ends a live review when the project is archived", async () => {
    await draft();
    await specVerdict(h.ctx, "thr_w1", [], "Fits the request.");
    expect(await h.engine.approve("csv", "human")).toMatchObject({ state: "ready" });

    await h.projects.propose({ toml: specToml((doc) => {
        doc.project.slug = "csv-two";
        doc.project.key = "CSVB";
      }), threadId: "thr_plan2", bbProjectId: "proj_1", hostId: "host_1" });
    await ensureSpecReview(h.ctx, "csv-two");
    const other = h.store.projectBySlug("csv-two")!;
    await h.engine.archive("csv-two", "human");
    expect(h.store.specReviews(other.id)[0]!.state).toBe("superseded");
  });

  it("sends a spec reviewer's idle, archive and failed turn to the spec review, and reconcile fails one that never started", async () => {
    await draft();
    await h.engine.onThreadIdle("thr_w1");
    expect(h.bb.sent("thr_w1")).toEqual([expect.stringContaining("Your turn ended without a verdict on spec v1")]);
    await h.engine.onTurnFailed(makeTurnFailedEvent({ threadId: "thr_w1" }));
    expect(review()).toMatchObject({ state: "failed", reason: "the reviewer ended its turn twice without a verdict" });

    await ensureSpecReview(h.ctx, "csv");
    const second = h.store.specReviews(project().id)[1]!;
    await h.engine.onThreadGone(second.thread_id!, "archived");
    expect(h.store.specReview(second.id)).toMatchObject({ state: "failed", reason: "the reviewer's thread was archived or deleted" });

    const lost = h.store.addSpecReview({ project_id: project().id, version: 1, round: 1, spawn_token: "tok_lost" });
    await h.engine.reconcile();
    expect(h.store.specReview(lost.id)).toMatchObject({ state: "failed", reason: "Loom restarted before the reviewer started" });
  });
});

describe("planning conversations", () => {
  const request = (): NewThreadRequest => ({
    projectId: "proj_1",
    providerId: "codex",
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "auto",
    executionInputSources: {},
    environment: { type: "project-default" },
    input: [{ type: "text", text: "Let people export their orders as CSV.", mentions: [] }],
  });
  const start = async () => (await h.projects.startPlanning({ request: request(), merge: "ask", reviewer: "" })).threadId;
  const open = () => h.store.openPlanning().map((row) => row.thread_id);

  it("ends a planning conversation when its thread is archived or deleted", async () => {
    const archived = await start();
    const deleted = await start();
    await h.engine.onThreadGone(archived, "archived");
    expect(h.store.planning(archived)).toMatchObject({ end_reason: "archived" });
    await h.engine.onThreadGone(deleted, "deleted");
    expect(h.store.planning(deleted)).toMatchObject({ end_reason: "deleted" });
    expect(open()).toEqual([]);
  });

  it("reconcile ends the conversations whose thread bb no longer lists or lists as archived or deleted, and keeps the live ones", async () => {
    const [missing, archived, deleted, live] = [await start(), await start(), await start(), await start()];
    h.bb.threads.delete(missing);
    h.bb.threads.get(archived)!.archivedAt = 5;
    h.bb.threads.get(deleted)!.deletedAt = 5;
    await h.engine.reconcile();
    expect(open()).toEqual([live]);
    for (const threadId of [missing, archived, deleted]) expect(h.store.planning(threadId)).toMatchObject({ end_reason: "gone" });
  });
});

describe("approve", () => {
  const proposeV2 = () =>
    h.projects.propose({
      toml: specToml((doc) => {
        withDocsTicket(doc);
        doc.project.goal = "Let people export their orders as a CSV file, with filters.";
      }),
      threadId: "thr_plan",
      bbProjectId: "proj_1",
      hostId: "host_1",
    });
  const stuck = async () => {
    await seedProject(h, withDocsTicket);
    h.bb.spawnError = (args) => (args.metadata.ticket === "CSV-1" ? new SpawnRefusedError(400, "HTTP 400: Provider pi only supports full permission mode.") : null);
    await h.engine.tick();
    h.bb.spawnError = null;
    await h.engine.block("CSV-3", "needs creds", "human");
    await proposeV2();
    h.kick.mockClear();
  };

  it("approving a pending version requeues the tickets whose worker never started, kicks the loop and tells the planner", async () => {
    await stuck();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", failures: 1 });
    const result = await h.engine.approve("csv", "human", 2);
    expect(result).toMatchObject({ applied: "pending", version: 2, requeued: ["CSV-1"] });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0, blocked_reason: null });
    expect(h.store.posts(ticketOf(h, "CSV-1").id).at(-1)).toMatchObject({
      kind: "reply",
      author_kind: "loom",
      body: "Spec v2 is approved, so Loom queued this ticket again: bb never started its worker.",
    });
    expect(ticketOf(h, "CSV-3").state).toBe("blocked");
    expect(h.kick).toHaveBeenCalled();
    const message = h.bb.sent("thr_plan").at(-1)!;
    expect(message).toContain("[loom] Spec v2 of csv is approved.");
    expect(message).toContain("Loom queued CSV-1 again, because bb never started its worker. Its failure count starts over, and a worker picks it up by itself.");
    expect(message).toContain("Still blocked: CSV-3. Requeue one with loom_requeue when v2 fixes what blocked it.");
  });

  it("approving a pending version sends a ticket whose reviewer bb refused back to review, in a new round for the same head", async () => {
    await seedProject(h, withDocsTicket);
    await reachReview(h);
    h.bb.spawnError = (args) =>
      args.metadata.role === "reviewer" || args.metadata.ticket === "CSV-3" ? new SpawnRefusedError(400, "HTTP 400: Unsupported provider claude") : null;
    await h.engine.tick();
    h.bb.spawnError = null;
    const blocked = ticketOf(h, "CSV-1");
    expect(blocked).toMatchObject({ state: "blocked", blocked_reason: "bb refused to start a reviewer: HTTP 400: Unsupported provider claude", review_round: 1 });
    expect(ticketOf(h, "CSV-3").state).toBe("blocked");
    await proposeV2();
    h.kick.mockClear();

    const result = await h.engine.approve("csv", "human", 2);
    expect(result).toMatchObject({ applied: "pending", requeued: ["CSV-3"], backToReview: ["CSV-1"] });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", review_round: 2, head_sha: blocked.head_sha, branch: blocked.branch, blocked_reason: null });
    expect(h.store.ticketEvents(blocked.id, ["ticket.state"]).at(-1)!.data_json).toContain('"from":"blocked","to":"review"');
    expect(h.store.posts(blocked.id).at(-1)).toMatchObject({
      kind: "reply",
      author_kind: "loom",
      body: "Spec v2 is approved, so Loom sent this ticket back to review: bb refused to start its reviewer, and its work had already passed the checks.",
    });
    expect(ticketOf(h, "CSV-3").state).toBe("queued");
    expect(h.kick).toHaveBeenCalled();
    const message = h.bb.sent("thr_plan").at(-1)!;
    expect(message).toContain("Loom queued CSV-3 again, because bb never started its worker.");
    expect(message).toContain("Loom sent CSV-1 back to review, because bb refused to start its reviewer; new reviewers start for the same commit.");
    expect(message).not.toContain("Still blocked");

    const before = h.bb.callsTo("spawnThread").length;
    await h.engine.tick();
    const reviewers = h.bb.callsTo("spawnThread").slice(before).map(([args]) => (args as SpawnArgs).metadata).filter((metadata) => metadata.role === "reviewer");
    expect(reviewers).toEqual([expect.objectContaining({ ticket: "CSV-1", round: "2" })]);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
  });

  it("leaves a ticket blocked when its reviewers ended without a verdict, even after approving a pending version", async () => {
    await seedProject(h);
    await reachReview(h);
    h.bb.spawnError = (args) => (args.metadata.role === "reviewer" ? new Error("provider is down") : null);
    for (let pass = 0; pass < 4; pass++) await h.engine.tick();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "reviewers ended without a verdict" });
    await proposeV2();
    expect(await h.engine.approve("csv", "human", 2)).toMatchObject({ requeued: [], backToReview: [] });
    expect(ticketOf(h, "CSV-1").state).toBe("blocked");
  });

  it("approving a draft requeues nothing and sends nothing", async () => {
    await h.projects.propose({ toml: specToml(), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    const result = await h.engine.approve("csv", "human");
    expect(result).toMatchObject({ applied: "draft", requeued: [], backToReview: [] });
    expect(h.bb.callsTo("send")).toEqual([]);
  });

  it("still approves when the message to the planner fails", async () => {
    await stuck();
    h.bb.sendError = new Error("thread is busy");
    expect(await h.engine.approve("csv", "human", 2)).toMatchObject({ applied: "pending", requeued: ["CSV-1"] });
    expect(project()).toMatchObject({ approved_version: 2, pending_version: null });
  });
});

describe("human ticket commands", () => {
  it("cancels a ticket in review, ends its worker and archives the thread", async () => {
    await seedProject(h);
    await h.engine.tick();
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "review", "loom");
    const cancelled = await h.engine.cancel("CSV-1", "Dropped", "human");
    expect(cancelled.state).toBe("cancelled");
    expect(workerRows(h, "CSV-1")[0]).toMatchObject({ state: "ended", end_reason: "cancelled" });
    expect(h.bb.callsTo("archive")).toEqual([["thr_w1"]]);
  });

  it("refuses to block or cancel a ticket that is merging, and a ticket that cannot move", async () => {
    await seedProject(h);
    for (const state of ["working", "checking", "review", "approved", "merging"] as const) h.store.setTicketState(ticketOf(h, "CSV-1").id, state, "loom");
    await expect(h.engine.block("CSV-1", "stop", "human")).rejects.toMatchObject({ code: "loom_invalid_state", message: "CSV-1 is merging; try again when the merge finishes." });
    await expect(h.engine.cancel("CSV-1", "stop", "human")).rejects.toMatchObject({ code: "loom_invalid_state" });
    await h.engine.cancel("CSV-2", "x", "human");
    await expect(h.engine.block("CSV-2", "stop", "human")).rejects.toMatchObject({ code: "loom_invalid_state" });
    await expect(h.engine.block("CSV-9", "stop", "human")).rejects.toMatchObject({ code: "loom_not_found" });
    await expect(h.engine.block("CSV-2", "  ", "human")).rejects.toMatchObject({ code: "loom_invalid_input" });
  });

  it("blocks a ticket with a worker: the worker ends, the ticket waits for triage, and a requeue puts it back", async () => {
    await seedProject(h);
    await h.engine.tick();
    await h.engine.block("CSV-1", "Wrong approach", "human");
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "Wrong approach", branch: "wt-thr_w1" });
    expect(project().triage_pending).toBe(1);
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("ended");
    const requeued = await h.engine.requeue("CSV-1", "Use the other approach", "human");
    expect(requeued.state).toBe("queued");
    await h.engine.tick();
    expect(spawned()).toEqual(["CSV-1", "CSV-1"]);
    expect((h.bb.callsTo("spawnThread")[1]![0] as SpawnArgs).prompt).toContain("Use the other approach");
  });

  it("delivers a human reply to the live worker of a working ticket, and only then", async () => {
    await seedProject(h, wide);
    await h.engine.tick();
    const post = await h.engine.humanPost("CSV-1", "Please use the v2 API", undefined);
    expect(post).toMatchObject({ kind: "reply", author_kind: "human", body: "Please use the v2 API" });
    const sent = h.bb.callsTo("send").filter(([id]) => id === "thr_w1");
    expect(sent).toEqual([["thr_w1", { summary: "[loom] Reply on CSV-1 from the human", detail: "Please use the v2 API" }]]);

    const reply = await h.engine.humanPost("CSV-1", "And keep it small", post.id);
    expect(reply.parent_id).toBe(post.id);

    h.store.setTicketState(ticketOf(h, "CSV-3").id, "checking", "loom");
    await h.engine.humanPost("CSV-3", "ok?", undefined);
    await h.engine.humanPost("CSV-2", "no worker yet", undefined);
    expect(h.bb.callsTo("send").filter(([id]) => id === "thr_w2")).toEqual([]);
    expect(h.store.posts(ticketOf(h, "CSV-2").id).at(-1)!.body).toBe("no worker yet");
  });

  it("sends a human reply on a blocked ticket to the planner, with the reply as agent-only detail", async () => {
    await seedProject(h);
    await h.engine.tick();
    await h.engine.block("CSV-1", "Needs the API token", "human");
    const before = h.bb.callsTo("send").length;
    const post = await h.engine.humanPost("CSV-1", "The token is in the vault under loom/csv", undefined);
    await h.engine.humanPost("CSV-1", "Use the read-only one", post.id);
    expect(h.bb.callsTo("send").slice(before)).toEqual([
      [
        "thr_plan",
        {
          summary: "[loom] The human replied on CSV-1, which is blocked. Read it with loom_ticket and answer with your board tools: loom_post, then loom_requeue, loom_edit_ticket or loom_cancel_ticket if the reply settles it.",
          detail: "The token is in the vault under loom/csv",
        },
      ],
      ["thr_plan", expect.objectContaining({ detail: `Use the read-only one (answering #${post.id})` })],
    ]);
  });

  it("still records a reply on a blocked ticket when the planner cannot be messaged", async () => {
    await seedProject(h);
    await h.engine.tick();
    await h.engine.block("CSV-1", "Needs the API token", "human");
    h.bb.sendError = new Error("planner is gone");
    expect((await h.engine.humanPost("CSV-1", "Here it is", undefined)).body).toBe("Here it is");
    expect(h.bb.callsTo("log").some(([level, text]) => level === "warn" && String(text).includes("planner is gone"))).toBe(true);
  });

  it("still records a reply when the worker cannot be messaged", async () => {
    await seedProject(h);
    await h.engine.tick();
    h.bb.sendError = new Error("thread is archived");
    const post = await h.engine.humanPost("CSV-1", "hello", undefined);
    expect(post.body).toBe("hello");
    expect(h.bb.callsTo("log").some(([level, text]) => level === "warn" && String(text).includes("thread is archived"))).toBe(true);
  });

  it("archives a project: workers stop and archive, tickets are cancelled, the section goes", async () => {
    await seedProject(h, wide);
    await h.engine.tick();
    await h.engine.archive("csv", "human");
    expect(project().state).toBe("archived");
    expect(h.store.tickets(project().id).every((ticket) => ticket.state === "cancelled")).toBe(true);
    expect(h.bb.callsTo("stop").map(([id]) => id).sort()).toEqual(["thr_w1", "thr_w2"]);
    expect(h.bb.callsTo("archive").map(([id]) => id).sort()).toEqual(["thr_w1", "thr_w2"]);
    expect(workerRows(h, "CSV-1")[0]).toMatchObject({ state: "ended", end_reason: "cancelled" });
    expect(h.bb.callsTo("deleteSection")).toEqual([["sec_1"]]);
    await h.engine.tick();
    expect(spawned()).toHaveLength(2);
  });

  it("ends the thread of a spawn that was still in flight when its ticket was cancelled", async () => {
    await seedProject(h);
    h.bb.afterSpawn = () => void h.store.setTicketState(ticketOf(h, "CSV-1").id, "cancelled", "human");
    await h.engine.tick();
    expect(workerRows(h, "CSV-1")[0]).toMatchObject({ state: "ended", end_reason: "cancelled" });
    expect(ticketOf(h, "CSV-1").state).toBe("cancelled");
    expect(h.bb.callsTo("archive")).toEqual([["thr_w1"]]);
  });
});

describe("reconcile", () => {
  async function working() {
    await seedProject(h);
    await h.engine.tick();
    return workerRows(h, "CSV-1")[0]!;
  }

  it("adopts a spawning row whose thread exists, and rolls back one whose thread does not", async () => {
    await seedProject(h, wide);
    const [one, three] = [ticketOf(h, "CSV-1"), ticketOf(h, "CSV-3")];
    for (const ticket of [one, three]) h.store.setTicketState(ticket.id, "working", "loom");
    h.store.updateTicket(one.id, { attempt: 1 });
    h.store.updateTicket(three.id, { attempt: 1 });
    const adopt = h.store.addThread({ spawn_token: "tok_adopt", project_id: project().id, ticket_id: one.id, role: "worker", state: "spawning" });
    h.store.addThread({ spawn_token: "tok_lost", project_id: project().id, ticket_id: three.id, role: "worker", state: "spawning" });
    await h.bb.spawnThread({ bbProjectId: "proj_1", hostId: "host_1", baseBranch: "loom/csv", title: "t", prompt: "p", sectionId: null, metadata: { spawnToken: "tok_adopt" } });

    expect(await h.engine.reconcile()).toEqual({ adopted: 1, rolledBack: 1, rechecked: 0 });
    expect(h.store.thread(adopt.id)).toMatchObject({ state: "active", thread_id: "thr_w1", environment_id: "env_1" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", worker_thread_id: "thr_w1" });
    expect(ticketOf(h, "CSV-3")).toMatchObject({ state: "queued", failures: 1 });
    expect(h.store.posts(three.id).at(-1)!.body).toContain("restarted");
  });

  it("ends an active row whose thread is gone or archived, and requeues its ticket without a failure", async () => {
    const row = await working();
    h.bb.threads.get("thr_w1")!.archivedAt = 5;
    await h.engine.reconcile();
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "gone" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 0 });
  });

  it("ends a planner row whose thread was deleted while the plugin was down", async () => {
    await working();
    h.bb.threads.delete("thr_plan");
    await h.engine.reconcile();
    expect(h.store.threadByThreadId("thr_plan")?.state).toBe("ended");
  });

  it("finishes a row left in ending, and runs the checks of a ticket left in checking again", async () => {
    await seedProject(h, wide);
    await h.engine.tick();
    const [first, second] = [workerRows(h, "CSV-1")[0]!, workerRows(h, "CSV-3")[0]!];
    h.store.claimThread(first.id, "abandoned");
    h.host.worktree("/wt/env_2").dirty = true;
    h.store.setTicketState(ticketOf(h, "CSV-3").id, "checking", "loom");

    const result = await h.engine.reconcile();
    expect(result.rechecked).toBe(1);
    await settleChecks(h.ctx);
    expect(h.store.thread(first.id)).toMatchObject({ state: "ended", end_reason: "abandoned" });
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", failures: 1 });
    expect(ticketOf(h, "CSV-3")).toMatchObject({ state: "review", head_sha: "c1" });
    expect(h.store.thread(second.id)?.state).toBe("active");
  });

  it("runs the checks of stranded tickets on every tick, even while the project is paused", async () => {
    await seedProject(h);
    await h.engine.tick();
    await h.engine.pause("csv", "human", false);
    h.host.worktree("/wt/env_1").dirty = true;
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "checking", "loom");
    await h.engine.tick();
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
  });

  it("retries a row stuck in ending on each tick", async () => {
    await seedProject(h);
    await h.engine.tick();
    const row = workerRows(h, "CSV-1")[0]!;
    h.bb.stopConfirms = false;
    h.clock.advance(121 * 60_000);
    await h.engine.tick();
    expect(h.store.thread(row.id)?.state).toBe("ending");
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    h.bb.stopConfirms = true;
    await h.engine.tick();
    expect(h.store.thread(row.id)?.state).toBe("ended");
    expect(workerRows(h, "CSV-1")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- review and merge

const roles = () => h.bb.callsTo("spawnThread").map(([args]) => `${(args as SpawnArgs).metadata.role}:${(args as SpawnArgs).metadata.ticket}`);
const reviewerRows = (key: string) => h.store.threads({ ticketId: ticketOf(h, key).id, role: "reviewer" });
const prProject = (doc: Doc) => {
  withDocsTicket(doc);
  doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0 };
};

describe("tick: review and merge", () => {
  it("starts reviewers for a ticket in review before it spawns workers", async () => {
    await seedProject(h, (doc) => withDocsTicket(doc));
    await reachReview(h, "CSV-1");
    await h.engine.tick();
    expect(roles()).toEqual(["worker:CSV-1", "reviewer:CSV-1", "worker:CSV-3"]);
  });

  it("goes from submit to a merged ticket, and then the dependent ticket's worker starts from the integration branch", async () => {
    await seedProject(h, (doc) => (doc.checks.after_merge = ["npm run e2e"]));
    await h.engine.tick();
    expect(roles()).toEqual(["worker:CSV-1"]);
    h.host.worktree("/wt/env_1").dirty = true;
    submit(h.ctx, "thr_w1", "Mapped orders");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("review");

    await h.engine.tick();
    expect(roles()).toEqual(["worker:CSV-1", "reviewer:CSV-1"]);
    checkOutHead(h, reviewerRows("CSV-1")[0]!);
    await approve(h.ctx, "thr_w2", "Every criterion holds");
    await settleReviews(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("approved");
    expect(roles()).toHaveLength(2);

    await h.engine.tick();
    await settleMerges(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(h.host.callsTo("merge")).toEqual([{ worktree: "/data/worktrees/csv", ref: "c1", message: "CSV-1: Order rows (Loom)", before: "base000" }]);
    expect(h.host.callsTo("exec").at(-1)).toMatchObject({ cwd: "/data/worktrees/csv", command: "npm run e2e" });

    await h.engine.tick();
    expect(roles()).toEqual(["worker:CSV-1", "reviewer:CSV-1", "worker:CSV-2"]);
    expect((h.bb.callsTo("spawnThread")[2]![0] as SpawnArgs).baseBranch).toBe("loom/csv");
  });

  it("starts no worker while a ticket is merging on the integration strategy, and starts it once the merge is over", async () => {
    await seedProject(h, withDocsTicket);
    await reachApproved(h, "CSV-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const call = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: unknown) => {
      if (method === "merge") await gate;
      return call(hostId, method as never, input as never);
    }) as typeof h.host.call;

    await h.engine.tick();
    expect(ticketOf(h, "CSV-1").state).toBe("merging");
    expect(roles().filter((role) => role.startsWith("worker"))).toEqual(["worker:CSV-1"]);
    await h.engine.tick();
    expect(roles().filter((role) => role.startsWith("worker"))).toEqual(["worker:CSV-1"]);

    release();
    await settleMerges(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    await h.engine.tick();
    expect(roles()).toContain("worker:CSV-3");
  });

  it("starts workers in other repos while a ticket of one repo is merging, and holds back the workers of that repo until the merge is over", async () => {
    await seedRepoProject(h, (doc) => doc.ticket.push({ ref: "web-docs", title: "Web docs", body: "Write the docs.", acceptance: ["WHEN the docs are built THE SYSTEM SHALL list the export"], scope: ["docs/**"], repo: "web" }));
    await reachApproved(h, "CSV-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const call = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: unknown) => {
      if (method === "merge") await gate;
      return call(hostId, method as never, input as never);
    }) as typeof h.host.call;
    const workers = () => roles().filter((role) => role.startsWith("worker"));

    await h.engine.tick();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "merging", repo: "web" });
    expect(workers()).toEqual(["worker:CSV-1", "worker:CSV-2"]);
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", repo: "api" });
    await h.engine.tick();
    expect(ticketOf(h, "CSV-3")).toMatchObject({ state: "queued", repo: "web" });
    expect(workers()).toEqual(["worker:CSV-1", "worker:CSV-2"]);

    release();
    await settleMerges(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    await h.engine.tick();
    expect(workers()).toEqual(["worker:CSV-1", "worker:CSV-2", "worker:CSV-3"]);
  });

  it("gives a free worker slot to a ticket of another repo when a ticket of the merging repo ranks ahead of it", async () => {
    await seedRepoProject(h, (doc) => {
      doc.agents.max_workers = 1;
      doc.ticket.push({ ref: "web-docs", title: "Web docs", body: "Write the docs.", acceptance: ["WHEN the docs are built THE SYSTEM SHALL list the export"], scope: ["docs/**"], repo: "web" });
    });
    await reachApproved(h, "CSV-1");
    h.store.updateTicket(ticketOf(h, "CSV-3").id, { priority: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const call = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: unknown) => {
      if (method === "merge") await gate;
      return call(hostId, method as never, input as never);
    }) as typeof h.host.call;

    await h.engine.tick();
    expect(ticketOf(h, "CSV-1").state).toBe("merging");
    expect(ticketOf(h, "CSV-3")).toMatchObject({ state: "queued", repo: "web", priority: 1 });
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "working", repo: "api" });
    expect(roles().filter((role) => role.startsWith("worker"))).toEqual(["worker:CSV-1", "worker:CSV-2"]);
    release();
    await settleMerges(h.ctx);
  });

  it("starts no worker in any repo while the merge guard is held with no ticket merging", async () => {
    await seedRepoProject(h);
    const release = holdMerge(h.ctx, project().id)!;
    await h.engine.tick();
    expect(roles()).toEqual([]);
    release();
    await h.engine.tick();
    expect(roles()).toEqual(["worker:CSV-1", "worker:CSV-2"]);
  });

  it("starts no worker while a direct land holds the merge guard on the integration strategy, and starts it once the land is over", async () => {
    await seedProject(h, withDocsTicket);
    await reachApproved(h, "CSV-1");
    const release = holdMerge(h.ctx, h.store.projectBySlug("csv")!.id)!;

    await h.engine.tick();
    await h.engine.tick();
    expect(roles().filter((role) => role.startsWith("worker"))).toEqual(["worker:CSV-1"]);

    release();
    await h.engine.tick();
    await settleMerges(h.ctx);
    await h.engine.tick();
    expect(roles()).toContain("worker:CSV-3");
  });

  it("keeps spawning workers while a pull request ticket is merging", async () => {
    await seedProject(h, prProject);
    await reachApproved(h, "CSV-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const call = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: unknown) => {
      if (method === "push") await gate;
      return call(hostId, method as never, input as never);
    }) as typeof h.host.call;

    await h.engine.tick();
    expect(ticketOf(h, "CSV-1").state).toBe("merging");
    expect(roles().filter((role) => role.startsWith("worker"))).toEqual(["worker:CSV-1", "worker:CSV-3"]);
    release();
    await settleMerges(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("pr_open");
  });

  it("does not spawn reviewers or merge for a paused project, but polls its pull requests and finishes it when the last one merges", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0 }));
    await reachApproved(h, "CSV-1");
    await h.engine.tick();
    await settleMerges(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("pr_open");
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "cancelled", "human");
    await h.engine.pause("csv", "human", false);

    h.host.prStates.set("https://github.com/acme/shop/pull/1", "OPEN");
    h.clock.advance(5 * 60_000);
    await h.engine.tick();
    expect(h.host.callsTo("prState")).toHaveLength(1);
    expect(project().state).toBe("paused");

    h.host.prStates.set("https://github.com/acme/shop/pull/1", "MERGED");
    h.clock.advance(5 * 60_000);
    await h.engine.tick();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(project().state).toBe("done");
    await h.engine.tick();
    expect(h.host.callsTo("prState")).toHaveLength(2);
  });

  it("does not start reviewers or merges while the project is paused", async () => {
    await seedProject(h, withDocsTicket);
    await reachReview(h, "CSV-1");
    await reachApproved(h, "CSV-3");
    const before = roles().length;
    await h.engine.pause("csv", "human", false);
    await h.engine.tick();
    await settleMerges(h.ctx);
    expect(roles()).toHaveLength(before);
    expect(ticketOf(h, "CSV-3").state).toBe("approved");
    expect(h.host.callsTo("merge")).toEqual([]);
  });

  it("moves a pull request project to done in the same pass that sees its last ticket finish", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0 }));
    for (const key of ["CSV-1", "CSV-2"]) h.store.setTicketState(ticketOf(h, key).id, "cancelled", "human");
    await h.engine.tick();
    expect(project().state).toBe("done");
    expect(h.bb.callsTo("deleteSection")).toEqual([["sec_1"]]);
    expect(project().section_id).toBeNull();
  });

  it("removes a done project's section on the next pass, and a running project's never", async () => {
    await seedProject(h);
    await h.engine.tick();
    expect(h.bb.callsTo("deleteSection")).toEqual([]);
    h.store.setProjectState(project().id, "done", "loom");
    await h.engine.tick();
    expect(h.bb.callsTo("deleteSection")).toEqual([["sec_1"]]);
    expect(project().section_id).toBeNull();
    await h.engine.tick();
    expect(h.bb.callsTo("deleteSection")).toHaveLength(1);
  });

  it("tries a refused section deletion again on the next pass", async () => {
    await seedProject(h);
    h.store.setProjectState(project().id, "done", "loom");
    h.bb.deleteSectionError = new Error("bb is down");
    await h.engine.tick();
    expect(project().section_id).toBe("sec_1");
    expect(h.bb.callsTo("log").some(([level, text]) => level === "warn" && String(text).includes("Could not delete the project's section"))).toBe(true);
    h.bb.deleteSectionError = null;
    await h.engine.tick();
    expect(project().section_id).toBeNull();
    expect(h.bb.sections.has("sec_1")).toBe(false);
  });
});

describe("reviewer events", () => {
  async function reviewing() {
    await seedProject(h);
    await reachReview(h, "CSV-1");
    await h.engine.tick();
    return reviewerRows("CSV-1")[0]!;
  }

  it("nudges an idle reviewer, then ends it, and the next tick starts a replacement", async () => {
    const row = await reviewing();
    await h.engine.onThreadIdle(row.thread_id!);
    expect(h.bb.sent(row.thread_id!)[0]).toContain("without a verdict");
    await h.engine.onThreadIdle(row.thread_id!);
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "abandoned" });
    await h.engine.tick();
    expect(reviewerRows("CSV-1")).toHaveLength(2);
  });

  it("ends a reviewer whose thread was archived without saving anything from its worktree", async () => {
    const row = await reviewing();
    const commits = h.host.callsTo("commitAll").length;
    await h.engine.onThreadGone(row.thread_id!, "archived");
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "gone" });
    expect(h.host.callsTo("commitAll")).toHaveLength(commits);
  });

  it("counts a failed turn as an idle, and retries a rate-limited one", async () => {
    const row = await reviewing();
    await h.engine.onTurnFailed(makeTurnFailedEvent({ threadId: row.thread_id!, requestId: "req_1", errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null } }));
    expect(h.bb.callsTo("retryTurn")).toHaveLength(1);
    expect(h.store.thread(row.id)!.idle_count).toBe(0);
    await h.engine.onTurnFailed(makeTurnFailedEvent({ threadId: row.thread_id!, requestId: "req_2", errorInfo: { category: "internal", httpStatusCode: 500, providerCode: null } }));
    expect(h.bb.sent(row.thread_id!)[0]).toContain("without a verdict");
    expect(h.store.thread(row.id)!.idle_count).toBe(1);
  });

  it("finishes a reviewer left in ending without saving anything from its worktree", async () => {
    const row = await reviewing();
    h.store.claimThread(row.id, "verdict");
    const commits = h.host.callsTo("commitAll").length;
    await h.engine.tick();
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "verdict" });
    expect(h.host.callsTo("commitAll")).toHaveLength(commits);
  });
});

describe("human block and cancel while a merge runs", () => {
  it("refuses both while the merge guard is held, changes nothing, and works again once it is released", async () => {
    await seedProject(h);
    await reachReview(h, "CSV-1");
    const release = holdMerge(h.ctx, project().id)!;
    await expect(h.engine.block("CSV-1", "stop", "human")).rejects.toMatchObject({ code: "loom_invalid_state", message: expect.stringContaining("a merge is running; try again in a moment") });
    await expect(h.engine.cancel("CSV-1", "stop", "human")).rejects.toMatchObject({ code: "loom_invalid_state", message: expect.stringContaining("a merge is running; try again in a moment") });
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("active");
    release();

    const blocked = await h.engine.block("CSV-1", "stop", "human");
    expect(blocked.state).toBe("blocked");
    expect(holdMerge(h.ctx, project().id)).not.toBeNull();
  });

  it("releases the guard when the command fails", async () => {
    await seedProject(h);
    await expect(h.engine.block("CSV-1", "  ", "human")).rejects.toMatchObject({ code: "loom_invalid_input" });
    await expect(h.engine.cancel("CSV-9", "x", "human")).rejects.toMatchObject({ code: "loom_not_found" });
    expect(holdMerge(h.ctx, project().id)).not.toBeNull();
  });
});

describe("reconcile: review and merge", () => {
  it("adopts a reviewer spawning row whose thread exists, and rolls back one whose thread does not, marking only the threads row", async () => {
    await seedProject(h, (doc) => (doc.review = { approvals: 2 }));
    await reachReview(h, "CSV-1");
    const ticket = ticketOf(h, "CSV-1");
    const adopt = h.store.addThread({ spawn_token: "tok_adopt", project_id: project().id, ticket_id: ticket.id, role: "reviewer", state: "spawning" });
    const lost = h.store.addThread({ spawn_token: "tok_lost", project_id: project().id, ticket_id: ticket.id, role: "reviewer", state: "spawning" });
    for (const row of [adopt, lost]) {
      h.store.updateThread(row.id, { review_round: ticket.review_round });
      h.store.addReview({ ticket_id: ticket.id, round: ticket.review_round, thread_row_id: row.id });
    }
    await h.bb.spawnThread({ bbProjectId: "proj_1", hostId: "host_1", baseBranch: "b", title: "t", prompt: "p", sectionId: null, metadata: { spawnToken: "tok_adopt" } });

    expect(await h.engine.reconcile()).toEqual({ adopted: 1, rolledBack: 1, rechecked: 0 });
    expect(h.store.thread(adopt.id)).toMatchObject({ state: "active", thread_id: "thr_w2", environment_id: "env_2" });
    expect(h.store.thread(lost.id)).toMatchObject({ state: "ended", end_reason: "failed" });
    expect(h.store.reviews(ticket.id).map((review) => review.verdict)).toEqual(["pending", "pending"]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", failures: 0 });
  });

  it("ends a reviewer row whose thread was archived while the plugin was down, without saving its worktree", async () => {
    await seedProject(h);
    await reachReview(h, "CSV-1");
    await h.engine.tick();
    const row = reviewerRows("CSV-1")[0]!;
    h.bb.threads.get(row.thread_id!)!.archivedAt = 5;
    const commits = h.host.callsTo("commitAll").length;
    await h.engine.reconcile();
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "gone" });
    expect(h.host.callsTo("commitAll")).toHaveLength(commits);
  });

  it("runs a ticket left in merging again, without waiting for the merge", async () => {
    await seedProject(h);
    await reachApproved(h, "CSV-1");
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "merging", "loom");
    await h.engine.reconcile();
    await settleMerges(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("done");
  });
});

describe("land", () => {
  it("delegates to the merge module and kicks the loop", async () => {
    await seedProject(h);
    await reachApproved(h, "CSV-1");
    await h.engine.tick();
    await settleMerges(h.ctx);
    h.kick.mockClear();
    const result = await h.engine.land("csv", "human", { ready: false });
    expect(result).toEqual({ url: "https://github.com/acme/shop/pull/1", done: false });
    expect(h.kick).toHaveBeenCalled();
  });
});
