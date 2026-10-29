import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ActivityRepository, cleanUrl, scrub, summarize, type ActivityEvent } from "../../src/research/activity.ts";
import { crawlPages } from "../../src/research/queries.ts";
import { applyThreadPolicy, createThreadPolicyStore, policyFromMetadata } from "../../src/research/policy.ts";
import { findInSources, searchTerms } from "../../src/research/find.ts";
import { FORAGE_MIGRATIONS } from "../../src/crawl/schema.ts";
import { configureSourceDatabase } from "../../src/sources/schema.ts";
import { SqliteSourceRepository } from "../../src/sources/repository.ts";
import { CONFIG_DEFAULTS } from "../../src/web/config.ts";
import { pathPrefix, crawlError } from "../../src/ui/crawls.tsx";
import { plainText } from "../../src/ui/kit.tsx";
import { artifact, attempt, threadScope } from "../sources/helpers.ts";

const event = (overrides: Partial<ActivityEvent>): ActivityEvent => ({ scope: threadScope(), actor: "agent", operation: "search", status: "success", startedAt: 1, finishedAt: 2, params: {}, details: {}, pages: [], ...overrides });
function database() {
 const db = new Database(":memory:"); configureSourceDatabase(db); for (const sql of FORAGE_MIGRATIONS) db.exec(sql);
 return { db, sources: new SqliteSourceRepository(db, { now: () => 1_000_000 }), activity: new ActivityRepository(db) };
}

describe("activity summaries", () => {
 it("strips userinfo, fragments and secret-looking parameters but keeps ordinary addresses", () => {
  expect(cleanUrl("https://user:pw@example.com/a?token=abc#x")).toBe("https://example.com/a");
  expect(cleanUrl("https://example.com/search?q=queues")).toBe("https://example.com/search?q=queues");
  expect(cleanUrl("https://example.com/cb#access_token=SECRET")).toBe("https://example.com/cb");
  expect(cleanUrl("https://example.com/a?api_key=sk-live-1&page=2")).toBe("https://example.com/a?page=2");
  expect(cleanUrl("https://s3.example.com/o?X-Amz-Credential=c&X-Amz-Signature=s")).toBe("https://s3.example.com/o");
  expect(scrub('Unsupported URL scheme "ftp:" in "ftp://alice:s3cret@files.example.com/x"', 300)).not.toContain("s3cret");
 });
 it("keeps the queries a failed search asked, and skips paging through kept snapshots", () => {
  const failed = summarize(event({ status: "failure", params: { queries: ["a", "b"] }, error: "POLICY_BLOCKED: no provider" }));
  expect(failed?.summary).toMatchObject({ kind: "search", queries: [{ query: "a", error: "POLICY_BLOCKED: no provider" }, { query: "b" }] });
  expect(summarize(event({ operation: "fetch", params: { snapshotId: "snap_1" } }))).toBeNull();
  expect(summarize(event({ operation: "crawl", params: { action: "status", jobId: "j" } }))).toBeNull();
 });
 it("records a Browser save as its own kind and bounds large result lists", () => {
  const save = summarize(event({ operation: "fetch", via: "browser", params: { url: "https://example.com/a" }, pages: [{ url: "https://example.com/a", finalUrl: "https://example.com/a", title: "A", origin: "fetch", sourceId: "src_1", snapshotId: "snap_1", chars: 10, restricted: false }] }));
  expect(save).toMatchObject({ operation: "save", summary: { kind: "save", pages: [{ sourceId: "src_1" }] } });
  const many = summarize(event({ details: { queries: [{ query: "q", provider: "exa", results: Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://e.com/${i}`, snippet: "s".repeat(500) })) }] } }));
  expect(many?.summary.kind === "search" && many.summary.queries[0]!.results).toHaveLength(10);
 });
});

describe("activity repository", () => {
 it("hides entries that read restricted content and pages with a cursor", () => {
  const { activity } = database();
  activity.record(event({ operation: "fetch", params: { url: "http://10.0.0.1/x" }, pages: [{ url: "http://10.0.0.1/x", finalUrl: "http://10.0.0.1/x", title: "Internal", origin: "fetch", sourceId: null, snapshotId: null, chars: 5, restricted: true }] }));
  for (let i = 0; i < 3; i++) activity.record(event({ startedAt: 10 + i, finishedAt: 10 + i, details: { queries: [{ query: `q${i}`, provider: "exa", results: [] }] } }));
  expect(activity.list(threadScope(), { limit: 10, includeRestricted: false }).entries).toHaveLength(3);
  expect(activity.list(threadScope(), { limit: 10, includeRestricted: true }).entries).toHaveLength(4);
  const first = activity.list(threadScope(), { limit: 2, includeRestricted: false });
  const second = activity.list(threadScope(), { limit: 2, includeRestricted: false, cursor: first.nextCursor! });
  expect([...first.entries, ...second.entries].map((e) => e.summary.kind === "search" && e.summary.queries[0]!.query)).toEqual(["q2", "q1", "q0"]);
  expect(activity.clear({ kind: "project", projectId: "proj_a" })).toBe(0);
  expect(activity.prune(11)).toBe(2);
 });
});

describe("crawl pages", () => {
 it("pages through state groups without skipping or repeating", () => {
  const { db } = database();
  db.prepare("INSERT INTO forage_crawl_jobs (id, scope_key, request_json, state, created_at, updated_at) VALUES ('job_a', 'thread:proj_a:thr_a', '{}', 'completed', 1, 1)").run();
  const states = ["saved", "saved", "saved", "failed", "saved", "saved"];
  states.forEach((state, i) => db.prepare("INSERT INTO forage_crawl_pages (job_id, url, depth, state) VALUES ('job_a', ?, 0, ?)").run(`https://e.com/${i + 1}`, state));
  const seen: number[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
   const page = crawlPages(db, threadScope(), "job_a", { limit: 2, ...(cursor ? { cursor } : {}) })!;
   seen.push(...page.pages.map((p) => p.id));
   if (!page.nextCursor) break;
   cursor = page.nextCursor;
  }
  expect(seen).toEqual([4, 1, 2, 3, 5, 6]);
  expect(crawlPages(db, threadScope("thr_other"), "job_a", { limit: 2 })).toBeNull();
 });
});

describe("thread policy", () => {
 it("reads only known values and only ever narrows settings", () => {
  expect(policyFromMetadata({ webResearch: "docs" })).toBe("docs");
  expect(policyFromMetadata({ webResearch: "everything" })).toBe("settings");
  const config = { ...CONFIG_DEFAULTS, warnings: [] };
  expect(applyThreadPolicy(config, "private").privacyProfile).toBe("private");
  expect(applyThreadPolicy(config, "fresh").profile).toBe("fresh");
  expect(applyThreadPolicy({ ...config, privacyProfile: "private" }, "docs")).toMatchObject({ privacyProfile: "private", profile: config.profile });
 });
 it("falls back to the settings ceiling when metadata cannot be read", async () => {
  const store = createThreadPolicyStore({ read: async () => { throw new Error("offline"); }, readMany: async () => ({}), write: async (_id, policy) => ({ webResearch: policy }) });
  expect(await store.get("thr_a")).toBe("settings");
  expect(await store.set("thr_a", "off")).toBe("off");
  expect(await store.get("thr_a")).toBe("off");
 });
});

describe("check in sources", () => {
 it("matches at word starts and reports a passage only an earlier version still has", () => {
  const { db, sources } = database();
  const scope = threadScope();
  sources.recordRetrieval({ scope, origin: "fetch", artifact: artifact("# Releases\n\nPgBouncer is not supported.\nUse a direct connection."), attempt: attempt() });
  sources.recordRetrieval({ scope, origin: "fetch", artifact: artifact("# Releases\n\nPgBouncer works in session mode.", { fetchedAt: "2026-02-01T00:00:00.000Z" }), attempt: attempt({ startedAt: 300, finishedAt: 400 }) });
  expect(searchTerms("Is the PgBouncer not supported?")).toEqual(["pgbouncer", "support"]);
  expect(searchTerms("After a few retries, 30s then 10m")).toEqual(["few", "retr"]);
  const found = findInSources(db, scope, "PgBouncer is not supported", { allowPrivate: false, allowRestricted: false });
  expect(found.matches).toEqual([expect.objectContaining({ latest: false, startLine: 3 })]);
  expect(findInSources(db, scope, "bouncer supported", { allowPrivate: false, allowRestricted: false }).matches).toEqual([]);
  sources.recordRetrieval({ scope, origin: "crawl", artifact: artifact("# Copy\n\n[PgBouncer](https://www.pgbouncer.org) is not supported.\nUse a direct connection.", { requestedUrl: "https://example.com/docs/copy", resolvedUrl: "https://example.com/docs/copy", finalUrl: "https://example.com/docs/copy" }), attempt: attempt({ startedAt: 500, finishedAt: 600 }) });
  expect(findInSources(db, scope, "PgBouncer is not supported", { allowPrivate: false, allowRestricted: false }).matches).toHaveLength(1);
 });
});

describe("display helpers", () => {
 it("turns typed globs into the path prefixes the crawler matches", () => {
  expect(pathPrefix("/docs/**")).toBe("/docs");
  expect(pathPrefix("/guide/")).toBe("/guide");
  expect(pathPrefix("*")).toBe("/");
  expect(crawlError("FETCH_FAILED")).toMatch(/could not be read/u);
 });
 it("reads Markdown as plain text for quotes", () => {
  expect(plainText("### `work()`\n**Retry** options and [docs](https://x.y)\u200B")).toBe("work() Retry options and docs");
 });
});
