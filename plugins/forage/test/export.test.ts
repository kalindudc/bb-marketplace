import { afterEach, expect, it } from "vitest";
import { createSourcesRpc, registerSourcesHttp, EXPORT_PATH, EXPORT_LIMITS } from "../src/rpc.ts";
import { artifact, attempt } from "./sources/helpers.ts";
import { fixtureServices } from "./fixtures/ui/services.ts";
const fixtures: ReturnType<typeof fixtureServices>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
function setup() {
 const f = fixtureServices(); fixtures.push(f); const api = createSourcesRpc(f.bb, f); registerSourcesHttp(f.bb, f, api);
 const download = (input: unknown) => f.harness.behavior.fetchHttp("GET", `${EXPORT_PATH}?request=${encodeURIComponent(JSON.stringify(input))}`);
 return { ...f, download };
}
it("registers a local-auth route and streams exact source content in bounded chunks", async () => {
 const f = setup();
 expect(f.harness.registrations.httpRoutes).toContainEqual(expect.objectContaining({ path: EXPORT_PATH, auth: "local" }));
 const res = await f.download({ scope: f.scope });
 expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
 const reader = res.body!.getReader(); const chunks: Uint8Array[] = [];
 for (;;) { const n = await reader.read(); if (n.done) break; expect(n.value.byteLength).toBeLessThanOrEqual(EXPORT_LIMITS.chunkBytes); chunks.push(n.value); }
 const rows = Buffer.concat(chunks).toString().trim().split("\n").map((s) => JSON.parse(s));
 expect(rows.filter((r) => r.type === "snapshot").map((r) => r.snapshot.content)).toContain("# Docs\n\nFirst line\nSecond line");
 expect(rows.at(-1)).toMatchObject({ type: "end", status: "complete", records: 2 });
});
it("rejects invalid scope, options, IDs and implicit restricted export", async () => {
 const f = setup();
 for (const input of [{ scope: f.scope, provider: "exa" }, { scope: f.scope, includeRestricted: true }, { scope: f.scope, sourceIds: [] }]) expect((await f.download(input)).status).toBe(400);
 expect((await f.download({ scope: { ...f.scope, threadId: "foreign" } })).status).toBe(404);
 expect((await f.download({ scope: f.scope, sourceIds: ["missing"] })).status).toBe(404);
});
it("excludes restricted records by default and honors explicit thread selection and revocation", async () => {
 const f = setup();
 const receipt = f.repository.recordRetrieval({ scope: f.scope, origin: "fetch", artifact: artifact("RESTRICTED_CONTENT", { requestedUrl: "https://example.com/private", finalUrl: "https://example.com/private", access: { network: "public", credentialed: true, requestScopeKey: "thread:proj_a:thr_a" } }), attempt: attempt(), allowRestrictedThreadCapture: true });
 expect(await (await f.download({ scope: f.scope })).text()).not.toContain("RESTRICTED_CONTENT");
 const input = { scope: f.scope, sourceIds: [receipt.sourceId], includeRestricted: true };
 expect((await f.download(input)).status).toBe(403);
 f.setRestricted(true); expect(await (await f.download(input)).text()).toContain("RESTRICTED_CONTENT");
});
it("stops at bounded record count and releases an iterator on download cancellation", async () => {
 const f = setup(); let returns = 0; let pulled = 0;
 const record = { source: f.repository.get(f.scope, f.first.sourceId!)!, snapshot: f.repository.getSnapshot(f.scope, f.first.snapshotId!)! };
 f.repository.export = () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { pulled++; return { value: record, done: false }; }, return: async () => { returns++; return { value: undefined, done: true }; } }) });
 const response = await f.download({ scope: f.scope });
 const text = await response.text();
 expect(JSON.parse(text.trim().split("\n").at(-1)!)).toMatchObject({ status: "partial", reason: "record-limit", records: EXPORT_LIMITS.records });
 expect(pulled).toBe(EXPORT_LIMITS.records); expect(returns).toBe(1);
 const cancelled = await f.download({ scope: f.scope }); await cancelled.body!.cancel(); expect(returns).toBe(2);
});
it("bounds concurrent downloads and releases slots on cancellation", async () => {
 const f = setup();
 f.repository.recordRetrieval({ scope: f.scope, origin: "fetch", artifact: artifact("x".repeat(200000)), attempt: attempt() });
 const [a, b] = await Promise.all([f.download({ scope: f.scope }), f.download({ scope: f.scope })]);
 expect(a.status).toBe(200); expect(b.status).toBe(200);
 expect((await f.download({ scope: f.scope })).status).toBe(429);
 await a.body!.cancel(); await b.body!.cancel();
 const next = await f.download({ scope: f.scope }); expect(next.status).toBe(200); await next.body!.cancel();
});
it("interrupts a restricted stream when capture policy is revoked", async () => {
 const f = setup(); f.setRestricted(true);
 const receipt = f.repository.recordRetrieval({ scope: f.scope, origin: "fetch", artifact: artifact("private ".repeat(30000), { requestedUrl: "https://example.com/private", finalUrl: "https://example.com/private", access: { network: "public", credentialed: true, requestScopeKey: "thread:proj_a:thr_a" } }), attempt: attempt(), allowRestrictedThreadCapture: true });
 const response = await f.download({ scope: f.scope, sourceIds: [receipt.sourceId], includeRestricted: true });
 const reader = response.body!.getReader(); await reader.read(); f.setRestricted(false);
 await expect((async () => { while (!(await reader.read()).done) {} })()).rejects.toThrow("Export interrupted");
});
it("reports a byte-limited partial download without sending an oversized record", async () => {
 const f = setup();
 const record = { source: f.repository.get(f.scope, f.first.sourceId!)!, snapshot: f.repository.getSnapshot(f.scope, f.first.snapshotId!)! };
 f.repository.export = async function* () { for (let i = 0; i < 10; i++) yield { ...record, snapshot: { ...record.snapshot, content: "x".repeat(8 * 1024 * 1024) } }; };
 const rows = (await (await f.download({ scope: f.scope })).text()).trim().split("\n");
 expect(JSON.parse(rows.at(-1)!)).toMatchObject({ status: "partial", reason: "byte-limit", records: 3 });
});
