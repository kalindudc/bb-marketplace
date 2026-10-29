import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createServerRuntime } from "../server.ts";
import { artifact, attempt, threadScope } from "./sources/helpers.ts";
import type { FetchedContent } from "../src/web/fetch.ts";
import type { SearchResponse } from "../src/web/search.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function page(url: string, content = "# Example\n\nBody"): FetchedContent {
 const a = artifact(content, { requestedUrl: url, resolvedUrl: url, finalUrl: url, fetchedAt: new Date().toISOString(), structured: { schemaVersion: 1, title: "Example", description: "Fixture", canonicalUrl: url, language: "en", headings: [{ level: 1, text: "Example", line: 1 }], links: [], tables: [], jsonLd: [] } });
 return { url, finalUrl: url, title: a.title, content, kind: "markdown", contentType: "text/markdown", status: 200, bytes: a.bytes, durationMs: 1, redirects: 0, cached: false, artifact: a, attempt: attempt(), contentHash: a.contentHash };
}
function fakeHost() {
 const fake = createFakePluginHost({ pluginId: "forage", experimental_declaredIconNames: ["search", "fetch", "map", "extract", "crawl", "diff"] });
 fake.harness.sdk.stub("projects.get", async ({ projectId }) => ({ id: projectId, name: "Fixture", createdAt: 1, updatedAt: 1, gitRemoteUrl: null, kind: "standard", sources: [] }));
 fake.harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "proj_a" }));
 cleanups.push(() => fake.harness.lifecycle.dispose()); return fake;
}
const flags = ["--project", "proj_a", "--thread", "thr_a"];
const context = { projectId: "proj_a", threadId: "thr_a" };
const searchResponse: SearchResponse = { query: "fixture", provider: "duckduckgo", results: [], rawCount: 0, durationMs: 1, attempts: [], appliedControls: [], unsupportedControls: [], cached: false };
async function until(test: () => boolean) { const end = Date.now() + 2000; while (!test()) { if (Date.now() > end) throw new Error("Fixture condition did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); } }

describe("single server service graph", () => {
 it("drives all six native tools and CLI families against the same actual sources/jobs/RPC and diagnostic ring", async () => {
  const fake = fakeHost();
  const runtime = await createServerRuntime(fake.bb, { search: async () => searchResponse, fetch: async url => page(url, url.endsWith("sitemap.xml") ? '<urlset><url><loc>https://example.com/docs</loc></url></urlset>' : "# Example\n\nBody"), crawl: { transport: async url => ({ response: new Response("", { status: 404 }), finalUrl: url, redirects: 0, acceptedRedirectBytes: 0, access: { network: "public", credentialed: false, requestScopeKey: null } }), fetchPage: async url => page(url) } });
  const before = runtime.sources.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("# Before", { fetchedAt: new Date().toISOString() }), attempt: attempt() });
  const after = runtime.sources.recordRetrieval({ scope: threadScope(), origin: "fetch", artifact: artifact("# After", { fetchedAt: new Date().toISOString() }), attempt: attempt() });
  for (const [name, input] of Object.entries({ search: { query: "fixture" }, fetch: { url: "https://example.com/docs" }, map: { url: "https://example.com", maxIndexDocuments: 3 }, extract: { url: "https://example.com/docs", fields: ["headings"] }, diff: { beforeSnapshotId: before.snapshotId, afterSnapshotId: after.snapshotId }, crawl: { action: "list" } })) {
   const tool = await fake.harness.behavior.callAgentTool(`web_${name}`, input, context); expect(tool, name).not.toHaveProperty("isError", true);
   const cli = await fake.harness.behavior.runCli([name, ...(name === "crawl" ? ["list"] : []), ...flags, "--input", JSON.stringify(input)]); expect(cli.exitCode, cli.stderr).toBe(0);
  }
  const start = await fake.harness.behavior.runCli(["crawl", "start", ...flags, "--input", '{"url":"https://example.com/docs","limits":{"maxPages":2}}']);
  expect(start.exitCode, start.stderr).toBe(0); const jobId = JSON.parse(start.stdout!).id as string;
  const runner = fake.harness.behavior.runService("crawl"); await until(() => runtime.jobs.status(threadScope(), jobId)?.state === "completed"); runner.controller.abort(); await runner.done;
  const jobs = await fake.harness.behavior.callRpc("getCrawlJob", { scope: threadScope(), jobId }); expect(jobs).toMatchObject({ state: "completed", counts: { saved: 1 } });
  expect((await fake.harness.behavior.callRpc("listSources", { scope: threadScope(), limit: 10 })) as object).toHaveProperty("sources");
  const diagnostic = await fake.harness.behavior.runCli(["diagnostics"]); for (const name of ["search", "fetch", "map", "extract", "diff", "crawl"]) expect(diagnostic.stdout).toContain(`"operation": "${name}"`);
  expect(fake.harness.experimental_rpcInvalidations).toContainEqual(["forage:sources:thread:proj_a:thr_a", "forage:jobs:thread:proj_a:thr_a"]);
  const exported = await fake.harness.behavior.runCli(["sources", "export", ...flags]); expect(exported.stdout).toContain("/api/v1/plugins/forage/http/sources-export");
 });
 it("recovers missed thread/project deletion, retains archived scopes and never deletes after transient SDK failures", async () => {
  const fake = fakeHost(); let projectMissing = false;
  fake.harness.sdk.stub("projects.get", async ({ projectId }) => { if (projectMissing) throw Object.assign(new Error("missing"), { status: 404 }); return { id: projectId, name: "Fixture", createdAt: 1, updatedAt: 1, gitRemoteUrl: null, kind: "standard", sources: [] }; });
  fake.harness.sdk.stub("threads.get", async ({ threadId }) => { if (threadId === "missing") throw Object.assign(new Error("missing"), { status: 404 }); if (threadId === "transient") throw Object.assign(new Error("forbidden"), { status: 403 }); return makeThreadResponse({ id: threadId, projectId: "proj_a", archivedAt: 100 }); });
  const runtime = await createServerRuntime(fake.bb);
  for (const thread of ["missing", "transient", "archived"]) runtime.sources.recordRetrieval({ scope: threadScope(thread), origin: "fetch", artifact: artifact("# Fresh", { fetchedAt: new Date().toISOString() }), attempt: attempt() });
  runtime.jobs.create({ scope: threadScope("missing"), rootUrl: "https://example.com", backend: "local", includePaths: [], excludePaths: [], includeSubdomains: false, limits: { maxPages: 1, maxDepth: 0, maxBytes: 1000, maxDurationMs: 1000, concurrency: 1 } });
  await fake.harness.behavior.runSchedule("retention");
  expect(runtime.sources.list({ scope: threadScope("missing"), limit: 10 }).sources).toHaveLength(0); expect(runtime.jobs.list({ scope: threadScope("missing"), limit: 10 }).jobs).toHaveLength(0);
  for (const thread of ["transient", "archived"]) expect(runtime.sources.list({ scope: threadScope(thread), limit: 10 }).sources).toHaveLength(1);
  projectMissing = true; await fake.harness.behavior.runSchedule("retention");
  for (const thread of ["transient", "archived"]) expect(runtime.sources.list({ scope: threadScope(thread), limit: 10 }).sources).toHaveLength(0);
 });
 it("fences a late capture through the authoritative thread-deleted event", async () => {
  const fake = fakeHost(); let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
  const runtime = await createServerRuntime(fake.bb, { fetch: async url => { entered(); await wait; return page(url); } });
  const pending = runtime.executeFetch({ url: "https://example.com/docs" }, { scope: threadScope(), signal: new AbortController().signal }); await started;
  const event = await fake.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_a", projectId: "proj_a", deletedAt: Date.now() }) }); expect(event.errors).toEqual([]);
  release(); await expect(pending).rejects.toThrow("Scope was cleared or deleted"); expect(runtime.sources.list({ scope: threadScope(), limit: 10 }).sources).toHaveLength(0);
 });
 it("updates the crawl config synchronously and revokes active captures on settings changes", async () => {
  const fake = fakeHost(); let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
  const runtime = await createServerRuntime(fake.bb, { fetch: async url => { entered(); await wait; return page(url); } });
  const pending = runtime.executeFetch({ url: "https://example.com/docs" }, { scope: threadScope(), signal: new AbortController().signal }); await started;
  await fake.harness.behavior.setSettings({ privacyProfile: "private", allowedReaders: "direct", allowedBackends: "local" }); release();
  await expect(pending).rejects.toThrow("Forage policy changed"); expect((await runtime.getConfig()).privacyProfile).toBe("private");
  const forbidden = await fake.harness.behavior.runCli(["fetch", ...flags, "--input", '{"url":"https://example.com","reader":"jina"}']); expect(forbidden.exitCode).toBe(1); expect(forbidden.stderr).toContain("POLICY_BLOCKED");
 });
});
