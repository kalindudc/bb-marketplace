// @vitest-environment node
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { SettingsStore } from "../../src/server/settings/store";
import { BackupRecords } from "../../src/server/backup/records";
import { AwayHolds } from "../../src/server/away/holds";
import { AwayStore } from "../../src/server/away/store";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { fakePort, seedQuest } from "../server/support";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = new Database(":memory:");
  db.exec(MIGRATIONS.join(";\n"));
  databases.push(db);
  const settings = new SettingsStore(db, () => 1000), away = new AwayStore(db, () => 1000);
  return { db, away, records: new BackupRecords(db, settings) };
}
function closed() {
  const source = setup();
  source.away.close({ revision: 0, until: 2000, quests: [{ questId: "q", endState: "pause" }] });
  return source;
}
const explicit = { kind: "explicit-return" as const, threadId: null, refId: null };
function held() {
  const source = closed();
  new AwayHolds(source.db).put({ threadId: "child", keeperThreadId: "lead", questId: "q", windowId: source.away.snapshot().window!.id,
    heldAt: 1000, resumeRequired: true, stopPending: true, error: "Offline", cancelledBrief: { id: "old", text: "Do not replay" } });
  return source;
}
it("returns a withdrawn closing request to its recorded scout phase after restore", async () => {
  const source = setup(), target = setup();
  const k = new Keeper(new KeeperStore(source.db), fakePort(), () => 1000);
  k.bind("lead", "keeper", "wren", "project");
  const q = await seedQuest(k, "lead", "Unplanned", "Unplanned");
  const ask = k.ask("lead", { boardQuestId: q.id, kind: "conclude", question: "Finish?", why: "No work needed", meanwhile: "Wait", holds: [], options: [{ id: "hold", label: "Keep open", detail: "", recommended: true }], effect: { type: "conclude", draft: { outcome: "No work needed", left: "", returnTo: "scout" } } });
  expect(k.quest(q.id).phase).toBe("closing");
  const snapshot = source.records.capture();
  const row = snapshot.tables.tavern_records!.rows.find(r => r.id === ask.id)!;
  row.data = JSON.stringify({ ...ask, state: "withdrawn", withdrawnCause: "backup-restored", withdrawnAt: null });
  target.records.restore(snapshot);
  expect(new KeeperStore(target.db).get("quests", q.id)?.phase).toBe("scout");
});

it("round-trips a restrictive member hold without dropping the pending interruption", () => {
  const source = held(), target = setup();
  target.records.restore(source.records.capture());
  expect(new AwayHolds(target.db).get("child")).toEqual(new AwayHolds(source.db).get("child"));
});
it.each(["shape", "id", "window"])("rejects a forged away hold %s before restoring anything", variant => {
  const source = held(), target = setup(), snapshot = source.records.capture();
  const row = snapshot.tables.tavern_records!.rows.find(row => row.kind === "awayHolds")!, data = JSON.parse(String(row.data));
  if (variant === "shape") data.resumeRequired = "false";
  if (variant === "id") row.id = "someone-else";
  if (variant === "window") data.windowId = "missing-window";
  row.data = JSON.stringify(data);
  expect(() => target.records.restore(snapshot)).toThrow(/away|closing|boolean/i);
  expect(target.records.empty()).toBe(true);
});

it("round-trips a passive content latch without any away window or private authority", () => {
  const source = setup(), target = setup(), holds = new AwayHolds(source.db);
  const token = holds.requestContent({ threadId: "child", keeperThreadId: "lead", questId: "q", heldAt: 1000, cancelledBrief: null }, "operation");
  target.records.restore(source.records.capture());
  expect(new AwayHolds(target.db).findContent(token)).toEqual(holds.get("child"));
  expect(target.away.snapshot().window).toBeNull();
  for (const table of ["tavern_placements", "tavern_source_snapshots", "tavern_placement_discoveries"]) expect(target.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
});
it("rejects private authority smuggled into a portable content reason", () => {
  const source = held(), target = setup(), snapshot = source.records.capture();
  const row = snapshot.tables.tavern_records!.rows.find(row => row.kind === "awayHolds")!, data = JSON.parse(String(row.data));
  data.reasons.push({ kind: "content", operationId: "operation", token: data.token, generation: 1, ready: true });
  row.data = JSON.stringify(data);
  expect(() => target.records.restore(snapshot)).toThrow();
  expect(target.records.empty()).toBe(true);
});

it("rejects duplicate reason tokens instead of allowing one finish to clear two reasons", () => {
  const source = held(), target = setup(), snapshot = source.records.capture();
  const row = snapshot.tables.tavern_records!.rows.find(row => row.kind === "awayHolds")!, data = JSON.parse(String(row.data));
  data.reasons.push({ kind: "content", operationId: "one", token: data.token }, { kind: "content", operationId: "two", token: data.token });
  row.data = JSON.stringify(data);
  expect(() => target.records.restore(snapshot)).toThrow(/duplicat|unique/i);
  expect(target.records.empty()).toBe(true);
});
it("validates away reason links even in an otherwise content-only row", () => {
  const source = held(), target = setup(), snapshot = source.records.capture();
  const row = snapshot.tables.tavern_records!.rows.find(row => row.kind === "awayHolds")!, data = JSON.parse(String(row.data));
  data.windowId = null; data.reasons = [{ kind: "away", windowId: "missing" }]; row.data = JSON.stringify(data);
  expect(() => target.records.restore(snapshot)).toThrow(/missing.*window/i);
  expect(target.records.empty()).toBe(true);
});

it("round-trips an active away restriction without reopening it", () => {
  const source = closed(), target = setup(), snapshot = source.records.capture();
  target.records.restore(snapshot);
  expect(target.away.snapshot()).toEqual(source.away.snapshot());
  expect(target.away.snapshot().status.closed).toBe(true);
});

it("round-trips completed windows and preserves the recorded return cause", () => {
  const source = closed(), id = source.away.snapshot().window!.id;
  source.away.finish(id, { kind: "ask-answer", threadId: "lead", refId: "ask" });
  const target = setup(); target.records.restore(source.records.capture());
  expect(target.away.snapshot()).toEqual(source.away.snapshot());
  expect(target.away.history()).toEqual(source.away.history());
});

it("rejects forged current-window controls before restoring any records", () => {
  const source = closed(), target = setup(), snapshot = source.records.capture();
  const row = snapshot.tables.tavern_records!.rows.find(row => row.kind === "away")!;
  const data = JSON.parse(String(row.data)); data.window.stopList = ["unknown-kind"]; row.data = JSON.stringify(data);
  expect(() => target.records.restore(snapshot)).toThrow();
  expect(target.records.empty()).toBe(true);
});

it("rejects active windows masquerading as completed portable history", () => {
  const source = closed(), target = setup(), snapshot = source.records.capture();
  snapshot.tables.tavern_records!.rows.push({ kind: "awayWindows", id: source.away.snapshot().window!.id,
    data: JSON.stringify(source.away.snapshot().window), archived_at: null });
  expect(() => target.records.restore(snapshot)).toThrow();
  expect(target.records.empty()).toBe(true);
});

it("refuses a missing current record instead of restoring a silently open database", () => {
  const source = closed(), id = source.away.snapshot().window!.id;
  source.away.finish(id, explicit);
  const target = setup(), snapshot = source.records.capture();
  snapshot.tables.tavern_records!.rows = snapshot.tables.tavern_records!.rows.filter(row => row.kind !== "away");
  expect(() => target.records.restore(snapshot)).toThrow(/away|closing/i);
  expect(target.records.empty()).toBe(true);
});

it.each(["away", "awayWindows"])("refuses mismatched record identities for %s", kind => {
  const source = closed(), id = source.away.snapshot().window!.id;
  source.away.finish(id, explicit);
  const target = setup(), snapshot = source.records.capture();
  snapshot.tables.tavern_records!.rows.find(row => row.kind === kind)!.id = "wrong-id";
  expect(() => target.records.restore(snapshot)).toThrow(/away|closing/i);
  expect(target.records.empty()).toBe(true);
});

it("refuses a completed current window whose history was removed", () => {
  const source = closed(), id = source.away.snapshot().window!.id;
  source.away.finish(id, explicit);
  const target = setup(), snapshot = source.records.capture();
  snapshot.tables.tavern_records!.rows = snapshot.tables.tavern_records!.rows.filter(row => row.kind !== "awayWindows");
  expect(() => target.records.restore(snapshot)).toThrow(/away|closing/i);
  expect(target.records.empty()).toBe(true);
});
