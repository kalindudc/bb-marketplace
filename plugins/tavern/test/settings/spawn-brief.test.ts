// @vitest-environment node
import { patchThreadFixture, runtimeFixture } from "../server/member-fixture";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../server/runtime-fixture";

function member(waitingForSpawnReceipt = false) {
  const f = setup();
  const owner = { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Task", brief: { outcome: "Task", doneWhen: "Done", mode: "make-it-work" as const, outOfScope: "", context: [], questions: [], timeboxMinutes: null } };
  const token = waitingForSpawnReceipt ? "spawn-hire" : undefined;
  if (token) f.k.store.put("hires", token, { classId: "smith", characterId: "vale", projectId: "project", owner, createdAt: f.time(), memberThreadId: "child" });
  f.k.bind("child", "smith", "vale", "project", owner, token);
  return f;
}
describe("accepted spawn brief", () => {
  it("marks accepted spawn input once without sending another message", async () => {
    const f = member(true), send = vi.spyOn(f.bb.sdk.threads, "send");
    f.runtime.spawnBriefDelivered("child");
    f.runtime.spawnBriefDelivered("child");
    await f.runtime.retryInitialBriefs("lead");
    expect(runtimeFixture(f.k.store, "child")).toMatchObject({ initialBriefAt: f.time(), lastBriefAt: f.time(), briefVersion: 1, pendingBrief: null });
    expect(f.k.store.events("lead", 0, 100).filter(event => event.type === "member.briefed")).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });
  it("clears obsolete initial pending state but preserves a later rebrief", async () => {
    const f = member();
    patchThreadFixture(f.k.store, "child", { pendingBrief: { id: "old", text: "The task", attempts: 0, nextAttemptAt: f.time(), attemptedAt: null, hostAfterSeq: null, error: null } });
    f.runtime.spawnBriefDelivered("child");
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("offline"));
    await f.runtime.sendRebrief("child", "A later instruction");
    const pending = runtimeFixture(f.k.store, "child").pendingBrief;
    f.runtime.spawnBriefDelivered("child");
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toEqual(pending);
  });
  it("refuses an unbound child", () => {
    const f = member();
    expect(() => f.runtime.spawnBriefDelivered("missing")).toThrow("bound");
  });
  it("never reconstructs an initial send from a stored brief", async () => {
    const f = member(), send = vi.spyOn(f.bb.sdk.threads, "send");
    f.k.store.patch("child", { brief: { outcome: "Task", doneWhen: "Done", mode: "make-it-work", outOfScope: "", context: [], questions: [], timeboxMinutes: null } });
    await f.runtime.retryInitialBriefs("lead");
    expect(send).not.toHaveBeenCalled();
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeUndefined();
  });
  it("durably retries an explicit rebrief after an accepted spawn, without overwriting another one", async () => {
    const f = member(), send = vi.spyOn(f.bb.sdk.threads, "send");
    f.runtime.spawnBriefDelivered("child");
    send.mockRejectedValueOnce(new Error("offline"));
    expect(await f.runtime.sendRebrief("child", "A later instruction")).toEqual({ briefPending: true });
    const pending = runtimeFixture(f.k.store, "child").pendingBrief!;
    await expect(f.runtime.sendRebrief("child", "Different instruction")).rejects.toThrow("different");
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toEqual(pending);
    f.advance(60_001);
    await f.runtime.retryInitialBriefs("lead");
    expect(send).toHaveBeenCalledTimes(2);
    expect(runtimeFixture(f.k.store, "child")).toMatchObject({ pendingBrief: null, briefVersion: 2 });
    expect(f.k.store.runtime("child").initialBriefAt).toBe(1_000_000);
  });
});
