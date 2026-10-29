import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { createServerRuntime } from "../../server.ts";
import { artifact, attempt } from "../sources/helpers.ts";
import type { FetchedContent } from "../../src/web/fetch.ts";
import type { SearchResponse } from "../../src/web/search.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const scope = { kind: "thread", projectId: "proj_a", threadId: "thr_a" } as const;
const ctx = { projectId: "proj_a", threadId: "thr_a" };
const DOC = "# Performance\n\nWorkers LISTEN on a channel and the database NOTIFYs them.\n\n## Connection poolers\n\nPgBouncer in transaction mode does not support LISTEN.\nGive workers a direct connection.";

function page(url: string, content = DOC): FetchedContent {
 const a = artifact(content, { requestedUrl: url, resolvedUrl: url, finalUrl: url, title: "Performance", fetchedAt: new Date().toISOString(), structured: { schemaVersion: 1, title: "Performance", description: "", canonicalUrl: url, language: "en", headings: [], links: [], tables: [], jsonLd: [] }, access: { network: "public", credentialed: false, requestScopeKey: "thread:proj_a:thr_a" } });
 return { url, finalUrl: url, title: "Performance", content, kind: "markdown", contentType: "text/markdown", status: 200, bytes: a.bytes, durationMs: 1, redirects: 0, cached: false, artifact: a, attempt: attempt(), contentHash: a.contentHash, access: a.access };
}
const searched = (query: string): SearchResponse => ({
 query, provider: "duckduckgo", rawCount: 2, durationMs: 3, attempts: [], appliedControls: [], unsupportedControls: [], cached: false,
 results: [{ title: "Performance", url: "https://worker.example/docs/performance", snippet: "Workers LISTEN" }, { title: "Releases", url: "https://github.com/example/releases?token=secret", snippet: "" }],
});

async function setup(fetch: (url: string, options: any) => Promise<FetchedContent> = async (url) => page(url)) {
 const metadata = new Map<string, Record<string, unknown>>();
 const fake = createFakePluginHost({ pluginId: "forage", agentSkillIds: ["forage", "forage-research"], experimental_declaredIconNames: ["forage", "search", "fetch", "map", "extract", "crawl", "diff"] });
 fake.harness.sdk.stub("projects.get", async ({ projectId }) => ({ id: projectId, name: "Acme API", createdAt: 1, updatedAt: 1, gitRemoteUrl: null, kind: "standard", sources: [] }));
 fake.harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "proj_a", title: `Thread ${threadId}` }));
 fake.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }) => metadata.get(threadId) ?? {});
 fake.harness.sdk.stub("threads.updatePluginMetadata", async ({ threadId, set }: any) => { const next = { ...(metadata.get(threadId) ?? {}), ...(set ?? {}) }; metadata.set(threadId, next); return next; });
 fake.harness.sdk.stub("threads.experimental_listPluginMetadata", async ({ threadIds }: any) => ({ threads: (threadIds as string[]).filter((id) => metadata.has(id)).map((threadId) => ({ threadId, metadata: metadata.get(threadId)! as never })) }));
 cleanups.push(() => fake.harness.lifecycle.dispose());
 const runtime = await createServerRuntime(fake.bb, { search: async (query) => searched(query), fetch });
 const rpc = <T = any>(method: string, input: unknown, caller?: { kind: "plugin"; pluginId: string }) => fake.harness.behavior.callRpc(method, input, caller ? { experimental_caller: caller } : undefined) as Promise<T>;
 const tool = (name: string, input: unknown) => fake.harness.behavior.callAgentTool(name, input, ctx) as Promise<{ content: unknown; isError?: boolean }>;
 return { fake, runtime, rpc, tool, metadata };
}
const configContext = (pluginMetadata: Record<string, unknown>) => ({
 thread: { id: "thr_a" }, project: { id: "proj_a", kind: "standard", name: "Acme API" }, environment: null, host: null, provider: { id: "codex", model: null, capabilities: {} }, origin: { kind: null, pluginId: null }, pluginMetadata,
}) as unknown as PluginAgentConfigurationContext;

describe("per-thread research", () => {
 it("records what the agent searched and read, and links search results to the pages it kept", async () => {
  const { rpc, tool } = await setup();
  await tool("web_search", { queries: ["pg-boss vs graphile-worker", "listen notify latency"] });
  await tool("web_fetch", { url: "https://worker.example/docs/performance" });
  const activity = await rpc<any>("listActivity", { scope, limit: 10 });
  expect(activity.enabled).toBe(true);
  expect(activity.entries.map((e: any) => [e.actor, e.operation])).toEqual([["agent", "fetch"], ["agent", "search"]]);
  const search = activity.entries[1].summary;
  expect(search.queries.map((q: any) => q.query)).toEqual(["pg-boss vs graphile-worker", "listen notify latency"]);
  expect(search.queries[0].results[0]).toMatchObject({ url: "https://worker.example/docs/performance", sourceId: expect.any(String) });
  // A secret-looking query string never reaches the log.
  expect(search.queries[0].results[1].url).toBe("https://github.com/example/releases");
  expect(activity.entries[0].summary.pages[0]).toMatchObject({ title: "Performance", sourceId: search.queries[0].results[0].sourceId });
  const summary = await rpc<any>("researchSummary", ctx);
  expect(summary).toMatchObject({ policy: "settings", searches: 2, reads: 1, sources: 1, cited: 0, running: [] });
 });

 it("runs a person's search with no model turn, labels it, and refuses other plugins", async () => {
  const { rpc } = await setup();
  const out = await rpc<any>("run", { ...ctx, operation: "search", query: "graphile worker priority", via: "tab" });
  expect(out).toMatchObject({ ok: true, message: "Found 2 results." });
  await rpc("run", { ...ctx, operation: "read", url: "https://worker.example/docs/performance", via: "browser" });
  const activity = await rpc<any>("listActivity", { scope, limit: 10 });
  expect(activity.entries.map((e: any) => [e.actor, e.operation])).toEqual([["person", "save"], ["person", "search"]]);
  const sources = await rpc<any>("listResearchSources", { scope, filter: "all", limit: 50 });
  expect(sources.sources[0]).toMatchObject({ arrival: "person", via: "browser" });
  await expect(rpc("run", { ...ctx, operation: "search", query: "x" }, { kind: "plugin", pluginId: "other" })).rejects.toThrow(/local client/u);
 });

 it("applies the thread's web research policy to tools, configuration and the ceiling", async () => {
  const { fake, rpc, tool } = await setup();
  const all = await fake.harness.behavior.resolveAgentConfiguration(configContext({}));
  expect(all.tools.map((t) => t.name)).toEqual(["web_search", "web_fetch", "web_map", "web_extract", "web_crawl", "web_diff"]);
  expect(all.skills).toEqual(["forage", "forage-research"]);
  expect((await rpc<any>("setThreadPolicy", { threadId: "thr_a", policy: "off" })).policy).toBe("off");
  const off = await fake.harness.behavior.resolveAgentConfiguration(configContext({ webResearch: "off" }));
  expect(off.tools).toEqual([]); expect(off.skills).toEqual(["forage"]);
  const refused = await tool("web_search", { query: "anything" });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toMatch(/web research is off in this thread/iu);
  expect(await rpc<any>("policies", { keys: ["thr_a", "thr_b"] })).toEqual({ thr_a: "off", thr_b: "settings" });
  // The CLI and the Research tab go through the same check.
  const cli = await fake.harness.behavior.runCli(["search", "--project", "proj_a", "--thread", "thr_a", "--input", '{"query":"anything"}']);
  expect(cli.exitCode).toBe(1);
  expect(cli.stderr).toMatch(/web research is off in this thread/iu);
  expect((await rpc<any>("run", { ...ctx, operation: "search", query: "blocked" })).ok).toBe(false);
  expect((await rpc<any>("researchConfig", {}))).toEqual({ searxng: false, activityLog: true });
  await rpc("setThreadPolicy", { threadId: "thr_a", policy: "private" });
  const blocked = await tool("web_search", { query: "anything" });
  expect(JSON.stringify(blocked.content)).toMatch(/no configured provider remains/u);
 });

 it("finds passages in kept pages, reads line ranges and records citations", async () => {
  const { rpc, tool } = await setup();
  await tool("web_fetch", { url: "https://worker.example/docs/performance" });
  const found = await rpc<any>("findInSources", { scope, text: "PgBouncer in transaction mode breaks LISTEN" });
  expect(found.matches[0]).toMatchObject({ title: "Performance", startLine: 7, latest: true });
  expect(found.matches[0].matched).toEqual(expect.arrayContaining(["pgbouncer", "transaction", "listen"]));
  // A paraphrase with other word forms still finds the passage.
  expect((await rpc<any>("findInSources", { scope, text: "workers listening on channels" })).matches[0]).toMatchObject({ startLine: 3 });
  const lines = await rpc<any>("readLines", { scope, snapshotId: found.matches[0].snapshotId, startLine: 1, find: "direct connection" });
  expect(lines).toMatchObject({ status: "ok", startLine: 8, lines: ["Give workers a direct connection."] });
  // A citation that misses the page is reported, never answered with other lines.
  expect(await rpc("readLines", { scope, snapshotId: found.matches[0].snapshotId, startLine: 1, find: "not on the page" })).toEqual({ status: "missing", totalLines: 8 });
  expect(await rpc("readLines", { scope, snapshotId: found.matches[0].snapshotId, startLine: 90, endLine: 95 })).toEqual({ status: "missing", totalLines: 8 });
  expect(await rpc("noteCitation", { ...ctx, messageId: "msg_1", snapshotId: found.matches[0].snapshotId, startLine: 7, endLine: 8 })).toEqual({ noted: true });
  const detail = await rpc<any>("researchSource", { scope, sourceId: found.matches[0].sourceId });
  expect(detail.citations).toEqual([expect.objectContaining({ messageId: "msg_1", startLine: 7, endLine: 8 })]);
  expect((await rpc<any>("listResearchSources", { scope, filter: "cited", limit: 10 })).counts.cited).toBe(1);
 });

 it("clears one thread's log, stops recording when the setting is off, and deletes logs with their thread", async () => {
  const { fake, rpc, tool } = await setup();
  await tool("web_search", { query: "one" });
  expect((await rpc<any>("clearActivity", { scope })).removed).toBe(1);
  await tool("web_search", { query: "two" });
  await fake.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_a", projectId: "proj_a" }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await rpc<any>("listActivity", { scope, limit: 10 })).entries).toEqual([]);
  await fake.harness.behavior.setSettings({ keepActivityLog: false });
  await tool("web_search", { query: "three" });
  const after = await rpc<any>("listActivity", { scope, limit: 10 });
  expect(after).toMatchObject({ enabled: false, entries: [] });
 });

 it("answers bb's health probe, which sends no input", async () => {
  const { rpc } = await setup();
  for (const input of [null, undefined, {}]) expect(await rpc<any>("health", input)).toMatchObject({ providers: expect.any(Array), last24h: expect.any(Object) });
 });

 it("downloads a fresh copy for a diff against a URL, and refuses one with no baseline before fetching", async () => {
  const calls: Array<{ url: string; noCache: boolean }> = [];
  let version = 0;
  const { tool, rpc } = await setup(async (url, options) => { calls.push({ url, noCache: Boolean(options.noCache) }); return page(url, `${DOC}\n\nVersion ${++version}.`); });
  await tool("web_fetch", { url: "https://worker.example/docs/performance" });
  const source = (await rpc<any>("listResearchSources", { scope, filter: "all", limit: 10 })).sources[0];
  const refused = await tool("web_diff", { url: "https://worker.example/docs/performance" });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toMatch(/baseline/u);
  expect(calls).toHaveLength(1);
  const diff = await tool("web_diff", { url: "https://worker.example/docs/performance", sourceId: source.id });
  expect(diff.isError).toBeFalsy();
  expect(calls[1]).toEqual({ url: "https://worker.example/docs/performance", noCache: true });
  expect(JSON.stringify(diff.content)).toContain("Version 2");
 });

 it("extracts the kept fields of a readable snapshot of an HTML page", async () => {
  // A readable page from HTML keeps Markdown text with kind html; its fields come from the HTML at capture.
  const { tool, rpc } = await setup(async (url) => {
   const base = page(url);
   return { ...base, kind: "html", artifact: { ...base.artifact!, kind: "html", structured: { ...base.artifact!.structured!, title: "JSON encoder", canonicalUrl: "https://docs.example/json" } } };
  });
  await tool("web_fetch", { url: "https://docs.example/json.html" });
  const source = (await rpc<any>("listResearchSources", { scope, filter: "all", limit: 10 })).sources[0];
  const text = JSON.stringify((await tool("web_extract", { snapshotId: source.latestSnapshotId, fields: ["title", "canonicalUrl"] })).content);
  expect(text).toContain("JSON encoder");
  expect(text).toContain("https://docs.example/json");
 });

 it("records citations from a finished reply, once per range", async () => {
  const { fake, rpc, tool } = await setup();
  await tool("web_fetch", { url: "https://worker.example/docs/performance" });
  const source = (await rpc<any>("listResearchSources", { scope, filter: "all", limit: 10 })).sources[0];
  const text = `Use LISTEN.\n::forage-cite{snapshot="${source.latestSnapshotId}" lines="7-8"}\n::forage-cite{snapshot="${source.latestSnapshotId}" find="direct connection"}\n::forage-cite{snapshot="snap_missing" lines="1"}`;
  await fake.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_a", projectId: "proj_a" }), lastAssistantText: text });
  await rpc("noteCitation", { ...ctx, messageId: "msg_9", snapshotId: source.latestSnapshotId, startLine: 7, endLine: 8 });
  const detail = await rpc<any>("researchSource", { scope, sourceId: source.id });
  expect(detail.citations.map((c: any) => [c.startLine, c.endLine]).sort()).toEqual([[7, 8], [8, 8]]);
  expect((await rpc<any>("researchSummary", ctx)).cited).toBe(1);
 });

 it("counts re-reads with the same text as one version and lists shared copies once", async () => {
  const { rpc, tool, runtime } = await setup();
  await tool("web_fetch", { url: "https://worker.example/docs/performance" });
  // A crawl keeps its own snapshot of the same text under a different extractor id.
  const source = (await rpc<any>("listResearchSources", { scope, filter: "all", limit: 10 })).sources[0];
  const doc = runtime.sources.getSnapshot(scope, source.latestSnapshotId)!;
  runtime.sources.recordRetrieval({ scope, origin: "crawl", artifact: artifact(doc.content, { requestedUrl: source.url, resolvedUrl: source.url, finalUrl: source.url, title: "Performance", extraction: { id: "forage-deterministic-v1", contentRoot: "article" }, fetchedAt: new Date().toISOString() }), attempt: attempt({ startedAt: 500, finishedAt: 600 }) });
  const after = await rpc<any>("listResearchSources", { scope, filter: "all", limit: 10 });
  expect(after.sources[0]).toMatchObject({ id: source.id, versions: 1 });
  expect(after.counts.changed).toBe(0);
  await rpc("copySourceToProject", { ...ctx, sourceId: source.id });
  expect((await rpc<any>("listResearchSources", { scope, filter: "all", limit: 10 })).sources[0].shared).toBe(true);
  expect((await rpc<any>("listResearchSources", { scope: { kind: "project", projectId: "proj_a" }, filter: "all", limit: 10, exceptThreadId: "thr_a" })).sources).toEqual([]);
  expect((await rpc<any>("researchSummary", ctx)).shared).toBe(0);
 });

 it("stops crawls that a stricter thread policy would not allow", async () => {
  const { runtime, rpc } = await setup();
  const started = await runtime.executeCrawl({ action: "start", url: "https://worker.example/docs", limits: { maxPages: 5 } }, { scope, signal: new AbortController().signal });
  const job = started.details as { id: string };
  expect((await rpc<any>("getCrawlJob", { scope, jobId: job.id })).state).not.toBe("cancelled");
  await rpc("setThreadPolicy", { threadId: "thr_a", policy: "off" });
  const after = await rpc<any>("getCrawlJob", { scope, jobId: job.id });
  expect(["cancelled", "cancelling", "completed", "partial"]).toContain(after.state);
  await expect(rpc("resumeCrawlJob", { scope, jobId: job.id })).rejects.toThrow(/off in this thread/u);
 });

 it("lists threads with research and reports health without queries or addresses", async () => {
  const { rpc, tool } = await setup();
  await tool("web_search", { query: "secret project codename" });
  const threads = await rpc<any>("researchThreads", { limit: 10 });
  expect(threads.threads).toEqual([expect.objectContaining({ threadId: "thr_a", title: "Thread thr_a", projectName: "Acme API", activity: 1 })]);
  const health = await rpc<any>("health", {});
  expect(health.providers.find((p: any) => p.id === "duckduckgo")).toMatchObject({ state: "ready" });
  expect(health.providers.find((p: any) => p.id === "brave")).toMatchObject({ state: "needs-key" });
  expect(health.last24h.total).toBeGreaterThan(0);
  expect(JSON.stringify(health)).not.toContain("codename");
 });
});
