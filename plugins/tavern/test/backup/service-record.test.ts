// @vitest-environment node
import { seedQuest } from "../server/support";
import { afterEach, describe, expect, it } from "vitest";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";
import { setup } from "../server/runtime-fixture";
import { planInput, waypointEntry } from "../server/support";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(empty = false) {
  const f = setup(); databases.push(f.k.store.db);
  if (empty) f.k.store.db.exec("DELETE FROM tavern_records; DELETE FROM tavern_runtime; DELETE FROM tavern_events;");
  return { ...f, records: new BackupRecords(f.k.store.db, new SettingsStore(f.k.store.db, f.time), f.time) };
}
async function source(withdrawn = false, superseded = false) {
  const f = fixture(); const q = await seedQuest(f.k,"lead", "Keep the proof", "History"); f.k.plan("lead", planInput(q.id));
  const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Publish", doneWhen: "Proof", context: [], questions: [], timeboxMinutes: null };
  for (const [threadId, classId, characterId] of [["maker", "smith", "juno"], ["checker", "warden", "vex"]]) f.k.bind(threadId!, classId!, characterId!, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Work", errand: false, brief });
  const before = waypointEntry("maker", q.id), after = { ...before, status: "verified" as const, review: { actor: { kind: "agent" as const, threadId: "checker" }, at: f.time(), evidence: before.evidence, reason: null, previousNote: null, memberEvidenceAt: null } };
  f.port.linkedEntries = () => [after]; f.runtime.serviceRecords.reviewed({ before, after, sequence: 1 });
  if (withdrawn || superseded) {
    if (withdrawn) f.runtime.serviceRecords.reviewed({ before, after, sequence: 2, undone: true });
    if (superseded) f.runtime.serviceRecords.superseded({ entry: after, version: 2, at: f.time() });
    f.port.linkedEntries = () => [before];
    f.k.store.put("quests", q.id, { ...f.k.quest(q.id), phase: "stopped", endedAt: f.time() });
    f.k.store.atomic(() => f.runtime.serviceRecords.record(q.id));
  } else await f.runtime.wrap("lead", q.id, "Proved", "");
  f.runtime.serviceRecords.backfill();
  return f;
}

describe("portable service records and private verdict facts", () => {
  it("round-trips terminal records, receipts and recording/backfill dates into an empty database without replay or recount", async () => {
    const f = await source(), target = fixture(true);
    const before = f.runtime.serviceRecords.read(); const snapshot = f.records.capture();
    const rows = snapshot.tables.tavern_records!.rows;
    for (const kind of ["serviceRecords", "serviceVerdicts", "serviceRecordState"]) expect(rows.some(row => row.kind === kind)).toBe(true);
    target.records.restore(snapshot);
    expect(target.runtime.serviceRecords.read()).toEqual(before);
    expect(target.k.store.all("serviceVerdicts")).toEqual(f.k.store.all("serviceVerdicts"));
    expect(target.k.store.get("serviceRecordState", "v1")).toEqual(f.k.store.get("serviceRecordState", "v1"));
    target.runtime.serviceRecords.backfill(); expect(target.runtime.serviceRecords.read()).toEqual(before);
    expect(target.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("round-trips Keep and frozen levels without replaying work or recomputing crossings", async () => {
    const f = await source(); f.runtime.serviceRecords.setTaleKept({ questId: f.k.store.all("serviceRecords")[0]!.questId, characterId: "juno", kept: true });
    const snapshot = f.records.capture(), target = fixture(true);
    expect(snapshot.tables.tavern_records!.rows.some(row => row.kind === "taleKeeps")).toBe(true);
    target.records.restore(snapshot);
    expect(target.k.store.all("taleKeeps")).toEqual(f.k.store.all("taleKeeps"));
    expect(target.k.store.all("serviceRecords")).toEqual(f.k.store.all("serviceRecords"));
    expect(target.runtime.serviceRecords.read()).toEqual(f.runtime.serviceRecords.read());
    target.runtime.serviceRecords.backfill();
    expect(target.k.store.all("serviceRecords")).toEqual(f.k.store.all("serviceRecords"));
    expect(target.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("rejects a Keep flag under a different tale/character key before restoring any row", async () => {
    const f = await source(), target = fixture(true);
    f.runtime.serviceRecords.setTaleKept({ questId: f.k.store.all("serviceRecords")[0]!.questId, characterId: "juno", kept: true });
    const snapshot = f.records.capture(), row = snapshot.tables.tavern_records!.rows.find(row => row.kind === "taleKeeps")!;
    row.id = "wrong-preference";
    expect(() => target.records.restore(snapshot)).toThrow(/identity/);
    expect(target.k.store.all("members")).toEqual([]);
  });
  it("preserves withdrawn verdict history without reviving its check during restore or backfill", async () => {
    const f = await source(true), target = fixture(true); target.records.restore(f.records.capture());
    expect(target.k.store.all("serviceVerdicts")[0]).toMatchObject({ withdrawn: true });
    expect(target.runtime.serviceRecords.read().find(row => row.characterId === "vex")).toBeUndefined();
    target.runtime.serviceRecords.backfill();
    expect(target.k.store.all("serviceVerdicts")[0]).toMatchObject({ withdrawn: true });
    expect(target.runtime.serviceRecords.read().find(row => row.characterId === "vex")).toBeUndefined();
  });
  it("preserves a superseded verify without reviving maker proof or removing the Warden check", async () => {
    const f = await source(false, true), target = fixture(true);
    target.records.restore(f.records.capture());
    const receipt = target.k.store.all("serviceVerdicts")[0]!;
    expect(receipt).toMatchObject({ superseded: { reason: "superseded by brief v2" } });
    expect(target.runtime.serviceRecords.read()).toEqual(f.runtime.serviceRecords.read());
    expect(target.runtime.serviceRecords.read().find(row => row.characterId === "juno")).toBeUndefined();
    expect(target.runtime.serviceRecords.read().find(row => row.characterId === "vex")?.warden?.checks).toBe(1);
    target.runtime.serviceRecords.backfill(); expect(target.k.store.get("serviceVerdicts", receipt.id)).toEqual(receipt);
    expect(target.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("keeps deleted-thread credit and already-redacted links after a backup round trip", async () => {
    const f = await source(); for (const id of ["maker", "checker", "lead"]) f.runtime.threadGone(id);
    const target = fixture(true); target.records.restore(f.records.capture());
    expect(target.runtime.serviceRecords.read()).toEqual(f.runtime.serviceRecords.read());
    expect(target.runtime.serviceRecords.read().find(r => r.characterId === "juno")!.maker?.verifiedWaypoints).toBe(1);
    expect(target.k.store.all("serviceVerdicts")[0]!).toMatchObject({ maker: { threadId: null }, checker: { threadId: null } });
  });
  it.each(["serviceRecords", "serviceVerdicts", "serviceRecordState"])("validates %s strictly before inserting any records", async kind => {
    const f = await source(), target = fixture(true), snapshot = f.records.capture();
    const row = snapshot.tables.tavern_records!.rows.find(row => row.kind === kind)!;
    row.data = JSON.stringify({ ...JSON.parse(String(row.data)), executionAuthority: { allocate: true } });
    expect(() => target.records.restore(snapshot)).toThrow();
    expect(target.k.store.all("members")).toEqual([]); expect(target.k.store.all("serviceRecords")).toEqual([]);
  });
  it.each(["serviceRecords", "serviceVerdicts", "serviceRecordState"])("refuses mismatched row identity for %s before inserting anything", async kind => {
    const f = await source(), target = fixture(true), snapshot = f.records.capture();
    const row = snapshot.tables.tavern_records!.rows.find(row => row.kind === kind)!; row.id = "wrong-id";
    expect(() => target.records.restore(snapshot)).toThrow(/identity/);
    expect(target.k.store.all("members")).toEqual([]);
  });
  it("refuses negative earned counts rather than trusting a forged history total", async () => {
    const f = await source(), target = fixture(true), snapshot = f.records.capture();
    const row = snapshot.tables.tavern_records!.rows.find(row => row.kind === "serviceRecords")!, data = JSON.parse(String(row.data));
    data.credits[0].verifiedWaypoints = -1; row.data = JSON.stringify(data);
    expect(() => target.records.restore(snapshot)).toThrow();
    expect(target.k.store.all("members")).toEqual([]);
  });
});
