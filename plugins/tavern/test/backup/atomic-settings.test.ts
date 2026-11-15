// @vitest-environment node
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { SettingsStore } from "../../src/server/settings/store";

function setup() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const changed = vi.fn(() => { expect(db.inTransaction).toBe(false); });
  return { store: new SettingsStore(db, Date.now, changed), changed };
}
it("does not publish a settings change from a rolled-back restore transaction", () => {
  const { store, changed } = setup();
  expect(() => store.atomic(() => {
    store.update({ revision: 0, patch: { tavern: { voice: "off" } }, why: "Restore" });
    expect(changed).not.toHaveBeenCalled();
    throw new Error("Restore failed");
  })).toThrow("Restore failed");
  expect(store.snapshot().revision).toBe(0);
  expect(store.read().tavern.voice).toBe("full");
  expect(changed).not.toHaveBeenCalled();
});
it("publishes one live update after the entire settings transaction commits", () => {
  const { store, changed } = setup();
  store.atomic(() => {
    store.update({ revision: 0, patch: { tavern: { voice: "off" } }, why: "Restore" });
    store.update({ revision: 1, patch: { data: { backupKeep: 7 } }, why: "Restore" });
    expect(changed).not.toHaveBeenCalled();
  });
  expect(changed).toHaveBeenCalledOnce();
  expect(store.read().data.backupKeep).toBe(7);
});
