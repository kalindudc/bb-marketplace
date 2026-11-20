// @vitest-environment node
import { patchThreadFixture, putMemberFixture } from "./member-fixture";
import { putQuestFixture } from "./support";
import { seedQuest } from "./support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Room } from "../../src/shared/contract";
import { AwayHolds } from "../../src/server/away/holds";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function fixture() {
  const f = setup({ threads: {
    stop: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }),
    get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", environmentId: "env" }),
    send: async () => ({ delivery: "sent" }),
    queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) },
    events: { list: async () => [] }, updatePluginMetadata: async () => ({}),
  } });
  databases.push(f.k.store.db); registerRpc(f.bb, f.runtime);
  const quest = await seedQuest(f.k,"lead", "A paused draft", "A draft"), holds = new AwayHolds(f.k.store.db);
  f.k.bind("child", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: quest.id, waypointId: null, errand: false, title: "Draft", brief: { outcome: "Draft", doneWhen: "Proof", mode: "make-it-work", outOfScope: "Publish", context: [], questions: [], timeboxMinutes: null } });
  f.runtime.spawnBriefDelivered("child");
  const owner = () => ({ threadId: "child", keeperThreadId: "lead", questId: quest.id, heldAt: f.time(), cancelledBrief: null });
  const close = async () => await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: quest.id, endState: "pause" }] });
  const room = async () => (await f.harness.invokeRpc("room", {}) as Room).away!;
  const back = () => f.runtime.away.return({ kind: "explicit-return", threadId: null, refId: null });
  return { ...f, quest, holds, owner, close, room, back };
}

describe("Closing time follow-up", () => {
  it("is false without a window, including an unrelated content hold", async () => {
    const f = await fixture();
    expect(await f.room()).toMatchObject({ windowId: null, followUp: false });
    f.holds.requestContent(f.owner(), "content-only");
    expect(await f.room()).toMatchObject({ windowId: null, followUp: false });
  });
  it("stays true for current-window resume work after Return, then clears after fresh instructions", async () => {
    const f = await fixture(); await f.close();
    const windowId = f.runtime.away.store.snapshot().window!.id;
    expect(await f.room()).toMatchObject({ closed: true, windowId, followUp: true });
    await f.back();
    expect(f.runtime.away.snapshot()).toMatchObject({ pendingStops: [], resumeRequired: [{ threadId: "child" }] });
    expect(await f.room()).toMatchObject({ closed: false, windowId, followUp: true });
    await f.runtime.tell("lead", "child", "Fresh instructions");
    expect(await f.room()).toMatchObject({ closed: false, windowId, followUp: false });
    expect(f.runtime.away.snapshot().status.followUp).toBe(false);
  });
  it("includes a pending stop even when resumeRequired is false", async () => {
    const f = await fixture(); await f.close();
    f.holds.put({ ...f.holds.get("child")!, resumeRequired: false, stopPending: true });
    expect(f.runtime.away.snapshot()).toMatchObject({ pendingStops: [{ threadId: "child" }], resumeRequired: [] });
    expect(await f.room()).toHaveProperty("followUp", true);
    f.holds.put({ ...f.holds.get("child")!, stopPending: false });
    expect(await f.room()).toHaveProperty("followUp", false);
  });
  it.each(["done-member", "archived-member", "finished-quest"])("ignores no-longer-eligible work: %s", async variant => {
    const f = await fixture(); await f.close();
    if (variant === "done-member") putMemberFixture(f.k.store, "child", { ...f.k.member("child")!, state: "done" });
    if (variant === "archived-member") patchThreadFixture(f.k.store, "child", { archivedAt: f.time() });
    if (variant === "finished-quest") putQuestFixture(f.k.store, f.quest.id, { ...f.k.quest(f.quest.id), phase: "done", endedAt: f.time() });
    expect(f.runtime.away.snapshot()).toMatchObject({ pendingStops: [], resumeRequired: [] });
    expect(await f.room()).toHaveProperty("followUp", false);
  });
  it("does not include another window but recognizes a current-window reason", async () => {
    const f = await fixture(); await f.close();
    const windowId = f.runtime.away.store.snapshot().window!.id;
    f.holds.put({ ...f.holds.get("child")!, windowId: "older-window", reasons: [{ kind: "away", windowId: "older-window" }] });
    expect(await f.room()).toHaveProperty("followUp", false);
    f.holds.put({ ...f.holds.get("child")!, reasons: [{ kind: "away", windowId }] });
    expect(await f.room()).toHaveProperty("followUp", true);
  });
  it("does not attach fresh content work to a fully resumed away window", async () => {
    const f = await fixture(); await f.close(); await f.back();
    await f.runtime.tell("lead", "child", "Fresh instructions");
    f.holds.requestContent(f.owner(), "new-content");
    expect(f.holds.get("child")!.windowId).toBeNull();
    expect(await f.room()).toHaveProperty("followUp", false);
  });
  it("preserves the window on a content request while away resume work is outstanding", async () => {
    const f = await fixture(); await f.close(); await f.back();
    const windowId = f.runtime.away.store.snapshot().window!.id;
    f.holds.requestContent(f.owner(), "overlapping-content");
    expect(f.holds.get("child")!.windowId).toBe(windowId);
    expect(await f.room()).toHaveProperty("followUp", true);
  });
  it("preserves the window on a content request while only its stop is pending", async () => {
    const f = await fixture(); await f.close();
    const hold = f.holds.get("child")!, windowId = hold.windowId;
    f.holds.put({ ...hold, resumeRequired: false, stopPending: true });
    f.holds.requestContent(f.owner(), "stop-still-pending");
    expect(f.holds.get("child")!.windowId).toBe(windowId);
    expect(await f.room()).toHaveProperty("followUp", true);
  });
  it("room reads are read-only and do not call the full away/scopes RPC", async () => {
    const f = await fixture(); await f.close(); await f.back();
    const before = f.k.store.db.prepare("SELECT * FROM tavern_records ORDER BY kind,id").all(), snapshot = vi.spyOn(f.runtime.away, "snapshot");
    const calls = () => [f.harness.inspection.sdk.callsTo("threads.get").length, f.harness.inspection.sdk.callsTo("threads.stop").length, f.harness.inspection.sdk.callsTo("threads.send").length], beforeCalls = calls();
    await f.room(); await f.room();
    expect(snapshot).not.toHaveBeenCalled();
    expect(calls()).toEqual(beforeCalls);
    expect(f.k.store.db.prepare("SELECT * FROM tavern_records ORDER BY kind,id").all()).toEqual(before);
  });
});
