import { createHash } from "node:crypto";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import type Database from "better-sqlite3";
import type { CrawlJobMaintenancePort, CrawlJobView, CrawlLimits, CrawlRequest, CrawlStopReason } from "../jobs/model.ts";
import type { SourceRepository } from "../sources/model.ts";
import { isSensitiveUrl } from "../sources/policy.ts";
import type { ByteBudget, OperationContext, RetrievalArtifact, SourceScope } from "../web/contracts.ts";
import { sourceScopeKey } from "../web/contracts.ts";
import type { WebConfig } from "../web/config.ts";
import { ByteBudgetError, createDeadline } from "../web/deadline.ts";
import { discoverSite, type DiscoveryFetchResult } from "../web/discovery.ts";
import { extractDeterministic } from "../web/extract.ts";
import { pdfToText, type FetchOptions, type FetchedContent } from "../web/fetch.ts";
import { createLimiter, decodeText, mimeType, NetError, readBodyLimited, safeFetch, type Resolver, type SafeFetchOptions, type SafeFetchResult } from "../web/net.ts";
import { isRobotsAllowed, parseRobots, type RobotsDocument } from "../web/robots.ts";
import { assertRemoteForwardableUrl } from "../web/readers/policy.ts";
import { firecrawlCancelCrawl, firecrawlCrawlNext, firecrawlCrawlStatus, firecrawlStartCrawl, type FirecrawlCrawlView, type FirecrawlDocument } from "../web/providers/firecrawl.ts";
import type { ProviderTransport } from "../web/providers/http.ts";
import { crawlUrlAllowed, SqliteCrawlRepository, type CrawlClaim } from "./repository.ts";

export interface CrawlEngineOptions {
 getSources(): SourceRepository;
 getConfig(): WebConfig;
 allowRestrictedThreadCapture?: () => boolean;
 fetchPage?: (url: string, options: FetchOptions) => Promise<FetchedContent>;
 transport?: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
 providerTransport?: ProviderTransport;
 resolver?: Resolver;
 now?: () => number;
 robotsTtlMs?: number;
 pollIntervalMs?: number;
 onChanged?(scope: SourceScope): void;
}
interface RobotsEntry { expires: number; bytes: number; document: RobotsDocument | null; allow: boolean }
const network = createLimiter(4);
const origins = new Map<string, { limit: ReturnType<typeof createLimiter>; users: number }>();

export class CrawlEngine implements CrawlJobMaintenancePort {
 readonly repository: SqliteCrawlRepository;
 private readonly controllers = new Map<string, AbortController>();
 private readonly tasks = new Map<Promise<void>, string>();
 private readonly robotsCache = new Map<string, RobotsEntry>();
 private readonly cancellations = new Map<string, Promise<void>>();
 private readonly now: () => number;
 private disposed = false;
 private runner = false;
 private notify: (() => void) | null = null;
 private disposePromise: Promise<void> | null = null;
 constructor(private readonly db: Database.Database, private readonly options: CrawlEngineOptions) {
  this.now = options.now ?? Date.now;
  this.repository = new SqliteCrawlRepository(db, { now: this.now, onInvalidate: id => { this.controllers.get(id)?.abort(new Error("Crawl generation invalidated")); } });
 }
 private check(): void { if (this.disposed || !this.db.open) throw new Error("Crawl service is disposed"); }
 private config(backend: CrawlRequest["backend"]): WebConfig {
  const config = this.options.getConfig();
  if (!config.allowedBackends.includes(backend) || (backend === "firecrawl" && (config.privacyProfile === "private" || config.profile === "private"))) throw new Error("Crawl backend is blocked by current provider policy");
  if (backend === "firecrawl" && !config.firecrawlApiKey) throw new Error("Firecrawl is not configured");
  return { ...config, userAgent: "ForageBot", maxResponseBytes: Math.min(config.maxResponseBytes, 8 * 1024 * 1024) };
 }
 create(request: CrawlRequest): CrawlJobView { this.check(); this.config(request.backend); if (request.backend === "firecrawl" && request.includeSubdomains) throw new Error("UNSUPPORTED_BACKEND_OPTION: Firecrawl includeSubdomains cannot be safely configured by this adapter; no request was sent."); const job = this.repository.create(request); this.options.onChanged?.(job.scope); this.wake(); return job; }
 status(scope: SourceScope, id: string): CrawlJobView | null { this.check(); return this.repository.status(scope, id); }
 list(input: { scope: SourceScope; cursor?: string; limit: number }) { this.check(); return this.repository.list(input); }
 cancel(scope: SourceScope, id: string): CrawlJobView { this.check(); const view = this.repository.cancel(scope, id); this.options.onChanged?.(scope); this.wake(); return view; }
 resume(scope: SourceScope, id: string, limits?: Partial<CrawlLimits>): CrawlJobView { this.check(); const job = this.repository.status(scope, id); if (!job) throw new Error("Crawl job not visible"); this.config(job.backend); const view = this.repository.resume(scope, id, limits); this.options.onChanged?.(scope); this.wake(); return view; }
 async cancelScope(scope: SourceScope): Promise<number> { const n = this.invalidateScope(scope); await this.settleScope(scope); return n; }
 protectedSnapshotIds(): ReadonlySet<string> { return this.db.open ? this.repository.protectedSnapshotIds() : new Set(); }
 invalidateScope(scope: SourceScope): number { if (!this.db.open) return 0; const n = this.repository.invalidateScope(scope); this.wake(); return n; }
 beforeSnapshotsDeleted(ids: readonly string[]): void { if (this.db.open) this.repository.beforeSnapshotsDeleted(ids); }
 async deleteScope(scope: SourceScope): Promise<number> { this.invalidateScope(scope); await this.settleScope(scope); return this.db.open ? this.repository.deleteScope(scope) : 0; }
 async pruneJobs(input?: { completedBefore?: number; failedBefore?: number }): Promise<number> { await this.cleanupRemote(); return this.db.open ? this.repository.pruneJobs(input) : 0; }
 private async settleScope(scope: SourceScope): Promise<void> {
  await Promise.allSettled([...this.tasks].filter(([, id]) => this.repository.status(scope, id)).map(([task]) => task));
  for (const remote of this.repository.pendingRemote()) {
   if (this.repository.status(scope, remote.job_id)) await this.cancelRemote(remote.id);
  }
 }
 scopes(): AsyncIterable<SourceScope> { return this.repository.scopes(); }
 revoke(): SourceScope[] { const scopes = this.repository.activeScopes(); for (const scope of scopes) this.invalidateScope(scope); return scopes; }
 wake(): void { this.notify?.(); }
 async run(signal: AbortSignal): Promise<void> {
  this.check(); if (this.runner) throw new Error("Crawl runner is already active"); this.runner = true;
  const abort = () => { for (const controller of this.controllers.values()) controller.abort(signal.reason); this.wake(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
   await this.cleanupRemote();
   while (!signal.aborted && !this.disposed && this.db.open) {
    await this.runOnce(signal);
    if (this.repository.queued().length) continue;
    await new Promise<void>(resolve => {
     const timer = setTimeout(done, 250); const self = this;
     function done() { clearTimeout(timer); self.notify = null; resolve(); }
     this.notify = done;
     if (signal.aborted || this.disposed) done();
    });
   }
  } finally {
   abort(); await Promise.allSettled([...this.tasks.keys()]);
   signal.removeEventListener("abort", abort); this.runner = false;
  }
 }
 async runOnce(signal?: AbortSignal): Promise<void> {
  this.check(); if (signal?.aborted) return;
  await this.cleanupRemote();
  const started: Promise<void>[] = [];
  for (const queued of this.repository.queued()) {
   const job = this.repository.start(queued.id); if (!job) continue;
   this.options.onChanged?.(job.scope);
   const task = this.execute(job, signal).finally(() => this.tasks.delete(task));
   this.tasks.set(task, job.id); started.push(task);
  }
  await Promise.all(started);
 }
 private async request<T>(url: string, context: OperationContext, work: () => Promise<T>): Promise<T> {
  context.deadline.throwIfExpired("crawl queue");
  const key = new URL(url).origin;
  let entry = origins.get(key);
  if (!entry) { entry = { limit: createLimiter(2), users: 0 }; origins.set(key, entry); }
  entry.users++;
  try { return await network(() => entry!.limit(work, { signal: context.deadline.signal, deadline: context.deadline }), { signal: context.deadline.signal, deadline: context.deadline }); }
  finally { if (--entry.users === 0) origins.delete(key); }
 }
 private async raw(url: string, context: OperationContext, maxBytes: number, guardRedirects = false, nested = false): Promise<DiscoveryFetchResult> {
  const config = this.config("local");
  const deadline = createDeadline(Math.min(config.timeoutMs, context.deadline.remainingMs()), context.deadline.signal);
  const operation = { ...context, deadline };
  const work = async () => {
   const response = await (this.options.transport ?? safeFetch)(url, { signal: deadline.signal, deadline, byteBudget: context.byteBudget,
    timeoutMs: config.timeoutMs, maxBytes, maxRedirects: 5, headers: { "User-Agent": "ForageBot" }, allowPrivateNetwork: config.allowPrivateNetwork,
    resolver: this.options.resolver, allowedRedirectOrigins: [new URL(url).origin], beforeRedirect: guardRedirects ? async ({ toUrl }) => { if (!await this.robots(toUrl, operation, true)) throw new NetError("Redirect blocked by robots policy", "blocked"); } : undefined, requestScopeKey: context.scope ? sourceScopeKey(context.scope) : null });
   const bytes = await readBodyLimited(response.response, maxBytes, deadline.signal, context.byteBudget);
   return { requestedUrl: url, finalUrl: response.finalUrl, status: response.response.status, contentType: response.response.headers.get("content-type") ?? "text/plain", content: new TextDecoder().decode(bytes), bytes: bytes.byteLength + response.acceptedRedirectBytes };
  };
  try { return await (nested ? work() : this.request(url, operation, work)); } catch (error) {
   if (error instanceof NetError && error.kind === "budget") throw new ByteBudgetError("Crawl discovery reservation exhausted");
   throw error;
  } finally { deadline.dispose(); }
 }
 private async robots(url: string, context: OperationContext, nested = false): Promise<boolean> {
  const origin = new URL(url).origin; const cached = this.robotsCache.get(origin);
  let entry: RobotsEntry;
  if (cached && cached.expires > this.now()) { context.byteBudget?.consume(cached.bytes); entry = cached; }
  else {
   const before = context.byteBudget?.remaining() ?? 0;
   try {
    const response = await this.raw(`${origin}/robots.txt`, context, 512 * 1024, false, nested);
    const doc = response.status >= 200 && response.status < 300 ? parseRobots(response.content, response.finalUrl) : null;
    entry = { expires: this.now() + Math.min(300000, this.options.robotsTtlMs ?? 300000), bytes: before - (context.byteBudget?.remaining() ?? 0), document: doc,
     allow: response.status >= 400 && response.status < 500 };
    if (doc?.truncated) entry.document = null;
   } catch (error) {
    if (error instanceof ByteBudgetError || context.deadline.signal.aborted) throw error;
    entry = { expires: this.now() + Math.min(30000, this.options.robotsTtlMs ?? 300000), bytes: before - (context.byteBudget?.remaining() ?? 0), document: null, allow: false };
   }
   this.robotsCache.delete(origin); this.robotsCache.set(origin, entry);
   while (this.robotsCache.size > 128) this.robotsCache.delete(this.robotsCache.keys().next().value!);
  }
  return entry.document ? isRobotsAllowed(entry.document, url, "ForageBot") : entry.allow;
 }
 private async execute(job: CrawlJobView, parent?: AbortSignal): Promise<void> {
  const controller = new AbortController(); this.controllers.set(job.id, controller);
  const abort = () => controller.abort(parent?.reason); parent?.addEventListener("abort", abort, { once: true });
  const deadline = createDeadline(Math.max(0, job.limits.maxDurationMs - job.activeDurationMs), controller.signal);
  const heartbeat = setInterval(() => { if (this.db.open) this.repository.heartbeat(job.id, job.generation); }, 100); heartbeat.unref?.();
  try {
   if (parent?.aborted) abort();
   if (job.backend === "firecrawl") await this.managed(job, { scope: job.scope, deadline });
   else await this.local(job, { scope: job.scope, deadline });
  } catch (error) {
   if (this.db.open && this.repository.current(job.id, job.generation)) {
    if (controller.signal.aborted) this.repository.pause(job.id);
    else this.repository.finish(job.id, job.generation, deadline.remainingMs() === 0 ? "time-limit" : error instanceof ByteBudgetError || (error instanceof NetError && ["budget", "too-large"].includes(error.kind)) ? "byte-limit" : "error", "Crawl request failed");
   }
  } finally {
   clearInterval(heartbeat); deadline.dispose(); parent?.removeEventListener("abort", abort);
   if (this.controllers.get(job.id) === controller) this.controllers.delete(job.id);
   if (this.db.open) {
    if (this.repository.current(job.id, job.generation)) this.repository.pause(job.id);
    for (const remote of this.repository.pendingRemote(job.id).filter(remote => remote.generation === job.generation)) await this.cancelRemote(remote.id);
    this.options.onChanged?.(job.scope);
   }
  }
 }
 private async local(job: CrawlJobView, context: OperationContext): Promise<void> {
  if (!this.repository.discovered(job.id)) {
   const reservation = this.repository.reserve(job.id, job.generation, Math.min(2 * 1024 * 1024, Math.floor(this.repository.available(job.id) / 4)));
   if (reservation) {
    const discoveryContext = { ...context, byteBudget: reservation.budget };
    try {
     const result = await discoverSite({ rootUrl: job.rootUrl, includePaths: job.includePaths, excludePaths: job.excludePaths, includeSubdomains: job.includeSubdomains,
      maxUrls: Math.min(5000, job.limits.maxPages * 10), maxDepth: 4, maxIndexDocuments: 16, maxBytes: reservation.budget.remaining(), includeRootLinks: false, signal: context.deadline.signal, operation: discoveryContext }, {
      fetch: async (url, options) => {
       if (options.purpose !== "robots" && !await this.robots(url, discoveryContext)) return { requestedUrl: url, finalUrl: url, status: 403, contentType: "text/plain", content: "", bytes: 0 };
       return this.raw(url, discoveryContext, Math.min(options.maxBytes, 512 * 1024), options.purpose !== "robots");
      },
     });
     if (!this.repository.current(job.id, job.generation)) return;
     this.repository.enqueue(job.id, job.generation, result.urls.map(u => u.url), 1);
     this.repository.markDiscovered(job.id, job.generation, result.truncated || result.warnings.length > 0);
    } finally { reservation.release(); }
   }
  }
  while (this.repository.current(job.id, job.generation)) {
   context.deadline.throwIfExpired("crawl dispatch"); this.config("local");
   const claims: CrawlClaim[] = [];
   for (let i = 0; i < job.limits.concurrency; i++) {
    const size = Math.min(this.config("local").maxResponseBytes, this.repository.available(job.id));
    const claim = this.repository.claim(job.id, job.generation, size);
    if (!claim) break;
    claims.push(claim);
   }
   if (!claims.length) {
    const current = this.repository.status(job.scope, job.id)!;
    const reason: CrawlStopReason = current.counts.queued === 0 ? "frontier-empty" : current.bytesUsed >= job.limits.maxBytes ? "byte-limit" : current.pagesUsed >= job.limits.maxPages ? "page-limit" : "frontier-empty";
    this.repository.finish(job.id, job.generation, reason); return;
   }
   const outcomes = await Promise.all(claims.map(claim => this.page(job, claim, context)));
   if (outcomes.some(o => o === "byte-limit" || o === "storage-limit")) { this.repository.finish(job.id, job.generation, outcomes.includes("storage-limit") ? "storage-limit" : "byte-limit"); return; }
   await yieldTurn();
  }
 }
 private async fetchLocalPage(url: string, options: FetchOptions): Promise<FetchedContent> {
  const startedAt = this.now(); const config = options.config;
  const result = await (this.options.transport ?? safeFetch)(url, { timeoutMs: config.timeoutMs, maxBytes: config.maxResponseBytes,
   signal: options.signal, deadline: options.deadline, byteBudget: options.byteBudget, headers: { "User-Agent": "ForageBot" }, maxRedirects: 5,
   allowPrivateNetwork: config.allowPrivateNetwork, resolver: this.options.resolver, requestScopeKey: options.requestScopeKey, allowedRedirectOrigins: options.allowedRedirectOrigins, beforeRedirect: options.beforeRedirect });
  const body = await readBodyLimited(result.response, config.maxResponseBytes, options.signal, options.byteBudget);
  options.deadline?.throwIfExpired("crawl extraction");
  const contentType = mimeType(result.response.headers.get("content-type"));
  const isPdf = contentType === "application/pdf" || (body[0] === 37 && body[1] === 80 && body[2] === 68 && body[3] === 70);
  if (!isPdf && contentType && !contentType.startsWith("text/") && !/json|xml|javascript|yaml|toml|csv/.test(contentType)) throw new Error("Unsupported crawl document type");
  const text = isPdf ? await pdfToText(body, options.signal, Math.min(30000, options.deadline?.remainingMs() ?? 30000), 8 * 1024 * 1024) : decodeText(body, result.response.headers.get("content-type"));
  const extracted = extractDeterministic({ finalUrl: result.finalUrl, contentType: isPdf ? "text/plain" : contentType || "text/plain", body: text });
  options.deadline?.throwIfExpired("crawl extraction");
  const bytes = body.byteLength + result.acceptedRedirectBytes; const finishedAt = this.now();
  const artifact: RetrievalArtifact = { schemaVersion: 1, requestedUrl: url, resolvedUrl: url, finalUrl: result.finalUrl, transport: "direct", representation: "readable",
   kind: isPdf ? "pdf" : extracted.kind, status: result.response.status, contentType: contentType || "text/plain", bytes, fetchedAt: new Date(finishedAt).toISOString(),
   title: extracted.structured.title, content: extracted.content, contentHash: createHash("sha256").update(extracted.content).digest("hex"), structured: extracted.structured,
   extraction: { id: extracted.extractorVersion }, access: result.access,
   completeness: { state: extracted.truncated ? "partial" : "complete", parts: [{ name: "body", state: "complete", fetched: body.byteLength }] }, warnings: extracted.warnings,
   diagnostics: { durationMs: finishedAt - startedAt, redirects: result.redirects, stageMs: {} } };
  return { url, finalUrl: result.finalUrl, title: artifact.title, content: artifact.content, kind: artifact.kind, contentType: artifact.contentType, status: artifact.status,
   bytes, durationMs: finishedAt - startedAt, redirects: result.redirects, cached: false, artifact,
   attempt: { startedAt, finishedAt, httpStatus: artifact.status, transferredBytes: bytes, cache: "miss" } };
 }
 private async page(job: CrawlJobView, claim: CrawlClaim, parent: OperationContext): Promise<CrawlStopReason> {
  const config = this.config("local"); const deadline = createDeadline(Math.min(config.timeoutMs, parent.deadline.remainingMs()), parent.deadline.signal);
  const context: OperationContext = { scope: job.scope, deadline, byteBudget: this.repository.budget(claim) };
  try {
   if (!await this.robots(claim.url, context)) { this.repository.skip(claim); return null; }
   const result = await this.request(claim.url, context, () => (this.options.fetchPage ?? this.fetchLocalPage.bind(this))(claim.url, { mode: "readable", resolve: "direct", config,
    signal: deadline.signal, deadline, operation: context, byteBudget: context.byteBudget, requestScopeKey: sourceScopeKey(job.scope), allowedRedirectOrigins: [new URL(claim.url).origin], beforeRedirect: async ({ toUrl }) => {
     if (!crawlUrlAllowed(job, toUrl)) throw new NetError("Redirect outside crawl path scope", "blocked");
     if (!await this.robots(toUrl, context, true)) throw new NetError("Redirect blocked by robots policy", "blocked");
    } }));
   deadline.throwIfExpired("crawl capture");
   if (!this.repository.valid(claim)) return null;
   if (result.error || result.status < 200 || result.status >= 300 || !result.artifact || !result.attempt) {
    const exhausted = result.errorCode === "budget" || result.errorCode === "too-large";
    this.repository.fail(claim, exhausted ? "BYTE_LIMIT" : "FETCH_FAILED", !exhausted); return exhausted ? "byte-limit" : null;
   }
   if (!result.artifact.structured) {
    const extracted = extractDeterministic({ finalUrl: result.artifact.finalUrl, contentType: result.artifact.kind === "json" ? "application/json" : "text/markdown", body: result.artifact.content });
    result.artifact = { ...result.artifact, structured: extracted.structured, warnings: [...result.artifact.warnings, ...extracted.warnings] };
    if (extracted.truncated) this.repository.markDiscovered(job.id, job.generation, true);
   }
   if (!crawlUrlAllowed(job, result.artifact.finalUrl)) { this.repository.fail(claim, "REDIRECT_OUTSIDE_SCOPE", false); return null; }
   if (result.artifact.finalUrl !== claim.url && !await this.robots(result.artifact.finalUrl, context)) { this.repository.skip(claim); return null; }
   this.repository.capture(claim, () => this.options.getSources().recordRetrieval({ scope: job.scope, origin: "crawl", artifact: result.artifact!, attempt: result.attempt!, allowRestrictedThreadCapture: this.options.allowRestrictedThreadCapture?.() === true }));
   if (!this.repository.current(job.id, job.generation)) return null;
   const state = this.repository.status(job.scope, job.id)!;
   if (state.stopReason === "storage-limit") return "storage-limit";
   this.repository.enqueue(job.id, job.generation, (result.artifact.structured?.links ?? []).filter(l => l.relation === "content").map(l => l.url), claim.depth + 1);
   return null;
  } catch (error) {
   if (!this.db.open) return null;
   const exhausted = error instanceof ByteBudgetError || (error instanceof NetError && ["budget", "too-large"].includes(error.kind));
   this.repository.fail(claim, exhausted ? "BYTE_LIMIT" : "FETCH_FAILED", !exhausted && !deadline.signal.aborted);
   return exhausted ? "byte-limit" : null;
  } finally { deadline.dispose(); if (this.db.open) this.options.onChanged?.(job.scope); }
 }
 private async vendorRequest<T>(job: CrawlJobView, context: OperationContext, work: (context: OperationContext, config: WebConfig) => Promise<T>): Promise<T> {
  const reservation = this.repository.reserve(job.id, job.generation, Math.min(8 * 1024 * 1024, this.repository.available(job.id)));
  if (!reservation) throw new ByteBudgetError("Crawl budget exhausted");
  const deadline = createDeadline(Math.min(this.config("firecrawl").timeoutMs, context.deadline.remainingMs()), context.deadline.signal);
  const op = { ...context, deadline, byteBudget: reservation.budget };
  try { return await this.request("https://api.firecrawl.dev", op, () => work(op, this.config("firecrawl"))); }
  finally { deadline.dispose(); reservation.release(); }
 }
 private async managed(job: CrawlJobView, context: OperationContext): Promise<void> {
  let remoteId: string | null = null;
  let dispatched = false;
  const startTransport: ProviderTransport = (url, options) => {
   this.repository.markRemoteStartPending(job.id, job.generation); dispatched = true;
   return this.options.providerTransport ? this.options.providerTransport(url, options) : safeFetch(url, options as SafeFetchOptions);
  };
  try {
   this.repository.reserveControl(job.id, job.generation);
   let view = await this.vendorRequest(job, context, (op, config) => firecrawlStartCrawl({ url: job.rootUrl, includePaths: job.includePaths, excludePaths: job.excludePaths, limit: job.limits.maxPages,
    maxDepth: job.limits.maxDepth, context: op, config, resolver: this.options.resolver, transport: startTransport }));
   remoteId = view.id;
   if (!this.db.open) return;
   this.repository.trackRemote(job.id, job.generation, remoteId);
   while (this.repository.current(job.id, job.generation)) {
    context.deadline.throwIfExpired("managed crawl");
    const done = ["completed", "failed", "cancelled"].includes(view.status);
    this.repository.setVendor(job.id, job.generation, remoteId, view.next ?? null, done && !view.next);
    await this.vendorPages(job, view, context);
    if (!this.repository.current(job.id, job.generation)) break;
    if (view.next) view = await this.vendorRequest(job, context, (op, config) => firecrawlCrawlNext(view.next!, op, config, this.options.providerTransport));
    else if (done) {
     this.repository.remoteDone(remoteId);
     const current = this.repository.status(job.scope, job.id)!;
     const omitted = view.total > current.pagesUsed || view.completed > current.counts.saved + current.counts.failed;
     if (omitted) this.repository.markDiscovered(job.id, job.generation, true);
     this.repository.finish(job.id, job.generation, view.status === "completed" && !omitted ? "frontier-empty" : "error", omitted ? "Managed provider omitted page results" : view.status === "completed" ? null : "Managed crawl did not complete"); return;
    } else {
     await delay(this.options.pollIntervalMs ?? 1000, undefined, { signal: context.deadline.signal });
     view = await this.vendorRequest(job, context, (op, config) => firecrawlCrawlStatus(remoteId!, op, config, this.options.providerTransport));
    }
   }
  } catch (error) {
   if (dispatched && !remoteId && this.db.open) this.repository.markRemoteStartUnknown(job.id);
   throw error;
  } finally {
   if (remoteId && this.db.open && this.repository.pendingRemote(job.id).some(r => r.id === remoteId)) await this.cancelRemote(remoteId);
   if (this.db.open) this.repository.releaseControl(job.id, job.generation);
  }
 }
 private async vendorPages(job: CrawlJobView, view: FirecrawlCrawlView, context: OperationContext): Promise<void> {
  for (const page of view.pages) {
   context.deadline.throwIfExpired("managed page");
   if (!this.repository.current(job.id, job.generation)) return;
   if (!crawlUrlAllowed(job, page.finalUrl)) { this.repository.markDiscovered(job.id, job.generation, true); continue; }
   await assertRemoteForwardableUrl(page.finalUrl, { resolver: this.options.resolver, signal: context.deadline.signal, deadline: context.deadline });
   this.repository.enqueue(job.id, job.generation, [page.finalUrl], 0);
   const claim = this.repository.claim(job.id, job.generation, 1, page.finalUrl);
   if (!claim) {
    const current = this.repository.status(job.scope, job.id)!;
    if (current.pagesUsed >= job.limits.maxPages && current.counts.queued > 0) { this.repository.finish(job.id, job.generation, "page-limit"); return; }
    continue;
   }
   if (page.statusCode >= 400) { this.repository.fail(claim, "VENDOR_PAGE_FAILED", false); continue; }
   const artifact = this.vendorArtifact(page);
   const now = this.now();
   this.repository.capture(claim, () => this.options.getSources().recordRetrieval({ scope: job.scope, origin: "crawl", artifact, attempt: { startedAt: now, finishedAt: now, httpStatus: page.statusCode, transferredBytes: 0, cache: "miss" } }));
   if (this.repository.status(job.scope, job.id)?.stopReason === "storage-limit") { this.repository.finish(job.id, job.generation, "storage-limit"); return; }
   this.options.onChanged?.(job.scope);
   await yieldTurn();
  }
 }
 private vendorArtifact(page: FirecrawlDocument): RetrievalArtifact {
  if (isSensitiveUrl(page.finalUrl)) throw new Error("Remote page rejected by capture policy");
  const extracted = extractDeterministic({ finalUrl: page.finalUrl, contentType: "text/markdown", body: page.markdown });
  return { schemaVersion: 1, requestedUrl: page.finalUrl, resolvedUrl: page.finalUrl, finalUrl: page.finalUrl, transport: "provider", representation: "readable", kind: "markdown", status: page.statusCode,
   contentType: "text/markdown", bytes: Buffer.byteLength(page.markdown), fetchedAt: new Date(this.now()).toISOString(), title: page.title, content: extracted.content,
   contentHash: createHash("sha256").update(extracted.content).digest("hex"), structured: extracted.structured, extraction: { id: extracted.extractorVersion },
   access: { network: "public", credentialed: false, requestScopeKey: null }, completeness: { state: "unknown", parts: [] },
   warnings: [...extracted.warnings, { code: "MANAGED_CRAWL", stage: "crawl", message: "Explicit Firecrawl backend; local robots enforcement and vendor-side redirect DNS pinning are unavailable. Vendor requests may continue until cancellation is acknowledged." }],
   diagnostics: { durationMs: 0, redirects: 0, stageMs: {} } };
 }
 private cancelRemote(id: string): Promise<void> {
  const existing = this.cancellations.get(id); if (existing) return existing;
  const task = this.performCancellation(id).finally(() => this.cancellations.delete(id));
  this.cancellations.set(id, task); return task;
 }
 private async performCancellation(id: string): Promise<void> {
  const deadline = createDeadline(5000); const context = { deadline, byteBudget: this.repository.cleanupBudget(id) };
  try {
   await this.request("https://api.firecrawl.dev", context, () => firecrawlCancelCrawl(id, context, this.options.getConfig(), this.options.providerTransport));
   if (this.db.open) this.repository.remoteDone(id);
  } finally { deadline.dispose(); }
 }
 private async cleanupRemote(): Promise<void> {
  if (!this.db.open) return;
  for (const remote of this.repository.pendingRemote()) {
   if (!this.repository.current(remote.job_id, remote.generation)) await this.cancelRemote(remote.id);
  }
 }
 dispose(): Promise<void> {
  if (this.disposePromise) return this.disposePromise;
  this.disposed = true; for (const controller of this.controllers.values()) controller.abort(new Error("Crawl disposed")); this.wake();
  this.disposePromise = (async () => { await Promise.allSettled([...this.tasks.keys()]); if (this.db.open) await this.cleanupRemote(); this.robotsCache.clear(); })();
  return this.disposePromise;
 }
}

export function createCrawlService(db: Database.Database, options: CrawlEngineOptions): CrawlEngine { return new CrawlEngine(db, options); }
