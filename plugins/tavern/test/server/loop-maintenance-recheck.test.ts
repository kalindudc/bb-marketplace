// @vitest-environment node
import { seedQuest } from "./support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { recoverHires } from "../../src/server/hires";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null };
afterEach(() => vi.useRealTimers());

describe("bounded lifecycle maintenance", () => {
  it.each(["list", "metadata", "cancelled-get", "cancelled-stop", "cancelled-archive"] as const)("N5 bounds hung hire recovery %s and preserves its reservation for retry", async point => {
    vi.useFakeTimers();
    const f = setup();
    f.k.store.put("hires", "token", { classId: "smith", characterId: "juno", projectId: "project", createdAt: 0,
      ...(point.startsWith("cancelled") ? { cancelledAt: f.time() } : {}),
      owner: { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Build", brief } });
    f.bb.sdk.threads.list = vi.fn(async () => [makeThreadResponse({ id: "child", parentThreadId: "lead" })] as never);
    f.bb.sdk.threads.getPluginMetadata = vi.fn(async () => ({ hireToken: "token" }));
    f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
    const blocked = new Promise<never>(() => {});
    if (point === "list") vi.spyOn(f.bb.sdk.threads, "list").mockReturnValueOnce(blocked);
    else if (point === "metadata") vi.spyOn(f.bb.sdk.threads, "getPluginMetadata").mockReturnValueOnce(blocked);
    else if (point === "cancelled-get") vi.spyOn(f.bb.sdk.threads, "get").mockReturnValueOnce(blocked);
    else if (point === "cancelled-stop") vi.spyOn(f.bb.sdk.threads, "stop").mockReturnValueOnce(blocked);
    else vi.spyOn(f.bb.sdk.threads, "archive").mockReturnValueOnce(blocked);
    const recovery = recoverHires(f.bb, f.k, "lead");
    await vi.advanceTimersByTimeAsync(20_001); await recovery;
    expect(f.k.store.get("hires", "token")).not.toBeNull();
    await recoverHires(f.bb, f.k, "lead");
    expect(f.k.store.get("hires", "token")).toBeNull();
  });

  it("N5 expires a stale maintenance flight so the Keeper can perform maintenance again", async () => {
    vi.useFakeTimers();
    const f = setup();
    let release!: () => void;
    const stop = vi.spyOn(f.runtime, "retryStops").mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
    const stale = vi.spyOn(f.k, "stale");
    const sweep = f.runtime.sweep(); await vi.advanceTimersByTimeAsync(20_001); await sweep;
    expect(stale).not.toHaveBeenCalled();
    f.advance(180_001); await f.runtime.sweep();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stale).toHaveBeenCalledTimes(1);
    release(); await vi.advanceTimersByTimeAsync(1);
    expect(stale).toHaveBeenCalledTimes(1);
  });

  it("N5 attempts pending Stops before waiting for hire recovery", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.k.store.put("hires", "token", { classId: "smith", characterId: "juno", projectId: "project", createdAt: 0,
      owner: { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Build", brief } });
    const order: string[] = [];
    f.bb.sdk.threads.list = vi.fn(() => { order.push("hires"); return new Promise<never>(() => {}); });
    vi.spyOn(f.runtime, "retryStops").mockImplementation(async () => { order.push("stops"); });
    const sweep = f.runtime.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(order.slice(0, 2)).toEqual(["stops", "hires"]);
    await vi.advanceTimersByTimeAsync(20_001); await sweep;
  });

  it.each(["get", "stop"] as const)("N5 bounds a hung Stop %s call and retries the unconfirmed member", async method => {
    vi.useFakeTimers();
    const f = setup(); const q = await seedQuest(f.k,"lead", "Build", "Build");
    f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Build", brief });
    f.k.activity("child", "working");
    f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, status: "active" }));
    f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
    vi.spyOn(f.bb.sdk.threads, method).mockReturnValueOnce(new Promise<never>(() => {}));
    const stop = f.runtime.stop(q.id);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await stop).toEqual({ phase: "stopping", unconfirmed: 1 });
    expect((f.k.member("child")?.engagement === "stopping")).toBe(true);
    vi.spyOn(f.bb.sdk.threads, "get").mockImplementation(async ({ threadId }) => makeThreadResponse({ id: threadId }));
    f.advance(5000); await f.runtime.retryStops("lead");
    expect(f.k.quest(q.id).phase).toBe("stopped");
    expect((f.k.member("child")?.engagement === "stopping")).toBe(false);
  });
});
