// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { BackupRecords, type RecordsSnapshot } from "../../src/server/backup/records";
import { requireUserAct } from "../../src/server/authority";
import { SettingsStore } from "../../src/server/settings/store";
import type { TickBatch } from "../../src/server/keeper/store";
import { TickLoop } from "../../src/server/tick";
import { setup } from "../server/runtime-fixture";
import { dispatch049 } from "../server/dispatch-fixture";

function fixture(empty = false) {
  const f = setup();
  if (empty) f.k.store.db.exec("DELETE FROM tavern_records; DELETE FROM tavern_runtime; DELETE FROM tavern_events;");
  const settings = new SettingsStore(f.k.store.db, f.time);
  return { ...f, records: new BackupRecords(f.k.store.db, settings, f.time) };
}
function seed(f: ReturnType<typeof fixture>, state: TickBatch["state"] = "prepared") {
  const ask = f.k.ask("lead", { effect: {type:"answer-blocker"}, kind: "blocker", question: "Old update delivery is uncertain", why: "The old host did not confirm the update.",
    options: [{ id: "retry", label: "Check", detail: "Check delivery", recommended: true }], meanwhile: "Other work continues.", holds: [] });
  const other = f.k.ask("lead", { effect: {type:"answer-blocker"}, kind: "blocker", question: "An unrelated question", why: "Keep this question.",
    options: [{ id: "wait", label: "Wait", detail: "Wait", recommended: true }], meanwhile: "Other work continues.", holds: [] });
  f.k.store.patch("lead", { cursor: 0, tickDeliveryAskId: ask.id, tickRefusalCount: 2, queuedTickResetId: "old-reset" });
  const batch: TickBatch = { id: "tick_f00d", threadId: "lead", text: "[Tavern tick] id=tick_f00d\nOLD UPDATE MUST NOT REPLAY", cursor: 9, reportIds: [],
    reanchor: null, createdAt: f.time() - 180_000, attempted: true, rowId: "old-row", state,
    sendPending: true, resendCount: 1, lastSendAt: f.time() - 180_000,
    measurements: { facts: { chars: 123, clipped: true }, restatement: { bytes: 456, clipped: false } } };
  f.k.store.putTick(batch);
  f.k.store.db.prepare("UPDATE tavern_runtime SET data=json_set(data,'$.tickRetryAt',?) WHERE thread_id=?").run(f.time() + 3_600_000, "lead");
  f.k.store.db.prepare("UPDATE tavern_outbox SET data=json_set(data,'$.admittedResendCount',1) WHERE id=?").run(batch.id);
  return { ask, other, batch };
}
function legacy(f: ReturnType<typeof fixture>): RecordsSnapshot {
  const snapshot = f.records.capture();
  for (const name of ["tavern_records", "tavern_runtime", "tavern_outbox"]) snapshot.tables[name]!.rows =
    f.k.store.db.prepare(`SELECT * FROM ${name}`).all() as RecordsSnapshot["tables"][string]["rows"];
  return snapshot;
}
function data(snapshot: RecordsSnapshot, table: string, id: string) {
  const row = snapshot.tables[table]!.rows.find(row => row.id === id || row.thread_id === id)!;
  return { row, value: JSON.parse(String(row.data)) };
}
function expectLocalFieldsAbsent(value: object, fields: string[]) {
  for (const field of fields) expect(value).not.toHaveProperty(field);
}
const batchFields = ["sendPending", "resendCount", "lastSendAt", "measurements", "admittedResendCount"];
const runtimeFields = ["tickDeliveryAskId", "tickRefusalCount", "queuedTickResetId", "tickRetryAt"];

it("records both cluster answers in history but restores no pending approval or live expiry", () => {
  const source = fixture(), restored = fixture(true);
  const ask = () => source.k.ask("lead", { kind: "cluster-write", effect: { type: "decision" }, question: "Apply the sample?", why: "Changes a cluster", target: { command: "kubectl apply -f sample.yaml" }, change: "Update the sample", options: [{ id: "approve", label: "Approve", detail: "", recommended: false }], meanwhile: "", holds: [] });
  const pending = ask(), done = ask();
  const receipt = requireUserAct({ experimental_caller: { kind: "client" } } as never, "answerAsk");
  for (const row of [pending, done]) source.k.answerAsk(row.id, "approve", null, "page", "user", "page", {}, receipt);
  source.k.answerAsk(done.id, "confirm-run", null, "banner", "user", "banner", {}, receipt);
  source.k.store.put("asks", done.id, { ...source.k.store.get("asks", done.id)!, clusterGrantExpiresAt: source.time() + 900_000 });
  restored.records.restore(source.records.capture());
  expect(restored.k.store.get("asks", pending.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "backup-restored" });
  const history = restored.k.store.get("asks", done.id);
  expect(history).toMatchObject({ state: "answered", clusterApproval: { via: "page" }, answer: { via: "banner" } });
  expect(history).not.toHaveProperty("clusterGrantExpiresAt");
});

describe("nonportable tick delivery state", () => {
  it.each(["prepared", "queued", "delivered", "cancelled"] as const)("exports %s batches as terminal without local delivery state and leaves the source untouched", state => {
    const source = fixture(), { ask, other } = seed(source, state);
    const before = source.k.store.tick("tick_f00d"), runtimeBefore = source.k.store.runtime("lead");
    const snapshot = source.records.capture(), batch = data(snapshot, "tavern_outbox", "tick_f00d");
    expect(batch.row.state).toBe(state === "delivered" ? "delivered" : "cancelled");
    expect(batch.value).toMatchObject({ state: batch.row.state, text: "", cursor: 9 });
    expectLocalFieldsAbsent(batch.value, batchFields);
    expectLocalFieldsAbsent(data(snapshot, "tavern_runtime", "lead").value, runtimeFields);
    expect(data(snapshot, "tavern_records", ask.id).value).toMatchObject({ state: "withdrawn", withdrawnCause: "backup-restored", withdrawnAt: null });
    expect(data(snapshot, "tavern_records", other.id).value).toEqual(other);
    expect(source.k.store.tick("tick_f00d")).toEqual(before);
    expect(source.k.store.runtime("lead")).toEqual(runtimeBefore);
    expect(source.k.store.get("asks", ask.id)).toEqual(ask);
    expect(source.records.capture()).toEqual(snapshot);
  });
  it.each(["capture", "legacy"])("restores a %s send-pending batch without resending it or admitting its old queued text", async mode => {
    const source = fixture(), { ask, other, batch } = seed(source), target = fixture(true);
    target.advance(300_000);
    const snapshot = mode === "capture" ? source.records.capture() : legacy(source), before = JSON.stringify(snapshot);
    target.records.restore(snapshot);
    const send = vi.spyOn(target.bb.sdk.threads, "send");
    await new TickLoop(target.runtime).recover("lead");
    expect(send).not.toHaveBeenCalled();
    expect(target.k.store.pendingTick("lead")).toBeNull();
    expect(target.k.store.tick(batch.id)).toMatchObject({ state: "cancelled", text: "", cursor: 9 });
    expectLocalFieldsAbsent(target.k.store.tick(batch.id)!, batchFields);
    expectLocalFieldsAbsent(target.k.store.runtime("lead"), runtimeFields);
    expect(target.k.store.runtime("lead").cursor).toBe(0);
    expect(target.k.store.get("asks", ask.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "backup-restored", withdrawnAt: target.time() });
    expect(target.k.store.get("asks", other.id)).toEqual(other);
    expect(await target.runtime.dispatch(dispatch049({ text: batch.text, pluginId: "tavern" }))).toMatchObject({ action: "reject" });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).toBe(before);
    target.k.store.event(target.time(), "lead", null, "promise.due", "FRESH CURRENT FACT");
    await target.runtime.tick("lead");
    expect(send).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(send.mock.calls[0]![0].input);
    expect(sent).toContain("FRESH CURRENT FACT");
    expect(sent).not.toContain("OLD UPDATE MUST NOT REPLAY");
    expect(sent).not.toContain("id=tick_f00d");
  });
  it("previews retirement without inventing a restore time or writing any row", () => {
    const source = fixture(), { ask } = seed(source), target = fixture(true), snapshot = legacy(source), before = JSON.stringify(snapshot);
    const preview = target.records.validate(snapshot);
    expect(data(preview, "tavern_records", ask.id).value).toMatchObject({ state: "withdrawn", withdrawnCause: "backup-restored", withdrawnAt: null });
    expect(target.records.empty()).toBe(true);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it.each(["stored-state", "batch-state", "object"])("refuses invalid %s instead of sanitizing it into an acceptable row", variant => {
    const source = fixture(); seed(source);
    const target = fixture(true), snapshot = legacy(source), batch = data(snapshot, "tavern_outbox", "tick_f00d");
    if (variant === "stored-state") batch.row.state = "invalid";
    if (variant === "batch-state") batch.row.data = JSON.stringify({ ...batch.value, state: "invalid" });
    if (variant === "object") batch.row.data = "[]";
    expect(() => target.records.restore(snapshot)).toThrow();
    expect(target.records.empty()).toBe(true);
  });
  it("cancels mismatched batch states without treating them as accepted delivery", async () => {
    const source = fixture(); seed(source);
    const target = fixture(true), snapshot = legacy(source), batch = data(snapshot, "tavern_outbox", "tick_f00d");
    batch.row.state = "delivered";
    target.records.restore(snapshot);
    await new TickLoop(target.runtime).recover("lead");
    expect(target.k.store.tick("tick_f00d")).toMatchObject({ state: "cancelled", text: "" });
    expect(target.k.store.runtime("lead").cursor).toBe(0);
    expect(target.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  });
  it("does not withdraw another Keeper's ask through a stale delivery reference", () => {
    const source = fixture(), { ask } = seed(source);
    source.k.bind("other", "keeper", "moss", "project");
    const otherAsk = source.k.ask("other", { effect: {type:"answer-blocker"}, kind: "blocker", question: "Other Keeper's question", why: "Keep this question.",
      options: [{ id: "wait", label: "Wait", detail: "Wait", recommended: true }], meanwhile: "Other work continues.", holds: [] });
    source.k.store.patch("lead", { tickDeliveryAskId: otherAsk.id });
    const target = fixture(true); target.records.restore(legacy(source));
    expect(target.k.store.get("asks", ask.id)?.state).toBe("open");
    expect(target.k.store.get("asks", otherAsk.id)).toEqual(otherAsk);
    expectLocalFieldsAbsent(target.k.store.runtime("lead"), runtimeFields);
  });
  it.each(["turn-recovered", "backup-restored"] as const)("does not reopen or restamp an ask already withdrawn for %s", cause => {
    const source = fixture(), { ask } = seed(source);
    source.k.withdrawAsk(ask.id, cause, 42);
    const target = fixture(true); target.advance(300_000); target.records.restore(legacy(source));
    expect(target.k.store.get("asks", ask.id)).toMatchObject({ state: "withdrawn", withdrawnCause: cause, withdrawnAt: 42 });
  });
});
