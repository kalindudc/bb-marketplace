// @vitest-environment node
import { seedQuest } from "./support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput, waypointEntry } from "./support";
import { makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "./host";
import { rpcHandlers, registerRpc } from "../../src/server/rpc";
import { registrySchema, type BoardQuestDetail, type Room } from "../../src/shared/contract";
import { serviceQuestRecordSchema, characterServiceRecordSchema } from "../../src/shared/service-record";
import type { JournalEntry } from "../../src/shared/schema";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function fixture() {
  const f = setup(); databases.push(f.k.store.db);
  const q = await seedQuest(f.k,"lead", "Keep the proof", "Earned history");
  f.k.plan("lead", planInput(q.id));
  const brief = { outcome: "Work", mode: "make-it-work" as const, outOfScope: "Publish", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null };
  for (const [threadId, classId, characterId] of [["maker", "smith", "juno"], ["checker", "warden", "vex"]]) f.k.bind(threadId!, classId!, characterId!, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Work", errand: false, brief });
  f.k.store.put("members", "checker", { ...f.k.member("checker")!, checkIndependence: "independent" });
  const entry = waypointEntry("maker", q.id);
  entry.doneAt = f.time(); entry.doneBy = { kind: "agent", threadId: "maker" };
  let entries: JournalEntry[] = [entry];
  f.port.linkedEntries = () => entries;
  let sequence = 0;
  const review = (verdict: "verify" | "reject", before = entries[0]!) => {
    f.advance(1);
    const after: JournalEntry = { ...structuredClone(before), status: verdict === "verify" ? "verified" : "rejected", review: { actor: { kind: "agent", threadId: "checker" }, at: f.time(), evidence: entry.evidence, reason: verdict === "reject" ? "Missing regression" : null, previousNote: null, memberEvidenceAt: null } };
    if (verdict === "reject") { after.doneAt = null; after.doneBy = null; }
    f.runtime.serviceRecords.reviewed({ before, after, sequence: ++sequence });
    entries = [after]; return after;
  };
  const fixed = (rejected: JournalEntry, changedEvidence = true) => {
    f.advance(1);
    const next = structuredClone(rejected); next.status = "done"; next.doneAt = f.time(); next.doneBy = { kind: "agent", threadId: "maker" };
    next.review!.memberEvidenceAt = f.time();
    if (changedEvidence) next.evidence.push({ kind: "command", ref: "node regression.test.js", detail: "Missing case now passes", exitCode: 0 });
    entries = [next]; return next;
  };
  const records = () => f.runtime.serviceRecords.read();
  const record = (id: string) => records().find(row => row.characterId === id)!;
  return { ...f, q, entry, review, fixed, records, record, setEntries: (next: JournalEntry[]) => { entries = next; } };
}

describe("lasting character service record", () => {
  it("writes once at return, counts verified waypoints rather than entries, and gives the Keeper its own record", async () => {
    const f = await fixture(); const verified = f.review("verify");
    f.setEntries([verified, { ...verified, id: "a2" }]);
    expect(f.records()).toEqual([]);
    await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.record("juno")).toMatchObject({ maker: { verifiedWaypoints: 1, quests: 1 }, recordsTotal: 1 });
    expect(f.record("vex")).toMatchObject({ warden: { checks: 1, independentChecks: 1, sameFamilyChecks: 0, caughtDefects: 0 } });
    expect(f.record("wren")).toMatchObject({ keeper: { returnedQuests: 1, verifiedReturns: 1, stoppedQuests: 0, verifiedWaypoints: 1 } });
    expect(f.k.store.get("serviceRecords", f.q.id)!.waypoints).toEqual({ verified: 1, total: 1, skipped: 0 });
    expect(f.record("juno")).not.toHaveProperty("warden");
    const before = f.records(); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.records()).toEqual(before);
  });
  it("does not award a verified return when every optional waypoint was skipped", async () => {
    const f = await fixture();
    f.k.plan("lead", { ...planInput(f.q.id), waypoints: [{ ...planInput(f.q.id).waypoints[0]!, optional: true }] });
    await f.runtime.wrap("lead", f.q.id, "Nothing needed making", "", [{ waypointId: "w1", reason: "Not needed" }]);
    expect(f.record("wren").keeper).toEqual({ returnedQuests: 1, verifiedReturns: 0, stoppedQuests: 0, verifiedWaypoints: 0, firstEarnedAt: f.k.quest(f.q.id).endedAt, completeSince: null });
    const stored = serviceQuestRecordSchema.parse(f.k.store.get("serviceRecords", f.q.id));
    expect(stored.waypoints).toEqual({ verified: 0, total: 1, skipped: 1 });
    expect(characterServiceRecordSchema.parse(f.record("wren")).records[0]!.waypoints).toEqual(stored.waypoints);
  });
  it("captures mixed verification and skips without calling a skipped waypoint verified in room or quest DTOs", async () => {
    const f = await fixture(), plan = planInput(f.q.id);
    f.k.plan("lead", { ...plan, waypoints: [...plan.waypoints, { ...plan.waypoints[0]!, id: "w2", optional: true }] });
    f.review("verify");
    await f.runtime.wrap("lead", f.q.id, "One checked, one not needed", "", [{ waypointId: "w2", reason: "Not needed" }]);
    const expected = { verified: 1, total: 2, skipped: 1 };
    expect(serviceQuestRecordSchema.parse(f.k.store.get("serviceRecords", f.q.id)).waypoints).toEqual(expected);
    registerRpc(f.bb, f.runtime);
    const room = await f.harness.invokeRpc("room", {}) as Room;
    const detail = await f.harness.invokeRpc("boardQuest", { id: f.q.id }) as BoardQuestDetail;
    for (const quest of [room.keepers[0]!.boardQuests.find(row => row.id === f.q.id)!, detail.quest]) {
      expect(quest.waypoints.map(waypoint => waypoint.state)).toEqual(["verified", "skipped"]);
      expect(quest.waypoints.filter(waypoint => waypoint.state === "verified")).toHaveLength(1);
      expect(quest.waypoints.filter(waypoint => waypoint.state === "skipped")).toHaveLength(1);
    }
    const registry = registrySchema.parse(await f.harness.invokeRpc("registry", {}));
    expect(registry.serviceRecords!.find(row => row.characterId === "wren")!.records[0]!.waypoints).toEqual(expected);
  });
  it("leaves a stored legacy skipped count unknown through reads and startup backfill", async () => {
    const f = await fixture();
    f.k.plan("lead", { ...planInput(f.q.id), waypoints: [{ ...planInput(f.q.id).waypoints[0]!, optional: true }] });
    await f.runtime.wrap("lead", f.q.id, "Not needed", "", [{ waypointId: "w1", reason: "Not needed" }]);
    const legacy = { ...f.k.store.get("serviceRecords", f.q.id)!, waypoints: { verified: 0, total: 1 } };
    f.k.store.put("serviceRecords", f.q.id, legacy);
    expect(serviceQuestRecordSchema.parse(legacy).waypoints).toEqual({ verified: 0, total: 1 });
    expect(characterServiceRecordSchema.parse(f.record("wren")).records[0]!.waypoints).toEqual({ verified: 0, total: 1 });
    f.runtime.serviceRecords.backfill();
    expect(f.k.store.get("serviceRecords", f.q.id)).toEqual(legacy);
    expect(f.record("wren").records[0]!.waypoints).not.toHaveProperty("skipped");
  });
  it("does not turn an all-skipped legacy return into a verified return during backfill", async () => {
    const f = await fixture();
    f.k.plan("lead", { ...planInput(f.q.id), waypoints: [{ ...planInput(f.q.id).waypoints[0]!, optional: true }] });
    await f.runtime.wrap("lead", f.q.id, "Nothing needed making", "", [{ waypointId: "w1", reason: "Not needed" }]);
    f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind LIKE 'service%'").run();
    f.runtime.serviceRecords.backfill();
    expect(f.record("wren").keeper).toEqual({ returnedQuests: 1, verifiedReturns: 0, stoppedQuests: 0, verifiedWaypoints: 0, firstEarnedAt: f.k.quest(f.q.id).endedAt, completeSince: f.time() });
    expect(f.record("wren").completeSince).toBe(f.time());
    expect(f.k.store.get("serviceRecords", f.q.id)!.waypoints).toEqual({ verified: 0, total: 1 });
    expect(characterServiceRecordSchema.parse(f.record("wren")).records[0]!.waypoints).not.toHaveProperty("skipped");
  });
  it("does not award a verified return to a stopped quest, even with verified work", async () => {
    const f = await fixture(); f.review("verify");
    f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
    await f.runtime.stop(f.q.id, "Stop after this proof");
    expect(f.record("wren").keeper).toEqual({ returnedQuests: 0, verifiedReturns: 0, stoppedQuests: 1, verifiedWaypoints: 1, firstEarnedAt: f.k.quest(f.q.id).endedAt, completeSince: f.time() });
    expect(f.k.store.get("serviceRecords", f.q.id)!.waypoints).toEqual({ verified: 1, total: 1, skipped: 0 });
  });
  it("archiving members and cellaring the quest leave the entire service record unchanged", async () => {
    const f = await fixture(); f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    const before = f.records();
    f.runtime.updateThread(makeThreadResponse({ id: "maker", archivedAt: f.time() }));
    f.runtime.updateThread(makeThreadResponse({ id: "checker", archivedAt: f.time() }));
    f.k.archiveQuests([f.q.id], true);
    expect(f.records()).toEqual(before);
  });
  it("deletion preserves counts and dates but removes maker, checker and Keeper links, including receipts", async () => {
    const f = await fixture(); f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    const before = f.record("juno");
    for (const id of ["maker", "checker", "lead"]) f.runtime.threadGone(id);
    expect(f.record("juno")).toMatchObject({ maker: before.maker, firstEarnedAt: before.firstEarnedAt, lastEarnedAt: before.lastEarnedAt });
    for (const row of f.records()) for (const item of row.records) { expect(item.threadIds).toEqual([]); expect(item.keeperThreadId).toBeNull(); }
    for (const receipt of f.k.store.all("serviceVerdicts")) { expect(receipt.maker.threadId).toBeNull(); expect(receipt.checker.threadId).toBeNull(); }
  });
  it("a deleted keeper payload redacts links even when it arrives through updateThread", async () => {
    const f = await fixture(); f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    f.runtime.updateThread(makeThreadResponse({ id: "lead", deletedAt: f.time() }));
    expect(f.record("wren").records[0]!.keeperThreadId).toBeNull();
    expect(f.record("wren").keeper?.returnedQuests).toBe(1);
  });
  it.each(["same-family", "not-established"] as const)("does not call a recorded %s check independent", async independence => {
    const f = await fixture(); f.k.store.put("members", "checker", { ...f.k.member("checker")!, checkIndependence: independence });
    f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.record("vex").warden).toMatchObject({ checks: 1, independentChecks: 0, sameFamilyChecks: independence === "same-family" ? 1 : 0 });
  });
  it("backfills a legacy stopped quest before a later return without claiming complete history", async () => {
    const f = await fixture(); f.review("verify");
    f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind LIKE 'service%'").run();
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "stopped", endedAt: f.time() });
    f.advance(1000); const boundary = f.time(); f.runtime.serviceRecords.backfill();
    f.setEntries([]); f.advance(1000);
    const later = await seedQuest(f.k,"lead", "A later quest", "New work");
    f.k.plan("lead", { ...planInput(later.id), waypoints: [{ ...planInput(later.id).waypoints[0]!, optional: true }] });
    await f.runtime.wrap("lead", later.id, "No implementation needed", "", [{ waypointId: "w1", reason: "Not needed" }]);
    expect(f.record("wren")).toMatchObject({ completeSince: boundary, keeper: { stoppedQuests: 1, returnedQuests: 1, verifiedReturns: 0 } });
    expect(f.record("juno")).toMatchObject({ completeSince: boundary, maker: { verifiedWaypoints: 1, quests: 1 } });
    expect(f.record("vex")).toMatchObject({ completeSince: boundary, warden: { checks: 1, caughtSince: boundary } });
    const before = f.records(); f.runtime.serviceRecords.backfill(); expect(f.records()).toEqual(before);
  });
  it("records an admitted worker override and uses that exact pair for its next verdict", async () => {
    const f = await fixture();
    for (const [threadId, providerId, model] of [["maker", "claude-code", "claude-sonnet-4"], ["checker", "codex", "gpt-5"]]) f.k.store.event(f.time(), "lead", f.q.id, "member.hired", "Hired", { memberThreadId: threadId, execution: { providerId, model } });
    const ctx = makeMessageDispatchHookContext({ thread: { id: "checker", status: "idle" } });
    ctx.requestedExecution = { ...ctx.requestedExecution, providerId: "pi", model: "claude-opus-4" };
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(f.k.store.runtime("checker").classExecutionChoice).toMatchObject({ providerId: "pi", model: "claude-opus-4", recordedAt: f.time() });
    f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.record("vex").warden).toMatchObject({ independentChecks: 0, sameFamilyChecks: 1 });
  });
  it("treats an admitted provider-default model as unknown rather than reusing its superseded hire family", async () => {
    const f = await fixture();
    for (const [threadId, providerId, model] of [["maker", "claude-code", "claude-sonnet-4"], ["checker", "codex", "gpt-5"]]) f.k.store.event(f.time(), "lead", f.q.id, "member.hired", "Hired", { memberThreadId: threadId, execution: { providerId, model } });
    const ctx = makeMessageDispatchHookContext({ thread: { id: "checker", status: "idle" } });
    ctx.requestedExecution = { ...ctx.requestedExecution, providerId: "pi", model: null }; f.advance(1000);
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.k.store.all("serviceVerdicts")[0]).toMatchObject({ checker: { family: null }, independence: "not-established" });
    expect(f.record("vex").warden).toMatchObject({ independentChecks: 0 });
  });
  it("does not retain stale independent posture when the maker's newer choice is incomplete", async () => {
    const f = await fixture();
    for (const [threadId, providerId, model] of [["maker", "codex", "gpt-5"], ["checker", "claude-code", "claude-opus-4"]]) f.k.store.event(f.time(), "lead", f.q.id, "member.hired", "Hired", { memberThreadId: threadId, execution: { providerId, model } });
    f.advance(1000); f.k.store.patch("maker", { classExecutionChoice: { providerId: "claude-code", model: null, recordedAt: f.time(), reasoningLevel: null, modelSource: null, reasoningSource: null } });
    f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.k.store.all("serviceVerdicts")[0]).toMatchObject({ maker: { family: null }, independence: "not-established" });
    expect(f.record("vex").warden).toMatchObject({ independentChecks: 0 });
  });
  it.each([false, true])("admits after an execution write failure, keeps that period unknown, then recovers (cached pair=%s)", async cached => {
    const f = await fixture();
    for (const [threadId, providerId, model] of [["maker", "claude-code", "claude-sonnet-4"], ["checker", "codex", "gpt-5"]]) f.k.store.event(f.time(), "lead", f.q.id, "member.hired", "Hired", { memberThreadId: threadId, execution: { providerId, model } });
    const ctx = makeMessageDispatchHookContext({ thread: { id: "checker", status: "idle" } });
    ctx.requestedExecution = { ...ctx.requestedExecution, providerId: "pi", model: "claude-opus-4" };
    f.k.store.patch("checker", { classExecutionChoice: { providerId: "codex", model: "gpt-5", recordedAt: f.time(), reasoningLevel: null, modelSource: null, reasoningSource: null } }); f.advance(1000);
    const patch = f.k.store.patch.bind(f.k.store), warn = vi.spyOn(f.bb.log, "warn"); let fail = true;
    const writes = vi.spyOn(f.k.store, "patch").mockImplementation((threadId, value) => {
      if (threadId === "checker" && Object.hasOwn(value, "classExecutionChoice") && fail) throw new Error("Execution metadata unavailable");
      return patch(threadId, value);
    });
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Execution metadata unavailable"));
    f.review("verify"); expect(f.k.store.all("serviceVerdicts")[0]).toMatchObject({ checker: { family: null }, independence: "not-established" });
    fail = false; f.advance(1000);
    if (cached) ctx.requestedExecution = { ...ctx.requestedExecution, providerId: "codex", model: "gpt-5" };
    const beforeRetry = writes.mock.calls.filter(([, value]) => Object.hasOwn(value, "classExecutionChoice")).length;
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" }); f.review("verify");
    expect(writes.mock.calls.filter(([, value]) => Object.hasOwn(value, "classExecutionChoice"))).toHaveLength(beforeRetry + (cached ? 0 : 1));
    expect(f.k.store.all("serviceVerdicts").sort((a, b) => a.at - b.at).map(row => row.checker.family)).toEqual([null, cached ? "openai" : "anthropic"]);
  });
  it("does not rewrite an unchanged admitted worker pair or move its recording time", async () => {
    const f = await fixture(); const ctx = makeMessageDispatchHookContext({ thread: { id: "checker", status: "idle" } });
    const choice = { providerId: ctx.requestedExecution.providerId, model: ctx.requestedExecution.model, recordedAt: f.time(), reasoningLevel: null, modelSource: null, reasoningSource: null };
    f.k.store.patch("checker", { classExecutionChoice: choice }); f.advance(1000);
    const patch = vi.spyOn(f.k.store, "patch"); expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
    expect(patch.mock.calls.filter(([, value]) => Object.hasOwn(value, "classExecutionChoice"))).toEqual([]);
    expect(f.k.store.runtime("checker").classExecutionChoice).toEqual(choice);
  });
  it.each([false, true])("does not record worker execution for a Keeper turn (tick=%s)", async tick => {
    const f = await fixture(); const ctx = makeMessageDispatchHookContext({ thread: { id: "lead", status: "idle" } });
    if (tick) { ctx.originPluginId = "tavern"; ctx.input.text = "[Tavern tick] id=unknown"; ctx.input.blocks = [{ type: "text", text: ctx.input.text, visibility: "agent-only", mentions: [] }]; }
    const patch = vi.spyOn(f.k.store, "patch"); await f.runtime.dispatch(ctx);
    expect(patch.mock.calls.filter(([, value]) => Object.hasOwn(value, "classExecutionChoice"))).toEqual([]);
  });
  it.each(["reject", "wait"])("does not record an execution pair for a %s dispatch", async action => {
    const f = await fixture(); const ctx = makeMessageDispatchHookContext({ thread: { id: "checker", status: "idle" } });
    if (action === "reject") f.port.dispatchCheck = () => "Hold this message";
    else vi.spyOn(f.runtime, "prepareRegistry").mockRejectedValue(new Error("Registry pending"));
    const patch = vi.spyOn(f.k.store, "patch"); expect(await f.runtime.dispatch(ctx)).toMatchObject({ action });
    expect(patch.mock.calls.filter(([, value]) => Object.hasOwn(value, "classExecutionChoice"))).toEqual([]);
  });
  it("uses a complete recorded live execution pair before the verdict instead of mixing in the hire provider", async () => {
    const f = await fixture();
    f.k.store.event(f.time(), "lead", f.q.id, "member.hired", "Maker", { memberThreadId: "maker", execution: { providerId: "claude-code", model: "claude-sonnet-4" } });
    f.k.store.event(f.time(), "lead", f.q.id, "member.hired", "Checker", { memberThreadId: "checker", execution: { providerId: "codex", model: "gpt-5" } });
    f.k.store.patch("checker", { classExecutionChoice: { providerId: "claude-code", model: "claude-opus-4", recordedAt: f.time(), reasoningLevel: null, modelSource: null, reasoningSource: null } });
    f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.record("vex").warden).toMatchObject({ independentChecks: 0, sameFamilyChecks: 1 });
    expect(f.k.store.all("serviceVerdicts")[0]).toMatchObject({ maker: { family: "anthropic" }, checker: { family: "anthropic" } });
  });
  it("falls back to a complete hire pair when the current choice is incomplete or dates after the verdict", async () => {
    const f = await fixture();
    for (const threadId of ["maker", "checker"]) f.k.store.event(f.time(), "lead", f.q.id, "member.hired", "Hired", { memberThreadId: threadId, execution: { providerId: "claude-code", model: "claude-sonnet-4" } });
    f.k.store.patch("maker", { classExecutionChoice: { model: "gpt-5", reasoningLevel: null, modelSource: null, reasoningSource: null } });
    f.k.store.patch("checker", { classExecutionChoice: { providerId: "codex", model: "gpt-5", recordedAt: f.time() + 1000, reasoningLevel: null, modelSource: null, reasoningSource: null } });
    f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.record("vex").warden).toMatchObject({ independentChecks: 0, sameFamilyChecks: 1 });
  });
  it("does not guess families from partial execution records or a provider default", async () => {
    const f = await fixture();
    for (const threadId of ["maker", "checker"]) {
      f.k.store.event(f.time(), "lead", f.q.id, "member.hired", "Hired", { memberThreadId: threadId, execution: { providerId: "claude-code" } });
      f.k.store.patch(threadId, { classExecutionChoice: { model: "claude-sonnet-4", reasoningLevel: null, modelSource: null, reasoningSource: null } });
    }
    f.k.store.put("members", "checker", { ...f.k.member("checker")!, checkIndependence: "not-established" });
    f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.k.store.all("serviceVerdicts")[0]).toMatchObject({ maker: { family: null }, checker: { family: null }, independence: "not-established" });
    expect(f.record("vex").warden).toMatchObject({ independentChecks: 0, sameFamilyChecks: 0 });
  });
  it("known matching recorded model families never count as independent even with a stale independent label", async () => {
    const f = await fixture();
    for (const id of ["maker", "checker"]) f.k.store.patch(id, { classExecutionChoice: { providerId: "pi", model: "claude-sonnet-4", recordedAt: f.time(), reasoningLevel: null, modelSource: null, reasoningSource: null } });
    f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.record("vex").warden).toMatchObject({ independentChecks: 0, sameFamilyChecks: 1 });
  });
  it("a recorded rejection with no verified fix is a check, not a catch, when stopped", async () => {
    const f = await fixture(); f.fixed(f.review("reject"));
    let status: "active" | "idle" = "active";
    f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, status }));
    f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
    await f.runtime.stop(f.q.id, "Not finished");
    expect(f.k.quest(f.q.id).phase).toBe("stopping"); expect(f.records()).toEqual([]);
    status = "idle"; f.advance(5000); await f.runtime.retryStops("lead");
    expect(f.k.quest(f.q.id).phase).toBe("stopped");
    expect(f.record("vex").warden).toMatchObject({ checks: 1, caughtDefects: 0 });
    expect(f.record("wren").keeper).toMatchObject({ returnedQuests: 0, stoppedQuests: 1 });
    expect(f.records().find(r => r.characterId === "juno")).toBeUndefined();
  });
  it.each([false, true])("keeps supersession sticky through replay, undo and redo (legacy=%s)", async legacy => {
    const f = await fixture(), old = f.review("verify");
    if (legacy) f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind='serviceVerdicts'").run();
    f.k.store.db.prepare("INSERT INTO questlog_logs(thread_id) VALUES(?)").run("maker");
    f.k.store.db.prepare("INSERT INTO questlog_history(thread_id,before_data,after_data,action,actor,state) VALUES(?,?,?,?,?,'undo')").run("maker", JSON.stringify([f.entry]), JSON.stringify([old]), "verify", JSON.stringify({ kind: "agent", threadId: "checker" }));
    const at = f.time();
    f.k.store.atomic(() => f.runtime.serviceRecords.superseded({ entry: old, version: 2, at }));
    const receipt = f.k.store.all("serviceVerdicts")[0]!;
    expect(receipt).toMatchObject({ superseded: { at, reason: "superseded by brief v2" } });
    f.runtime.serviceRecords.reviewed({ before: f.entry, after: old, sequence: 2, undone: true });
    f.runtime.serviceRecords.reviewed({ before: f.entry, after: old, sequence: 3, undone: false });
    f.runtime.serviceRecords.superseded({ entry: old, version: 3, at: at + 1 });
    expect(f.k.store.get("serviceVerdicts", receipt.id)).toMatchObject({ withdrawn: false, superseded: { at, reason: "superseded by brief v2" } });
    f.review("verify", { ...f.entry, evidence: [{ kind: "command", ref: "node fresh-tests.js", detail: "Fresh brief proved", exitCode: 0 }] });
    await f.runtime.wrap("lead", f.q.id, "New brief proved", "");
    expect(f.record("vex").warden).toMatchObject({ checks: 2, independentChecks: 2 });
    expect(f.record("juno").maker?.verifiedWaypoints).toBe(1);
    expect(f.k.store.get("serviceVerdicts", receipt.id)).toHaveProperty("superseded");
  });
  it("recovers a legacy catch before supersession freezes its verify receipt", async () => {
    const f = await fixture(), rejected = f.review("reject"), fixed = f.fixed(rejected), verified = f.review("verify", fixed);
    f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind='serviceVerdicts'").run();
    f.k.store.db.prepare("INSERT INTO questlog_logs(thread_id) VALUES(?)").run("maker");
    const history = f.k.store.db.prepare("INSERT INTO questlog_history(thread_id,before_data,after_data,action,actor,state) VALUES(?,?,?,?,?,'undo')");
    history.run("maker", JSON.stringify([f.entry]), JSON.stringify([rejected]), "reject", JSON.stringify({ kind: "agent", threadId: "checker" }));
    history.run("maker", JSON.stringify([fixed]), JSON.stringify([verified]), "verify", JSON.stringify({ kind: "agent", threadId: "checker" }));
    f.runtime.serviceRecords.superseded({ entry: verified, version: 2, at: f.time() });
    f.setEntries([{ ...verified, status: "doing", review: null }]);
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "stopped", endedAt: f.time() });
    f.runtime.serviceRecords.record(f.q.id);
    expect(f.record("vex").warden).toMatchObject({ checks: 2, caughtDefects: 1 });
    expect(f.records().find(row => row.characterId === "juno")).toBeUndefined();
  });
  it("retains the Warden check and completed catch when supersession removes maker proof", async () => {
    const f = await fixture(), fixed = f.fixed(f.review("reject")), old = f.review("verify", fixed);
    f.runtime.serviceRecords.superseded({ entry: old, version: 2, at: f.time() });
    f.setEntries([{ ...old, status: "doing", review: null }]);
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "stopped", endedAt: f.time() });
    f.runtime.serviceRecords.record(f.q.id);
    expect(f.record("vex").warden).toMatchObject({ checks: 2, caughtDefects: 1 });
    expect(f.records().find(row => row.characterId === "juno")).toBeUndefined();
    expect(f.k.store.all("serviceVerdicts").find(row => row.verdict === "rejected")).not.toHaveProperty("superseded");
  });
  it("supersedes same-family checks but ignores non-verdicts and terminal records", async () => {
    const f = await fixture();
    f.k.store.put("members", "checker", { ...f.k.member("checker")!, checkIndependence: "same-family" });
    f.runtime.serviceRecords.superseded({ entry: f.entry, version: 2, at: f.time() });
    expect(f.k.store.all("serviceVerdicts")).toEqual([]);
    const old = f.review("verify");
    f.runtime.serviceRecords.superseded({ entry: old, version: 2, at: f.time() });
    expect(f.k.store.all("serviceVerdicts")[0]).toMatchObject({ independence: "same-family", superseded: { reason: "superseded by brief v2" } });
    f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    const records = f.records(), receipts = f.k.store.all("serviceVerdicts");
    expect(() => f.runtime.serviceRecords.superseded({ entry: old, version: 3, at: f.time() })).not.toThrow();
    expect(f.records()).toEqual(records); expect(f.k.store.all("serviceVerdicts")).toEqual(receipts);
  });
  it("does not award maker proof from a superseded entry restored by old history", async () => {
    const f = await fixture(), old = f.review("verify");
    f.runtime.serviceRecords.superseded({ entry: old, version: 2, at: f.time() });
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "stopped", endedAt: f.time() });
    f.runtime.serviceRecords.record(f.q.id);
    expect(f.records().find(row => row.characterId === "juno")).toBeUndefined();
    expect(f.record("vex").warden).toMatchObject({ independentChecks: 1 });
  });
  it("does not award a deleted maker superseded proof when another maker now verifies that waypoint", async () => {
    const f = await fixture(), old = f.review("verify");
    f.runtime.serviceRecords.superseded({ entry: old, version: 2, at: f.time() });
    f.runtime.threadGone("maker");
    f.k.bind("replacement", "smith", "mira", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", errand: false, title: "New work", brief: f.k.store.runtime("maker").brief! });
    f.review("verify", { ...f.entry, threadId: "replacement" });
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
    f.runtime.serviceRecords.record(f.q.id);
    expect(f.records().find(row => row.characterId === "juno")).toBeUndefined();
    expect(f.record("mira").maker?.verifiedWaypoints).toBe(1);
    expect(f.record("vex").warden?.independentChecks).toBe(2);
  });
  it("logs a failed supersession write without aborting a rebrief", async () => {
    const f = await fixture(), old = f.review("verify"), warn = vi.spyOn(f.bb.log, "warn"), put = f.k.store.put.bind(f.k.store);
    vi.spyOn(f.k.store, "put").mockImplementation((...args) => { if (args[0] === "serviceVerdicts") throw new Error("receipt disk unavailable"); return put(...args); });
    expect(() => f.runtime.serviceRecords.superseded({ entry: old, version: 2, at: f.time() })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("receipt disk unavailable"));
  });
  it("withdraws a verdict receipt on undo and restores that same proof on redo", async () => {
    const f = await fixture(), verified = f.review("verify");
    const receipt = f.k.store.all("serviceVerdicts")[0]!;
    f.advance(1); f.runtime.serviceRecords.reviewed({ before: f.entry, after: verified, sequence: 2, undone: true });
    expect(f.k.store.get("serviceVerdicts", receipt.id)).toMatchObject({ withdrawn: true });
    f.advance(1); f.runtime.serviceRecords.reviewed({ before: f.entry, after: verified, sequence: 3, undone: false });
    expect(f.k.store.get("serviceVerdicts", receipt.id)).toMatchObject({ at: receipt.at, withdrawn: false });
    expect(f.k.store.all("serviceVerdicts")).toHaveLength(1);
  });
  it.each([true, false])("refuses linked review history changes after its terminal record is written (undo=%s)", async undone => {
    const f = await fixture(), verified = f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    const before = f.records(), receipts = f.k.store.all("serviceVerdicts");
    expect(() => f.runtime.serviceRecords.reviewed({ before: f.entry, after: verified, sequence: 2, undone })).toThrow("This quest has ended and its record is written, so this verdict can\'t be undone.");
    expect(f.records()).toEqual(before); expect(f.k.store.all("serviceVerdicts")).toEqual(receipts);
  });
  it("does not count a withdrawn verification or a catch whose verification was undone", async () => {
    const f = await fixture(), fixed = f.fixed(f.review("reject")), verified = f.review("verify", fixed);
    f.runtime.serviceRecords.reviewed({ before: fixed, after: verified, sequence: 3, undone: true });
    f.setEntries([fixed]); f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "stopped", endedAt: f.time() });
    f.k.store.atomic(() => f.runtime.serviceRecords.record(f.q.id));
    expect(f.record("vex").warden).toMatchObject({ checks: 1, caughtDefects: 0 });
  });
  it("does not count a catch whose rejection has been withdrawn", async () => {
    const f = await fixture(), rejected = f.review("reject"), fixed = f.fixed(rejected);
    f.review("verify", fixed); f.runtime.serviceRecords.reviewed({ before: f.entry, after: rejected, sequence: 3, undone: true });
    await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.record("vex").warden).toMatchObject({ checks: 1, caughtDefects: 0 });
  });
  it("credits a catch only after new maker evidence and a Warden verification, even after undo history is gone", async () => {
    const f = await fixture(); f.review("verify", f.fixed(f.review("reject")));
    f.k.store.db.exec("DELETE FROM questlog_history; DELETE FROM questlog_changes;");
    await f.runtime.wrap("lead", f.q.id, "Fixed and proved", "");
    expect(f.record("vex").warden).toMatchObject({ checks: 2, independentChecks: 2, caughtDefects: 1 });
  });
  it.each(["no-new-evidence", "not-maker", "no-rejection"])("does not infer a catch from %s", async mode => {
    const f = await fixture(); const rejected = f.review("reject"); const before = f.fixed(rejected, mode !== "no-new-evidence");
    if (mode === "not-maker") before.doneBy = { kind: "user" };
    if (mode === "no-rejection") before.review = null;
    f.review("verify", before); await f.runtime.wrap("lead", f.q.id, "Proved", "");
    expect(f.record("vex").warden?.caughtDefects).toBe(0);
  });
  it("backs up legacy returned quests once without double counting surviving entries and stored wins", async () => {
    const f = await fixture(); const verified = f.review("verify");
    f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind LIKE 'service%'").run();
    f.setEntries([verified, { ...verified, id: "a2" }]);
    f.k.store.put("members", "maker", { ...f.k.member("maker")!, verifiedWins: 1 });
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
    f.advance(1000); f.runtime.serviceRecords.backfill();
    expect(f.record("juno")).toMatchObject({ maker: { verifiedWaypoints: 1 }, backfilledAt: f.time(), completeSince: f.time() });
    expect(f.record("vex").warden).toMatchObject({ checks: 1, caughtDefects: 0, caughtSince: f.time() });
    expect(f.record("wren").keeper?.returnedQuests).toBe(1);
    const before = f.records(); f.advance(5000); f.runtime.serviceRecords.backfill(); expect(f.records()).toEqual(before);
    expect(f.k.store.all("serviceRecords")).toHaveLength(1);
  });
  it("does not add overlapping legacy thread wins for the same character and waypoint", async () => {
    const f = await fixture(), verified = f.review("verify");
    f.k.bind("other-maker", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", errand: false, title: "Help", brief: f.k.store.runtime("maker").brief! });
    for (const id of ["maker", "other-maker"]) f.k.store.put("members", id, { ...f.k.member(id)!, verifiedWins: 1 });
    f.setEntries([verified, { ...verified, threadId: "other-maker" }]);
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
    f.runtime.serviceRecords.backfill();
    expect(f.record("juno").maker).toEqual({ verifiedWaypoints: 1, quests: 1, firstEarnedAt: f.k.quest(f.q.id).endedAt, completeSince: f.time() });
  });
  it("preserves recorded legacy maker wins when the old thread and its journal have gone", async () => {
    const f = await fixture(); f.setEntries([]); f.k.store.put("members", "maker", { ...f.k.member("maker")!, verifiedWins: 3 });
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
    f.runtime.threadGone("maker"); f.runtime.serviceRecords.backfill();
    expect(f.record("juno").maker).toEqual({ verifiedWaypoints: 3, quests: 1, firstEarnedAt: f.k.quest(f.q.id).endedAt, completeSince: f.time() });
    expect(f.record("juno").records[0]!.threadIds).toEqual([]);
    expect(f.record("wren").keeper).toMatchObject({ returnedQuests: 1, verifiedReturns: 1, verifiedWaypoints: 3 });
  });
  it("reads service history only through registry RPC, with no changes to agent snapshots, configuration, reports or journal text", async () => {
    const f = await fixture(); f.review("verify");
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
    const context = makePluginAgentConfigurationContext({ thread: { id: "lead" } });
    const before = { snapshot: f.runtime.snapshot(), config: f.runtime.configure(context), journal: f.port.instructions("maker"), reports: f.k.store.all("reports"), events: f.k.store.events("lead") };
    f.runtime.serviceRecords.backfill();
    expect({ snapshot: f.runtime.snapshot(), config: f.runtime.configure(context), journal: f.port.instructions("maker"), reports: f.k.store.all("reports"), events: f.k.store.events("lead") }).toEqual(before);
    const output = await rpcHandlers(f.runtime).registry({});
    expect(output.serviceRecords?.find(row => row.characterId === "wren")?.keeper?.returnedQuests).toBe(1);
    expect(f.runtime.snapshot()).not.toHaveProperty("serviceRecords");
  });
  it("caps read history at twenty, retains aggregate totals, captures names, and sorts newest first", async () => {
    const f = await fixture(); f.review("verify");
    for (let i = 0; i < 23; i++) {
      const id = `${f.q.id}-${i}`;
      f.k.store.put("quests", id, { ...f.k.quest(f.q.id), id, short: `Q${i}`, title: `Quest ${i}`, phase: "done", endedAt: f.time() + i });
    }
    f.runtime.serviceRecords.backfill(); const row = f.record("wren");
    expect(row.keeper?.returnedQuests).toBe(23); expect(row.recordsTotal).toBe(23); expect(row.records).toHaveLength(20);
    expect(row.records[0]).toMatchObject({ title: "Quest 22", short: "Q22" });
  });
  it("credits the original rejecting Warden, not a different Warden who verifies the fix", async () => {
    const f = await fixture(); const fixed = f.fixed(f.review("reject"));
    f.k.bind("second", "warden", "maeve", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", errand: false, title: "Recheck", brief: f.k.store.runtime("checker").brief! });
    f.advance(1);
    const after = { ...fixed, status: "verified" as const, review: { ...fixed.review!, actor: { kind: "agent" as const, threadId: "second" }, at: f.time(), reason: null, memberEvidenceAt: null } };
    f.runtime.serviceRecords.reviewed({ before: fixed, after, sequence: 3 }); f.setEntries([after]);
    await f.runtime.wrap("lead", f.q.id, "Fixed and proved", "");
    expect(f.record("vex").warden).toMatchObject({ checks: 1, caughtDefects: 1 });
    expect(f.record("maeve").warden).toMatchObject({ checks: 1, caughtDefects: 0 });
  });
  it("recovers a legacy catch only when the surviving history records the entire rejection, new evidence and verification chain", async () => {
    const f = await fixture(), rejected = f.review("reject"), fixed = f.fixed(rejected), verified = f.review("verify", fixed);
    f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind LIKE 'service%'").run();
    f.k.store.db.prepare("INSERT INTO questlog_logs(thread_id) VALUES(?)").run("maker");
    const insert = f.k.store.db.prepare("INSERT INTO questlog_history(thread_id,before_data,after_data,action,actor,state) VALUES(?,?,?,?,?,'undo')");
    insert.run("maker", JSON.stringify([f.entry]), JSON.stringify([rejected]), "reject", JSON.stringify({ kind: "agent", threadId: "checker" }));
    insert.run("maker", JSON.stringify([fixed]), JSON.stringify([verified]), "verify", JSON.stringify({ kind: "agent", threadId: "checker" }));
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
    f.runtime.serviceRecords.backfill();
    expect(f.record("vex").warden).toMatchObject({ checks: 2, caughtDefects: 1, caughtSince: f.time() });
  });
  it("preserves undated legacy counts without turning an update or backfill timestamp into an earned date", async () => {
    const f = await fixture(); f.setEntries([]);
    f.k.store.put("members", "maker", { ...f.k.member("maker")!, verifiedWins: 3 });
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: null, updatedAt: f.time() + 999 });
    f.k.store.put("quests", "dated", { ...f.k.quest(f.q.id), id: "dated", endedAt: f.time() + 100 });
    f.runtime.serviceRecords.backfill();
    expect(f.record("juno")).toMatchObject({ maker: { verifiedWaypoints: 3 }, firstEarnedAt: null, lastEarnedAt: null, backfilledAt: f.time() });
    expect(f.record("juno").records[0]!.endedAt).toBeNull();
    const keeper = f.record("wren");
    expect(keeper.keeper?.returnedQuests).toBe(2); expect(keeper.firstEarnedAt).toBeNull(); expect(keeper.lastEarnedAt).toBeNull();
    expect(keeper.records.map(row => row.endedAt)).toEqual([f.time() + 100, null]);
  });
  it("keeps an undone legacy verdict as withdrawn history without counting it", async () => {
    const f = await fixture(), verified = f.review("verify");
    f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind LIKE 'service%'").run();
    f.k.store.db.prepare("INSERT INTO questlog_logs(thread_id) VALUES(?)").run("maker");
    f.k.store.db.prepare("INSERT INTO questlog_history(thread_id,before_data,after_data,action,actor,state) VALUES(?,?,?,?,?,'redo')").run("maker", JSON.stringify([f.entry]), JSON.stringify([verified]), "verify", JSON.stringify({ kind: "agent", threadId: "checker" }));
    f.setEntries([f.entry]); f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "stopped", endedAt: f.time() });
    f.runtime.serviceRecords.backfill();
    expect(f.k.store.all("serviceVerdicts")).toHaveLength(1);
    expect(f.k.store.all("serviceVerdicts")[0]).toMatchObject({ withdrawn: true, verdict: "verified" });
    expect(f.records().find(row => row.characterId === "vex")).toBeUndefined();
  });
  it("does not run service-history reads, writes or backfill on a Keeper tick", async () => {
    const f = await fixture();
    const read = vi.spyOn(f.runtime.serviceRecords, "read"), record = vi.spyOn(f.runtime.serviceRecords, "record"), backfill = vi.spyOn(f.runtime.serviceRecords, "backfill"), review = vi.spyOn(f.runtime.serviceRecords, "reviewed");
    await f.runtime.tick("lead"); f.advance(60_000); await f.runtime.tick("lead");
    for (const method of [read, record, backfill, review]) expect(method).not.toHaveBeenCalled();
  });
  it("does not stop startup reconciliation when old service history cannot be backfilled", async () => {
    const f = await fixture(); vi.spyOn(f.runtime.serviceRecords, "backfill").mockImplementation(() => { throw new Error("Unreadable old journal"); });
    const warning = vi.spyOn(f.bb.log, "warn");
    await expect(f.runtime.reconcile()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Unreadable old journal"));
    expect(f.harness.inspection.sdk.callsTo("threads.get").length).toBeGreaterThan(0);
  });
  it("rolls back quest completion and member wins if its terminal service write fails", async () => {
    const f = await fixture(); f.review("verify"); const quest = f.k.quest(f.q.id), member = f.k.member("maker");
    vi.spyOn(f.runtime.serviceRecords, "record").mockImplementation(() => { throw new Error("Service write failed"); });
    await expect(f.runtime.wrap("lead", f.q.id, "Proved", "")).rejects.toThrow("Service write failed");
    expect(f.k.quest(f.q.id)).toEqual(quest); expect(f.k.member("maker")).toEqual(member); expect(f.records()).toEqual([]);
  });
  it("keeps its captured names and earned counts when the source quest is later renamed or missing", async () => {
    const f = await fixture(); f.review("verify"); await f.runtime.wrap("lead", f.q.id, "Proved", ""); const before = f.records();
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), title: "Renamed", short: "new" });
    expect(f.records()).toEqual(before);
    f.k.store.remove("quests", f.q.id);
    expect(f.records()).toEqual(before.map(character => ({ ...character, records: character.records.map(record => ({ ...record, available: false, keeperThreadId: null, threadIds: [] })) })));
  });
});
