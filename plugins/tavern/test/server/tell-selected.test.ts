// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";

it("checks live Keeper targets for a guarded client action without sending as a plugin", async () => {
  const f = setup();
  f.k.bind("quiet", "keeper", "moss", "project");
  f.k.bind("gone", "keeper", "wren", "project");
  f.k.store.patch("quiet", { manualStopAt: 100 });
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, deletedAt: threadId === "gone" ? 100 : null }));
  registerRpc(f.bb, f.runtime);
  const input = { keeperIds: ["lead", "gone", "quiet", "lead"] };
  await expect(f.harness.invokeRpc("prepareTellKeepers", input, { experimental_caller: { kind: "plugin", pluginId: "agent" } })).rejects.toThrow(/explicit client action/);
  expect(f.bb.sdk.threads.get).not.toHaveBeenCalled();
  const result = await f.harness.invokeRpc("prepareTellKeepers", input, { experimental_caller: { kind: "client" } });
  expect(result).toEqual({ targets: [
    { threadId: "lead", name: "Wren", status: "ready" },
    { threadId: "gone", name: "Wren", status: "gone" },
    { threadId: "quiet", name: "Moss", status: "ready" },
  ] });
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});
