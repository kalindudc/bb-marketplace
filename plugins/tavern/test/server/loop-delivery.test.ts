// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { queued049 } from "./dispatch-fixture";
import { makeThreadResponse } from "./host";
import type { BackendScopes } from "../../src/server/scopes";

function news(f: ReturnType<typeof setup>) {
  return f.k.store.event(f.time(), "lead", null, "promise.due", "A fact that must remain unread until delivery");
}

describe("Keeper loop delivery failures", () => {
  it("does not mark a live Keeper stopped for an unrelated maintenance 404", async () => {
    const f = setup();
    news(f);
    vi.spyOn(f.k, "stale").mockImplementation(() => { throw Object.assign(new Error("row missing"), { status: 404 }); });
    await f.runtime.sweep();
    expect(f.k.member("lead")?.state).not.toBe("stopped");
    await f.runtime.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("confirms a missing Keeper with threads.get before marking it stopped", async () => {
    const f = setup();
    vi.spyOn(f.k, "stale").mockImplementation(() => { throw Object.assign(new Error("row missing"), { status: 404 }); });
    vi.spyOn(f.bb.sdk.threads, "get").mockRejectedValue(Object.assign(new Error("thread not found"), { status: 404 }));
    await f.runtime.sweep();
    expect(f.harness.inspection.sdk.callsTo("threads.get").length).toBeGreaterThan(0);
    expect(f.k.member("lead")?.state).toBe("stopped");
  });

  it("does not mark a live Keeper stopped for a reconcile scope-row 404", async () => {
    const f = setup();
    f.runtime.scopes = { refreshPresets: vi.fn().mockResolvedValue(undefined), pinWorktree: vi.fn().mockRejectedValue(Object.assign(new Error("scope missing"), { status: 404 })) } as unknown as BackendScopes;
    await f.runtime.reconcile();
    expect(f.k.member("lead")?.state).not.toBe("stopped");
  });

  it("retires a queued tick when its row disappears between list and delete", async () => {
    const f = setup();
    news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValue({ delivery: "queued" } as Awaited<ReturnType<typeof f.bb.sdk.threads.send>>);
    await f.runtime.tick("lead");
    const old = f.k.store.pendingTick("lead")!;
    const row = queued049("dispatched-row", old.text, f.time(), { pluginId: "tavern" });
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "list").mockResolvedValueOnce([row]);
    f.bb.sdk.threads.queuedMessages.delete = vi.fn().mockRejectedValue(Object.assign(new Error("queue row not found"), { status: 404 }));
    f.k.store.patch("lead", { queuedTickResetId: "reset" });
    await expect(f.runtime.tick("lead")).resolves.toBeUndefined();
    expect(f.k.store.tick(old.id)?.state).toBe("cancelled");
    expect(f.k.store.runtime("lead").queuedTickResetId).toBeNull();
    expect(f.k.member("lead")?.state).not.toBe("stopped");
  });

  it("sends to a currently live Keeper despite a stale cached stopped state", async () => {
    const f = setup();
    news(f);
    f.k.activity("lead", "stopped");
    await f.runtime.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it.each([400, 403, 404, 422])("cancels a definite HTTP %s refusal immediately and raises a blocker after two", async status => {
    const f = setup();
    news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(Object.assign(new Error(`HTTP ${status}: invalid model`), { status }));
    await f.runtime.tick("lead");
    expect(f.k.store.pendingTick("lead")).toBeNull();
    expect(f.k.store.runtime("lead").cursor).toBe(0);
    expect(f.k.store.events("lead").filter(e => e.type === "tick.failed")).toHaveLength(1);
    f.advance(60_000);
    await f.runtime.tick("lead");
    expect(f.k.asks("lead").filter(a => a.kind === "blocker" && a.state === "open")).toHaveLength(1);
    await f.runtime.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
  });

  it.each([new Error("socket closed"), Object.assign(new Error("HTTP 503 unavailable"), { status: 503 })])("retains uncertain delivery for %s", async error => {
    const f = setup();
    news(f);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(error);
    await f.runtime.tick("lead");
    expect(f.k.store.pendingTick("lead")?.state).toBe("prepared");
    expect(f.k.store.runtime("lead").cursor).toBe(0);
    expect(f.k.store.events("lead").some(e => e.type === "tick.failed")).toBe(false);
    await f.runtime.tick("lead");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });
});
