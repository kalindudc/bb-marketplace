// @vitest-environment node
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { KEEPER_MIGRATIONS } from "../../src/server/keeper/migrations";
import { QUESTLOG_MIGRATIONS as JOURNAL_MIGRATIONS } from "../../src/server/journal/migrations";
import { KeeperStore } from "../../src/server/keeper/store";

describe("append-only live migrations", () => {
  it("pins the two installed statements at their original positions and hashes", () => {
    expect(MIGRATIONS.slice(0, 2)).toEqual([...JOURNAL_MIGRATIONS, ...KEEPER_MIGRATIONS]);
    expect(
      MIGRATIONS.slice(0, 2).map((sql) => createHash("sha256").update(sql).digest("hex")),
    ).toEqual([
      "2a99d603cdc87b7032c9677ffd40a043e383708596b988548db264e50818abe1",
      "9866e1720baa1a0a9abdd63bcdc164dffc54787b81bd158f24def38008e8e575",
    ]);
  });
  it("upgrades existing rows, backfills ask and skip metadata and preserves the audit log", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS.slice(0, 2)) db.exec(sql);
    const store = new KeeperStore(db);
    store.event(1, "lead", "q", "ask.opened", "Approval?", { askId: "ask", planVersion: 3 });
    store.event(2, "lead", "q", "waypoint.skipped", "Not needed", { version: 3, waypointId: "w1" });
    const before = store.events("lead");
    const legacyQuest = {
      id: "legacy",
      keeperThreadId: "lead",
      title: "Returned goal",
      short: "Goal",
      phase: "done",
      planVersion: 0,
      greenlitVersion: null,
      createdAt: 1,
      updatedAt: 2,
      endedAt: 2,
    };
    db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('quests',?,?)").run(
      legacyQuest.id,
      JSON.stringify(legacyQuest),
    );
    for (const sql of MIGRATIONS.slice(2)) db.exec(sql);
    expect(store.get("quests", "legacy")).toEqual({ ...legacyQuest, archivedAt: null });
    expect(store.archivedQuestCount()).toBe(0);
    expect(store.visibleRecords("quests", "lead")).toHaveLength(1);
    expect(store.get("askMeta", "ask")).toEqual({ planVersion: 3 });
    expect(store.get("skips", "q:3:w1")).toEqual({
      boardQuestId: "q",
      version: 3,
      waypointId: "w1",
    });
    expect(store.events("lead")).toEqual(before);
    expect(() => db.exec("DELETE FROM tavern_events")).toThrow(/append-only/);
    const index = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT data FROM tavern_records WHERE kind='asks' AND json_extract(data,'$.keeperThreadId')='lead' LIMIT 10",
      )
      .all();
    expect(JSON.stringify(index)).toContain("tavern_records_keeper");
  });
});
