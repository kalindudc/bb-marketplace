import { chmod, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function isLockError(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  return code === 5 || code === 6 || /database is locked|database table is locked|SQLITE_BUSY/i.test(String((error as Error).message));
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export type SnapshotMethod = "vacuum" | "copy";

/**
 * Open a consistent private copy of a database another process has open. `VACUUM INTO` reads under a shared lock, so
 * it never sees a half-written page; a browser that holds an exclusive lock (Firefox can) refuses that, so the files
 * are copied instead, with their journal or WAL so SQLite replays or rolls back what was in flight. The copy lives in a
 * 0700 directory under `tempRoot` and is deleted before this returns.
 */
export async function withSnapshot<T>(
  path: string,
  tempRoot: string,
  use: (database: DatabaseSync, method: SnapshotMethod) => T | Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tempRoot, "snapshot-"));
  await chmod(directory, 0o700);
  try {
    let target = join(directory, "snapshot.sqlite");
    let method: SnapshotMethod = "vacuum";
    try {
      const source = new DatabaseSync(path, { readOnly: true, timeout: 2_000 });
      try {
        source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      } finally {
        source.close();
      }
    } catch (error) {
      if (!isLockError(error)) throw error;
      method = "copy";
      target = join(directory, basename(path));
      await copyFile(path, target);
      for (const suffix of ["-wal", "-journal"]) {
        if (await exists(path + suffix)) await copyFile(path + suffix, target + suffix);
      }
    }
    const database = new DatabaseSync(target, { readOnly: method === "vacuum" });
    try {
      return await use(database, method);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
