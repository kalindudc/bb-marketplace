// Loom's database keeps check output, posts and pull request text, so only its owner may read it.
import { chmodSync, existsSync } from "node:fs";
import type Database from "better-sqlite3";

/** Sets mode 0600 on the database file and on its -wal and -shm files where they exist; SQLite gives files it makes later the database's mode. */
export function keepPrivate(db: Database.Database): void {
  if (db.memory) return;
  for (const path of [db.name, `${db.name}-wal`, `${db.name}-shm`]) if (existsSync(path)) chmodSync(path, 0o600);
}
