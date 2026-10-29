import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ForageRuntime } from "../src/operations.ts";
import type { createServerRuntime } from "../server.ts";
import { artifact, attempt, threadScope } from "./sources/helpers.ts";

const bundleUrl = new URL("../dist/server.js", import.meta.url).href;
const compiled = await import(/* @vite-ignore */ bundleUrl) as { default(bb: BbPluginApi): Promise<void>; createServerRuntime: typeof createServerRuntime };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function host() {
 const fake = createFakePluginHost({ pluginId: "forage", experimental_declaredIconNames: ["search", "fetch", "map", "extract", "crawl", "diff"], sdk: {
  projects: { get: async ({ projectId }) => ({ id: projectId, name: "Fixture", createdAt: 1, updatedAt: 1, gitRemoteUrl: null, kind: "standard", sources: [] }) },
  threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "proj_a" }) },
 } });
 cleanups.push(() => fake.harness.lifecycle.dispose()); return fake;
}
const flags = ["--project", "proj_a", "--thread", "thr_a"];
function fetched(url: string) {
 const a = artifact("# Bundled fixture\n\nBody", { requestedUrl: url, resolvedUrl: url, finalUrl: url, fetchedAt: new Date().toISOString() });
 return { url, finalUrl: url, title: a.title, content: a.content, kind: "markdown" as const, contentType: "text/markdown", status: 200, bytes: a.bytes, durationMs: 0, redirects: 0, cached: false, artifact: a, attempt: attempt(), contentHash: a.contentHash };
}
it("runs six CLI entrypoints, shared native diagnostics, and the emitted local bench corpus", async () => {
 const fake = host();
 const runtime = await compiled.createServerRuntime(fake.bb, { fetch: async url => fetched(url), search: async query => ({ query, provider: "duckduckgo", results: [], rawCount: 0, durationMs: 0, attempts: [], appliedControls: [], unsupportedControls: [], cached: false }) });
 const a = runtime.sources.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("# A", { fetchedAt: new Date().toISOString() }), attempt: attempt() });
 const b = runtime.sources.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("# B", { fetchedAt: new Date().toISOString() }), attempt: attempt() });
 for (const [name, params] of Object.entries({ search: { query: "bundled fixture" }, fetch: { url: "https://example.com/docs" }, map: { url: "https://example.com", maxIndexDocuments: 1 }, extract: { snapshotId: b.snapshotId, fields: ["title"] }, diff: { beforeSnapshotId: a.snapshotId, afterSnapshotId: b.snapshotId }, crawl: { action: "list" } })) {
  const result = await fake.harness.behavior.runCli([name, ...(name === "crawl" ? ["list"] : []), ...flags, "--input", JSON.stringify(params)]);
  expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout!.length).toBeLessThanOrEqual(32000);
 }
 const tool = await fake.harness.behavior.callAgentTool("web_fetch", { snapshotId: b.snapshotId }, { projectId: "proj_a", threadId: "thr_a" }); expect(tool).not.toHaveProperty("isError", true);
 const status = await fake.harness.behavior.runCli(["status"]); expect(status.stdout).toContain('"diagnostics": 7');
 const bench = await fake.harness.behavior.runCli(["bench"]); expect(bench.exitCode).toBe(0); expect(JSON.parse(bench.stdout!)).toMatchObject({ network: false, cases: [{ name: "documentation" }, { name: "markdown" }, { name: "json" }] });
});
it("pauses running crawl work on reload and does not let the old generation capture", async () => {
 let fake = host(); let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
 const runtime = await compiled.createServerRuntime(fake.bb, { crawl: {
  transport: async url => ({ response: new Response("", { status: 404 }), finalUrl: url, redirects: 0, acceptedRedirectBytes: 0, access: { network: "public", credentialed: false, requestScopeKey: null } }),
  fetchPage: async (_url, options) => { started(); await new Promise<void>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("fixture shutdown")), { once: true })); throw new Error("unreachable"); },
 } });
 const start = await fake.harness.behavior.runCli(["crawl", "start", ...flags, "--input", '{"url":"https://example.com/docs"}']); const jobId = JSON.parse(start.stdout!).id as string;
 const runner = fake.harness.behavior.runService("crawl"); await entered;
 fake = await fake.harness.lifecycle.reload(compiled.default); await runner.done;
 const job = await fake.harness.behavior.runCli(["crawl", "status", ...flags, "--input", JSON.stringify({ jobId })]); expect(job.exitCode, job.stderr).toBe(0); expect(JSON.parse(job.stdout!).state).toBe("paused");
 const sources = await fake.harness.behavior.runCli(["sources", "list", ...flags]); expect(JSON.parse(sources.stdout!).sources).toEqual([]);
 await expect(runtime.executeFetch({ url: "https://example.com/docs" }, { scope: threadScope(), signal: new AbortController().signal })).rejects.toThrow("disposed");
 await fake.harness.lifecycle.dispose();
});
it("persists snapshots and crawl controls through compiled-factory reload without model turns", async () => {
 let fake = host(); let runtime: ForageRuntime;
 const load = async (bb: BbPluginApi) => { runtime = await compiled.createServerRuntime(bb); };
 await load(fake.bb);
 const receipt = runtime!.sources.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("# Persisted bundle", { fetchedAt: new Date().toISOString() }), attempt: attempt() });
 const start = await fake.harness.behavior.runCli(["crawl", "start", ...flags, "--input", '{"url":"https://example.com/docs"}']); expect(start.exitCode).toBe(0); const jobId = JSON.parse(start.stdout!).id as string;
 const cancel = await fake.harness.behavior.runCli(["crawl", "cancel", ...flags, "--input", JSON.stringify({ jobId })]); expect(JSON.parse(cancel.stdout!).state).toBe("cancelled");
 const resume = await fake.harness.behavior.runCli(["crawl", "resume", ...flags, "--input", JSON.stringify({ jobId })]); expect(JSON.parse(resume.stdout!).state).toBe("queued");
 fake = await fake.harness.lifecycle.reload(load);
 const read = await fake.harness.behavior.runCli(["fetch", ...flags, "--input", JSON.stringify({ snapshotId: receipt.snapshotId, contentHash: receipt.contentHash })]); expect(read.exitCode, read.stderr).toBe(0); expect(read.stdout).toContain("Persisted bundle");
 const job = await fake.harness.behavior.runCli(["crawl", "status", ...flags, "--input", JSON.stringify({ jobId })]); expect(JSON.parse(job.stdout!).state).toBe("queued");
 expect(fake.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
 await fake.harness.lifecycle.dispose();
});
