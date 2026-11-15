// @vitest-environment node
import { seedQuest } from "./support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scopeForClass } from "../../src/scope/presets";
import { makeThreadResponse } from "./host";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { setup } from "./runtime-fixture";

afterEach(() => vi.useRealTimers());

describe("bb 0.49 dispatch regressions", () => {
  it("H1/L1 plugin sends and retries are never user messages, inline or grouped", async () => {
    const { k, runtime } = setup();
    for (const [pluginId, text] of [
      ["tavern", "[Tavern tick]\nFacts"],
      ["tavern", "[Journal] changed"],
      ["flare", "a nudge"],
    ]) {
      expect((await runtime.dispatch(dispatch049({ pluginId, text }))).action).toBe("proceed");
    }
    await runtime.dispatch(dispatch049({ text: "retry", retry: true }));
    await runtime.dispatch(
      dispatch049({
        rows: [
          queued049("p", "brief", 1_000_000, { pluginId: "tavern" }),
          queued049("s", "retry", 1_000_000, { retry: true }),
        ],
      }),
    );
    expect(k.store.runtime("lead").pending).toEqual([]);
    expect(k.store.runtime("lead").userAt).toBeNull();
  });
  it("H3 records inline then drained once, even after a long queue and repeated drains", async () => {
    const { k, runtime, advance, time } = setup();
    await runtime.dispatch(dispatch049({ text: "Vault: stage first", status: "active" }));
    const row = queued049("row9", "Vault: stage first", time());
    advance(600_000);
    await runtime.dispatch(dispatch049({ rows: [row] }));
    await runtime.dispatch(dispatch049({ rows: [row] }));
    expect(k.store.runtime("lead").pending.map((p) => p.text)).toEqual(["Vault: stage first"]);
  });
  it("H3 grouped mixed authors retain each user's message separately", async () => {
    const { k, runtime, time } = setup();
    await runtime.dispatch(
      dispatch049({
        rows: [
          queued049("one", "first", time()),
          queued049("note", "nudge", time(), { pluginId: "flare" }),
          queued049("two", "second", time()),
        ],
      }),
    );
    expect(k.store.runtime("lead").pending.map((p) => p.text)).toEqual(["first", "second"]);
  });
  it("M1 accepts malformed data and bounds a human Keeper message's port-failure wait to thirty seconds with a notice", async () => {
    const { runtime, port, k, advance, time } = setup();
    expect(
      (
        await runtime.dispatch(
          dispatch049({ submission: { pluginId: "tavern", data: { route: "steer" } } }),
        )
      ).action,
    ).toBe("proceed");
    vi.useFakeTimers();
    const scope = scopeForClass("keeper"), ensure = vi.fn();
    runtime.scopes = { api: { mode: () => "enforce", status: () => ({ threads: [{ threadId: "lead", scope }] }) }, ensure } as never;
    port.dispatchCheck = () => { throw new Error("broken port"); };
    const first = await runtime.dispatch(dispatch049());
    expect(first).toMatchObject({ action: "wait", sendAt: expect.any(Number) });
    if (first.action === "wait") expect(first.sendAt).toBeLessThanOrEqual(time() + 30_000);
    advance(29_999);
    await vi.advanceTimersByTimeAsync(29_999);
    const retry = await runtime.dispatch(dispatch049());
    expect(retry).toMatchObject({ action: "wait", sendAt: time() + 1 });
    advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await runtime.dispatch(dispatch049())).toEqual({ action: "proceed" });
    expect(k.store.runtime("lead").classNotice).toMatchObject({ message: expect.stringContaining("Tavern's checks failed"), settings: true, switchExecution: null });
    expect(k.store.runtime("lead").classNotice?.message).toContain("broken port");
    expect(k.store.runtime("lead").classNotice?.message).toContain("existing scope");
    expect(ensure).not.toHaveBeenCalled();
    expect(scope.preset).toBe("open");
  });
  it.each(["member", "hire", "tick", "plugin"] as const)("keeps a %s waiting after the generic failure deadline", async kind => {
    const { runtime, port, k, advance } = setup();
    vi.useFakeTimers();
    if (kind === "member") k.bind("worker", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Build", brief: { outcome: "Build", mode: "make-it-work", outOfScope: "Other work", doneWhen: "Evidence", context: [], questions: [], timeboxMinutes: null } });
    const ctx = kind === "member" ? dispatch049({ threadId: "worker" }) : kind === "hire" ? dispatch049({ threadId: "new-worker", status: "pending", submission: { pluginId: "tavern", data: { hireToken: "reserved" } } }) : dispatch049({ pluginId: kind === "tick" ? "tavern" : "flare", text: kind === "tick" ? "[Tavern tick] id=tick_1234" : "A nudge" });
    port.dispatchCheck = () => { throw new Error("broken port"); };
    expect(await runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    advance(30_001);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    expect(k.store.runtime(ctx.thread.id).classNotice).toBeUndefined();
  });
  it("restarts the generic failure wait after normal admission recovers", async () => {
    const { runtime, port, advance } = setup();
    vi.useFakeTimers();
    const original = port.dispatchCheck;
    const broken = () => { throw new Error("broken port"); };
    port.dispatchCheck = broken;
    expect(await runtime.dispatch(dispatch049())).toMatchObject({ action: "wait" });
    advance(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    port.dispatchCheck = original;
    expect(await runtime.dispatch(dispatch049())).toEqual({ action: "proceed" });
    advance(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    port.dispatchCheck = broken;
    expect(await runtime.dispatch(dispatch049())).toMatchObject({ action: "wait" });
    advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await runtime.dispatch(dispatch049())).toEqual({ action: "proceed" });
  });
  it("allows a queued human Keeper message after the bound even when grouped with plugin input", async () => {
    const { runtime, port, k, advance, time } = setup();
    vi.useFakeTimers();
    const ctx = dispatch049({ rows: [queued049("plugin", "Nudge", time(), { pluginId: "flare" }), queued049("user", "Please answer", time())] });
    port.dispatchCheck = () => { throw new Error("broken port"); };
    expect(await runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    advance(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(k.store.runtime("lead").classNotice?.message).toContain("broken port");
  });
  it.each(["bound", "new"] as const)("rejects a %s Keeper after the failure bound if its required scope could not be set up", async kind => {
    const { runtime, port, advance } = setup();
    vi.useFakeTimers();
    runtime.scopes = { api: { mode: () => "enforce", status: () => ({ threads: [] }) } } as never;
    const ctx = kind === "bound" ? dispatch049() : dispatch049({ threadId: "fresh-keeper", status: "pending", submission: { pluginId: "tavern", data: { classId: "keeper" } } });
    port.dispatchCheck = () => { throw new Error("broken port"); };
    expect(await runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    advance(30_001);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await runtime.dispatch(ctx)).toEqual({ action: "reject", message: "Tavern couldn't set up this Keeper's scope: broken port. Send again, or start it as a plain thread." });
  });
  it("H2 expires only messages whose following turn ended and reports the miss", async () => {
    const { k, runtime } = setup();
    await runtime.dispatch(dispatch049({ text: "thanks" }));
    runtime.updateThread(makeThreadResponse({ id: "lead", status: "active" }));
    await runtime.dispatch(dispatch049({ text: "queued later", status: "active" }));
    runtime.updateThread(makeThreadResponse({ id: "lead", status: "idle" }));
    expect(k.store.runtime("lead").pending.map((p) => p.text)).toEqual(["queued later"]);
    expect(k.store.events("lead").some((e) => e.type === "route.missed")).toBe(true);
  });
  it("M7 enforces explicit route hints", async () => {
    const { k } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    k.receiveUser("lead", "aside", "aside");
    expect(() => k.route("lead", { kind: "steer", boardQuestId: q.id, summary: "bad" })).toThrow(
      /aside/,
    );
    k.route("lead", { kind: "aside", summary: "aside" });
    k.receiveUser("lead", "new", "new-quest");
    expect(() => k.route("lead", { kind: "question", summary: "bad" })).toThrow(/new-quest/);
  });
});
