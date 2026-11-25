// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { dispatch049 } from "./dispatch-fixture";
import { planInput, seedQuest } from "./support";
import { registerTools } from "../../src/server/tools/index";
import { StudyEvents, StudyRefusal } from "../../src/server/study-events";
import { registerCli } from "../../src/server/cli";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";
import { DAY_MS, type CardSignal } from "../../src/shared/study-events";

it("records first observed Keeper execution and only emits changes, including reasoning-only changes", () => {
  const { runtime, k } = setup();
  const seat = k.member("lead")!;
  const low = { providerId: "provider", model: "model-a", reasoningLevel: "low" };
  runtime.study.execution(seat, low);
  runtime.study.execution(seat, low);
  runtime.study.execution(seat, { ...low, reasoningLevel: "high" });
  expect(runtime.study.page(0).events).toMatchObject([
    { type: "keeper.bound", threadId: "lead", data: low },
    { type: "keeper.execution-changed", threadId: "lead", data: { ...low, reasoningLevel: "high" } },
  ]);
});

it("does not delay an admitted turn when recording execution throws", async () => {
  const { runtime } = setup();
  const measurement = vi.spyOn(runtime.study, "execution").mockImplementation(() => {
    throw new Error("Execution measurement is unavailable");
  });
  const result = await runtime.dispatch(dispatch049());
  expect(measurement).toHaveBeenCalledOnce();
  expect(result).toEqual({ action: "proceed" });
});

it("leaves successful and refused tool calls unchanged when the study database cannot be written", async () => {
  const { runtime, k, bb, harness } = setup();
  registerTools(bb, runtime);
  const status = (input: unknown) => harness.behavior.invokeAgentTool("tavern_status", input, { threadId: "lead" });
  const expected = await status({});
  const invalid = { section: "not-a-section" };
  const error = await status(invalid).catch(error => error);
  if (!(error instanceof Error)) throw new Error("Expected the unrecognized section to be refused");
  k.store.db.exec("DROP TABLE tavern_study_events");
  await expect(status(invalid)).rejects.toThrow(error.message);
  await expect(status({})).resolves.toEqual(expected);
});

it("marks the next same-thread call at start, then records whether that exact call succeeded", async () => {
  const { runtime, bb, harness } = setup();
  registerTools(bb, runtime);
  const invoke = (tool: string, input: unknown, threadId: string) => harness.behavior.invokeAgentTool(tool, input, { threadId });
  await expect(invoke("tavern_status", {}, "unbound")).rejects.toThrow();
  await expect(invoke("tavern_status", { section: "not-a-section" }, "lead")).rejects.toThrow();
  await expect(invoke("tavern_status", {}, "another-thread")).rejects.toThrow();
  await invoke("tavern_status", {}, "lead");
  expect(runtime.study.page(0).events).toMatchObject([
    { type: "tool.refused", threadId: "unbound", data: { ruleId: "tool.role", nextCall: null } },
    { type: "tool.refused", threadId: "lead", data: { ruleId: "tool.arguments", classId: "keeper", argumentBytes: 27, nextCall: { tool: "tavern_status", succeeded: true, afterMs: 0 } } },
    { type: "tool.refused", threadId: "another-thread", data: { nextCall: null } },
  ]);
});

it("uses the configured next-call window and observes failure without replacing the first follow-up", async () => {
  const f = setup();
  const s = new StudyEvents(f.k.store, f.time, () => 2, vi.fn());
  const reject = () => { throw new StudyRefusal("example.refusal", "sensitive text"); };
  await expect(s.tool("journal", "lead", { text: "private" }, reject)).rejects.toThrow("sensitive text");
  f.advance(2_001);
  await expect(s.tool("tavern_plan", "lead", {}, reject)).rejects.toThrow();
  await expect(s.tool("tavern_plan", "lead", {}, reject)).rejects.toThrow();
  await s.tool("journal", "lead", {}, () => "ok");
  const { events } = s.page(0);
  expect(events.map(row => row.data.ruleId)).toEqual(Array(3).fill("example.refusal"));
  expect(events.map(row => row.data.nextCall)).toEqual([null, { tool: "tavern_plan", succeeded: false, afterMs: 0 }, { tool: "journal", succeeded: true, afterMs: 0 }]);
  expect(JSON.stringify(events)).not.toMatch(/sensitive|private/);
});

it("records a labeled plan revision on the ledger and exports it without the plan text", async () => {
  const { k, runtime } = setup();
  const quest = await seedQuest(k, "lead", "Track revisions", "Private goal");
  k.plan("lead", planInput(quest.id));
  k.plan("lead", { ...planInput(quest.id), changeNote: "Private detail", cause: "failed-check" });
  expect(k.store.latestQuestEvent(quest.id, "plan.revised")?.data.cause).toBe("failed-check");
  expect(runtime.study.page(0).events).toMatchObject([{ type: "plan.revised", questId: quest.id, data: { cause: "failed-check", causeSource: "keeper", fromVersion: 1, toVersion: 2 } }]);
  expect(JSON.stringify(runtime.study.page(0))).not.toContain("Private detail");
});

it("requires a fresh greenlight for weaker checks despite a Keeper-given steer cause", async () => {
  const { k, runtime, bb, harness } = setup();
  registerTools(bb, runtime);
  const quest = await seedQuest(k, "lead", "Require approval", "Keep the check");
  const draft = planInput(quest.id);
  const waypoints = draft.waypoints.map(waypoint => ({ ...waypoint, owner: null, check: "warden" as const }));
  k.plan("lead", { ...draft, waypoints });
  const first = k.store.openAsks("lead", quest.id).find(ask => ask.kind === "greenlight")!;
  k.answerAsk(first.id, "approve", null, "page", "user");
  expect(k.quest(quest.id).phase).toBe("build");

  await harness.behavior.invokeAgentTool("tavern_plan", {
    ...draft, waypoints: waypoints.map(waypoint => ({ ...waypoint, check: "none" })), cause: "steer",
  }, { threadId: "lead" });
  expect(k.quest(quest.id)).toMatchObject({ phase: "greenlight", greenlitVersion: 1, planVersion: 2 });
  expect(k.store.openAsks("lead", quest.id).find(ask => ask.kind === "greenlight")?.effect)
    .toMatchObject({ type: "greenlight", planVersion: 2 });
  expect(runtime.study.page(0).events).toMatchObject([
    { type: "plan.revised", questId: quest.id, data: { cause: "steer", causeSource: "keeper" } },
  ]);
});

it("deduplicates card milestones and retires only private study rows; the CLI exports JSON", async () => {
  const { runtime, k, advance, bb, harness } = setup();
  const signal: CardSignal = { threadId: "lead", messageId: "message", cardId: "map:v1", cardType: "questmap", questId: null, action: "first-seen" };
  runtime.study.cards([signal, signal, { ...signal, action: "expanded" }]);
  k.store.event(1, "lead", null, "plan.revised", "Unrelated live history");
  expect(runtime.study.page(0).events.map(e => [e.type, e.data.action])).toEqual([["card.engagement", "first-seen"], ["card.engagement", "expanded"]]);
  registerCli(bb, runtime);
  const run = async (...args: string[]) => JSON.parse((await harness.inspection.registrations.cli[0]!.run(["study-events", ...args], {})).stdout ?? "");
  const page = await run();
  expect(page.events).toHaveLength(2);
  expect((await run("--after", String(page.events[0].id))).events).toHaveLength(1);
  const backup = new BackupRecords(k.store.db, new SettingsStore(k.store.db)).capture();
  expect(backup.tables).not.toHaveProperty("tavern_study_events");
  expect(backup.tables).not.toHaveProperty("tavern_study_state");
  advance(DAY_MS + 1);
  runtime.study.prune(1);
  expect(runtime.study.page(0).events).toHaveLength(0);
  expect(k.store.events("lead")).toMatchObject([{ type: "plan.revised" }]);
});
