export const QUESTLOG_MIGRATIONS: string[] = [
  `CREATE TABLE questlog_logs (
    thread_id TEXT PRIMARY KEY,
    next_id INTEGER NOT NULL DEFAULT 576,
    hydrated INTEGER NOT NULL DEFAULT 0,
    agent_changed_at INTEGER,
    noted_at INTEGER,
    last_tool_at INTEGER
  );
  CREATE TABLE questlog_entries (
    thread_id TEXT NOT NULL REFERENCES questlog_logs(thread_id),
    id TEXT NOT NULL,
    board_quest_id TEXT,
    data TEXT NOT NULL,
    PRIMARY KEY (thread_id, id)
  );
  CREATE INDEX questlog_board ON questlog_entries(board_quest_id);
  CREATE TABLE questlog_reserved (
    thread_id TEXT NOT NULL REFERENCES questlog_logs(thread_id),
    id TEXT NOT NULL,
    PRIMARY KEY (thread_id, id)
  );
  CREATE TABLE questlog_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES questlog_logs(thread_id),
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entry_ids TEXT NOT NULL,
    text TEXT NOT NULL,
    seen INTEGER NOT NULL
  );
  CREATE INDEX questlog_changes_thread ON questlog_changes(thread_id, id);
  CREATE TABLE questlog_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES questlog_logs(thread_id),
    before_data TEXT NOT NULL,
    after_data TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('undo', 'redo'))
  );
  CREATE INDEX questlog_history_thread ON questlog_history(thread_id, state, id);`,
];
