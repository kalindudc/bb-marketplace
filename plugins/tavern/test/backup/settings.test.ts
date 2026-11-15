// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/server/settings/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { exportToml, previewToml } from "../../src/server/settings/toml";

function settings() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  return new SettingsStore(db);
}
describe("backup retention setting", () => {
  it("defaults to fourteen and remains a user setting", () => {
    const store = settings();
    expect(store.read().data.backupKeep).toBe(14);
    expect(store.snapshot().rows.some(row => String(row.key) === "backupKeep")).toBe(false);
  });
  it("round trips backup_keep through the ordinary settings transfer", () => {
    const store = settings();
    store.update({ revision: 0, patch: { data: { backupKeep: 0 } }, why: "Keep every backup" });
    const toml = exportToml(store.snapshot());
    expect(toml).toContain("backup_keep = 0");
    const preview = previewToml(toml, settings().snapshot());
    expect(preview.problems).toEqual([]);
    expect(preview.user.data?.backupKeep).toBe(0);
  });
  it("refuses values outside the documented range with their line", () => {
    const preview = previewToml("[data]\nbackup_keep = 366\n", settings().snapshot());
    expect(preview.problems).toMatchObject([{ line: 2, key: "data.backup_keep", allowed: "0 to 365" }]);
  });
});
