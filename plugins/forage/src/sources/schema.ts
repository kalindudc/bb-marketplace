import type Database from "better-sqlite3";

export const SOURCE_MIGRATIONS: readonly string[] = [
	`CREATE TABLE forage_sources (
		id TEXT PRIMARY KEY,
		scope_key TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('thread', 'project')),
		project_id TEXT NOT NULL,
		thread_id TEXT,
		normalized_url TEXT NOT NULL,
		display_url TEXT NOT NULL,
		canonical_url TEXT,
		access_network TEXT NOT NULL CHECK (access_network IN ('public', 'private')),
		access_credentialed INTEGER NOT NULL CHECK (access_credentialed IN (0, 1)),
		request_scope_key TEXT,
		title TEXT NOT NULL,
		latest_snapshot_id TEXT,
		last_retrieved_at INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1)),
		UNIQUE (scope_key, normalized_url)
	)`,
	`CREATE INDEX forage_sources_scope_updated ON forage_sources (scope_key, deleting, updated_at DESC, id DESC)`,
	`CREATE TABLE forage_snapshots (
		id TEXT PRIMARY KEY,
		source_id TEXT NOT NULL REFERENCES forage_sources(id),
		kind TEXT NOT NULL CHECK (kind IN ('html', 'markdown', 'text', 'json', 'pdf', 'github-api')),
		content_type TEXT NOT NULL,
		content TEXT NOT NULL,
		structured_json TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		snapshot_hash TEXT NOT NULL,
		extractor_id TEXT NOT NULL,
		extractor_version TEXT NOT NULL,
		truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
		content_bytes INTEGER NOT NULL,
		structured_bytes INTEGER NOT NULL,
		fetched_at INTEGER NOT NULL,
		completeness_json TEXT NOT NULL,
		warnings_json TEXT NOT NULL,
		UNIQUE (source_id, snapshot_hash)
	)`,
	`CREATE INDEX forage_snapshots_source_fetched ON forage_snapshots (source_id, fetched_at DESC, id DESC)`,
	`CREATE TABLE forage_retrievals (
		id TEXT PRIMARY KEY,
		source_id TEXT NOT NULL REFERENCES forage_sources(id),
		snapshot_id TEXT REFERENCES forage_snapshots(id) ON DELETE SET NULL,
		origin TEXT NOT NULL CHECK (origin IN ('fetch', 'search-content', 'map', 'crawl', 'extract', 'diff', 'import')),
		status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'unknown', 'failed')),
		requested_url TEXT NOT NULL,
		resolved_url TEXT,
		final_url TEXT,
		transport TEXT CHECK (transport IN ('direct', 'github-smart', 'provider')),
		representation TEXT CHECK (representation IN ('readable', 'raw')),
		access_network TEXT NOT NULL CHECK (access_network IN ('public', 'private')),
		access_credentialed INTEGER NOT NULL CHECK (access_credentialed IN (0, 1)),
		request_scope_key TEXT,
		http_status INTEGER NOT NULL,
		artifact_bytes INTEGER,
		redirects INTEGER,
		diagnostics_json TEXT,
		completeness_json TEXT,
		warnings_json TEXT,
		started_at INTEGER NOT NULL,
		finished_at INTEGER NOT NULL,
		transferred_bytes INTEGER NOT NULL,
		cache_state TEXT NOT NULL CHECK (cache_state IN ('miss', 'hit', 'revalidated')),
		error TEXT
	)`,
	`CREATE INDEX forage_retrievals_source_finished ON forage_retrievals (source_id, finished_at DESC, id DESC)`,
	`CREATE INDEX forage_retrievals_snapshot_finished ON forage_retrievals (snapshot_id, finished_at DESC)`,
	`CREATE TABLE forage_discovery_links (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		scope_key TEXT NOT NULL,
		from_source_id TEXT REFERENCES forage_sources(id) ON DELETE SET NULL,
		method TEXT NOT NULL CHECK (method IN ('robots', 'sitemap', 'sitemap-index', 'llms', 'html-link', 'provider')),
		url TEXT NOT NULL,
		parent_url TEXT NOT NULL,
		title TEXT,
		last_modified TEXT,
		observed_at INTEGER NOT NULL,
		UNIQUE (scope_key, from_source_id, method, url, parent_url)
	)`,
	`CREATE UNIQUE INDEX forage_discovery_unique ON forage_discovery_links (scope_key, IFNULL(from_source_id, ''), method, url, parent_url)`,
	`CREATE INDEX forage_discovery_scope_observed ON forage_discovery_links (scope_key, observed_at DESC, id DESC)`,
	`CREATE TABLE forage_snapshot_tombstones (
		id TEXT PRIMARY KEY,
		scope_key TEXT NOT NULL,
		source_id TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		reason TEXT NOT NULL CHECK (reason IN ('expired', 'storage-limit', 'source-deleted', 'scope-deleted')),
		deleted_at INTEGER NOT NULL
	)`,
	`CREATE INDEX forage_snapshot_tombstones_scope ON forage_snapshot_tombstones (scope_key, deleted_at DESC)`,
	`CREATE TABLE forage_scope_deletions (
		scope_key TEXT PRIMARY KEY,
		scope_json TEXT NOT NULL,
		started_at INTEGER NOT NULL
	)`,
	`ALTER TABLE forage_snapshots ADD COLUMN retained_at INTEGER NOT NULL DEFAULT 0`,
	`UPDATE forage_snapshots SET retained_at = MAX(fetched_at, COALESCE((SELECT MAX(finished_at) FROM forage_retrievals WHERE snapshot_id = forage_snapshots.id), fetched_at))`,
	`CREATE INDEX forage_snapshots_retained ON forage_snapshots (retained_at, id)`,
	`CREATE INDEX forage_retrievals_finished ON forage_retrievals (finished_at, id)`,
	`CREATE INDEX forage_snapshot_tombstones_source ON forage_snapshot_tombstones (source_id)`,
	`ALTER TABLE forage_snapshot_tombstones ADD COLUMN retained_at INTEGER NOT NULL DEFAULT 0`,
	`CREATE INDEX forage_snapshot_tombstones_retained ON forage_snapshot_tombstones (retained_at, id)`,
	`CREATE INDEX forage_discovery_observed ON forage_discovery_links (observed_at, id)`,
];

export function configureSourceDatabase(db: Database.Database): void {
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma("secure_delete = ON");
	db.pragma("busy_timeout = 5000");
}
