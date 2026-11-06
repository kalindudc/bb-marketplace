import { beforeEach, describe, expect, it } from "vitest";
import { RETRY_LONGEST_MS, RETRY_STEPS_MS, Retries, retryDelayMs } from "../src/backoff";
import type { ThreadRow } from "../src/db/store";
import { requestChanges, spawnReviewers, type Finding } from "../src/review";
import { deliverHandBacks } from "../src/slots";
import { freeWorkerSlots, toLite } from "../src/scheduler";
import { HUMAN_ACTOR } from "../src/states";
import { resumeEnding } from "../src/workers";
import { requeueTicket } from "../src/requeue";
import { specOf } from "../src/ctx";
import { checkOutHead, makeEngine, reachReview, seedProject, startWorker, ticketOf } from "./helpers";

describe("the retry schedule", () => {
  it("is 15 seconds, 30, 60 and 120, then 5 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 40].map((failures) => retryDelayMs(failures, () => 0))).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
    expect(RETRY_STEPS_MS).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(RETRY_LONGEST_MS).toBe(300_000);
  });

  it("adds up to a tenth of jitter and never subtracts", () => {
    expect(retryDelayMs(1, () => 0.999)).toBe(16_499);
    expect(retryDelayMs(5, () => 0.5)).toBe(315_000);
    for (let failures = 1; failures <= 6; failures += 1) {
      const base = retryDelayMs(failures, () => 0);
      for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
        const delay = retryDelayMs(failures, () => roll);
        expect(delay).toBeGreaterThanOrEqual(base);
        expect(delay).toBeLessThanOrEqual(base * 1.1);
      }
    }
  });

  it("makes a key wait from its failure, counts failures in a row, and forgets on reset", () => {
    const retries = new Retries(() => 0);
    expect(retries.waitMs(7, 1000)).toBe(0);
    expect(retries.failed(7, 1000, "offline")).toMatchObject({ failures: 1, retryAt: 16_000, changed: true });
    expect(retries.waitMs(7, 1000)).toBe(15_000);
    expect(retries.waitMs(7, 15_999)).toBe(1);
    expect(retries.waitMs(7, 16_000)).toBe(0);
    expect(retries.failed(7, 16_000, "offline")).toMatchObject({ failures: 2, retryAt: 46_000, changed: false });
    expect(retries.failed(7, 46_000, "refused")).toMatchObject({ failures: 3, retryAt: 106_000, changed: true });
    expect(retries.waitMs(8, 46_000)).toBe(0);
    retries.reset(7);
    expect(retries.state(7)).toBeNull();
    expect(retries.failed(7, 200_000, "offline")).toMatchObject({ failures: 1, retryAt: 215_000, changed: true });
  });
});

describe("a hand-back that bb does not take", () => {
  let h: ReturnType<typeof makeEngine>;
  const findings: Finding[] = [{ severity: "blocking", title: "The header row is missing", detail: "An empty export has no header." }];
  const project = () => h.store.projectBySlug("csv")!;
  const ticket = () => ticketOf(h, "CSV-1");
  const worker = (): ThreadRow => h.store.threads({ ticketId: ticket().id, role: "worker" }).at(-1)!;
  const sends = () => h.bb.sent(worker().thread_id!).filter((text) => text.includes("asked for changes"));
  const warnings = () => h.bb.callsTo("log").filter(([level, text]) => level === "warn" && String(text).startsWith("Could not send CSV-1's work")).map(([, text]) => String(text));
  const systemPosts = () => h.store.posts(ticket().id).filter((post) => post.kind === "system");
  const tick = () => deliverHandBacks(h.ctx, project().id);

  /** CSV-1's reviewer asks for changes while bb refuses every send. */
  async function refused(error: Error) {
    await seedProject(h);
    await reachReview(h, "CSV-1");
    await spawnReviewers(h.ctx, project(), specOf(h.store, project()));
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    h.bb.sendError = error;
    h.bb.calls = [];
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix the header.", findings);
    expect(ticket().state).toBe("working");
  }

  beforeEach(() => {
    h = makeEngine();
  });

  it("is tried again after 15 seconds, 30, 60 and 120, then every 5 minutes", async () => {
    await refused(new Error("HTTP 503: bb is restarting"));
    expect(sends()).toHaveLength(1);
    const delays: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      const before = sends().length;
      let waited = 0;
      while (sends().length === before) {
        await tick();
        if (sends().length === before) {
          h.clock.advance(1000);
          waited += 1000;
        }
      }
      delays.push(waited);
    }
    [15, 30, 60, 120, 300, 300].forEach((seconds, at) => {
      expect(delays[at]).toBeGreaterThanOrEqual(seconds * 1000);
      expect(delays[at]).toBeLessThanOrEqual(seconds * 1100 + 1000);
    });
  });

  it("logs the same failure once, a new one again, and stops waiting when bb takes the message", async () => {
    await refused(new Error("HTTP 503: bb is restarting"));
    for (let round = 0; round < 4; round += 1) {
      h.clock.advance(6 * 60_000);
      await tick();
    }
    expect(sends()).toHaveLength(5);
    expect(warnings()).toEqual([expect.stringContaining("HTTP 503: bb is restarting")]);
    expect(warnings()[0]).toContain("tries again, waiting longer after each failure up to 5 minutes");

    h.bb.sendError = new Error("HTTP 502: bad gateway");
    h.clock.advance(6 * 60_000);
    await tick();
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]).toContain("HTTP 502: bad gateway");

    h.bb.sendError = null;
    h.clock.advance(6 * 60_000);
    await tick();
    expect(ticket().handback_json).toBeNull();
    expect(systemPosts().filter((post) => post.data_json.includes("undeliverable"))).toEqual([]);
  });

  it("keeps trying while the worker's thread and machine are still there, however the send fails", async () => {
    await refused(new Error("HTTP 404: Host not found"));
    h.clock.advance(6 * 60_000);
    await tick();
    expect(sends()).toHaveLength(2);
    expect(JSON.parse(ticket().handback_json!)).not.toHaveProperty("undeliverable");
  });

  const unreachable: Array<[string, () => unknown]> = [
    ["its machine was removed", () => h.bb.removedHosts.add(h.bb.environments.get(h.bb.threads.get(worker().thread_id!)!.environmentId!)!.hostId)],
    ["its thread was archived", () => (h.bb.threads.get(worker().thread_id!)!.archivedAt = 1)],
    ["its thread was deleted", () => (h.bb.threads.get(worker().thread_id!)!.deletedAt = 1)],
    ["its thread was deleted", () => h.bb.threads.delete(worker().thread_id!)],
    ["its environment is gone", () => h.bb.environments.delete(h.bb.threads.get(worker().thread_id!)!.environmentId!)],
  ];

  describe.each(unreachable)("when %s", (why, gone) => {
    it("blocks the ticket without bringing anything home, keeps the message on its feed, and a requeue gives it a new worker", async () => {
      await seedProject(h);
      await reachReview(h, "CSV-1");
      await spawnReviewers(h.ctx, project(), specOf(h.store, project()));
      const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
      checkOutHead(h, reviewer);
      const row = worker();
      const threadId = row.thread_id!;
      gone();
      h.bb.sendError = new Error("HTTP 404: Host not found");
      h.bb.calls = [];
      h.host.calls = [];
      await requestChanges(h.ctx, reviewer.thread_id!, "Fix the header.", findings);

      const attempts = () => h.bb.sent(threadId).filter((text) => text.includes("asked for changes")).length;
      expect(attempts()).toBe(1);
      expect(ticket()).toMatchObject({ state: "blocked", worker_thread_id: null, environment_id: null, handback_json: null, blocked_reason: `its worker can no longer be reached: ${why}` });
      expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "unreachable" });
      expect(h.host.callsTo("commitAll")).toEqual([]);
      expect(h.host.callsTo("importCommit")).toEqual([]);

      const blocks = h.store.posts(ticket().id).filter((post) => post.kind === "block");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.body).toContain(`its worker can no longer be reached: ${why}. Needs: Requeue the ticket, for example with \`bb loom requeue CSV-1\`, to start a new worker from its branch.`);
      expect(blocks[0]!.body).toContain("The message Loom could not send it:");
      expect(blocks[0]!.body).toContain("asked for changes");
      const kept = systemPosts().filter((post) => post.data_json.includes("undeliverable"));
      expect(kept).toHaveLength(1);
      expect(kept[0]!.body).toContain("Loom could not send CSV-1's worker this message, so it is kept here for the next worker");
      expect(kept[0]!.body).toContain("asked for changes");

      for (let round = 0; round < 5; round += 1) {
        h.clock.advance(10 * 60_000);
        await tick();
      }
      expect(attempts()).toBe(1);
      expect(h.store.posts(ticket().id).filter((post) => post.data_json.includes("undeliverable"))).toHaveLength(2);
      expect(warnings()).toEqual([]);

      h.bb.sendError = null;
      await requeueTicket(h.ctx, "CSV-1", { note: "", actor: HUMAN_ACTOR, author: "human" });
      expect(ticket().state).toBe("queued");
      const next = await startWorker(h, "CSV-1");
      expect(next.thread_id).not.toBe(threadId);
      expect(ticket()).toMatchObject({ state: "working", worker_thread_id: next.thread_id });
    });
  });

  it("blocks the ticket at once when the machine is gone but bb still reports the thread active, and a later ending pass touches no host", async () => {
    await seedProject(h, (doc) => (doc.agents.max_workers = 1));
    await reachReview(h, "CSV-1");
    await spawnReviewers(h.ctx, project(), specOf(h.store, project()));
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    const row = worker();
    h.bb.removedHosts.add(h.bb.environments.get(h.bb.threads.get(row.thread_id!)!.environmentId!)!.hostId);
    // bb cannot stop a thread on a machine that is gone, so it stays active.
    h.bb.stopConfirms = false;
    h.bb.sendError = new Error("HTTP 404: Host not found");
    h.host.calls = [];
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix the header.", findings);

    const reason = "its worker can no longer be reached: its machine was removed";
    expect(ticket()).toMatchObject({ state: "blocked", worker_thread_id: null, handback_json: null, blocked_reason: reason });
    expect(h.store.thread(row.id)).toMatchObject({ state: "ending", end_reason: "unreachable" });
    expect(freeWorkerSlots(1, h.store.tickets(project().id).map(toLite))).toBe(1);

    h.host.calls = [];
    h.clock.advance(60_000);
    await resumeEnding(h.ctx, h.store.thread(row.id)!);
    expect(h.host.calls).toEqual([]);
    expect(h.store.thread(row.id)?.state).toBe("ending");
    expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: reason });

    // After the ten-minute limit the stale thread is archived, still without host work, and the reason is unchanged.
    h.clock.advance(11 * 60_000);
    await resumeEnding(h.ctx, h.store.thread(row.id)!);
    expect(h.host.calls).toEqual([]);
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "unreachable" });
    expect(ticket()).toMatchObject({ state: "blocked", blocked_reason: reason });

    await requeueTicket(h.ctx, "CSV-1", { note: "", actor: HUMAN_ACTOR, author: "human" });
    expect(ticket().state).toBe("queued");
  });

  it("keeps the unsent message in the next worker's brief however long the ticket's thread is", async () => {
    await seedProject(h);
    await reachReview(h, "CSV-1");
    await spawnReviewers(h.ctx, project(), specOf(h.store, project()));
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    h.bb.threads.get(worker().thread_id!)!.archivedAt = 1;
    h.bb.sendError = new Error("HTTP 404: Host not found");
    const long = `${"START ".repeat(10)}${"detail ".repeat(8000)}`;
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix the header.", [{ severity: "blocking", title: "A long finding", detail: long }]);
    expect(ticket().state).toBe("blocked");
    const system = systemPosts().find((post) => post.data_json.includes("undeliverable"))!;
    expect(system.body.length).toBeGreaterThan(30_000);

    h.bb.sendError = null;
    await requeueTicket(h.ctx, "CSV-1", { note: "", actor: HUMAN_ACTOR, author: "human" });
    h.bb.calls = [];
    await startWorker(h, "CSV-1");
    const spawn = h.bb.callsTo("spawnThread").at(-1)![0] as { prompt: string; detail?: string };
    const brief = `${spawn.prompt}\n${spawn.detail ?? ""}`;
    expect(brief).toContain("The message Loom could not send it:");
    expect(brief).toContain("START START START");
    expect(brief).toContain("[The rest is in the post below this one on the ticket's feed.]");
  });

  it("frees the worker slot of a ticket whose worker cannot be reached", async () => {
    await seedProject(h, (doc) => (doc.agents.max_workers = 1));
    await reachReview(h, "CSV-1");
    await spawnReviewers(h.ctx, project(), specOf(h.store, project()));
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    h.bb.threads.get(worker().thread_id!)!.archivedAt = 1;
    h.bb.sendError = new Error("HTTP 404: Host not found");
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix the header.", findings);
    expect(ticket().state).toBe("blocked");
    expect(freeWorkerSlots(1, h.store.tickets(project().id).map(toLite))).toBe(1);
  });

  it("ignores a send that fails after its hand-back was replaced by a new worker's", async () => {
    await refused(new Error("HTTP 503: bb is restarting"));
    const oldThread = worker().thread_id!;
    h.clock.advance(6 * 60_000);
    h.bb.sendError = null;
    const real = h.bb.send.bind(h.bb);
    let fail!: (error: Error) => void;
    h.bb.send = (threadId, message) => (threadId === oldThread ? new Promise<void>((_, reject) => (fail = reject)) : real(threadId, message));

    const late = tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The ticket was requeued and a new worker has its own hand-back while the old send is still out.
    h.store.updateTicket(ticket().id, { worker_thread_id: "thr_new", handback_json: JSON.stringify({ thread: "thr_new", text: "new work" }) });
    h.bb.threads.get(oldThread)!.deletedAt = 1;
    fail(new Error("HTTP 404: Host not found"));
    await late;

    expect(ticket()).toMatchObject({ state: "working", worker_thread_id: "thr_new" });
    expect(JSON.parse(ticket().handback_json!)).toEqual({ thread: "thr_new", text: "new work" });
    expect(h.store.posts(ticket().id).filter((post) => post.data_json.includes("undeliverable"))).toEqual([]);
    expect(warnings()).toHaveLength(1);

    h.bb.send = real;
    await tick();
    expect(h.bb.sent("thr_new")).toEqual(["new work"]);
    expect(ticket().handback_json).toBeNull();
  });

  it("does not make a new worker wait out the failures of the one before it", async () => {
    await refused(new Error("HTTP 503: bb is restarting"));
    for (let round = 0; round < 3; round += 1) {
      h.clock.advance(6 * 60_000);
      await tick();
    }
    h.store.updateTicket(ticket().id, { worker_thread_id: "thr_new", handback_json: JSON.stringify({ thread: "thr_new", text: "new work" }) });
    h.bb.sendError = null;
    await tick();
    expect(h.bb.sent("thr_new")).toEqual(["new work"]);
  });
});
