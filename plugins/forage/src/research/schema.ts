// Appended after the source and crawl migrations; existing databases run only these.
export const RESEARCH_MIGRATIONS: readonly string[] = [
 `CREATE TABLE forage_activity (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent', 'person')),
  operation TEXT NOT NULL CHECK (operation IN ('search', 'fetch', 'map', 'extract', 'crawl', 'diff', 'save')),
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failure', 'cancelled')),
  items INTEGER NOT NULL DEFAULT 0,
  restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL
 )`,
 `CREATE INDEX forage_activity_scope ON forage_activity (scope_key, finished_at DESC, id DESC)`,
 `CREATE INDEX forage_activity_finished ON forage_activity (finished_at, id)`,
 `CREATE TABLE forage_source_actors (
  source_id TEXT PRIMARY KEY REFERENCES forage_sources(id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK (actor IN ('agent', 'person')),
  via TEXT,
  first_at INTEGER NOT NULL
 )`,
 `CREATE TABLE forage_citations (
  source_id TEXT NOT NULL REFERENCES forage_sources(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  noted_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, message_id, start_line, end_line)
 )`,
 `CREATE INDEX forage_crawl_pages_source ON forage_crawl_pages (source_id)`,
];
