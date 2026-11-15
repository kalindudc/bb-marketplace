// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { roomSchema, type Room } from "../../src/shared/contract";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

it("reads a stored event whose actor no longer fits the schema as Tavern's, so one old row never breaks the room", async () => {
  const f = setup(); databases.push(f.k.store.db); registerRpc(f.bb, f.runtime);
  f.k.store.db.prepare("INSERT INTO tavern_events (at, keeper_thread_id, board_quest_id, actor, type, text, data) VALUES (?, ?, NULL, ?, ?, ?, ?)")
    .run(f.time(), "lead", JSON.stringify({ kind: "system" }), "scope.refreshed", "Keeper scope widened", "{}");
  const room = roomSchema.parse(await f.harness.invokeRpc("room", {})) as Room;
  const row = room.recent.find(event => event.type === "scope.refreshed");
  expect(row?.actor).toEqual({ kind: "tavern" });
});

it("refuses to record an event with an actor outside the schema", () => {
  const f = setup(); databases.push(f.k.store.db);
  expect(() => f.k.store.event(f.time(), "lead", null, "scope.refreshed", "x", {}, { kind: "system" } as never)).toThrow();
});

it("backs up and restores a stored event whose actor no longer fits the schema, exporting it as Tavern's", async () => {
  const { BackupRecords } = await import("../../src/server/backup/records");
  const { SettingsStore } = await import("../../src/server/settings/store");
  const f = setup(); databases.push(f.k.store.db);
  f.k.store.db.prepare("INSERT INTO tavern_events (at, keeper_thread_id, board_quest_id, actor, type, text, data) VALUES (?, ?, NULL, ?, ?, ?, ?)")
    .run(f.time(), "lead", JSON.stringify({ kind: "system" }), "scope.refreshed", "Keeper scope widened", "{}");
  const records = new BackupRecords(f.k.store.db, new SettingsStore(f.k.store.db, () => f.time()));
  const snapshot = records.capture();
  const rows = snapshot.tables.tavern_events!.rows.filter(row => row.type === "scope.refreshed");
  expect(rows.map(row => JSON.parse(String(row.actor)))).toEqual([{ kind: "tavern" }]);
  expect(() => records.validate(snapshot)).not.toThrow();
});

it("reads a Closing time digest whose window covers such an event", async () => {
  const { readAwayDigest } = await import("../../src/server/away/digest");
  const f = setup(); databases.push(f.k.store.db);
  f.runtime.away.store.close({ revision: 0, until: f.time() + 60_000, quests: [] });
  f.k.store.db.prepare("INSERT INTO tavern_events (at, keeper_thread_id, board_quest_id, actor, type, text, data) VALUES (?, ?, NULL, ?, ?, ?, ?)")
    .run(f.time(), "lead", JSON.stringify({ kind: "system" }), "scope.refreshed", "Keeper scope widened", "{}");
  f.runtime.away.store.finish(f.runtime.away.store.snapshot().window!.id, { kind: "explicit-return", threadId: null, refId: null });
  const digest = readAwayDigest(f.k, f.runtime.away.store, {});
  expect(digest.events.find(event => event.type === "scope.refreshed")?.actor).toEqual({ kind: "tavern" });
});
