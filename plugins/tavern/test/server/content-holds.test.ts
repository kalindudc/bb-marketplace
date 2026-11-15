// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { TavernRuntime } from "../../src/server/runtime";

async function fixture() {
  const stop = vi.fn(async (_: { threadId: string }) => ({ ok: true as const }));
  const f = setup({ threads: { stop, get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }), send: async () => ({ delivery: "sent" }), queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) }, events: { list: async () => [] }, updatePluginMetadata: async () => ({}) } });
  const q = await seedQuest(f.k,"lead", "Draft", "Tested draft");
  f.k.bind("child", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Draft", brief: { outcome: "Draft", doneWhen: "Tests pass", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
  f.runtime.spawnBriefDelivered("child");
  const row = () => JSON.parse((f.k.store.db.prepare("SELECT data FROM tavern_records WHERE kind='awayHolds' AND id='child'").get() as { data: string }).data);
  const close = () => f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: q.id, endState: "pause" }] });
  return { ...f, q, stop, row, close };
}
const returned = { kind: "explicit-return" as const, threadId: null, refId: null };
describe("shared content-transfer holds", () => {
  it("persists a versioned token before interruption and never grants content authority or resumes automatically", async () => {
    const f = await fixture(), token = f.runtime.away.requestContentHold("child", { operationId: "operation-a" });
    expect(typeof token).toBe("string");
    expect(f.row()).toMatchObject({ version: expect.any(Number), token: expect.any(String), windowId: null, resumeRequired: true, stopPending: true, reasons: [{ kind: "content", operationId: "operation-a", token }] });
    expect(f.runtime.away.blocked("child")).toBe(true);
    expect(await f.runtime.dispatch(makeMessageDispatchHookContext({ thread: { id: "child", status: "idle" }, initiator: "agent", originPluginId: "tavern", senderThreadId: "lead" }))).toMatchObject({ action: "wait", reason: expect.stringContaining("content transfer") });
    expect(f.runtime.away.snapshot().status.closed).toBe(false);
    expect(f.stop).not.toHaveBeenCalled();
    expect(await f.runtime.away.confirmHeld(token)).toMatchObject({ state: "confirmed", error: null });
    expect(f.stop).toHaveBeenCalledWith({ threadId: "child" });
    expect(f.runtime.away.finishContentHold(token)).toEqual({ state: "finished" });
    expect(f.runtime.away.inspectHeld(token)).toMatchObject({ state: "stale" });
    expect(f.runtime.away.blocked("child")).toBe(true);
    expect(f.k.store.runtime("child").released).toBeFalsy();
    await f.runtime.tell("lead", "child", "Fresh private work");
    expect(f.runtime.away.blocked("child")).toBe(false);
    for (const table of ["tavern_placements", "tavern_source_snapshots", "tavern_placement_discoveries"]) expect(f.k.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });
  it("fails closed on dispatch errors even when a content latch has no away window", async () => {
    const f = await fixture(); f.runtime.away.requestContentHold("child", { operationId: "operation" });
    vi.spyOn(f.runtime.away, "dispatch").mockRejectedValueOnce(new Error("Hold read failed"));
    expect(await f.runtime.dispatch(makeMessageDispatchHookContext({ thread: { id: "child", status: "idle" }, initiator: "agent", originPluginId: "tavern", senderThreadId: "lead" }))).toMatchObject({ action: "wait" });
  });
  it.each(["lead", "missing"])("refuses a content hold on non-party thread %s", async threadId => {
    const f = await fixture();
    expect(() => f.runtime.away.requestContentHold(threadId, { operationId: "operation" })).toThrow(/party member/i);
    expect(f.stop).not.toHaveBeenCalled();
  });
  it("reuses a same-operation token but never clears a different content reason", async () => {
    const f = await fixture(), first = f.runtime.away.requestContentHold("child", { operationId: "one" });
    expect(f.runtime.away.requestContentHold("child", { operationId: "one" })).toBe(first);
    const second = f.runtime.away.requestContentHold("child", { operationId: "two" });
    expect(second).not.toBe(first);
    await f.runtime.away.confirmHeld(second);
    f.runtime.away.finishContentHold(first);
    expect(f.runtime.away.inspectHeld(second)).toMatchObject({ state: "confirmed" });
    await expect(f.runtime.tell("lead", "child", "Too early")).rejects.toThrow(/content|transfer/i);
    f.runtime.away.finishContentHold(second);
    expect(f.row().resumeRequired).toBe(true);
  });
  it("retries failed interruption across reload without an away window", async () => {
    const f = await fixture(), token = f.runtime.away.requestContentHold("child", { operationId: "operation" });
    f.stop.mockRejectedValueOnce(new Error("Stop unavailable"));
    expect(await f.runtime.away.confirmHeld(token)).toMatchObject({ state: "pending", error: expect.stringContaining("Stop unavailable") });
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.sweep();
    expect(f.stop).toHaveBeenCalledTimes(2);
    expect(restarted.away.inspectHeld(token)).toMatchObject({ state: "confirmed" });
    expect(restarted.away.store.snapshot().window).toBeNull();
  });
  it.each(["return-first", "content-first"])("keeps away and content reasons independent: %s", async order => {
    const f = await fixture(), token = f.runtime.away.requestContentHold("child", { operationId: "operation" });
    await f.close();
    expect(f.row().reasons.map((reason: { kind: string }) => reason.kind).sort()).toEqual(["away", "content"]);
    if (order === "return-first") {
      await f.runtime.away.return(returned);
      expect(f.runtime.away.inspectHeld(token)).toMatchObject({ state: "confirmed" });
      await expect(f.runtime.tell("lead", "child", "Too early")).rejects.toThrow(/content|transfer/i);
      f.runtime.away.finishContentHold(token);
    } else {
      f.runtime.away.finishContentHold(token);
      expect(f.row().reasons.map((reason: { kind: string }) => reason.kind)).toEqual(["away"]);
      await expect(f.runtime.tell("lead", "child", "Too early")).rejects.toThrow(/closed/i);
      await f.runtime.away.return(returned);
    }
    expect(f.runtime.away.blocked("child")).toBe(true);
    await f.runtime.tell("lead", "child", "Fresh after both holds");
    expect(f.runtime.away.blocked("child")).toBe(false);
  });
  it.each(["ACK", "failure"])("cannot let a late stop %s overwrite a replacement token", async outcome => {
    const f = await fixture(), first = f.runtime.away.requestContentHold("child", { operationId: "old" });
    let resolve!: (value: { ok: true }) => void, reject!: (error: Error) => void, entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    f.stop.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; entered(); }));
    const confirming = f.runtime.away.confirmHeld(first);
    await started;
    f.runtime.away.finishContentHold(first);
    const second = f.runtime.away.requestContentHold("child", { operationId: "new" });
    if (outcome === "ACK") resolve({ ok: true });
    else reject(new Error("Stale stop failure"));
    expect(await confirming).toMatchObject({ state: "stale" });
    expect(f.runtime.away.inspectHeld(second)).toMatchObject({ state: "pending" });
    expect(f.row().reasons).toEqual([{ kind: "content", operationId: "new", token: second }]);
    expect(f.row().error).toBeNull();
    expect(await f.runtime.away.confirmHeld(second)).toMatchObject({ state: "confirmed" });
  });
  it("cannot confirm a newer away reason from an older content stop ACK", async () => {
    const f = await fixture(), token = f.runtime.away.requestContentHold("child", { operationId: "operation" });
    const resolves: ((value: { ok: true }) => void)[] = [];
    let enteredFirst!: () => void, enteredSecond!: () => void;
    const firstStarted = new Promise<void>(done => { enteredFirst = done; }), secondStarted = new Promise<void>(done => { enteredSecond = done; });
    f.stop.mockImplementation(() => new Promise(done => { resolves.push(done); if (resolves.length === 1) enteredFirst(); else enteredSecond(); }));
    const first = f.runtime.away.confirmHeld(token);
    await firstStarted;
    const closing = f.close();
    await Promise.resolve();
    expect(f.row().reasons.map((reason: { kind: string }) => reason.kind).sort()).toEqual(["away", "content"]);
    resolves[0]!({ ok: true });
    expect(await first).toMatchObject({ state: "pending" });
    expect(f.row().stopPending).toBe(true);
    const retry = f.runtime.away.confirmHeld(token);
    await secondStarted;
    resolves[1]!({ ok: true });
    expect(await retry).toMatchObject({ state: "confirmed" });
    await closing;
    expect(f.row().reasons).toHaveLength(2);
  });
  it("does not interrupt a released or no-longer-party thread from an old away latch", async () => {
    const f = await fixture();
    f.stop.mockRejectedValueOnce(new Error("Stop unavailable"));
    await f.close();
    f.k.store.put("members", "child", { ...f.k.member("child")!, role: "solo", keeperThreadId: null });
    await f.runtime.away.sweep();
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it("rechecks reasons added while a fresh tell awaits queue inspection", async () => {
    const f = await fixture(), first = f.runtime.away.requestContentHold("child", { operationId: "old" });
    await f.runtime.away.confirmHeld(first); f.runtime.away.finishContentHold(first);
    let added = false;
    f.bb.sdk.threads.queuedMessages.list = async () => {
      if (!added) { added = true; f.runtime.away.requestContentHold("child", { operationId: "new" }); }
      return [];
    };
    await expect(f.runtime.tell("lead", "child", "Raced with transfer")).rejects.toThrow(/content|transfer/i);
    expect(f.runtime.away.blocked("child")).toBe(true);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("upgrades legacy holds before retrying their interruption", async () => {
    const f = await fixture(); f.stop.mockRejectedValueOnce(new Error("Stop unavailable")); await f.close();
    const data = f.row(); delete data.version; delete data.token; delete data.reasons;
    f.k.store.db.prepare("UPDATE tavern_records SET data=? WHERE kind='awayHolds' AND id='child'").run(JSON.stringify(data));
    f.stop.mockImplementationOnce(async () => {
      expect(f.row()).toMatchObject({ version: expect.any(Number), token: expect.any(String) });
      return { ok: true };
    });
    await f.runtime.away.sweep();
    expect(f.row()).toMatchObject({ stopPending: false, resumeRequired: true });
  });
  it("retains the no-replay fence and foreign queues after a transfer finishes", async () => {
    const f = await fixture();
    f.k.store.patch("child", { pendingBrief: { id: "old-brief", text: "Old work", attempts: 0, nextAttemptAt: f.time(), attemptedAt: null, hostAfterSeq: null, error: null } });
    let queued = [makeQueueEntry({ id: "ours", originPluginId: "tavern", senderThreadId: "lead" }), makeQueueEntry({ id: "human", originPluginId: null, senderThreadId: null }), makeQueueEntry({ id: "other", originPluginId: "other", senderThreadId: null })];
    f.bb.sdk.threads.queuedMessages.list = async () => queued;
    f.bb.sdk.threads.queuedMessages.delete = async ({ queuedMessageId }) => { queued = queued.filter(row => row.id !== queuedMessageId); return { ok: true }; };
    const token = f.runtime.away.requestContentHold("child", { operationId: "operation" });
    await f.runtime.away.confirmHeld(token);
    f.runtime.away.finishContentHold(token);
    await f.runtime.retryInitialBriefs("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(queued.map(row => row.id)).toEqual(["human", "other"]);
    await expect(f.runtime.tell("lead", "child", "New work")).rejects.toThrow(/queued messages/i);
    expect(f.runtime.away.blocked("child")).toBe(true);
  });
});
