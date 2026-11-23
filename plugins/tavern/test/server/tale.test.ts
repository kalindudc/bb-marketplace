// @vitest-environment node
import { fixtureActivity, patchThreadFixture } from "./member-fixture";
import { concludeQuest, putQuestFixture } from "./support";
import { seedQuest } from "./support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardQuestDetail, Room, ThreadDecor } from "../../src/shared/contract";
import { reportSchema } from "../../src/shared/schema";
import { registerRpc } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";
import { makeThreadResponse } from "./host";
import { planInput, waypointEntry } from "./support";
import { setup } from "./runtime-fixture";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function fixture() {
  const f = setup(); databases.push(f.k.store.db); registerRpc(f.bb, f.runtime);
  const q = await seedQuest(f.k,"lead", "README smoke", "README smoke");
  f.k.plan("lead", { ...planInput(q.id), waypoints: [
    ...planInput(q.id).waypoints,
    { ...planInput(q.id).waypoints[0]!, id: "w2", title: "Optional follow-up", optional: true },
  ] });
  const bind = (id: string, classId: string) => f.k.bind(id, classId, classId === "warden" ? "vex" : "lark", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Check README", brief: { outcome: "Check README", mode: "make-it-work", outOfScope: "Publishing", doneWhen: "Checks pass", context: [], questions: [], timeboxMinutes: null } });
  const call = <T = unknown>(name: string, input: unknown) => f.harness.invokeRpc(name, input) as Promise<T>;
  const detail = () => call<BoardQuestDetail>("boardQuest", { id: q.id });
  const report = (extra: Record<string, unknown> = {}) => ({ status: "done" as const, outcome: "Tests pass.", evidence: [], artifacts: [], confidence: null, voice: null, ...extra });
  return { ...f, q, bind, call, detail, report };
}

describe("quest tale and credits", () => {
  it("returns null for an unwrapped sparse quest and empty credit rows", async () => {
    const f = await fixture();
    expect(await f.detail()).toMatchObject({ tale: null, memberCredits: [] });
  });

  it("reads the latest wrap beyond the generic Keeper event page and restores legacy skip receipts", async () => {
    const f = await fixture();
    f.k.store.event(f.time(), "lead", f.q.id, "waypoint.skipped", "Old plan", { waypointId: "w1", version: 0, reason: "Wrong version" });
    f.k.store.event(f.time(), "lead", f.q.id, "waypoint.skipped", "Skipped", { waypointId: "w2", version: 1, reason: "Not needed" });
    f.k.store.event(f.time(), "lead", f.q.id, "quest.wrapped", "Old tale", { outcome: "Old tale", left: "Old work" });
    for (let i = 0; i < 550; i++) f.k.store.event(f.time(), "lead", f.q.id, "journal.changed", "Noise");
    f.advance(1000);
    f.k.store.event(f.time(), "lead", f.q.id, "quest.wrapped", "The README is corrected.", { outcome: "The README is corrected.", left: "" });
    f.k.store.event(f.time(), "lead", f.q.id, "waypoint.skipped", "After wrap", { waypointId: "w1", version: 1, reason: "Not part of the tale" });
    expect((await f.detail()).tale).toEqual({ outcome: "The README is corrected.", left: null, skipped: [{ waypointId: "w2", reason: "Not needed" }], wrappedAt: f.time(), levels: null, keptCharacterIds: [] });
  });

  it("uses the wrap's explicit skip snapshot and tolerates a missing legacy left field", async () => {
    const f = await fixture();
    f.k.store.event(f.time(), "lead", f.q.id, "waypoint.skipped", "Old receipt", { waypointId: "w2", version: 1, reason: "Superseded" });
    f.k.store.event(f.time(), "lead", f.q.id, "quest.wrapped", "Done", { outcome: "Done", skipped: [] });
    expect((await f.detail()).tale).toEqual({ outcome: "Done", left: null, skipped: [], wrappedAt: f.time(), levels: null, keptCharacterIds: [] });
  });

  it("uses the quest/type index for the latest tale rather than scanning unrelated events", async () => {
    const f = await fixture();
    const plan = f.k.store.db.prepare("EXPLAIN QUERY PLAN SELECT id,at,data FROM tavern_events WHERE board_quest_id=? AND type='quest.wrapped' ORDER BY id DESC LIMIT 1").all(f.q.id) as { detail: string }[];
    expect(plan.map(step => step.detail)).toEqual(expect.arrayContaining([expect.stringContaining("tavern_events_quest_type")]));
  });

  it("snapshots skipped reasons in a new wrap and retains the story after cellar", async () => {
    const f = await fixture();
    f.k.plan("lead", { ...planInput(f.q.id), waypoints: [{ ...planInput(f.q.id).waypoints[0]!, optional: true }] });
    await concludeQuest(f.runtime, "lead", f.q.id, "The smoke check is complete.", "Nothing", [{ waypointId: "w1", reason: "No implementation was needed" }]);
    const wrapped = f.k.store.events("lead", 0, 200).find(e => e.type === "quest.wrapped")!;
    expect(wrapped.data.skipped).toEqual([{ waypointId: "w1", reason: "No implementation was needed" }]);
    await f.call("archiveBoardQuests", { ids: [f.q.id], archived: true });
    expect((await f.detail()).tale).toEqual({ outcome: "The smoke check is complete.", closure: "concluded", left: "Nothing", skipped: wrapped.data.skipped, wrappedAt: f.time(), levels: [{ characterId: "wren", role: "keeper", before: null, after: null, historyComplete: true }], keptCharacterIds: [] });
  });

  it("credits completed linked work and actual review actors, not symbolic owners or later note authors", async () => {
    const f = await fixture(); f.bind("maker", "smith"); f.bind("checker", "warden"); f.bind("scout", "ranger");
    const first = waypointEntry("maker", f.q.id);
    const verified = { ...first, status: "verified" as const, review: { actor: { kind: "agent" as const, threadId: "checker" }, at: f.time(), evidence: first.evidence, reason: null, previousNote: null, memberEvidenceAt: null }, updatedBy: { kind: "agent" as const, threadId: "scout" } };
    f.port.linkedEntries = () => [verified, { ...verified, id: "a2" }, { ...first, id: "a3", link: { boardQuestId: f.q.id, waypointId: "w2" }, status: "doing" }];
    const detail = await f.detail();
    expect(detail.quest.waypoints[0]!.ownerMember).toBeNull();
    expect(detail.memberCredits).toEqual(expect.arrayContaining([
      { memberThreadId: "maker", madeWaypointIds: ["w1"], verifiedWaypointIds: [] },
      { memberThreadId: "checker", madeWaypointIds: [], verifiedWaypointIds: ["w1"] },
      { memberThreadId: "scout", madeWaypointIds: [], verifiedWaypointIds: [] },
    ]));
  });

  it("does not inflate reviewer credit for a partially verified waypoint or released unfinished work", async () => {
    const f = await fixture(); f.bind("maker", "smith"); f.bind("checker", "warden");
    const entry = waypointEntry("maker", f.q.id);
    f.port.linkedEntries = () => [{ ...entry, status: "verified", updatedBy: { kind: "agent", threadId: "checker" } }, { ...entry, id: "a2", status: "doing" }];
    expect((await f.detail()).memberCredits!.find(c => c.memberThreadId === "checker")!.verifiedWaypointIds).toEqual([]);
    expect((await f.detail()).memberCredits!.find(c => c.memberThreadId === "maker")!.madeWaypointIds).toEqual([]);
    patchThreadFixture(f.k.store, "maker", { released: { reason: "Replaced", decisionId: "release" } });
    f.port.linkedEntries = () => [entry];
    expect((await f.detail()).memberCredits!.find(c => c.memberThreadId === "maker")!.madeWaypointIds).toEqual([]);
    f.port.linkedEntries = () => [{ ...entry, status: "verified", updatedBy: { kind: "agent", threadId: "checker" } }];
    expect((await f.detail()).memberCredits!.find(c => c.memberThreadId === "maker")!.madeWaypointIds).toEqual(["w1"]);
  });

  it("does not treat a later Ranger note as a legacy verification receipt", async () => {
    const f = await fixture(); f.bind("maker", "smith"); f.bind("scout", "ranger");
    const entry = waypointEntry("maker", f.q.id);
    f.port.linkedEntries = () => [{ ...entry, status: "verified", updatedBy: { kind: "agent", threadId: "scout" } }];
    const detail = await f.detail();
    expect(detail.quest.waypoints[0]!.verifiedBy).toBeNull();
    expect(detail.memberCredits!.find(c => c.memberThreadId === "scout")!.verifiedWaypointIds).toEqual([]);
  });

  it("leaves unknown legacy actors uncredited rather than assigning their work to a named member", async () => {
    const f = await fixture(); f.bind("maker", "smith");
    const entry = waypointEntry("forgotten-thread", f.q.id);
    f.port.linkedEntries = () => [{ ...entry, status: "verified", updatedBy: { kind: "agent", threadId: "forgotten-checker" } }];
    expect((await f.detail()).memberCredits).toEqual([
      { memberThreadId: "maker", madeWaypointIds: [], verifiedWaypointIds: [] },
    ]);
  });
});

describe("report headline", () => {
  it("keeps old reports sparse and persists a trimmed optional headline through report RPC", async () => {
    const f = await fixture(); f.bind("scout", "ranger");
    const original = f.k.report("scout", f.report());
    expect(original).not.toHaveProperty("headline");
    await f.runtime.acceptRangerReport("lead", original.id);
    await f.runtime.tell("lead", "scout", "Check the README again.");
    const updated = f.k.report("scout", { ...f.report(), headline: "  The README is correct.  " });
    expect(updated.headline).toBe("The README is correct.");
    expect(await f.call("reports", { ids: [updated.id] })).toMatchObject({ reports: [{ headline: "The README is correct." }] });
    expect(f.k.report("scout", { ...f.report(), headline: "The README is correct." }).id).toBe(updated.id);
  });

  it("advertises headline on tavern_report and rejects blank or overlong headlines", async () => {
    const f = await fixture(); f.bind("scout", "ranger"); registerTools(f.bb, f.runtime);
    const tool = f.harness.inspection.registrations.agentTools.find(t => t.name === "tavern_report")!;
    expect((tool as unknown as { parameters: { properties: Record<string, unknown> } }).parameters.properties).toHaveProperty("headline");
    const base = f.k.report("scout", f.report());
    expect(() => reportSchema.parse({ ...base, headline: " " })).toThrow();
    expect(() => reportSchema.parse({ ...base, headline: "x".repeat(161) })).toThrow();
  });

  it("accepts the headline boundary and names the extra room needed for a same-family label", async () => {
    const f = await fixture(); f.bind("scout", "ranger");
    expect(f.k.report("scout", { ...f.report(), headline: "x".repeat(160) }).headline).toHaveLength(160);
    const w = f.bind("checker", "warden");
    f.k.store.put("members", w.threadId, { ...w, checkIndependence: "same-family" });
    expect(() => f.k.report("checker", { ...f.report(), headline: "x".repeat(160) })).toThrow(/same-family label/);
    expect(f.k.store.query("reports", "memberThreadId", "checker")).toEqual([]);
  });

  it("does not let Warden headlines claim independence and retains the same-family limitation", async () => {
    const f = await fixture(); const w = f.bind("checker", "warden");
    f.k.store.put("members", w.threadId, { ...w, checkIndependence: "same-family" });
    expect(() => f.k.report("checker", { ...f.report(), headline: "Independently verified the README." })).toThrow(/headline.*independen/i);
    const report = f.k.report("checker", { ...f.report(), headline: "The README checks pass." });
    expect(report.headline).toContain("same-family check (not independent)");
    expect(report.outcome).toContain("same-family check (not independent)");
  });
});

describe("archived Keepers and current holding state", () => {
  it("expires stale displayed typing holds even without another delivered tick", async () => {
    const f = await fixture();
    f.k.store.patch("lead", { heldAt: f.time(), typingAt: f.time(), userAt: null });
    expect((await f.call<Room>("room", {})).keepers[0]!.status).toBe("holding");
    f.advance((f.runtime.config().knobs.typingHoldSeconds + 1) * 1000);
    expect((await f.call<Room>("room", {})).keepers[0]!.status).toBe("listening");
    expect((await f.call<ThreadDecor>("decor", { threadId: "lead" })).keeperView!.status).toBe("listening");
  });

  it("invalidates cached holding views when the user hold expires without a delivered tick", async () => {
    const f = await fixture();
    f.k.store.patch("lead", { heldAt: f.time(), userAt: f.time() });
    vi.spyOn(f.runtime, "tick").mockResolvedValue();
    vi.mocked(f.bb.rpc.experimental_invalidate).mockClear();
    const userAt = f.time();
    f.advance((f.runtime.config().knobs.afterMessageHoldSeconds + 1) * 1000);
    await f.runtime.sweep();
    expect(f.bb.rpc.experimental_invalidate).toHaveBeenCalledWith(expect.arrayContaining(["tavern:room", "tavern:thread:lead"]));
    expect(f.k.store.runtime("lead")).toMatchObject({ heldAt: null, userAt });
    vi.mocked(f.bb.rpc.experimental_invalidate).mockClear();
    await f.runtime.sweep();
    expect(f.bb.rpc.experimental_invalidate).not.toHaveBeenCalled();
  });

  it("reports busy rather than typing from a historic cooldown/busy hold", async () => {
    const f = await fixture();
    f.k.activity("lead", "working"); f.k.store.patch("lead", { heldAt: f.time() });
    expect((await f.call<Room>("room", {})).keepers[0]!.status).toBe("busy");
  });

  it("keeps archived rows and their uncellared quests but never holds or accepts typing for them", async () => {
    const f = await fixture();
    putQuestFixture(f.k.store, f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
    f.k.store.patch("lead", { heldAt: f.time(), typingAt: f.time(), userAt: f.time() });
    await f.runtime.threadLifecycle("thread.archived", { thread: makeThreadResponse({ id: "lead", archivedAt: f.time() }) });
    const room = await f.call<Room>("room", {});
    expect(room.keepers).toHaveLength(1);
    expect(room.keepers[0]).toMatchObject({ archived: true, status: "listening", boardQuests: [{ id: f.q.id }] });
    expect(f.k.store.runtime("lead")).toMatchObject({ heldAt: null, typingAt: null, userAt: null });
    await f.call("typing", { threadId: "lead" });
    expect(f.runtime.held("lead")).toBe(false);
    expect(f.k.store.runtime("lead").typingAt).toBeNull();
    expect((await f.call<ThreadDecor>("decor", { threadId: "lead" })).keeperView).toMatchObject({ archived: true, status: "listening" });
    await f.runtime.threadLifecycle("thread.unarchived", { thread: makeThreadResponse({ id: "lead", archivedAt: null }) });
    expect((await f.call<Room>("room", {})).keepers[0]!.archived).toBe(false);
  });

  it("reconciles missed archive events, without equating a manual Stop with archive", async () => {
    const f = await fixture(); fixtureActivity(f.k, "lead", "stopped");
    expect((await f.call<Room>("room", {})).keepers[0]!.archived).toBe(false);
    f.k.store.patch("lead", { heldAt: f.time() });
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, archivedAt: f.time() });
    await f.runtime.reconcile();
    expect((await f.call<Room>("room", {})).keepers[0]).toMatchObject({ archived: true, status: "listening" });
    expect(f.k.store.runtime("lead").heldAt).toBeNull();
  });

  it("clears an orphaned tick hold once the idle tick has no packet to send", async () => {
    const f = await fixture();
    f.k.store.patch("lead", { cursor: f.k.store.events("lead", 0, 100).at(-1)?.id ?? 0, heldAt: f.time(), reanchor: null });
    await f.runtime.tick("lead");
    expect(f.k.store.runtime("lead").heldAt).toBeNull();
  });
});
