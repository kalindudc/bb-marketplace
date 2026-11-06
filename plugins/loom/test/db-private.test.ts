// @vitest-environment node
import Database from "better-sqlite3";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { keepPrivate } from "../src/db/private";

const dir = mkdtempSync(join(tmpdir(), "loom-db-private-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const mode = (path: string) => statSync(path).mode & 0o777;

describe("keepPrivate", () => {
  it("makes the database and its -wal and -shm files readable by their owner alone", () => {
    const file = join(dir, "data.db");
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('check output')");
    for (const path of [`${file}-wal`, `${file}-shm`]) chmodSync(path, 0o644);
    keepPrivate(db);
    expect([file, `${file}-wal`, `${file}-shm`].map(mode)).toEqual([0o600, 0o600, 0o600]);
    db.close();
    const again = new Database(file);
    again.exec("INSERT INTO t VALUES ('more')");
    expect([`${file}-wal`, `${file}-shm`].map(mode)).toEqual([0o600, 0o600]);
    again.close();
  });

  it("leaves an in-memory database alone, and a database whose -wal and -shm do not exist yet", () => {
    expect(() => keepPrivate(new Database(":memory:"))).not.toThrow();
    const file = join(dir, "fresh.db");
    const db = new Database(file);
    keepPrivate(db);
    expect(mode(file)).toBe(0o600);
    db.close();
  });
});
