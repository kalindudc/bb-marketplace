import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CRAWL_DEFAULT_LIMITS, SqliteCrawlRepository } from "../../src/crawl/repository.ts";
import { CRAWL_MIGRATIONS, FORAGE_MIGRATIONS } from "../../src/crawl/schema.ts";
import { RESEARCH_MIGRATIONS } from "../../src/research/schema.ts";
import { SOURCE_MIGRATIONS, configureSourceDatabase } from "../../src/sources/schema.ts";
import { artifact, attempt, threadScope } from "../sources/helpers.ts";
import { SqliteSourceRepository } from "../../src/sources/repository.ts";

const databases: Database.Database[] = [];
function setup(now = () => 1000) {
 const db = new Database(":memory:"); databases.push(db); configureSourceDatabase(db);
 for (const sql of FORAGE_MIGRATIONS) db.exec(sql);
 const repo = new SqliteCrawlRepository(db, { now });
 const sources = new SqliteSourceRepository(db, { maintenance: repo, now });
 const job = repo.create({ scope: threadScope(), rootUrl: "https://example.com/docs", includePaths: [], excludePaths: [], includeSubdomains: false, backend: "local", limits: { ...CRAWL_DEFAULT_LIMITS, maxPages: 2, maxBytes: 100 } });
 return { db, repo, sources, job };
}
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });
describe("durable crawl repository", () => {
 it("exports append-only combined migrations", () => { expect(FORAGE_MIGRATIONS).toEqual([...SOURCE_MIGRATIONS, ...CRAWL_MIGRATIONS, ...RESEARCH_MIGRATIONS]); });
 it("reserves before claims, charges accepted bytes, counts distinct failed URLs and caps retries", () => {
  const { repo, job } = setup(); const run = repo.start(job.id)!;
  repo.enqueue(run.id, run.generation, ["https://example.com/a", "https://example.com/b"], 1);
  const a = repo.claim(run.id, run.generation, 60)!;
  expect(repo.claim(run.id, run.generation, 60)).toBeNull();
  repo.budget(a).consume(30); expect(repo.status(job.scope, job.id)!.bytesUsed).toBe(30);
  repo.fail(a, "error", true); const retry = repo.claim(run.id, run.generation, 40)!;
  expect(retry.url).toBe(a.url); repo.fail(retry, "error", true);
  const b = repo.claim(run.id, run.generation, 40)!; repo.fail(b, "error", false);
  expect(repo.claim(run.id, run.generation, 1)).toBeNull();
  expect(repo.status(job.scope, job.id)!.pagesUsed).toBe(2);
 });
 it("fences old capture and settlement across cancel/resume, without reducing consumed limits", () => {
  const { repo, sources, job } = setup(); const run = repo.start(job.id)!; const claim = repo.claim(run.id, run.generation, 80)!;
  repo.budget(claim).consume(10); repo.cancel(job.scope, job.id);
  expect(repo.capture(claim, () => sources.recordRetrieval({ scope: job.scope, origin: "crawl", artifact: artifact("ok"), attempt: attempt() }))).toBe(false);
  expect(repo.fail(claim, "stale", false)).toBe(false);
  expect(() => repo.resume(job.scope, job.id, { maxBytes: 9 })).toThrow();
  repo.resume(job.scope, job.id); expect(repo.status(job.scope, job.id)!.generation).toBeGreaterThan(run.generation);
  expect(sources.list({ scope: job.scope, limit: 10 }).sources).toHaveLength(0);
 });
 it("keeps old-generation cancellation reserves separate from a resumed generation", () => {
  const { repo, job } = setup(); const remote = repo.create({ ...job, backend: "firecrawl", limits: { ...CRAWL_DEFAULT_LIMITS } });
  const old = repo.start(remote.id)!; repo.reserveControl(old.id, old.generation); repo.trackRemote(old.id, old.generation, "old-remote");
  repo.cancel(old.scope, old.id); repo.resume(old.scope, old.id); const current = repo.start(old.id)!; repo.reserveControl(current.id, current.generation);
  const before = repo.available(old.id); repo.cleanupBudget("old-remote").consume(20); repo.remoteDone("old-remote");
  expect(repo.available(old.id)).toBe(before + 1024 - 20);
  repo.trackRemote(current.id, current.generation, "new-remote"); expect(repo.cleanupBudget("new-remote").remaining()).toBe(1024);
  repo.releaseControl(old.id, old.generation); expect(repo.cleanupBudget("new-remote").remaining()).toBe(1024);
 });
 it("reload pauses running work and requeues claims, never automatically resuming", () => {
  let now = 1000; const { db, repo, job } = setup(() => now); const run = repo.start(job.id)!;
  repo.claim(run.id, run.generation, 50); now += 200; repo.heartbeat(run.id, run.generation);
  now += 10000; const reloaded = new SqliteCrawlRepository(db, { now: () => now });
  const status = reloaded.status(job.scope, job.id)!;
  expect(status.state).toBe("paused"); expect(status.counts.queued).toBe(1); expect(status.counts.fetching).toBe(0);
  expect(status.activeDurationMs).toBe(200); expect(status.bytesUsed).toBe(0);
 });
 it("records storage refusal as failed/partial and protects then evicts references", () => {
  const { repo, sources, job } = setup(); const run = repo.start(job.id)!;
  const claim = repo.claim(run.id, run.generation, 40)!;
  expect(repo.capture(claim, () => sources.recordRetrieval({ scope: job.scope, origin: "crawl", artifact: artifact("one"), attempt: attempt() }))).toBe(true);
  const ids = [...repo.protectedSnapshotIds()]; expect(ids).toHaveLength(1);
  repo.finish(run.id, run.generation, "frontier-empty"); expect(repo.protectedSnapshotIds().size).toBe(0);
  repo.beforeSnapshotsDeleted(ids); expect(repo.pages(job.scope, job.id)[0]!.state).toBe("evicted");
 });
 it("protects active snapshots from deletion, then coordinates terminal eviction", async () => {
  const { repo, sources, job } = setup(); const run = repo.start(job.id)!; const claim = repo.claim(job.id, run.generation, 50)!;
  repo.capture(claim, () => sources.recordRetrieval({ scope: job.scope, origin: "crawl", artifact: artifact("saved"), attempt: attempt() }));
  const source = sources.list({ scope: job.scope, limit: 10 }).sources[0]!;
  await expect(sources.deleteSource(job.scope, source.id)).rejects.toMatchObject({ code: "ACTIVE_JOB" });
  repo.cancel(job.scope, job.id); await sources.deleteSource(job.scope, source.id);
  expect(repo.pages(job.scope, job.id)[0]!.state).toBe("evicted"); expect(repo.pages(job.scope, job.id)[0]!.snapshot_id).toBeNull();
 });
 it("fences scope deletion and physically removes jobs and source references", async () => {
  const { repo, sources, job } = setup(); const run = repo.start(job.id)!; const claim = repo.claim(job.id, run.generation, 50)!;
  repo.capture(claim, () => sources.recordRetrieval({ scope: job.scope, origin: "crawl", artifact: artifact("saved"), attempt: attempt() }));
  const receipt = await sources.deleteScope(job.scope);
  expect(receipt.jobs).toBe(1); expect(repo.status(job.scope, job.id)).toBeNull(); expect(sources.list({ scope: job.scope, limit: 10 }).sources).toHaveLength(0);
  expect(repo.valid(claim)).toBe(false);
 });
 it("enforces 20 queued and 200 terminal jobs with oldest terminal retention", () => {
  let now = 1000; const { repo, job } = setup(() => ++now);
  for (let i = 1; i < 20; i++) repo.create(job);
  expect(() => repo.create(job)).toThrow(/queue limit/);
  for (const queued of repo.list({ scope: job.scope, limit: 100 }).jobs) repo.cancel(job.scope, queued.id);
  for (let i = 0; i < 200; i++) { const next = repo.create(job); repo.cancel(job.scope, next.id); }
  expect(repo.status(job.scope, job.id)).toBeNull();
  const first = repo.list({ scope: job.scope, limit: 100 }); const second = repo.list({ scope: job.scope, limit: 100, cursor: first.nextCursor! });
  expect(first.jobs.length + second.jobs.length).toBe(200); expect(second.nextCursor).toBeNull();
 });
 it("persists claims, payload accounting and fences across a file-backed SQLite reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "forage-j5-")); const file = join(directory, "crawl.sqlite");
  let db = new Database(file);
  try {
   configureSourceDatabase(db); for (const sql of FORAGE_MIGRATIONS) db.exec(sql);
   const repo = new SqliteCrawlRepository(db); const job = repo.create({ scope: threadScope(), rootUrl: "https://example.com/", includePaths: [], excludePaths: [], includeSubdomains: false, backend: "local", limits: { ...CRAWL_DEFAULT_LIMITS } });
   const run = repo.start(job.id)!; const claim = repo.claim(job.id, run.generation, 100)!; repo.budget(claim).consume(40); db.close();
   db = new Database(file); configureSourceDatabase(db); const reload = new SqliteCrawlRepository(db);
   expect(reload.status(job.scope, job.id)).toMatchObject({ state: "paused", bytesUsed: 40, pagesUsed: 1 });
   expect(reload.valid(claim)).toBe(false); expect(reload.available(job.id)).toBe(job.limits.maxBytes - 40);
  } finally { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); }
 });
 it("caps logical job/frontier metadata at 32 MiB and reports omitted URLs", () => {
  const { db, repo, job } = setup(); const first = repo.create({ ...job, limits: { ...CRAWL_DEFAULT_LIMITS, maxPages: 200 } });
  const second = repo.create({ ...job, limits: { ...CRAWL_DEFAULT_LIMITS, maxPages: 200 } });
  for (const next of [first, second]) {
   const run = repo.start(next.id)!;
   repo.enqueue(run.id, run.generation, Array.from({ length: 1999 }, (_, i) => `https://example.com/${i}-${"x".repeat(8000)}`), 1);
  }
  const bytes = (db.prepare("SELECT (SELECT SUM(LENGTH(CAST(request_json AS BLOB)) + 1024) FROM forage_crawl_jobs) + (SELECT SUM(LENGTH(CAST(url AS BLOB)) + 512) FROM forage_crawl_pages) AS n").get() as { n: number }).n;
  expect(bytes).toBeLessThanOrEqual(32 * 1024 * 1024); expect(repo.omissions(second.id)).toBeGreaterThan(0);
 });
 it("prunes expired metadata but preserves active jobs", async () => {
  const { repo, job } = setup(); repo.cancel(job.scope, job.id); const active = repo.create(job);
  expect(await repo.pruneJobs({ completedBefore: 2000, failedBefore: 2000 })).toBe(1);
  expect(repo.status(job.scope, active.id)!.state).toBe("queued");
 });
 it("reload turns cancelling into cancelled and keeps its finish timestamp", () => {
  const { db, repo, job } = setup(); const run = repo.start(job.id)!;
  db.prepare("UPDATE forage_crawl_jobs SET state = 'cancelling' WHERE id = ?").run(job.id);
  const reload = new SqliteCrawlRepository(db);
  expect(reload.status(job.scope, job.id)).toMatchObject({ state: "cancelled", stopReason: "cancelled", finishedAt: 1000, generation: run.generation + 1 });
 });
 it("bounds the frontier and returns explicit omissions", () => {
  const { repo, job } = setup(); const run = repo.start(job.id)!;
  repo.enqueue(run.id, run.generation, Array.from({ length: 30 }, (_, i) => `https://example.com/${i}`), 1);
  expect(repo.pages(job.scope, job.id)).toHaveLength(20);
  expect(repo.omissions(job.id)).toBeGreaterThan(0);
 });
});
