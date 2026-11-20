// @vitest-environment node
import { fixtureActivity, patchThreadFixture, runtimeFixture } from "./member-fixture";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { seedQuest, planInput, waypointEntry, putQuestFixture } from "./support";
import { placementRecord } from "./placement-fixture";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import { readStatus, statusInput } from "../../src/server/status";
import { TavernRuntime } from "../../src/server/runtime";
import { rpcHandlers } from "../../src/server/rpc";
import { AUTHORITY } from "../../src/server/authority";
import { migrateMemberEngagement } from "../../src/server/member-engagement-migration";
import { patchMemberDetails } from "../../src/server/member-engagement";

async function fixture(classId = "ranger") {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "A", "A");
  const m = f.k.bind("resting", classId, "fern", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Find the source", brief: { outcome: "Find the source", mode: "make-it-work", outOfScope: "", doneWhen: "Evidence", context: [], questions: [], timeboxMinutes: null } });
  fixtureActivity(f.k, m.threadId, "done");
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, activeBackgroundAgentCount: 0 }));
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  return { ...f, q, m: f.k.member(m.threadId)! };
}
const reminders = (f: Awaited<ReturnType<typeof fixture>>) => f.k.store.unreadEvents("lead", 0, 100).filter(e => e.type === "member.rest-reminder");
it("reminds once per member per rest at the configured threshold, without stopping or releasing", async () => {
  const f = await fixture();
  expect(DEFAULT_SETTINGS.keepers.restMinutes).toBe(30);
  f.advance(29 * 60_000);
  f.runtime.remindResting("lead");
  expect(reminders(f)).toHaveLength(0);
  f.advance(60_000);
  f.runtime.remindResting("lead");
  f.runtime.remindResting("lead");
  expect(reminders(f)).toHaveLength(1);
  expect(reminders(f)[0]?.text).toContain("resting 30 min");
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
  expect(runtimeFixture(f.k.store, f.m.threadId).released).toBeUndefined();
  await f.runtime.tell("lead", f.m.threadId, "Check the follow-up");
  f.k.report(f.m.threadId, { status: "done", outcome: "Follow-up checked", evidence: [], artifacts: [], confidence: null, voice: null });
  f.advance(30 * 60_000);
  f.runtime.remindResting("lead");
  expect(reminders(f)).toHaveLength(2);
});
it("delivers a once-only reminder to an idle Keeper through the real tick loop", async () => {
  const f = await fixture();
  f.k.store.patch("lead", { cursor: f.k.store.eventSequence("lead"), userAt: null, reanchor: null });
  f.advance(31 * 60_000);
  await f.runtime.tick("lead");
  const sends = () => f.harness.inspection.sdk.callsTo("threads.send");
  expect(sends()).toHaveLength(1);
  const text = (sends()[0]!.args[0] as { input: { text: string }[] }).input[0]!.text;
  expect(text).toContain("resting 31 min; work settled");
  expect(text).toContain("Release or keep this member.");
  await f.runtime.tick("lead", "wake");
  expect(sends()).toHaveLength(1);
  expect(reminders(f)).toHaveLength(1);
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
});
it("puts a resting, settled member and its held machine in the ledger and status", async () => {
  const f = await fixture();
  f.runtime.placements().store.reserve(placementRecord({ memberThreadId: f.m.threadId, keeperThreadId: "lead", questId: f.q.id }), { maxMakers: 2, maxCheckers: 2 });
  f.advance(40 * 60_000);
  expect(f.k.restatement("lead")).toContain("resting 40 min; machine held");
  expect(JSON.stringify(readStatus(f.runtime, "lead", statusInput.parse({})))).toContain('"machineHeld":true');
  expect(f.runtime.restNote(f.m)).not.toContain("Releases at");
  expect((await rpcHandlers(f.runtime).room({}, {} as never)).keepers[0]).toHaveProperty("freeHands", 1);
});
it("uses upgrade time rather than an old report as the rest start and persists it across restart", async () => {
  const f = await fixture();
  f.k.store.db.prepare("UPDATE tavern_records SET data=json_set(json_remove(data,'$.engagement'),'$.state','done') WHERE kind='members' AND id=?").run(f.m.threadId);
  f.k.store.db.prepare("UPDATE tavern_runtime SET data=json_remove(data,'$.memberEngagement') WHERE thread_id=?").run(f.m.threadId);
  f.advance(3 * 60 * 60_000);
  migrateMemberEngagement(f.k.store, f.time());
  const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
  restarted.remindResting("lead");
  expect(reminders(f)).toHaveLength(0);
  expect(runtimeFixture(f.k.store, f.m.threadId).restSince).toBe(f.time());
  f.advance(30 * 60_000);
  new TavernRuntime(f.bb, f.k, f.runtime.registry).remindResting("lead");
  expect(reminders(f)).toHaveLength(1);
  new TavernRuntime(f.bb, f.k, f.runtime.registry).remindResting("lead");
  expect(reminders(f)).toHaveLength(1);
});
it.each(["none", "keeper"] as const)("counts resting work as settled with the planned %s check", async check => {
  const f = await fixture();
  const base = planInput(f.q.id);
  f.k.plan("lead", { ...base, waypoints: [{ ...base.waypoints[0]!, check }] });
  f.port.linkedEntries = () => [waypointEntry(f.m.threadId, f.q.id)];
  if (check === "keeper") {
    expect(f.k.restatement("lead")).not.toContain("Resting, settled");
    f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w1", as: "accepted", reason: "Read the source" });
  }
  expect(f.k.restatement("lead")).toContain("Resting, settled");
  f.advance(60 * 60_000);
  f.runtime.remindResting("lead");
  expect(reminders(f)).toHaveLength(1);
});
it("does not remind about unchecked Smith work", async () => {
  const f = await fixture("smith");
  f.port.linkedEntries = () => [waypointEntry(f.m.threadId, f.q.id)];
  f.advance(60 * 60_000);
  f.runtime.remindResting("lead");
  expect(reminders(f)).toHaveLength(0);
});
it.each(["verified", "rejected"] as const)("does not automatically release a Warden after a %s verdict", async status => {
  const f = await fixture("warden");
  const entry = waypointEntry("maker", f.q.id);
  entry.status = status;
  entry.review = { actor: { kind: "agent", threadId: f.m.threadId }, at: f.time(), evidence: [], reason: null, previousNote: null, memberEvidenceAt: null };
  f.port.linkedEntries = () => [entry];
  f.advance(60 * 60_000);
  f.runtime.remindResting("lead");
  expect(reminders(f)).toHaveLength(status === "verified" ? 1 : 0);
  expect(runtimeFixture(f.k.store, f.m.threadId).released).toBeUndefined();
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
});
it("a keep suppresses the first reminder until its deadline, without a release or repeated reminder", async () => {
  const f = await fixture();
  const until = f.time() + 60 * 60_000;
  f.runtime.keep("lead", f.m.threadId, until, "Follow-up");
  f.advance(30 * 60_000);
  f.runtime.remindResting("lead");
  expect(reminders(f)).toHaveLength(0);
  expect(f.runtime.restNote(f.m)).toContain("kept until");
  expect(f.runtime.restNote(f.m)).not.toContain("T");
  f.advance(30 * 60_000);
  f.runtime.remindResting("lead");
  f.runtime.remindResting("lead");
  expect(reminders(f)).toHaveLength(1);
  expect(runtimeFixture(f.k.store, f.m.threadId).released).toBeUndefined();
});
it.each(["done", "held", "stopped"] as const)("refuses a keep on a %s quest", async phase => {
  const f = await fixture();
  putQuestFixture(f.k.store, f.q.id, { ...f.q, phase, ...(phase === "held" ? { held: { since: f.time(), from: "scout" } } : { endedAt: f.time() }) } as never);
  expect(() => f.runtime.keep("lead", f.m.threadId, f.time() + 60_000, "Wait")).toThrow();
});
it("caps a keep at 24 hours and records Keeper authority", async () => {
  const f = await fixture();
  expect(() => f.runtime.keep("lead", f.m.threadId, f.time() + 24 * 60 * 60_000 + 1, "Wait")).toThrow(/24 hours/);
  f.runtime.keep("lead", f.m.threadId, f.time() + 24 * 60 * 60_000, "Wait");
  expect(AUTHORITY).toHaveProperty("keepMember.level", "keeper");
});
it("ends a keep when the quest ends", async () => {
  const f = await fixture();
  f.runtime.keep("lead", f.m.threadId, f.time() + 60 * 60_000, "Follow-up");
  f.k.recordStop(f.q.id);
  expect(runtimeFixture(f.k.store, f.m.threadId).kept).toBeNull();
  expect(f.runtime.restNote(f.m)).toBeNull();
});
it("refuses manual release on a held quest before sending stop", async () => {
  const f = await fixture();
  putQuestFixture(f.k.store, f.q.id, { ...f.q, phase: "held", held: { since: f.time(), from: "scout" } } as never);
  await expect(f.runtime.release("lead", f.m.threadId, "Release")).rejects.toThrow(/held/);
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
});
it.each(["manual", "cleanup"] as const)("records a placed manual release racing cleanup only once when %s starts first", async firstPath => {
  const f = await fixture();
  patchThreadFixture(f.k.store, f.m.threadId, { releasePending: "cleanup" });
  const receipt = f.k.decide("lead", { text: "Release the resting member", why: "Cleanup", boardQuestId: f.q.id, reversible: true, source: "keeper" });
  const operation = f.k.store.runtime(f.m.threadId).memberEngagement!.operation!;
  patchMemberDetails(f.k.store, f.m.threadId, { operation: { ...operation, receipt: { kind: "decision", id: receipt.id } } });
  const placements = f.runtime.placements().store;
  placements.reserve(placementRecord({ memberThreadId: f.m.threadId, keeperThreadId: "lead", questId: f.q.id }), { maxMakers: 2, maxCheckers: 2 });
  vi.spyOn(f.runtime.placements(), "host", "get").mockReturnValue({ call: vi.fn(), onWorkerExit: () => () => {} });
  const preserve = vi.spyOn(f.runtime.placements().preserve, "beforeRelease").mockImplementation(async () => {
    const record = placements.byMember(f.m.threadId)!;
    const cancelled = placements.cancel(record.id, record.generation);
    placements.update(cancelled.id, cancelled.generation, row => ({ ...row, phase: "releasing",
      preservation: { ...row.preservation, source: "not-needed", liveOwnerThreadId: null, stopConfirmed: true } }), "released");
    placements.finishRelease(cancelled.id, cancelled.generation, true);
    return { state: "released" };
  });
  let resolve!: () => void;
  const wait = new Promise<void>(done => { resolve = done; });
  let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  let first = true;
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => {
    if (first) { first = false; entered(); await wait; }
    return makeThreadResponse({ id: threadId, activeBackgroundAgentCount: 0 });
  });
  const manual = () => f.runtime.release("lead", f.m.threadId, "manual");
  const cleanup = () => f.runtime["finishMemberCleanup"]("lead");
  const firstWork = firstPath === "manual" ? manual() : cleanup();
  await started;
  const secondWork = firstPath === "manual" ? cleanup() : manual();
  resolve();
  await Promise.all([firstWork, secondWork]);
  expect(preserve).toHaveBeenCalledOnce();
  expect(f.k.store.unreadEvents("lead", 0, 100).filter(e => e.type === "member.released")).toHaveLength(1);
  expect(f.k.store.all("decisions").filter(d => d.text.startsWith("Release"))).toHaveLength(1);
});
