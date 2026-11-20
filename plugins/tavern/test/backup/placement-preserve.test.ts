// @vitest-environment node
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { SettingsStore } from "../../src/server/settings/store";
import { BackupRecords } from "../../src/server/backup/records";

function setup() {
  const db = new Database(":memory:"); db.exec(MIGRATIONS.join(";\n"));
  return { db, records: new BackupRecords(db, new SettingsStore(db, () => 123)) };
}
it("excludes private preservation manifests from portable records and rejects imported authority", () => {
  const source = setup(), target = setup();
  source.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('placementArtifactManifests','private','{}')").run();
  const snapshot = source.records.capture();
  expect(snapshot.tables.tavern_records!.rows).toEqual([]);
  expect(source.records.empty()).toBe(false);
  const forged = structuredClone(snapshot);
  forged.tables.tavern_records!.rows.push({ kind: "placementArtifactManifests", id: "forged", data: "{}", archived_at: null });
  expect(() => target.records.restore(forged)).toThrow(/private/i);
  expect(target.records.empty()).toBe(true);
});
