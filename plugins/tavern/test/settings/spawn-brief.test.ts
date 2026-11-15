// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { setup } from "../server/runtime-fixture";

function member() {
  const f = setup();
  f.k.bind("child", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Task", brief: { outcome: "Task", doneWhen: "Done", mode: "make-it-work", outOfScope: "", context: [], questions: [], timeboxMinutes: null } });
  return f;
}
describe("accepted spawn brief", () => {
  it("marks accepted spawn input once without sending another message", async () => {
    const f = member(), send = vi.spyOn(f.bb.sdk.threads, "send");
    f.runtime.spawnBriefDelivered("child");
    f.runtime.spawnBriefDelivered("child");
    await f.runtime.retryInitialBriefs("lead");
    expect(f.k.store.runtime("child")).toMatchObject({ initialBriefAt: f.time(), lastBriefAt: f.time(), briefVersion: 1, pendingBrief: null });
    expect(f.k.store.events("lead", 0, 100).filter(event => event.type === "member.briefed")).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });
  it("clears obsolete initial pending state but preserves a later rebrief", async () => {
    const f = member();
    f.k.store.patch("child", { pendingBrief: { id: "old", text: "The task", attempts: 0, nextAttemptAt: f.time(), attemptedAt: null, hostAfterSeq: null, error: null } });
    f.runtime.spawnBriefDelivered("child");
    expect(f.k.store.runtime("child").pendingBrief).toBeNull();
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("offline"));
    await f.runtime.sendRebrief("child", "A later instruction");
    const pending = f.k.store.runtime("child").pendingBrief;
    f.runtime.spawnBriefDelivered("child");
    expect(f.k.store.runtime("child").pendingBrief).toEqual(pending);
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
    expect(f.k.store.runtime("child").pendingBrief).toBeUndefined();
  });
  it("durably retries an explicit rebrief after an accepted spawn, without overwriting another one", async () => {
    const f = member(), send = vi.spyOn(f.bb.sdk.threads, "send");
    f.runtime.spawnBriefDelivered("child");
    send.mockRejectedValueOnce(new Error("offline"));
    expect(await f.runtime.sendRebrief("child", "A later instruction")).toEqual({ briefPending: true });
    const pending = f.k.store.runtime("child").pendingBrief!;
    await expect(f.runtime.sendRebrief("child", "Different instruction")).rejects.toThrow("different");
    expect(f.k.store.runtime("child").pendingBrief).toEqual(pending);
    f.advance(60_001);
    await f.runtime.retryInitialBriefs("lead");
    expect(send).toHaveBeenCalledTimes(2);
    expect(f.k.store.runtime("child")).toMatchObject({ pendingBrief: null, briefVersion: 2 });
    expect(f.k.store.runtime("child").initialBriefAt).toBe(1_000_000);
  });
});
