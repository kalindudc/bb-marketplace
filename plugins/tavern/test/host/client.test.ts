// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createHostPort, hostCallTimeoutMs } from "../../src/host/client";
import { hostContract } from "../../src/host-contract";
import { scopeForClass } from "../../src/scope/presets";

it("creates an inert typed client and routes only to an explicit host", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, experimental_callHostRpc: async () => ({ revoked: true, generation: 1 }) });
  try {
    const port = createHostPort(bb);
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
    expect(await port.call("guest-a", "revokePlacement", { placementId: "placement-a", generation: 1, reason: "cancel" })).toEqual({ revoked: true, generation: 1 });
    expect(harness.experimental_hostRpcCalls[0]).toMatchObject({ hostId: "guest-a", method: "revokePlacement", input: { placementId: "placement-a", generation: 1 } });
    await expect(port.call("guest-a", "revokePlacement", { placementId: "placement-a", generation: 0, reason: "invalid" })).rejects.toThrow();
    expect(harness.experimental_hostRpcCalls).toHaveLength(1);
  } finally { await harness.lifecycle.dispose(); }
});
it("requires a bounded strict host-evaluated decision in prepared-call replies", () => {
  const value = { call: { kind: "bash", toolName: "bash", input: { command: "pwd" }, cwd: "/guest/member" }, scopeRevision: 1, scopeDigest: "a".repeat(64) };
  const schema = hostContract.prepareCall.output;
  expect(schema.safeParse({ ...value, decision: { allow: true, check: true } }).success).toBe(true);
  expect(schema.safeParse({ ...value, decision: { allow: false, ruleId: "rule", reason: "Denied" } }).success).toBe(true);
  expect(schema.safeParse(value).success).toBe(false);
  for (const decision of [{ allow: true, ruleId: "unexpected" }, { allow: false, ruleId: "x".repeat(201), reason: "Denied" }, { allow: false, ruleId: "rule", reason: "x".repeat(16385) }]) expect(schema.safeParse({ ...value, decision }).success).toBe(false);
});
it("rejects endpoint metadata for a different authenticated target before dispatch", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, experimental_callHostRpc: async () => ({ registered: true, generation: 1 }) });
  try {
    const port = createHostPort(bb);
    await expect(port.call("guest-a", "registerEndpoint", { placementId: "placement", generation: 1, endpointId: "endpoint", endpoint: { hostId: "guest-b", environmentId: null, root: "/source" }, ownerThreadId: null, access: "source-read", workspaceKind: null, objectFormat: null, allowedRefs: [] })).rejects.toThrow(/host|target/i);
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
  } finally { await harness.lifecycle.dispose(); }
});
it("validates every batched endpoint against the authenticated target before any dispatch", async () => {
  const {bb,harness}=createFakePluginHost({pluginId:"tavern",experimental_hostEntry:true,experimental_callHostRpc:async()=>({outcome:"registered",generation:1,endpointIds:["a","b"]})});
  const endpoint=(endpointId:string,hostId:string)=>({placementId:"placement",generation:1,endpointId,endpoint:{hostId,environmentId:null,root:"/source"},ownerThreadId:null,access:"source-read" as const,workspaceKind:null,objectFormat:null,allowedRefs:[]});
  try{const port=createHostPort(bb);await expect(port.call("guest-a","registerEndpoints",{placementId:"placement",generation:1,operationId:"batch",endpoints:[endpoint("a","guest-a"),endpoint("b","guest-b")]})).rejects.toThrow(/host|target/i);expect(harness.experimental_hostRpcCalls).toHaveLength(0);
    expect(await port.call("guest-a","registerEndpoints",{placementId:"placement",generation:1,operationId:"batch",endpoints:[endpoint("a","guest-a"),endpoint("b","guest-a")]})).toMatchObject({outcome:"registered"});expect(harness.experimental_hostRpcCalls).toHaveLength(1);
  }finally{await harness.lifecycle.dispose();}
});
it("rejects delivery host metadata for a different authenticated target without rewriting bytes", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "tavern", experimental_hostEntry: true, experimental_callHostRpc: async () => ({ revision: 1, scopeDigest: "a".repeat(64), scopeFile: "/scope.json", variables: {} }) });
  try {
    const template = { ...scopeForClass("smith"), threadId: "member", issuedAt: 1 }, scopeFileJson = JSON.stringify({ ...template, bindingTemplate: template, workspaceBinding: { kind: "dedicated-machine", hostId: "guest-b", environmentId: "member-env", root: "/repo", placementId: "placement", generation: 1, snapshotId: null, expectedTree: null } }) + "\n";
    const port = createHostPort(bb), input = { placementId: "placement", generation: 1, endpointId: "endpoint", operationId: "bind", revision: 1, scopeDigest: "a".repeat(64), scopeFileJson };
    await expect(port.call("guest-a", "bindScope", input)).rejects.toThrow(/host|target/i); expect(harness.experimental_hostRpcCalls).toHaveLength(0); expect(input.scopeFileJson).toBe(scopeFileJson);
    await port.call("guest-b", "bindScope", input); expect(harness.experimental_hostRpcCalls[0]!.input).toMatchObject({ scopeFileJson });
  } finally { await harness.lifecycle.dispose(); }
});
it("bounds host-call budgets without placing transport inside the env contributor", () => {
  for (const method of ["inspect", "snapshotWorktree", "commitAll", "worktreeState", "carryFinish", "carryAbort"] as const)
    expect(hostCallTimeoutMs(method, {})).toBe(180_000);
  expect(hostCallTimeoutMs("registerEndpoint", {})).toBe(30_000);
  expect(hostCallTimeoutMs("importCommit", { networkTimeoutMs: 120_000 })).toBe(420_000);
  expect(hostCallTimeoutMs("carryStart", { networkTimeoutMs: 900_000 })).toBe(1_800_000);
  expect(hostCallTimeoutMs("carryFinish", {})).toBe(180_000);
  expect(hostCallTimeoutMs("releaseSnapshotRef", {})).toBe(180_000);
});
