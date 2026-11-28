// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { TavernRuntime } from "../../src/server/runtime";
import { dispatch049 } from "./dispatch-fixture";

function fact(f: ReturnType<typeof setup>, threadId = "lead") {
  f.k.store.event(f.time(), threadId, null, "promise.due", `Fact for ${threadId}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());

describe("Keeper loop scheduling and startup", () => {
  it("still ticks when an earlier maintenance step throws", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.k, "stale").mockImplementation(() => { throw new Error("stale query failed"); });
    await f.runtime.sweep();
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("still ticks when Closing time maintenance throws", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.runtime.away, "sweep").mockRejectedValue(new Error("away store failed"));
    await expect(f.runtime.sweep()).resolves.toBeUndefined();
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("does not let one hung Keeper SDK read delay another Keeper", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.k.bind("other", "keeper", "moss", "project"); fact(f); fact(f, "other");
    const stuck = deferred<ReturnType<typeof makeThreadResponse>>();
    vi.spyOn(f.bb.sdk.threads, "get").mockImplementation(async ({ threadId }) => threadId === "lead" ? stuck.promise : makeThreadResponse({ id: threadId }));
    const sweep = f.runtime.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.harness.inspection.sdk.callsTo("threads.send").map(call => (call.args[0] as { threadId: string }).threadId)).toEqual(["other"]);
    await vi.advanceTimersByTimeAsync(40_001);
    await expect(sweep).resolves.toBeUndefined();
    stuck.resolve(makeThreadResponse({ id: "lead" }));
  });

  it("bounds a hung tick read, releases single-flight, and ignores its late continuation", async () => {
    vi.useFakeTimers();
    const f = setup(); fact(f);
    const stuck = deferred<ReturnType<typeof makeThreadResponse>>();
    vi.spyOn(f.bb.sdk.threads, "get").mockReturnValueOnce(stuck.promise);
    const first = f.runtime.tick("lead");
    const result = expect(first).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(20_001);
    await result;
    await f.runtime.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    stuck.resolve(makeThreadResponse({ id: "lead" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("keeps a timed-out send uncertain beyond retry age, then acknowledges its late success without a duplicate", async () => {
    vi.useFakeTimers();
    const f = setup(); fact(f);
    const late = deferred<Awaited<ReturnType<typeof f.bb.sdk.threads.send>>>();
    vi.spyOn(f.bb.sdk.threads, "send").mockReturnValueOnce(late.promise);
    const first = f.runtime.tick("lead");
    await vi.advanceTimersByTimeAsync(20_001);
    await first;
    const batch = f.k.store.pendingTick("lead")!;
    expect(batch.state).toBe("prepared");
    f.advance(119_999);
    await f.runtime.tick("lead"); await f.runtime.tick("lead");
    expect(f.k.store.tick(batch.id)?.state).toBe("prepared");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    late.resolve({ delivery: "sent" } as Awaited<ReturnType<typeof f.bb.sdk.threads.send>>);
    await vi.advanceTimersByTimeAsync(1);
    await f.runtime.tick("lead");
    expect(f.k.store.tick(batch.id)?.state).toBe("delivered");
    expect(f.k.store.runtime("lead").cursor).toBeGreaterThan(0);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("retains a timed-out send across reload until accepted-input history confirms it", async () => {
    vi.useFakeTimers();
    const f = setup(); fact(f);
    const late = deferred<Awaited<ReturnType<typeof f.bb.sdk.threads.send>>>();
    vi.spyOn(f.bb.sdk.threads, "send").mockReturnValueOnce(late.promise);
    const first = f.runtime.tick("lead"); await vi.advanceTimersByTimeAsync(20_001); await first;
    const batch = f.k.store.pendingTick("lead")!;
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    f.advance(119_999);
    await restarted.tick("lead"); await restarted.tick("lead");
    expect(f.k.store.tick(batch.id)?.state).toBe("prepared");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    vi.spyOn(f.bb.sdk.threads.events, "list").mockResolvedValue([{ seq: 1, type: "client/turn/requested", data: { input: batch.text }, createdAt: f.time() }] as never);
    await restarted.tick("lead");
    expect(f.k.store.tick(batch.id)?.state).toBe("delivered");
    late.resolve({ delivery: "sent" } as Awaited<ReturnType<typeof f.bb.sdk.threads.send>>);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("delivers once after reload when a timed-out send never reached bb", async () => {
    vi.useFakeTimers();
    const f = setup(); fact(f);
    const late = deferred<Awaited<ReturnType<typeof f.bb.sdk.threads.send>>>();
    let delivered = 0;
    vi.spyOn(f.bb.sdk.threads, "send").mockReturnValueOnce(late.promise).mockImplementation(async () => {
      delivered++;
      return { delivery: "sent" } as Awaited<ReturnType<typeof f.bb.sdk.threads.send>>;
    });
    const first = f.runtime.tick("lead"); await vi.advanceTimersByTimeAsync(20_001); await first;
    const batch = f.k.store.pendingTick("lead")!;
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    f.advance(120_001);
    await restarted.tick("lead");
    expect(f.k.store.tick(batch.id)?.state).toBe("delivered");
    expect(f.k.store.tick(batch.id)?.resendCount).toBe(1);
    await restarted.tick("lead");
    expect(delivered).toBe(1);
    expect(f.k.store.runtime("lead").cursor).toBeGreaterThan(0);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
  });

  it("admits exactly one action when an ambiguous original arrives after its same-id resend", async () => {
    vi.useFakeTimers();
    const f = setup(); fact(f);
    const release = deferred<void>();
    let actions = 0;
    const texts: string[] = [];
    const deliver = async (text: string) => {
      const decision = await f.runtime.dispatch(dispatch049({ text, pluginId: "tavern" }));
      if (decision.action === "reject") throw Object.assign(new Error(decision.message), { status: 409 });
      expect(decision.action).toBe("proceed");
      actions++;
      return { delivery: "sent" } as Awaited<ReturnType<typeof f.bb.sdk.threads.send>>;
    };
    vi.spyOn(f.bb.sdk.threads, "send").mockImplementation(async args => {
      const text = args.input.filter(b => b.type === "text").map(b => b.text).join("\n");
      texts.push(text);
      if (texts.length === 1) await release.promise;
      return deliver(text);
    });
    const first = f.runtime.tick("lead"); await vi.advanceTimersByTimeAsync(20_001); await first;
    const batch = f.k.store.pendingTick("lead")!;
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    f.advance(120_001); await restarted.tick("lead");
    expect(actions).toBe(1);
    release.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(actions).toBe(1);
    expect(texts).toHaveLength(2);
    expect(texts.every(text => text.includes(`id=${batch.id}`))).toBe(true);
    expect(texts[1]).toContain("Delivery retry");
    expect(f.k.store.tick(batch.id)?.state).toBe("delivered");
  });

  it("shows unresolved delivery only after two same-id resends", async () => {
    vi.useFakeTimers();
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockReturnValue(new Promise(() => {}));
    const first = f.runtime.tick("lead"); await vi.advanceTimersByTimeAsync(20_001); await first;
    const batch = f.k.store.pendingTick("lead")!;
    for (let attempt = 1; attempt <= 2; attempt++) {
      f.advance(120_001);
      const tick = f.runtime.tick("lead"); await vi.advanceTimersByTimeAsync(20_001); await tick;
      expect(f.k.store.pendingTick("lead")?.id).toBe(batch.id);
      expect(f.k.store.tick(batch.id)?.resendCount).toBe(attempt);
      expect(f.k.asks("lead").filter(ask => ask.kind === "blocker" && ask.state === "open")).toHaveLength(attempt === 2 ? 1 : 0);
    }
  });

  it("rechecks host deletion immediately before sending even when no lifecycle event arrived", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "get").mockResolvedValueOnce(makeThreadResponse({ id: "lead" }))
      .mockResolvedValue(makeThreadResponse({ id: "lead", deletedAt: f.time() }));
    await f.runtime.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("does not rebuild an unresolved send when a quiet-queue reset arrives", async () => {
    vi.useFakeTimers();
    const f = setup(); fact(f);
    const late = deferred<Awaited<ReturnType<typeof f.bb.sdk.threads.send>>>();
    vi.spyOn(f.bb.sdk.threads, "send").mockReturnValueOnce(late.promise);
    const first = f.runtime.tick("lead"); await vi.advanceTimersByTimeAsync(20_001); await first;
    const batch = f.k.store.pendingTick("lead")!;
    f.k.store.patch("lead", { queuedTickResetId: "reset" });
    const reset = f.runtime.tick("lead");
    await vi.advanceTimersByTimeAsync(20_001); await reset;
    expect(f.k.store.runtime("lead").queuedTickResetId).toBeNull();
    expect(f.k.store.tick(batch.id)?.state).toBe("prepared");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    late.resolve({ delivery: "sent" } as Awaited<ReturnType<typeof f.bb.sdk.threads.send>>);
    await vi.advanceTimersByTimeAsync(1);
  });

  it.each(["thread/compacted", "system/thread/interrupted"] as const)("observes %s during startup before building the first recovery tick", async type => {
    const f = setup();
    vi.spyOn(f.bb.sdk.threads.events, "list").mockImplementation(async args => args.types?.includes(type) ? [{ seq: 1, type, scope: { kind: "thread" }, data: { reason: "host-daemon-restarted" }, createdAt: f.time() }] as never : []);
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.reconcile();
    expect(f.k.store.runtime("lead").reanchor).toMatch(type === "thread/compacted" ? /compaction/ : /host-daemon-restarted/);
    if (type === "thread/compacted") {
      await restarted.tick("lead");
      expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
      expect(f.k.store.runtime("lead").reanchor).toMatch(/compaction/);
      fact(f);
    }
    await restarted.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(f.k.store.runtime("lead").reanchor).toBeNull();
  });

  it("observes a manual Stop from downtime before preparing a tick", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads.events, "list").mockImplementation(async args => args.types?.includes("system/thread/interrupted") ? [{ seq: 1, type: "system/thread/interrupted", scope: { kind: "thread" }, data: { reason: "manual-stop" }, createdAt: f.time() }] as never : []);
    await f.runtime.reconcile(); await f.runtime.tick("lead");
    expect(f.k.store.runtime("lead").manualStopAt).toBe(f.time());
    expect(f.k.store.pendingTick("lead")).toBeNull();
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
});
