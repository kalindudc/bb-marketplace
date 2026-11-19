// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest, putQuestFixture } from "./support";
import { registerRpc } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools/index";
import { placementRecord } from "./placement-fixture";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";

const brief = { outcome: "Watch", outOfScope: "Rest", doneWhen: "Report", mode: "make-it-work" as const, context: [], questions: [], timeboxMinutes: 5 };

describe("held quests", () => {
  it.each(["scout", "greenlight", "build"] as const)("holds and resumes %s without touching a member or machine", async phase => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Watch", "Watch");
    if (phase !== "scout") f.k.plan("lead", planInput(q.id));
    if (phase === "build") f.k.answerAsk(f.k.store.openAsks("lead")[0]!.id, "approve", null, "page", "user");
    const member = f.k.bind("child", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Watch", brief });
    const before = f.k.store.runtime(member.threadId);
    const machines = f.runtime.placements().store;
    machines.reserve(placementRecord({ memberThreadId: member.threadId, questId: q.id, keeperThreadId: "lead" }), { maxMakers: 2, maxCheckers: 2 });
    const placed = machines.byMember(member.threadId);
    f.k.setQuestHeld(q.id, true, { kind: "user" });
    expect(f.k.quest(q.id)).toMatchObject({ phase: "held", held: { from: phase, since: f.time() } });
    expect(f.k.summary(q.id).move.text).toMatch(/^Held by you since .* · Resume$/);
    await expect(f.runtime.hire("lead", "project", { title: "Watch", classId: "smith", boardQuestId: q.id, waypointId: "w1", brief })).rejects.toThrow(/^Watch is held by you since .*; resume it first\.$/);
    await expect(f.runtime.tell("lead", member.threadId, "New work")).rejects.toThrow(/resume it first/);
    expect(f.k.store.runtime(member.threadId)).toEqual(before);
    expect(machines.byMember(member.threadId)).toEqual(placed);
    expect(f.k.restatement("lead")).toContain("held by you since");
    expect(f.k.restatement("lead")).not.toContain("Allocated party");
    f.k.setQuestHeld(q.id, false, { kind: "user" });
    expect(f.k.quest(q.id).phase).toBe(phase);
    expect(f.k.store.events("lead").filter(event => ["quest.held", "quest.resumed"].includes(event.type)).map(event => event.data.receipt)).toEqual([expect.objectContaining({ kind: "user-act", id: expect.stringMatching(/^act_/), surface: "client (unattested)" }), expect.objectContaining({ kind: "user-act", id: expect.stringMatching(/^act_/), surface: "client (unattested)" })]);
  });
  it("ticks skip held quest news while unrelated news and user messages remain live", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Held watch", "Held watch");
    f.k.setQuestHeld(q.id, true, { kind: "user" });
    f.k.store.patch("lead", { cursor: f.k.store.events("lead").at(-1)!.id, userAt: null });
    f.k.store.event(f.time(), "lead", q.id, "report.filed", "HELD_WORK_DO_NOT_ACT", { reportId: "missing" });
    f.k.store.event(f.time(), "lead", null, "promise.due", "Unrelated news");
    f.k.reanchor("lead", "test the held digest");
    f.advance(61_000);
    await f.runtime.tick("lead");
    const packets = f.harness.inspection.sdk.callsTo("threads.send").map(call => (call.args[0] as { input: { text: string }[] }).input[0]!.text).join("\n");
    expect(packets).toContain("held by you since");
    expect(packets).not.toContain("HELD_WORK_DO_NOT_ACT");
    expect(packets).not.toContain('For "Held watch": Propose');
    f.k.receiveUser("lead", "Resume the watch");
    expect(f.k.store.runtime("lead").pending.at(-1)?.text).toBe("Resume the watch");
  });
  it("requires the user's own routed message for this quest for both tools", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Watch", "Watch");
    registerTools(f.bb, f.runtime);
    for (const hold of [true, false]) {
      expect(() => f.k.setQuestHeld(q.id, hold, { kind: "agent", threadId: "lead" }, "fake")).toThrow(/user's own routed/);
      f.advance(1);
      f.k.receiveUser("lead", hold ? "Pause here" : "Resume now");
      const route = f.k.route("lead", { kind: "steer", boardQuestId: q.id, summary: "User direction", notes: [] });
      const other = await seedQuest(f.k, "lead", "Other", "Other");
      expect(() => f.k.setQuestHeld(other.id, hold, { kind: "agent", threadId: "lead" }, route.sourceMessageId!)).toThrow(/user's own routed/);
      await f.harness.behavior.invokeAgentTool(hold ? "tavern_hold" : "tavern_resume", { boardQuestId: q.id, messageId: route.sourceMessageId! }, { threadId: "lead" });
      expect(f.k.store.events("lead").at(-1)?.data.receipt).toEqual({ kind: "user-message", id: route.sourceMessageId, text: hold ? "Pause here" : "Resume now" });
    }
  });
  it("refuses non-client Hold and Resume RPCs", async () => {
    const f = setup();
    registerRpc(f.bb, f.runtime);
    const q = await seedQuest(f.k, "lead", "Watch", "Watch");
    for (const method of ["holdBoardQuest", "resumeBoardQuest"]) await expect(f.harness.invokeRpc(method, { id: q.id }, { experimental_caller: { kind: "plugin", pluginId: "tavern" } })).rejects.toThrow(/explicit client/);
    expect(f.k.quest(q.id).phase).toBe("scout");
  });
  it("can stop held work and reopens scouting without a greenlit plan", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Watch", "Watch");
    f.k.setQuestHeld(q.id, true, { kind: "user" });
    await f.runtime.stop(q.id, "Stop");
    expect(f.k.quest(q.id).phase).toBe("stopped");
    f.advance(1);
    f.k.receiveUser("lead", "Reopen the watch");
    const route = f.k.route("lead", { kind: "steer", boardQuestId: q.id, summary: "Reopen", notes: [] });
    expect(f.k.reopenQuest(q.id, { kind: "agent", threadId: "lead" }, route.sourceMessageId!).phase).toBe("scout");
  });
  it("reads an old conclude hold as kept-open, not a lifecycle hold", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Watch", "Watch");
    f.k.store.event(f.time(), "lead", q.id, "quest.held", "Kept open", { askId: "old" });
    expect(f.k.store.events("lead").at(-1)?.type).toBe("quest.kept-open");
    f.k.setQuestHeld(q.id, true, { kind: "user" });
    expect(f.k.store.events("lead").at(-1)?.type).toBe("quest.held");
  });
  it("reuses an earlier user approval when a replacement plan fits, withdrawing the superseded ask", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Watch", "Watch");
    f.k.plan("lead", planInput(q.id));
    const approval = f.k.store.openAsks("lead", q.id)[0]!;
    f.k.answerAsk(approval.id, "approve", null, "page", "user");
    f.k.plan("lead", { ...planInput(q.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
    const superseded = f.k.store.openAsks("lead", q.id)[0]!;
    f.k.plan("lead", planInput(q.id));
    expect(f.k.quest(q.id).phase).toBe("build");
    expect(f.k.store.get("asks", superseded.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "plan-superseded" });
    const event = f.k.store.events("lead").filter(event => event.type === "plan.proposed").at(-1)!;
    expect(event.data.phase).toEqual({ from: "greenlight", to: "build" });
    expect(event.data.receipt).toEqual({ kind: "ask-answer", id: approval.id });
    expect(f.k.store.openAsks("lead", q.id)).toEqual([]);
  });
  it("reuses the earlier reversible auto-approval decision", async () => {
    const f = setup();
    f.k.settings = () => ({ ...DEFAULT_SETTINGS, keepers: { ...DEFAULT_SETTINGS.keepers, greenlight: "by-size" } });
    const q = await seedQuest(f.k, "lead", "Watch", "Watch");
    const slot = { classId: "smith", characterId: null, model: null, purpose: "Work", waypointIds: ["w1"] };
    const plan = { ...planInput(q.id), reversible: true, party: [slot] };
    f.k.plan("lead", plan);
    const approval = f.k.store.query("decisions", "boardQuestId", q.id)[0]!;
    f.k.plan("lead", { ...plan, party: [slot, slot] });
    const superseded = f.k.store.openAsks("lead", q.id)[0]!;
    f.k.plan("lead", plan);
    expect(f.k.quest(q.id).phase).toBe("build");
    expect(f.k.store.get("asks", superseded.id)?.withdrawnCause).toBe("plan-superseded");
    expect(f.k.store.events("lead").filter(event => event.type === "plan.proposed").at(-1)?.data.receipt).toEqual({ kind: "decision", id: approval.id });
  });
  it("refuses a fits-party return without a genuine earlier approval", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Watch", "Watch");
    f.k.plan("lead", planInput(q.id));
    putQuestFixture(f.k.store, q.id, { ...f.k.quest(q.id), greenlitVersion: 1 });
    expect(() => f.k.plan("lead", planInput(q.id))).toThrow(/earlier party approval/);
    expect(f.k.quest(q.id)).toMatchObject({ phase: "greenlight", planVersion: 1 });
    expect(f.k.store.openAsks("lead", q.id)).toHaveLength(1);
  });
  it.each(["check", "wrap"] as const)("reads old stored %s as build without migrating it", async phase => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Old work", "Old work");
    putQuestFixture(f.k.store, q.id, { ...q, phase });
    expect(f.k.quest(q.id).phase).toBe("build");
    expect(f.k.summary(q.id).phase).toBe("build");
    f.k.store.put("quests", q.id, { ...f.k.quest(q.id), title: "Renamed" });
    expect(f.k.store.get("quests", q.id)?.phase).toBe(phase);
    f.k.setQuestHeld(q.id, true, { kind: "user" });
    expect(f.k.quest(q.id).held?.from).toBe("build");
  });
  it("next news comes from live Rangers and open due promises", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Watch", "Watch");
    f.k.bind("ranger", "ranger", null, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Watch", brief });
    expect(f.k.summary(q.id).nextNewsBy).toBe(f.time() + 5 * 60_000);
    const deadline = f.time() + 60_000;
    f.k.memory.note("lead", { kind: "commitment", text: "News", boardQuestId: q.id, dueAt: deadline });
    expect(f.k.summary(q.id).nextNewsBy).toBe(deadline);
    expect(f.k.summary(q.id).move.text).toContain("next news by");
    f.k.setQuestHeld(q.id, true, { kind: "user" });
    expect(f.k.summary(q.id).nextNewsBy).toBeNull();
  });
});
