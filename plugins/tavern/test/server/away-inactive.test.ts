// @vitest-environment node
import { fixtureActivity, patchThreadFixture, putMemberFixture, runtimeFixture } from "./member-fixture";
import { putQuestFixture } from "./support";
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { TavernRuntime } from "../../src/server/runtime";
import { captureRequestSources, requestSourcePacket } from "../../src/server/request-sources";

async function fixture() {
  const stop = vi.fn(async () => ({ ok: true })), send = vi.fn(async () => ({ delivery: "sent" as const }));
  const remove = vi.fn(async () => ({ ok: true }));
  const f = setup({ threads: { stop, send, get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }),
    queuedMessages: { list: async ({ threadId }: { threadId: string }) => threadId === "child" ? [makeQueueEntry({ id: "old", threadId, originPluginId: "tavern", senderThreadId: "lead" })] : [], delete: remove },
    events: { list: async () => [] }, updatePluginMetadata: async () => ({}) } });
  const quest = await seedQuest(f.k,"lead", "Draft", "Tested draft");
  f.k.bind("child", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: quest.id, waypointId: null, errand: false, title: "Draft",
    brief: { outcome: "Draft", doneWhen: "Tests", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
  const hold = () => f.k.store.db.prepare("SELECT data FROM tavern_records WHERE kind='awayHolds' AND id='child'").get();
  const close = () => f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [] });
  const inactive = (kind: string) => {
    const member = f.k.member("child")!;
    if (kind === "done" || kind === "failed") putMemberFixture(f.k.store, member.threadId, { ...member, state: kind });
    else if (kind === "deleted") patchThreadFixture(f.k.store, member.threadId, { deletedAt: f.time() });
    else if (kind === "ended-quest") putQuestFixture(f.k.store, quest.id, { ...quest, endedAt: f.time() });
    else if (kind === "archived") patchThreadFixture(f.k.store, member.threadId, { archivedAt: f.time() });
    else if (kind === "finished-quest") putQuestFixture(f.k.store, quest.id, { ...quest, phase: "done", endedAt: f.time() });
    else throw new Error(`Unknown inactive fixture: ${kind}`);
  };
  return { ...f, quest, stop, send, remove, hold, close, inactive };
}
const returned = { kind: "explicit-return" as const, threadId: null, refId: null };

describe("inactive away participants", () => {
  it.each(["done", "failed", "archived", "deleted", "finished-quest", "ended-quest"])("never holds, interrupts, clears or retries an inactive %s member on close or Return", async kind => {
    const f = await fixture(); f.inactive(kind);
    f.stop.mockRejectedValue(new Error("An inactive thread must not be stopped"));
    await f.close();
    await f.runtime.away.sweep();
    expect(f.runtime.away.snapshot()).toMatchObject({ watchedCount: 0, watchedByQuest: [], heldCount: 0, pendingStops: [], resumeRequired: [] });
    expect(f.hold()).toBeUndefined();
    expect(f.runtime.away.blocked("child")).toBe(true);
    await f.runtime.away.return(returned);
    await f.runtime.away.sweep();
    expect(f.hold()).toBeUndefined();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["done", "failed", "archived", "deleted", "finished-quest", "ended-quest"])("refuses a new content hold and skips an existing content stop retry for an inactive %s member", async kind => {
    const f = await fixture(), token = f.runtime.away.requestContentHold("child", { operationId: "old-operation" });
    f.inactive(kind);
    const before = f.hold();
    expect(() => f.runtime.away.requestContentHold("child", { operationId: "new-operation" })).toThrow(/inactive|finished|archived|work/i);
    expect(f.runtime.away.inspectHeld(token)).toMatchObject({ state: "stale" });
    expect(await f.runtime.away.confirmHeld(token)).toMatchObject({ state: "stale" });
    await f.close(); await f.runtime.away.sweep(); await f.runtime.away.return(returned); await f.runtime.away.sweep();
    expect(f.hold()).toEqual(before);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not treat a live solo as an away party member", async () => {
    const f = await fixture(); f.inactive("done");
    f.k.bind("solo", "smith", "vale", "project");
    await f.close(); await f.runtime.away.sweep(); await f.runtime.away.return(returned);
    expect(f.runtime.away.snapshot()).toMatchObject({ watchedCount: 0, watchedByQuest: [], heldCount: 0 });
    expect(() => f.runtime.away.requestContentHold("solo", { operationId: "operation" })).toThrow(/party member/);
    expect(f.stop).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["archived", "deleted"])("does not stop a member when a fresh SDK read discovers it is %s", async kind => {
    const f = await fixture(), token = f.runtime.away.requestContentHold("child", { operationId: "operation" });
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle", ...(kind === "archived" ? { archivedAt: f.time() } : { deletedAt: f.time() }) });
    expect(await f.runtime.away.confirmHeld(token)).toMatchObject({ state: "stale" });
    await f.runtime.away.sweep();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("does not turn an inactive member dispatch into a new away hold", async () => {
    const f = await fixture(); f.inactive("done"); await f.close();
    expect(await f.runtime.away.dispatch(makeMessageDispatchHookContext({ thread: { id: "child", status: "idle" }, initiator: "agent", originPluginId: "other", senderThreadId: "lead" }))).toMatchObject({ action: "wait" });
    expect(f.hold()).toBeUndefined();
  });
  it("abandons queue clearing and confirmation if a member finishes during interruption", async () => {
    const f = await fixture(), token = f.runtime.away.requestContentHold("child", { operationId: "operation" });
    let resolve!: (value: { ok: true }) => void, entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    f.stop.mockImplementationOnce(() => new Promise(done => { resolve = done; entered(); }));
    const stopping = f.runtime.away.confirmHeld(token);
    await started;
    f.inactive("done"); const before = f.hold(); resolve({ ok: true });
    expect(await stopping).toMatchObject({ state: "stale" });
    expect(f.hold()).toEqual(before);
    expect(f.remove).not.toHaveBeenCalled();
    await f.runtime.away.sweep(); expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it("does not remove an old away reason from an inactive member on Return", async () => {
    const f = await fixture(); await f.close(); f.inactive("done");
    const before = f.hold(), calls = f.stop.mock.calls.length;
    await f.runtime.away.return(returned); await f.runtime.away.sweep();
    expect(f.hold()).toEqual(before);
    expect(f.stop).toHaveBeenCalledTimes(calls);
  });
});

async function drain(f: Awaited<ReturnType<typeof fixture>>, queue: ReturnType<typeof makeQueueEntry>[], delivered: string[]) {
  for (const row of [...queue]) {
    const text = row.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const result = await f.runtime.dispatch(makeMessageDispatchHookContext({ thread: { id: "child", status: "idle", archivedAt: runtimeFixture(f.k.store, "child").archivedAt ?? null },
      queuedMessages: [row], initiator: "agent", originPluginId: "tavern", senderThreadId: "lead", input: { text, blocks: row.content } }));
    if (result.action !== "proceed") continue;
    delivered.push(row.id); queue.splice(queue.indexOf(row), 1); f.runtime.dispatched(row);
  }
}
function briefRow(id: string, text: string) {
  return makeQueueEntry({ id: "queued-brief", threadId: "child", initiator: "agent", originPluginId: "tavern", senderThreadId: "lead",
    content: [{ type: "text", text: `[Tavern brief] id=${id}\n${text}`, mentions: [], visibility: "agent-only" }] });
}
describe("inactive queued briefs", () => {
  it.each([false, true])("keeps an already queued brief read-only while closed, delivering once only if still unarchived: %s", async archived => {
    const f = await fixture(); f.inactive("done"); await f.close();
    const queue = [briefRow("brief", "New work")], delivered: string[] = [];
    patchThreadFixture(f.k.store, "child", { pendingBrief: { id: "brief", text: "New work", attempts: 1, nextAttemptAt: f.time(), attemptedAt: f.time(), hostAfterSeq: 0, error: null } });
    f.bb.sdk.threads.queuedMessages.list = async ({ threadId }) => threadId === "child" ? queue : [];
    vi.spyOn(f.bb.experimental_hooks, "recheck").mockImplementation(async () => { await drain(f, queue, delivered); });
    await drain(f, queue, delivered);
    expect(delivered).toEqual([]); expect(queue).toHaveLength(1);
    expect(f.runtime.away.snapshot().watchedCount).toBe(0); expect(f.hold()).toBeUndefined();
    if (archived) f.runtime.updateThread(makeThreadResponse({ id: "child", status: "idle", archivedAt: f.time() }));
    await f.runtime.away.return(returned);
    await drain(f, queue, delivered); await f.runtime.retryInitialBriefs("lead"); await drain(f, queue, delivered);
    expect(delivered).toEqual(archived ? [] : ["queued-brief"]);
    expect(queue).toHaveLength(archived ? 1 : 0);
    expect(f.k.store.runtime("child").briefVersion ?? 0).toBe(archived ? 0 : 1);
    expect(f.stop).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(f.hold()).toBeUndefined();
  });
  it.each([false, true])("keeps a pending retry unsent while closed and sends through normal dispatch once only if unarchived: %s", async archived => {
    const f = await fixture(); f.inactive("done"); await f.close();
    const queue: ReturnType<typeof makeQueueEntry>[] = [], delivered: string[] = [];
    f.bb.sdk.threads.queuedMessages.list = async ({ threadId }) => threadId === "child" ? queue : [];
    vi.spyOn(f.bb.experimental_hooks, "recheck").mockImplementation(async () => { await drain(f, queue, delivered); });
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockImplementation(async () => {
      const pending = runtimeFixture(f.k.store, "child").pendingBrief!;
      queue.push(briefRow(pending.id, pending.text)); await drain(f, queue, delivered);
      return queue.length ? { delivery: "queued", ok: true, queuedMessage: queue[0]! } : { delivery: "sent", ok: true };
    });
    const sources = captureRequestSources(f.k, "lead", f.quest.id), frozenText = `New work\n\n${requestSourcePacket(f.k, sources)}`;
    expect(sources.sources).toHaveLength(1); expect(frozenText).toContain("\nDraft\n");
    expect(await f.runtime.sendRebrief("child", "New work")).toEqual({ briefPending: true });
    const pending = runtimeFixture(f.k.store, "child").pendingBrief!;
    expect(pending.assignmentText).toBe("New work"); expect(pending.text).toBe(frozenText); expect(pending.requestSources).toEqual(sources);
    await f.runtime.retryInitialBriefs("lead");
    expect(send).not.toHaveBeenCalled(); expect(delivered).toEqual([]);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toEqual(pending);
    expect(f.runtime.away.snapshot().watchedCount).toBe(0); expect(f.hold()).toBeUndefined();
    if (archived) f.runtime.updateThread(makeThreadResponse({ id: "child", status: "idle", archivedAt: f.time() }));
    await f.runtime.away.return(returned); await f.runtime.retryInitialBriefs("lead"); await f.runtime.retryInitialBriefs("lead");
    expect(send).toHaveBeenCalledTimes(archived ? 0 : 1);
    if (archived) {
      expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
      const refused = f.k.store.events("lead", 0, 200).filter(event => event.type === "member.brief-refused");
      expect(refused).toHaveLength(1); expect(refused[0]!.data).toEqual({ memberThreadId: "child", briefId: pending.id });
      expect(refused[0]!.text).toContain("archived");
    } else {
      expect(send.mock.calls[0]![0].input).toEqual([{ type: "text", text: `[Tavern brief] id=${pending.id}\n${frozenText}`, mentions: [], visibility: "agent-only" }]);
      expect(runtimeFixture(f.k.store, "child")).toMatchObject({ pendingBrief: null, assignmentText: "New work", requestSources: sources });
    }
    expect(delivered).toEqual(archived ? [] : ["queued-brief"]);
    expect(f.k.store.runtime("child").briefVersion ?? 0).toBe(archived ? 0 : 1);
    expect(f.stop).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.hold()).toBeUndefined();
  });
});

it.each(["released", "stopped"] as const)("admits a direct user message to an open unplaced %s thread", async state => {
  const f = await fixture();
  if (state === "released") patchThreadFixture(f.k.store, "child", { released: { reason: "Finished", decisionId: "release" } });
  else fixtureActivity(f.k, "child", "stopped");
  const result = await f.runtime.away.dispatch(makeMessageDispatchHookContext({ thread: { id: "child", status: "idle" }, initiator: "user" }));
  expect(result).toBeNull();
  expect(f.k.member("child")?.engagement).toBe(state);
});

describe("away lifecycle boundaries", () => {
  it.each(["stopping", "ended"])("refuses a %s quest in the Closing time finish selection", async kind => {
    const f = await fixture();
    putQuestFixture(f.k.store, f.quest.id, { ...f.quest, ...(kind === "stopping" ? { phase: "stopping" as const } : { endedAt: f.time() }) });
    await expect(f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.quest.id, endState: "drafts-ready" }] })).rejects.toThrow("live quests");
    expect(f.runtime.away.store.snapshot().window).toBeNull();
    expect(f.stop).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["quiet", "deleted"])("does not re-anchor a %s Keeper on close or Return", async kind => {
    const f = await fixture(); f.inactive("done");
    patchThreadFixture(f.k.store, "lead", { reanchor: "Existing facts", queuedTickResetId: "existing-reset", ...(kind === "quiet" ? { manualStopAt: f.time() } : { deletedAt: f.time() }) });
    const before = f.k.store.runtime("lead");
    await f.close(); await f.runtime.away.return(returned);
    expect(f.k.store.runtime("lead")).toEqual(before);
    expect(f.stop).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
});

describe("archived Keeper reopening", () => {
  it.each(["late-report", "restart"])("never sends an archived Keeper a tick without Closing time: %s", async cause => {
    const f = await fixture();
    patchThreadFixture(f.k.store, "lead", { archivedAt: f.time() });
    f.k.report("child", { status: "done", outcome: "Late findings", evidence: [], artifacts: [], confidence: null, voice: null });
    const runtime = cause === "restart" ? new TavernRuntime(f.bb, f.k, f.runtime.registry) : f.runtime;
    await runtime.sweep();
    expect(runtime.away.store.snapshot().window).toBeNull();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not re-anchor or rebuild an archived Keeper's queue on close, Return or a later tick", async () => {
    const f = await fixture(); f.inactive("done");
    patchThreadFixture(f.k.store, "lead", { archivedAt: f.time(), reanchor: "Old facts", queuedTickResetId: "old-reset" });
    const before = f.k.store.runtime("lead");
    await f.close(); await f.runtime.away.return(returned); await f.runtime.tick("lead");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.k.store.runtime("lead")).toEqual(before);
    expect(f.harness.inspection.sdk.callsTo("threads.get")).toEqual([]);
  });
  it.each(["archived", "deleted"])("refuses a tick when a fresh SDK read discovers a %s Keeper", async kind => {
    const f = await fixture(); f.k.store.event(f.time(), "lead", null, "route.corrected", "Facts ready");
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle", ...(kind === "archived" ? { archivedAt: f.time() } : { deletedAt: f.time() }) });
    await f.runtime.tick("lead");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rechecks cached archival immediately before sending after awaited event reads", async () => {
    const f = await fixture(); f.k.store.event(f.time(), "lead", null, "route.corrected", "Facts ready");
    f.bb.sdk.threads.events.list = async () => { patchThreadFixture(f.k.store, "lead", { archivedAt: f.time() }); return []; };
    await f.runtime.tick("lead");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not admit an old queued tick for an archived Keeper after Return's dispatch recheck", async () => {
    const f = await fixture();
    expect(await f.runtime.dispatch(makeMessageDispatchHookContext({ thread: { id: "lead", status: "idle", archivedAt: f.time() }, initiator: "agent", originPluginId: "tavern", senderThreadId: null,
      input: { text: "[Tavern tick] id=old\nOld facts", blocks: [{ type: "text", text: "[Tavern tick] id=old\nOld facts", mentions: [], visibility: "agent-only" }] } }))).not.toMatchObject({ action: "proceed" });
    expect(f.send).not.toHaveBeenCalled();
  });
});
