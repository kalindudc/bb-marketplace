// SQLite schema: append-only migrations, never edit a shipped statement. Times are epoch milliseconds.
export const MIGRATIONS: string[] = [
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE servers (
    id TEXT PRIMARY KEY,
    ok INTEGER,
    login TEXT,
    error TEXT,
    last_ok_at INTEGER,
    last_sync_at INTEGER,
    duration_ms INTEGER,
    baseline_at INTEGER
  )`,
  `CREATE TABLE prs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    server TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'draft', 'merged', 'closed')),
    checks TEXT NOT NULL CHECK (checks IN ('passed', 'failed', 'pending', 'none')),
    review TEXT NOT NULL CHECK (review IN ('approved', 'changes', 'required', 'none')),
    head TEXT,
    head_ref TEXT,
    base TEXT,
    additions INTEGER,
    deletions INTEGER,
    files INTEGER,
    updated_at INTEGER,
    mine INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL,
    dismissed_at INTEGER
  )`,
  `CREATE INDEX prs_server ON prs (server)`,
  `CREATE TABLE reasons (
    pr_id INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('authored', 'requested', 'team', 'mentioned')),
    teams TEXT NOT NULL DEFAULT '[]',
    since INTEGER NOT NULL,
    PRIMARY KEY (pr_id, reason)
  )`,
  `CREATE TABLE links (
    pr_id INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'review', 'reference')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (pr_id, thread_id)
  )`,
  `CREATE INDEX links_thread ON links (thread_id)`,
  `CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE watches (
    pr_id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('act', 'forward')),
    baselined INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    checked_at INTEGER,
    error TEXT
  )`,
  `CREATE TABLE seen_items (pr_id INTEGER NOT NULL, item_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (pr_id, item_id))`,
  `CREATE TABLE pending_items (pr_id INTEGER NOT NULL, item_id TEXT NOT NULL, item TEXT NOT NULL, first_seen_at INTEGER NOT NULL, PRIMARY KEY (pr_id, item_id))`,
  `CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    preset TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
    head TEXT,
    state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed')),
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE INDEX reviews_pr ON reviews (pr_id)`,
  `CREATE INDEX reviews_thread ON reviews (thread_id)`,
  `CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    pr_id INTEGER,
    thread_id TEXT
  )`,
  `CREATE INDEX events_pr ON events (pr_id)`,
  `CREATE INDEX events_thread ON events (thread_id)`,
  `CREATE TABLE deliveries (pr_id INTEGER NOT NULL, item_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (pr_id, item_id, thread_id))`,
  `ALTER TABLE prs ADD COLUMN body TEXT`,
];
