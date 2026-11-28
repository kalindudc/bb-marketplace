// @vitest-environment node
import { fixtureActivity, patchThreadFixture, runtimeFixture } from "../server/member-fixture";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { reserveStaffing } from "../../src/server/staffing";
import { exportToml } from "../../src/server/settings/toml";
import { settingsHandlers } from "../../src/server/settings/rpc";
import type { SettingsFiles } from "../../src/server/settings/files";
import type { SettingsPatch } from "../../src/shared/settings";
import { setup } from "../server/runtime-fixture";
import { seedLegacyQuest, seedQuest } from "../server/support";
import { dispatch049 } from "../server/dispatch-fixture";
import { makeThreadResponse } from "../server/host";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
const brief = { outcome: "Work", doneWhen: "Evidence", mode: "make-it-work" as const, outOfScope: "Publish", context: [], questions: [], timeboxMinutes: null };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const f = setup(); databases.push(f.k.store.db);
  const settings = new SettingsStore(f.k.store.db, f.time, () => f.runtime.settingsChanged());
  const insights = new InsightsReader(f.k.store.db, settings, f.time);
  f.runtime.enableSettings(settings, insights);
  const save = (patch: SettingsPatch) => settings.update({ revision: settings.snapshot().revision, patch, why: "Change the fixture setting" });
  return { ...f, settings, insights, save };
}
async function party() {
  const f = fixture(), q = await seedQuest(f.k, "lead", "Keep a verifiable fixture result", "Fixture");
  const member = f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Work", brief });
  return { ...f, q, member };
}

it("bounds a loaded restatement using the chosen memory budget and keeps its leading sections", async () => {
  const f = fixture();
  for (let i = 0; i < 16; i++) {
    seedLegacyQuest(f.k, "lead", `Quest ${i} ${"x".repeat(110)}`, `Q${i}`);
    f.k.addRule({ scope: "keeper", scopeId: "lead", source: "user", text: `Rule ${i} ${"detail ".repeat(65)}` }, "lead");
    f.k.addRule({ scope: "keeper", scopeId: "lead", source: "keeper-proposed", text: `Pending ${i} ${"detail ".repeat(65)}` }, "lead");
  }
  for (let i = 0; i < 6; i++) f.k.memory.note("lead", { kind: "fact", text: `Fact ${i} ${"details ".repeat(65)}`, boardQuestId: null });
  const original = f.k.restatement("lead");
  f.save({ keepers: { restatementBytes: 8000 } });
  const limited = f.k.restatement("lead");
  expect(Buffer.byteLength(original)).toBeGreaterThan(8000);
  expect(Buffer.byteLength(limited)).toBeLessThanOrEqual(8000);
  expect(limited).toContain("Standing rules");
  expect(limited).toContain("Proposed, waiting for the user");
  expect(limited).toContain("Next link:");
  expect(limited).toContain("[Truncated");
});

it("clips a large tick fact at the selected cap and preserves its continuation", () => {
  const f = fixture();
  f.k.store.put("reports", "wide-report", { id: "wide-report", memberThreadId: "member", keeperThreadId: "lead", boardQuestId: null, waypointId: null, status: "done", outcome: "x".repeat(4000), artifacts: [], evidence: [], confidence: null, voice: null, createdAt: f.time(), deliveredAt: null });
  const id = f.k.store.event(f.time(), "lead", null, "report.filed", "Report", {reportId:"wide-report"}, { kind: "tavern" });
  const baseline = f.runtime["loop"]["batch"]("lead")!;
  expect(baseline.continuation).toBeNull();
  f.save({ keepers: { tickFactChars: 4000 } });
  const limited = f.runtime["loop"]["batch"]("lead")!;
  expect(limited.continuation).toEqual({ eventId: id, offset: 3800 });
  expect(limited.measurements?.facts.chars).toBeLessThan(4500);
});

it("asks after the chosen number of refusals and uses the configured retry gap", () => {
  const f = fixture();
  f.save({ keepers: { failuresBeforeAsk: 3, retryAfterSeconds: 13 } });
  f.runtime.tickRefused("lead", new Error("offline"));
  expect(f.k.store.runtime("lead").tickRetryAt).toBe(f.time() + 13_000);
  f.runtime.tickRefused("lead", new Error("offline"));
  expect(f.k.store.openAsks("lead")).toHaveLength(0);
  f.runtime.tickRefused("lead", new Error("offline"));
  expect(f.k.store.openAsks("lead")[0]?.question).toMatch(/refused 3 Keeper ticks/);
});

it("opens an unconfirmed stop ask at the selected delay, not before", async () => {
  const f = await party();
  f.save({ keepers: { stopAskAfterSeconds: 30 } });
  f.bb.sdk.threads.get = vi.fn(async ({threadId}) => makeThreadResponse({ id: threadId, status: "active" }));
  f.bb.sdk.threads.stop = vi.fn(async () => ({ok: true as const}));
  await f.runtime.stop(f.q.id);
  f.advance(29_999); await f.runtime.retryStops("lead", f.q.id, true);
  expect(f.k.store.openAsks("lead").find(a => a.effect?.type === "retry-stop")).toBeUndefined();
  f.advance(1); await f.runtime.retryStops("lead", f.q.id, true);
  expect(f.k.store.openAsks("lead").find(a => a.effect?.type === "retry-stop")).toBeTruthy();
});

it("exhausts brief delivery at the selected number of attempts", async () => {
  const f = await party();
  f.save({ keepers: { briefRetryAttempts: 1 } });
  vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValue(new Error("offline"));
  await f.runtime.sendRebrief(f.member.threadId, "Resume work");
  expect(runtimeFixture(f.k.store, f.member.threadId).pendingBrief?.attempts).toBe(1);
  expect(f.k.store.openAsks("lead").find(a => a.kind === "blocker")?.why).toContain("after 1 attempt.");
});

it("enforces the configured replacement and keep ceilings", async () => {
  const f = await party();
  fixtureActivity(f.k, f.member.threadId, "done");
  f.save({ keepers: { replacementsPerSlot: 0, keepMaxHours: 2 } });
  expect(() => f.runtime.keep("lead", f.member.threadId, f.time() + 2 * 3_600_000 + 1, "Wait")).toThrow(/2 hours/);
  f.runtime.keep("lead", f.member.threadId, f.time() + 2 * 3_600_000, "Wait");
  patchThreadFixture(f.k.store, f.member.threadId, { released: { reason: "Done", decisionId: "release-f" } });
  expect(() => reserveStaffing(f.k, f.k.quest(f.q.id), "smith", 1, "replacement")).toThrow(/0 replacements/);
});

it("enforces the configured Ranger fallback when the Keeper class has no cap", async () => {
  const f = await party();
  const snapshot = f.runtime.snapshot("project");
  vi.spyOn(f.runtime, "prepareRegistry").mockResolvedValue({ ...snapshot, classes: snapshot.classes.map(c => c.id === "keeper" ? { ...c, budget: null } : c) });
  const ranger = f.k.bind("ranger-child", "ranger", "fern", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: null, errand: false, title: "Scout", brief });
  f.k.activity(ranger.threadId, "working");
  f.save({ keepers: { rangerMax: 1 } });
  await expect(f.runtime.hire("lead", "project", { classId: "ranger", errand: true, title: "Scout again", brief: { ...brief, questions: ["Which source?"], timeboxMinutes: 5 } })).rejects.toThrow(/Ranger budget is full/);
});

it("uses the shorter configured class-file wait and the chosen blocker delay", async () => {
  const f = await party();
  f.save({ keepers: { registryWaitSeconds: 5, registryBlockerMinutes: 1 } });
  f.port.dispatchCheck = () => { throw new Error("class root unreachable"); };
  const first = await f.runtime.dispatch(dispatch049());
  expect(first).toMatchObject({action: "wait"});
  f.advance(5_000);
  expect(await f.runtime.dispatch(dispatch049())).toEqual({action: "proceed"});
  expect(f.k.store.runtime("lead").classNotice?.message).toContain("after 5 seconds");
  const notices = () => f.k.store.events("lead").filter(event => event.type === "blocker.moved");
  f.runtime["registryFailureBlocker"](f.member.threadId, f.member, null, "class root unreachable", f.time() - 59_999);
  expect(notices()).toHaveLength(0);
  expect(f.k.store.openAsks("lead")).toHaveLength(0);
  f.runtime["registryFailureBlocker"](f.member.threadId, f.member, null, "class root unreachable", f.time() - 60_000);
  expect(notices()).toMatchObject([{ data: { reason: "class root unreachable" } }]);
  expect(f.k.store.openAsks("lead")).toHaveLength(0);
});

it("reads the configured tuner evidence window", () => {
  const f = fixture();
  const data = vi.spyOn(f.insights, "data");
  f.save({ tuning: { windowDays: 7 } });
  f.insights.signals();
  expect(data).toHaveBeenCalledWith(f.time() - 7 * 86_400_000, f.time());
});

it("snapshots the confirmed stop selection and notification delay", async () => {
  const f = fixture();
  f.save({ away: { neverWhileClosed: ["merge", "delete", "other-writes"], productionWakeHours: 3 } });
  const request = { revision: 0, until: f.time() + 4 * 3_600_000, quests: [], wakeRules: { blockers: false, productionAsksAfterTwoHours: true } };
  await expect(f.runtime.away.close({...request, settingsRevision: 0})).rejects.toThrow(/Closing time changed/);
  const closed = await f.runtime.away.close({...request, settingsRevision: 1, stopList: ["merge"]});
  expect(f.settings.read().away.neverWhileClosed).toEqual(["merge", "delete", "other-writes"]);
  const openedAt = f.time();
  expect(closed.state.window?.stopList).toEqual(["merge"]);
  f.save({ away: { neverWhileClosed: [], productionWakeHours: 10 } });
  expect(f.runtime.away.snapshot().window?.stopList).toEqual(["merge"]);
  f.advance(3 * 3_600_000 - 1);
  expect(f.runtime.away.shouldNotify("production", openedAt)).toBe(false);
  f.advance(1);
  expect(f.runtime.away.shouldNotify("production", openedAt)).toBe(true);
});

it("lists live overrides outside TOML and fences an end action by caller and revision", async () => {
  const f = await party();
  f.save({ tuning: { mode: "apply" } });
  f.settings.override(f.q.id, "lead", { staleMinutes: 42, reportBatchSeconds: 77 }, "Quest pacing");
  const handlers = settingsHandlers(f.settings, { status: () => ({}) } as SettingsFiles);
  const input = { revision: f.settings.snapshot().revision, boardQuestId: f.q.id, key: "staleMinutes" as const };
  const client = { experimental_caller: {kind:"client"} } as never;
  expect(await handlers.settings(null, client)).toMatchObject({ liveOverrides: expect.arrayContaining([expect.objectContaining({ questId: f.q.id, questTitle: f.q.title, key: "staleMinutes", value: 42, keeperThreadId: "lead" })]) });
  expect(exportToml(f.settings.snapshot())).not.toMatch(/overrides|42/);
  expect(() => handlers.settingsEndOverride(input, { experimental_caller: {kind:"plugin", pluginId:"other"} } as never)).toThrow(/explicit client/);
  expect(await handlers.settingsEndOverride({...input, revision: 0}, client)).toMatchObject({code:"stale"});
  expect(await handlers.settingsEndOverride(input, client)).toMatchObject({code:"ok"});
  expect(f.settings.read(f.q.id).knobs).toMatchObject({ staleMinutes: 20, reportBatchSeconds: 77 });
  expect(f.k.store.events().some(e => e.type === "authority.acted" && e.data.act === "settingsEndOverride")).toBe(true);
});
