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
  // The review queue: posting a review returns at once, and Shuttle posts it in the background, one at a time per server.
  `CREATE TABLE review_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL,
    server TEXT NOT NULL,
    draft_id INTEGER,
    verdict TEXT NOT NULL CHECK (verdict IN ('comment', 'approve', 'changes')),
    body TEXT NOT NULL,
    findings TEXT NOT NULL,
    stale_ok INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('queued', 'posting', 'posted', 'failed', 'cancelled')),
    error TEXT,
    placed INTEGER,
    in_body INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    cleared_at INTEGER
  )`,
  `CREATE INDEX review_posts_pr ON review_posts (pr_id, id)`,
  `CREATE INDEX review_posts_state ON review_posts (state, server, id)`,
  // A review's notes for the user: shown beside its draft and never posted.
  `ALTER TABLE review_drafts ADD COLUMN notes TEXT`,
  // The bots a watch last heard from: a JSON list of logins and globs, or "*" for every bot. NULL is none, as Ignore bots had it.
  `ALTER TABLE watches ADD COLUMN bots TEXT`,
  // The merge queue: merging one of your PRs returns at once, and Shuttle merges it in the background, one at a time per server.
  `CREATE TABLE merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL,
    server TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('squash', 'merge', 'rebase')),
    head TEXT NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    delete_branch INTEGER NOT NULL DEFAULT 0,
    subject TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'merging', 'done', 'failed', 'cancelled')),
    outcome TEXT CHECK (outcome IN ('merged', 'auto_merge', 'sent')),
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    cleared_at INTEGER
  )`,
  `CREATE INDEX merges_pr ON merges (pr_id, id)`,
  `CREATE INDEX merges_state ON merges (state, server, id)`,
  // A review run ends when its thread hands back a draft, says it is over, fails, or goes quiet; a turn that ends does not.
  `ALTER TABLE reviews ADD COLUMN active_at INTEGER`,
  `ALTER TABLE reviews ADD COLUMN ended_by TEXT`,
  `ALTER TABLE reviews ADD COLUMN note TEXT`,
  // Whether the PR waits in the repository's own merge queue, such as GitHub's; NULL while the server has not said.
  `ALTER TABLE prs ADD COLUMN in_merge_queue INTEGER`,
  // Auto post: the reviewer's view of the PR, the gate's decision, what the user did with each finding, and why a draft was discarded.
  `ALTER TABLE review_drafts ADD COLUMN assessment TEXT`,
  `ALTER TABLE review_drafts ADD COLUMN gate TEXT`,
  `ALTER TABLE review_drafts ADD COLUMN outcome TEXT`,
  `ALTER TABLE review_drafts ADD COLUMN discard_reason TEXT CHECK (discard_reason IN ('user', 'superseded'))`,
  // The verdict the user posted from a draft, which may differ from the one the review suggested.
  `ALTER TABLE review_drafts ADD COLUMN posted_verdict TEXT CHECK (posted_verdict IN ('comment', 'approve', 'changes'))`,
  // Drafts posted before this: the review the user posted closest to it, within a minute.
  // The gap is a column of its own because older SQLite cannot read the outer row in a correlated ORDER BY.
  `UPDATE review_drafts SET posted_verdict = (SELECT verdict FROM (SELECT m.verdict, abs(m.at - review_drafts.posted_at) AS gap, m.id FROM my_reviews m WHERE m.pr_id = review_drafts.pr_id AND m.verdict IN ('comment', 'approve', 'changes') AND m.at BETWEEN review_drafts.posted_at - 60000 AND review_drafts.posted_at + 60000) ORDER BY gap, id LIMIT 1) WHERE state = 'posted'`,
  // The options a review run started with, so a run whose thread could not set up its workspace starts again in a new one,
  // and which try of that review the run is.
  `ALTER TABLE reviews ADD COLUMN input TEXT`,
  `ALTER TABLE reviews ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1`,
  // Auto post's schedule for a draft in a repository that posts: when, as what, and what became of it.
  `ALTER TABLE review_drafts ADD COLUMN auto_post_state TEXT CHECK (auto_post_state IN ('scheduled', 'stopped', 'queued', 'posted', 'refused'))`,
  `ALTER TABLE review_drafts ADD COLUMN auto_post_at INTEGER`,
  `ALTER TABLE review_drafts ADD COLUMN auto_post_verdict TEXT CHECK (auto_post_verdict IN ('comment', 'approve'))`,
  `ALTER TABLE review_drafts ADD COLUMN auto_post_reason TEXT`,
  // When the user marked an approval Shuttle posted as a mistake.
  `ALTER TABLE review_drafts ADD COLUMN approval_mistake_at INTEGER`,
  // Breaker trips: posting of one kind stops in a repository entry until the user resumes it. The config is left alone.
  `CREATE TABLE auto_post_trips (
    id INTEGER PRIMARY KEY,
    repo TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('comment', 'approve')),
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    cleared_at INTEGER
  )`,
  `CREATE INDEX review_drafts_auto_post ON review_drafts (auto_post_state, auto_post_at)`,
  // A review auto post queued, as opposed to one the user posted.
  `ALTER TABLE review_posts ADD COLUMN auto INTEGER NOT NULL DEFAULT 0`,
  // The auto post settings a schedule was checked under; a review whose settings changed since does not post.
  `ALTER TABLE review_drafts ADD COLUMN auto_post_policy TEXT`,
  // The findings a schedule posts, by id, so a check again that changes them starts a new countdown and says so.
  `ALTER TABLE review_drafts ADD COLUMN auto_post_findings TEXT`,
  // What review threads and the threads under them used, as the Burn plugin reads it: each thread's totals over its life,
  // and every turn Shuttle has seen, since Burn lists only a thread's latest turns. root_id is the review thread a thread
  // counts toward: itself, or the review thread above a critic.
  `CREATE TABLE usage_threads (
    thread_id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    started_at INTEGER,
    updated_at INTEGER,
    calls INTEGER NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    read_at INTEGER NOT NULL
  )`,
  `CREATE INDEX usage_threads_root ON usage_threads (root_id)`,
  `CREATE TABLE usage_turns (
    thread_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    at INTEGER NOT NULL,
    calls INTEGER NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cost REAL NOT NULL,
    model TEXT,
    PRIMARY KEY (thread_id, n)
  )`,
  `ALTER TABLE reviews ADD COLUMN cleanup_requested_at INTEGER`,
  `ALTER TABLE reviews ADD COLUMN cleanup_finished_at INTEGER`,
  // A watch is on or it is not: the old mode that only sent without asking the thread to act is now the same watch.
  `UPDATE watches SET mode = 'act' WHERE mode = 'forward'`,
  `UPDATE kv SET value = json_set(value, '$.watch.mode', 'act') WHERE key = 'config' AND json_valid(value) AND json_extract(value, '$.watch.mode') = 'forward'`,
  `CREATE TABLE reference_resolutions (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, message_id TEXT NOT NULL, text_hash TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX reference_resolutions_updated ON reference_resolutions(updated_at)`,
  `CREATE TABLE reference_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, reference_id TEXT NOT NULL, action TEXT NOT NULL, before_url TEXT, after_url TEXT, at INTEGER NOT NULL)`,
  // When a full list first left out a PR that has the reason; it keeps the reason until Shuttle can tell the server sees the PR.
  `ALTER TABLE reasons ADD COLUMN unlisted_since INTEGER`,
  // References became one record per thread and number; the per-message log kept before that starts over.
  `DELETE FROM reference_feedback`,
  `DELETE FROM reference_resolutions`,
  `CREATE INDEX prs_number ON prs (number)`,
];
