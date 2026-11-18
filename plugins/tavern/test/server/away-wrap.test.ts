// @vitest-environment node
import { concludeQuest } from "./support";
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { planInput, waypointEntry } from "./support";
import { readAwayDigest } from "../../src/server/away/digest";
import { TavernRuntime } from "../../src/server/runtime";

async function fixture(endState: "drafts-ready" | "pause" = "drafts-ready", allowWatched = false) {
  const archive = vi.fn(async () => ({ ok: true as const }));
  const f = setup({ threads: { archive, stop: async () => ({ ok: true }), get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }), queuedMessages: { list: async () => [] } } });
  const q = await seedQuest(f.k,"lead", "Private draft", "Verified draft");
  f.k.plan("lead", planInput(q.id));
  f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
  f.k.bind("child", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Draft", displayName: "Vale", brief: { outcome: "Draft", mode: "make-it-work", doneWhen: "Tests pass", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
  f.port.linkedEntries = () => [{ ...waypointEntry("child", q.id), status: "verified" }];
  const ask = f.k.ask("lead", { boardQuestId: q.id, kind: "production", question: "Publish later?", why: "Needs you", options: [{ id: "wait", label: "Wait", detail: "Wait for return", recommended: true }], meanwhile: "Private drafts", holds: [] });
  await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: q.id, endState }], allowWatched });
  return { ...f, q, ask, archive };
}
describe("Closing time internal wrapping", () => {
  it("returns a finished draft and closes its asks without archiving members while closed", async () => {
    const f = await fixture();
    expect(await concludeQuest(f.runtime, "lead", f.q.id, "Draft tested", "Publication waits")).toEqual({ pendingArchives: ["child"] });
    expect(f.k.quest(f.q.id).phase).toBe("done");
    expect(f.k.store.get("asks", f.ask.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "quest-returned", withdrawnAt: f.time() });
    expect(f.k.store.runtime("child").archivePending).toBe(true);
    const digest = readAwayDigest(f.k, f.runtime.away.store, {});
    expect(digest.quests[0]).toMatchObject({ returnedWhileAway: true, deferredCleanup: [{ threadId: "child", action: "archive-member-thread", pending: true, error: null }] });
    expect(digest.events.find(event => event.type === "quest.wrapped")?.data.outcome).toBe("Draft tested");
    await concludeQuest(f.runtime, "lead", f.q.id, "Repeat", "");
    await f.runtime.sweep();
    expect(f.archive).not.toHaveBeenCalled();
  });
  it("keeps the cleanup deferred across reload, then uses existing cleanup retries after return", async () => {
    const f = await fixture();
    await concludeQuest(f.runtime, "lead", f.q.id, "Draft tested", "");
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.sweep();
    expect(f.archive).not.toHaveBeenCalled();
    await restarted.away.return({ kind: "explicit-return", threadId: null, refId: null });
    await restarted.sweep();
    expect(f.archive).toHaveBeenCalledWith({ threadId: "child" });
    expect(readAwayDigest(f.k, restarted.away.store, {}).quests[0]).toMatchObject({ returnedWhileAway: true, deferredCleanup: [{ threadId: "child", pending: false }] });
  });
  it("keeps a completed, previously continuing party fenced after return until archival", async () => {
    const f = await fixture("drafts-ready", true);
    expect(f.runtime.away.blocked("child")).toBe(false);
    await concludeQuest(f.runtime, "lead", f.q.id, "Draft tested", "");
    await f.runtime.away.return({ kind: "explicit-return", threadId: null, refId: null });
    expect(f.runtime.away.blocked("child")).toBe(true);
    expect(await f.runtime.dispatch(makeMessageDispatchHookContext({ thread: { id: "child", status: "idle" }, initiator: "agent", originPluginId: "tavern", senderThreadId: "lead", input: { text: "Old work", blocks: [{ type: "text", text: "Old work", mentions: [] }] } }))).toMatchObject({ action: "wait", reason: expect.stringContaining("deferred cleanup") });
    await expect(f.runtime.tell("lead", "child", "Old work")).rejects.toThrow(/archiv|finished/i);
  });
  it("does not wrap a paused quest or change its asks", async () => {
    const f = await fixture("pause");
    await expect(concludeQuest(f.runtime, "lead", f.q.id, "Done", "")).rejects.toThrow(/closed|held/i);
    expect(f.k.quest(f.q.id).phase).not.toBe("done");
    expect(f.k.store.get("asks", f.ask.id)?.state).toBe("open");
    expect(f.archive).not.toHaveBeenCalled();
  });
});
