// @vitest-environment node
import { seedQuest } from "../server/support";
import { expect, it, vi } from "vitest";
import { setup } from "../server/runtime-fixture";
import { makeThreadResponse } from "../server/host";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { briefSchema } from "../../src/shared/schema";
import { evaluateRules } from "../../src/server/settings/tuner";
import { registerTools } from "../../src/server/tools/index";
import { planInput } from "../server/support";
it("records member interruptions once without applying Keeper-only stop behavior to the member", async () => {
  const at = 1_000_000;
  const f = setup({ threads: { events: { list: async () => [{ type: "system/thread/interrupted", seq: 1, createdAt: at, data: { reason: "manual-stop" } }] } } });
  const settings = new SettingsStore(f.k.store.db, f.time), insights = new InsightsReader(f.k.store.db, settings, f.time);
  f.runtime.enableSettings(settings, insights);
  const q = await seedQuest(f.k,"lead", "Read", "Read");
  f.k.bind("member", "smith", "otto", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Read", brief: briefSchema.parse({ outcome: "Read", mode: "make-it-work", outOfScope: "", doneWhen: "Read", context: [] }) });
  await f.runtime.observe(makeThreadResponse({ id: "member" }), 1);
  await f.runtime.observe(makeThreadResponse({ id: "member" }), 1);
  const rows = insights.data(0).events.filter(event => event.type === "turn.interrupted");
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ at, keeperThreadId: "lead", questId: q.id, data: { reason: "manual-stop", threadId: "member" } });
  expect(f.k.store.runtime("member").manualStopAt).toBeUndefined();
});
it("records completed Ranger runs from the acknowledged initial brief for the time-box rule", async () => {
  const f = setup(), settings = new SettingsStore(f.k.store.db, f.time), insights = new InsightsReader(f.k.store.db, settings, f.time);
  f.runtime.enableSettings(settings, insights); registerTools(f.bb, f.runtime);
  const brief = briefSchema.parse({ outcome: "Read", mode: "make-it-work", outOfScope: "", doneWhen: "Read", context: [], questions: ["What exists?"], timeboxMinutes: 5 });
  f.k.bind("scout", "ranger", "otto", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Read", brief });
  f.k.store.patch("scout", { initialBriefAt: f.time() - 8 * 60_000 });
  await f.harness.behavior.invokeAgentTool("tavern_report", { status: "done", outcome: "Found the files", evidence: [], artifacts: [] }, { threadId: "scout" });
  expect(insights.signals()).toMatchObject({ rangerMinutes: [8], rangerOverruns: 1 });
});
it("measures main Keeper turn time from native boundaries without double counting", async () => {
  const at = 1_000_000, scope = { kind: "turn", turnId: "main" };
  const f = setup({ threads: { events: { list: async () => [
    { type: "turn/started", seq: 1, createdAt: at, scope, data: { parentToolCallId: null } },
    { type: "turn/completed", seq: 2, createdAt: at + 90_000, scope, data: { status: "completed" } },
  ] } } });
  const settings = new SettingsStore(f.k.store.db, f.time), insights = new InsightsReader(f.k.store.db, settings, f.time);
  f.runtime.enableSettings(settings, insights); f.advance(90_000);
  await f.runtime.observe(makeThreadResponse({ id: "lead" }), 2); await f.runtime.observe(makeThreadResponse({ id: "lead" }), 2);
  expect(insights.signals().keeperTurnSeconds).toEqual([90]);
});
it("records definite failed spawns and review-budget holds as measured events", async () => {
  const f = setup(), settings = new SettingsStore(f.k.store.db, f.time), insights = new InsightsReader(f.k.store.db, settings, f.time);
  f.runtime.enableSettings(settings, insights);
  const brief = briefSchema.parse({ outcome: "Read", mode: "make-it-work", outOfScope: "", doneWhen: "Read", context: [], questions: ["What exists?"], timeboxMinutes: 3 });
  vi.spyOn(f.bb.sdk.threads, "spawn").mockRejectedValueOnce(Object.assign(new Error("Invalid request"), { status: 400 }));
  await expect(f.runtime.hire("lead", "project", { classId: "ranger", title: "Read", errand: true, brief })).rejects.toThrow("Invalid request");
  expect(insights.data(0).events.filter(event => event.type === "spawn.failed")).toHaveLength(1);
  const quest = await seedQuest(f.k,"lead", "Build", "Build"); f.k.plan("lead", planInput(quest.id));
  f.k.answerAsk(f.k.asks("lead").find(ask => ask.kind === "greenlight")!.id, "approve", null, "page");
  vi.spyOn(f.runtime, "review").mockReturnValue({ waiting: 3, budget: 3, items: [] });
  await expect(f.runtime.hire("lead", "project", { classId: "smith", title: "Build", boardQuestId: quest.id, waypointId: "w1", brief })).rejects.toThrow(/review budget/);
  expect(insights.data(0).events.filter(event => event.type === "review-budget.held")).toHaveLength(1);
});
it("links every tuning rule to an actual chart in its Insights section", async () => {
  const f = setup(), settings = new SettingsStore(f.k.store.db, f.time), insights = new InsightsReader(f.k.store.db, settings, f.time);
  const proposals = evaluateRules(settings.read().knobs, { ticks: 20, held: 10, deferred: 0, typingHolds: 5, afterMessageHolds: 5,
    keeperTurnSeconds: Array(20).fill(90), reportIntervals: Array(20).fill({ classId: "smith", seconds: 1800 }), staleStrikes: 0,
    lateReportsAfterStrike: 0, releases: 0, reportsPerMinute: Array(20).fill(4), restatementBytes: [], restatementClipped: 0,
    tickFactChars: [], factsClipped: 0, rangerMinutes: Array(20).fill(18), rangerOverruns: 3 });
  expect(proposals).toHaveLength(5);
  const view = await insights.view("30d");
  for (const proposal of proposals) {
    expect(["party", "reliability"]).toContain(proposal.evidence.section);
    const section = proposal.evidence.section === "party" ? view.party : view.reliability;
    expect(section.series.map(series => series.id)).toContain(proposal.evidence.chart);
  }
});
