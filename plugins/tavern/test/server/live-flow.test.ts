// @vitest-environment node
import { fixtureActivity, patchThreadFixture } from "./member-fixture";
import { concludeQuest } from "./support";
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput, waypointEntry } from "./support";
import { queued049 } from "./dispatch-fixture";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import {
  makeThreadResponse,
  makePluginAgentConfigurationContext,
} from "./host";
import { catalog, model } from "./provider-fixture";
import { journalEntrySchema } from "../../src/shared/schema";

const brief = {
  outcome: "Answer the numbered question",
  mode: "make-it-work" as const,
  outOfScope: "Deliverable",
  doneWhen: "Report evidence",
  context: [],
  questions: ["1. What is present?"],
  timeboxMinutes: 5,
};
function bind(
  f: ReturnType<typeof setup>,
  threadId: string,
  classId: string,
  questId: string,
  characterId = "lark",
) {
  return f.k.bind(threadId, classId, characterId, "project", {
    keeperThreadId: "lead",
    boardQuestId: questId,
    waypointId: null,
    errand: false,
    title: "Task",
    brief,
  });
}

describe("live Keeper flow regressions", () => {
  it("tells a scouting Keeper to propose the map after a Ranger report and never prints approved vnone", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Small goal", "Small");
    f.k.store.patch("lead", { userAt: null });
    bind(f, "scout", "ranger", q.id);
    f.k.report("scout", {
      status: "done",
      outcome: "Evidence found",
      evidence: [],
      artifacts: [],
      confidence: null,
      voice: null,
    });
    expect(f.k.restatement("lead")).not.toContain("approved vnone");
    expect(f.k.restatement("lead")).not.toContain("Next link: Check the plan");
    await f.runtime.tick("lead");
    const text = JSON.stringify(
      f.harness.inspection.sdk.callsTo("threads.send"),
    );
    expect(text).toContain(
      "Propose the quest map with tavern_plan now (done-when, waypoints, party, questions)",
    );
  });
  it("prepares and links existing owners before committing a plan and assigns a Warden multiple waypoints", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    bind(f, "maker", "ranger", q.id);
    bind(f, "checker", "warden", q.id, "rook");
    let prepared = false;
    f.port.prepare = vi.fn(async () => {
      prepared = true;
    });
    f.port.linkWaypoint = vi.fn((threadId, link, title, owner) => {
      expect(prepared).toBe(true);
      expect(threadId).toBe("maker");
      expect(owner).toBe("maker");
      return link.waypointId;
    });
    const base = planInput(q.id);
    await f.runtime.plan("lead", {
      ...base,
      waypoints: [
        { ...base.waypoints[0]!, owner: "maker" },
        { ...base.waypoints[0]!, id: "w2", owner: "maker" },
      ],
      party: [
        {
          classId: "warden",
          characterId: "rook",
          model: null,
          purpose: "Check",
          waypointIds: ["w1", "w2"],
        },
      ],
    });
    expect(f.port.linkWaypoint).toHaveBeenCalledTimes(2);
    expect(f.k.member("checker")?.checkerWaypointId).toBe("w1");
    expect(f.k.checkerWaypoints("checker")).toEqual(["w1", "w2"]);
    expect(
      f.k.asks("lead").find((ask) => ask.kind === "greenlight")?.state,
    ).toBe("open");
  });
  it("does not commit a plan when an existing owner's log cannot be prepared", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    bind(f, "maker", "ranger", q.id);
    f.port.prepare = async () => {
      throw new Error("Legacy import failed");
    };
    const base = planInput(q.id);
    await expect(
      f.runtime.plan("lead", {
        ...base,
        waypoints: [{ ...base.waypoints[0]!, owner: "maker" }],
      }),
    ).rejects.toThrow("Legacy import failed");
    expect(f.k.quest(q.id).planVersion).toBe(0);
  });
  it("clears a Warden's former assignments when a revised plan removes its slot", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    bind(f, "checker", "warden", q.id, "rook");
    const base = planInput(q.id);
    await f.runtime.plan("lead", {
      ...base,
      party: [
        {
          classId: "warden",
          characterId: "rook",
          model: null,
          purpose: "Check",
          waypointIds: ["w1"],
        },
      ],
    });
    expect(f.k.checkerWaypoints("checker")).toEqual(["w1"]);
    await f.runtime.plan("lead", base);
    expect(f.k.member("checker")?.checkerWaypointId).toBeNull();
    expect(f.k.checkerWaypoints("checker")).toEqual([]);
  });
  it("binds a new Warden's explicit waypoint into its existing approved class slot", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    bind(f, "maker", "ranger", q.id);
    const entry = waypointEntry("maker", q.id), get = f.port.get;
    f.port.get = id => ({ ...get(id), entries: id === "maker" ? [entry] : [] });
    f.port.linkedEntries = () => [entry];
    const base = planInput(q.id);
    f.k.plan("lead", {
      ...base,
      waypoints: [{ ...base.waypoints[0]!, owner: "maker" }],
      party: [
        {
          classId: "warden",
          characterId: null,
          model: null,
          purpose: "Check",
          waypointIds: [],
        },
      ],
    });
    f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
    const member = await f.runtime.hire("lead", "project", {
      classId: "warden",
      boardQuestId: q.id,
      waypointId: "w1",
      title: "Check",
      brief,
    });
    expect(f.k.checkerWaypoints(member.threadId)).toEqual(["w1"]);
    expect(member.checkerWaypointId).toBe("w1");
    expect(f.k.asks("lead").filter((ask) => ask.state === "open")).toHaveLength(
      0,
    );
  });
  it("reuses a resting Warden only for its rejected waypoint and pinned maker", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Two makers", "Check");
    const first = bind(f, "maker-one", "ranger", q.id);
    const second = bind(f, "maker-two", "ranger", q.id, "fern");
    const entries = [waypointEntry(first.threadId, q.id, "w1"), waypointEntry(second.threadId, q.id, "w2")];
    const get = f.port.get;
    f.port.get = id => ({ ...get(id), entries: entries.filter(entry => entry.threadId === id) });
    f.port.linkedEntries = () => entries;
    const base = planInput(q.id);
    f.k.plan("lead", { ...base,
      waypoints: [{ ...base.waypoints[0]!, owner: first.threadId }, { ...base.waypoints[0]!, id: "w2", owner: second.threadId }],
      party: [{ classId: "warden", characterId: "rook", model: null, purpose: "Check one", waypointIds: ["w1"] },
        { classId: "warden", characterId: "vex", model: null, purpose: "Check two", waypointIds: ["w2"] }],
    });
    f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
    const hire = (waypointId: string) => f.runtime.hire("lead", "project", { classId: "warden", boardQuestId: q.id, waypointId, title: "Check", brief });
    const resting = await hire("w1");
    fixtureActivity(f.k, resting.threadId, "done");
    const [entry] = entries;
    entry!.status = "rejected";
    entry!.review = { actor: { kind: "agent", threadId: resting.threadId }, at: f.time(), evidence: [], reason: "Fix", previousNote: null, memberEvidenceAt: null };
    await expect(hire("w1")).rejects.toThrow(/is resting.*tavern_tell/);
    await expect(hire("w2")).resolves.toMatchObject({ checkerMakerThreadId: second.threadId });
    expect(f.k.member(resting.threadId)?.engagement).toBe("resting");
  });
  it("does not accept a completed report while any of the member's linked waypoints is unfinished", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    bind(f, "maker", "ranger", q.id);
    const entry = journalEntrySchema.parse({
      threadId: "maker",
      id: "a1",
      parentId: null,
      description: "Done",
      owner: "maker",
      status: "done",
      evidence: [
        { kind: "command", ref: "npm test", detail: "Passed", exitCode: 0 },
      ],
      order: 0,
      note: null,
      link: { boardQuestId: q.id, waypointId: "w1" },
      updatedAt: f.time(),
      createdAt: f.time(),
      updatedBy: { kind: "tavern" },
      createdBy: { kind: "tavern" },
    });
    const originalGet = f.port.get;
    f.port.get = (threadId) => ({
      ...originalGet(threadId),
      entries: [
        entry,
        {
          ...entry,
          id: "a2",
          status: "todo",
          link: { boardQuestId: q.id, waypointId: "w2" },
        },
      ],
    });
    expect(() =>
      f.k.report("maker", {
        status: "done",
        outcome: "Done",
        evidence: [],
        artifacts: [],
        confidence: null,
        voice: null,
      }),
    ).toThrow("evidence");
  });
  it("lets one current steer govern both quests even after a newer queued message arrives", async () => {
    const f = setup();
    const a = await seedQuest(f.k,"lead", "README missing plugins", "README");
    const b = await seedQuest(f.k,"lead", "TS lines", "LOC");
    registerTools(f.bb, f.runtime);
    f.k.receiveUser(
      "lead",
      "Close both quests properly with a plan and a Warden",
      null,
      "both",
    );
    const routed = JSON.parse(
      (await f.harness.behavior.invokeAgentTool(
        "tavern_route",
        {
          kind: "steer",
          boardQuestIds: [a.id, b.id],
          summary: "Plan and check both quests",
          notes: [],
        },
        { threadId: "lead" },
      )) as string,
    );
    f.runtime.queued(
      queued049("loc", "For the LOC quest, sort by total", f.time() + 1),
    );
    expect(() =>
      f.k.plan("lead", { ...planInput(a.id), fromSteer: routed.id }),
    ).not.toThrow();
    expect(() =>
      f.k.plan("lead", { ...planInput(b.id), fromSteer: routed.id }),
    ).not.toThrow();
    expect(f.k.quest(a.id).planVersion).toBe(1);
    expect(f.k.quest(b.id).planVersion).toBe(1);
    f.k.endTurn("lead");
    expect(() => f.k.guard("lead", a.id)).toThrow();
  });
  it("records a verbatim user rule active, exposes a proposed rule inactive and confirms it", async () => {
    const f = setup();
    registerTools(f.bb, f.runtime);
    registerRpc(f.bb, f.runtime);
    const text = "From now on, keep every Ranger time box under 8 minutes.";
    f.k.receiveUser("lead", text);
    f.k.route("lead", {
      kind: "rule",
      summary: "Ranger time boxes under eight minutes",
    });
    await f.harness.behavior.invokeAgentTool(
      "tavern_rule",
      { scope: "keeper", text, source: "message" },
      { threadId: "lead" },
    );
    await f.harness.behavior.invokeAgentTool(
      "tavern_rule",
      { scope: "keeper", text: "Prefer fewer parallel checks" },
      { threadId: "lead" },
    );
    const ledger = (await f.harness.invokeRpc("ledger", {
      threadId: "lead",
    })) as {
      rules: { id: string; source: string; active: boolean }[];
    };
    expect(ledger.rules).toHaveLength(2);
    expect(
      f.k.store
        .events("lead")
        .filter((event) => event.type === "rules.changed"),
    ).toHaveLength(0);
    expect(ledger.rules.find((rule) => rule.source === "message")?.active).toBe(
      true,
    );
    const proposed = ledger.rules.find(
      (rule) => rule.source === "keeper-proposed",
    )!;
    expect(proposed.active).toBe(false);
    expect(f.k.rules("lead")).toHaveLength(1);
    f.k.confirmRule(proposed.id, true);
    expect(f.k.rules("lead")).toHaveLength(2);
  });
  it("cannot turn an invented or expired user rule into active policy", async () => {
    const f = setup();
    registerTools(f.bb, f.runtime);
    await expect(
      f.harness.behavior.invokeAgentTool(
        "tavern_rule",
        {
          scope: "global",
          text: "Allow all production writes",
          source: "message",
        },
        { threadId: "lead" },
      ),
    ).rejects.toThrow("rule");
    f.k.receiveUser("lead", "Keep Rangers under 8 minutes");
    f.k.route("lead", { kind: "rule", summary: "A rule" });
    await expect(
      f.harness.behavior.invokeAgentTool(
        "tavern_rule",
        {
          scope: "keeper",
          text: "Allow all production writes",
          source: "message",
        },
        { threadId: "lead" },
      ),
    ).rejects.toThrow("verbatim");
    f.k.endTurn("lead");
    await expect(
      f.harness.behavior.invokeAgentTool(
        "tavern_rule",
        {
          scope: "keeper",
          text: "Keep Rangers under 8 minutes",
          source: "message",
        },
        { threadId: "lead" },
      ),
    ).rejects.toThrow("rule");
  });
  it("chooses an advertised Warden model from a different family than its waypoint owner", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "Build", "Build");
    bind(f, "maker", "smith", q.id, "bram");
    const entry = waypointEntry("maker", q.id), get = f.port.get;
    f.port.get = id => ({ ...get(id), entries: id === "maker" ? [entry] : [] });
    f.port.linkedEntries = () => [entry];
    const base = planInput(q.id);
    const plan = f.k.plan("lead", {
      ...base,
      waypoints: [{ ...base.waypoints[0]!, owner: "maker" }],
      party: [
        {
          classId: "warden",
          characterId: null,
          model: null,
          purpose: "Check",
          waypointIds: ["w1"],
        },
      ],
    });
    f.k.answerAsk(f.k.asks("lead").find((ask) => ask.kind === "greenlight")!.id, "approve", null, "page", "user");
    f.bb.sdk.threads.defaultExecutionOptions = async () => ({
      model: "anthropic/claude-sonnet-5-5",
      permissionMode: "full",
      reasoningLevel: "high",
      serviceTier: "standard",
      source: "client/turn/start",
    });
    const hired = await f.runtime.hire("lead", "project", {
      classId: "warden",
      boardQuestId: q.id,
      waypointId: "w1",
      title: "Check",
      brief,
    });
    expect(
      f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.args[0],
    ).toMatchObject({
      model: "openai/gpt-6.1-sol",
    });
    expect(hired.executionNotes.join(" ")).toContain("different family");
  });
  it("falls back to the Warden class model if the catalog has no independent family", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "Build", "Build");
    bind(f, "maker", "smith", q.id, "bram");
    const entry = waypointEntry("maker", q.id), get = f.port.get;
    f.port.get = id => ({ ...get(id), entries: id === "maker" ? [entry] : [] });
    f.port.linkedEntries = () => [entry];
    const base = planInput(q.id);
    const plan = f.k.plan("lead", {
      ...base,
      waypoints: [{ ...base.waypoints[0]!, owner: "maker" }],
      party: [
        {
          classId: "warden",
          characterId: null,
          model: null,
          purpose: "Check",
          waypointIds: ["w1"],
        },
      ],
    });
    f.k.answerAsk(f.k.asks("lead").find((ask) => ask.kind === "greenlight")!.id, "approve", null, "page", "user");
    f.bb.sdk.threads.defaultExecutionOptions = async () => ({
      model: "anthropic/claude-opus-4",
      permissionMode: "full",
      reasoningLevel: "high",
      serviceTier: "standard",
      source: "client/turn/start",
    });
    f.bb.sdk.providers.models = async () => catalog([model()]);
    const hired = await f.runtime.hire("lead", "project", {
      classId: "warden",
      boardQuestId: q.id,
      waypointId: "w1",
      title: "Check",
      brief,
    });
    expect(
      f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.args[0],
    ).toMatchObject({
      model: "anthropic/claude-sonnet-5-5",
    });
    expect(hired.executionNotes.join(" ")).toContain("class model");
  });
  it("keeps active party display names unique even for an explicitly reused character", async () => {
    const f = setup();
    let child = 0;
    f.bb.sdk.threads.spawn = vi.fn(async () =>
      makeThreadResponse({
        id: `scout-${++child}`,
        parentThreadId: "lead",
        projectId: "project",
      }),
    );
    const input = {
      classId: "ranger",
      characterId: "lark",
      title: "Scout: plugin folders",
      errand: true,
      brief,
    };
    const first = await f.runtime.hire("lead", "project", input);
    const second = await f.runtime.hire("lead", "project", input);
    expect(first.displayName).toBe("Lark");
    expect(second.displayName).toBe("Lark II");
    expect(
      vi.mocked(f.bb.sdk.threads.spawn).mock.calls.at(-1)?.[0],
    ).toMatchObject({
      title: "Lark II · plugin folders",
    });
    expect(
      f.runtime.configure(
        makePluginAgentConfigurationContext({
          thread: { id: second.threadId },
        }),
      ).instructions,
    ).toContain("Lark II");
    registerRpc(f.bb, f.runtime);
    expect(
      await f.harness.invokeRpc("decor", { threadId: second.threadId }),
    ).toMatchObject({
      member: { displayName: "Lark II" },
    });
    expect(
      await f.harness.invokeRpc("crests", { threadIds: [second.threadId] }),
    ).toMatchObject({
      crests: [{ label: expect.stringContaining("Lark II") }],
    });
  });
  it("journal archive attribution as unknown when absent and restores unarchived member state", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    bind(f, "scout", "ranger", q.id);
    await f.runtime.threadLifecycle("thread.archived", {
      thread: makeThreadResponse({ id: "scout", archivedAt: f.time() }),
    });
    expect(f.k.member("scout")).toMatchObject({ state: "idle", engagement: "archived" });
    const archived = f.k.store
      .events("lead")
      .find((event) => event.type === "thread.archived")!;
    expect(archived.data).toMatchObject({
      memberThreadId: "scout",
      originActor: null,
    });
    await f.runtime.threadLifecycle("thread.unarchived", {
      thread: makeThreadResponse({
        id: "scout",
        status: "idle",
        archivedAt: null,
      }),
    });
    expect(f.k.member("scout")).toMatchObject({ state: "idle", engagement: "active" });
    expect(
      f.k.store
        .events("lead")
        .some((event) => event.type === "thread.unarchived"),
    ).toBe(true);
    await f.runtime.threadLifecycle("thread.archived", {
      thread: makeThreadResponse({ id: "lead", archivedAt: f.time() }),
      actor: { kind: "user" },
    });
    expect(
      f.k.store
        .events("lead")
        .filter((event) => event.type === "thread.archived")
        .at(-1)?.actor,
    ).toEqual({ kind: "user" });
  });
  it("keeps a completed member inactive when its final idle event arrives and preserves an explicit release on unarchive", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    bind(f, "scout", "ranger", q.id);
    const scoutReport = f.k.report("scout", {
      status: "done",
      outcome: "Answers",
      evidence: [],
      artifacts: [],
      confidence: null,
      voice: null,
    });
    await f.runtime.acceptRangerReport("lead", scoutReport.id);
    f.runtime.updateThread(makeThreadResponse({ id: "scout", status: "idle" }));
    expect(f.k.member("scout")).toMatchObject({ state: "idle", engagement: "resting" });
    patchThreadFixture(f.k.store, "scout", {
      released: { reason: "Released", decisionId: "decision" },
    });
    await f.runtime.threadLifecycle("thread.archived", {
      thread: makeThreadResponse({ id: "scout", archivedAt: f.time() }),
    });
    await f.runtime.threadLifecycle("thread.unarchived", {
      thread: makeThreadResponse({ id: "scout", archivedAt: null }),
    });
    expect(f.k.member("scout")?.engagement).toBe("released");
    bind(f, "other", "ranger", q.id, "fern");
    const otherReport = f.k.report("other", {
      status: "done",
      outcome: "Answers",
      evidence: [],
      artifacts: [],
      confidence: null,
      voice: null,
    });
    await f.runtime.acceptRangerReport("lead", otherReport.id);
    await f.runtime.threadLifecycle("thread.unarchived", {
      thread: makeThreadResponse({
        id: "other",
        status: "active",
        archivedAt: null,
      }),
    });
    expect(f.k.member("other")).toMatchObject({ state: "working", engagement: "resting" });
  });
  it("credits verified work to the entry's member rather than a symbolic plan owner", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    bind(f, "maker", "ranger", q.id);
    bind(f, "checker", "warden", q.id, "rook");
    const base = planInput(q.id);
    const plan = f.k.plan("lead", base);
    f.k.answerAsk(f.k.asks("lead").find((ask) => ask.kind === "greenlight")!.id, "approve", null, "page", "user");
    f.port.linkedEntries = () => [
      journalEntrySchema.parse({
        threadId: "maker",
        id: "a1",
        description: "Done",
        owner: "maker",
        status: "verified",
        parentId: null,
        note: null,
        evidence: [
          { kind: "command", ref: "npm test", detail: "Passed", exitCode: 0 },
        ],
        order: 0,
        createdAt: f.time(),
        createdBy: { kind: "tavern" },
        link: { boardQuestId: q.id, waypointId: "w1" },
        updatedBy: { kind: "agent", threadId: "checker" },
        updatedAt: f.time(),
      }),
    ];
    await concludeQuest(f.runtime, "lead", q.id, "Verified result", "");
    expect(f.k.member("maker")?.verifiedWins).toBe(1);
    expect(f.k.member("checker")?.verifiedWins).toBe(0);
  });
  it("journal asks, a sent tick and a held tick through the plugin logger", async () => {
    const f = setup();
    f.bb.log.info = vi.fn();
    f.bb.log.warn = vi.fn();
    await seedQuest(f.k,"lead", "A", "A");
    f.k.ask("lead", { effect: {type:"decision"},
      kind: "decision",
      question: "Pick",
      why: "Choice",
      options: [
        { id: "a", label: "A", detail: "", recommended: true },
        { id: "b", label: "B", detail: "", recommended: false },
      ],
      meanwhile: "Wait",
      holds: [],
    });
    f.k.store.patch("lead", { userAt: null });
    f.k.reanchor("lead", "test logging");
    await f.runtime.tick("lead");
    await f.runtime.tick("lead");
    const lines = vi.mocked(f.bb.log.info).mock.calls.flat().join(" ");
    expect(lines).toContain("ask.opened");
    expect(lines).toContain("tick.sent");
    expect(lines).toContain("tick.held");
  });
  it("states the Ranger time-box limit in the hire error", async () => {
    const f = setup();
    await expect(
      f.runtime.hire("lead", "project", {
        classId: "ranger",
        title: "Scout",
        errand: true,
        brief: { ...brief, timeboxMinutes: 15 },
      }),
    ).rejects.toThrow("settings ceiling of 12 minutes");
  });
});
