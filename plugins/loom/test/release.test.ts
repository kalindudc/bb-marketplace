import { makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { SpawnUnavailableError, type SpawnArgs } from "../src/ports";
import { RESTORED_NOTE } from "../src/prompts";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { advanceWakes, isReleased, isWaking, releaseIdleWorkers, wakeForRestacks } from "../src/release";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { boardCards } from "../src/rpc";
import { deliverHandBacks } from "../src/slots";
import { parseSpec } from "../src/spec";
import { waitOf } from "../src/starts";
import { onThreadGone, onTurnFailed, onWorkerIdle, RELEASED_TEXT, specOf } from "../src/workers";
import { checkOutHead, makeCtx, makeEngine, reachApproved, seedProject, specToml, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = (key = "CSV-1") => ticketOf(h, key);
const row = (id: number) => h.store.thread(id)!;
const pr = (more: Doc = {}) => (doc: Doc) => (doc.merge = { strategy: "pr", ...more });
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const release = () => releaseIdleWorkers(h.ctx, project(), spec());
const spawned = () => h.bb.callsTo("spawnThread").map(([args]) => args as SpawnArgs);
const changesRequested = { items: [{ key: "review:1:a", kind: "review" as const, author: "alice", bot: false, body: "Rename the column.", url: null, state: "changes_requested", path: null, line: null }] };

/** CSV-1's pull request is open, and its worker sits idle in a clean worktree at the reviewed commit. */
async function openPr(more: Doc = {}): Promise<ThreadRow> {
  await seedProject(h, pr(more));
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Why.", commit_message: "Add the order row mapper" });
  await queue();
  expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL });
  h.bb.threads.get(worker.thread_id!)!.status = "idle";
  return row(worker.id);
}

/** Released, and bb has since torn the environment down. */
async function released(more: Doc = {}): Promise<ThreadRow> {
  const worker = await openPr(more);
  await release();
  expect(isReleased(row(worker.id))).toBe(true);
  h.bb.environments.get(worker.environment_id!)!.status = "destroyed";
  return row(worker.id);
}

/** The worktree bb restores holds the worker's branch as the released one had it. */
function restoredWorktree(worker: ThreadRow): string {
  const path = `/wt/${row(worker.id).environment_id}`;
  h.host.worktrees.set(path, { ...h.host.worktree(`/wt/${worker.environment_id}`) });
  return path;
}

describe("releasing the worker of an open pull request", () => {
  it("archives the idle worker's thread, keeps it as the ticket's worker, and frees its environment", async () => {
    const worker = await openPr();
    await release();
    expect(h.bb.callsTo("archive")).toContainEqual([worker.thread_id]);
    expect(row(worker.id)).toMatchObject({ state: "ended", end_reason: "released", released_at: h.clock.t });
    expect(ticket()).toMatchObject({ state: "pr_open", worker_thread_id: worker.thread_id, environment_id: null });
    expect(h.store.posts(ticket().id).at(-1)).toMatchObject({ kind: "system", body: RELEASED_TEXT });
    // The archive's own event is not the human archiving the worker.
    await onThreadGone(h.ctx, worker.thread_id!);
    expect(row(worker.id).end_reason).toBe("released");
  });

  it("is started by the engine's tick, and keeps following the pull request", async () => {
    const e = makeEngine();
    h = e;
    const worker = await openPr();
    await e.engine.tick();
    expect(isReleased(row(worker.id))).toBe(true);
    h.host.prStates.set(URL, "MERGED");
    h.clock.advance(5 * 60_000);
    await e.engine.tick();
    expect(ticket().state).toBe("done");
    expect(row(worker.id).end_reason).toBe("released");
  });

  it("keeps the worker when the spec sets merge.release_workers = false, as before", async () => {
    const worker = await openPr({ release_workers: false });
    await release();
    expect(row(worker.id)).toMatchObject({ state: "active", released_at: null });
    expect(h.bb.callsTo("archive")).not.toContainEqual([worker.thread_id]);
  });

  it("follows merge.release_workers in a version approved after the project started, either way", async () => {
    const worker = await openPr();
    const propose = (value: boolean) => h.projects.propose({ toml: specToml((doc) => (doc.merge = { strategy: "pr", release_workers: value })), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    expect(await propose(false)).toMatchObject({ pending: true, version: 2 });
    await h.projects.approve("csv", "human", 2);
    await release();
    expect(row(worker.id)).toMatchObject({ state: "active", released_at: null });

    await propose(true);
    await h.projects.approve("csv", "human", 3);
    await release();
    expect(isReleased(row(worker.id))).toBe(true);
  });

  it("keeps a worker that is busy, waits on the human, has a fix round on its way, or has work beyond the reviewed commit", async () => {
    const worker = await openPr();
    const thread = h.bb.threads.get(worker.thread_id!)!;
    const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
    const kept = async () => {
      await release();
      expect(row(worker.id).state).toBe("active");
    };
    thread.status = "active";
    await kept();
    thread.status = "idle";
    h.bb.waiting.add(worker.thread_id!);
    await kept();
    h.bb.waiting.clear();
    h.store.updateTicket(ticket().id, { handback_json: JSON.stringify({ thread: worker.thread_id, text: { summary: "s", detail: "d" } }) });
    await kept();
    h.store.updateTicket(ticket().id, { handback_json: null });
    worktree.dirty = true;
    await kept();
    worktree.dirty = false;
    worktree.head = "c9";
    await kept();
    worktree.head = ticket().head_sha!;
    await release();
    expect(isReleased(row(worker.id))).toBe(true);
  });

  it("refuses merge.release_workers on the integration strategy", () => {
    const result = parseSpec(specToml((doc) => (doc.merge = { strategy: "integration", release_workers: true })));
    expect(result.errors).toContain('merge.release_workers: it applies to the pull request Loom opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".');
  });
});

describe("bringing the worker back for a fix round", () => {
  it("unarchives the same thread, restores its environment, then sends the round with what the restore means", async () => {
    const worker = await released();
    h.host.feedback.set(URL, changesRequested);
    await poll();

    expect(h.bb.callsTo("unarchive")).toEqual([[worker.thread_id]]);
    expect(h.bb.callsTo("restoreEnvironment")).toEqual([[worker.thread_id]]);
    expect(row(worker.id)).toMatchObject({ state: "active", released_at: null, environment_id: "env_r1" });
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1, worker_thread_id: worker.thread_id, environment_id: "env_r1" });
    expect(h.store.posts(ticket().id).at(-1)!.body).toBe(`The worker's thread is back, with a new environment on its branch ${ticket().branch}.`);

    await deliverHandBacks(h.ctx, project().id);
    const message = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(message).toContain(RESTORED_NOTE);
    expect(message).toContain("Rename the column.");
    expect(spawned().filter((args) => args.metadata.role === "worker")).toHaveLength(1);

    // The same worker fixes it in its new worktree, and Loom pushes the fix as before.
    const worktree = h.host.worktree(restoredWorktree(worker));
    worktree.dirty = true;
    submit(h.ctx, worker.thread_id!, "Renamed the column.");
    await settleChecks(h.ctx);
    expect(h.host.callsTo("commitAll").at(-1)).toMatchObject({ worktree: "/wt/env_r1" });
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "The fix holds.");
    await settleReviews(h.ctx);
    await askForPrTexts(h.ctx, project(), spec());
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename the column" });
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pushed_sha: "sq2" });
  });

  it("waits for a restore that is still running: no message, no nudge, until the environment is ready", async () => {
    const worker = await released();
    h.bb.restoreResult = "provisioning";
    h.host.feedback.set(URL, changesRequested);
    await poll();
    expect(isWaking(row(worker.id))).toBe(true);
    await deliverHandBacks(h.ctx, project().id);
    await onWorkerIdle(h.ctx, row(worker.id));
    await onTurnFailed(h.ctx, makeTurnFailedEvent({ threadId: worker.thread_id!, requestId: "req_1" }));
    expect(h.bb.sent(worker.thread_id!).filter((text) => text.includes("Rename the column") || text.includes("your turn ended"))).toEqual([]);
    expect(row(worker.id).state).toBe("active");

    h.bb.environments.get("env_r1")!.status = "ready";
    h.bb.threads.get(worker.thread_id!)!.status = "idle";
    await advanceWakes(h.ctx, project().id);
    await deliverHandBacks(h.ctx, project().id);
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Rename the column.");
  });

  it("uses the environment as it is when the thread comes back before bb tore it down", async () => {
    const worker = await openPr();
    await release();
    h.host.feedback.set(URL, changesRequested);
    await poll();
    expect(h.bb.callsTo("restoreEnvironment")).toEqual([]);
    expect(row(worker.id)).toMatchObject({ state: "active", released_at: null, environment_id: worker.environment_id });
  });

  it("brings the worker back for the human's reply on the ticket", async () => {
    const e = makeEngine();
    h = e;
    const worker = await released();
    await e.engine.humanPost("CSV-1", "Please also rename the header.");
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
    expect(row(worker.id)).toMatchObject({ state: "active", released_at: null });
    await deliverHandBacks(h.ctx, project().id);
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Please also rename the header.");
  });

  it("waits and tries again when the restore fails, then hands the round to a new worker after four failures in a row", async () => {
    const worker = await released();
    h.bb.restoreResult = new Error("the provider is out of room");
    h.host.feedback.set(URL, changesRequested);
    await poll();
    expect(row(worker.id)).toMatchObject({ state: "ended", end_reason: "released" });
    expect(ticket()).toMatchObject({ state: "working", worker_thread_id: worker.thread_id });
    expect(waitOf(ticket())).toMatchObject({ role: "worker", tries: 1, reason: "the provider is out of room" });
    expect(h.store.posts(ticket().id).at(-1)!.body).toBe("Could not bring the worker's environment back: the provider is out of room. Loom tries again in 1m; after 4 failures in a row a new worker takes over from the branch.");
    await advanceWakes(h.ctx, project().id);
    expect(h.bb.callsTo("restoreEnvironment")).toHaveLength(1);

    for (let n = 0; n < 3; n++) {
      h.clock.advance(waitOf(ticket())!.until - h.clock.t);
      await advanceWakes(h.ctx, project().id);
    }
    expect(h.bb.callsTo("restoreEnvironment")).toHaveLength(4);
    expect(row(worker.id)).toMatchObject({ state: "ended", end_reason: "gone" });
    expect(ticket()).toMatchObject({ state: "queued", worker_thread_id: null, handback_json: null, failures: 0 });

    const next = await startWorker(h);
    expect(next.thread_id).not.toBe(worker.thread_id);
    const brief = spawned().at(-1)!.prompt;
    expect(brief).toContain(`read the newest with \`bb thread log ${worker.thread_id} --all\``);
    expect(brief).toContain("Rename the column.");
    expect(spawned().at(-1)!.baseBranch).toBe(ticket().branch);
  });

  it("shows the wait on the board while the worker cannot come back, and not once it is back", async () => {
    const worker = await released();
    h.bb.restoreResult = new SpawnUnavailableError("No free slot.");
    h.host.feedback.set(URL, changesRequested);
    await poll();
    const card = () => boardCards(h.store.tickets(project().id), h.store.threadsForProject(project().id), spec()).find((each) => each.key === "CSV-1")!;
    expect(card().startWait).toMatchObject({ role: "worker", reason: "No free slot.", unavailable: true });
    h.bb.restoreResult = "ready";
    h.clock.advance(waitOf(ticket())!.until - h.clock.t);
    await advanceWakes(h.ctx, project().id);
    expect(row(worker.id)).toMatchObject({ state: "active", released_at: null });
    expect(card().startWait).toBeNull();
  });

  it("waits for a provider that says it is unavailable, counting nothing, and blocks the ticket after an hour", async () => {
    const worker = await released();
    h.bb.restoreResult = new SpawnUnavailableError("No free slot.");
    h.host.feedback.set(URL, changesRequested);
    await poll();
    for (let n = 0; n < 6; n++) {
      h.clock.advance(waitOf(ticket())!.until - h.clock.t);
      await advanceWakes(h.ctx, project().id);
    }
    expect(row(worker.id)).toMatchObject({ state: "ended", end_reason: "released" });
    expect(ticket()).toMatchObject({ state: "working", failures: 0 });
    expect(waitOf(ticket())).toMatchObject({ kind: "unavailable", tries: 7 });

    h.clock.advance(waitOf(ticket())!.until - h.clock.t);
    await advanceWakes(h.ctx, project().id);
    expect(ticket()).toMatchObject({ state: "blocked", failures: 0, worker_thread_id: null, blocked_reason: "the worker could not come back: the environment provider was unavailable for 1h: No free slot." });
    expect(project().triage_pending).toBe(1);
    expect(row(worker.id).end_reason).toBe("gone");
  });

  it("treats a restore whose provisioning failed as a failed restore", async () => {
    const worker = await released();
    h.bb.restoreResult = "provisioning";
    h.host.feedback.set(URL, changesRequested);
    await poll();
    h.bb.threads.get(worker.thread_id!)!.status = "error";
    h.bb.environments.get("env_r1")!.status = "error";
    h.bb.systemErrors.set(worker.thread_id!, { code: "thread_provisioning_failed", message: "Provisioning thread failed", detail: "No free slot." });
    await advanceWakes(h.ctx, project().id);
    expect(row(worker.id)).toMatchObject({ state: "ended", end_reason: "released" });
    expect(waitOf(ticket())).toMatchObject({ reason: "No free slot." });
  });

  it("hands the round to a new worker at once when bb cannot restore the environment, or the thread is gone", async () => {
    let worker = await released();
    h.bb.restorable = false;
    h.host.feedback.set(URL, changesRequested);
    await poll();
    expect(row(worker.id)).toMatchObject({ state: "ended", end_reason: "gone" });
    expect(ticket()).toMatchObject({ state: "queued", worker_thread_id: null });
    expect(h.store.posts(ticket().id).at(-1)!.body).toContain("The worker's thread cannot come back with an environment (bb cannot restore its environment)");

    h = makeCtx();
    worker = await released();
    h.bb.threads.delete(worker.thread_id!);
    h.host.feedback.set(URL, changesRequested);
    await poll();
    expect(ticket()).toMatchObject({ state: "queued", worker_thread_id: null });
  });

  it("skips a waking worker in a restart's reconcile, pause --now and resume", async () => {
    const e = makeEngine();
    h = e;
    const worker = await released();
    h.bb.restoreResult = "provisioning";
    h.host.feedback.set(URL, changesRequested);
    await poll();
    expect(isWaking(row(worker.id))).toBe(true);
    h.bb.threads.get(worker.thread_id!)!.archivedAt = 5;
    await e.engine.reconcile();
    expect(isWaking(row(worker.id))).toBe(true);
    h.bb.threads.get(worker.thread_id!)!.archivedAt = null;
    const stops = h.bb.callsTo("stop").length;
    await e.engine.pause("csv", "human", true);
    expect(h.bb.callsTo("stop").slice(stops).map(([id]) => id)).not.toContain(worker.thread_id);
    await e.engine.resume("csv", "human");
    expect(h.bb.sent(worker.thread_id!).filter((text) => text.includes("The project resumed"))).toEqual([]);
  });
});

describe("bringing the worker back to catch a stacked pull request up", () => {
  const stackedPr = (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom" });

  async function stackedAndReleased() {
    await seedProject(h, stackedPr);
    await reachApproved(h, "CSV-1");
    await queue();
    const worker = await reachApproved(h, "CSV-2");
    await queue();
    expect(ticket("CSV-2").state).toBe("pr_open");
    h.bb.threads.get(worker.thread_id!)!.status = "idle";
    await release();
    expect(isReleased(row(worker.id))).toBe(true);
    h.bb.environments.get(worker.environment_id!)!.status = "destroyed";
    return row(worker.id);
  }

  it("does not release a worker whose branch must catch up, and wakes a released one when it must, with no message", async () => {
    const worker = await stackedAndReleased();
    const sent = h.bb.sent(worker.thread_id!).length;
    h.store.updateTicket(ticket("CSV-1").id, { pushed_sha: "sq7" });
    await release();
    await wakeForRestacks(h.ctx, project(), spec());
    expect(row(worker.id)).toMatchObject({ state: "active", released_at: null, environment_id: "env_r1" });
    restoredWorktree(worker);
    await queue();

    expect(h.host.callsTo("merge").at(-1)).toMatchObject({ worktree: "/wt/env_r1", ref: "sq7" });
    expect(ticket("CSV-2")).toMatchObject({ state: "pr_open", head_sha: "m1" });
    expect(h.bb.sent(worker.thread_id!)).toHaveLength(sent);
    // Caught up, the worker is released again.
    h.host.worktree("/wt/env_r1").head = "m1";
    await release();
    expect(isReleased(row(worker.id))).toBe(true);
  });

  it("sends a failing check in the restored worktree back to the worker with what the restore means, counting no failure", async () => {
    const worker = await stackedAndReleased();
    h.store.updateTicket(ticket("CSV-1").id, { pushed_sha: "sq7" });
    await wakeForRestacks(h.ctx, project(), spec());
    restoredWorktree(worker);
    h.host.execResults = [{ exitCode: 1, output: "Cannot find module 'vitest'" }];
    await queue();
    expect(ticket("CSV-2")).toMatchObject({ state: "working", check_failures: 0 });
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain(RESTORED_NOTE);
  });

  it("hands the catch-up to a new worker when the thread cannot come back", async () => {
    const worker = await stackedAndReleased();
    h.bb.restorable = false;
    h.store.updateTicket(ticket("CSV-1").id, { pushed_sha: "sq7" });
    await wakeForRestacks(h.ctx, project(), spec());
    expect(row(worker.id).end_reason).toBe("gone");
    expect(ticket("CSV-2")).toMatchObject({ state: "queued", worker_thread_id: null });
  });
});
