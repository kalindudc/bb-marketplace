// @vitest-environment node
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { preparedDatabase } from "../../src/server/prepared-database";
import { SettingsStore } from "../../src/server/settings/store";
import { reserveStaffing, settleStaffing } from "../../src/server/staffing";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";

it("can grow a cached class allocation without changing the prior row", async () => {
  const { k } = setup();
  try {
    const quest = await seedQuest(k, "lead", "Build", "Build");
    const first = k.store.atomic(() => reserveStaffing(k, quest, "smith", 1, "first"));
    settleStaffing(k, first, "first", null);
    const before = k.store.get("staffing", first.id)!;
    expect(Object.isFrozen(before.slots)).toBe(true);
    const next = k.store.atomic(() => reserveStaffing(k, quest, "smith", 2, "second"));
    expect(next.id).toBe(first.id);
    expect(before.slots).toEqual([{ memberThreadId: null, uses: 0 }]);
    expect(k.store.get("staffing", first.id)?.slots).toEqual([
      { memberThreadId: "second", uses: 1 }, { memberThreadId: null, uses: 0 },
    ]);
  } finally { k.store.db.close(); }
});

it("charges a named replacement to its original slot, not an earlier free slot", async () => {
  const { k } = setup();
  try {
    const quest = await seedQuest(k, "lead", "Build", "Build");
    const id = `${quest.id}:${quest.planVersion}:smith`;
    const slots = [{ memberThreadId: null, uses: 0 }, { memberThreadId: "previous", uses: 1 }];
    k.store.put("staffing", id, { boardQuestId: quest.id, version: quest.planVersion, classId: "smith", slots });
    const reservation = k.store.atomic(() => reserveStaffing(k, quest, "smith", 2, "fresh", "previous"));
    expect(reservation).toMatchObject({ slot: 1, replacement: 1 });
    expect(k.store.get("staffing", id)?.slots).toEqual([slots[0], { memberThreadId: "fresh", uses: 2 }]);
  } finally { k.store.db.close(); }
});

it("keeps Keeper reads current across stores, transactions and a bulk import", () => {
  const db = new Database(":memory:");
  try {
    db.exec(MIGRATIONS.join(";\n"));
    const writer = new KeeperStore(db), reader = new KeeperStore(preparedDatabase(db));
    writer.put("attentionSeen", "a", { token: "seen", seenAt: 1 });
    writer.patch("keeper", { eventSequence: 1 });
    expect(reader.get("attentionSeen", "a")?.seenAt).toBe(1);
    expect(reader.runtime("keeper").eventSequence).toBe(1);
    expect(() => reader.atomic(() => {
      writer.remove("attentionSeen", "a");
      writer.patch("keeper", { eventSequence: 2 });
      expect(reader.get("attentionSeen", "a")).toBeNull();
      expect(reader.runtime("keeper").eventSequence).toBe(2);
      throw new Error("roll back");
    })).toThrow("roll back");
    expect(reader.get("attentionSeen", "a")?.seenAt).toBe(1);
    expect(reader.runtime("keeper").eventSequence).toBe(1);
    writer.atomic(() => {
      writer.put("attentionSeen", "b", { token: "seen", seenAt: 1 });
      expect(Object.isFrozen(reader.get("attentionSeen", "b"))).toBe(true);
      expect(Object.isFrozen(reader.runtime("never-written"))).toBe(true);
    });
    writer.put("decisionSeen", "c", { token: "seen", seenAt: 1 });
    expect(reader.get("attentionSeen", "b")?.seenAt).toBe(1);
    expect(reader.get("decisionSeen", "c")?.seenAt).toBe(1);
    expect(writer.writeRecords("UPDATE tavern_records SET data=json_set(data,'$.seenAt',2) WHERE id IN (?,?)", "b", "c")).toEqual({ changes: 2 });
    expect(reader.get("attentionSeen", "b")?.seenAt).toBe(2);
    expect(reader.get("decisionSeen", "c")?.seenAt).toBe(2);
    writer.atomic(() => writer.importRows(() => {
      db.prepare("UPDATE tavern_runtime SET data=json_set(data,'$.eventSequence',3) WHERE thread_id='keeper'").run();
      db.prepare("DELETE FROM tavern_records WHERE kind='attentionSeen'").run();
    }));
    expect(reader.get("attentionSeen", "a")).toBeNull();
    expect(reader.runtime("keeper").eventSequence).toBe(3);
  } finally { db.close(); }
});

it("refreshes immutable settings and does not publish a rolled-back update", () => {
  const db = new Database(":memory:");
  try {
    db.exec(MIGRATIONS.join(";\n"));
    const settings = new SettingsStore(db), reader = new SettingsStore(preparedDatabase(db));
    const before = settings.read();
    expect(reader.read().attention.reviewBudget).toBe(before.attention.reviewBudget);
    expect(Object.isFrozen(before.knobs)).toBe(true);
    expect(settings.read()).toBe(before);
    expect(() => settings.atomic(() => {
      settings.update({ revision: 0, patch: { attention: { reviewBudget: 7 } }, why: "Fixture settings" });
      expect(settings.read().attention.reviewBudget).toBe(7);
      expect(reader.read().attention.reviewBudget).toBe(7);
      throw new Error("roll back");
    })).toThrow("roll back");
    expect(settings.read()).toEqual(before);
    expect(reader.read()).toEqual(before);
    settings.update({ revision: 0, patch: { attention: { reviewBudget: 7 } }, why: "Fixture settings" });
    const data = (db.prepare("SELECT data FROM tavern_settings WHERE id=1").get() as { data: string }).data;
    const parse = vi.spyOn(JSON, "parse");
    try {
      const after = reader.read();
      expect(after.attention.reviewBudget).toBe(7);
      expect(reader.read()).toBe(after);
      expect(parse.mock.calls.filter(([input]) => input === data)).toHaveLength(1);
    } finally { parse.mockRestore(); }
  } finally { db.close(); }
});
