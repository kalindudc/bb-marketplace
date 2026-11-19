// @vitest-environment node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BackendScopes } from "../../src/server/scopes";
import { PlacementController } from "../../src/server/placement/controller";
import { readyFixture, readyGit } from "./placement-e2e-ready";

async function fixture() {
  const f = await readyFixture();
  const services = { store: f.placements, deliveries: f.deliveries, host: f.port, ready: undefined as unknown as ReturnType<typeof f.make> };
  const runtime = { bb: f.bb, placements: () => services, keeper: { changed: vi.fn(), member: () => null }, config: () => ({ machines: { rules: [] } }),
    scopes: undefined as unknown as BackendScopes };
  const scopes = new BackendScopes(runtime as never, { dataDir: join(f.root, "controller"), installGuard: false });
  runtime.scopes = scopes;
  services.ready = f.make(threadId => scopes.api.hostTemplate(threadId));
  await services.ready.forThread("member");
  writeFileSync(join(f.member, "tracked"), "member committed work\n");
  readyGit(f.member, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qam", "member work");
  const reconcile = vi.spyOn(services.ready, "reconcileForThread");
  const controller = new PlacementController(runtime as never, services as never);
  const changed = { ...f.template, tools: { ...f.template.tools, deny: [...f.template.tools.deny, "bash"] } };
  return { ...f, services, scopes, reconcile, controller, changed };
}

it("redelivers a changed host-bound template without a member turn or replaying setup", async () => {
  const f = await fixture(), calls = f.harness.experimental_hostRpcCalls.length;
  await f.scopes.api.writeScope("member", f.changed);
  expect(f.reconcile).toHaveBeenCalledWith("member");
  await f.reconcile.mock.results[0].value;
  expect(f.placements.get("placement")).toMatchObject({ phase: "ready", acknowledgedScopeRevision: 2, desiredScopeRevision: 2 });
  expect(JSON.parse(f.deliveries.get("placement")!.scopeFileJson).bindingTemplate).toEqual(f.changed);
  expect(f.harness.experimental_hostRpcCalls.slice(calls).map(call => call.method)).toEqual(["inspect", "bindScope", "sessionStatus"]);
  expect(f.controller.forMember("member")!.posture.detail).toBeNull();
  expect((await f.harness.behavior.resolveProviderEnv("pi", { threadId: "member", hostId: "member-host" } as never))
    .some(entry => entry.name === "TAVERN_SCOPE_FILE")).toBe(true);
  f.events([{ id: "read", seq: 1, threadId: "member", type: "item/completed", createdAt: 2,
    data: { item: { type: "toolCall", tool: "read", arguments: { path: "tracked" } } } }]);
  const thread = await f.bb.sdk.threads.get({ threadId: "member" });
  expect((await f.harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 })).errors).toEqual([]);
  expect(f.scopes.api.observationHolds()).toEqual([]);
  expect(f.harness.experimental_hostRpcCalls.filter(call => call.method === "prepareCall")).toHaveLength(1);
}, 60_000);

it("reconciles another template change that arrives during native delivery", async () => {
  const f = await fixture();
  const latest = { ...f.changed, issuedAt: 2 };
  let once = true;
  f.intercept((method, _input, result) => {
    if (method === "bindScope" && once) {
      once = false;
      return f.scopes.api.writeScope("member", latest).then(() => result);
    }
    return result;
  });
  await f.scopes.api.writeScope("member", f.changed);
  await f.reconcile.mock.results[0].value;
  await f.reconcile.mock.results[1].value;
  expect(f.placements.get("placement")).toMatchObject({ phase: "ready", acknowledgedScopeRevision: 3, desiredScopeRevision: 3 });
  expect(JSON.parse(f.deliveries.get("placement")!.scopeFileJson).bindingTemplate).toEqual(latest);
}, 60_000);

it("shows failed scope redelivery and its observation hold, then resumes after retry", async () => {
  const f = await fixture();
  f.intercept((method, _input, result) => {
    if (method === "bindScope") throw new Error("Scope copy refused");
    return result;
  });
  await f.scopes.api.writeScope("member", f.changed);
  expect(f.reconcile).toHaveBeenCalledWith("member");
  await f.reconcile.mock.results[0].value;
  const view = f.controller.forMember("member")!;
  expect(view.blocker).toMatchObject({ stage: "bind", message: "Scope copy refused", retryable: true });
  expect(view.posture.detail).toContain("Scope update pending; detection paused");
  f.events([{ id: "read", seq: 1, threadId: "member", type: "item/completed", createdAt: 2,
    data: { item: { type: "toolCall", tool: "read", arguments: { path: "tracked" } } } }]);
  const thread = await f.bb.sdk.threads.get({ threadId: "member" });
  await f.harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  expect(f.scopes.api.status().threads[0].observationHold).toBeDefined();
  expect(f.scopes.api.violations()).toEqual([]);
  f.intercept(undefined);
  expect(await f.services.ready.forThread("member")).toContain("Ready.");
  await f.harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  expect(f.scopes.api.observationHolds()).toEqual([]);
  expect(f.controller.forMember("member")!.posture.detail).toBeNull();
}, 60_000);
