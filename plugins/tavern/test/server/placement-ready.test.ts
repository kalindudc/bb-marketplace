// @vitest-environment node
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { envForScope } from "../../src/scope/env";
import { formatExecutionPosture } from "../../src/scope/posture";
import { registerWatcher } from "../../src/scope/watch";
import { readyFixture, readyGit, deliverGate, readyGate } from "./placement-e2e-ready";

it("binds the SDK host and environment, carries the tree, and acknowledges the exact scope in one member batch", readyGate, 60_000);
it("retains an unmarked extension and admits readiness with a visible guard warning", deliverGate, 60_000);
it("shares concurrent calls and returns the same completed result without new native work", async () => {
  const f = await readyFixture(), ready = f.make();
  const first = ready.forThread("member"), second = ready.forThread("member"); expect(second).toBe(first);
  const result = await first, calls = f.harness.experimental_hostRpcCalls.length;
  expect(await ready.forThread("member")).toBe(result); expect(await f.make().forThread("member")).toBe(result);
  expect(f.harness.experimental_hostRpcCalls.slice(calls).map(call => call.method)).toEqual(["inspect", "inspect"]);
}, 60_000);
it("refuses an unplaced caller without any native work", async () => {
  const f = await readyFixture(); expect(await f.make().forThread("unplaced")).toBe("This member was not placed by a machine rule; nothing to set up.");
  expect(f.harness.experimental_hostRpcCalls).toEqual([]);
});
it.each(["registerEndpoints", "carryFinish", "bindScope", "sessionStatus"] as const)("fences a stale generation during %s without publishing readiness", async method => {
  const f = await readyFixture(); f.intercept((name, _input, result) => { if (name === method) f.placements.cancel("placement", 1); return result; });
  const result = await f.make().forThread("member"); expect(result).toMatch(/Stale|released|changed/);
  expect(f.placements.get("placement")!.phase).not.toBe("ready");
}, 60_000);
it("reports exact transfer-slot waiting and resumes on Retry", async () => {
  const f = await readyFixture(); let waiting = true;
  f.intercept((method, _input, result) => method === "registerEndpoints" && waiting ? { outcome: "waiting", generation: 1, active: 32, required: 1, limit: 32 } : result);
  expect(await f.make().forThread("member")).toContain("Waiting for transfer slots: 32 in use (limit 32)");
  expect(f.placements.get("placement")).toMatchObject({ phase: "blocked", blocked: { stage: "bind", retryable: true } });
  waiting = false; expect(await f.make().forThread("member")).toContain("Detection only (remote)"); expect(f.placements.get("placement")!.phase).toBe("ready");
}, 60_000);
it("admits guard preparation failure with its exact warning", async () => {
  const f = await readyFixture(); f.intercept((method, _input, result) => method === "prepareGuard" ? { state: "failed", artifactDigest: null, scopeDirectory: "/native/scopes", warning: "Guard copy refused" } : result);
  expect(await f.make().forThread("member")).toContain("Guard copy refused");
  expect(f.placements.get("placement")).toMatchObject({ phase: "ready", posture: { guard: "failed", warnings: ["Guard copy refused"] } });
}, 60_000);
it("returns no laptop env before acknowledgment and only acknowledged host-local paths after readiness", async () => {
  const f = await readyFixture();
  const env = () => envForScope(f.scopes.records, "member", { hostId: "member-host", hostScope: f.deliveries.forThread("member") });
  expect(env()).toEqual([]); await f.make().forThread("member");
  const entries = env(), ack = f.deliveries.get("placement")!.acknowledged!;
  expect(entries).toContainEqual(expect.objectContaining({ name: "TAVERN_SCOPE_FILE", value: ack.scopeFile }));
  expect(entries.some(entry => entry.value.includes("controller"))).toBe(false);
  expect(envForScope(f.scopes.records, "member", { hostId: "wrong-host", hostScope: f.deliveries.forThread("member") })).toEqual([]);
}, 60_000);
it("observes a placed tool only through native prepareCall and does not report pending readiness as a violation", async () => {
  const f = await readyFixture(), ready = f.make();
  const violations: unknown[] = [];
  registerWatcher(f.bb, f.scopes, { remoteForThread: threadId => f.deliveries.observationForThread(threadId, f.port), onViolation: value => { violations.push(value); } });
  const thread = await f.bb.sdk.threads.get({ threadId: "member" });
  f.events([{ id: "read", seq: 1, threadId: "member", type: "item/completed", createdAt: 2,
    data: { item: { type: "toolCall", tool: "read", arguments: { path: "tracked" } } } }]);
  await f.harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  expect(violations).toEqual([]); expect(f.harness.experimental_hostRpcCalls).toEqual([]);
  await ready.forThread("member");
  const emitted = await f.harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
  expect(emitted.errors).toEqual([]);
  expect(f.deliveries.observationForThread("member", f.port)?.kind).toBe("ready");
  expect(f.scopes.observationHold("member")).toBeNull();
  expect(f.harness.experimental_hostRpcCalls.filter(call => call.method === "prepareCall")).toHaveLength(1);
  expect(violations).toEqual([]);
}, 60_000);
it("binds a checker to its pinned review tree and never calls preparation an observed guard", async () => {
  const f = await readyFixture(true); const result = await f.make().forThread("member");
  const envelope = JSON.parse(f.deliveries.get("placement")!.scopeFileJson);
  expect(envelope.workspaceBinding).toMatchObject({ snapshotId: f.snapshot.id, expectedTree: f.tree, root: f.member });
  expect(result).toContain("detection only, no containment"); expect(f.placements.get("placement")!.posture.toolGate).toBe("not-established");
}, 60_000);
it("uses the canonical remote and observed Linux checker labels", async () => {
  const f = await readyFixture(true), posture = f.placements.get("placement")!.posture;
  expect(formatExecutionPosture({ ...posture, aggregate: "remote-detection-only", guard: "prepared", toolGate: "pi-observed", checker: "pre-exec-no-containment" })).toBe("Detection only (remote); pre-exec checks only, no containment");
});
it.each(["pi", "other-provider"])("claims Linux pre-exec observation only with a prepared and observed Pi guard: %s", async providerId => {
  const f = await readyFixture(true); f.provider(providerId);
  f.intercept((method, input, result) => method === "sessionStatus" ? { state: "armed", revision: (input as { revision: number }).revision, scopeDigest: (input as { scopeDigest: string }).scopeDigest } : result);
  expect(await f.make().forThread("member")).toContain(providerId === "pi" ? "pre-exec checks only, no containment" : "detection only, no containment");
}, 60_000);
it("reports included uncommitted Keeper changes and their trusted origin", async () => {
  const f = await readyFixture(false, true);
  expect(await f.make().forThread("member")).toContain(`Uncommitted Keeper changes were included from ${f.home} on host home-host.`);
}, 60_000);
it("refuses self-turn carry for a foreign caller or cancelled generation without stopping the owner", async () => {
  const f = await readyFixture();
  await expect(f.carry.carryIntoOwnTurn("placement", 1, f.snapshot.id, { threadId: "foreign", toolName: "tavern_ready", assertActive: () => {} })).rejects.toThrow(/own|member|caller/i);
  f.placements.cancel("placement", 1);
  await expect(f.carry.carryIntoOwnTurn("placement", 1, f.snapshot.id, { threadId: "member", toolName: "tavern_ready", assertActive: () => {} })).rejects.toThrow(/Stale/);
  expect(f.harness.experimental_hostRpcCalls).toEqual([]); expect(f.harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
});
it("acknowledges a changed effective template on Retry without replaying the verified carry", async () => {
  const f = await readyFixture(), ready = f.make();
  await ready.forThread("member");
  const changed = { ...f.template, tools: { ...f.template.tools, deny: [...f.template.tools.deny, "bash"] } };
  writeFileSync(join(f.member, "tracked"), "member work\n");
  readyGit(f.member, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qam", "member work");
  f.scopes.write("member", changed, changed);
  const carryCalls = f.harness.experimental_hostRpcCalls.filter(call => call.method === "carryStart").length;
  expect(await ready.forThread("member")).toContain("Ready.");
  expect(JSON.parse(f.deliveries.get("placement")!.scopeFileJson).bindingTemplate).toEqual(changed);
  expect(f.deliveries.get("placement")!.binding.revision).toBe(2);
  expect(f.harness.experimental_hostRpcCalls.filter(call => call.method === "carryStart")).toHaveLength(carryCalls);
}, 60_000);
it("reconciles a working member without changing its running phase or checking the initial tree", async () => {
  const f = await readyFixture(), ready = f.make();
  await ready.forThread("member");
  f.placements.update("placement", 1, value => ({ ...value, phase: "running" }));
  writeFileSync(join(f.member, "tracked"), "working member edits\n");
  const changed = { ...f.template, issuedAt: 2 }; f.scopes.write("member", changed, changed);
  const calls = f.harness.experimental_hostRpcCalls.length;
  expect(await ready.forThread("member")).toContain("Ready.");
  expect(f.placements.get("placement")).toMatchObject({ phase: "running", desiredScopeRevision: 2, acknowledgedScopeRevision: 2 });
  expect(f.harness.experimental_hostRpcCalls.slice(calls).map(call => call.method)).toEqual(["inspect", "bindScope", "sessionStatus"]);
  expect(readFileSync(join(f.member, "tracked"), "utf8")).toBe("working member edits\n");
}, 60_000);
it("keeps foreign dirty member edits and returns the exact carry blocker", async () => {
  const f = await readyFixture(); writeFileSync(join(f.member, "tracked"), "human\n");
  expect(await f.make().forThread("member")).toMatch(/dirty|uncommitted|left it/i);
  expect(readFileSync(join(f.member, "tracked"), "utf8")).toBe("human\n"); expect(readyGit(f.member, "rev-parse", "HEAD")).toBe(f.base);
}, 60_000);
it("blocks disconnected and suspended environments with Retry rather than falling back", async () => {
  const f = await readyFixture(); f.connected(false); expect(await f.make().forThread("member")).toMatch(/disconnected/);
  expect(f.placements.get("placement")!.blocked!.retryable).toBe(true);
  f.connected(true); f.environments.set("member-env", { ...f.environments.get("member-env")!, hostLifecycle: "suspended" } as never);
  expect(await f.make().forThread("member")).toMatch(/suspended/); expect(f.harness.experimental_hostRpcCalls).toEqual([]);
});

it("keeps a preservation blocker unchanged when a member calls tavern_ready", async () => {
  const f = await readyFixture();
  f.placements.block("placement", 1, { stage: "preserve", code: "save-failed", message: "Save failed; machine retained", retryable: true });
  const before = f.placements.get("placement");
  expect(await f.make().forThread("member")).toContain("Save failed; machine retained");
  expect(f.placements.get("placement")).toEqual(before);
  expect(f.harness.experimental_hostRpcCalls).toEqual([]);
});
it("keeps a preservation blocker that arrives during a readiness await", async () => {
  const f = await readyFixture();
  f.intercept((method, _input, result) => {
    if (method === "inspect") f.placements.block("placement", 1, { stage: "preserve", code: "save-failed", message: "Save failed during setup", retryable: true });
    return result;
  });
  expect(await f.make().forThread("member")).toContain("Save failed during setup");
  expect(f.placements.get("placement")).toMatchObject({ phase: "blocked", blocked: { stage: "preserve", message: "Save failed during setup" } });
}, 60_000);
it("rejects an aborted ready call rather than reporting success", async () => {
  const f = await readyFixture();
  await expect(f.make().forThread("member", AbortSignal.abort(new Error("Cancelled")))).rejects.toThrow("Cancelled");
});
it("makes an effective-template race retryable without carrying member work again", async () => {
  const f = await readyFixture(), ready = f.make();
  await ready.forThread("member");
  const changed = { ...f.template, tools: { ...f.template.tools, deny: [...f.template.tools.deny, "bash"] } };
  f.scopes.write("member", changed, changed);
  f.intercept((method, _input, result) => {
    if (method === "bindScope") f.scopes.write("member", { ...changed, issuedAt: 2 }, { ...changed, issuedAt: 2 });
    return result;
  });
  expect(await ready.forThread("member")).toContain("effective scope changed");
  expect(f.placements.get("placement")!.blocked!.retryable).toBe(true);
  f.intercept(undefined);
  expect(await ready.forThread("member")).toContain("Ready.");
}, 60_000);
