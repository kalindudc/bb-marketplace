// @vitest-environment node
import { seedQuest } from "./support";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { TavernRuntime } from "../../src/server/runtime";
import { setup } from "./runtime-fixture";
import { makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "./host";

const returned = { kind: "explicit-return" as const, threadId: null, refId: null };
const brief = { outcome: "Private draft", doneWhen: "Tests pass", mode: "make-it-work" as const, outOfScope: "Production", context: [], questions: [], timeboxMinutes: null };
function fixture() {
  const send = vi.fn(async (_args: Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0]) => ({ delivery: "sent" as const }));
  const f = setup({ threads: {
    send, stop: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }),
    get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", environmentId: "env" }),
    events: { list: async () => [] }, queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) },
    updatePluginMetadata: async () => ({}),
  } });
  const anchors = vi.spyOn(f.k, "reanchor");
  const close = () => f.runtime.away.close({ revision: f.runtime.away.snapshot().revision, until: f.time() + 60_000, quests: [] });
  const context = () => f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "lead" } })).instructions;
  const child = (keeperThreadId = "lead", boardQuestId: string | null = null) => f.k.bind("child", "smith", "vale", "project", {
    keeperThreadId, boardQuestId, waypointId: null, errand: true, title: "Draft", brief,
  });
  return { ...f, send, anchors, close, context, child };
}
function sentText(f: ReturnType<typeof fixture>, index = 0) {
  return f.send.mock.calls[index]![0].input.map(block => block.type === "text" ? block.text : "").join("\n");
}
function anchorsFor(f: ReturnType<typeof fixture>, threadId = "lead") {
  return f.anchors.mock.calls.filter(([id]) => id === threadId).map(([, reason]) => reason);
}

describe("Closing time re-anchors only Keepers with window work", () => {
  it("does not buy Close or Return turns for an empty Keeper, while retaining queue invalidation", async () => {
    const f = fixture();
    await f.close();
    expect(f.anchors).not.toHaveBeenCalled();
    expect(f.k.store.runtime("lead").queuedTickResetId).toEqual(expect.any(String));
    await f.runtime.tick("lead");
    expect(f.send).not.toHaveBeenCalled();
    await f.runtime.away.return(returned);
    expect(f.anchors).not.toHaveBeenCalled();
    expect(f.k.store.runtime("lead").queuedTickResetId).toEqual(expect.any(String));
    await f.runtime.tick("lead");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("shows closed and reopened state in fresh configuration and the next naturally needed tick", async () => {
    const f = fixture();
    await f.close();
    expect(f.context()).toContain("Closing time: closed until");
    await f.runtime.tick("lead");
    expect(f.send).not.toHaveBeenCalled();
    f.k.store.event(f.time(), "lead", null, "promise.due", "A separate reminder needs a turn");
    await f.runtime.tick("lead");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(sentText(f)).toContain("Closing time: closed until");
    expect(sentText(f)).not.toContain("Re-anchor after Closing time");
    f.send.mockClear();
    await f.runtime.away.return(returned);
    expect(f.context()).toContain("Tavern reopened");
    await f.runtime.tick("lead");
    expect(f.send).not.toHaveBeenCalled();
    f.k.store.event(f.time(), "lead", null, "promise.due", "Another separate reminder");
    await f.runtime.tick("lead");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(sentText(f)).toContain("Tavern reopened");
    expect(f.anchors).not.toHaveBeenCalled();
  });

  it("still re-anchors open work on Close and Return even when no quest was selected", async () => {
    const f = fixture();
    await seedQuest(f.k, "lead", "Unselected work", "A private draft");
    f.k.store.patch("lead", { userAt: null });
    await f.close();
    await f.runtime.tick("lead");
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.runtime.away.return(returned);
    await f.runtime.tick("lead");
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(anchorsFor(f)).toEqual([expect.stringContaining("Closing time changed"), expect.stringContaining("Tavern reopened")]);
  });

  it("re-anchors the work-owning Keeper but not an empty neighbour", async () => {
    const f = fixture();
    f.k.bind("busy", "keeper", "wren", "project");
    await seedQuest(f.k, "busy", "Held work", "Verified draft");
    f.k.store.patch("busy", { userAt: null });
    await f.close();
    await f.runtime.tick("lead"); await f.runtime.tick("busy");
    expect(anchorsFor(f, "lead")).toEqual([]);
    expect(anchorsFor(f, "busy")).toHaveLength(1);
    expect(f.send.mock.calls.map(([args]) => args.threadId)).toEqual(["busy"]);
    await f.runtime.away.return(returned);
    await f.runtime.tick("lead"); await f.runtime.tick("busy");
    expect(anchorsFor(f, "lead")).toEqual([]);
    expect(anchorsFor(f, "busy")).toHaveLength(2);
    expect(f.send.mock.calls.map(([args]) => args.threadId)).toEqual(["busy", "busy"]);
  });

  it("remembers finished watched work across restart when choosing the Return cohort", async () => {
    const f = fixture(), quest = await seedQuest(f.k, "lead", "Watched draft", "Private result");
    f.k.store.patch("lead", { userAt: null });
    const child = f.child("lead", quest.id);
    await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: quest.id, endState: "drafts-ready" }], allowWatched: true });
    expect(f.runtime.away.snapshot().heldCount).toBe(0);
    await f.runtime.tick("lead");
    expect(f.k.store.runtime("lead").reanchor).toBeNull();
    f.k.store.put("quests", quest.id, { ...quest, phase: "done", endedAt: f.time() });
    f.k.store.put("members", child.threadId, { ...child, state: "done" });
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    f.anchors.mockClear(); f.send.mockClear();
    await restarted.away.return(returned);
    expect(anchorsFor(f)).toEqual([expect.stringContaining("Tavern reopened")]);
    await restarted.tick("lead");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(sentText(f)).toContain("Tavern reopened");
  });

  it("notices work staged during the window even when its Keeper was empty at Close", async () => {
    const f = fixture(); await f.close();
    expect(f.anchors).not.toHaveBeenCalled();
    await seedQuest(f.k,"lead", "Newly staged work", "A draft");
    await f.runtime.away.return(returned);
    expect(anchorsFor(f)).toEqual([expect.stringContaining("Tavern reopened")]);
  });

  it.each(["finishes", "becomes-live"])("retains relevant work if it %s before Close requests its anchors", async change => {
    const f = fixture(), quest = await seedQuest(f.k,"lead", "Changing work", "Private draft");
    if (change === "becomes-live") f.k.store.put("quests", quest.id, { ...quest, archivedAt: f.time() });
    vi.spyOn(f.bb.rpc, "experimental_invalidate").mockImplementationOnce(() => {
      f.k.store.put("quests", quest.id, change === "finishes" ? { ...quest, phase: "done", endedAt: f.time() } : quest);
    });
    await f.close();
    expect(anchorsFor(f)).toEqual([expect.stringContaining("Closing time changed")]);
    await f.runtime.tick("lead");
    f.anchors.mockClear();
    await f.runtime.away.return(returned);
    expect(anchorsFor(f)).toEqual([expect.stringContaining("Tavern reopened")]);
  });

  it("does not carry an earlier window's work cohort into a later empty window", async () => {
    const f = fixture(), quest = await seedQuest(f.k,"lead", "First window", "Draft");
    await f.close(); await f.runtime.tick("lead");
    f.k.store.put("quests", quest.id, { ...quest, phase: "done", endedAt: f.time() });
    await f.runtime.away.return(returned); await f.runtime.tick("lead");
    f.anchors.mockClear(); f.send.mockClear();
    await f.close(); await f.runtime.tick("lead");
    await f.runtime.away.return(returned); await f.runtime.tick("lead");
    expect(f.anchors).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("keeps a human message reachable and recorded when the empty Keeper returns everyone", async () => {
    const f = fixture();
    f.k.bind("busy", "keeper", "wren", "project");
    const quest = await seedQuest(f.k,"busy", "Paused work", "Draft");
    f.child("busy", quest.id);
    await f.close();
    expect(f.runtime.away.blocked("child")).toBe(true);
    f.anchors.mockClear();
    const result = await f.runtime.dispatch(makeMessageDispatchHookContext({ thread: { id: "lead", status: "idle" }, input: { text: "I am back", blocks: [{ type: "text", text: "I am back", mentions: [] }] } }));
    expect(result).toEqual({ action: "proceed" });
    expect(f.runtime.away.snapshot().status.closed).toBe(false);
    expect(f.k.store.runtime("lead").pending.map(message => message.text)).toEqual(["I am back"]);
    expect(anchorsFor(f, "lead")).toEqual([]);
    expect(anchorsFor(f, "busy")).toEqual([expect.stringContaining("Tavern reopened")]);
    expect(f.runtime.away.blocked("child")).toBe(true);
    const childInput = { ...makeMessageDispatchHookContext({ thread: { id: "child", status: "idle" }, initiator: "agent", originPluginId: "tavern" }), senderThreadId: "busy" };
    expect(await f.runtime.dispatch(childInput)).toMatchObject({ action: "wait" });
  });

  it("preserves an unrelated re-anchor rather than replacing it with an empty Close or Return", async () => {
    const f = fixture();
    f.k.reanchor("lead", "after compaction");
    f.anchors.mockClear();
    await f.close();
    expect(f.k.store.runtime("lead").reanchor).toBe("after compaction");
    await f.runtime.away.return(returned);
    expect(f.k.store.runtime("lead").reanchor).toBe("after compaction");
    expect(f.anchors).not.toHaveBeenCalled();
  });

  it.each(["done", "stopped", "archived"])("does not count an old %s quest as window work", async state => {
    const f = fixture(), quest = await seedQuest(f.k,"lead", "Old work", "Past result");
    f.k.store.put("quests", quest.id, { ...quest, ...(state === "archived" ? { archivedAt: f.time() } : { phase: state as "done" | "stopped", endedAt: f.time() }) });
    await f.close(); await f.runtime.away.return(returned);
    expect(f.anchors).not.toHaveBeenCalled();
  });

  it.each(["done", "failed", "stopped", "released", "archived", "deleted"])("does not count an old %s member as window work", async state => {
    const f = fixture(), member = f.child();
    if (state === "released") f.k.store.patch(member.threadId, { released: { reason: "Finished", decisionId: "past-decision" } });
    else if (state === "archived") f.k.store.patch(member.threadId, { archivedAt: f.time() });
    else if (state === "deleted") f.k.store.patch(member.threadId, { deletedAt: f.time() });
    else f.k.store.put("members", member.threadId, { ...member, state: state as "done" | "failed" | "stopped" });
    await f.close(); await f.runtime.away.return(returned);
    expect(f.anchors).not.toHaveBeenCalled();
  });

  it.each(["pending", "cancelled", "bound-finished", "missing-quest"])("counts only real staged hires: %s", async state => {
    const f = fixture();
    if (state === "bound-finished") { const member = f.child(); f.k.store.put("members", member.threadId, { ...member, state: "done" }); }
    f.k.store.put("hires", "staged", { classId: "ranger", characterId: "lark", projectId: "project", createdAt: f.time(),
      ...(state === "cancelled" ? { cancelledAt: f.time() } : {}), ...(state === "bound-finished" ? { memberThreadId: "child" } : {}),
      owner: { keeperThreadId: "lead", boardQuestId: state === "missing-quest" ? "missing" : null, waypointId: null, errand: true, title: "Staged scout", brief } });
    await f.close(); await f.runtime.away.return(returned);
    expect(anchorsFor(f)).toHaveLength(state === "pending" ? 2 : 0);
  });

  it.each(["live", "pending-brief", "release", "ended-release", "cleanup"])("keeps relevant %s party work in the cohort without an open quest", async state => {
    const f = fixture(), member = f.child();
    if (state !== "live") f.k.store.put("members", member.threadId, { ...member, state: state === "release" ? "stopped" : "done" });
    if (state === "pending-brief") f.k.store.patch(member.threadId, { pendingBrief: { id: "fresh", text: "Fresh instructions", attempts: 0, nextAttemptAt: f.time(), attemptedAt: null, hostAfterSeq: null, error: null } });
    if (state === "release" || state === "ended-release") f.k.store.patch(member.threadId, { releasePending: "Confirm release" });
    if (state === "ended-release") {
      const quest = await seedQuest(f.k,"lead", "Ended work", "Past draft");
      f.k.store.put("quests", quest.id, { ...quest, phase: "done", endedAt: f.time() });
      f.k.store.put("members", member.threadId, { ...f.k.member(member.threadId)!, boardQuestId: quest.id });
    }
    if (state === "cleanup") f.k.store.patch(member.threadId, { archivePending: true });
    await f.close(); await f.runtime.away.return(returned);
    expect(anchorsFor(f)).toHaveLength(2);
  });
});
