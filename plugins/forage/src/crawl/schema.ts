import { SOURCE_MIGRATIONS } from "../sources/schema.ts";

export const CRAWL_MIGRATIONS: readonly string[] = [
 `CREATE TABLE forage_crawl_jobs (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, request_json TEXT NOT NULL,
  state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
  pages_used INTEGER NOT NULL DEFAULT 0, bytes_used INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
  active_since INTEGER, created_at INTEGER NOT NULL, started_at INTEGER,
  updated_at INTEGER NOT NULL, finished_at INTEGER, stop_reason TEXT, error TEXT,
  omitted INTEGER NOT NULL DEFAULT 0, discovered INTEGER NOT NULL DEFAULT 0,
  vendor_id TEXT, vendor_next TEXT, vendor_done INTEGER NOT NULL DEFAULT 0,
  vendor_pending_cancel INTEGER NOT NULL DEFAULT 0
 )`,
 `CREATE INDEX forage_crawl_scope ON forage_crawl_jobs(scope_key, created_at DESC, id DESC)`,
 `CREATE INDEX forage_crawl_state ON forage_crawl_jobs(state, created_at)`,
 `CREATE TABLE forage_crawl_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES forage_crawl_jobs(id) ON DELETE CASCADE,
  url TEXT NOT NULL, depth INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT, generation INTEGER,
  reserved INTEGER NOT NULL DEFAULT 0, error TEXT,
  source_id TEXT REFERENCES forage_sources(id) ON DELETE SET NULL,
  snapshot_id TEXT REFERENCES forage_snapshots(id) ON DELETE SET NULL,
  retrieval_id TEXT REFERENCES forage_retrievals(id) ON DELETE SET NULL,
  UNIQUE(job_id, url)
 )`,
 `CREATE INDEX forage_crawl_frontier ON forage_crawl_pages(job_id, state, depth, id)`,
 `CREATE INDEX forage_crawl_snapshot ON forage_crawl_pages(snapshot_id)`,
 `CREATE TABLE forage_crawl_reservations (token TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES forage_crawl_jobs(id) ON DELETE CASCADE, generation INTEGER NOT NULL, reserved INTEGER NOT NULL)`,
 `CREATE TABLE forage_crawl_remote (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES forage_crawl_jobs(id), generation INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 1)`,
 `CREATE INDEX forage_crawl_remote_job ON forage_crawl_remote(job_id, pending)`,
 `ALTER TABLE forage_crawl_jobs ADD COLUMN control_reserved INTEGER NOT NULL DEFAULT 0`,
 `CREATE TABLE forage_crawl_control (job_id TEXT NOT NULL REFERENCES forage_crawl_jobs(id) ON DELETE CASCADE, generation INTEGER NOT NULL, reserved INTEGER NOT NULL, PRIMARY KEY(job_id, generation))`,
];

export const FORAGE_MIGRATIONS: readonly string[] = [...SOURCE_MIGRATIONS, ...CRAWL_MIGRATIONS];
