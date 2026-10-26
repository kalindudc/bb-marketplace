import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { projectHealth } from "../src/health";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import type { SpawnArgs } from "../src/ports";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { isReleased, releaseIdleWorkers } from "../src/release";
import { requestChanges, spawnReviewers, type Finding } from "../src/review";
import { boardCards } from "../src/rpc";
import { freeWorkerSlots, slotTurns, toLite, waitsForSlot, workerSlots, type TicketLite } from "../src/scheduler";
import { deliverHandBacks } from "../src/slots";
import { specOf } from "../src/workers";
import { metrics } from "./fixtures";
import { checkOutHead, makeEngine, reachApproved, reachReview, seedProject, startWorker, ticketOf, withDocsTicket, type Doc } from "./helpers";

let h: ReturnType<typeof makeEngine>;
beforeEach(() => {
  h = makeEngine();
});

const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = (key: string) => ticketOf(h, key);
const workerOf = (key: string): ThreadRow => h.store.threads({ ticketId: ticket(key).id, role: "worker" }).at(-1)!;
const sentTo = (key: string, text: string) => h.bb.sent(workerOf(key).thread_id!).filter((message) => message.includes(text));
const fixRounds = (key: string) => sentTo(key, "needs fixes (fix round");
const workerSpawns = () => h.bb.callsTo("spawnThread").filter(([args]) => (args as SpawnArgs).metadata.role === "worker").map(([args]) => (args as SpawnArgs).metadata.ticket);
const reviewerSpawns = () => h.bb.callsTo("spawnThread").filter(([args]) => (args as SpawnArgs).metadata.role === "reviewer").map(([args]) => (args as SpawnArgs).metadata.ticket);
const findings: Finding[] = [{ severity: "blocking", title: "The header row is missing", detail: "An empty export has no header." }];
const TEXT = { title: "Add order rows", body: "## Why\nSupport wants CSV exports.", commit_message: "Add the order row mapper" };

/** A fourth ticket, CSV-4, whose scope overlaps none of the others. */
const withApiTicket = (doc: Doc) =>
  doc.ticket.push({ ref: "csv-api", title: "API", body: "Serve the rows over the API.", acceptance: ["WHEN the API is called THE SYSTEM SHALL return the rows"], scope: ["api/**"] });

/** Four tickets with no dependencies and no overlapping scope, and at most `maxWorkers` workers at once. */
async function seed(maxWorkers: number, edit?: (doc: Doc) => void) {
  await seedProject(h, (doc) => {
    withDocsTicket(doc);
    withApiTicket(doc);
    doc.ticket[1].depends_on = [];
    doc.agents.max_workers = maxWorkers;
    edit?.(doc);
  });
}

const pr = (doc: Doc) => (doc.merge = { strategy: "pr" });

/** Each ticket's pull request is opened in turn, so its worker waits on it and holds no slot; CSV-n's is pull/n. */
async function openPrs(keys: string[]): Promise<void> {
  for (const key of keys) {
    const worker = await reachApproved(h, key);
    await askForPrTexts(h.ctx, project(), spec());
    handInPrText(h.ctx, worker.thread_id!, TEXT);
    await runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);
    expect(ticket(key).state).toBe("pr_open");
  }
}

const feedback = (key: string) => {
  const url = ticket(key).pr_url!;
  h.host.feedback.set(url, { items: [{ key: `review:${key}`, kind: "review", author: "alice", bot: false, body: `Rename the column in ${key}.`, url: null, state: "changes_requested", path: null, line: null }] });
};

const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};

/** The worker hands in a change and the checks pass: its ticket goes to review, and its worker slot is free. */
async function handIn(key: string): Promise<void> {
  const worker = workerOf(key);
  Object.assign(h.host.worktree(`/wt/${h.store.thread(worker.id)!.environment_id}`), { dirty: true, changed: ["src/model/a.ts"] });
  submit(h.ctx, worker.thread_id!, "Fixed.");
  await settleChecks(h.ctx);
  expect(ticket(key).state).toBe("review");
}

/** CSV-1 is in review with a reviewer started, and CSV-2's worker holds the only worker slot. */
async function reviewWhileFull(): Promise<ThreadRow> {
  await seed(1);
  await reachReview(h, "CSV-1");
  await startWorker(h, "CSV-2");
  expect(ticket("CSV-2").state).toBe("working");
  await spawnReviewers(h.ctx, project(), spec());
  const reviewer = h.store.threads({ ticketId: ticket("CSV-1").id, role: "reviewer" }).at(-1)!;
  checkOutHead(h, reviewer);
  return reviewer;
}

describe("worker slots for work going back to a worker", () => {
  it("starts at most max_workers fix rounds when every open pull request gets feedback at once, and the rest wait", async () => {
    await seed(2, pr);
    await openPrs(["CSV-1", "CSV-2", "CSV-3", "CSV-4"]);
    for (const key of ["CSV-1", "CSV-2", "CSV-3", "CSV-4"]) feedback(key);
    h.clock.advance(5 * 60_000);
    await h.engine.tick();

    expect(["CSV-1", "CSV-2", "CSV-3", "CSV-4"].map((key) => ticket(key).state)).toEqual(["working", "working", "working", "working"]);
    expect(["CSV-1", "CSV-2", "CSV-3", "CSV-4"].map((key) => fixRounds(key).length)).toEqual([1, 1, 0, 0]);
    expect(["CSV-1", "CSV-2", "CSV-3", "CSV-4"].map((key) => waitsForSlot(ticket(key)))).toEqual([false, false, true, true]);
    expect(h.store.posts(ticket("CSV-3").id).at(-1)).toMatchObject({ kind: "system", body: "CSV-3 waits for a worker slot: the project runs at most 2 workers at once, and all are busy. Its worker gets this as soon as a slot is free." });
    expect(boardCards(h.store.tickets(project().id), h.store.threads({ projectId: project().id }), spec()).map((card) => card.waitsForSlot)).toEqual([false, false, true, true]);
    const tickets = h.store.tickets(project().id);
    expect(projectHealth({ tickets, threads: [], metrics: metrics(), spec: spec(), now: h.clock.t }).capacity).toMatchObject({ workers: 2, maxWorkers: 2, handBacksWaiting: 2 });

    // A waiting ticket is not polled again, and its feedback is already its fix round, so nothing more starts.
    h.clock.advance(5 * 60_000);
    await h.engine.tick();
    expect(["CSV-1", "CSV-2", "CSV-3", "CSV-4"].map((key) => fixRounds(key).length)).toEqual([1, 1, 0, 0]);

    await handIn("CSV-2");
    await h.engine.tick();
    expect(["CSV-1", "CSV-2", "CSV-3", "CSV-4"].map((key) => fixRounds(key).length)).toEqual([1, 1, 1, 0]);
    expect(h.store.thread(workerOf("CSV-3").id)).toMatchObject({ clock_at: h.clock.t, idle_count: 0 });
  });

  it("gives a free slot to the waiting work of the highest priority, then to the work waiting longest", async () => {
    await seed(1, (doc) => {
      pr(doc);
      doc.ticket[2].priority = 0;
    });
    // In pick order: each worker starts only as the queue's first pick.
    await openPrs(["CSV-3", "CSV-1", "CSV-2", "CSV-4"]);
    for (const key of ["CSV-1", "CSV-2", "CSV-4", "CSV-3"]) {
      feedback(key);
      await poll();
    }
    expect(["CSV-1", "CSV-2", "CSV-3", "CSV-4"].map((key) => fixRounds(key).length)).toEqual([1, 0, 0, 0]);

    await handIn("CSV-1");
    await deliverHandBacks(h.ctx, project().id);
    expect(["CSV-1", "CSV-2", "CSV-3", "CSV-4"].map((key) => fixRounds(key).length)).toEqual([1, 0, 1, 0]);
    await handIn("CSV-3");
    await deliverHandBacks(h.ctx, project().id);
    expect(["CSV-1", "CSV-2", "CSV-3", "CSV-4"].map((key) => fixRounds(key).length)).toEqual([1, 1, 1, 0]);
  });

  it("brings a released worker back for its fix round only once it has a slot", async () => {
    await seed(1, pr);
    await openPrs(["CSV-1", "CSV-2"]);
    for (const key of ["CSV-1", "CSV-2"]) {
      const row = workerOf(key);
      h.bb.threads.get(row.thread_id!)!.status = "idle";
    }
    await releaseIdleWorkers(h.ctx, project(), spec());
    for (const key of ["CSV-1", "CSV-2"]) {
      const row = h.store.thread(workerOf(key).id)!;
      expect(isReleased(row)).toBe(true);
      h.bb.environments.get(h.bb.threads.get(row.thread_id!)!.environmentId!)!.status = "destroyed";
    }
    feedback("CSV-1");
    feedback("CSV-2");
    await poll();

    const second = workerOf("CSV-2").thread_id!;
    expect(h.bb.callsTo("unarchive")).toEqual([[workerOf("CSV-1").thread_id]]);
    expect(ticket("CSV-2")).toMatchObject({ state: "working", worker_thread_id: second });
    expect(isReleased(h.store.thread(workerOf("CSV-2").id)!)).toBe(true);

    await h.engine.block("CSV-1", "Not now.", "human");
    await deliverHandBacks(h.ctx, project().id);
    expect(h.bb.callsTo("unarchive")).toContainEqual([second]);
    expect(h.bb.callsTo("restoreEnvironment")).toContainEqual([second]);
  });

  it("sends a review's changes to the worker once a slot is free, before any new worker starts", async () => {
    const reviewer = await reviewWhileFull();
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix the header.", findings);

    expect(ticket("CSV-1").state).toBe("working");
    expect(waitsForSlot(ticket("CSV-1"))).toBe(true);
    expect(sentTo("CSV-1", "asked for changes")).toEqual([]);
    await h.engine.tick();
    expect(sentTo("CSV-1", "asked for changes")).toEqual([]);
    expect(workerSpawns()).toEqual(["CSV-1", "CSV-2"]);

    await handIn("CSV-2");
    await h.engine.tick();
    expect(sentTo("CSV-1", "review round 1 asked for changes")).toHaveLength(1);
    expect(waitsForSlot(ticket("CSV-1"))).toBe(false);
    // CSV-3 and CSV-4 are ready, but the freed slot went to CSV-1's changes.
    expect(workerSpawns()).toEqual(["CSV-1", "CSV-2"]);
  });

  it("sends a merge that conflicted back to the worker once a slot is free, and leaves the merge queue free meanwhile", async () => {
    await seed(1);
    await reachApproved(h, "CSV-1");
    await startWorker(h, "CSV-2");
    h.host.scripted.merge = [{ outcome: "conflict", files: ["src/model/a.ts"] }];
    await runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);

    expect(ticket("CSV-1").state).toBe("working");
    expect(waitsForSlot(ticket("CSV-1"))).toBe(true);
    expect(sentTo("CSV-1", "conflicts in")).toEqual([]);
    expect(h.store.tickets(project().id, ["merging"])).toEqual([]);

    await handIn("CSV-2");
    await deliverHandBacks(h.ctx, project().id);
    expect(sentTo("CSV-1", "conflicts in 1 file")).toHaveLength(1);
  });

  it("does not time out a worker while its work waits for a slot, and starts its clock when it gets one", async () => {
    await reviewWhileFull();
    await requestChanges(h.ctx, h.store.threads({ ticketId: ticket("CSV-1").id, role: "reviewer" }).at(-1)!.thread_id!, "Fix the header.", findings);
    const running = workerOf("CSV-2");
    h.clock.advance(121 * 60_000);
    h.store.updateThread(running.id, { clock_at: h.clock.t });
    await h.engine.tick();
    expect(ticket("CSV-1")).toMatchObject({ state: "working", failures: 0 });
    expect(h.store.thread(workerOf("CSV-1").id)!.state).toBe("active");

    await h.engine.block("CSV-2", "Not now.", "human");
    await h.engine.tick();
    expect(h.store.thread(workerOf("CSV-1").id)).toMatchObject({ state: "active", clock_at: h.clock.t });
  });

  it("keeps the human's reply to a worker whose work waits with that work, and sends both together", async () => {
    const reviewer = await reviewWhileFull();
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix the header.", findings);
    const before = h.bb.sent(workerOf("CSV-1").thread_id!).length;
    await h.engine.humanPost("CSV-1", "Use the order's own currency too.");
    expect(h.bb.sent(workerOf("CSV-1").thread_id!)).toHaveLength(before);

    await handIn("CSV-2");
    await deliverHandBacks(h.ctx, project().id);
    const sent = h.bb.sent(workerOf("CSV-1").thread_id!).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("review round 1 asked for changes");
    expect(sent[0]).toContain("[loom] Reply on CSV-1 from the human\nUse the order's own currency too.");
  });

  it("sends no resume message to a worker whose work waits for a slot", async () => {
    const reviewer = await reviewWhileFull();
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix the header.", findings);
    await h.engine.pause("csv", "human", false);
    h.bb.threads.get(workerOf("CSV-1").thread_id!)!.status = "idle";
    await h.engine.resume("csv", "human");
    expect(sentTo("CSV-1", "The project resumed")).toEqual([]);
    expect(waitsForSlot(ticket("CSV-1"))).toBe(true);
  });

  it("asks a worker for its pull request only when a slot is free, and the ask holds the slot until the text is in", async () => {
    await seed(1, pr);
    const worker = await reachApproved(h, "CSV-1");
    await startWorker(h, "CSV-2");
    await askForPrTexts(h.ctx, project(), spec());
    expect(sentTo("CSV-1", "loom_pr")).toEqual([]);

    await h.engine.block("CSV-2", "Not now.", "human");
    await askForPrTexts(h.ctx, project(), spec());
    expect(sentTo("CSV-1", "loom_pr")).toHaveLength(1);
    expect(toLite(ticket("CSV-1")).holds).toBe(true);
    await startWorker(h, "CSV-3");
    expect(ticket("CSV-3").state).toBe("queued");

    handInPrText(h.ctx, worker.thread_id!, TEXT);
    expect(toLite(ticket("CSV-1")).holds).toBe(false);
    await startWorker(h, "CSV-3");
    expect(ticket("CSV-3").state).toBe("working");
  });
});

describe("threads that wait for the human", () => {
  it("frees the worker slot of a worker waiting for the human, so waiting work takes it", async () => {
    const reviewer = await reviewWhileFull();
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix the header.", findings);
    await h.engine.tick();
    expect(sentTo("CSV-1", "asked for changes")).toEqual([]);

    h.bb.waiting.add(workerOf("CSV-2").thread_id!);
    await h.engine.tick();
    expect(sentTo("CSV-1", "review round 1 asked for changes")).toHaveLength(1);
  });

  it("frees the reviewer slot of a reviewer waiting for the human", async () => {
    await seedProject(h, (doc) => {
      withDocsTicket(doc);
      doc.agents.max_reviewers = 1;
    });
    await reachReview(h, "CSV-1");
    await reachReview(h, "CSV-3");
    await h.engine.tick();
    expect(reviewerSpawns()).toEqual(["CSV-1"]);
    await h.engine.tick();
    expect(reviewerSpawns()).toEqual(["CSV-1"]);

    h.bb.waiting.add(h.store.threads({ ticketId: ticket("CSV-1").id, role: "reviewer" })[0]!.thread_id!);
    await h.engine.tick();
    expect(reviewerSpawns()).toEqual(["CSV-1", "CSV-3"]);
  });

  it("asks bb only while every slot is held and work waits for one", async () => {
    await seed(2);
    await h.engine.tick();
    expect(workerSpawns()).toEqual(["CSV-1", "CSV-2"]);
    expect(h.bb.callsTo("waitingOnUser")).toEqual([]);
    await h.engine.tick();
    expect(h.bb.callsTo("waitingOnUser")).toEqual([[[workerOf("CSV-1").thread_id, workerOf("CSV-2").thread_id]]]);
  });
});

describe("slot arithmetic", () => {
  let seq = 0;
  const lite = (over: Partial<TicketLite> = {}): TicketLite => {
    seq += 1;
    return { id: seq, key: `CSV-${seq}`, state: "working", priority: 2, seq, deps: [], scope: [], repo: null, pushed: false, holds: true, waitsSince: null, ...over };
  };

  it("counts the workers that hold a slot, less the parked ones, and keeps the free ones for waiting work first", () => {
    const running = lite();
    const parked = lite();
    const waitingEarly = lite({ holds: false, waitsSince: 10 });
    const waitingLate = lite({ holds: false, waitsSince: 20 });
    const urgent = lite({ holds: false, waitsSince: 30, priority: 0 });
    const all = [running, parked, waitingEarly, waitingLate, urgent];
    expect(freeWorkerSlots(4, all)).toBe(2);
    expect(freeWorkerSlots(4, all, new Set([parked.id]))).toBe(3);
    expect(workerSlots(4, all)).toBe(0);
    expect(workerSlots(8, all)).toBe(3);
    expect(slotTurns(4, all).map((t) => t.id)).toEqual([urgent.id, waitingEarly.id]);
    expect(slotTurns(4, all, new Set([parked.id])).map((t) => t.id)).toEqual([urgent.id, waitingEarly.id, waitingLate.id]);
    expect(slotTurns(2, all)).toEqual([]);
  });
});
