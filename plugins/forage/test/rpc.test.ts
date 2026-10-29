import { afterEach, describe, expect, it } from "vitest";
import { createSourcesRpc, registerSourcesRpc } from "../src/rpc.ts";
import { deleteSourceConfirmation } from "../src/contract.ts";
import { artifact, attempt, threadScope } from "./sources/helpers.ts";
import { fixtureServices } from "./fixtures/ui/services.ts";

const fixtures: ReturnType<typeof fixtureServices>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
function setup() { const f = fixtureServices(); fixtures.push(f); const api = createSourcesRpc(f.bb, f); registerSourcesRpc(f.bb, api); return { ...f, api, call: f.harness.behavior.callRpc }; }

describe("Sources RPC", () => {
 it("validates project visibility and thread relationship before repository access", async () => {
  const f = setup();
  for (const scope of [{ ...f.scope, projectId: "missing" }, { ...f.scope, threadId: "foreign" }, { ...f.scope, threadId: "missing" }]) {
   await expect(f.call("listSources", { scope, limit: 10 })).rejects.toThrow("SOURCE_NOT_VISIBLE");
  }
  expect(await f.call("listSources", { scope: f.scope, limit: 1 })).toMatchObject({ sources: [{ id: f.first.sourceId }] });
 });
 it("denies cross-thread source and snapshot IDs without disclosing existence", async () => {
  const f = setup(); const scope = threadScope("thr_b");
  expect(await f.call("getSource", { scope, sourceId: f.first.sourceId })).toBeNull();
  expect(await f.call("readSnapshot", { scope, snapshotId: f.first.snapshotId, offset: 0, maxChars: 100 })).toEqual({ status: "not-visible" });
 });
 it("rejects malformed, unknown and widening fields and exact destructive confirmation", async () => {
  const f = setup();
  for (const input of [{ scope: f.scope, limit: 101 }, { scope: f.scope, limit: 10, provider: "exa" }, { scope: { ...f.scope, extra: 1 }, limit: 10 }]) await expect(f.call("listSources", input)).rejects.toThrow();
  await expect(f.call("deleteSource", { scope: f.scope, sourceId: f.first.sourceId, confirm: "yes" })).rejects.toThrow();
  expect(f.repository.get(f.scope, f.first.sourceId!)).not.toBeNull();
 });
 it("blocks revoked restricted reads, but still permits confirmed deletion", async () => {
  const f = setup();
  const restricted = f.repository.recordRetrieval({ scope: f.scope, origin: "fetch", artifact: artifact("restricted", { requestedUrl: "https://example.com/private", finalUrl: "https://example.com/private", access: { network: "public", credentialed: true, requestScopeKey: "thread:proj_a:thr_a" } }), attempt: attempt(), allowRestrictedThreadCapture: true });
  expect((await f.call("listSources", { scope: f.scope, limit: 10 }) as { sources: unknown[] }).sources).toHaveLength(1);
  expect(await f.call("getSource", { scope: f.scope, sourceId: restricted.sourceId })).toBeNull();
  expect(await f.call("readSnapshot", { scope: f.scope, snapshotId: restricted.snapshotId, offset: 0, maxChars: 10 })).toEqual({ status: "not-visible" });
  f.setRestricted(true);
  expect(await f.call("getSource", { scope: f.scope, sourceId: restricted.sourceId })).not.toBeNull();
  f.setRestricted(false);
  await f.call("deleteSource", { scope: f.scope, sourceId: restricted.sourceId, confirm: deleteSourceConfirmation(f.scope, restricted.sourceId!) });
  expect(f.repository.get(f.scope, restricted.sourceId!)).toBeNull();
 });
 it("returns immutable preview citations, bounded diff and public project copy", async () => {
  const f = setup();
  expect(await f.call("readSnapshot", { scope: f.scope, snapshotId: f.first.snapshotId, offset: 0, maxChars: 100 })).toMatchObject({ status: "ok", slice: { text: "# Docs\n\nFirst line\nSecond line", citation: expect.stringContaining("lines:1-4") } });
  expect(await f.call("diffSnapshots", { scope: f.scope, beforeSnapshotId: f.first.snapshotId, afterSnapshotId: f.second.snapshotId, maxHunks: 1, maxChars: 200 })).toMatchObject({ unchanged: false, hunks: [expect.anything()] });
  const copied = await f.call("copySourceToProject", { projectId: "proj_a", threadId: "thr_a", sourceId: f.first.sourceId });
  expect(copied).toMatchObject({ copied: true });
 });
 it("rejects plugin callers on client-only controls, not ordinary reads", async () => {
  const f = setup(); const plugin = { experimental_caller: { kind: "plugin" as const, pluginId: "other" } };
  await expect(f.call("cancelCrawlJob", { scope: f.scope, jobId: "job_a" }, plugin)).rejects.toThrow("client");
  expect(await f.call("listSources", { scope: f.scope, limit: 10 }, plugin)).toMatchObject({ sources: [expect.anything()] });
 });
 it("enforces current backend ceiling on job reads/resume but allows cancellation", async () => {
  const f = setup(); f.setConfig({ allowedBackends: [] });
  expect(await f.call("getCrawlJob", { scope: f.scope, jobId: "job_a" })).toBeNull();
  await expect(f.call("resumeCrawlJob", { scope: f.scope, jobId: "job_a" })).rejects.toThrow("POLICY_BLOCKED");
  expect(await f.call("cancelCrawlJob", { scope: f.scope, jobId: "job_a" })).toMatchObject({ state: "cancelled" });
 });
 it("returns selected snapshot completeness, stale and evicted states without exposing another scope", async () => {
  const f = setup();
  expect(await f.call("snapshotMetadata", { scope: f.scope, snapshotId: f.first.snapshotId })).toMatchObject({ completeness: { state: "complete" }, contentType: "text/markdown; charset=utf-8" });
  expect(await f.call("snapshotMetadata", { scope: threadScope("thr_b"), snapshotId: f.first.snapshotId })).toBeNull();
  expect(await f.call("readSnapshot", { scope: f.scope, snapshotId: f.first.snapshotId, offset: 0, maxChars: 10, contentHash: "0".repeat(64) })).toMatchObject({ status: "stale" });
  await f.repository.prune({ threadDays: 30, projectDays: 180, completedJobDays: 30, failedJobDays: 7, maxContentBytes: 1, now: 1_000_000 });
  expect(await f.call("readSnapshot", { scope: f.scope, snapshotId: f.first.snapshotId, offset: 0, maxChars: 10 })).toEqual({ status: "evicted" });
 });
 it("paginates sources and invalidates only the affected scope after mutation", async () => {
  const f = setup();
  f.repository.recordRetrieval({ scope: f.scope, origin: "fetch", artifact: artifact("second", { requestedUrl: "https://example.com/two", resolvedUrl: "https://example.com/two", finalUrl: "https://example.com/two" }), attempt: attempt() });
  const first = await f.call("listSources", { scope: f.scope, limit: 1 }) as { sources: Array<{ id: string }>; nextCursor: string };
  const second = await f.call("listSources", { scope: f.scope, limit: 1, cursor: first.nextCursor }) as { sources: Array<{ id: string }>; nextCursor: string | null };
  expect(second.sources[0]!.id).not.toBe(first.sources[0]!.id); expect(second.nextCursor).toBeNull();
  await f.call("cancelCrawlJob", { scope: f.scope, jobId: "job_a" });
  expect(f.harness.experimental_rpcInvalidations).toContainEqual(["forage:jobs:thread:proj_a:thr_a"]);
 });
 it("publishes exact scope invalidation for background source/job updates", () => {
  const f = setup(); f.api.invalidate(f.scope);
  expect(f.harness.experimental_rpcInvalidations).toContainEqual(["forage:sources:thread:proj_a:thr_a", "forage:jobs:thread:proj_a:thr_a", "forage:activity:thread:proj_a:thr_a"]);
 });
});
