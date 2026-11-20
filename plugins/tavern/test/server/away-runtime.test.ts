// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { TavernRuntime } from "../../src/server/runtime";

async function party() {
  const stop = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
  const f = setup({ threads: {
    stop,
    get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", environmentId: "env" }),
    send: async () => ({ delivery: "sent" }),
    queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) },
    events: { list: async () => [] },
    updatePluginMetadata: async () => ({}),
  } });
  const quest = await seedQuest(f.k,"lead", "Build a draft", "A tested draft");
  f.k.bind("child", "smith", "vale", "project", {
    keeperThreadId: "lead", boardQuestId: quest.id, waypointId: null, errand: false, title: "Draft",
    displayName: "Pip", brief: { outcome: "Draft", doneWhen: "Tests", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null },
  });
  f.runtime.spawnBriefDelivered("child");
  const close = (allowWatched = false, endState: "pause" | "drafts-ready" = "drafts-ready") => f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: quest.id, endState }], allowWatched });
  return { ...f, quest, stop, close };
}
const human = () => makeMessageDispatchHookContext({ thread: { id: "lead", status: "idle" }, initiator: "user", originPluginId: null, senderThreadId: null,
  input: { text: "I'm back", blocks: [{ type: "text", text: "I'm back", mentions: [] }] } });

describe("Closing time runtime", () => {
  it("is inert and open before the first window", async () => {
    const f = await party();
    expect(f.runtime.away.snapshot()).toMatchObject({ revision: 0, status: { closed: false }, watchedCount: 1, heldCount: 0 });
    await f.runtime.away.sweep();
    expect(f.stop).not.toHaveBeenCalled();
  });
  it("interrupts watched members without terminating the quest, releasing the slot or changing manual quiet", async () => {
    const f = await party();
    f.k.store.patch("lead", { manualStopAt: f.time() });
    const before = f.k.store.get("quests", f.quest.id);
    const result = await f.close();
    expect(result.code).toBe("closed");
    expect(f.stop).toHaveBeenCalledWith({ threadId: "child" });
    expect(f.k.store.get("quests", f.quest.id)).toEqual(before);
    expect(f.k.store.runtime("child").released).toBeFalsy();
    expect(f.k.member("child")?.state).not.toBe("stopped");
    expect(f.k.store.runtime("lead").manualStopAt).toBe(f.time());
    expect(f.runtime.away.snapshot()).toMatchObject({ heldCount: 1, pendingStops: [] });
  });
  it("lets explicitly opted-in watched drafts continue but always holds pause", async () => {
    const f = await party();
    await f.close(true);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.runtime.away.blocked("child")).toBe(false);
    const g = await party();
    await g.close(true, "pause");
    expect(g.stop).toHaveBeenCalledOnce();
    expect(g.runtime.away.blocked("child")).toBe(true);
  });
  it("holds unselected and unattached side quests while selected opted-in drafts and solos continue", async () => {
    const f = await party(), other = await seedQuest(f.k,"lead", "Other", "Findings");
    const bind = (threadId: string, questId: string | null) => f.k.bind(threadId, "ranger", "lark", "project", { keeperThreadId: "lead", boardQuestId: questId, waypointId: null, errand: true, title: "Scout", displayName: "Lark", brief: { outcome: "Scout", doneWhen: "Findings", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
    bind("attached", f.quest.id); bind("other", other.id); bind("unattached", null);
    f.k.bind("solo", "wanderer", "pip", "project");
    await f.close(true);
    expect(f.runtime.away.blocked("attached")).toBe(false);
    expect(f.runtime.away.blocked("child")).toBe(false);
    expect(f.runtime.away.blocked("solo")).toBe(false);
    expect(f.runtime.away.blocked("other")).toBe(true);
    expect(f.runtime.away.blocked("unattached")).toBe(true);
    expect(new Set(f.stop.mock.calls.map(([args]) => args.threadId))).toEqual(new Set(["other", "unattached"]));
  });
  it("keeps failed interruptions durable and retries visibly after restart", async () => {
    const f = await party();
    f.stop.mockRejectedValueOnce(new Error("stop offline"));
    expect(await f.close()).toMatchObject({ code: "pending", state: { pendingStops: [{ threadId: "child", error: expect.stringContaining("stop offline") }] } });
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.away.sweep();
    expect(f.stop).toHaveBeenCalledTimes(2);
    expect(restarted.away.snapshot().pendingStops).toEqual([]);
  });
  it("does not reopen by the clock or replay an old pending brief on return", async () => {
    const f = await party();
    f.k.store.patch("child", { pendingBrief: { id: "old", text: "Old work", attempts: 0, nextAttemptAt: f.time(), attemptedAt: null, hostAfterSeq: null, error: null } });
    await f.close();
    f.advance(90_000);
    expect(f.runtime.away.snapshot().status).toMatchObject({ closed: true, dueBack: true });
    await f.runtime.away.return({ kind: "explicit-return", threadId: null, refId: null });
    await f.runtime.retryInitialBriefs("lead");
    expect(f.runtime.away.snapshot().status.closed).toBe(false);
    expect(f.runtime.away.blocked("child")).toBe(true);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    await f.runtime.tell("lead", "child", "New instructions");
    expect(f.runtime.away.blocked("child")).toBe(false);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });
  it("does not count a paused member as stale", async () => {
    const f = await party();
    await f.close();
    f.advance(60 * 60_000);
    await f.runtime.sweep();
    expect(f.k.member("child")!.strikes).toBe(0);
  });
  it("does not strike a member for the turn interrupted by Closing time", async () => {
    const f = await party();
    const strikes = f.k.member("child")!.strikes;
    await f.close();
    f.runtime.memberEnded(makeThreadResponse({ id: "child", status: "idle" }), "Interrupted");
    expect(f.k.member("child")!.strikes).toBe(strikes);
  });
  it("recognizes a real return through actual dispatch but not a plugin message", async () => {
    const f = await party();
    await f.close();
    await f.runtime.dispatch({ ...human(), originPluginId: "another-plugin" });
    expect(f.runtime.away.snapshot().status.closed).toBe(true);
    await f.runtime.dispatch(human());
    expect(f.runtime.away.snapshot().window?.returnCause).toEqual({ kind: "user-message", threadId: "lead", refId: null });
  });
  it("blocks a held member's actual dispatch after return until a fresh tell", async () => {
    const f = await party();
    await f.close();
    await f.runtime.away.return({ kind: "explicit-return", threadId: null, refId: null });
    const result = await f.runtime.dispatch({ ...human(), thread: makeThreadResponse({ id: "child", status: "idle" }), initiator: "agent", senderThreadId: "lead" });
    expect(result.action).toBe("wait");
  });
  it("removes only Tavern's old queued work and refuses to replay other people's rows", async () => {
    const f = await party();
    const own = makeQueueEntry({ id: "own", threadId: "child", originPluginId: "tavern", initiator: "system", content: [{ type: "text", text: "[Tavern brief] old", mentions: [], visibility: "agent-only" }] });
    const user = makeQueueEntry({ id: "user", threadId: "child", initiator: "user", originPluginId: null, senderThreadId: null });
    let rows = [own, user];
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockImplementation(async () => rows);
    const remove = vi.spyOn(f.bb.sdk.threads.queuedMessages, "delete").mockImplementation(async ({ queuedMessageId }) => { rows = rows.filter(row => row.id !== queuedMessageId); return { ok: true }; });
    await f.close();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ threadId: "child", queuedMessageId: "own" });
    await f.runtime.away.return({ kind: "explicit-return", threadId: null, refId: null });
    await expect(f.runtime.tell("lead", "child", "New work")).rejects.toThrow(/queued messages.*review/i);
    expect(rows.map(row => row.id)).toEqual(["user"]);
  });
  it("does not confuse an old in-flight delivery with the new Keeper brief", async () => {
    const f = await party();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.bb.sdk.threads.send;
    vi.spyOn(f.bb.sdk.threads, "send").mockImplementation(async args => { entered(); await gate; return original(args); });
    const old = f.runtime.sendRebrief("child", "Old pending instructions");
    await started;
    await f.close();
    await f.runtime.away.return({ kind: "explicit-return", threadId: null, refId: null });
    const fresh = f.runtime.tell("lead", "child", "Fresh instructions");
    release();
    await expect(fresh).rejects.toThrow(/in flight/i);
    await old;
  });
  it("puts the reopening digest in the next tick without resuming a manually quiet Keeper", async () => {
    const f = await party();
    f.k.store.patch("lead", { userAt: null });
    await f.close();
    f.k.store.event(f.time(), "lead", f.quest.id, "report.filed", "Draft evidence arrived");
    await f.runtime.away.return({ kind: "explicit-return", threadId: null, refId: null });
    await f.runtime.tick("lead");
    const calls = f.harness.inspection.sdk.callsTo("threads.send");
    expect(JSON.stringify(calls)).toContain("Since-return digest");
    const g = await party();
    g.k.store.patch("lead", { manualStopAt: g.time() });
    await g.close();
    await g.runtime.away.return({ kind: "explicit-return", threadId: null, refId: null });
    await g.runtime.tick("lead");
    expect(g.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(g.k.store.runtime("lead").manualStopAt).toBe(g.time());
  });
  it.each(["release", "wrap"] as const)("does not let a background %s bypass a paused quest's hold", async operation => {
    const f = await party();
    await f.close(false, "pause");
    const result = operation === "release" ? f.runtime.release("lead", "child", "Old stale worker") : f.runtime.proposeWrap("lead", f.quest.id, "Done", "Nothing");
    await expect(result).rejects.toThrow(/closed/i);
    expect(f.k.store.runtime("child").released).toBeFalsy();
  });
  it("sends an opted-in production wake after two hours under consequential notifications, once across restart", async () => {
    const f = await party();
    await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.quest.id, endState: "pause" }], wakeRules: { blockers: false, productionAsksAfterTwoHours: true } });
    f.k.ask("lead", { effect: {type:"decision"}, boardQuestId: f.quest.id, kind: "production", question: "Production?", why: "Needs you", options: [{ id: "no", label: "No", detail: "Wait", recommended: true }], meanwhile: "Drafts", holds: [] });
    f.advance(2 * 60 * 60_000 - 1);
    await f.runtime.away.sweep();
    expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    f.advance(1);
    await f.runtime.away.sweep();
    expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.away.sweep();
    expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
  });
  it("respects existing notification off and quiet hours even with away wake opt-ins", async () => {
    const f = await party(), base = f.runtime.config();
    let attention = { ...base.attention, notify: "none" as const };
    const config = vi.spyOn(f.runtime, "config").mockImplementation(() => ({ ...base, attention }));
    await f.close();
    const ask = f.k.ask("lead", { effect: {type:"answer-blocker"}, boardQuestId: f.quest.id, kind: "blocker", question: "Blocked?", why: "Needs you", options: [{ id: "no", label: "Wait", detail: "Wait", recommended: true }], meanwhile: "Wait", holds: [] });
    await f.runtime.push("lead", ask.question, ask.why, ask.id);
    expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    config.mockImplementation(() => ({ ...base, attention: { ...base.attention, quietHours: { start: "00:00", end: "23:59", timeZone: "UTC" } } }));
    await f.runtime.push("lead", ask.question, ask.why, ask.id);
    expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });
  it("honors wake choices in the existing push path", async () => {
    const f = await party();
    await f.close();
    const ask = f.k.ask("lead", { effect: {type:"decision"}, boardQuestId: f.quest.id, kind: "production", question: "Production?", why: "Needs you", options: [{ id: "no", label: "No", detail: "Wait", recommended: true }], meanwhile: "Drafts", holds: [] });
    await f.runtime.push("lead", ask.question, ask.why, ask.id);
    expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  });
});
