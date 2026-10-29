import { randomUUID } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type Database from "better-sqlite3";
import type { CrawlJobView, CrawlLimits, CrawlRequest, CrawlStopReason, JobMaintenancePort } from "../jobs/model.ts";
import type { RetrievalReceipt } from "../sources/model.ts";
import { isSensitiveUrl } from "../sources/policy.ts";
import { sourceScopeKey, type ByteBudget, type SourceScope } from "../web/contracts.ts";
import { ByteBudgetError } from "../web/deadline.ts";
import { canonicalUrlKey } from "../web/url.ts";

export const CRAWL_DEFAULT_LIMITS: Readonly<CrawlLimits> = { maxPages: 25, maxDepth: 2, maxBytes: 20 * 1024 * 1024, maxDurationMs: 300000, concurrency: 2 };
export const CRAWL_HARD_LIMITS: Readonly<CrawlLimits> = { maxPages: 200, maxDepth: 5, maxBytes: 100 * 1024 * 1024, maxDurationMs: 1800000, concurrency: 4 };
const ACTIVE = "('queued','running','paused','cancelling')";
const TERMINAL = "('completed','partial','failed','cancelled')";
const MAX_METADATA = 32 * 1024 * 1024;
interface JobRow {
 id: string; scope_key: string; request_json: string; state: CrawlJobView["state"]; generation: number;
 pages_used: number; bytes_used: number; reserved: number; duration_ms: number; active_since: number | null;
 created_at: number; started_at: number | null; updated_at: number; finished_at: number | null;
 stop_reason: CrawlStopReason; error: string | null; omitted: number; discovered: number;
 vendor_id: string | null; vendor_next: string | null; vendor_done: number; vendor_pending_cancel: number; control_reserved: number;
}
export interface CrawlPage {
 id: number; job_id: string; url: string; depth: number; state: string; attempts: number;
 claim_token: string | null; generation: number | null; reserved: number; error: string | null;
 source_id: string | null; snapshot_id: string | null; retrieval_id: string | null;
}
export interface CrawlClaim { id: number; jobId: string; generation: number; token: string; url: string; depth: number; capacity: number }
export interface CrawlRepositoryOptions { now?: () => number; onInvalidate?: (jobId: string) => void }

export function crawlLimits(input: Partial<CrawlLimits> = {}): CrawlLimits {
 const result = { ...CRAWL_DEFAULT_LIMITS, ...input };
 for (const key of Object.keys(result) as Array<keyof CrawlLimits>) {
  const min = key === "maxDepth" ? 0 : key === "maxDurationMs" ? 1000 : 1;
  if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > CRAWL_HARD_LIMITS[key]) throw new Error(`Invalid crawl limit: ${key}`);
 }
 return result;
}
function safeUrl(input: string): string {
 if (input.length > 8192 || isSensitiveUrl(input)) throw new Error("Crawl URL rejected by capture policy");
 const url = new URL(input); if (!["https:", "http:"].includes(url.protocol)) throw new Error("Crawl requires HTTP(S)");
 return canonicalUrlKey(url.href);
}
export function crawlUrlAllowed(request: CrawlRequest, input: string): boolean {
 try {
  safeUrl(input); const root = new URL(request.rootUrl); const url = new URL(input);
  return url.protocol === root.protocol && url.port === root.port && (url.hostname === root.hostname || (request.includeSubdomains && url.hostname.endsWith(`.${root.hostname}`)))
   && (!request.includePaths.length || request.includePaths.some(p => url.pathname.startsWith(p))) && !request.excludePaths.some(p => url.pathname.startsWith(p));
 } catch { return false; }
}

const UNKNOWN_REMOTE_START = "REMOTE_START_UNKNOWN: The provider may have accepted the start request, but no job ID was acknowledged. Cancellation cannot be confirmed. Inspect the provider account; this job cannot be resumed safely.";

export class SqliteCrawlRepository implements JobMaintenancePort {
 private readonly now: () => number;
 private readonly onInvalidate: (id: string) => void;
 constructor(readonly db: Database.Database, options: CrawlRepositoryOptions = {}) {
  this.now = options.now ?? Date.now; this.onInvalidate = options.onInvalidate ?? (() => {});
  this.db.transaction(() => {
   this.db.prepare(`UPDATE forage_crawl_jobs SET duration_ms = duration_ms + MAX(0, updated_at - active_since), active_since = NULL WHERE active_since IS NOT NULL`).run();
   this.db.prepare(`UPDATE forage_crawl_jobs SET state = CASE WHEN state = 'cancelling' THEN 'cancelled' ELSE 'paused' END, generation = generation + 1, reserved = 0, finished_at = CASE WHEN state = 'cancelling' THEN updated_at ELSE finished_at END, stop_reason = CASE WHEN state = 'cancelling' THEN 'cancelled' ELSE stop_reason END WHERE state IN ('running','cancelling')`).run();
   this.db.prepare(`UPDATE forage_crawl_pages SET state = CASE WHEN attempts < 2 THEN 'queued' ELSE 'failed' END, claim_token = NULL, reserved = 0 WHERE state = 'fetching'`).run();
   this.db.prepare("DELETE FROM forage_crawl_reservations").run();
   this.db.prepare("UPDATE forage_crawl_jobs SET state = 'failed', generation = generation + 1, reserved = 0, stop_reason = 'error', error = ?, finished_at = updated_at WHERE error = 'REMOTE_START_PENDING'").run(UNKNOWN_REMOTE_START);
  })();
  this.trimSync();
 }
 private row(id: string): JobRow | undefined { return this.db.prepare("SELECT * FROM forage_crawl_jobs WHERE id = ?").get(id) as JobRow | undefined; }
 private view(row: JobRow): CrawlJobView {
  const request = JSON.parse(row.request_json) as CrawlRequest;
  const counts = { queued: 0, fetching: 0, saved: 0, failed: 0, skipped: 0 };
  for (const r of this.db.prepare("SELECT state, COUNT(*) AS n FROM forage_crawl_pages WHERE job_id = ? GROUP BY state").all(row.id) as Array<{ state: string; n: number }>) {
   if (r.state === "evicted") counts.failed += r.n;
   else if (r.state in counts) counts[r.state as keyof typeof counts] = r.n;
  }
  return { ...request, id: row.id, state: row.state, counts, pagesUsed: row.pages_used, bytesUsed: row.bytes_used,
   activeDurationMs: row.duration_ms + (row.active_since === null ? 0 : Math.max(0, this.now() - row.active_since)), generation: row.generation,
   createdAt: row.created_at, startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at, stopReason: row.stop_reason, error: [row.error, row.omitted ? `Omitted ${row.omitted} frontier URL(s) or discovery result(s) due to limits` : null].filter(Boolean).join("; ") || null };
 }
 status(scope: SourceScope, id: string): CrawlJobView | null { const row = this.row(id); return row?.scope_key === sourceScopeKey(scope) ? this.view(row) : null; }
 private require(scope: SourceScope, id: string): CrawlJobView { const job = this.status(scope, id); if (!job) throw new Error("Crawl job not visible"); return job; }
 list(input: { scope: SourceScope; cursor?: string; limit: number }): { jobs: CrawlJobView[]; nextCursor: string | null } {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("Invalid job page limit");
  let at = Number.MAX_SAFE_INTEGER, id = "\uffff";
  if (input.cursor) { const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); if (!Number.isSafeInteger(cursor[0]) || typeof cursor[1] !== "string") throw new Error("Invalid job cursor"); [at, id] = cursor; }
  const rows = this.db.prepare("SELECT * FROM forage_crawl_jobs WHERE scope_key = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?").all(sourceScopeKey(input.scope), at, at, id, input.limit + 1) as JobRow[];
  const more = rows.length > input.limit; const page = rows.slice(0, input.limit); const last = page.at(-1);
  return { jobs: page.map(r => this.view(r)), nextCursor: more && last ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString("base64url") : null };
 }
 create(input: CrawlRequest): CrawlJobView {
  const request: CrawlRequest = { scope: input.scope, rootUrl: safeUrl(input.rootUrl), limits: crawlLimits(input.limits), includePaths: input.includePaths, excludePaths: input.excludePaths, includeSubdomains: input.includeSubdomains, backend: input.backend };
  if (request.scope.kind !== "thread" || [request.scope.projectId, request.scope.threadId].some(id => !id || id.length > 256 || id.includes(":"))) throw new Error("Crawls require a valid thread capture scope");
  if (!["local", "firecrawl"].includes(request.backend)) throw new Error("Invalid crawl backend");
  for (const paths of [request.includePaths, request.excludePaths]) if (paths.length > 50 || paths.some(p => typeof p !== "string" || p.length > 1024 || !p.startsWith("/"))) throw new Error("Invalid path prefixes");
  if (JSON.stringify(request).length > 128 * 1024) throw new Error("Crawl request too large");
  if (this.db.prepare("SELECT 1 FROM forage_scope_deletions WHERE scope_key = ?").get(sourceScopeKey(request.scope))) throw new Error("Scope is being deleted");
  return this.db.transaction(() => {
   this.trimSync();
   const queued = this.db.prepare("SELECT COUNT(*) AS n FROM forage_crawl_jobs WHERE state = 'queued'").get() as { n: number };
   if (queued.n >= 20) throw new Error("Crawl queue limit reached");
   if (this.metadataBytes() + 256 * 1024 > MAX_METADATA) throw new Error("Crawl metadata limit reached");
   const id = `crawl_${randomUUID()}`; const now = this.now();
   this.db.prepare("INSERT INTO forage_crawl_jobs(id, scope_key, request_json, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)").run(id, sourceScopeKey(request.scope), JSON.stringify(request), now, now);
   if (crawlUrlAllowed(request, request.rootUrl)) this.db.prepare("INSERT INTO forage_crawl_pages(job_id, url, depth) VALUES (?, ?, 0)").run(id, request.rootUrl);
   else this.db.prepare("UPDATE forage_crawl_jobs SET omitted = 1 WHERE id = ?").run(id);
   return this.require(request.scope, id);
  })();
 }
 queued(): CrawlJobView[] { return (this.db.prepare("SELECT * FROM forage_crawl_jobs WHERE state = 'queued' ORDER BY created_at, id LIMIT 2").all() as JobRow[]).map(r => this.view(r)); }
 start(id: string): CrawlJobView | null {
  return this.db.transaction(() => {
   const count = this.db.prepare("SELECT COUNT(*) AS n FROM forage_crawl_jobs WHERE state = 'running'").get() as { n: number };
   if (count.n >= 2) return null;
   const now = this.now(); const changed = this.db.prepare("UPDATE forage_crawl_jobs SET state = 'running', generation = generation + 1, active_since = ?, started_at = COALESCE(started_at, ?), updated_at = ?, finished_at = NULL WHERE id = ? AND state = 'queued'").run(now, now, now, id).changes;
   return changed ? this.view(this.row(id)!) : null;
  })();
 }
 current(id: string, generation: number): boolean { if (!this.db.open) return false; const row = this.row(id); return row?.state === "running" && row.generation === generation; }
 heartbeat(id: string, generation: number): void { this.db.prepare("UPDATE forage_crawl_jobs SET updated_at = ? WHERE id = ? AND generation = ? AND state = 'running'").run(this.now(), id, generation); }
 available(id: string): number { const row = this.row(id); if (!row) return 0; return (JSON.parse(row.request_json) as CrawlRequest).limits.maxBytes - row.bytes_used - row.reserved - row.control_reserved; }
 enqueue(id: string, generation: number, urls: readonly string[], depth: number): number {
  return this.db.transaction(() => {
   if (!this.current(id, generation)) return 0;
   const row = this.row(id)!; const request = JSON.parse(row.request_json) as CrawlRequest;
   let count = (this.db.prepare("SELECT COUNT(*) AS n FROM forage_crawl_pages WHERE job_id = ?").get(id) as { n: number }).n;
   const cap = Math.min(5000, request.limits.maxPages * 10); let omitted = 0;
   const insert = this.db.prepare("INSERT OR IGNORE INTO forage_crawl_pages(job_id, url, depth) VALUES (?, ?, ?)");
   const exists = this.db.prepare("SELECT 1 FROM forage_crawl_pages WHERE job_id = ? AND url = ?");
   let metadata = this.metadataBytes();
   for (const input of urls) {
    if (!crawlUrlAllowed(request, input)) continue;
    const url = safeUrl(input); if (exists.get(id, url)) continue;
    const size = Buffer.byteLength(url) + 512;
    if (depth > request.limits.maxDepth || count >= cap || metadata + size > MAX_METADATA) { omitted++; continue; }
    count += insert.run(id, url, depth).changes; metadata += size;
   }
   if (omitted) this.db.prepare("UPDATE forage_crawl_jobs SET omitted = omitted + ? WHERE id = ?").run(omitted, id);
   return omitted;
  })();
 }
 claim(id: string, generation: number, bytes: number, specificUrl?: string): CrawlClaim | null {
  return this.db.transaction(() => {
   if (!Number.isSafeInteger(bytes) || bytes < 1 || !this.current(id, generation) || bytes > this.available(id)) return null;
   const row = this.row(id)!; const limits = (JSON.parse(row.request_json) as CrawlRequest).limits;
   const page = this.db.prepare(`SELECT * FROM forage_crawl_pages WHERE job_id = ? AND state = 'queued' AND attempts < 2 AND (attempts > 0 OR ? < ?) ${specificUrl ? "AND url = ?" : ""} ORDER BY depth, id LIMIT 1`).get(...[id, row.pages_used, limits.maxPages, ...(specificUrl ? [safeUrl(specificUrl)] : [])]) as CrawlPage | undefined;
   if (!page) return null;
   const token = randomUUID();
   this.db.prepare("UPDATE forage_crawl_pages SET state = 'fetching', attempts = attempts + 1, claim_token = ?, generation = ?, reserved = ? WHERE id = ?").run(token, generation, bytes, page.id);
   this.db.prepare("UPDATE forage_crawl_jobs SET pages_used = pages_used + ?, reserved = reserved + ?, updated_at = ? WHERE id = ?").run(page.attempts === 0 ? 1 : 0, bytes, this.now(), id);
   return { id: page.id, jobId: id, generation, token, url: page.url, depth: page.depth, capacity: bytes };
  })();
 }
 valid(claim: CrawlClaim): boolean {
  return this.current(claim.jobId, claim.generation) && !!this.db.prepare("SELECT 1 FROM forage_crawl_pages WHERE id = ? AND job_id = ? AND state = 'fetching' AND claim_token = ? AND generation = ?").get(claim.id, claim.jobId, claim.token, claim.generation);
 }
 reserve(id: string, generation: number, bytes: number): { budget: ByteBudget; release(): void } | null {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !this.current(id, generation) || bytes > this.available(id)) return null;
  const token = randomUUID();
  this.db.transaction(() => {
   this.db.prepare("INSERT INTO forage_crawl_reservations(token, job_id, generation, reserved) VALUES (?, ?, ?, ?)").run(token, id, generation, bytes);
   this.db.prepare("UPDATE forage_crawl_jobs SET reserved = reserved + ? WHERE id = ?").run(bytes, id);
  })();
  const remaining = () => this.current(id, generation) ? (this.db.prepare("SELECT reserved FROM forage_crawl_reservations WHERE token = ?").get(token) as { reserved: number } | undefined)?.reserved ?? 0 : 0;
  return { budget: { remaining, consume: bytes => this.db.transaction(() => {
   if (!Number.isSafeInteger(bytes) || bytes < 0 || !this.current(id, generation)) throw new Error("Stale crawl reservation");
   if (bytes > remaining()) throw new ByteBudgetError("Crawl reservation exhausted");
   this.db.prepare("UPDATE forage_crawl_reservations SET reserved = reserved - ? WHERE token = ?").run(bytes, token);
   this.db.prepare("UPDATE forage_crawl_jobs SET reserved = reserved - ?, bytes_used = bytes_used + ?, updated_at = ? WHERE id = ?").run(bytes, bytes, this.now(), id);
  })() }, release: () => {
   if (!this.db.open) return;
   this.db.transaction(() => {
    const row = this.db.prepare("SELECT reserved FROM forage_crawl_reservations WHERE token = ?").get(token) as { reserved: number } | undefined;
    if (!row) return;
    if (this.current(id, generation)) this.db.prepare("UPDATE forage_crawl_jobs SET reserved = reserved - ? WHERE id = ?").run(row.reserved, id);
    this.db.prepare("DELETE FROM forage_crawl_reservations WHERE token = ?").run(token);
   })();
  } };
 }
 budget(claim: CrawlClaim): ByteBudget {
  return { remaining: () => this.valid(claim) ? (this.db.prepare("SELECT reserved FROM forage_crawl_pages WHERE id = ?").get(claim.id) as { reserved: number }).reserved : 0,
   consume: bytes => this.db.transaction(() => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !this.valid(claim)) throw new Error("Stale crawl claim");
    const page = this.db.prepare("SELECT reserved FROM forage_crawl_pages WHERE id = ?").get(claim.id) as { reserved: number };
    if (bytes > page.reserved) throw new ByteBudgetError("Crawl claim reservation exhausted");
    this.db.prepare("UPDATE forage_crawl_pages SET reserved = reserved - ? WHERE id = ?").run(bytes, claim.id);
    this.db.prepare("UPDATE forage_crawl_jobs SET reserved = reserved - ?, bytes_used = bytes_used + ?, updated_at = ? WHERE id = ?").run(bytes, bytes, this.now(), claim.jobId);
   })() };
 }
 private settle(claim: CrawlClaim, state: string, error: string | null, receipt?: RetrievalReceipt): void {
  const page = this.db.prepare("SELECT reserved FROM forage_crawl_pages WHERE id = ?").get(claim.id) as { reserved: number };
  this.db.prepare("UPDATE forage_crawl_jobs SET reserved = reserved - ?, updated_at = ? WHERE id = ?").run(page.reserved, this.now(), claim.jobId);
  this.db.prepare("UPDATE forage_crawl_pages SET state = ?, error = ?, reserved = 0, claim_token = NULL, source_id = ?, snapshot_id = ?, retrieval_id = ? WHERE id = ?").run(state, error, receipt?.sourceId ?? null, receipt?.snapshotId ?? null, receipt?.retrievalId ?? null, claim.id);
 }
 capture(claim: CrawlClaim, capture: () => RetrievalReceipt): boolean {
  return this.db.transaction(() => {
   if (!this.valid(claim)) return false;
   const receipt = capture();
   const saved = receipt.persisted && receipt.snapshotId !== null;
   this.settle(claim, saved ? "saved" : "failed", saved ? null : receipt.warning?.code ?? "CAPTURE_REFUSED", receipt);
   if (!saved) this.db.prepare("UPDATE forage_crawl_jobs SET stop_reason = ?, error = ? WHERE id = ?").run(receipt.warning?.code === "STORAGE_LIMIT" ? "storage-limit" : "error", "Capture refused", claim.jobId);
   return true;
  })();
 }
 fail(claim: CrawlClaim, error: string, retry: boolean): boolean {
  return this.db.transaction(() => {
   if (!this.valid(claim)) return false;
   const page = this.db.prepare("SELECT attempts FROM forage_crawl_pages WHERE id = ?").get(claim.id) as { attempts: number };
   this.settle(claim, retry && page.attempts < 2 ? "queued" : "failed", error.slice(0, 128));
   if (!retry || page.attempts >= 2) this.db.prepare("UPDATE forage_crawl_jobs SET error = COALESCE(error, ?) WHERE id = ?").run(error.slice(0, 128), claim.jobId);
   return true;
  })();
 }
 skip(claim: CrawlClaim): void { if (this.valid(claim)) this.db.transaction(() => { this.settle(claim, "skipped", "ROBOTS_DENIED"); })(); }
 finish(id: string, generation: number, reason: CrawlStopReason, error: string | null = null): void {
  if (!this.current(id, generation)) return;
  const row = this.row(id)!; const view = this.view(row);
  const effective = row.stop_reason === "storage-limit" ? row.stop_reason : reason;
  const partial = row.omitted > 0 || view.counts.failed > 0 || view.counts.queued > 0 || view.counts.skipped > 0 || reason !== "frontier-empty";
  this.fence(id, partial ? "partial" : "completed", effective, error ?? row.error);
  this.trimSync(id);
 }
 pause(id: string): void { const row = this.row(id); if (row?.state === "running") this.fence(id, "paused", null, null); }
 private fence(id: string, state: CrawlJobView["state"], reason: CrawlStopReason, error: string | null): void {
  this.db.transaction(() => {
   const row = this.row(id); if (!row) return;
   const now = this.now();
   this.db.prepare("UPDATE forage_crawl_jobs SET state = ?, generation = generation + 1, duration_ms = duration_ms + ?, active_since = NULL, reserved = 0, updated_at = ?, finished_at = ?, stop_reason = ?, error = ? WHERE id = ?").run(state, row.active_since === null ? 0 : Math.max(0, now - row.active_since), now, state === "paused" ? null : now, reason, error === null && row.error === "REMOTE_START_PENDING" ? row.error : error, id);
   this.db.prepare("UPDATE forage_crawl_pages SET state = CASE WHEN attempts < 2 THEN 'queued' ELSE 'failed' END, reserved = 0, claim_token = NULL WHERE job_id = ? AND state = 'fetching'").run(id);
   this.db.prepare("DELETE FROM forage_crawl_reservations WHERE job_id = ?").run(id);
  })();
  this.onInvalidate(id);
 }
 cancel(scope: SourceScope, id: string): CrawlJobView { const job = this.require(scope, id); if (job.error === "REMOTE_START_PENDING") { this.markRemoteStartUnknown(id); return this.require(scope, id); } if (["queued", "running", "paused", "cancelling"].includes(job.state)) this.fence(id, "cancelled", "cancelled", null); this.trimSync(id); return this.require(scope, id); }
 resume(scope: SourceScope, id: string, changes: Partial<CrawlLimits> = {}): CrawlJobView {
  const job = this.require(scope, id);
  if (job.error?.includes("REMOTE_START_UNKNOWN")) throw new Error(UNKNOWN_REMOTE_START);
  if (this.db.prepare("SELECT 1 FROM forage_scope_deletions WHERE scope_key = ?").get(sourceScopeKey(scope))) throw new Error("Scope is being deleted");
  if (["running", "queued", "cancelling", "completed"].includes(job.state)) throw new Error("Job cannot be resumed");
  const limits = crawlLimits({ ...job.limits, ...changes });
  for (const key of Object.keys(changes) as Array<keyof CrawlLimits>) if (limits[key] < job.limits[key]) throw new Error("Resume limits may only increase");
  if ((this.db.prepare("SELECT COUNT(*) AS n FROM forage_crawl_jobs WHERE state = 'queued'").get() as { n: number }).n >= 20) throw new Error("Crawl queue limit reached");
  const request = { scope: job.scope, rootUrl: job.rootUrl, includePaths: job.includePaths, excludePaths: job.excludePaths, includeSubdomains: job.includeSubdomains, backend: job.backend, limits };
  this.db.transaction(() => {
   this.db.prepare("UPDATE forage_crawl_jobs SET request_json = ?, state = 'queued', generation = generation + 1, finished_at = NULL, stop_reason = NULL, error = NULL, discovered = 0, updated_at = ? WHERE id = ?").run(JSON.stringify(request), this.now(), id);
   this.db.prepare("UPDATE forage_crawl_pages SET state = 'queued', error = NULL WHERE job_id = ? AND state IN ('skipped','failed') AND attempts < 2").run(id);
  })();
  return this.require(scope, id);
 }
 async cancelScope(scope: SourceScope): Promise<number> { return this.invalidateScope(scope); }
 protectedSnapshotIds(): ReadonlySet<string> { return new Set((this.db.prepare(`SELECT DISTINCT p.snapshot_id FROM forage_crawl_pages p JOIN forage_crawl_jobs j ON j.id = p.job_id WHERE j.state IN ${ACTIVE} AND p.snapshot_id IS NOT NULL`).all() as Array<{ snapshot_id: string }>).map(r => r.snapshot_id)); }
 invalidateScope(scope: SourceScope): number {
  const rows = this.db.prepare(`SELECT id FROM forage_crawl_jobs WHERE scope_key = ? AND state IN ${ACTIVE}`).all(sourceScopeKey(scope)) as Array<{ id: string }>;
  for (const { id } of rows) this.fence(id, "cancelled", "cancelled", null);
  this.trimSync(); return rows.length;
 }
 beforeSnapshotsDeleted(ids: readonly string[]): void {
  const update = this.db.prepare("UPDATE forage_crawl_pages SET state = 'evicted', error = 'SNAPSHOT_EVICTED' WHERE snapshot_id = ? AND state = 'saved'");
  const affected = this.db.prepare("UPDATE forage_crawl_jobs SET state = CASE WHEN state = 'completed' THEN 'partial' ELSE state END, error = 'SNAPSHOT_EVICTED' WHERE id IN (SELECT job_id FROM forage_crawl_pages WHERE snapshot_id = ?)");
  for (const id of ids) { affected.run(id); update.run(id); }
 }
 async deleteScope(scope: SourceScope): Promise<number> {
  this.invalidateScope(scope); let count = 0;
  while (this.db.open) {
   const rows = this.db.prepare("SELECT id FROM forage_crawl_jobs WHERE scope_key = ? LIMIT 4").all(sourceScopeKey(scope)) as Array<{ id: string }>;
   if (!rows.length) break;
   this.db.transaction(() => { for (const { id } of rows) this.deleteJob(id); })();
   count += rows.length; await yieldTurn();
  }
  return count;
 }
 private metadataBytes(): number { return (this.db.prepare("SELECT (SELECT COALESCE(SUM(LENGTH(CAST(request_json AS BLOB)) + 65536),0) FROM forage_crawl_jobs) + (SELECT COALESCE(SUM(LENGTH(CAST(url AS BLOB)) + 512),0) FROM forage_crawl_pages) AS n").get() as { n: number }).n; }
 private trimSync(keepId = ""): number {
  let removed = 0;
  let count = (this.db.prepare(`SELECT COUNT(*) AS n FROM forage_crawl_jobs WHERE state IN ${TERMINAL}`).get() as { n: number }).n;
  while (count > 200 || this.metadataBytes() > MAX_METADATA) {
   const oldest = this.db.prepare(`SELECT id FROM forage_crawl_jobs WHERE state IN ${TERMINAL} AND id != ? AND NOT EXISTS (SELECT 1 FROM forage_crawl_remote r WHERE r.job_id = forage_crawl_jobs.id AND r.pending = 1) ORDER BY finished_at, id LIMIT 1`).get(keepId) as { id: string } | undefined;
   if (!oldest) break;
   this.deleteJob(oldest.id); count--; removed++;
  }
  return removed;
 }
 async pruneJobs(input: { completedBefore?: number; failedBefore?: number } = {}): Promise<number> {
  const now = this.now(); let removed = 0;
  while (this.db.open) {
   const rows = this.db.prepare(`SELECT id FROM forage_crawl_jobs WHERE ((state = 'completed' AND finished_at < ?) OR (state IN ('partial','failed','cancelled') AND finished_at < ?)) AND NOT EXISTS (SELECT 1 FROM forage_crawl_remote r WHERE r.job_id = forage_crawl_jobs.id AND r.pending = 1) LIMIT 4`).all(input.completedBefore ?? now - 30 * 86400000, input.failedBefore ?? now - 7 * 86400000) as Array<{ id: string }>;
   if (!rows.length) break;
   this.db.transaction(() => { for (const { id } of rows) this.deleteJob(id); })(); removed += rows.length; await yieldTurn();
  }
  if (this.db.open) removed += this.trimSync(); return removed;
 }
 private deleteJob(id: string): void {
  if (this.pendingRemote(id).length) throw new Error("Remote crawl cancellation must complete before deletion");
  this.db.prepare("DELETE FROM forage_crawl_remote WHERE job_id = ?").run(id);
  this.db.prepare("DELETE FROM forage_crawl_jobs WHERE id = ?").run(id);
 }
 markRemoteStartPending(jobId: string, generation: number): void {
  if (!this.current(jobId, generation)) throw new Error("Stale managed start");
  this.db.prepare("UPDATE forage_crawl_jobs SET error = 'REMOTE_START_PENDING' WHERE id = ? AND generation = ?").run(jobId, generation);
 }
 markRemoteStartUnknown(jobId: string): void { this.fence(jobId, "failed", "error", UNKNOWN_REMOTE_START); }
 trackRemote(jobId: string, generation: number, remoteId: string): void {
  if (remoteId.length > 256) throw new Error("Invalid remote id");
  this.db.transaction(() => {
   this.db.prepare("INSERT OR IGNORE INTO forage_crawl_remote(id, job_id, generation) VALUES (?, ?, ?)").run(remoteId, jobId, generation);
   this.db.prepare("UPDATE forage_crawl_jobs SET error = NULL WHERE id = ? AND error = 'REMOTE_START_PENDING'").run(jobId);
  })();
 }
 pendingRemote(jobId?: string): Array<{ id: string; job_id: string; generation: number }> { return this.db.prepare(`SELECT id, job_id, generation FROM forage_crawl_remote WHERE pending = 1 ${jobId ? "AND job_id = ?" : ""}`).all(...(jobId ? [jobId] : [])) as Array<{ id: string; job_id: string; generation: number }>; }
 reserveControl(id: string, generation: number): void {
  this.db.transaction(() => {
   if (!this.current(id, generation) || this.available(id) < 1024) throw new ByteBudgetError("Managed crawl requires a cancellation-response reservation");
   this.db.prepare("INSERT INTO forage_crawl_control(job_id, generation, reserved) VALUES (?, ?, 1024)").run(id, generation);
   this.db.prepare("UPDATE forage_crawl_jobs SET control_reserved = control_reserved + 1024 WHERE id = ?").run(id);
  })();
 }
 releaseControl(id: string, generation: number): void {
  this.db.transaction(() => {
   if (this.pendingRemote(id).some(remote => remote.generation === generation)) return;
   const row = this.db.prepare("SELECT reserved FROM forage_crawl_control WHERE job_id = ? AND generation = ?").get(id, generation) as { reserved: number } | undefined;
   if (!row) return;
   this.db.prepare("UPDATE forage_crawl_jobs SET control_reserved = control_reserved - ? WHERE id = ?").run(row.reserved, id);
   this.db.prepare("DELETE FROM forage_crawl_control WHERE job_id = ? AND generation = ?").run(id, generation);
  })();
 }
 cleanupBudget(remoteId: string): ByteBudget {
  const row = this.db.prepare("SELECT job_id, generation FROM forage_crawl_remote WHERE id = ? AND pending = 1").get(remoteId) as { job_id: string; generation: number } | undefined;
  if (!row) throw new Error("Remote cancellation is no longer pending");
  const remaining = () => (this.db.prepare("SELECT reserved FROM forage_crawl_control WHERE job_id = ? AND generation = ?").get(row.job_id, row.generation) as { reserved: number } | undefined)?.reserved ?? 0;
  return { remaining, consume: bytes => this.db.transaction(() => {
   if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining()) throw new ByteBudgetError("Cancellation response reservation exhausted");
   this.db.prepare("UPDATE forage_crawl_control SET reserved = reserved - ? WHERE job_id = ? AND generation = ?").run(bytes, row.job_id, row.generation);
   this.db.prepare("UPDATE forage_crawl_jobs SET control_reserved = control_reserved - ?, bytes_used = bytes_used + ? WHERE id = ?").run(bytes, bytes, row.job_id);
  })() };
 }
 remoteDone(id: string): void {
  const remote = this.db.prepare("SELECT job_id, generation FROM forage_crawl_remote WHERE id = ?").get(id) as { job_id: string; generation: number } | undefined;
  this.db.prepare("DELETE FROM forage_crawl_remote WHERE id = ?").run(id);
  if (remote) this.releaseControl(remote.job_id, remote.generation);
  this.trimSync();
 }
 async *scopes(): AsyncIterable<SourceScope> {
  let after = "";
  for (;;) {
   const rows = this.db.prepare("SELECT scope_key, MIN(request_json) AS request_json FROM forage_crawl_jobs WHERE scope_key > ? GROUP BY scope_key ORDER BY scope_key LIMIT 32").all(after) as Array<{ scope_key: string; request_json: string }>;
   if (!rows.length) return;
   for (const row of rows) { after = row.scope_key; yield (JSON.parse(row.request_json) as CrawlRequest).scope; }
   await new Promise<void>(resolve => setImmediate(resolve));
  }
 }
 activeScopes(): SourceScope[] { return (this.db.prepare(`SELECT MIN(request_json) AS request_json FROM forage_crawl_jobs WHERE state IN ('queued','running','cancelling') GROUP BY scope_key LIMIT 22`).all() as Array<{ request_json: string }>).map(row => (JSON.parse(row.request_json) as CrawlRequest).scope); }
 pages(scope: SourceScope, id: string): CrawlPage[] { this.require(scope, id); return this.db.prepare("SELECT * FROM forage_crawl_pages WHERE job_id = ? ORDER BY depth, id LIMIT 5000").all(id) as CrawlPage[]; }
 omissions(id: string): number { return this.row(id)?.omitted ?? 0; }
 markDiscovered(id: string, generation: number, omitted: boolean): void { if (this.current(id, generation)) this.db.prepare("UPDATE forage_crawl_jobs SET discovered = 1, omitted = omitted + ? WHERE id = ?").run(omitted ? 1 : 0, id); }
 discovered(id: string): boolean { return this.row(id)?.discovered === 1; }
 vendor(id: string): { id: string | null; next: string | null; done: boolean; pendingCancel: boolean } { const row = this.row(id)!; return { id: row.vendor_id, next: row.vendor_next, done: !!row.vendor_done, pendingCancel: !!row.vendor_pending_cancel }; }
 setVendor(id: string, generation: number, vendorId: string, next: string | null, done: boolean): boolean {
  if (vendorId.length > 256 || (next?.length ?? 0) > 8192) throw new Error("Invalid vendor cursor");
  return this.db.prepare("UPDATE forage_crawl_jobs SET vendor_id = ?, vendor_next = ?, vendor_done = ?, vendor_pending_cancel = ? WHERE id = ? AND generation = ? AND state = 'running'").run(vendorId, next, done ? 1 : 0, done ? 0 : 1, id, generation).changes > 0;
 }
 vendorCancelled(id: string): void { this.db.prepare("UPDATE forage_crawl_jobs SET vendor_pending_cancel = 0 WHERE id = ?").run(id); }
}
