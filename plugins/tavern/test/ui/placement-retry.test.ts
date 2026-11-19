// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { placementHandlers } from "../../src/server/placement/rpc";
import type { TavernRuntime } from "../../src/server/runtime";
import { PlacementStore } from "../../src/server/placement/store";
import { readyPlacement } from "./fixtures/placement";
import { placementRecord } from "../server/placement-fixture";
import { setup } from "../server/runtime-fixture";

function fixture() {
  const f = setup();
  const store = new PlacementStore(f.k.store.db);
  store.reserve(placementRecord({ id: "placement-juno", generation: 1, questId: "quest", memberThreadId: "juno" }), { maxMakers: 2, maxCheckers: 2 });
  const retry = vi.fn(async (_id: string, _generation: number) => readyPlacement);
  const invalidate = vi.fn();
  const placements = vi.fn(() => ({ store, controller: { retry } }));
  const runtime = { keeper: f.k, placements, bb: { rpc: { experimental_invalidate: invalidate } } } as unknown as TavernRuntime;
  const handler = placementHandlers(runtime).placementRetry;
  return { retry, invalidate, placements, handler: (input: Parameters<typeof handler>[0]) => handler(input, { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal }) };
}

describe("placement retry RPC", () => {
  it("retries the current generation and invalidates member surfaces", async () => {
    const f = fixture();
    expect(await f.handler({ placementId: "placement-juno", generation: 1 })).toEqual({ ok: true, message: null });
    expect(f.retry).toHaveBeenCalledOnce();
    expect(f.retry).toHaveBeenCalledWith("placement-juno", 1);
    expect(f.invalidate).toHaveBeenCalledWith(["tavern:room", "tavern:rows", "tavern:quest:quest", "tavern:thread:juno", "tavern:thread:keeper"]);
  });
  it("refuses a stale generation without initializing host services", async () => {
    const f = fixture();
    expect(await f.handler({ placementId: "placement-juno", generation: 2 })).toEqual({ ok: false, message: "This placement changed. Refresh before retrying." });
    expect(f.placements).not.toHaveBeenCalled();
    expect(f.retry).not.toHaveBeenCalled();
  });
  it("refuses a missing placement without initializing host services", async () => {
    const f = fixture();
    expect(await f.handler({ placementId: "missing", generation: 3 })).toEqual({ ok: false, message: "This placement no longer exists." });
    expect(f.placements).not.toHaveBeenCalled();
    expect(f.retry).not.toHaveBeenCalled();
  });
  it("returns the controller's exact refusal and refreshes any changed blocker", async () => {
    const f = fixture(); f.retry.mockRejectedValue(new Error("Machine is disconnected; reconnect it before retrying."));
    expect(await f.handler({ placementId: "placement-juno", generation: 1 })).toEqual({ ok: false, message: "Machine is disconnected; reconnect it before retrying." });
    expect(f.invalidate).toHaveBeenCalledOnce();
  });
});
