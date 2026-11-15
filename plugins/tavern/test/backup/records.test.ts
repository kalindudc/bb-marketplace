// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { SettingsStore } from "../../src/server/settings/store";
import { BackupRecords } from "../../src/server/backup/records";

function setup() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const settings = new SettingsStore(db, () => 12345);
  return { db, settings, records: new BackupRecords(db, settings) };
}
function populate(f: ReturnType<typeof setup>) {
  f.db.prepare("INSERT INTO questlog_logs(thread_id,next_id,hydrated) VALUES('thread',33,1)").run();
  f.db.prepare("INSERT INTO questlog_reserved(thread_id,id) VALUES('thread','20')").run();
  f.db.prepare("INSERT INTO tavern_events(at,keeper_thread_id,board_quest_id,actor,type,text,data) VALUES(1,NULL,NULL,?,?,?,?)").run('{"kind":"tavern"}', "backup.fixture", "A private note", '{}');
}
describe("Tavern records snapshots", () => {
  it("round-trips a soft-deleted quest until its purge", () => {
    const source = setup(), target = setup();
    const quest = { id: "deleted-quest", keeperThreadId: "keeper", title: "Private work", short: "Private work", phase: "done", planVersion: 0, greenlitVersion: null, createdAt: 1, updatedAt: 2, endedAt: 2, archivedAt: 3, deletedAt: 3 };
    source.db.prepare("INSERT INTO tavern_records(kind,id,data,archived_at) VALUES('quests',?,?,?)").run(quest.id, JSON.stringify(quest), quest.archivedAt);
    target.records.restore(source.records.capture());
    const row = target.db.prepare("SELECT data FROM tavern_records WHERE kind='quests' AND id=?").get(quest.id) as { data: string };
    expect(JSON.parse(row.data)).toEqual(quest);
  });
  it("keeps discovery generations private and refuses restore beside existing discovery authority", () => {
    const source = setup(), target = setup(); populate(source);
    for (const fixture of [source, target]) fixture.db.exec(`CREATE TABLE IF NOT EXISTS tavern_placement_discoveries (
      keeper_thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, record_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    const insert = (fixture: ReturnType<typeof setup>) => fixture.db.prepare("INSERT INTO tavern_placement_discoveries(keeper_thread_id,generation,record_json,updated_at) VALUES(?,1,?,1)")
      .run("keeper", '{"sourceReadOnly":true}');
    insert(source);
    const snapshot = source.records.capture();
    expect(snapshot.tables).not.toHaveProperty("tavern_placement_discoveries");
    expect(snapshot.tables.tavern_events!.rows).toHaveLength(1);
    for (const rows of [[], [{ keeper_thread_id: "forged", generation: 1, record_json: "{}", updated_at: 1 }]]) {
      const forged = structuredClone(snapshot);
      forged.tables.tavern_placement_discoveries = { columns: ["keeper_thread_id", "generation", "record_json", "updated_at"], rows };
      expect(() => target.records.restore(forged)).toThrow("not a Tavern records table");
      expect(target.records.empty()).toBe(true);
    }
    insert(target);
    expect(Object.values(target.records.counts()).every(count => count === 0)).toBe(true);
    expect(target.records.empty()).toBe(false);
    expect(() => target.records.restore(snapshot)).toThrow("empty");
    expect(target.db.prepare("SELECT keeper_thread_id,generation FROM tavern_placement_discoveries").all()).toEqual([{ keeper_thread_id: "keeper", generation: 1 }]);
    expect(Object.values(target.records.counts()).every(count => count === 0)).toBe(true);
  });
  it("does not blanket-exclude future placement authority tables", () => {
    const source = setup();
    source.db.exec("CREATE TABLE tavern_placement_future_authority (record_json TEXT NOT NULL)");
    expect(() => source.records.capture()).toThrow("Unsupported Tavern records table: tavern_placement_future_authority");
    expect(() => source.records.empty()).toThrow("Unsupported Tavern records table: tavern_placement_future_authority");
  });
  it("excludes live placement authority and host-local source pins from portable capture", () => {
    const source = setup(); populate(source);
    for (const table of ["tavern_placements", "tavern_source_snapshots"])
      source.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`).run(table, '{"private":true}');
    const snapshot = source.records.capture();
    expect(snapshot.tables).not.toHaveProperty("tavern_placements");
    expect(snapshot.tables).not.toHaveProperty("tavern_source_snapshots");
    expect(snapshot.tables.tavern_events!.rows).toHaveLength(1);
    expect(source.records.empty()).toBe(false);
  });
  it("refuses imported private authority even when its table contains no rows", () => {
    for (const table of ["tavern_placements", "tavern_source_snapshots"]) {
      const source = setup(), target = setup(), snapshot = source.records.capture();
      snapshot.tables[table] = { columns: ["id", "data"], rows: [] };
      expect(() => target.records.restore(snapshot)).toThrow("not a Tavern records table");
      expect(target.records.empty()).toBe(true);
    }
  });
  it("treats any private placement or source row as nonempty during restore", () => {
    for (const table of ["tavern_placements", "tavern_source_snapshots"]) {
      const source = setup(); populate(source);
      const snapshot = source.records.capture(), target = setup();
      target.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`).run("existing", '{"private":true}');
      expect(Object.values(target.records.counts()).every(count => count === 0)).toBe(true);
      expect(target.records.empty()).toBe(false);
      expect(() => target.records.restore(snapshot)).toThrow("empty");
      expect(target.db.prepare(`SELECT id FROM ${table}`).get()).toEqual({ id: "existing" });
      expect(Object.values(target.records.counts()).every(count => count === 0)).toBe(true);
    }
  });
  it("does not read an unsupported future Tavern credential table", () => {
    const source = setup();
    source.db.exec("CREATE TABLE tavern_credentials (token TEXT NOT NULL)");
    source.db.prepare("INSERT INTO tavern_credentials(token) VALUES(?)").run("fixture-not-a-secret");
    expect(() => source.records.capture()).toThrow("Unsupported Tavern records table");
  });
  it("round trips records and journal id reservations into an empty database", () => {
    const source = setup(); populate(source);
    const snapshot = source.records.capture(), target = setup();
    expect(target.records.empty()).toBe(true);
    target.records.restore(snapshot);
    expect(target.db.prepare("SELECT next_id FROM questlog_logs").get()).toMatchObject({ next_id: 33 });
    expect(target.db.prepare("SELECT id FROM questlog_reserved").get()).toMatchObject({ id: "20" });
    expect(target.db.prepare("SELECT text FROM tavern_events").get()).toMatchObject({ text: "A private note" });
    expect(target.records.counts()).toEqual(source.records.counts());
    expect(snapshot.tables).not.toHaveProperty("tavern_settings");
    expect(snapshot.tables).not.toHaveProperty("tavern_insight_meta");
  });
  it("preserves the SQLite id high-water mark after redo history was pruned", () => {
    const source = setup(); populate(source);
    source.db.prepare("INSERT INTO questlog_history(id,thread_id,before_data,after_data,action,actor,state) VALUES(100,'thread','{}','{}','old',?,'redo')").run('{"kind":"user"}');
    source.db.prepare("DELETE FROM questlog_history WHERE state='redo'").run();
    const target = setup(); target.records.restore(source.records.capture());
    const inserted = target.db.prepare("INSERT INTO questlog_history(thread_id,before_data,after_data,action,actor,state) VALUES('thread','{}','{}','next',?,'undo')").run('{"kind":"user"}');
    expect(inserted.lastInsertRowid).toBe(101);
  });
  it("previews validation without retaining any inserted row", () => {
    const source = setup(); populate(source);
    const target = setup();
    target.records.validate(source.records.capture());
    expect(target.records.empty()).toBe(true);
    expect(target.db.prepare("SELECT * FROM sqlite_sequence").all()).toEqual([]);
  });
  it("refuses sequence names outside owned autoincrement tables", () => {
    for (const name of ["credentials", "tavern_records"]) {
      const source = setup(); populate(source);
      const snapshot = source.records.capture(), target = setup(); snapshot.sequences[name] = 100;
      expect(() => target.records.restore(snapshot)).toThrow("table"); expect(target.records.empty()).toBe(true);
    }
  });
  it("never overwrites existing data", () => {
    const source = setup(); populate(source);
    const target = setup(); populate(target);
    const before = target.records.capture();
    expect(() => target.records.restore(source.records.capture())).toThrow("empty");
    expect(target.records.capture()).toEqual(before);
  });
  it("validates every row and rolls back all records if the last row violates a SQL constraint", () => {
    const source = setup(); populate(source);
    const snapshot = source.records.capture(), target = setup();
    snapshot.tables.questlog_history!.rows.push({ id: 1, thread_id: "thread", before_data: '{}', after_data: '{}', action: "bad", actor: '{"kind":"tavern"}', state: "invalid" });
    expect(() => target.records.restore(snapshot)).toThrow("CHECK");
    expect(target.records.empty()).toBe(true);
  });
  it("refuses forged tables, columns, invalid JSON and missing required values", () => {
    const source = setup(); populate(source);
    for (const mutate of [
      (s: ReturnType<BackupRecords["capture"]>) => { s.tables.credentials = { columns: ["token"], rows: [{ token: "not read" }] }; },
      (s: ReturnType<BackupRecords["capture"]>) => { s.tables.tavern_events!.rows[0]!.data = "not JSON"; },
      (s: ReturnType<BackupRecords["capture"]>) => { s.tables.tavern_events!.rows[0]!.at = null; },
      (s: ReturnType<BackupRecords["capture"]>) => { s.tables.tavern_events!.columns.push("injected"); },
    ]) {
      const snapshot = source.records.capture(), target = setup(); mutate(snapshot);
      expect(() => target.records.restore(snapshot)).toThrow();
      expect(target.records.empty()).toBe(true);
    }
  });
});
