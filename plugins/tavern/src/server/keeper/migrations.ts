export const KEEPER_MIGRATIONS = [
  `CREATE TABLE tavern_records (
    kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    PRIMARY KEY(kind, id)
  );
  CREATE TABLE tavern_runtime (thread_id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE TABLE tavern_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, keeper_thread_id TEXT,
    board_quest_id TEXT, actor TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX tavern_events_keeper ON tavern_events(keeper_thread_id, id);
  CREATE INDEX tavern_events_quest ON tavern_events(board_quest_id, id);
  CREATE TRIGGER tavern_events_no_update BEFORE UPDATE ON tavern_events BEGIN SELECT RAISE(ABORT, 'Tavern events are append-only'); END;
  CREATE TRIGGER tavern_events_no_delete BEFORE DELETE ON tavern_events BEGIN SELECT RAISE(ABORT, 'Tavern events are append-only'); END;`,
];
