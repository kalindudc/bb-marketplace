// @vitest-environment node
import { expect, it } from "vitest";
import { modelResolutionFailure, targetModelKey } from "../../src/server/placement/models";
import { setup } from "./runtime-fixture";
import { placementHandlers } from "../../src/server/placement/rpc";
import { placementContract } from "../../src/shared/placement-rpc";

it.each(["The model is not available because the server is overloaded", "Unavailable model capacity; retry later"])("does not persist temporary model errors: %s", error => {
  expect(modelResolutionFailure(error)).toBe(false);
});
it("keeps different harness providers' failures separate", () => {
  const target = { kind: "provider" as const, environmentProviderId: "env", machine: { type: "new" as const, machineProviderId: "machine" }, workspace: "dedicated-machine" as const };
  expect(targetModelKey(target, "model", "pi")).not.toBe(targetModelKey(target, "model", "codex"));
});

it("exposes explicit model failures and clears one from the Settings RPC", async () => {
  const f = setup();
  f.k.store.put("placementModelFailures", "failure", { id: "failure", target: "machine/env", model: "provider/model", detail: "Failed to resolve Pi model provider/model", at: 1 });
  const handlers = placementHandlers(f.runtime);
  expect(await handlers.placementModelFailures({})).toHaveLength(1);
  await handlers.placementModelFailureClear({ id: "failure" });
  expect(await handlers.placementModelFailures({})).toEqual([]);
  expect(placementContract.placementModelFailureClear.input.safeParse({ id: "failure", model: "invented" }).success).toBe(false);
});
