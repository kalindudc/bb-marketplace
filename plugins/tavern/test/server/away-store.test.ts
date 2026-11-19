// @vitest-environment node
import Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AwayConflict, AwayStore } from "../../src/server/away/store";
import { AWAY_STOP_LIST, awayCloseSchema, awayCompletedWindowSchema, awayReturnCauseSchema, awaySnapshotSchema, awayStateSchema, awayStatusSchema, awayWindowSchema } from "../../src/shared/away";
import { MIGRATIONS } from "../../src/server/migrations";

const databases: Sqlite.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  let now = 1_000_000;
  const db = new Sqlite(":memory:");
  db.exec(MIGRATIONS.join("\n"));
  databases.push(db);
  const store = new AwayStore(db, () => now);
  const input = (revision = store.snapshot().revision) => ({ revision, until: now + 3_600_000,
    quests: [{ questId: "quest-a", endState: "drafts-ready" as const }, { questId: "quest-b", endState: "pause" as const }] });
  const event = (text: string) => Number(db.prepare("INSERT INTO tavern_events(at,keeper_thread_id,board_quest_id,actor,type,text,data) VALUES(?,'lead','quest-a','{\"kind\":\"agent\",\"threadId\":\"lead\"}','report.filed',?,'{}')").run(now, text).lastInsertRowid);
  return { db, store, input, event, time: () => now, advance: (ms: number) => { now += ms; } };
}
const explicit = { kind: "explicit-return" as const, threadId: null, refId: null };

describe("Closing time contracts", () => {
  it("defaults to guarded drafts, locked stop actions and opt-in watched work", () => {
    const input = awayCloseSchema.parse({ revision: 0, until: 2000, quests: [] });
    expect(input).toMatchObject({ note: null, allowWatched: false, wakeRules: { blockers: true, productionAsksAfterTwoHours: false } });
    expect(AWAY_STOP_LIST).toEqual(["merge", "deploy", "production", "sends-as-you", "delete", "other-writes"]);
  });

  it("rejects unknown controls, duplicate quests, long notes and unsupported end states", () => {
    const base = { revision: 0, until: 2000, quests: [] };
    for (const value of [{ ...base, stopList: ["unknown"] }, { ...base, stopList: ["merge", "merge"] }, { ...base, note: "x".repeat(501) },
      { ...base, quests: [{ questId: "q", endState: "merge" }] },
      { ...base, quests: [{ questId: "q", endState: "pause" }, { questId: "q", endState: "drafts-ready" }] },
      { ...base, until: Infinity }, { ...base, until: -1 }]) expect(awayCloseSchema.safeParse(value).success).toBe(false);
    expect(awayCloseSchema.parse({ ...base, note: "x".repeat(500) }).note).toHaveLength(500);
  });

  it("requires a recorded Tavern thread for message and ask-answer return causes", () => {
    expect(awayReturnCauseSchema.parse(explicit)).toEqual(explicit);
    for (const kind of ["user-message", "ask-answer"] as const) {
      expect(awayReturnCauseSchema.safeParse({ kind, threadId: null, refId: null }).success).toBe(false);
      expect(awayReturnCauseSchema.parse({ kind, threadId: "lead", refId: "reference" })).toMatchObject({ kind, threadId: "lead" });
    }
    expect(awayReturnCauseSchema.safeParse({ kind: "tick", threadId: "lead", refId: null }).success).toBe(false);
  });

  it("exports both native RPC JSON Schema directions", () => {
    for (const schema of [awayCloseSchema, awayReturnCauseSchema, awaySnapshotSchema, awayStateSchema, awayStatusSchema, awayWindowSchema, awayCompletedWindowSchema])
      for (const io of ["input", "output"] as const) expect(() => z.toJSONSchema(schema, { io })).not.toThrow();
  });
});

describe("Closing time store", () => {
  it("is open by default without writing records or events", () => {
    const f = fixture();
    expect(f.store.snapshot()).toEqual({ revision: 0, window: null, status: { closed: false, until: null, dueBack: false, windowId: null } });
    expect(f.db.prepare("SELECT count(*) AS n FROM tavern_records").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT count(*) AS n FROM tavern_events").get()).toEqual({ n: 0 });
  });

  it("persists the complete window, normalizes a note and survives a new reader", () => {
    const f = fixture(), snapshot = f.store.close({ ...f.input(), note: "  Keep the drafts private.  " });
    expect(snapshot).toMatchObject({ revision: 1, status: { closed: true, dueBack: false, until: f.time() + 3_600_000 },
      window: { note: "Keep the drafts private.", allowWatched: false, stopList: [...AWAY_STOP_LIST], returnedAt: null, returnCause: null, eventCeiling: null } });
    expect(snapshot.status.windowId).toBe(snapshot.window!.id);
    expect(new AwayStore(f.db, f.time).snapshot()).toEqual(snapshot);
    expect(f.store.window(snapshot.window!.id)).toEqual(snapshot.window);
  });

  it("keeps a selected policy as a window snapshot and permits the empty selection", () => {
    const f = fixture(), selection = ["merge", "deploy", "delete"] as ("merge" | "deploy" | "delete")[];
    const first = f.store.close(f.input(), selection);
    selection.pop();
    expect(f.store.snapshot().window?.stopList).toEqual(["merge", "deploy", "delete"]);
    expect(first.window?.guardPolicy).toBe("selected");
    f.store.finish(first.window!.id, explicit);
    expect(f.store.close(f.input(), []).window?.stopList).toEqual([]);
  });
  it("marks due back without reopening, even after a restart", () => {
    const f = fixture(), closed = f.store.close(f.input());
    f.advance(3_600_001);
    expect(new AwayStore(f.db, f.time).snapshot()).toMatchObject({ revision: 1, status: { closed: true, dueBack: true, until: closed.window!.until, windowId: closed.window!.id } });
    expect(f.db.prepare("SELECT count(*) AS n FROM tavern_events WHERE type='away.returned'").get()).toEqual({ n: 0 });
  });

  it.each([explicit, { kind: "user-message" as const, threadId: "lead", refId: "message" },
    { kind: "ask-answer" as const, threadId: "other-tavern-thread", refId: "ask" }])("records the first return cause: $kind", cause => {
    const f = fixture(), closed = f.store.close(f.input());
    f.advance(5000);
    const returned = f.store.finish(closed.window!.id, cause);
    expect(returned.changed).toBe(true);
    expect(returned.snapshot).toMatchObject({ revision: 2, status: { closed: false, until: null, dueBack: false, windowId: closed.window!.id },
      window: { returnedAt: f.time(), returnCause: cause } });
    f.advance(1000);
    expect(f.store.finish(closed.window!.id, explicit)).toEqual({ changed: false, snapshot: returned.snapshot });
    expect(f.store.history()).toEqual([returned.snapshot.window]);
    expect(f.db.prepare("SELECT count(*) AS n FROM tavern_events WHERE type='away.returned'").get()).toEqual({ n: 1 });
  });

  it("fences stale close and return requests without replacing an active window", () => {
    const f = fixture(), first = f.store.close(f.input());
    expect(() => f.store.close(f.input(0))).toThrow(AwayConflict);
    expect(() => f.store.close(f.input(1))).toThrow(/already closed/i);
    f.store.finish(first.window!.id, explicit);
    const second = f.store.close(f.input());
    expect(second.window!.id).not.toBe(first.window!.id);
    expect(() => f.store.finish(first.window!.id, explicit)).toThrow(AwayConflict);
    expect(f.store.snapshot()).toEqual(second);
    expect(f.store.history()).toHaveLength(1);
  });

  it("rejects expired deadlines and invalid controls before writing anything", () => {
    const f = fixture();
    expect(() => f.store.close({ ...f.input(), until: f.time() })).toThrow(/future/i);
    expect(() => f.store.close({ ...f.input(), note: "x".repeat(501) })).toThrow();
    expect(f.store.snapshot().revision).toBe(0);
    expect(f.db.prepare("SELECT count(*) AS n FROM tavern_events").get()).toEqual({ n: 0 });
  });

  it("uses event IDs rather than timestamps to delimit the digest", () => {
    const f = fixture();
    f.event("Before closing, same timestamp");
    const first = f.store.close(f.input());
    const during = f.event("During closing, same timestamp");
    f.advance(-1000);
    const rolledBack = f.event("During closing, clock moved backwards");
    const returned = f.store.finish(first.window!.id, explicit);
    f.event("After returning");
    expect(f.store.eventRange(first.window!.id)).toEqual({ after: first.window!.eventFloor, through: rolledBack,
      closedAt: first.window!.closedAt, returnedAt: returned.snapshot.window!.returnedAt });
    const range = f.store.eventRange(first.window!.id)!;
    const ids = f.db.prepare("SELECT id FROM tavern_events WHERE id>? AND id<=? ORDER BY id").all(range.after, range.through);
    expect(ids).toEqual([{ id: during }, { id: rolledBack }]);
    f.store.close(f.input());
    expect(f.store.eventRange(first.window!.id)).toEqual(range);
  });

  it("keeps active digest boundaries moving until the user returns", () => {
    const f = fixture(), closed = f.store.close(f.input());
    const event = f.event("Work continued");
    expect(f.store.eventRange()).toEqual({ after: closed.window!.eventFloor, through: event, closedAt: f.time(), returnedAt: null });
  });

  it("rolls back the window and audit event together on a database failure", () => {
    const f = fixture();
    f.db.exec("CREATE TRIGGER away_state_failure BEFORE INSERT ON tavern_records WHEN NEW.kind='away' BEGIN SELECT RAISE(ABORT,'away state write failed'); END;");
    expect(() => f.store.close(f.input())).toThrow("away state write failed");
    expect(f.store.snapshot().revision).toBe(0);
    expect(f.db.prepare("SELECT count(*) AS n FROM tavern_events").get()).toEqual({ n: 0 });
  });

  it("rolls back a return if the completed-window history cannot be written", () => {
    const f = fixture(), closed = f.store.close(f.input());
    f.db.exec("CREATE TRIGGER away_history_failure BEFORE INSERT ON tavern_records WHEN NEW.kind='awayWindows' BEGIN SELECT RAISE(ABORT,'away history write failed'); END;");
    expect(() => f.store.finish(closed.window!.id, explicit)).toThrow("away history write failed");
    expect(f.store.snapshot()).toEqual(closed);
    expect(f.db.prepare("SELECT count(*) AS n FROM tavern_events WHERE type='away.returned'").get()).toEqual({ n: 0 });
  });

  it("refuses corrupt state instead of silently reopening", () => {
    const f = fixture();
    f.store.close(f.input());
    f.db.prepare("UPDATE tavern_records SET data='{}' WHERE kind='away'").run();
    expect(() => f.store.snapshot()).toThrow(/away|closing/i);
    expect(() => f.store.close({ revision: 0, until: f.time() + 10000, quests: [] })).toThrow();
  });

  it("does not mistake lost current state with retained history for a fresh database", () => {
    const f = fixture(), closed = f.store.close(f.input());
    f.store.finish(closed.window!.id, explicit);
    f.db.prepare("DELETE FROM tavern_records WHERE kind='away'").run();
    expect(() => f.store.snapshot()).toThrow(/away|closing/i);
  });
});
