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
  `ALTER TABLE prs ADD COLUMN labels TEXT`,
  `ALTER TABLE prs ADD COLUMN reviewers TEXT`,
  `ALTER TABLE prs ADD COLUMN viewed_at INTEGER`,
  // 0.3: agents, tracking, snoozes, AI review drafts, the conversation's outcomes and Insights.
  `ALTER TABLE prs ADD COLUMN tracked INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE prs ADD COLUMN snoozed_until INTEGER`,
  `ALTER TABLE prs ADD COLUMN handled_sig TEXT`,
  `ALTER TABLE prs ADD COLUMN created_at INTEGER`,
  `ALTER TABLE prs ADD COLUMN closed_at INTEGER`,
  `ALTER TABLE prs ADD COLUMN check_counts TEXT`,
  `ALTER TABLE prs ADD COLUMN my_review TEXT`,
  `ALTER TABLE prs ADD COLUMN auto_merge INTEGER`,
  `ALTER TABLE prs ADD COLUMN author_bot INTEGER`,
  `ALTER TABLE prs ADD COLUMN requested_at INTEGER`,
  `ALTER TABLE prs ADD COLUMN first_review_at INTEGER`,
  `ALTER TABLE prs ADD COLUMN suggested_thread TEXT`,
  `ALTER TABLE prs ADD COLUMN suggested_why TEXT`,
  `ALTER TABLE links ADD COLUMN auto INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE threads ADD COLUMN status TEXT`,
  `ALTER TABLE threads ADD COLUMN waiting INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE review_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    review_id INTEGER,
    head TEXT,
    summary TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('comment', 'approve', 'changes')),
    findings TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('draft', 'posted', 'discarded')),
    created_at INTEGER NOT NULL,
    posted_at INTEGER,
    posted_findings INTEGER
  )`,
  `CREATE INDEX review_drafts_pr ON review_drafts (pr_id)`,
  `CREATE TABLE my_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    head TEXT,
    at INTEGER NOT NULL,
    findings INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX my_reviews_pr ON my_reviews (pr_id)`,
  `CREATE TABLE sent_items (pr_id INTEGER NOT NULL, item_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (pr_id, item_id, thread_id))`,
  `CREATE TABLE outcomes (
    pr_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('fixed', 'replied', 'declined', 'question')),
    note TEXT,
    commit_sha TEXT,
    thread_id TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (pr_id, item_id)
  )`,
  `CREATE TABLE requests (pr_id INTEGER NOT NULL, reason TEXT NOT NULL, first_seen INTEGER NOT NULL, gone_at INTEGER, PRIMARY KEY (pr_id, reason, first_seen))`,
  `INSERT INTO requests (pr_id, reason, first_seen) SELECT pr_id, reason, since FROM reasons WHERE reason IN ('requested', 'team', 'mentioned')`,
  `CREATE TABLE snapshots (day TEXT PRIMARY KEY, counts TEXT NOT NULL)`,
  `CREATE TABLE phases (pr_id INTEGER NOT NULL, phase TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER)`,
  `CREATE INDEX phases_pr ON phases (pr_id)`,
  // Tracking replaces watching for other people's PRs, and a PR has at most one agent (its owner link).
  `UPDATE prs SET tracked = 1 WHERE mine = 0 AND id IN (SELECT pr_id FROM watches)`,
  `DELETE FROM watches WHERE pr_id IN (SELECT id FROM prs WHERE mine = 0)`,
  `UPDATE links SET role = 'reference' WHERE role = 'owner' AND rowid NOT IN (SELECT MAX(rowid) FROM links WHERE role = 'owner' GROUP BY pr_id)`,
  `DELETE FROM watches WHERE pr_id NOT IN (SELECT pr_id FROM links WHERE role = 'owner')`,
  // What 0.2 saw on a watched PR may have gone to its owner; record it so turning the agent off and on never sends it again.
  `INSERT OR IGNORE INTO sent_items (pr_id, item_id, thread_id, at) SELECT s.pr_id, s.item_id, l.thread_id, 0 FROM seen_items s JOIN links l ON l.pr_id = s.pr_id AND l.role = 'owner' JOIN watches w ON w.pr_id = s.pr_id`,
  // The reasons table's CHECK predates the reviewed list, and SQLite can't change a CHECK in place.
  `CREATE TABLE reasons_v3 (
    pr_id INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('authored', 'requested', 'team', 'mentioned', 'reviewed')),
    teams TEXT NOT NULL DEFAULT '[]',
    since INTEGER NOT NULL,
    PRIMARY KEY (pr_id, reason)
  )`,
  `INSERT INTO reasons_v3 (pr_id, reason, teams, since) SELECT pr_id, reason, teams, since FROM reasons`,
  `DROP TABLE reasons`,
  `ALTER TABLE reasons_v3 RENAME TO reasons`,
  // 0.3.2: review threads Shuttle started are archived once their review is done, and brought back for the next one.
  `ALTER TABLE reviews ADD COLUMN own_thread INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE reviews ADD COLUMN archived_at INTEGER`,
  // A thread's first review that left it a review link was one Shuttle spawned; a reused owner or reference thread keeps its role.
  `UPDATE reviews SET own_thread = 1 WHERE id IN (SELECT MIN(id) FROM reviews GROUP BY thread_id)
    AND EXISTS (SELECT 1 FROM links l WHERE l.pr_id = reviews.pr_id AND l.thread_id = reviews.thread_id AND l.role = 'review')`,
  `UPDATE reviews SET own_thread = 1 WHERE thread_id IN (SELECT thread_id FROM reviews WHERE own_thread = 1)`,
  // 0.3.6: a sync that failed only some lists is partial, and each sync keeps why each step failed.
  `ALTER TABLE servers ADD COLUMN state TEXT`,
  `UPDATE servers SET state = CASE ok WHEN 1 THEN 'ok' WHEN 0 THEN 'failed' END`,
  `ALTER TABLE servers ADD COLUMN failures INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE servers ADD COLUMN failing_since INTEGER`,
  `UPDATE servers SET failures = 1, failing_since = last_sync_at WHERE ok = 0`,
  `ALTER TABLE servers ADD COLUMN steps_ok_at TEXT`,
  `ALTER TABLE servers ADD COLUMN failed_steps TEXT`,
  `CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server TEXT NOT NULL,
    at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ok', 'partial', 'failed')),
    steps TEXT NOT NULL
  )`,
  `CREATE INDEX sync_runs_server ON sync_runs (server, at)`,
  // 0.3.9: saved boards of explicit PR memberships, with stable ids and activity.
  `CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    created_by TEXT
  )`,
  `CREATE TABLE board_members (
    board_id TEXT NOT NULL,
    pr_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, pr_id)
  )`,
  `CREATE INDEX board_members_board ON board_members (board_id, position)`,
  `CREATE INDEX board_members_pr ON board_members (pr_id, board_id)`,
  `CREATE TABLE board_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    text TEXT NOT NULL,
    thread_id TEXT
  )`,
  `CREATE INDEX board_activity_board ON board_activity (board_id, id)`,
  // The Inbox rework: dismissed_at was always a snooze's start, and a dismissal from the Inbox is its own column.
  `ALTER TABLE prs RENAME COLUMN dismissed_at TO snoozed_at`,
  `ALTER TABLE prs ADD COLUMN inbox_dismissed_at INTEGER`,
  `ALTER TABLE prs ADD COLUMN seen_at INTEGER`,
  // PRs stored before seen state existed count as seen, so the upgrade does not mark them all new.
  `UPDATE prs SET seen_at = COALESCE(updated_at, fetched_at)`,
  `CREATE TABLE inbox_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('author', 'repo', 'mention')),
    server TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (kind, server, value)
  )`,
];
