import type Database from "better-sqlite3";
import { sourceScopeKey, type SourceScope } from "../web/contracts.ts";
import { canonicalUrlKey } from "../web/url.ts";

export type Arrival = "agent" | "crawl" | "person" | "shared";
export type SourceFilter = "all" | "cited" | "changed" | "problems";
export interface Visibility { allowPrivate: boolean; allowRestricted: boolean }

// A crawl and a direct read extract with different ids, so two snapshots can hold the same text.
// Versions here count distinct text, which is what "changed" means to a person.
export interface ResearchSource {
 id: string;
 url: string;
 title: string;
 network: "public" | "private";
 credentialed: boolean;
 arrival: Arrival;
 via: "tab" | "browser" | null;
 crawlJobId: string | null;
 versions: number;
 latestSnapshotId: string | null;
 bytes: number;
 truncated: boolean;
 status: "complete" | "partial" | "failed";
 error: string | null;
 cited: number;
 shared: boolean;
 createdAt: number;
 updatedAt: number;
 lastRetrievedAt: number | null;
}

export interface CrawlGroup { jobId: string | null; rootUrl: string | null; state: string | null; sources: number }

const MAX_SCOPE_ROWS = 2000;
const THIRTY_DAYS = 30 * 86_400_000;

interface Row {
 id: string; display_url: string; title: string; access_network: "public" | "private"; access_credentialed: number; latest_snapshot_id: string | null;
 created_at: number; updated_at: number; last_retrieved_at: number | null; versions: number; bytes: number | null; truncated: number | null;
 last_status: string | null; last_error: string | null; first_origin: string | null; crawl_job: string | null; actor: string | null; via: string | null; cited: number; shared: number;
}

function visibilitySql(scope: SourceScope, visibility: Visibility): string {
 const clauses: string[] = [];
 if (!visibility.allowPrivate) clauses.push("src.access_network = 'public'");
 if (scope.kind === "project" || !visibility.allowRestricted) clauses.push("(src.access_network = 'public' AND src.access_credentialed = 0)");
 return clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
}

// For a project scope, exceptThread leaves out copies of pages that thread already keeps, so the thread view lists each page once.
function scopeRows(db: Database.Database, scope: SourceScope, visibility: Visibility, onlyId?: string, exceptThread?: string): Row[] {
 const except = scope.kind === "project" && exceptThread ? sourceScopeKey({ kind: "thread", projectId: scope.projectId, threadId: exceptThread }) : null;
 return db.prepare(`SELECT src.id, src.display_url, src.title, src.access_network, src.access_credentialed, src.latest_snapshot_id, src.created_at, src.updated_at, src.last_retrieved_at,
  (SELECT COUNT(DISTINCT s.content_hash) FROM forage_snapshots s WHERE s.source_id = src.id) AS versions,
  (SELECT s.content_bytes FROM forage_snapshots s WHERE s.id = src.latest_snapshot_id) AS bytes,
  (SELECT s.truncated FROM forage_snapshots s WHERE s.id = src.latest_snapshot_id) AS truncated,
  (SELECT r.status FROM forage_retrievals r WHERE r.source_id = src.id ORDER BY r.finished_at DESC, r.id DESC LIMIT 1) AS last_status,
  (SELECT r.error FROM forage_retrievals r WHERE r.source_id = src.id ORDER BY r.finished_at DESC, r.id DESC LIMIT 1) AS last_error,
  (SELECT r.origin FROM forage_retrievals r WHERE r.source_id = src.id ORDER BY r.finished_at ASC, r.id ASC LIMIT 1) AS first_origin,
  (SELECT p.job_id FROM forage_crawl_pages p WHERE p.source_id = src.id LIMIT 1) AS crawl_job,
  (SELECT a.actor FROM forage_source_actors a WHERE a.source_id = src.id) AS actor,
  (SELECT a.via FROM forage_source_actors a WHERE a.source_id = src.id) AS via,
  (SELECT COUNT(*) FROM forage_citations c WHERE c.source_id = src.id) AS cited,
  EXISTS (SELECT 1 FROM forage_sources p WHERE p.scope_key = 'project:' || src.project_id AND p.normalized_url = src.normalized_url AND p.deleting = 0 AND src.scope_kind = 'thread') AS shared
  FROM forage_sources src WHERE src.scope_key = ? AND src.deleting = 0${onlyId ? " AND src.id = ?" : ""}${except ? " AND NOT EXISTS (SELECT 1 FROM forage_sources t WHERE t.scope_key = ? AND t.normalized_url = src.normalized_url AND t.deleting = 0)" : ""}${visibilitySql(scope, visibility)}
  ORDER BY src.updated_at DESC, src.id DESC LIMIT ?`).all(sourceScopeKey(scope), ...(onlyId ? [onlyId] : []), ...(except ? [except] : []), MAX_SCOPE_ROWS) as Row[];
}

export function researchSourceById(db: Database.Database, scope: SourceScope, id: string, visibility: Visibility): ResearchSource | null {
 const row = scopeRows(db, scope, visibility, id)[0];
 return row ? toSource(scope, row) : null;
}

export function visibleSourceIds(db: Database.Database, scope: SourceScope, ids: readonly string[], visibility: Visibility): Set<string> {
 const out = new Set<string>();
 const unique = [...new Set(ids)];
 for (let i = 0; i < unique.length; i += 200) {
  const batch = unique.slice(i, i + 200);
  const rows = db.prepare(`SELECT src.id FROM forage_sources src WHERE src.scope_key = ? AND src.deleting = 0 AND src.latest_snapshot_id IS NOT NULL AND src.id IN (${batch.map(() => "?").join(",")})${visibilitySql(scope, visibility)}`).all(sourceScopeKey(scope), ...batch) as Array<{ id: string }>;
  for (const row of rows) out.add(row.id);
 }
 return out;
}

function toSource(scope: SourceScope, row: Row): ResearchSource {
 const arrival: Arrival = scope.kind === "project" ? "shared"
  : row.actor === "person" ? "person"
  : row.actor === "agent" ? "agent"
  : row.crawl_job || row.first_origin === "crawl" ? "crawl" : "agent";
 const status = !row.latest_snapshot_id ? "failed" : row.last_status === "partial" || row.truncated === 1 ? "partial" : "complete";
 return {
  id: row.id, url: row.display_url, title: row.title, network: row.access_network, credentialed: row.access_credentialed === 1, arrival,
  via: row.via === "tab" || row.via === "browser" ? row.via : null, crawlJobId: row.crawl_job, versions: row.versions, latestSnapshotId: row.latest_snapshot_id,
  bytes: row.bytes ?? 0, truncated: row.truncated === 1, status, error: status === "failed" ? row.last_error : null, cited: row.cited,
  shared: row.shared === 1, createdAt: row.created_at, updatedAt: row.updated_at, lastRetrievedAt: row.last_retrieved_at,
 };
}

export function researchSources(db: Database.Database, scope: SourceScope, visibility: Visibility, exceptThread?: string): ResearchSource[] {
 return scopeRows(db, scope, visibility, undefined, exceptThread).map((row) => toSource(scope, row));
}

export function matchesFilter(source: ResearchSource, filter: SourceFilter): boolean {
 if (filter === "cited") return source.cited > 0;
 if (filter === "changed") return source.versions > 1;
 if (filter === "problems") return source.status !== "complete";
 return true;
}

export function crawlGroups(db: Database.Database, scope: SourceScope, sources: readonly ResearchSource[]): CrawlGroup[] {
 const crawled = sources.filter((source) => source.arrival === "crawl");
 const jobs = db.prepare("SELECT id, request_json, state FROM forage_crawl_jobs WHERE scope_key = ? ORDER BY created_at DESC, id DESC LIMIT 50").all(sourceScopeKey(scope)) as Array<{ id: string; request_json: string; state: string }>;
 const groups: CrawlGroup[] = jobs.map((job) => {
  let rootUrl: string | null = null;
  try { const request = JSON.parse(job.request_json) as { rootUrl?: unknown }; rootUrl = typeof request.rootUrl === "string" ? request.rootUrl : null; } catch { rootUrl = null; }
  return { jobId: job.id, rootUrl, state: job.state, sources: crawled.filter((source) => source.crawlJobId === job.id).length };
 });
 const known = new Set(jobs.map((job) => job.id));
 const orphaned = crawled.filter((source) => !source.crawlJobId || !known.has(source.crawlJobId)).length;
 if (orphaned > 0) groups.push({ jobId: null, rootUrl: null, state: null, sources: orphaned });
 return groups;
}

export interface CrawlPageView { id: number; url: string; depth: number; state: string; error: string | null; sourceId: string | null }
const PAGE_GROUP = "CASE state WHEN 'fetching' THEN 0 WHEN 'failed' THEN 1 WHEN 'saved' THEN 2 WHEN 'skipped' THEN 3 ELSE 4 END";
export function crawlPages(db: Database.Database, scope: SourceScope, jobId: string, options: { cursor?: string; limit: number }): { pages: CrawlPageView[]; nextCursor: string | null } | null {
 const job = db.prepare("SELECT id FROM forage_crawl_jobs WHERE id = ? AND scope_key = ?").get(jobId, sourceScopeKey(scope));
 if (!job) return null;
 // Pages sort by state group, then id; the cursor carries both so paging neither skips nor repeats.
 const [group, after] = (options.cursor ?? "-1:0").split(":").map(Number) as [number, number];
 const g = Number.isFinite(group) ? group : -1;
 const i = Number.isFinite(after) ? after : 0;
 const limit = Math.max(1, Math.min(200, Math.floor(options.limit)));
 const rows = db.prepare(`SELECT id, url, depth, state, error, source_id, ${PAGE_GROUP} AS grp FROM forage_crawl_pages WHERE job_id = ? AND (${PAGE_GROUP} > ? OR (${PAGE_GROUP} = ? AND id > ?))
  ORDER BY grp, id LIMIT ?`).all(jobId, g, g, i, limit + 1) as Array<{ id: number; url: string; depth: number; state: string; error: string | null; source_id: string | null; grp: number }>;
 const page = rows.slice(0, limit);
 const last = page.at(-1);
 return { pages: page.map((row) => ({ id: row.id, url: row.url, depth: row.depth, state: row.state, error: row.error, sourceId: row.source_id })), nextCursor: rows.length > limit && last ? `${last.grp}:${last.id}` : null };
}

export function sourceIdsByUrl(db: Database.Database, scope: SourceScope, urls: readonly string[], visibility: Visibility): Map<string, string> {
 const keys = new Map<string, string>();
 for (const url of urls) { try { keys.set(canonicalUrlKey(url), url); } catch { /* An address that does not parse cannot match a kept source. */ } }
 const out = new Map<string, string>();
 const all = [...keys.keys()];
 for (let i = 0; i < all.length; i += 200) {
  const batch = all.slice(i, i + 200);
  const rows = db.prepare(`SELECT src.id, src.normalized_url FROM forage_sources src WHERE src.scope_key = ? AND src.deleting = 0 AND src.latest_snapshot_id IS NOT NULL AND src.normalized_url IN (${batch.map(() => "?").join(",")})${visibilitySql(scope, visibility)}`).all(sourceScopeKey(scope), ...batch) as Array<{ id: string; normalized_url: string }>;
  for (const row of rows) out.set(keys.get(row.normalized_url)!, row.id);
 }
 return out;
}

export function scopeStorage(db: Database.Database, scope: SourceScope): { bytes: number; oldestRetainedAt: number | null } {
 const row = db.prepare(`SELECT COALESCE(SUM(s.content_bytes), 0) AS bytes, MIN(s.retained_at) AS oldest FROM forage_snapshots s JOIN forage_sources src ON src.id = s.source_id
  WHERE src.scope_key = ? AND src.deleting = 0`).get(sourceScopeKey(scope)) as { bytes: number; oldest: number | null };
 return { bytes: row.bytes, oldestRetainedAt: row.oldest };
}

export const expiresAt = (oldestRetainedAt: number | null): number | null => (oldestRetainedAt === null ? null : oldestRetainedAt + THIRTY_DAYS);

export interface ResearchThreadRow { projectId: string; threadId: string; lastAt: number; sources: number; cited: number; bytes: number; activity: number }
export function researchThreads(db: Database.Database, limit: number): ResearchThreadRow[] {
 const rows = db.prepare(`SELECT scope_key, project_id, thread_id, MAX(at) AS at FROM (
   SELECT scope_key, project_id, thread_id, MAX(updated_at) AS at FROM forage_sources WHERE scope_kind = 'thread' AND deleting = 0 GROUP BY scope_key
   UNION ALL
   SELECT scope_key, project_id, thread_id, MAX(finished_at) AS at FROM forage_activity GROUP BY scope_key
  ) GROUP BY scope_key ORDER BY at DESC LIMIT ?`).all(Math.max(1, Math.min(100, limit))) as Array<{ scope_key: string; project_id: string; thread_id: string; at: number }>;
 return rows.map((row) => {
  const stats = db.prepare(`SELECT COUNT(*) AS sources,
    (SELECT COUNT(DISTINCT c.source_id) FROM forage_citations c JOIN forage_sources s2 ON s2.id = c.source_id WHERE s2.scope_key = ?) AS cited,
    (SELECT COALESCE(SUM(s.content_bytes), 0) FROM forage_snapshots s JOIN forage_sources s3 ON s3.id = s.source_id WHERE s3.scope_key = ?) AS bytes,
    (SELECT COUNT(*) FROM forage_activity a WHERE a.scope_key = ?) AS activity
    FROM forage_sources WHERE scope_key = ? AND deleting = 0`).get(row.scope_key, row.scope_key, row.scope_key, row.scope_key) as { sources: number; cited: number; bytes: number; activity: number };
  return { projectId: row.project_id, threadId: row.thread_id, lastAt: row.at, ...stats };
 });
}

export interface SharedSourceRow { id: string; projectId: string; title: string; url: string; updatedAt: number }
export function sharedSources(db: Database.Database, limit: number): SharedSourceRow[] {
 return (db.prepare(`SELECT id, project_id, title, display_url, updated_at FROM forage_sources WHERE scope_kind = 'project' AND deleting = 0
  AND access_network = 'public' AND access_credentialed = 0 ORDER BY updated_at DESC LIMIT ?`).all(Math.max(1, Math.min(100, limit))) as Array<{ id: string; project_id: string; title: string; display_url: string; updated_at: number }>)
  .map((row) => ({ id: row.id, projectId: row.project_id, title: row.title, url: row.display_url, updatedAt: row.updated_at }));
}

export function storageOverview(db: Database.Database): { bytes: number; sources: number; byScope: Array<{ scope: SourceScope; bytes: number }> } {
 const total = db.prepare("SELECT COALESCE(SUM(content_bytes), 0) AS bytes FROM forage_snapshots").get() as { bytes: number };
 const sources = db.prepare("SELECT COUNT(*) AS n FROM forage_sources WHERE deleting = 0").get() as { n: number };
 const rows = db.prepare(`SELECT src.scope_kind, src.project_id, src.thread_id, SUM(s.content_bytes) AS bytes FROM forage_snapshots s JOIN forage_sources src ON src.id = s.source_id
  WHERE src.deleting = 0 GROUP BY src.scope_key ORDER BY bytes DESC LIMIT 10`).all() as Array<{ scope_kind: string; project_id: string; thread_id: string | null; bytes: number }>;
 return { bytes: total.bytes, sources: sources.n, byScope: rows.map((row) => ({ scope: row.scope_kind === "thread" && row.thread_id ? { kind: "thread", projectId: row.project_id, threadId: row.thread_id } : { kind: "project", projectId: row.project_id }, bytes: row.bytes })) };
}

export interface CitationRow { messageId: string; snapshotId: string; startLine: number; endLine: number; notedAt: number }
export function sourceCitations(db: Database.Database, sourceId: string): CitationRow[] {
 return (db.prepare("SELECT message_id, snapshot_id, start_line, end_line, noted_at FROM forage_citations WHERE source_id = ? ORDER BY noted_at DESC LIMIT 20").all(sourceId) as Array<{ message_id: string; snapshot_id: string; start_line: number; end_line: number; noted_at: number }>)
  .map((row) => ({ messageId: row.message_id, snapshotId: row.snapshot_id, startLine: row.start_line, endLine: row.end_line, notedAt: row.noted_at }));
}
