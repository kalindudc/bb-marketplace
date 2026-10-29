import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { isSensitiveUrl } from "../sources/policy.ts";
import { sourceScopeKey, type SourceScope } from "../web/contracts.ts";

export type ActivityActor = "agent" | "person";
export type ActivityOperation = "search" | "fetch" | "map" | "extract" | "crawl" | "diff" | "save";
export type ActivityStatus = "success" | "partial" | "failure" | "cancelled";
export type ThreadScope = Extract<SourceScope, { kind: "thread" }>;

export interface PageRef { url: string; title: string; sourceId: string | null; snapshotId: string | null; chars: number; error?: string }
export interface SearchResultRef { title: string; url: string; snippet?: string }
export interface QueryRef { query: string; provider: string | null; total: number; error?: string; results: SearchResultRef[] }

export type ActivitySummary =
 | { kind: "search"; queries: QueryRef[]; pages: PageRef[] }
 | { kind: "fetch"; find?: string; pages: PageRef[] }
 | { kind: "save"; pages: PageRef[] }
 | { kind: "map"; root: string; total: number; methods: Record<string, number>; truncated: boolean; sample: string[] }
 | { kind: "extract"; fields: string[]; pages: PageRef[] }
 | { kind: "crawl"; action: "start" | "cancel" | "resume"; jobId: string | null; root: string | null }
 | { kind: "diff"; url: string | null; sourceId: string | null; unchanged: boolean; added: number; removed: number; sections: string[]; persisted: boolean };

export interface ActivityEntry {
 id: string;
 scope: ThreadScope;
 actor: ActivityActor;
 operation: ActivityOperation;
 status: ActivityStatus;
 items: number;
 restricted: boolean;
 startedAt: number;
 finishedAt: number;
 summary: ActivitySummary;
 error: string | null;
}

export interface TouchedPage {
 url: string;
 finalUrl: string;
 title: string;
 origin: string;
 sourceId: string | null;
 snapshotId: string | null;
 chars: number;
 error?: string;
 restricted: boolean;
}

export interface ActivityEvent {
 scope: SourceScope;
 actor: ActivityActor;
 via?: "tab" | "browser";
 operation: "search" | "fetch" | "map" | "extract" | "crawl" | "diff";
 status: ActivityStatus;
 startedAt: number;
 finishedAt: number;
 params: unknown;
 details: unknown;
 pages: readonly TouchedPage[];
 error?: string;
}

const MAX_RESULTS = 10;
const MAX_PAGES = 20;
const MAX_SUMMARY_BYTES = 24 * 1024;
const MAX_ENTRIES_PER_THREAD = 2000;
const clip = (value: unknown, max: number): string => {
 const text = typeof value === "string" ? value : "";
 return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

const SECRET_PARAM = /token|key|secret|sig|auth|pass|credential|session|code|jwt|bearer|otp|nonce/iu;
// Userinfo, fragments and secret-looking query parameters never reach the log; the rest of the address stays readable.
export function cleanUrl(value: unknown): string {
 const text = typeof value === "string" ? value : "";
 try {
  const url = new URL(text);
  url.username = ""; url.password = ""; url.hash = "";
  if (isSensitiveUrl(text)) url.search = "";
  for (const name of [...url.searchParams.keys()]) if (SECRET_PARAM.test(name)) url.searchParams.delete(name);
  return clip(url.toString(), 500);
 } catch { return clip(text.replace(/[?#].*$/su, ""), 500); }
}
// Error text from a failed read can repeat the address it failed on.
export const scrub = (value: unknown, max: number): string => clip(typeof value === "string" ? value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()`]+/giu, (url) => cleanUrl(url)) : "", max);

function pageRefs(pages: readonly TouchedPage[], origins: readonly string[]): PageRef[] {
 const seen = new Set<string>();
 const out: PageRef[] = [];
 for (const page of pages) {
  if (!origins.includes(page.origin)) continue;
  const url = cleanUrl(page.finalUrl || page.url);
  if (seen.has(url)) continue;
  seen.add(url);
  out.push({ url, title: clip(page.title, 200), sourceId: page.sourceId, snapshotId: page.snapshotId, chars: count(page.chars), ...(page.error ? { error: scrub(page.error, 300) } : {}) });
  if (out.length >= MAX_PAGES) break;
 }
 return out;
}

export function summarize(event: ActivityEvent): { operation: ActivityOperation; items: number; summary: ActivitySummary } | null {
 const params = record(event.params);
 const details = record(event.details);
 if (event.operation === "search") {
  const queries: QueryRef[] = list(details.queries).slice(0, 8).map((value) => {
   const q = record(value);
   return {
    query: clip(q.query, 500), provider: typeof q.provider === "string" ? q.provider : null, total: list(q.results).length,
    ...(q.error ? { error: scrub(q.error, 300) } : {}),
    results: list(q.results).slice(0, MAX_RESULTS).map((r) => { const result = record(r); return { title: clip(result.title, 200), url: cleanUrl(result.url), ...(result.snippet ? { snippet: clip(result.snippet, 240) } : {}) }; }),
   };
  });
  if (queries.length === 0) {
   const asked = [...list(params.queries), ...(typeof params.query === "string" ? [params.query] : [])].slice(0, 8);
   for (const query of asked) queries.push({ query: clip(query, 500), provider: null, total: 0, error: scrub(event.error ?? "The search did not run.", 300), results: [] });
  }
  return { operation: "search", items: queries.length, summary: { kind: "search", queries, pages: pageRefs(event.pages, ["search-content"]) } };
 }
 if (event.operation === "fetch") {
  if (params.snapshotId || params.sourceId) return null;
  const pages = pageRefs(event.pages, ["fetch"]);
  if (pages.length === 0) {
   const urls = [...list(params.urls), ...(typeof params.url === "string" ? [params.url] : [])].slice(0, MAX_PAGES);
   for (const url of urls) pages.push({ url: cleanUrl(url), title: "", sourceId: null, snapshotId: null, chars: 0, error: scrub(event.error ?? "The page was not read.", 300) });
  }
  if (event.via === "browser") return { operation: "save", items: pages.length, summary: { kind: "save", pages } };
  return { operation: "fetch", items: pages.length, summary: { kind: "fetch", ...(typeof params.find === "string" ? { find: clip(params.find, 200) } : {}), pages } };
 }
 if (event.operation === "map") {
  const urls = list(details.urls);
  const methods: Record<string, number> = {};
  for (const value of urls) { const method = String(record(value).method ?? "other"); methods[method] = (methods[method] ?? 0) + 1; }
  return { operation: "map", items: urls.length, summary: { kind: "map", root: cleanUrl(details.rootUrl ?? params.url), total: urls.length, methods, truncated: details.truncated === true, sample: urls.slice(0, 8).map((value) => cleanUrl(record(value).url)) } };
 }
 if (event.operation === "extract") {
  if (params.snapshotId) return null;
  const pages = pageRefs(event.pages, ["extract"]);
  return { operation: "extract", items: pages.length, summary: { kind: "extract", fields: list(params.fields).map((field) => clip(field, 40)).slice(0, 10), pages } };
 }
 if (event.operation === "crawl") {
  const action = params.action;
  if (action !== "start" && action !== "cancel" && action !== "resume") return null;
  return { operation: "crawl", items: 1, summary: { kind: "crawl", action, jobId: typeof details.id === "string" ? details.id : typeof params.jobId === "string" ? params.jobId : null, root: typeof details.rootUrl === "string" ? cleanUrl(details.rootUrl) : typeof params.url === "string" ? cleanUrl(params.url) : null } };
 }
 const hunks = list(details.hunks);
 return { operation: "diff", items: 1, summary: {
  kind: "diff", url: typeof params.url === "string" ? cleanUrl(params.url) : null, sourceId: typeof params.sourceId === "string" ? params.sourceId : null,
  unchanged: details.unchanged === true, added: count(details.addedLines), removed: count(details.removedLines), persisted: details.persisted !== false,
  sections: [...new Set(hunks.map((h) => list(record(h).headingPath).map((part) => clip(part, 80)).join(" › ")).filter(Boolean))].slice(0, 5),
 } };
}

function bounded(summary: ActivitySummary): string {
 let json = JSON.stringify(summary);
 if (json.length <= MAX_SUMMARY_BYTES) return json;
 if (summary.kind === "search") {
  const slim: ActivitySummary = { ...summary, queries: summary.queries.map((q) => ({ ...q, results: q.results.slice(0, 5).map(({ title, url }) => ({ title, url })) })), pages: summary.pages.slice(0, 10) };
  json = JSON.stringify(slim);
  if (json.length <= MAX_SUMMARY_BYTES) return json;
 }
 if ("pages" in summary) json = JSON.stringify({ ...summary, pages: summary.pages.slice(0, 5) });
 if (json.length <= MAX_SUMMARY_BYTES) return json;
 const empty: ActivitySummary = summary.kind === "search" ? { kind: "search", queries: [], pages: [] }
  : summary.kind === "map" ? { ...summary, sample: [] }
  : summary.kind === "fetch" || summary.kind === "save" || summary.kind === "extract" ? { ...summary, pages: [] } : summary;
 return JSON.stringify(empty);
}

interface ActivityRow {
 id: string; scope_key: string; project_id: string; thread_id: string; actor: ActivityActor; operation: ActivityOperation; status: ActivityStatus;
 items: number; restricted: number; started_at: number; finished_at: number; summary_json: string;
}
const toEntry = (row: ActivityRow): ActivityEntry => {
 const parsed = JSON.parse(row.summary_json) as ActivitySummary & { error?: string };
 const { error, ...summary } = parsed as ActivitySummary & { error?: string };
 return {
  id: row.id, scope: { kind: "thread", projectId: row.project_id, threadId: row.thread_id }, actor: row.actor, operation: row.operation, status: row.status,
  items: row.items, restricted: row.restricted === 1, startedAt: row.started_at, finishedAt: row.finished_at, summary: summary as ActivitySummary, error: error ?? null,
 };
};
const encodeCursor = (at: number, id: string) => Buffer.from(JSON.stringify([at, id])).toString("base64url");
function decodeCursor(value: string | undefined): [number, string] | null {
 if (!value) return null;
 try {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  if (Array.isArray(parsed) && typeof parsed[0] === "number" && typeof parsed[1] === "string") return [parsed[0], parsed[1]];
 } catch { /* An unreadable cursor restarts from the newest entry. */ }
 return null;
}

export class ActivityRepository {
 private readonly now: () => number;
 constructor(private readonly db: Database.Database, options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

 record(event: ActivityEvent): ActivityEntry | null {
  const scope = event.scope;
  if (scope.kind !== "thread") return null;
  const built = summarize(event);
  if (!built) return null;
  const id = `act_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const key = sourceScopeKey(scope);
  // A comparison of two kept versions reads no page, so it takes the access of the source it compared.
  const diffSource = built.summary.kind === "diff" && built.summary.sourceId
   ? this.db.prepare("SELECT access_network, access_credentialed FROM forage_sources WHERE id = ? AND scope_key = ?").get(built.summary.sourceId, key) as { access_network: string; access_credentialed: number } | undefined : undefined;
  const restricted = event.pages.some((page) => page.restricted && !page.error) || Boolean(diffSource && (diffSource.access_network !== "public" || diffSource.access_credentialed === 1));
  const error = event.status === "failure" && event.error ? scrub(event.error, 400) : undefined;
  const json = bounded(built.summary);
  const summaryJson = error ? JSON.stringify({ ...JSON.parse(json), error }) : json;
  const sourceIds = "pages" in built.summary ? built.summary.pages.map((page) => page.sourceId).filter((value): value is string => Boolean(value)) : [];
  this.db.transaction(() => {
   this.db.prepare(`INSERT INTO forage_activity (id, scope_key, project_id, thread_id, actor, operation, status, items, restricted, started_at, finished_at, summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, key, scope.projectId, scope.threadId, event.actor, built.operation, event.status, built.items, restricted ? 1 : 0, event.startedAt, event.finishedAt, summaryJson);
   const insertActor = this.db.prepare("INSERT OR IGNORE INTO forage_source_actors (source_id, actor, via, first_at) SELECT id, ?, ?, ? FROM forage_sources WHERE id = ? AND scope_key = ?");
   for (const sourceId of sourceIds) insertActor.run(event.actor, event.via ?? null, event.finishedAt, sourceId, key);
   const excess = (this.db.prepare("SELECT COUNT(*) AS n FROM forage_activity WHERE scope_key = ?").get(key) as { n: number }).n - MAX_ENTRIES_PER_THREAD;
   if (excess > 0) this.db.prepare("DELETE FROM forage_activity WHERE id IN (SELECT id FROM forage_activity WHERE scope_key = ? ORDER BY finished_at, id LIMIT ?)").run(key, excess);
  })();
  return this.get(scope, id);
 }

 get(scope: ThreadScope, id: string): ActivityEntry | null {
  const row = this.db.prepare("SELECT * FROM forage_activity WHERE scope_key = ? AND id = ?").get(sourceScopeKey(scope), id) as ActivityRow | undefined;
  return row ? toEntry(row) : null;
 }

 list(scope: ThreadScope, options: { cursor?: string; limit: number; includeRestricted: boolean }): { entries: ActivityEntry[]; nextCursor: string | null } {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  const cursor = decodeCursor(options.cursor);
  const args: unknown[] = [sourceScopeKey(scope)];
  let where = "scope_key = ?";
  if (!options.includeRestricted) where += " AND restricted = 0";
  if (cursor) { where += " AND (finished_at < ? OR (finished_at = ? AND id < ?))"; args.push(cursor[0], cursor[0], cursor[1]); }
  const rows = this.db.prepare(`SELECT * FROM forage_activity WHERE ${where} ORDER BY finished_at DESC, id DESC LIMIT ?`).all(...args, limit + 1) as ActivityRow[];
  const page = rows.slice(0, limit);
  return { entries: page.map(toEntry), nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!.finished_at, page.at(-1)!.id) : null };
 }

 stats(scope: ThreadScope): { entries: number; searches: number; lastAt: number | null } {
  const row = this.db.prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(CASE WHEN operation = 'search' THEN items ELSE 0 END), 0) AS searches, MAX(finished_at) AS last_at
   FROM forage_activity WHERE scope_key = ?`).get(sourceScopeKey(scope)) as { entries: number; searches: number; last_at: number | null };
  return { entries: row.entries, searches: row.searches, lastAt: row.last_at };
 }

 // A log belongs to its thread; clearing a project's shared sources leaves thread logs alone.
 clear(scope: SourceScope): number {
  if (scope.kind !== "thread") return 0;
  return this.db.prepare("DELETE FROM forage_activity WHERE scope_key = ?").run(sourceScopeKey(scope)).changes;
 }

 prune(before: number): number { return this.db.prepare("DELETE FROM forage_activity WHERE finished_at < ?").run(before).changes; }

 deleteAll(): number { return this.db.prepare("DELETE FROM forage_activity").run().changes; }

 noteCitation(input: { scope: ThreadScope; snapshotId: string; messageId: string; startLine: number; endLine: number }): boolean {
  const row = this.db.prepare(`SELECT s.source_id AS source_id FROM forage_snapshots s JOIN forage_sources src ON src.id = s.source_id
   WHERE s.id = ? AND src.scope_key = ? AND src.deleting = 0`).get(input.snapshotId, sourceScopeKey(input.scope)) as { source_id: string } | undefined;
  if (!row) return false;
  // A range counts once, whether the server saw the reply or a card recorded it when it rendered.
  if (this.db.prepare("SELECT 1 FROM forage_citations WHERE source_id = ? AND start_line = ? AND end_line = ?").get(row.source_id, input.startLine, input.endLine)) return true;
  const existing = (this.db.prepare("SELECT COUNT(*) AS n FROM forage_citations WHERE source_id = ?").get(row.source_id) as { n: number }).n;
  if (existing >= 500) return false;
  this.db.prepare("INSERT OR IGNORE INTO forage_citations (source_id, snapshot_id, message_id, start_line, end_line, noted_at) VALUES (?, ?, ?, ?, ?, ?)")
   .run(row.source_id, input.snapshotId, input.messageId.slice(0, 200), input.startLine, input.endLine, this.now());
  return true;
 }

 async *scopes(): AsyncIterable<SourceScope> {
  let after = "";
  for (;;) {
   const rows = this.db.prepare("SELECT scope_key, project_id, thread_id FROM forage_activity WHERE scope_key > ? GROUP BY scope_key ORDER BY scope_key LIMIT 50").all(after) as Array<{ scope_key: string; project_id: string; thread_id: string }>;
   if (rows.length === 0) return;
   for (const row of rows) { after = row.scope_key; yield { kind: "thread", projectId: row.project_id, threadId: row.thread_id }; }
   await new Promise((resolve) => setImmediate(resolve));
  }
 }
}
