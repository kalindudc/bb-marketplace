// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registerRpc } from "../../src/server/rpc";
import { TavernRuntime } from "../../src/server/runtime";
import { setup } from "./runtime-fixture";

function fixture(enabled: boolean | null = true) {
  const send = vi.fn(async () => ({ ok: true, channels: ["fixture"] }));
  const f = setup({ plugins: { callRpc: send, list: async () => ({ plugins: enabled === null ? [] : [{ id: "push-notifications", enabled }] }) } });
  registerRpc(f.bb, f.runtime);
  const call = (method: string, input: unknown) => f.harness.invokeRpc(method, input, { experimental_caller: { kind: "client" } });
  const ask = f.k.ask("lead", {
    kind: "decision", effect: { type: "decision" }, question: "Clarify?", why: "Needs you",
    options: [{ id: "wait", label: "Wait", detail: "", recommended: true }], meanwhile: "Wait", holds: [],
  });
  return { ...f, send, call, push: () => f.runtime.push("lead", ask.question, ask.why, ask.id),
    events: () => f.k.store.events().filter(e => e.type === "alert.push") };
}

it.each([[null, "plugin-missing"], [false, "plugin-disabled"]] as const)("records an unavailable plugin (%s) as held", async (enabled, reason) => {
  const f = fixture(enabled);
  await f.push();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.events().map(e => e.data)).toEqual([expect.objectContaining({ outcome: "held", reason })]);
});

it("records a real failure once and keeps its message", async () => {
  const f = fixture();
  f.send.mockRejectedValueOnce(new Error("Fixture delivery failed"));
  await Promise.all([f.push(), f.push()]);
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.events().map(e => e.data)).toEqual([expect.objectContaining({ outcome: "failed", error: "Fixture delivery failed" })]);
  expect(await f.call("alertRoute", null)).toMatchObject({ proven: false, lastFailure: { error: "Fixture delivery failed" } });
});

it("dedupes quiet-hour holds without consuming an ask's later send", async () => {
  const f = fixture(), base = f.runtime.config();
  const config = vi.spyOn(f.runtime, "config").mockReturnValue({ ...base, attention: { ...base.attention, quietHours: { start: "00:00", end: "01:00", timeZone: "UTC" } } });
  await f.push();
  await f.push();
  expect(f.events().map(e => e.data)).toEqual([expect.objectContaining({ outcome: "held", reason: "quiet-hours" })]);
  expect(f.send).not.toHaveBeenCalled();
  config.mockRestore();
  await f.push();
  await f.push();
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.events().map(e => e.data.outcome)).toEqual(["held", "sent"]);
});

it("keeps alert attempts, tests and receipts in Settings without displacing room history", async () => {
  const f = fixture();
  const id = f.k.store.event(f.time(), "lead", null, "summary.posted", "A real update");
  for (let i = 0; i < 60; i++) await f.runtime.push("lead", "Fixture", "Fixture push");
  const sent = await f.call("alertTestSend", {}) as { lastTest: { id: number } };
  await f.call("alertTestConfirm", { id: sent.lastTest.id, arrived: true });
  expect(f.k.store.events().some(e => e.type === "authority.acted" && e.data.act === "alertTestConfirm")).toBe(true);
  expect(await f.call("alertRoute", null)).toMatchObject({ proven: true, lastTest: { response: "arrived" } });
  expect(await f.call("room", {})).toMatchObject({ recent: [
    expect.objectContaining({ type: "ask.opened" }), expect.objectContaining({ id, type: "summary.posted" }),
  ] });
});

it("requires a client action to send or confirm, and only an arrival proves delivery", async () => {
  const f = fixture();
  const plugin = { experimental_caller: { kind: "plugin" as const, pluginId: "other" } };
  await expect(f.harness.invokeRpc("alertTestSend", {}, plugin)).rejects.toThrow(/explicit client action/);
  expect(f.send).not.toHaveBeenCalled();
  const result = await f.call("alertTestSend", {}) as { lastTest: { id: number } };
  const id = result.lastTest.id;
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "push-notifications", method: "notifications.send" }));
  expect(result).toMatchObject({ proven: false, lastTest: { outcome: "sent", response: null } });
  await expect(f.harness.invokeRpc("alertTestConfirm", { id, arrived: true }, plugin)).rejects.toThrow(/explicit client action/);
  await expect(f.call("alertTestConfirm", { id: id + 1, arrived: true })).rejects.toThrow(/latest test/);
  expect(await f.call("alertTestConfirm", { id, arrived: true })).toMatchObject({ proven: true, lastTest: { response: "arrived" } });
  expect(new TavernRuntime(f.bb, f.k, f.runtime.registry).alerts.view()).toMatchObject({ proven: true });
  await expect(f.call("alertTestConfirm", { id, arrived: false })).rejects.toThrow(/latest test/);

  f.send.mockRejectedValueOnce(new Error("Fixture delivery failed"));
  await f.push();
  expect(await f.call("alertRoute", null)).toMatchObject({ proven: false, lastFailure: { error: "Fixture delivery failed" } });
  const next = await f.call("alertTestSend", {}) as typeof result;
  expect(await f.call("alertTestConfirm", { id: next.lastTest.id, arrived: false })).toMatchObject({ proven: false, lastTest: { response: "not-arrived" } });
  const again = await f.call("alertTestSend", {}) as typeof result;
  expect(await f.call("alertTestConfirm", { id: again.lastTest.id, arrived: true })).toMatchObject({ proven: true, lastFailure: { error: "Fixture delivery failed" } });
});
