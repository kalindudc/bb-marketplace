import { afterEach, describe, expect, it, vi } from "vitest";
import { threadStatusSchema } from "../src/contract";
import { DISPATCH_TIMEOUT_MS, EVENTS_SYNC_MS, EVENTS_SYNC_SLOW_MS, HOLD_MAX_MS, HOLD_REASON, HOLD_RETRY_MS, PENDING_TTL_MS, RUNNING_INVALIDATE_MS } from "../src/service";
import { commandRow, compactedEvent, compactionRow, flush, harness, queuedEntry, threadId } from "./service-fake";

const WAIT = { action: "wait", reason: HOLD_REASON };

afterEach(() => {
  vi.useRealTimers();
});

describe("the message.dispatch hold", () => {
  it("lets joins, new threads and threads with nothing to do proceed", async () => {
    const h = harness({ usedTokens: 850_000 });
    expect(await h.dispatch({ attempt: "join-turn" })).toEqual({ action: "proceed" });
    expect(await h.dispatch({ thread: { ...h.thread, status: "pending" } })).toEqual({ action: "proceed" });
    h.usage.usedTokens = 100_000;
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("does not start a compaction outside auto mode", async () => {
    const h = harness({ usedTokens: 850_000, settings: { mode: "advisor" } });
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("compacts before the next turn when a point fires, and holds the turn until it lands", async () => {
    const h = harness({ usedTokens: 850_000 });
    expect(await h.dispatch()).toEqual({ ...WAIT, sendAt: h.clock.now() + HOLD_RETRY_MS });
    await flush();
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.store.decisions({ threadId, limit: 1 })[0]).toMatchObject({ origin: "dispatch", point: "window" });
    const held = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(held.held).toMatchObject({ reason: HOLD_REASON, count: 1 });
    expect(held.compacting).not.toBeNull();

    // The re-attempt while the compaction runs keeps waiting, and counts the queued rows.
    h.emit("message.queued", { entry: queuedEntry("q1") });
    h.emit("message.queued", { entry: queuedEntry("q2") });
    h.clock.advance(HOLD_RETRY_MS);
    expect(await h.dispatch({ queuedMessages: [queuedEntry("q1"), queuedEntry("q2")] })).toMatchObject(WAIT);
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).held?.count).toBe(2);
    expect(h.compact).toHaveBeenCalledTimes(1);

    // The landing releases the hold: Press asks core to re-attempt, and the re-attempt proceeds.
    h.compactions.push(compactedEvent(9, h.clock.now()));
    h.emit("experimental_thread.events", { thread: { ...h.thread }, sequence: 9 });
    await vi.waitFor(() => expect(h.recheck).toHaveBeenCalledWith("message.dispatch"));
    expect(await h.dispatch({ queuedMessages: [queuedEntry("q1"), queuedEntry("q2")] })).toEqual({ action: "proceed" });
    const released = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(released.held).toBeNull();
    expect(released.lastCompaction).toMatchObject({ point: "window", outcome: "ok" });
  });

  it("holds a turn while a compaction Press already requested is pending", async () => {
    const h = harness({ usedTokens: 850_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    expect(await h.dispatch()).toMatchObject(WAIT);
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it("releases the turn when the request is refused", async () => {
    const h = harness({ usedTokens: 850_000 });
    h.compact.mockRejectedValue(new Error("refused"));
    expect(await h.dispatch()).toMatchObject(WAIT);
    await vi.waitFor(() => expect(h.recheck).toHaveBeenCalledWith("message.dispatch"));
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it("stops holding after ten minutes and does not hold for the same compaction again", async () => {
    const h = harness({ usedTokens: 850_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    expect(await h.dispatch()).toMatchObject(WAIT);
    h.clock.advance(HOLD_MAX_MS - 1);
    expect(await h.dispatch()).toMatchObject(WAIT);
    h.clock.advance(1);
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect(h.recheck).toHaveBeenCalled();
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).held).toBeNull();
  });

  it("the sweep lapses a hold nobody re-attempted", async () => {
    const h = harness({ usedTokens: 850_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    await h.dispatch();
    h.clock.advance(HOLD_MAX_MS);
    await h.service.sweep();
    expect(h.recheck).toHaveBeenCalledWith("message.dispatch");
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).held).toBeNull();
  });

  it("proceeds, and logs, when the check throws", async () => {
    const h = harness({ usedTokens: 850_000 });
    expect(await h.dispatch({ queuedMessages: undefined })).toEqual({ action: "proceed" });
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining("dispatch check"));
    expect(h.compact).not.toHaveBeenCalled();
  });

  it("proceeds when the check is slow, and does not start a compaction after answering", async () => {
    vi.useFakeTimers();
    const h = harness({ usedTokens: 850_000 });
    let resolveContext: (value: unknown) => void = () => undefined;
    h.context.mockImplementationOnce(() => new Promise((resolve) => {
      resolveContext = resolve;
    }) as never);
    const answer = h.dispatch();
    await vi.advanceTimersByTimeAsync(DISPATCH_TIMEOUT_MS);
    expect(await answer).toEqual({ action: "proceed" });
    resolveContext({ usage: { modelContextWindow: 1_000_000, usedTokens: 850_000 } });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.store.pendingCompactions(threadId)).toEqual([]);
  });
});

describe("the events path", () => {
  it("settles a pending compaction from thread events, throttled per thread", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness({ usedTokens: 850_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    const lists = h.listEvents.mock.calls.length;
    h.emit("experimental_thread.events", { thread: { ...h.thread }, sequence: 1 });
    await flush();
    expect(h.listEvents).toHaveBeenCalledTimes(lists + 1);
    expect(h.store.pendingCompactions(threadId)).toHaveLength(1);

    h.compactions.push(compactedEvent(3, h.clock.now() + 500));
    const invalidations = h.statusInvalidations();
    h.emit("experimental_thread.events", { thread: { ...h.thread }, sequence: 2 });
    await flush();
    expect(h.listEvents).toHaveBeenCalledTimes(lists + 1);
    h.clock.advance(EVENTS_SYNC_MS);
    await vi.advanceTimersByTimeAsync(EVENTS_SYNC_MS);
    await flush();
    expect(h.store.pendingCompactions(threadId)).toHaveLength(0);
    expect(h.statusInvalidations()).toBeGreaterThan(invalidations);
  });

  it("does not sync an idle thread with nothing pending, and refreshes a running thread's status at most every 5 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    h.emit("experimental_thread.events", { thread: { ...h.thread }, sequence: 1 });
    await flush();
    expect(h.listEvents).not.toHaveBeenCalled();
    const running = { ...h.thread, status: "active" };
    h.emit("experimental_thread.events", { thread: running, sequence: 2 });
    h.emit("experimental_thread.events", { thread: running, sequence: 3 });
    expect(h.statusInvalidations()).toBe(1);
    h.clock.advance(RUNNING_INVALIDATE_MS);
    h.emit("experimental_thread.events", { thread: running, sequence: 4 });
    expect(h.statusInvalidations()).toBe(2);
    await flush();
    expect(h.timeline).not.toHaveBeenCalled();
  });

  it("looks for a landing nobody requested while a turn runs, at most every 15 s, and records it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    const running = { ...h.thread, status: "active" };
    h.emit("experimental_thread.events", { thread: running, sequence: 1 });
    await flush();
    expect(h.listEvents).toHaveBeenCalledTimes(1);
    const landedAt = h.clock.now() + 1_000;
    h.compactions.push(compactedEvent(5, landedAt));
    h.rows.push(compactionRow(landedAt - 3_000, landedAt));
    h.clock.advance(5_000);
    h.emit("experimental_thread.events", { thread: running, sequence: 2 });
    await flush();
    expect(h.listEvents).toHaveBeenCalledTimes(1);
    h.clock.advance(EVENTS_SYNC_SLOW_MS - 5_000);
    await vi.advanceTimersByTimeAsync(EVENTS_SYNC_SLOW_MS);
    await flush();
    expect(h.listEvents).toHaveBeenCalledTimes(2);
    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(status.lastCompaction).toMatchObject({ point: "native", outcome: "ok" });
  });
});

describe("the hold never loops", () => {
  const disabled = JSON.stringify({ providers: { pi: { enabled: false } } });

  it("lets a turn on a provider Press policy disables proceed, and writes no decision or compaction", async () => {
    const h = harness({ usedTokens: 850_000 });
    h.files.set("/workspace/.bb/press/policy.json", disabled);
    for (let index = 0; index < 3; index += 1) {
      expect(await h.dispatch()).toEqual({ action: "proceed" });
      await flush();
      h.clock.advance(HOLD_RETRY_MS);
    }
    await h.service.evaluate(threadId, { origin: "idle" });
    await h.service.sweep();
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.store.decisions({ threadId, limit: 10 })).toEqual([]);
    expect(h.store.compactionsOf(threadId, 10)).toEqual([]);
    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(status).toMatchObject({ providerEnabled: false, held: null, compacting: null });
    expect(await h.service.compactionPoint(threadId)).toMatch(/off for this provider/);
  });

  it("serves providerEnabled true when policy leaves the provider on", async () => {
    const h = harness();
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).providerEnabled).toBe(true);
  });

  it("holds a message for one compaction attempt: with no cooldown and a refusing provider the re-attempt proceeds", async () => {
    const h = harness({ usedTokens: 850_000, settings: { cooldownSeconds: 0 } });
    h.compact.mockRejectedValue(new Error("refused"));
    expect(await h.dispatch()).toMatchObject(WAIT);
    await vi.waitFor(() => expect(h.recheck).toHaveBeenCalledWith("message.dispatch"));
    h.emit("message.queued", { entry: queuedEntry("q1") });
    expect(await h.dispatch({ queuedMessages: [queuedEntry("q1")] })).toEqual({ action: "proceed" });
    expect(h.compact).toHaveBeenCalledTimes(1);
    // The next message inside the minimum retry delay is not held either.
    h.clock.advance(30_000);
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it("releases a hold whose request was cancelled before it was sent, instead of holding again", async () => {
    const h = harness({ usedTokens: 850_000 });
    // The re-read before compacting finds the thread no longer idle, so nothing is sent and no attempt starts.
    h.current.status = "starting";
    expect(await h.dispatch()).toMatchObject(WAIT);
    await vi.waitFor(() => expect(h.recheck).toHaveBeenCalledWith("message.dispatch"));
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.store.decisions({ threadId, limit: 10 })).toHaveLength(1);
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).held).toBeNull();
  });

  it("gives up a pending row older than its time to live instead of holding for it", async () => {
    const h = harness({ usedTokens: 100_000 });
    const stale = h.store.insertCompaction({
      threadId, decisionId: null, requestedAt: h.clock.now() - PENDING_TTL_MS - 1, point: "window", reason: "window.hard", mode: "auto", provider: "pi", tokensBefore: 850_000,
    });
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect(h.store.compaction(stale.id)).toMatchObject({ status: "settled", outcome: "cancelled", error: "pending compaction timed out" });
  });

  it("compactNow is not blocked by a stale pending row", async () => {
    const h = harness({ usedTokens: 100_000 });
    h.store.insertCompaction({
      threadId, decisionId: null, requestedAt: h.clock.now() - PENDING_TTL_MS - 1, point: "window", reason: "window.hard", mode: "auto", provider: "pi", tokensBefore: 850_000,
    });
    expect(await h.service.compactNow(threadId)).toEqual({ ok: true, message: "Compaction requested." });
  });
});

describe("an errored thread is not running", () => {
  it("compacts before the follow-up to a failed turn, and serves running false", async () => {
    const h = harness({ usedTokens: 850_000 });
    h.thread.status = "error";
    const status = threadStatusSchema.parse(await h.service.buildThreadStatus(threadId));
    expect(status.running).toBe(false);
    expect(status.blockers.map((blocker) => blocker.veto)).not.toContain("midTurn");
    expect(await h.dispatch()).toMatchObject(WAIT);
    await flush();
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it("the sweep and compactNow act on an errored thread", async () => {
    const h = harness({ usedTokens: 850_000 });
    h.thread.status = "error";
    await h.service.sweep();
    expect(h.compact).toHaveBeenCalledTimes(1);
    h.compactions.push(compactedEvent(3, h.clock.now() + 1));
    h.clock.advance(2);
    await h.service.syncThread(threadId, {});
    expect(await h.service.compactNow(threadId)).toEqual({ ok: true, message: "Compaction requested." });
    expect(h.compact).toHaveBeenCalledTimes(2);
  });
});

describe("a message that drains as the turn ends", () => {
  it("waits briefly for the timeline signals, so a phase point still compacts before the turn", async () => {
    const h = harness({ usedTokens: 600_000 });
    h.store.bumpTurns(threadId);
    h.store.bumpTurns(threadId);
    h.rows.push(commandRow(h.thread.updatedAt - 500, "npm test"));
    const first = await h.dispatch();
    expect(first).toMatchObject({ action: "wait" });
    expect((first as { sendAt: number }).sendAt - h.clock.now()).toBeLessThanOrEqual(5_000);
    expect(threadStatusSchema.parse(await h.service.buildThreadStatus(threadId)).held).toBeNull();
    await vi.waitFor(() => expect(h.recheck).toHaveBeenCalledWith("message.dispatch"));
    expect(await h.dispatch()).toMatchObject(WAIT);
    await flush();
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.store.pendingCompactions(threadId)[0]).toMatchObject({ point: "phase", reason: "tests.green" });
  });

  it("waits for the signals once per thread change, then decides on what it has", async () => {
    const h = harness({ usedTokens: 600_000 });
    h.timeline.mockImplementation(() => new Promise(() => undefined));
    expect(await h.dispatch()).toMatchObject({ action: "wait" });
    expect(await h.dispatch()).toEqual({ action: "proceed" });
  });

  it("does not wait below the points' gate or for a thread with no timeline point on", async () => {
    const h = harness({ usedTokens: 400_000 });
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    const off = harness({ usedTokens: 600_000, settings: { phasePoint: false, volumePoint: false } });
    expect(await off.dispatch()).toEqual({ action: "proceed" });
    expect(off.timeline).not.toHaveBeenCalled();
  });
});

describe("the hook's reads", () => {
  it("does not read the policy files or the environment again on a later message", async () => {
    const h = harness({ usedTokens: 100_000 });
    await h.service.evaluate(threadId, { origin: "idle" });
    const reads = h.read.mock.calls.filter(([args]) => args.path.endsWith("policy.json")).length;
    const environments = (h.bb.sdk.environments.get as ReturnType<typeof vi.fn>).mock.calls.length;
    h.clock.advance(10 * 60_000);
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect(h.read.mock.calls.filter(([args]) => args.path.endsWith("policy.json"))).toHaveLength(reads);
    expect(h.bb.sdk.environments.get).toHaveBeenCalledTimes(environments);
  });
});
