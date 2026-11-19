// @vitest-environment node
import { concludeQuest } from "./support";
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { fakePort, planInput } from "./support";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makeThreadResponse, makePluginAgentConfigurationContext } from "./host";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { TavernRuntime } from "../../src/server/runtime";
import { Keeper } from "../../src/server/keeper/service";
import { journalEntrySchema } from "../../src/shared/schema";

const brief = {
  outcome: "Build",
  mode: "make-it-work" as const,
  outOfScope: "Production",
  doneWhen: "Tests pass",
  context: [],
  questions: [],
  timeboxMinutes: null,
};
const ask = {
  kind: "decision" as const,
  question: "Which fixture?",
  why: "A small choice",
  options: [{ id: "small", label: "Small", detail: "", recommended: true }],
  meanwhile: "Read",
  holds: [],
};
async function approved() {
  const f = setup(),
    q = await seedQuest(f.k,"lead", "A", "A");
  f.k.plan("lead", {
    ...planInput(q.id),
    party: [
      { classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] },
    ],
  });
  f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
  return {
    ...f,
    q,
    input: { classId: "smith", boardQuestId: q.id, waypointId: "w1", title: "Build", brief },
  };
}

describe("round 2 reservations and routing", () => {
  it("H-1 releases a rejected 4xx spawn and rolls back the party slot", async () => {
    const f = await approved();
    f.bb.sdk.threads.spawn = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 400: invalid model"))
      .mockResolvedValueOnce(makeThreadResponse({ id: "replacement", parentThreadId: "lead" }));
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("HTTP 400");
    expect(f.k.store.all("hires")).toHaveLength(0);
    await expect(f.runtime.hire("lead", "project", f.input)).resolves.toMatchObject({
      threadId: "replacement",
    });
    expect(f.k.store.get("staffing", `${f.q.id}:1:smith`)?.slots[0]?.uses).toBe(1);
  });
  it("H-1 keeps uncertain reservations until five minutes and releases them after a complete child scan", async () => {
    const f = await approved();
    f.bb.sdk.threads.spawn = async () => {
      throw new Error("connection lost");
    };
    const list = vi.fn(async () => []);
    f.bb.sdk.threads.list = list;
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("connection lost");
    f.advance(299_999);
    await f.runtime.sweep();
    expect(f.k.store.all("hires")).toHaveLength(1);
    expect(list).not.toHaveBeenCalled();
    f.advance(1);
    await f.runtime.sweep();
    expect(list).toHaveBeenCalled();
    expect(f.k.store.all("hires")).toHaveLength(0);
    expect(f.k.store.get("staffing", `${f.q.id}:1:smith`)?.slots[0]?.uses).toBe(0);
  });
  it("H-1 reconciles a real child instead of freeing its reservation on reload", async () => {
    const f = await approved();
    f.bb.sdk.threads.spawn = async () => {
      throw new Error("response lost");
    };
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow();
    const intent = f.k.store.all("hires")[0]!;
    const token = f.k.store.db
      .prepare("SELECT id FROM tavern_records WHERE kind='hires'")
      .get() as { id: string };
    const child = makeThreadResponse({
      id: "existing",
      parentThreadId: "lead",
      createdAt: intent.createdAt + 1,
      originPluginId: "tavern",
    });
    f.bb.sdk.threads.list = vi.fn().mockResolvedValue([child]);
    f.bb.sdk.threads.getPluginMetadata = async () => ({ hireToken: token.id });
    f.advance(300_000);
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.reconcile();
    expect(f.k.member("existing")?.boardQuestId).toBe(f.q.id);
    expect(f.k.store.all("hires")).toHaveLength(0);
    expect(f.k.store.runtime("existing").briefVersion).toBe(1);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    await expect(restarted.hire("lead", "project", f.input)).rejects.toThrow(/greenlit party/);
  });
  it("H-1 clears a legacy unbound reservation on load through the sweep, without changing the live database by hand", async () => {
    const f = setup();
    f.k.store.put("hires", "legacy-token", {
      classId: "ranger",
      characterId: "otto",
      projectId: "project",
      createdAt: f.time() - 300_001,
      owner: {
        keeperThreadId: "lead",
        boardQuestId: null,
        waypointId: null,
        errand: true,
        title: "Read",
        brief,
      },
    });
    f.bb.sdk.threads.list = vi.fn().mockResolvedValue([]);
    await new TavernRuntime(f.bb, f.k, f.runtime.registry).reconcile();
    expect(f.k.store.all("hires")).toHaveLength(0);
    expect(f.k.store.events("lead").some((event) => event.type === "hire.expired")).toBe(true);
  });
  it("H-1 keeps the reservation if the child scan itself fails", async () => {
    const f = await approved();
    f.bb.sdk.threads.spawn = async () => {
      throw new Error("response lost");
    };
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow();
    f.bb.sdk.threads.list = async () => {
      throw new Error("host unavailable");
    };
    f.advance(300_000);
    await f.runtime.sweep();
    expect(f.k.store.all("hires")).toHaveLength(1);
  });
  it.each([false, true])(
    "M-1 applies the first steer with a later message queued or joined (%s)",
    async (joined) => {
      const f = await approved();
      await f.runtime.dispatch(dispatch049({ text: "A: stage first" }));
      await f.runtime.dispatch({
        ...dispatch049({ text: "What is the ETA?", status: "active" }),
        ...(joined ? { attempt: "join-turn" as const } : {}),
      });
      const route = f.k.route("lead", {
        kind: "steer",
        boardQuestId: f.q.id,
        summary: "stage first",
      });
      expect(() => f.k.plan("lead", { ...planInput(f.q.id), fromSteer: route.id })).not.toThrow();
      f.k.route("lead", { kind: "question", summary: "eta" });
      expect(() => f.k.plan("lead", { ...planInput(f.q.id), fromSteer: route.id })).not.toThrow();
      const other = await f.k.openQuest("lead", "B", "B").catch(() => null);
      if (other) expect(() => f.k.plan("lead", planInput(other.id))).toThrow(/route/);
      f.k.endTurn("lead");
      expect(() => f.k.plan("lead", { ...planInput(f.q.id), fromSteer: route.id })).toThrow(
        /applicable|expired/,
      );
    },
  );
  it("M-1 preserves a queued steer until its following turn, not the preceding turn, ends", async () => {
    const f = await approved();
    f.k.receiveUser("lead", "A: stage first", null, "row", f.time(), false);
    const route = f.k.route("lead", {
      kind: "steer",
      boardQuestId: f.q.id,
      summary: "stage first",
    });
    f.k.endTurn("lead");
    expect(() => f.k.plan("lead", { ...planInput(f.q.id), fromSteer: route.id })).not.toThrow();
    f.k.receiveUser("lead", "A: stage first", null, "row", f.time(), true);
    f.k.endTurn("lead");
    expect(() => f.k.plan("lead", { ...planInput(f.q.id), fromSteer: route.id })).toThrow(
      /applicable|expired/,
    );
  });
});

function linked(threadId: string, boardQuestId: string, status: string) {
  return journalEntrySchema.parse({
    threadId,
    id: "a1",
    parentId: null,
    description: "Build",
    status,
    owner: threadId,
    note: null,
    evidence: [{ kind: "command", ref: "test", detail: "ok", exitCode: 0 }],
    review:
      status === "verified"
        ? {
            actor: { kind: "agent", threadId: "checker" },
            at: 1_000_000,
            evidence: [],
            reason: null,
          }
        : null,
    link: { boardQuestId, waypointId: "w1" },
    order: 0,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    createdBy: { kind: "tavern" },
    updatedBy: { kind: "tavern" },
  });
}

describe("round 2 release, ask and scout policies", () => {
  it.each(["todo", "doing", "blocked", "rejected", "done"])(
    "M-2 excludes released %s work and its owner without deleting its history",
    async (status) => {
      const f = await approved();
      f.bb.sdk.threads.stop = async () => ({ ok: true });
      const previous = await f.runtime.hire("lead", "project", f.input);
      await f.runtime.release("lead", previous.threadId, "Replace stalled work");
      const replacement = await f.runtime.hire("lead", "project", f.input);
      const rows = [
        linked(previous.threadId, f.q.id, status),
        linked(replacement.threadId, f.q.id, "verified"),
      ];
      const get = f.port.get;
      f.port.get = (threadId) => ({
        ...get(threadId),
        entries: rows.filter((entry) => entry.threadId === threadId),
      });
      f.port.linkedEntries = () => rows;
      const waypoint = f.k.summary(f.q.id).waypoints[0]!;
      expect(waypoint).toMatchObject({ state: "verified", evidenceCount: 1 });
      expect(waypoint.ownerMember?.threadId).toBe(replacement.threadId);
      expect(f.port.get(previous.threadId).entries[0]?.status).toBe(status);
    },
  );
  it("M-2 keeps released members' verified work credited", async () => {
    const f = await approved();
    f.bb.sdk.threads.stop = async () => ({ ok: true });
    const member = await f.runtime.hire("lead", "project", f.input);
    await f.runtime.release("lead", member.threadId, "Retire after verified work");
    const proof = linked(member.threadId, f.q.id, "verified");
    f.port.linkedEntries = () => [proof];
    const waypoint = f.k.summary(f.q.id).waypoints[0]!;
    expect(waypoint).toMatchObject({ state: "verified", evidenceCount: 1, verifiedBy: "checker" });
    expect(waypoint.ownerMember?.threadId).toBe(member.threadId);
    expect(f.port.linkedEntries(f.q.id)).toEqual([proof]);
  });
  it("M-2 releases a stale member, records a reversible decision and permits its bounded replacement", async () => {
    const f = await approved();
    registerTools(f.bb, f.runtime);
    f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
    const member = await f.runtime.hire("lead", "project", f.input);
    f.advance(21 * 60_000);
    f.k.stale();
    f.advance(21 * 60_000);
    f.k.stale();
    expect(f.k.member(member.threadId)?.strikes).toBe(2);
    expect(f.k.store.events("lead").at(-1)?.text).toContain("tavern_release");
    const result = await f.harness.behavior.invokeAgentTool(
      "tavern_release",
      {
        memberThreadId: member.threadId,
        reason: "No progress after two strikes",
      },
      { threadId: "lead" },
    );
    expect(result).toContain("Released");
    expect(f.bb.sdk.threads.stop).toHaveBeenCalledWith({ threadId: member.threadId });
    expect(f.k.member(member.threadId)).toMatchObject({ state: "stopped", place: "rest" });
    expect(
      f.k.store
        .query("decisions", "keeperThreadId", "lead")
        .some((d) => d.reversible && d.source === "keeper" && /Release/.test(d.text)),
    ).toBe(true);
    await expect(f.runtime.hire("lead", "project", f.input)).resolves.toBeTruthy();
    f.runtime.updateThread(makeThreadResponse({ id: member.threadId, status: "idle" }));
    expect(f.k.member(member.threadId)?.state).toBe("stopped");
  });
  it("M-2 keeps the slot until stopping is confirmed, then completes release in the sweep", async () => {
    const f = await approved();
    const member = await f.runtime.hire("lead", "project", f.input);
    f.bb.sdk.threads.stop = async () => ({ ok: true });
    f.bb.sdk.threads.get = vi
      .fn()
      .mockResolvedValueOnce(makeThreadResponse({ id: member.threadId, status: "active" }))
      .mockResolvedValueOnce(makeThreadResponse({ id: member.threadId, status: "stopping" }))
      .mockResolvedValue(makeThreadResponse({ id: member.threadId, status: "idle" }));
    expect(await f.runtime.release("lead", member.threadId, "Stalled")).toBe(false);
    expect(f.k.store.allocated(f.q.id, "smith")).toBe(1);
    await f.runtime.sweep();
    expect(f.k.store.allocated(f.q.id, "smith")).toBe(0);
    f.runtime.updateThread(makeThreadResponse({ id: member.threadId, status: "active" }));
    expect(f.k.store.allocated(f.q.id, "smith")).toBe(0);
  });
  it("L-a requires an explicit reversible declaration for a timed decision, including after reload", () => {
    const f = setup();
    expect(() => f.k.ask("lead", { effect: {type:"decision"}, ...ask, proceedInMinutes: 1 })).toThrow(/reversible/);
    expect(() => f.k.ask("lead", { effect: {type:"decision"}, ...ask, reversible: false, proceedInMinutes: 1 })).toThrow(
      /reversible/,
    );
    const created = f.k.ask("lead", { effect: {type:"decision"}, ...ask, reversible: true, proceedInMinutes: 1 });
    f.advance(60_000);
    new Keeper(f.k.store, f.port, f.time).defaults();
    expect(f.k.store.get("asks", created.id)?.state).toBe("defaulted");
  });
  it.each(["ranger", "wanderer"])(
    "L-b scouts a greenlit quest with %s without expanding the party",
    async (classId) => {
      const f = await approved();
      await expect(
        f.runtime.hire("lead", "project", {
          classId,
          boardQuestId: f.q.id,
          title: "Read",
          brief: { ...brief, questions: ["1. Why?"], timeboxMinutes: 5 },
        }),
      ).resolves.toMatchObject({ classId });
      expect(f.k.asks("lead").filter((a) => a.state === "open")).toHaveLength(0);
      expect(
        f.k.store
          .query("decisions", "keeperThreadId", "lead")
          .some((d) => d.reversible && /scout/i.test(d.text)),
      ).toBe(true);
    },
  );
  it("L-c keeps an old open ask in the room after more than 200 newer closed asks", async () => {
    const f = setup();
    registerRpc(f.bb, f.runtime);
    const old = f.k.ask("lead", { ...ask, effect: { type: "decision" } });
    for (let n = 0; n < 205; n++) {
      const recent = f.k.ask("lead", { effect: {type:"decision"}, ...ask, question: `Ask ${n}` });
      f.k.answerAsk(recent.id, "small", null, "page", "user");
    }
    const room = (await f.harness.invokeRpc("room", {})) as { asks: { id: string }[] };
    expect(room.asks.map((a) => a.id)).toContain(old.id);
  });
});

describe("round 2 delivery and cleanup", () => {
  it("L-d compacts final tick text while retaining its dedupe receipt", async () => {
    const f = setup();
    f.k.reanchor("lead", "wake");
    await f.runtime.tick("lead");
    const row = f.k.store.db
      .prepare("SELECT id,data FROM tavern_outbox WHERE state='delivered'")
      .get() as { id: string; data: string };
    expect(JSON.parse(row.data).text).toBe("");
    const text = `[Tavern tick] id=${row.id}\nFacts`;
    expect((await f.runtime.dispatch(dispatch049({ text, pluginId: "tavern" }))).action).toBe(
      "reject",
    );
  });
  it("L-e commits wrapping before partial archive failure and retries cleanup", async () => {
    const f = await approved();
    const member = await f.runtime.hire("lead", "project", f.input);
    f.port.linkedEntries = () => [
      {
        ...fakePort().get(member.threadId).entries[0],
        threadId: member.threadId,
        id: "a1",
        parentId: null,
        description: "Build",
        status: "verified",
        evidence: [{ kind: "command", ref: "test", detail: "ok", exitCode: 0 }],
        link: { boardQuestId: f.q.id, waypointId: "w1" },
        owner: member.threadId,
        note: null,
        order: 0,
        createdAt: f.time(),
        updatedAt: f.time(),
        createdBy: { kind: "tavern" },
        updatedBy: { kind: "tavern" },
      },
    ];
    f.bb.sdk.threads.archive = vi
      .fn()
      .mockRejectedValueOnce(new Error("archive unavailable"))
      .mockResolvedValue({ ok: true });
    await concludeQuest(f.runtime, "lead", f.q.id, "Done", "");
    expect(f.k.quest(f.q.id).phase).toBe("done");
    expect(f.k.member(member.threadId)?.state).toBe("done");
    await f.runtime.sweep();
    expect(f.bb.sdk.threads.archive).toHaveBeenCalledTimes(2);
  });
  it("L-f keeps quests and asks ahead of many standing rules and marks any cap", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "Important board", "Board");
    f.k.ask("lead", { effect: {type:"decision"}, ...ask, boardQuestId: q.id, question: "Important open ask?" });
    for (let n = 0; n < 100; n++)
      f.k.addRule({
        scope: "keeper",
        scopeId: "lead",
        text: `${n} ${"rule ".repeat(98)}`,
        source: "user",
      });
    const config = f.runtime.configure(
      makePluginAgentConfigurationContext({ thread: { id: "lead" } }),
    );
    expect(config.instructions).toContain("Important board");
    expect(config.instructions).toContain("Important open ask?");
    expect(config.instructions).toMatch(/truncat|shorten|tavern_status/i);
  });
  it("L-g retires a failed queued tick and can deliver its undelivered facts again", async () => {
    const f = setup();
    f.bb.sdk.threads.send = vi
      .fn()
      .mockResolvedValueOnce({ delivery: "queued" })
      .mockResolvedValue({ delivery: "sent" });
    f.k.reanchor("lead", "wake");
    await f.runtime.tick("lead");
    const batch = f.k.store.pendingTick("lead")!;
    const failed = {
      ...queued049("failed", batch.text, f.time(), { pluginId: "tavern" }),
      failureReason: "dispatch failed",
    };
    f.bb.sdk.threads.queuedMessages.list = vi
      .fn()
      .mockResolvedValueOnce([failed])
      .mockResolvedValue([]);
    f.bb.sdk.threads.queuedMessages.delete = vi.fn(async () => ({ ok: true as const }));
    f.advance(60_000);
    await f.runtime.tick("lead");
    await f.runtime.tick("lead");
    expect(f.bb.sdk.threads.queuedMessages.delete).toHaveBeenCalled();
    expect(f.bb.sdk.threads.send).toHaveBeenCalledTimes(2);
  });
  it("L-h expires input after a retained root turn resumes its main run and then completes", async () => {
    const f = setup();
    const start = f.time();
    const events = [
      {
        seq: 1,
        createdAt: start + 1,
        type: "turn/started",
        scope: { kind: "turn", turnId: "root" },
        data: {},
      },
      {
        seq: 2,
        createdAt: start + 2,
        type: "turn/mainRun/updated",
        scope: { kind: "turn", turnId: "root" },
        data: { state: "idle" },
      },
    ];
    f.bb.sdk.threads.events.list = vi
      .fn()
      .mockImplementation(async ({ afterSeq }) =>
        events.filter((event) => event.seq > Number(afterSeq ?? 0)),
      );
    f.k.receiveUser("lead", "First message");
    await f.runtime.observe(makeThreadResponse({ id: "lead" }), 2);
    f.advance(10);
    await f.runtime.dispatch(dispatch049({ text: "Resume the main run" }));
    events.push({
      seq: 3,
      createdAt: start + 11,
      type: "turn/mainRun/updated",
      scope: { kind: "turn", turnId: "root" },
      data: { state: "running" },
    });
    events.push({
      seq: 4,
      createdAt: start + 12,
      type: "turn/completed",
      scope: { kind: "turn", turnId: "root" },
      data: {},
    });
    await f.runtime.observe(makeThreadResponse({ id: "lead" }), 4);
    expect(f.k.store.runtime("lead").pending).toHaveLength(0);
    expect(f.k.store.events("lead").filter((event) => event.type === "route.missed")).toHaveLength(
      2,
    );
  });
  it("L-h protects newly accepted input when an old boundary is observed late after a host read fails", async () => {
    const f = setup();
    f.k.receiveUser("lead", "First message");
    const start = f.time();
    f.advance(2000);
    const events = [
      {
        seq: 1,
        createdAt: start + 1,
        type: "turn/started",
        scope: { kind: "turn", turnId: "old" },
        data: {},
      },
      {
        seq: 2,
        createdAt: start + 100,
        type: "turn/mainRun/updated",
        scope: { kind: "turn", turnId: "old" },
        data: { state: "idle" },
      },
      {
        seq: 3,
        createdAt: start + 200,
        type: "turn/completed",
        scope: { kind: "turn", turnId: "old" },
        data: {},
      },
    ];
    f.bb.sdk.threads.events.list = vi
      .fn()
      .mockRejectedValueOnce(new Error("host unavailable"))
      .mockResolvedValue(events);
    await f.runtime.dispatch(dispatch049({ text: "New queued steer" }));
    await f.runtime.observe(makeThreadResponse({ id: "lead" }), 3);
    expect(f.k.store.runtime("lead").pending.map((p) => p.text)).toEqual(["New queued steer"]);
  });
  it("L-h does not expire a new message drained after main-run idle when the old background turn completes", async () => {
    const f = setup();
    const events = [
      {
        seq: 1,
        type: "turn/started",
        scope: { kind: "turn", turnId: "old" },
        data: { state: "active" },
      },
      {
        seq: 2,
        type: "turn/mainRun/updated",
        scope: { kind: "turn", turnId: "old" },
        data: { state: "idle" },
      },
    ];
    f.bb.sdk.threads.events.list = vi
      .fn()
      .mockImplementation(async ({ afterSeq }) =>
        events.filter((e) => e.seq > Number(afterSeq ?? 0)),
      );
    f.k.receiveUser("lead", "First message");
    await f.runtime.dispatch(
      dispatch049({ rows: [queued049("new-row", "New queued steer", f.time())] }),
    );
    events.push({
      seq: 3,
      type: "turn/completed",
      scope: { kind: "turn", turnId: "old" },
      data: { state: "idle" },
    });
    f.runtime.updateThread(makeThreadResponse({ id: "lead", status: "active" }));
    f.runtime.updateThread(makeThreadResponse({ id: "lead", status: "idle" }));
    await f.runtime.observe(makeThreadResponse({ id: "lead" }), 3);
    expect(f.k.store.runtime("lead").pending.map((p) => p.text)).toEqual(["New queued steer"]);
    expect(f.k.store.events("lead").filter((e) => e.type === "route.missed")).toHaveLength(1);
  });
});
