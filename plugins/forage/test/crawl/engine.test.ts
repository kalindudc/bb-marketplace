import Database from "better-sqlite3";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createCrawlService, type CrawlEngine, type CrawlEngineOptions } from "../../src/crawl/engine.ts";
import { CRAWL_DEFAULT_LIMITS } from "../../src/crawl/repository.ts";
import { FORAGE_MIGRATIONS } from "../../src/crawl/schema.ts";
import { configureSourceDatabase } from "../../src/sources/schema.ts";
import { SqliteSourceRepository } from "../../src/sources/repository.ts";
import { resolveConfig } from "../../src/web/config.ts";
import type { CrawlRequest } from "../../src/jobs/model.ts";
import type { SafeFetchOptions, SafeFetchResult } from "../../src/web/net.ts";
import type { ProviderTransportOptions } from "../../src/web/providers/http.ts";
import { artifact, attempt, structured, threadScope } from "../sources/helpers.ts";

const resources: Array<{ db: Database.Database; service: CrawlEngine }> = [];
const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
function response(url: string, body = "", status = 404, contentType = "text/plain"): SafeFetchResult {
 return { response: new Response(body, { status, headers: { "content-type": contentType } }), finalUrl: url, redirects: 0, acceptedRedirectBytes: 0, access: { network: "public", credentialed: false, requestScopeKey: null } };
}
function setup(overrides: Partial<CrawlEngineOptions> = {}, storageBytes = 128 * 1024 * 1024) {
 const db = new Database(":memory:"); configureSourceDatabase(db); for (const sql of FORAGE_MIGRATIONS) db.exec(sql);
 let sources: SqliteSourceRepository;
 const fetched: string[] = [];
 const service = createCrawlService(db, {
  getConfig: () => resolveConfig(), getSources: () => sources, resolver: publicResolver,
  transport: async url => response(url),
  fetchPage: async (url, options) => {
   fetched.push(url); options.byteBudget!.consume(10);
   const a = artifact("fixture", { requestedUrl: url, resolvedUrl: url, finalUrl: url, structured: structured({ canonicalUrl: url }) });
   return { url, finalUrl: url, title: a.title, content: a.content, kind: a.kind, contentType: a.contentType, status: 200, bytes: 10, durationMs: 1, redirects: 0, cached: false, artifact: a, attempt: attempt() };
  }, ...overrides,
 });
 sources = new SqliteSourceRepository(db, { maintenance: service, maxContentBytes: storageBytes });
 resources.push({ db, service });
 function create(changes: Partial<CrawlRequest> = {}, discover = false) {
  const job = service.create({ scope: threadScope(), rootUrl: "https://example.com/docs", includePaths: [], excludePaths: [], includeSubdomains: false,
   limits: { ...CRAWL_DEFAULT_LIMITS }, backend: "local", ...changes });
  if (!discover) db.prepare("UPDATE forage_crawl_jobs SET discovered = 1 WHERE id = ?").run(job.id);
  return job;
 }
 return { db, service, sources, fetched, create };
}
afterEach(async () => { for (const { db, service } of resources.splice(0)) { await service.dispose(); if (db.open) db.close(); } });

describe("local crawl fixtures", () => {
 it("charges robots and discovery bytes without extra pages, and stores real source references", async () => {
  const { create, service, sources } = setup({ transport: async url => response(url, url.endsWith("sitemap.xml") ? '<urlset><url><loc>https://example.com/a</loc></url></urlset>' : "", url.endsWith("sitemap.xml") ? 200 : 404) });
  const job = create({}, true); await service.runOnce();
  const status = service.status(job.scope, job.id)!;
  expect(status.state).toBe("completed"); expect(status.pagesUsed).toBe(2); expect(status.bytesUsed).toBeGreaterThan(20);
  expect(status.counts.saved).toBe(2); expect(sources.list({ scope: job.scope, limit: 10 }).sources).toHaveLength(2);
 });
 it.each([404, 403, 429])("allows HTTP %i robots responses", async status => {
  const { create, service, fetched } = setup({ transport: async url => response(url, "missing", status) }); const job = create();
  await service.runOnce(); expect(fetched).toHaveLength(1); expect(service.status(job.scope, job.id)!.state).toBe("completed");
 });
 it.each([500, 503, 302])("denies HTTP %i robots responses", async status => {
  const { create, service, fetched } = setup({ transport: async url => response(url, "unavailable", status) }); const job = create();
  await service.runOnce(); expect(fetched).toHaveLength(0); expect(service.status(job.scope, job.id)!.counts.skipped).toBe(1);
 });
 it("denies unreachable robots, expires the negative cache, and rechecks on resume", async () => {
  let now = 1000, calls = 0;
  const { create, service, fetched } = setup({ now: () => now, robotsTtlMs: 10, transport: async url => { if (++calls === 1) throw new Error("offline"); return response(url); } });
  const a = create(); await service.runOnce(); expect(service.status(a.scope, a.id)!.counts.skipped).toBe(1);
  now += 11; const b = create(); await service.runOnce(); expect(fetched).toHaveLength(1); expect(calls).toBe(2);
 });
 it("uses shared D4 longest matching, Allow ties, wildcard/end and encoded rules for ForageBot", async () => {
  const rules = "User-agent: *\nDisallow: /\nUser-agent: ForageBot\nDisallow: /docs\nAllow: /docs/public\nDisallow: /docs/public\nDisallow: /*.zip$\nDisallow: /encoded\n";
  const { create, service, fetched } = setup({ transport: async url => response(url, rules, 200) });
  create({ rootUrl: "https://example.com/docs/public" }); create({ rootUrl: "https://example.com/%65ncoded" }); await service.runOnce();
  expect(fetched).toEqual(["https://example.com/docs/public"]);
  create({ rootUrl: "https://example.com/file.zip" }); await service.runOnce(); expect(fetched).toHaveLength(1);
 });
 it("fails capture refusal and reports storage-limit rather than saved", async () => {
  const { create, service, sources } = setup({}, 1); const job = create(); await service.runOnce();
  const status = service.status(job.scope, job.id)!; expect(status.state).toBe("partial"); expect(status.stopReason).toBe("storage-limit");
  expect(status.counts.saved).toBe(0); expect(status.counts.failed).toBe(1); expect(sources.list({ scope: job.scope, limit: 10 }).sources).toHaveLength(0);
 });
 it("reserves parallel payloads and explicitly stops on an exhausted reservation", async () => {
  let active = 0, peak = 0;
  const { create, service } = setup({ fetchPage: async (_url, options) => {
   peak = Math.max(peak, ++active); await delay(5); active--; options.byteBudget!.consume(101); throw new Error("unreachable");
  } });
  const job = create({ limits: { ...CRAWL_DEFAULT_LIMITS, maxBytes: 100 } });
  await service.runOnce(); const status = service.status(job.scope, job.id)!;
  expect(status.bytesUsed).toBe(0); expect(status.stopReason).toBe("byte-limit"); expect(status.counts.failed).toBe(1); expect(peak).toBe(1);
 });
 it("fences late responses after cancel/resume and accumulates active duration", async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const { create, service, sources } = setup({ fetchPage: async (url) => { entered(); await wait; const a = artifact("late"); return { url, finalUrl: url, title: "late", content: "late", kind: "markdown", contentType: "text/markdown", status: 200, bytes: 4, durationMs: 1, redirects: 0, cached: false, artifact: a, attempt: attempt() }; } });
  const job = create(); const running = service.runOnce(); await started;
  service.cancel(job.scope, job.id); service.resume(job.scope, job.id); release(); await running;
  expect(sources.list({ scope: job.scope, limit: 10 }).sources).toHaveLength(0); expect(service.status(job.scope, job.id)!.state).toBe("queued");
  await service.runOnce(); expect(service.status(job.scope, job.id)!.counts.saved).toBe(1);
 });
 it("pauses on service abort and can dispose after its database has closed", async () => {
  let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  const { create, service, db } = setup({ fetchPage: async (_url, options) => { entered(); await delay(60000, undefined, { signal: options.signal }); throw new Error("not reached"); } });
  const job = create(); const controller = new AbortController(); const running = service.run(controller.signal); await started;
  controller.abort(); await running; expect(service.status(job.scope, job.id)!.state).toBe("paused");
  db.close(); await service.dispose();
 });
 it("captures raw HTML metadata through D4 and follows links without automatic remote alternates", async () => {
  const requests: string[] = [];
  const { create, service } = setup({ fetchPage: undefined, transport: async (url, options) => {
   requests.push(url); expect(options.headers!["User-Agent"]).toBe("ForageBot"); expect(options.maxRedirects).toBe(5);
   if (url.endsWith("robots.txt")) return response(url);
   return response(url, url.endsWith("/docs") ? '<html><title>Root</title><link rel="alternate" type="text/markdown" href="https://elsewhere.example/private.md"><main><a href="/next">Next</a></main></html>' : '<main>Second page</main>', 200, "text/html");
  } });
  const job = create(); await service.runOnce(); expect(service.status(job.scope, job.id)!.counts.saved).toBe(2);
  expect(requests.some(url => url.includes("elsewhere"))).toBe(false);
 });
 it("recognizes transport-normalized byte errors from the default acquisition path", async () => {
  const { create, service } = setup({ fetchPage: undefined, transport: async url => url.endsWith("robots.txt") ? response(url) : response(url, "x".repeat(101), 200) });
  const job = create({ limits: { ...CRAWL_DEFAULT_LIMITS, maxBytes: 100 } }); await service.runOnce();
  expect(service.status(job.scope, job.id)).toMatchObject({ state: "partial", stopReason: "byte-limit", bytesUsed: 0, counts: { failed: 1, saved: 0 } });
 });
 it("checks restrictive robots before allowing each redirect target", async () => {
  const { create, service } = setup({ transport: async url => response(url, "User-agent: ForageBot\nDisallow: /private", 200), fetchPage: async (_url, options) => {
   expect(options.allowedRedirectOrigins).toEqual(["https://example.com"]);
   await expect(options.beforeRedirect!({ fromUrl: "https://example.com/docs", toUrl: "https://example.com/private", status: 302, signal: options.signal!, deadline: options.deadline! })).rejects.toThrow("robots");
   throw new Error("fixture redirect refused");
  } });
  const job = create(); await service.runOnce(); expect(service.status(job.scope, job.id)!.counts.saved).toBe(0);
 });
 it("aborts in-flight work and disposes safely even if the database was closed first", async () => {
  let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  const { create, service, db } = setup({ fetchPage: async (_url, options) => { entered(); await delay(60000, undefined, { signal: options.signal }); throw new Error("not reached"); } });
  create(); const task = service.runOnce(); await started; db.close(); await service.dispose(); await task;
 });
 it("refuses sensitive canonical metadata before saving the original document", async () => {
  const { create, service, sources } = setup({ fetchPage: undefined, transport: async url => url.endsWith("robots.txt") ? response(url) : response(url, '<link rel="canonical" href="https://example.com/?token=do-not-save"><main>Content</main>', 200, "text/html") });
  const job = create(); await service.runOnce(); const status = service.status(job.scope, job.id)!;
  expect(status.counts.saved).toBe(0); expect(status.counts.failed).toBe(1); expect(status.state).toBe("partial"); expect(sources.list({ scope: job.scope, limit: 10 }).sources).toHaveLength(0);
 });
 it("rechecks robots on resumed skipped work and never exceeds two URL attempts", async () => {
  let now = 1000; let deny = true;
  const { create, service, fetched } = setup({ now: () => now, robotsTtlMs: 1, transport: async url => response(url, deny ? "User-agent: ForageBot\nDisallow: /" : "", 200) });
  const job = create(); await service.runOnce(); deny = false; now += 2;
  service.resume(job.scope, job.id); await service.runOnce();
  expect(fetched).toHaveLength(1); expect(service.status(job.scope, job.id)!.counts.saved).toBe(1); expect(service.repository.pages(job.scope, job.id)[0]!.attempts).toBe(2);
 });
 it("stops at the accumulated active time limit", async () => {
  const { create, service } = setup({ fetchPage: async (_url, options) => { await delay(60000, undefined, { signal: options.signal }); throw new Error("not reached"); } });
  const job = create({ limits: { ...CRAWL_DEFAULT_LIMITS, maxDurationMs: 1000 } });
  await service.runOnce(); const status = service.status(job.scope, job.id)!;
  expect(status.state).toBe("partial"); expect(status.stopReason).toBe("time-limit"); expect(status.activeDurationMs).toBeGreaterThanOrEqual(990);
 });
 it("runs the maximum 200-page, 100-MiB fixture with event-loop lag below 250ms", async () => {
  const content = "x".repeat(512 * 1024); let peakLag = 0; let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); peakLag = Math.max(peakLag, now - last - 5); last = now; }, 5);
  const { create, service } = setup({ fetchPage: async (url, options) => {
   options.byteBudget!.consume(Buffer.byteLength(content));
   const links = url.endsWith("/docs") ? Array.from({ length: 199 }, (_, i) => ({ url: `https://example.com/page-${i}`, text: "page", relation: "content" as const })) : [];
   const a = artifact(content, { requestedUrl: url, resolvedUrl: url, finalUrl: url, structured: structured({ canonicalUrl: url, links }) });
   return { url, finalUrl: url, title: "fixture", content, kind: "markdown", contentType: "text/markdown", status: 200, bytes: content.length, durationMs: 1, redirects: 0, cached: false, artifact: a, attempt: attempt() };
  } });
  const job = create({ limits: { ...CRAWL_DEFAULT_LIMITS, maxPages: 200, maxBytes: 100 * 1024 * 1024, concurrency: 4 } });
  try {
   await service.runOnce(); await delay(10);
   const status = service.status(job.scope, job.id)!; expect(status.counts.saved).toBe(200); expect(status.bytesUsed).toBe(100 * 1024 * 1024);
   expect(peakLag).toBeLessThan(250); console.log(`J5 maximum crawl: 200 pages, 100 MiB, peak event-loop lag ${peakLag.toFixed(1)}ms`);
  } finally { clearInterval(timer); }
 }, 15000);
 it("blocks forbidden backends before forwarding and rejects sensitive seed URLs", () => {
  const { create } = setup({ getConfig: () => resolveConfig({ allowedBackends: ["local"] }) });
  expect(() => create({ backend: "firecrawl" })).toThrow(/blocked/); expect(() => create({ rootUrl: "https://example.com/?TOKEN=secret" })).toThrow(/policy/);
 });
 it("enforces global two jobs, four requests and two requests per origin", async () => {
  let active = 0, peak = 0; const origins = new Map<string, number>(); let originPeak = 0;
  const { create, service } = setup({ fetchPage: async (url, options) => {
   active++; peak = Math.max(peak, active); const origin = new URL(url).origin; origins.set(origin, (origins.get(origin) ?? 0) + 1); originPeak = Math.max(originPeak, origins.get(origin)!);
   options.byteBudget!.consume(10); await delay(5);
   const a = artifact("fixture", { requestedUrl: url, resolvedUrl: url, finalUrl: url, structured: structured({ canonicalUrl: url, links: Array.from({ length: 8 }, (_, i) => ({ url: `${origin}/${i}`, text: "link", relation: "content" as const })) }) });
   active--; origins.set(origin, origins.get(origin)! - 1);
   return { url, finalUrl: url, title: "fixture", content: a.content, kind: a.kind, contentType: a.contentType, status: 200, bytes: 10, durationMs: 1, redirects: 0, cached: false, artifact: a, attempt: attempt() };
  } });
  const limits = { ...CRAWL_DEFAULT_LIMITS, concurrency: 4, maxPages: 8 }; const first = create({ limits }); create({ rootUrl: "https://other.example/docs", limits }); const third = create({ rootUrl: "https://third.example/docs", limits });
  await service.runOnce();
  const jobs = service.list({ scope: first.scope, limit: 10 }).jobs;
  expect(jobs.filter(j => j.state === "queued")).toHaveLength(1);
  expect(jobs.filter(j => j.pagesUsed === 8)).toHaveLength(2); expect(peak).toBe(4); expect(originPeak).toBe(2);
 });
});

function vendorFixture() {
 const calls: Array<{ url: string; method: string }> = []; let polls = 0;
 const transport = async (url: string, options: ProviderTransportOptions) => {
  calls.push({ url, method: options.method ?? "GET" });
  const payload = options.method === "POST" ? { id: "remote-1", status: "scraping" } : options.method === "DELETE" ? { status: "cancelled" } : ++polls === 1
   ? { status: "completed", completed: 1, total: 1, next: "https://api.firecrawl.dev/v2/crawl/remote-1?cursor=2", data: [{ markdown: "# Root", metadata: { url: "https://example.com/docs", title: "Root" } }] }
   : { status: "completed", completed: 2, total: 2, data: [{ markdown: "# Next", metadata: { url: "https://example.com/a", title: "Next" } }] };
  return response(url, JSON.stringify(payload), 200, "application/json");
 };
 return { calls, transport };
}
describe("explicit managed Firecrawl lifecycle with injected transport", () => {
 it("rejects unsupported vendor subdomain discovery before any request", () => {
  let calls = 0;
  const { create } = setup({ getConfig: () => resolveConfig({ firecrawlApiKey: "fixture-only" }), providerTransport: async () => { calls++; throw new Error("must not dispatch"); } });
  expect(() => create({ backend: "firecrawl", includeSubdomains: true })).toThrow("UNSUPPORTED_BACKEND_OPTION"); expect(calls).toBe(0);
 });
 it("keeps lost start acknowledgements visibly failed and never restarts or claims cancellation", async () => {
  let calls = 0;
  const { create, service } = setup({ getConfig: () => resolveConfig({ firecrawlApiKey: "fixture-only" }), providerTransport: async () => { calls++; throw new Error("lost acknowledgement"); } });
  const job = create({ backend: "firecrawl" }); await service.runOnce();
  expect(service.status(job.scope, job.id)).toMatchObject({ state: "failed", stopReason: "error" });
  expect(service.status(job.scope, job.id)!.error).toContain("REMOTE_START_UNKNOWN");
  expect(() => service.resume(job.scope, job.id)).toThrow("cannot be resumed safely");
  expect(service.cancel(job.scope, job.id).state).toBe("failed"); await service.runOnce(); expect(calls).toBe(1);
 });
 it("recovers a crash during remote start as unknown rather than resumable", async () => {
  const { create, service, db, sources } = setup({ getConfig: () => resolveConfig({ firecrawlApiKey: "fixture-only" }) });
  const job = create({ backend: "firecrawl" }); const run = service.repository.start(job.id)!;
  service.repository.markRemoteStartPending(job.id, run.generation); await service.dispose();
  const reloaded = createCrawlService(db, { getConfig: () => resolveConfig({ firecrawlApiKey: "fixture-only" }), getSources: () => sources });
  expect(reloaded.status(job.scope, job.id)!.state).toBe("failed"); expect(reloaded.status(job.scope, job.id)!.error).toContain("REMOTE_START_UNKNOWN");
  expect(() => reloaded.resume(job.scope, job.id)).toThrow("cannot be resumed safely"); await reloaded.dispose();
 });
 it("starts, polls, paginates, captures provenance and settles completion", async () => {
  const vendor = vendorFixture(); const { create, service, sources } = setup({ getConfig: () => resolveConfig({ firecrawlApiKey: "fixture-only-not-a-real-key" }), providerTransport: vendor.transport, pollIntervalMs: 1 });
  const job = create({ backend: "firecrawl" }); await service.runOnce(); const status = service.status(job.scope, job.id)!;
  expect(status.state).toBe("completed"); expect(status.counts.saved).toBe(2); expect(status.bytesUsed).toBeGreaterThan(100);
  expect(vendor.calls.map(c => c.method)).toEqual(["POST", "GET", "GET"]); expect(service.repository.pendingRemote()).toHaveLength(0);
  const source = sources.list({ scope: job.scope, limit: 10 }).sources[0]!; const snapshot = sources.getSnapshot(job.scope, source.latestSnapshot!.id)!;
  expect(snapshot.warnings.some(w => w.code === "MANAGED_CRAWL")).toBe(true);
 });
 it("retains failed cancellation for retry, accounts its bytes, and blocks metadata deletion", async () => {
  let failing = true; let deletes = 0;
  const { create, service } = setup({ getConfig: () => resolveConfig({ firecrawlApiKey: "fixture-only-not-a-real-key" }), providerTransport: async (url, options) => {
   expect(options.method).toBe("DELETE"); deletes++;
   return response(url, failing ? '{"error":"fixture unavailable"}' : '{"status":"cancelled"}', failing ? 503 : 200, "application/json");
  } });
  const job = create({ backend: "firecrawl" }); const run = service.repository.start(job.id)!;
  service.repository.reserveControl(job.id, run.generation); service.repository.trackRemote(job.id, run.generation, "pending-remote"); service.cancel(job.scope, job.id);
  await expect(service.runOnce()).rejects.toThrow(/503/); expect(service.repository.pendingRemote()).toHaveLength(1);
  expect(service.status(job.scope, job.id)!.bytesUsed).toBeGreaterThan(0); await expect(service.repository.deleteScope(job.scope)).rejects.toThrow(/cancellation/);
  failing = false; await service.runOnce(); expect(deletes).toBe(2); expect(service.repository.pendingRemote()).toHaveLength(0);
  expect(await service.deleteScope(job.scope)).toBe(1);
 });
 it("sends DELETE on cancellation and prevents post-cancel capture", async () => {
  let polled!: () => void; const started = new Promise<void>(r => { polled = r; }); const vendor = vendorFixture();
  const { create, service, sources } = setup({ getConfig: () => resolveConfig({ firecrawlApiKey: "fixture-only-not-a-real-key" }), pollIntervalMs: 1,
   providerTransport: async (url, options) => { if (!options.method) { polled(); await delay(60000, undefined, { signal: options.signal }); } return vendor.transport(url, options); } });
  const job = create({ backend: "firecrawl" }); const running = service.runOnce(); await started; service.cancel(job.scope, job.id); await running;
  expect(service.status(job.scope, job.id)!.state).toBe("cancelled"); expect(vendor.calls.at(-1)!.method).toBe("DELETE");
  expect(sources.list({ scope: job.scope, limit: 10 }).sources).toHaveLength(0); expect(service.repository.pendingRemote()).toHaveLength(0);
 });
 it("recovers a persisted remote id on reload without resuming local pages", async () => {
  const vendor = vendorFixture(); const { create, service, db, sources } = setup({ getConfig: () => resolveConfig({ firecrawlApiKey: "fixture-only-not-a-real-key" }), providerTransport: vendor.transport });
  const job = create({ backend: "firecrawl" }); const started = service.repository.start(job.id)!; service.repository.reserveControl(job.id, started.generation); service.repository.trackRemote(job.id, started.generation, "remote-reload");
  const reload = createCrawlService(db, { getConfig: () => resolveConfig({ firecrawlApiKey: "fixture-only-not-a-real-key" }), getSources: () => sources, providerTransport: vendor.transport });
  expect(reload.status(job.scope, job.id)!.state).toBe("paused"); await reload.runOnce(); expect(vendor.calls.map(c => c.method)).toEqual(["DELETE"]);
  await reload.dispose();
 });
});
