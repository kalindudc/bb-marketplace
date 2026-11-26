// @vitest-environment node
import { concludeQuest } from "./support";
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { dispatch049, queued049 } from "./dispatch-fixture";
import {
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "./host";
import { planInput } from "./support";
import { journalEntrySchema, ASK_KINDS } from "../../src/shared/schema";
import { TavernRuntime } from "../../src/server/runtime";
import { utf8Limit } from "../../src/server/instructions";
import { registerTools } from "../../src/server/tools";
import { rpcHandlers } from "../../src/server/rpc";

const brief = {
  outcome: "Build",
  mode: "make-it-work" as const,
  outOfScope: "Deploy",
  doneWhen: "Tests",
  context: [],
  questions: [],
  timeboxMinutes: null,
};
const report = {
  status: "done" as const,
  outcome: "Read results",
  evidence: [],
  artifacts: [],
  confidence: null,
  voice: null,
};
const askInput = {
  reversible: true,
  kind: "decision" as const,
  question: "Small fixture?",
  why: "Reversible",
  options: [{ id: "yes", label: "Yes", detail: "Small", recommended: true }],
  meanwhile: "Scout",
  holds: [],
};
const slot = (classId: string) => ({
  classId,
  characterId: null,
  model: null,
  purpose: "Work",
  waypointIds: ["w1"],
});
function bind(
  k: ReturnType<typeof setup>["k"],
  id = "child",
  q: string | null = null,
  waypointId: string | null = null,
  classId = "smith",
) {
  return k.bind(id, classId, "juno", "project", {
    keeperThreadId: "lead",
    boardQuestId: q,
    waypointId,
    title: "Work",
    errand: q === null,
    brief,
  });
}
function sent(harness: ReturnType<typeof setup>["harness"]) {
  return harness.inspection.sdk
    .callsTo("threads.send")
    .map((call) => JSON.stringify(call));
}
function approve(k: ReturnType<typeof setup>["k"]) {
  const ask = k
    .asks("lead")
    .find((a) => a.state === "open" && a.kind === "greenlight")!;
  k.answerAsk(ask.id, "approve", null, "page", "user");
}
function linked(
  threadId: string,
  boardQuestId: string,
  status: "doing" | "done" | "verified" | "rejected",
  evidence = false,
) {
  return journalEntrySchema.parse({
    id: "a1",
    threadId,
    description: "Build",
    parentId: null,
    status,
    evidence: evidence
      ? [{ kind: "command", ref: "npm test", exitCode: 0, detail: "pass" }]
      : [],
    link: { boardQuestId, waypointId: "w1" },
    owner: threadId,
    note: status === "rejected" ? "Tests missing" : null,
    order: 0,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    createdBy: { kind: "tavern" },
    updatedBy: { kind: "agent", threadId: "checker" },
  });
}

describe("tick delivery regressions", () => {
  it("H2 delivers despite unrouted messages and releases a typing hold", async () => {
    const { k, runtime, harness, advance, time } = setup();
    bind(k);
    k.receiveUser("lead", "thanks");
    k.report("child", report);
    k.store.patch("lead", { typingAt: time() });
    await runtime.tick("lead");
    expect(sent(harness)).toHaveLength(0);
    advance(61_000);
    await runtime.tick("lead");
    expect(sent(harness)).toHaveLength(1);
    expect(sent(harness)[0]).toContain("Not yet routed:");
    expect(sent(harness)[0]).toContain("Held 61 s");
  });
  it("H4 preserves typed answers and defaults ahead of more than 1000 churn events", async () => {
    const { k, runtime, harness, advance } = setup();
    const answer = k.ask("lead", { ...askInput, effect: { type: "decision" } });
    k.answerAsk(answer.id, "yes", "User chose the fixture", "page", "user");
    const timer = k.ask("lead", { effect: {type:"decision"},
      ...askInput,
      question: "Default fixture?",
      proceedInMinutes: 1,
    });
    advance(60_000);
    k.defaults();
    for (let i = 0; i < 1100; i++)
      k.store.event(k.now(), "lead", null, "journal.changed", "churn");
    await runtime.tick("lead");
    expect(sent(harness)[0]).toContain("User chose the fixture");
    expect(sent(harness)[0]).toContain("Default fixture?");
    expect(sent(harness)[0]).toContain("default");
    expect(k.store.get("asks", timer.id)?.state).toBe("defaulted");
    expect(k.store.runtime("lead").cursor).toBeLessThan(
      k.store.events("lead").at(-1)!.id,
    );
  });
  it("H4 marks only included outcomes, leaving overflow reports for the next tick", async () => {
    const { k, runtime, harness, advance } = setup();
    bind(k);
    const reports = Array.from({ length: 5 }, (_, i) =>
      k.report("child", { ...report, outcome: `${i}:` + "x".repeat(3990) }),
    );
    await runtime.tick("lead");
    const delivered = reports.filter(
      (r) => k.store.get("reports", r.id)?.deliveredAt !== null,
    );
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThan(5);
    for (const r of delivered) expect(sent(harness)[0]).toContain(r.outcome);
    expect(sent(harness)[0]).toContain("more; call tavern_status");
    advance(61_000);
    await runtime.tick("lead");
    expect(
      reports.every((r) => k.store.get("reports", r.id)?.deliveredAt !== null),
    ).toBe(true);
  });
  it("H4 splits an oversized escaped outcome without marking it until its final part", async () => {
    const { k, runtime, advance } = setup();
    bind(k);
    await runtime.tick("lead");
    advance(61_000);
    const r = k.report("child", { ...report, outcome: "\u0000".repeat(4000) });
    await runtime.tick("lead");
    expect(k.store.get("reports", r.id)?.deliveredAt).toBeNull();
    expect(k.store.runtime("lead").factContinuation).toBeTruthy();
    advance(61_000);
    await runtime.tick("lead");
    expect(k.store.get("reports", r.id)?.deliveredAt).not.toBeNull();
  });
  it("M2 isolates missing Keepers and broken defaults while the next Keeper ticks", async () => {
    const { k, runtime, harness, advance } = setup();
    k.bind("next", "keeper", "wren", "project");
    k.reanchor("lead", "failed");
    k.reanchor("next", "failed");
    const bad = k.ask("lead", { effect: {type:"decision"}, ...askInput, proceedInMinutes: 1 });
    k.store.put("asks", bad.id, { ...bad, options: [] });
    advance(61_000);
    runtime.bb.sdk.threads.get = async ({ threadId }) => {
      if (threadId === "lead") throw new Error("thread not found");
      return makeThreadResponse({ id: threadId });
    };
    await expect(runtime.sweep()).resolves.toBeUndefined();
    expect(k.store.runtime("lead")).toMatchObject({ deletedAt: expect.any(Number), archivedAt: expect.any(Number) });
    expect(sent(harness)).toHaveLength(1);
    expect(sent(harness)[0]).toContain("next");
  });
  it("M3 sends a failed Keeper its re-anchor", async () => {
    const { runtime, k, harness } = setup();
    k.reanchor("lead", "failed turn");
    runtime.bb.sdk.threads.get = async () =>
      makeThreadResponse({ id: "lead", status: "error" });
    await runtime.tick("lead");
    expect(sent(harness)[0]).toContain("Re-anchor after");
  });
  it.each(["journal.changed", "questlog.changed"])(
    "M4 ignores the Keeper's own work, %s churn and an idle reload",
    async (eventType) => {
      const { k, runtime, harness } = setup();
      const q = await seedQuest(k,"lead", "A", "A");
      k.plan("lead", planInput(q.id));
      k.decide("lead", {
        text: "Use fixture",
        why: "Small",
        reversible: true,
        source: "keeper",
      });
      k.addRule({
        scope: "keeper",
        scopeId: "lead",
        text: "Small changes",
        source: "keeper-proposed",
      });
      k.store.event(k.now(), "lead", q.id, eventType, "edited");
      await runtime.reconcile();
      await runtime.tick("lead");
      expect(sent(harness)).toHaveLength(0);
      expect(k.store.runtime("lead").cursor).toBeGreaterThan(0);
      const restarted = new TavernRuntime(runtime.bb, k, runtime.registry);
      await restarted.reconcile();
      await restarted.tick("lead");
      expect(sent(harness)).toHaveLength(0);
    },
  );
  it("L4 cancels queued delivery without advancing the cursor, and deduplicates delivered ids", async () => {
    const { k, runtime, harness, advance } = setup();
    bind(k);
    const r = k.report("child", report);
    runtime.bb.sdk.threads.send = async () =>
      ({ delivery: "queued" }) as Awaited<
        ReturnType<typeof runtime.bb.sdk.threads.send>
      >;
    await runtime.tick("lead");
    const pending = k.store.pendingTick("lead")!;
    expect(k.store.get("reports", r.id)?.deliveredAt).toBeNull();
    expect(k.store.runtime("lead").cursor).toBe(0);
    runtime.cancelTick(pending.text);
    runtime.bb.sdk.threads.send = async () =>
      ({ delivery: "sent" }) as Awaited<
        ReturnType<typeof runtime.bb.sdk.threads.send>
      >;
    advance(61_000);
    await runtime.tick("lead");
    expect(k.store.pendingTick("lead")).toBeNull();
    const delivered = k.store.db
      .prepare("SELECT data FROM tavern_outbox WHERE state='delivered'")
      .get() as { data: string };
    const batch = JSON.parse(delivered.data);
    expect(batch.text).toBe("");
    expect(
      (
        await runtime.dispatch(
          dispatch049({
            pluginId: "tavern",
            text: `[Tavern tick] id=${batch.id}\nFacts`,
          }),
        )
      ).action,
    ).toBe("reject");
  });
  it("L4 reconciles uncertain delivery from its accepted-input history without a repeat", async () => {
    const { k, runtime, harness } = setup();
    k.reanchor("lead", "failed");
    runtime.bb.sdk.threads.send = async () => {
      throw new Error("connection closed after send");
    };
    await runtime.tick("lead");
    const attempts = sent(harness).length;
    expect(attempts).toBe(1);
    const pending = k.store.pendingTick("lead")!;
    runtime.bb.sdk.threads.events.list = async () =>
      [{ data: { text: pending.text } }] as Awaited<
        ReturnType<typeof runtime.bb.sdk.threads.events.list>
      >;
    const restarted = new TavernRuntime(runtime.bb, k, runtime.registry);
    await restarted.reconcile();
    await restarted.tick("lead");
    expect(k.store.tick(pending.id)?.state).toBe("delivered");
    expect(sent(harness)).toHaveLength(attempts);
  });
});

describe("staffing and policy regressions", () => {
  it("a report delivers news even if journal work is missing or open", async () => {
    const { k, port } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    bind(k, "child", q.id, "w1");
    expect(k.report("child", { ...report, status: "done" }).status).toBe("done");
    const original = port.get;
    port.get = (id) => ({
      ...original(id),
      entries: [linked(id, q.id, "doing")],
    });
    expect(k.report("child", { ...report, status: "done", outcome: "Update with work open" }).status).toBe("done");
    expect(port.get("child").entries[0]?.status).toBe("doing");
    port.get = (id) => ({
      ...original(id),
      entries: [linked(id, q.id, "verified", true)],
    });
    expect(k.report("child", { ...report, status: "done" }).status).toBe(
      "done",
    );
  });
  it("M6 hires a checker without linking or holding its waypoint, and shows rejection", async () => {
    const { k, runtime, port } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    bind(k, "maker", q.id, "w1");
    const owner = linked("maker", q.id, "done", true);
    const original = port.get;
    port.get = id => ({ ...original(id), entries: id === "maker" ? [owner] : [] });
    port.linkedEntries = () => [owner];
    k.plan("lead", { ...planInput(q.id), party: [slot("warden")] });
    approve(k);
    port.linkWaypoint = vi.fn(() => "a1");
    const member = await runtime.hire("lead", "project", {
      classId: "warden",
      boardQuestId: q.id,
      waypointId: "w1",
      title: "Check",
      brief,
    });
    expect(member.checkerWaypointId).toBe("w1");
    expect(port.linkWaypoint).not.toHaveBeenCalled();
    const checker = linked(member.threadId, q.id, "doing");
    port.linkedEntries = () => [owner, checker];
    expect(k.summary(q.id).waypoints[0]?.state).toBe("reported");
    owner.status = "rejected";
    owner.note = "Missing test";
    expect(k.summary(q.id).waypoints[0]).toMatchObject({
      state: "rejected",
      rejectedReason: "Missing test",
    });
  });
  it("M8 only decision asks can default", () => {
    const { k } = setup();
    for (const kind of ASK_KINDS.filter((kind) => kind !== "decision")) {
      expect(() =>
        k.ask("lead", { effect: {type:"decision"}, ...askInput, kind, proceedInMinutes: 1 }),
      ).toThrow(/Only decision/);
    }
    expect(
      k.ask("lead", { effect: {type:"decision"}, ...askInput, proceedInMinutes: 1 }).proceedAt,
    ).not.toBeNull();
  });
  it("M9 allows a same-party re-plan as a reversible decision but gates expansion", async () => {
    const { k, runtime, port } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    const plan = { ...planInput(q.id), party: [slot("smith")] };
    k.plan("lead", plan);
    approve(k);
    k.plan("lead", { ...plan, changeNote: "Smaller fixture" });
    expect(k.asks("lead").filter((a) => a.state === "open")).toHaveLength(0);
    expect(
      k.store.query("decisions", "keeperThreadId", "lead").at(-1),
    ).toMatchObject({
      source: "keeper",
      reversible: true,
    });
    const maker = await runtime.hire("lead", "project", {
      classId: "smith",
      boardQuestId: q.id,
      waypointId: "w1",
      title: "Build",
      brief,
    });
    const entry = linked(maker.threadId, q.id, "done", true);
    const original = port.get;
    port.get = id => ({ ...original(id), entries: id === maker.threadId ? [entry] : [] });
    port.linkedEntries = () => [entry];
    k.plan("lead", { ...plan, party: [slot("smith"), slot("warden")] });
    expect(k.asks("lead").filter((a) => a.state === "open")).toHaveLength(1);
    await expect(
      runtime.hire("lead", "project", {
        classId: "warden",
        boardQuestId: q.id,
        waypointId: "w1",
        title: "Check",
        brief,
      }),
    ).rejects.toThrow(/greenlit party/);
    await expect(
      runtime.hire("lead", "project", {
        classId: "smith",
        boardQuestId: q.id,
        title: "Extra",
        brief,
      }),
    ).rejects.toThrow(/greenlit party/);
    approve(k);
    await expect(
      runtime.hire("lead", "project", {
        classId: "warden",
        boardQuestId: q.id,
        waypointId: "w1",
        title: "Check",
        brief,
      }),
    ).resolves.toBeTruthy();
  });
  it("L3 preserves reservations across reloads and counts concurrent waypoint hires", async () => {
    const { k, runtime } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    k.plan("lead", {
      ...planInput(q.id),
      party: [slot("smith"), slot("smith")],
    });
    approve(k);
    let release!: () => void;
    runtime.bb.sdk.threads.spawn = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return makeThreadResponse({ id: "kid", parentThreadId: "lead" });
    };
    const input = {
      classId: "smith",
      boardQuestId: q.id,
      waypointId: "w1",
      title: "Build",
      brief,
    };
    const first = runtime.hire("lead", "project", input);
    await vi.waitFor(() => expect(k.store.all("hires")).toHaveLength(1));
    const intent = k.store.all("hires")[0]!;
    expect(intent).toBeTruthy();
    const restarted = new TavernRuntime(runtime.bb, k, runtime.registry);
    await expect(restarted.hire("lead", "project", input)).rejects.toThrow(
      /already/,
    );
    const row = k.store.db
      .prepare("SELECT id FROM tavern_records WHERE kind='hires'")
      .get() as {
      id: string;
    };
    const ctx = dispatch049({
      threadId: "kid",
      pluginId: "tavern",
      text: "Your brief",
      submission: { pluginId: "tavern", data: { hireToken: row.id } },
    });
    ctx.thread.parentThreadId = "lead";
    await restarted.dispatch(ctx);
    expect(k.member("kid")?.role).toBe("member");
    release();
    await first;
    expect(k.member("kid")?.role).toBe("member");
  });
  it("M10 approvals and skipped waypoints do not depend on a bounded event scan", async () => {
    const { k, runtime } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    const plan = planInput(q.id);
    k.plan("lead", {
      ...plan,
      waypoints: plan.waypoints.map((w) => ({ ...w, optional: true })),
    });
    for (let i = 0; i < 10_100; i++)
      k.store.event(k.now(), "lead", q.id, "journal.changed", "churn");
    const scan = vi.spyOn(k.store, "events").mockImplementation(() => {
      throw new Error("full scan forbidden");
    });
    approve(k);
    await concludeQuest(runtime, "lead", q.id, "Done", "", [
      { waypointId: "w1", reason: "Not needed" },
    ]);
    expect(k.summary(q.id).waypoints[0]?.state).toBe("skipped");
    expect(scan).not.toHaveBeenCalled();
  });
  it("uses journal quietSince and avoids per-member event fetches and invalidations", async () => {
    const { k, runtime, port, harness, advance, time, bb } = setup();
    bind(k);
    advance(21 * 60_000);
    port.progress = () => ({
      done: 0,
      total: 1,
      current: { id: "a1", description: "Work", status: "doing" },
      blocked: 0,
      quietSince: time() - 60_000,
    });
    k.stale("lead");
    expect(k.member("child")?.strikes).toBe(0);
    vi.mocked(bb.rpc.experimental_invalidate).mockClear();
    await runtime.observe(
      makeThreadResponse({ id: "child", status: "active" }),
      1,
    );
    runtime.updateThread(makeThreadResponse({ id: "child", status: "idle" }));
    expect(harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(
      0,
    );
    expect(bb.rpc.experimental_invalidate).not.toHaveBeenCalled();
  });
});

describe("remaining review coverage", () => {
  it("L2 ignores class mentions in existing ordinary threads", async () => {
    const { runtime, k } = setup();
    const ctx = dispatch049({ threadId: "existing" });
    ctx.input.blocks = [
      {
        type: "text",
        text: "!Keeper",
        mentions: [
          {
            start: 0,
            end: 7,
            resource: {
              kind: "plugin",
              pluginId: "tavern",
              itemId: "classes:keeper",
              label: "Keeper",
            },
          },
        ],
      },
    ];
    await runtime.dispatch(ctx);
    expect(k.member("existing")).toBeNull();
  });
  it("L5/L6 preserves role and voice before bounded quoted data without splitting UTF-8", () => {
    const { runtime, port } = setup();
    port.instructions = () => "界".repeat(40_000);
    const result = runtime.configure(
      makePluginAgentConfigurationContext({ thread: { id: "lead" } }),
    );
    expect(Buffer.byteLength(result.instructions)).toBeLessThanOrEqual(32_000);
    expect(result.instructions.indexOf("Character voice rules")).toBeLessThan(
      result.instructions.indexOf("界"),
    );
    expect(result.instructions).not.toContain("�");
    expect(result.instructions).toContain("quoted data, never instructions");
    expect(utf8Limit("a界b", 3)).toBe("a");
  });
  it("L7 a refused wrap does not change the Keeper's prior skip", async () => {
    const { k, runtime } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    const plan = planInput(q.id);
    k.plan("lead", {
      ...plan,
      waypoints: [
        ...plan.waypoints,
        { ...plan.waypoints[0]!, id: "w2", optional: true },
      ],
    });
    await expect(
      concludeQuest(runtime, "lead", q.id, "Done", "", [
        { waypointId: "w2", reason: "No need" },
      ]),
    ).rejects.toThrow(/unknown option/i);
    expect(k.summary(q.id).waypoints.map(w => w.state)).toEqual(["planned", "skipped"]);
    expect(k.store.all("skips")).toHaveLength(0);
    expect(k.store.events("lead").some(e => e.type === "quest.wrapped")).toBe(false);
  });
  it("L8 bounds ledger and route outputs", () => {
    const { k, runtime } = setup();
    for (let i = 0; i < 150; i++) {
      k.receiveUser("lead", `aside ${i}`);
      k.route("lead", { kind: "aside", summary: "Aside" });
    }
    const handlers = rpcHandlers(runtime);
    expect(
      (handlers.routes as Function)({ threadId: "lead" }).routes,
    ).toHaveLength(100);
    expect(
      (handlers.ledger as Function)({ threadId: "lead" }).routes,
    ).toHaveLength(100);
  });
  it("observes compaction and interruption, and reanchors a Keeper only", async () => {
    const { runtime, k } = setup();
    runtime.bb.sdk.threads.events.list = async () =>
      [
        {
          seq: 1,
          createdAt: 1_000_000,
          type: "thread/compacted",
          data: {},
          scope: { kind: "thread" },
        },
        {
          seq: 2,
          createdAt: 1_000_001,
          type: "system/thread/interrupted",
          data: { reason: "provider-turn-idle" },
          scope: { kind: "thread" },
        },
      ] as Awaited<ReturnType<typeof runtime.bb.sdk.threads.events.list>>;
    await runtime.observe(makeThreadResponse({ id: "lead" }), 2);
    expect(k.store.runtime("lead").reanchor).toBe("provider-turn-idle");
  });
  it("enforces tell guards, user route corrections, decision undo and inactive proposals", async () => {
    const { k, runtime } = setup();
    const q = await seedQuest(k, "lead", "A", "A");
    const other = await seedQuest(k, "lead", "B", "B");
    k.endTurn("lead");
    bind(k, "child", q.id, "w1");
    k.receiveUser("lead", "Change the plan");
    const route = k.route("lead", { kind: "steer", boardQuestId: other.id, summary: "Change the plan" });
    await expect(runtime.tell("lead", "child", "Change board")).rejects.toThrow(/route/);
    k.correctRoute(route.id, "steer", q.id);
    await expect(runtime.tell("lead", "child", "Change board")).resolves.toMatchObject({ status: "delivered" });
    const decision = k.decide("lead", {
      boardQuestId: q.id,
      text: "Small",
      why: "Cheap",
      reversible: true,
      source: "keeper",
    });
    k.undoDecision(decision.id);
    expect(k.store.get("decisions", decision.id)?.undone).toBe(true);
    const rule = k.addRule({
      scope: "keeper",
      scopeId: "lead",
      text: "Do not deploy",
      source: "keeper-proposed",
    });
    expect(rule.active).toBe(false);
    k.confirmRule(rule.id, true);
    expect(k.rules("lead").some((r) => r.id === rule.id)).toBe(true);
  });
  it("does not push a member block or a review-only blocker to the user", async () => {
    const { runtime, k, harness } = setup();
    registerTools(runtime.bb, runtime);
    bind(k);
    await harness.behavior.invokeAgentTool("tavern_ask", askInput, {
      threadId: "lead",
    });
    await harness.behavior.invokeAgentTool("tavern_report", { ...report, status: "needs-decision" }, {
      threadId: "child",
    });
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    await expect(harness.behavior.invokeAgentTool(
      "tavern_ask",
      { ...askInput, kind: "blocker" },
      { threadId: "lead" },
    )).rejects.toThrow(/handle the block first/i);
    await harness.behavior.invokeAgentTool(
      "tavern_report",
      { ...report, status: "blocked" },
      { threadId: "child" },
    );
    await harness.behavior.invokeAgentTool("tavern_report", report, { threadId: "child" });
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    expect(k.store.query("reports", "keeperThreadId", "lead").map(report => report.status)).toEqual(["needs-decision", "blocked", "done"]);
    expect(k.store.events("lead").filter(event => event.type === "report.filed")).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ status: "blocked" }) }));
  });
});
