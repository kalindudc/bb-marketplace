// @vitest-environment node
import { seedQuest } from "./support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rpcHandlers, registerRpc } from "../../src/server/rpc";
import type { BoardQuestDetail } from "../../src/shared/contract";
import type { ServiceQuestRecord } from "../../src/shared/service-record";
import { setup } from "./runtime-fixture";
import { planInput, waypointEntry } from "./support";
import { makePluginAgentConfigurationContext } from "./host";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
type Credit = ServiceQuestRecord["credits"][number];
function credit(role: Credit["role"], count: number, characterId = role === "maker" ? "juno" : role === "warden" ? "vex" : "wren"): Credit {
  return { characterId, role, verifiedWaypoints: role === "warden" ? 0 : count, checks: role === "warden" ? count : 0, independentChecks: role === "warden" ? count : 0, sameFamilyChecks: 0, caught: 0, threadIds: [] };
}
function history(f: Awaited<ReturnType<typeof fixture>>, credits: Credit[], id = "prior", endedAt: number | null = f.time() - 100) {
  const record: ServiceQuestRecord = { version: 1, questId: id, title: id, short: id, phase: "done", endedAt, keeperThreadId: null, backfilledAt: null, completeSince: null, credits };
  f.k.store.put("serviceRecords", id, record);
}
async function fixture() {
  const f = setup(); databases.push(f.k.store.db); registerRpc(f.bb, f.runtime);
  const q = await seedQuest(f.k,"lead", "A kept tale", "Proven work"); f.k.plan("lead", planInput(q.id));
  const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Publish", doneWhen: "Proof", context: [], questions: [], timeboxMinutes: null };
  for (const [threadId, classId, characterId] of [["maker", "smith", "juno"], ["checker", "warden", "vex"]]) f.k.bind(threadId!, classId!, characterId!, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Work", errand: false, brief });
  f.k.store.put("members", "checker", { ...f.k.member("checker")!, checkIndependence: "independent" });
  const before = waypointEntry("maker", q.id);
  const after = { ...before, status: "verified" as const, review: { actor: { kind: "agent" as const, threadId: "checker" }, at: f.time(), evidence: before.evidence, reason: null, previousNote: null, memberEvidenceAt: null } };
  f.port.linkedEntries = () => [after]; f.runtime.serviceRecords.reviewed({ before, after, sequence: 1 });
  const call = (method: string, input: unknown) => f.harness.invokeRpc(method, input);
  const detail = async () => await call("boardQuest", { id: q.id }) as BoardQuestDetail;
  const keep = (kept: boolean, characterId = "juno") => call("setTaleKept", { questId: q.id, characterId, kept });
  const wrap = () => f.runtime.wrap("lead", q.id, "The proof is kept.", "");
  const record = (id = "juno") => f.runtime.serviceRecords.read().find(row => row.characterId === id)!;
  return { ...f, q, call, detail, keep, wrap, record };
}

describe("terminal tale level snapshots", () => {
  it.each(["maker", "warden", "keeper"] as const)("captures the 7 to 8 and 8 to 9 boundary for %s", async role => {
    const f = await fixture();
    if (role === "keeper") for (let n = 0; n < 7; n++) history(f, [credit(role, 1)], `prior-${n}`);
    else history(f, [credit(role, 7)]);
    await f.wrap();
    const snapshot = f.k.store.get("serviceRecords", f.q.id)!;
    expect(snapshot.credits.find(c => c.role === role)!.level).toEqual({ before: 1, after: 2, historyComplete: true });
    const before = structuredClone(snapshot);
    await f.detail(); await f.detail(); await f.wrap();
    expect(f.k.store.get("serviceRecords", f.q.id)).toEqual(before);
    const second = await fixture();
    if (role === "keeper") for (let n = 0; n < 8; n++) history(second, [credit(role, 1)], `prior-${n}`);
    else history(second, [credit(role, 8)]);
    await second.wrap();
    expect(second.k.store.get("serviceRecords", second.q.id)!.credits.find(c => c.role === role)!.level).toEqual({ before: 2, after: 2, historyComplete: true });
  });
  it("exposes flat tale levels, keeps zero earned as null, and never invents legacy crossings", async () => {
    const f = await fixture(); await f.wrap();
    expect((await f.detail()).tale?.levels).toEqual(expect.arrayContaining([{ characterId: "juno", role: "maker", before: null, after: 1, historyComplete: true }]));
    const stored = f.k.store.get("serviceRecords", f.q.id)!;
    f.k.store.put("serviceRecords", f.q.id, { ...stored, credits: stored.credits.map(({ level: _level, ...rest }) => rest) });
    expect((await f.detail()).tale?.levels).toBeNull();
    f.runtime.serviceRecords.backfill(); expect((await f.detail()).tale?.levels).toBeNull();
  });
  it("captures a first quest that earns a notch without inventing a prior level", async () => {
    const f = await fixture(), plan = planInput(f.q.id), first = waypointEntry("maker", f.q.id);
    f.k.plan("lead", { ...plan, waypoints: Array.from({ length: 8 }, (_, index) => ({ ...plan.waypoints[0]!, id: `w${index + 1}` })) });
    f.port.linkedEntries = () => Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(first), id: `entry-${index}`, link: { boardQuestId: f.q.id, waypointId: `w${index + 1}` }, status: "verified", review: { actor: { kind: "agent", threadId: "checker" }, at: f.time(), evidence: first.evidence, reason: null, previousNote: null, memberEvidenceAt: null } }));
    await f.wrap();
    expect((await f.detail()).tale?.levels).toEqual(expect.arrayContaining([{ characterId: "juno", role: "maker", before: null, after: 2, historyComplete: true }]));
  });
  it("marks a crossing as incomplete only for the role with incomplete contributing history", async () => {
    const f = await fixture();
    history(f, [credit("maker", 7)], "old-maker");
    history(f, [credit("keeper", 7, "juno")], "partial-keeper");
    const partial = f.k.store.get("serviceRecords", "partial-keeper")!;
    f.k.store.put("serviceRecords", "partial-keeper", { ...partial, completeSince: 50, backfilledAt: 100 });
    await f.wrap();
    expect(f.record().maker!.completeSince).toBeNull();
    expect(f.record().keeper!.completeSince).toBe(50);
    expect((await f.detail()).tale?.levels).toEqual(expect.arrayContaining([expect.objectContaining({ characterId: "juno", role: "maker", before: 1, after: 2, historyComplete: true })]));
    const other = await fixture();
    history(other, [credit("maker", 7)], "partial-maker");
    const old = other.k.store.get("serviceRecords", "partial-maker")!;
    other.k.store.put("serviceRecords", "partial-maker", { ...old, completeSince: 50, backfilledAt: 100 });
    await other.wrap();
    expect((await other.detail()).tale?.levels).toEqual(expect.arrayContaining([
      expect.objectContaining({ characterId: "juno", role: "maker", before: 1, after: 2, historyComplete: false }),
      expect.objectContaining({ characterId: "vex", role: "warden", historyComplete: true }),
    ]));
  });
  it.each([["maker", false], ["warden", false], ["maker", true], ["warden", true]] as const)("keeps %s confidence incomplete with no surviving credit (quest deleted: %s)", async (role, deletedQuest) => {
    const f = await fixture(), plan = planInput(f.q.id), first = waypointEntry("maker", f.q.id);
    const legacyId = `legacy-${role}`, oldThread = `old-${role}`, characterId = role === "warden" ? "vex" : "juno";
    f.k.store.put("quests", legacyId, { ...f.k.quest(f.q.id), id: legacyId, phase: "done", createdAt: f.time() - 500, endedAt: f.time() - 100, archivedAt: f.time() - 50 });
    f.k.bind(oldThread, role === "warden" ? "warden" : "smith", characterId, "project", { keeperThreadId: "lead", boardQuestId: legacyId, waypointId: "w1", title: "Legacy work", errand: false, brief: { outcome: "Legacy work", mode: "make-it-work", outOfScope: "Publish", doneWhen: "Proof", context: [], questions: [], timeboxMinutes: null } });
    f.k.store.patch(oldThread, { archivedAt: f.time(), deletedAt: f.time() });
    if (deletedQuest) f.k.store.remove("quests", legacyId);
    expect(f.k.store.get("serviceRecords", legacyId)).toBeNull();
    f.k.plan("lead", { ...plan, waypoints: Array.from({ length: 8 }, (_, index) => ({ ...plan.waypoints[0]!, id: `w${index + 1}` })) });
    f.port.linkedEntries = () => Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(first), id: `entry-${index}`, link: { boardQuestId: f.q.id, waypointId: `w${index + 1}` }, status: "verified", review: { actor: { kind: "agent", threadId: "checker" }, at: f.time(), evidence: first.evidence, reason: null, previousNote: null, memberEvidenceAt: null } }));
    await f.wrap();
    expect((await f.detail()).tale?.levels?.find(row => row.characterId === characterId && row.role === role)).toMatchObject({ before: null, after: 2, historyComplete: false });
  });
  it("never upgrades legacy or frozen incomplete confidence when later read totals are complete", async () => {
    const f = await fixture(); history(f, [credit("maker", 7)]);
    const past = f.k.store.get("serviceRecords", "prior")!;
    f.k.store.put("serviceRecords", "prior", { ...past, completeSince: 50 });
    await f.wrap();
    f.k.store.put("serviceRecords", "prior", past);
    expect(f.record().maker!.completeSince).toBeNull();
    expect((await f.detail()).tale?.levels?.find(row => row.role === "maker")).toMatchObject({ before: 1, after: 2, historyComplete: false });
    const stored = f.k.store.get("serviceRecords", f.q.id)!;
    f.k.store.put("serviceRecords", f.q.id, { ...stored, credits: stored.credits.map(credit => credit.level ? { ...credit, level: { before: credit.level.before, after: credit.level.after } } : credit) });
    expect((await f.detail()).tale?.levels?.find(row => row.role === "maker")?.historyComplete).toBe(false);
  });
  it("keeps each captured credit when another credit has no historical snapshot", async () => {
    const f = await fixture(); await f.wrap();
    const stored = f.k.store.get("serviceRecords", f.q.id)!;
    f.k.store.put("serviceRecords", f.q.id, { ...stored, credits: stored.credits.map(({ level, ...credit }) => credit.role === "maker" ? credit : { ...credit, level }) });
    expect((await f.detail()).tale?.levels?.map(row => row.role).sort()).toEqual(["keeper", "warden"]);
  });
  it("does not capture a historical level change during backfill", async () => {
    const f = await fixture(); await f.wrap();
    f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind IN ('serviceRecords','serviceRecordState')").run();
    history(f, [credit("maker", 7)]); f.runtime.serviceRecords.backfill();
    expect(f.k.store.get("serviceRecords", f.q.id)!.credits.find(c => c.role === "maker")!.level ?? null).toBeNull();
  });
});

describe("kept tales", () => {
  it("sets and clears a per-character preference without changing work, counts or terminal proof", async () => {
    const f = await fixture(); await f.wrap();
    const before = { snapshot: f.runtime.snapshot(), instructions: f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "lead" } })).instructions, proof: f.k.store.get("serviceRecords", f.q.id), events: f.k.store.events("lead", 0, 1000), reports: f.k.store.all("reports") };
    const invalidate = vi.spyOn(f.bb.rpc, "experimental_invalidate"); invalidate.mockClear();
    expect(await f.keep(true)).toEqual({ kept: true });
    expect(invalidate).toHaveBeenCalledWith(["tavern:registry", `tavern:quest:${f.q.id}`]);
    expect(f.record().records.find(row => row.questId === f.q.id)).toMatchObject({ kept: true, told: true, available: true, waypoints: { verified: 1, total: 1 } });
    expect(f.record("vex").records.find(row => row.questId === f.q.id)).toMatchObject({ independentChecks: 1, sameFamilyChecks: 0, kept: false });
    expect((await f.detail()).tale?.keptCharacterIds).toEqual(["juno"]);
    const put = vi.spyOn(f.k.store, "put"); invalidate.mockClear(); await f.keep(true);
    expect(put.mock.calls.filter(([kind]) => kind === "taleKeeps")).toEqual([]); expect(invalidate).not.toHaveBeenCalled();
    expect(await f.keep(false)).toEqual({ kept: false }); expect(f.k.store.all("taleKeeps")).toEqual([]);
    expect({ snapshot: f.runtime.snapshot(), instructions: f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "lead" } })).instructions, proof: f.k.store.get("serviceRecords", f.q.id), events: f.k.store.events("lead", 0, 1000), reports: f.k.store.all("reports") }).toEqual(before);
  });
  it("refuses plugin and missing callers before mutation, while documenting the SDK client identity limit", async () => {
    const f = await fixture(); await f.wrap(); const handler = rpcHandlers(f.runtime).setTaleKept;
    for (const context of [undefined, { experimental_caller: { kind: "plugin", pluginId: "other" }, experimental_signal: new AbortController().signal }])
      expect(() => Reflect.apply(handler, undefined, [{ questId: f.q.id, characterId: "juno", kept: true }, context])).toThrow(/client/i);
    expect(f.k.store.all("taleKeeps")).toEqual([]);
    expect(await f.keep(true)).toEqual({ kept: true });
  });
  it("refuses live, stopped, untold and uncredited targets", async () => {
    const f = await fixture(); await expect(f.keep(true)).rejects.toThrow();
    await f.wrap(); await expect(f.keep(true, "someone-else")).rejects.toThrow();
    f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "stopped" }); await expect(f.keep(true)).rejects.toThrow();
    const untold = await fixture();
    untold.k.store.put("quests", untold.q.id, { ...untold.k.quest(untold.q.id), phase: "done", endedAt: untold.time() });
    untold.k.store.atomic(() => untold.runtime.serviceRecords.record(untold.q.id));
    await expect(untold.keep(true)).rejects.toThrow();
  });
  it("retains kept rows past the recent-history cap and survives cellar and deletion harmlessly", async () => {
    const f = await fixture(); await f.wrap(); await f.keep(true);
    for (let n = 0; n < 25; n++) history(f, [credit("maker", 1)], `new-${n}`, f.time() + n + 1);
    expect(f.record().records).toHaveLength(21);
    expect(f.record().records.find(row => row.questId === f.q.id)?.kept).toBe(true);
    f.k.archiveQuests([f.q.id], true); expect((await f.detail()).tale).not.toBeNull();
    f.k.store.remove("quests", f.q.id);
    expect(f.record().records.find(row => row.questId === f.q.id)).toMatchObject({ kept: true, available: false });
    await expect(f.keep(true)).rejects.toThrow(); expect(await f.keep(false)).toEqual({ kept: false });
    expect(f.record().maker!.verifiedWaypoints).toBe(26); expect(f.record().records).toHaveLength(20);
  });
  it("keeps legacy tales independently of missing level snapshots and never lists stopped work as told", async () => {
    const f = await fixture(); await f.wrap();
    const stored = f.k.store.get("serviceRecords", f.q.id)!;
    f.k.store.put("serviceRecords", f.q.id, { ...stored, credits: stored.credits.map(({ level: _level, ...rest }) => rest) });
    await f.keep(true); expect((await f.detail()).tale).toMatchObject({ levels: null, keptCharacterIds: ["juno"] });
    f.k.store.put("serviceRecords", f.q.id, { ...stored, phase: "stopped" });
    expect(f.record().records.find(row => row.questId === f.q.id)?.told).toBe(false);
  });
  it("keeps per-role dates exact beyond the cap and nulls only the role with an undated record", async () => {
    const f = await fixture(); await f.wrap();
    history(f, [credit("maker", 1)], "old-maker", 10); history(f, [credit("warden", 1, "juno")], "old-checker", 20);
    history(f, [credit("keeper", 1, "juno")], "undated-keeper", null);
    for (let n = 0; n < 25; n++) history(f, [credit("maker", 1)], `new-${n}`, f.time() + n + 1);
    expect(f.record()).toMatchObject({ firstEarnedAt: null, maker: { firstEarnedAt: 10 }, warden: { firstEarnedAt: 20 }, keeper: { firstEarnedAt: null } });
    expect(f.record().records.some(row => row.questId === "old-maker")).toBe(false);
  });
});
