// @vitest-environment node
import { seedQuest } from "./support";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { setup } from "./runtime-fixture";
import { registerRpc } from "../../src/server/rpc";
import { awayHandlers } from "../../src/server/away/rpc";
import { makeThreadResponse } from "./host";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
function fixture() {
  const f = setup(), host = createFakePluginHost({ pluginId: "tavern" });
  hosts.push(host);
  registerRpc(host.bb, f.runtime);
  return { ...f, call: (method: string, input: unknown, plugin = false) => host.harness.behavior.callRpc(method, input, plugin ? { experimental_caller: { kind: "plugin", pluginId: "other-plugin" } } : { experimental_caller: { kind: "client" } }) };
}
function bind(f: ReturnType<typeof fixture>, threadId: string, questId: string | null) {
  return f.k.bind(threadId, "ranger", "lark", "project", { keeperThreadId: "lead", boardQuestId: questId, waypointId: null, errand: true, title: "Scout", displayName: "Lark", brief: { outcome: "Scout", doneWhen: "Findings", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
}
const input = { revision: 0, until: 2_000_000, quests: [] };
describe("Closing time RPC", () => {
  it("exposes open room data by default and page views never return", async () => {
    const f = fixture();
    expect(await f.call("room", {})).toHaveProperty("away", { closed: false, until: null, dueBack: false, windowId: null, followUp: false });
    const result = await f.call("awayClose", input) as { state: { window: { id: string } } };
    await f.call("room", {}); await f.call("away", {}); await f.call("awayDigest", {});
    expect(f.runtime.away.snapshot().status.closed).toBe(true);
    expect(result.state.window.id).toBeTruthy();
  });
  it("groups watched party members by quest, including unattached errands but not solos or inactive allocations", async () => {
    const f = fixture(), first = await seedQuest(f.k,"lead", "First", "Draft"), second = await seedQuest(f.k,"lead", "Second", "Draft");
    bind(f, "first-a", first.id); bind(f, "first-b", first.id); bind(f, "second", second.id); bind(f, "unattached", null);
    bind(f, "released", first.id); f.k.store.patch("released", { released: { reason: "Done", decisionId: "release" } });
    bind(f, "releasing", first.id); f.k.store.patch("releasing", { releasePending: "Done" });
    bind(f, "archiving", second.id); f.k.store.patch("archiving", { archivePending: true });
    const stopped = bind(f, "stopped", second.id); f.k.store.put("members", stopped.threadId, { ...stopped, state: "stopped" });
    f.k.bind("solo", "wanderer", "pip", "project");
    expect(await f.call("away", {})).toMatchObject({ revision: 0, watchedCount: 4, watchedByQuest: expect.arrayContaining([
      { questId: first.id, watchedCount: 2 }, { questId: second.id, watchedCount: 1 }, { questId: null, watchedCount: 1 },
    ]), soloCount: 1, eligibleByQuest: expect.arrayContaining([
      { questId: first.id, members: 2, watchedCount: 2 }, { questId: second.id, members: 1, watchedCount: 1 }, { questId: null, members: 1, watchedCount: 1 },
    ]) });
    expect(f.runtime.away.store.snapshot().window).toBeNull();
  });
  it.each(["done-member", "archived-member", "stopped-member", "done-quest", "stopped-quest", "archived-quest", "missing-quest"])("does not count inactive work in the closing warning: %s", async variant => {
    const f = fixture(), quest = await seedQuest(f.k,"lead", "Old quest", "Draft"), member = bind(f, "old-member", variant === "missing-quest" ? "missing" : quest.id);
    if (variant === "done-member" || variant === "stopped-member") f.k.store.put("members", member.threadId, { ...member, state: variant === "done-member" ? "done" : "stopped" });
    if (variant === "archived-member") f.k.store.patch(member.threadId, { archivedAt: 0 });
    if (variant === "done-quest" || variant === "stopped-quest") f.k.store.put("quests", quest.id, { ...quest, phase: variant === "done-quest" ? "done" : "stopped", endedAt: f.time() });
    if (variant === "archived-quest") f.k.store.put("quests", quest.id, { ...quest, archivedAt: f.time() });
    expect(await f.call("away", {})).toMatchObject({ watchedCount: 0, watchedByQuest: [], eligibleByQuest: [], soloCount: 0 });
    expect(f.runtime.away.store.snapshot().window).toBeNull();
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
  });
  it("excludes archived completed members even though activity preserves their done state", async () => {
    const f = fixture(), quest = await seedQuest(f.k,"lead", "Old quest", "Draft"), member = bind(f, "finished", quest.id);
    f.k.store.put("members", member.threadId, { ...member, state: "done" });
    f.runtime.updateThread(makeThreadResponse({ id: member.threadId, status: "idle", archivedAt: f.time() }));
    expect(f.k.member(member.threadId)?.state).toBe("done");
    expect(await f.call("away", {})).toMatchObject({ watchedCount: 0, watchedByQuest: [] });
  });
  it("counts a rebriefed completed member only after real activity resumes", async () => {
    const f = fixture(), quest = await seedQuest(f.k,"lead", "Live quest", "Draft"), member = bind(f, "rebriefed", quest.id);
    f.k.store.put("members", member.threadId, { ...member, state: "done" });
    f.k.store.patch(member.threadId, { pendingBrief: { id: "new-brief", text: "Fresh work", attempts: 0, nextAttemptAt: f.time(), attemptedAt: null, hostAfterSeq: null, error: null } });
    expect(await f.call("away", {})).toMatchObject({ watchedCount: 0, watchedByQuest: [] });
    f.runtime.updateThread(makeThreadResponse({ id: member.threadId, status: "active" }));
    expect(await f.call("away", {})).toMatchObject({ watchedCount: 1, watchedByQuest: [{ questId: quest.id, watchedCount: 1 }] });
  });
  it("counts only live solos for display without making them close participants", async () => {
    const f = fixture();
    for (const state of ["working", "idle", "waiting", "done", "failed", "stopped"] as const) {
      const member = f.k.bind(state, "wanderer", "pip", "project"); f.k.store.put("members", state, { ...member, state });
    }
    for (const threadId of ["archived", "deleted", "released"]) {
      f.k.bind(threadId, "wanderer", "pip", "project");
      f.k.store.patch(threadId, threadId === "archived" ? { archivedAt: 0 } : threadId === "deleted" ? { deletedAt: 0 } : { released: { reason: "Done", decisionId: "release" } });
    }
    expect(await f.call("away", {})).toMatchObject({ soloCount: 3, eligibleByQuest: [], watchedCount: 0 });
    await f.call("awayClose", input);
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
  });
  it.each(["failed", "deleted", "ended", "stopping"])("excludes shared-work-ineligible %s members from both count sets", async variant => {
    const f = fixture(), quest = await seedQuest(f.k,"lead", "Old quest", "Draft"), member = bind(f, "old-member", quest.id);
    if (variant === "failed") f.k.store.put("members", member.threadId, { ...member, state: "failed" });
    if (variant === "deleted") f.k.store.patch(member.threadId, { deletedAt: f.time() });
    if (variant === "ended") f.k.store.put("quests", quest.id, { ...quest, endedAt: f.time() });
    if (variant === "stopping") f.k.store.put("quests", quest.id, { ...quest, phase: "stopping" });
    expect(await f.call("away", {})).toMatchObject({ watchedCount: 0, watchedByQuest: [], eligibleByQuest: [] });
  });
  it.each(["awayClose", "awayReturn"])("refuses plugin-origin %s before any mutation", async method => {
    const f = fixture();
    await expect(f.call(method, method === "awayClose" ? input : { windowId: "old" }, true)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.runtime.away.snapshot().revision).toBe(0);
  });
  it("refuses missing caller context in the shared factory", async () => {
    const f = fixture();
    await expect(async () => awayHandlers(f.runtime).awayClose(input)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("returns typed stale receipts without closing or returning a newer window", async () => {
    const f = fixture();
    const first = await f.call("awayClose", input) as { state: { window: { id: string } } };
    expect(await f.call("awayClose", input)).toHaveProperty("code", "stale");
    expect(await f.call("awayReturn", { windowId: first.state.window.id })).toHaveProperty("code", "returned");
    await f.call("awayClose", { ...input, revision: 2 });
    expect(await f.call("awayReturn", { windowId: first.state.window.id })).toHaveProperty("code", "stale");
    expect(f.runtime.away.snapshot().status.closed).toBe(true);
  });
  it("returns only after an accepted explicit-client ask answer", async () => {
    const f = fixture();
    const ask = f.k.ask("lead", { kind: "production", question: "Production?", why: "Needs you", options: [{ id: "wait", label: "Wait", detail: "Stay safe", recommended: true }], meanwhile: "Drafts", holds: [] });
    await f.call("awayClose", input);
    await expect(f.call("answerAsk", { askId: ask.id, optionId: "wait", via: "page" }, true)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.runtime.away.snapshot().status.closed).toBe(true);
    await expect(f.call("answerAsk", { askId: ask.id, optionId: "missing", via: "page" })).rejects.toThrow();
    expect(f.runtime.away.snapshot().status.closed).toBe(true);
    await f.call("answerAsk", { askId: ask.id, optionId: "wait", via: "page" });
    expect(f.runtime.away.snapshot().window?.returnCause).toEqual({ kind: "ask-answer", threadId: "lead", refId: ask.id });
  });
});
