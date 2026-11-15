// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makeThreadResponse } from "./host";
import { TavernRuntime } from "../../src/server/runtime";

const fact = (f: ReturnType<typeof setup>) => f.k.store.event(f.time(), "lead", null, "promise.due", "An unread fact");
const sends = (f: ReturnType<typeof setup>) => f.harness.inspection.sdk.callsTo("threads.send");
const retrySuffix = "\nDelivery retry of the same tick id. Ignore it if you have already seen or acted on this id.";
afterEach(() => vi.useRealTimers());

describe("loop recheck recovery regressions", () => {
  it("N3 admits a marked resend when the first admission was lost before host dispatch", async () => {
    const f = setup(); fact(f);
    let attempts = 0, actions = 0;
    vi.spyOn(f.bb.sdk.threads, "send").mockImplementation(async args => {
      attempts++;
      const text = args.input.filter(block => block.type === "text").map(block => block.text).join("\n");
      const admitted = await f.runtime.dispatch(dispatch049({ text, pluginId: "tavern" }));
      if (admitted.action === "reject") throw Object.assign(new Error(admitted.message), { status: 400 });
      expect(admitted.action).toBe("proceed");
      if (attempts === 1) throw new Error("daemon stopped after hook admission, before dispatch");
      actions++;
      return { delivery: "sent" } as never;
    });
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    expect(batch.attempted).toBe(true);
    f.advance(120_001); await f.runtime.tick("lead");
    expect(actions).toBe(1);
    expect(f.k.store.tick(batch.id)?.state).toBe("delivered");
    expect(sends(f)).toHaveLength(2);
  });

  it("N3 admits each stored marked resend generation once but rejects its replay and unmarked duplicates", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("unconfirmed send"));
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    const original = dispatch049({ text: batch.text, pluginId: "tavern" });
    expect((await f.runtime.dispatch(original)).action).toBe("proceed");
    expect((await f.runtime.dispatch(original)).action).toBe("reject");
    const marked = dispatch049({ text: batch.text + retrySuffix, pluginId: "tavern" });
    expect((await f.runtime.dispatch(marked)).action).toBe("reject");
    f.k.store.putTick({ ...f.k.store.tick(batch.id)!, resendCount: 1 });
    expect((await f.runtime.dispatch(marked)).action).toBe("proceed");
    expect((await f.runtime.dispatch(marked)).action).toBe("reject");
    f.k.store.putTick({ ...f.k.store.tick(batch.id)!, resendCount: 2 });
    expect((await f.runtime.dispatch(marked)).action).toBe("proceed");
    f.runtime.acknowledgeTick(batch.id);
    expect((await f.runtime.dispatch(marked)).action).toBe("reject");
  });

  it("N3 does not reactivate a batch acknowledged while the resend host read was awaited", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("unconfirmed send"));
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    vi.spyOn(f.bb.sdk.threads, "get").mockImplementation(async () => {
      f.runtime.acknowledgeTick(batch.id);
      return makeThreadResponse({ id: "lead" });
    });
    f.advance(120_001); await f.runtime.tick("lead");
    expect(f.k.store.tick(batch.id)?.state).toBe("delivered");
    expect(sends(f)).toHaveLength(1);
  });

  it("N3 does not reactivate a batch acknowledged while a history page was awaited", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("unconfirmed send"));
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    vi.spyOn(f.bb.sdk.threads.events, "list").mockImplementation(async () => {
      f.runtime.acknowledgeTick(batch.id);
      return Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, type: "client/turn/requested", createdAt: f.time(), data: { text: "other" } })) as never;
    });
    await f.runtime.tick("lead");
    expect(f.k.store.tick(batch.id)?.state).toBe("delivered");
    expect(sends(f)).toHaveLength(1);
  });

  it("N3 Check again immediately reconciles accepted history without waiting for the next retry deadline", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("unconfirmed send"));
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    for (let i = 0; i < 2; i++) { f.advance(120_001); await f.runtime.tick("lead"); }
    const askId = f.k.store.runtime("lead").tickDeliveryAskId!;
    expect(f.k.store.get("asks", askId)?.state).toBe("open");
    vi.spyOn(f.bb.sdk.threads.events, "list").mockResolvedValue([{ seq: 1, type: "client/turn/requested", createdAt: f.time(), data: { text: batch.text } }] as never);
    await f.runtime.answerAsk(askId, "retry", null, "page");
    expect(f.k.store.tick(batch.id)?.state).toBe("delivered");
    expect(f.k.store.runtime("lead").tickDeliveryAskId).toBeNull();
    expect(sends(f)).toHaveLength(3);
  });

  it("N3 Check again retries the same batch immediately when history still has no confirmation", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("unconfirmed send"));
    await f.runtime.tick("lead"); const batch = f.k.store.pendingTick("lead")!;
    for (let i = 0; i < 2; i++) { f.advance(120_001); await f.runtime.tick("lead"); }
    const askId = f.k.store.runtime("lead").tickDeliveryAskId!;
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValue({ delivery: "sent" } as never);
    await f.runtime.answerAsk(askId, "retry", null, "page");
    expect(f.k.store.tick(batch.id)?.state).toBe("delivered");
    expect(sends(f)).toHaveLength(4);
    expect(sends(f).every(call => JSON.stringify(call.args).includes(`id=${batch.id}`))).toBe(true);
  });

  it("N4 clears repeated reset markers around never-settling sends and continues same-id recovery", async () => {
    vi.useFakeTimers();
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockReturnValue(new Promise(() => {}));
    const first = f.runtime.tick("lead"); await vi.advanceTimersByTimeAsync(20_001); await first;
    const batch = f.k.store.pendingTick("lead")!;
    for (let i = 0; i < 4; i++) {
      f.advance(120_001); f.k.store.patch("lead", { queuedTickResetId: `reset-${i}` });
      const outcome = f.runtime.tick("lead").then(() => null, error => error);
      await vi.advanceTimersByTimeAsync(40_002); expect(await outcome).toBeNull();
      expect(f.k.store.runtime("lead").queuedTickResetId).toBeNull();
      expect(f.k.store.pendingTick("lead")?.id).toBe(batch.id);
      expect(sends(f)).toHaveLength(i + 2);
    }
  });
});

describe("loop recheck high regressions", () => {
  it.each([408, 409, 425, 429])("N1 keeps transient HTTP %s uncertain through repeated sweeps", async status => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(Object.assign(new Error(`HTTP ${status}: transient`), { status }));
    for (let i = 0; i < 3; i++) { await f.runtime.sweep(); f.advance(5000); }
    expect(sends(f)).toHaveLength(1);
    expect(f.k.store.pendingTick("lead")?.state).toBe("prepared");
    expect(f.k.store.runtime("lead").tickRefusalCount ?? 0).toBe(0);
    expect(f.k.asks("lead").filter(ask => ask.kind === "blocker")).toHaveLength(0);
  });

  it.each(["connect ECONNRESET 10.0.0.2:443", "request failed for item 404", "model400 is not ready", "prefix HTTP 400: stale diagnostic"])("N1 does not infer HTTP refusal from %s", async message => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error(message));
    await f.runtime.tick("lead");
    expect(f.k.store.pendingTick("lead")?.state).toBe("prepared");
    expect(f.k.store.runtime("lead").tickRefusalCount ?? 0).toBe(0);
  });

  it.each([400, 401, 403, 404, 405, 410, 413, 422])("N1 backs off at least retryMs after definite HTTP %s across reload", async status => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(Object.assign(new Error(`HTTP ${status}: refused`), { statusCode: status }));
    await f.runtime.tick("lead");
    expect(f.k.store.pendingTick("lead")).toBeNull();
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    f.advance(5000); await restarted.tick("lead");
    expect(sends(f)).toHaveLength(1);
    f.advance(54_999); await restarted.tick("lead"); expect(sends(f)).toHaveLength(1);
    f.advance(1); await restarted.tick("lead"); expect(sends(f)).toHaveLength(2);
    expect(f.k.store.runtime("lead").tickRefusalCount).toBe(2);
  });

  it("N2 clears refusal gating and its blocker after a successful completed turn", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("HTTP 403: model refused"));
    await f.runtime.tick("lead"); f.advance(60_001); await f.runtime.tick("lead");
    const askId = f.k.store.runtime("lead").failureAskId!;
    expect(f.k.store.runtime("lead").tickRefusalCount).toBe(2);
    vi.spyOn(f.bb.sdk.threads.events, "list").mockResolvedValueOnce([{ seq: 1, type: "turn/completed", scope: { kind: "turn", turnId: "good" }, data: { status: "completed" }, createdAt: f.time() }] as never);
    await f.runtime.observe(makeThreadResponse({ id: "lead" }));
    expect(f.k.store.runtime("lead").tickRefusalCount).toBe(0);
    expect(f.k.store.get("asks", askId)?.state).toBe("withdrawn");
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValue({ delivery: "sent" } as never);
    await f.runtime.sweep();
    expect(f.k.store.pendingTick("lead")).toBeNull();
    expect(sends(f)).toHaveLength(3);
    expect(f.k.asks("lead").filter(ask => ask.kind === "blocker" && ask.state === "open")).toHaveLength(0);
  });

  it("N2 resets only on accepted Keeper input, including a previously queued receipt", async () => {
    const f = setup(); fact(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("HTTP 403: refused"));
    await f.runtime.tick("lead"); f.advance(60_001); await f.runtime.tick("lead");
    const row = queued049("human", "Use the repaired model", f.time());
    f.runtime.queued(row);
    expect(f.k.store.runtime("lead").tickRefusalCount).toBe(2);
    f.runtime.dispatched(row);
    expect(f.k.store.runtime("lead").tickRefusalCount).toBe(0);
    expect(f.k.store.runtime("lead").failureAskId).toBeNull();
    expect(f.k.asks("lead").filter(ask => ask.kind === "blocker" && ask.state === "open")).toHaveLength(0);
  });
});
