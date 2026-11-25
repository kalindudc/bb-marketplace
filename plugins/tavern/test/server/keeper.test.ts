// @vitest-environment node
import { withMemberFixtures } from "./member-fixture";
import { concludeQuest } from "./support";
import { seedQuest } from "./support";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "./host";
import { fileURLToPath } from "node:url";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { Registry } from "../../src/server/registry";
import { TavernRuntime } from "../../src/server/runtime";
import { registerTools } from "../../src/server/tools/index";
import { registerRpc } from "../../src/server/rpc";
import { rpcContract } from "../../src/shared/contract";
import { journalEntrySchema } from "../../src/shared/schema";
import { fakePort, planInput } from "./support";
import { providerSdk } from "./provider-fixture";
import { worktreeProvider } from "./environment-fixture";

let now: number;
function setup() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  const thread = makeThreadResponse({ id: "lead", status: "idle", projectId: "project" });
  const host = createFakePluginHost({
    pluginId: "tavern",
    agentSkillIds: ["journal", "quest-management", "tavern", "tavern-keeper"],
    sdk: {
      providers: providerSdk(),
      system: { config: async () => ({ primaryHostId: "host" }) },
      projects: { get: async () => ({ sources: [] }) },
      threads: {
        get: async () => thread,
        spawn: async () =>
          makeThreadResponse({ id: "child", parentThreadId: "lead", projectId: "project" }),
        send: vi.fn(async () => ({ delivery: "sent" })),
        queuedMessages: { list: async () => [] },
        updatePluginMetadata: async () => ({}),
        stop: async () => ({ ok: true }),
        archive: async () => ({ ok: true }),
        events: { list: async () => [] },
      },
      environments: {
        listProviders: async () => [worktreeProvider()],
        get: async () => ({
          id: "env",
          hostId: "host",
          isGitRepo: true,
          environmentProviderId: "git-worktree",
          branchName: "main",
        }),
      },
      plugins: { callRpc: async () => ({ ok: true, channels: [] }) },
    },
  });
  const port = fakePort();
  const k = withMemberFixtures(new Keeper(
    new KeeperStore(db),
    port,
    () => now,
    (tags) => host.bb.rpc.experimental_invalidate(tags),
  ));
  const runtime = new TavernRuntime(
    host.bb,
    k,
    new Registry(fileURLToPath(new URL("../../", import.meta.url)), "/nonexistent"),
  );
  host.bb.agents.registerTool({
    name: "journal",
    description: "Journal",
    parameters: {},
    execute: () => "log",
  });
  host.bb.agents.configure((ctx) => runtime.configure(ctx));
  registerTools(host.bb, runtime);
  registerRpc(host.bb, runtime);
  k.bind("lead", "keeper", "wren", "project");
  return { ...host, k, runtime, port, thread };
}
beforeEach(() => {
  now = 1_000_000;
});
const askInput = {
  reversible: true,
  kind: "decision" as const,
  question: "Use a small fixture?",
  why: "Reversible",
  options: [{ id: "small", label: "Small", detail: "", recommended: true }],
  meanwhile: "Keep scouting",
  holds: [],
};

describe("asks and consent", () => {
  it("refuses consequential timers and incomplete sends-as-you drafts", () => {
    const { k } = setup();
    for (const kind of ["production", "sends-as-you", "credential", "greenlight"] as const)
      expect(() => k.ask("lead", { effect: {type:"decision"}, ...askInput, kind, proceedInMinutes: 5 })).toThrow(/never/);
    expect(() => k.ask("lead", { effect: {type:"decision"}, ...askInput, kind: "sends-as-you" })).toThrow(/complete/);
  });
  it("applies the recommended reversible default once and records attribution", () => {
    const { k } = setup();
    const ask = k.ask("lead", { effect: {type:"decision"}, ...askInput, proceedInMinutes: 5 });
    now += 300_000;
    k.defaults();
    k.defaults();
    expect(k.store.get("asks", ask.id)?.answer).toMatchObject({
      by: "default",
      via: "timer",
      optionId: "small",
    });
    expect(k.store.events("lead").filter((e) => e.type === "ask.defaulted")).toHaveLength(1);
  });
  it("refreshes greenlights per plan version and approvals only come from the open ask", async () => {
    const { k } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    k.plan("lead", planInput(q.id));
    const old = k.asks("lead")[0]!;
    k.plan("lead", planInput(q.id));
    expect(() => k.answerAsk(old.id, "approve", null, "page", "user")).toThrow(/no longer open/);
    const ask = k.asks("lead").find((a) => a.state === "open")!;
    k.answerAsk(ask.id, "approve", null, "banner", "user");
    k.answerAsk(ask.id, "approve", null, "page", "user");
    expect(k.quest(q.id)).toMatchObject({ phase: "build", greenlitVersion: 2 });
  });
  it("does not let an agent forge a user decision or an answered ask", () => {
    const { k } = setup();
    expect(() =>
      k.decide("lead", { text: "Ship", why: "I say so", reversible: false, source: "user" }),
    ).toThrow(/consent|user/);
    expect(() =>
      k.decide("lead", {
        text: "Ship",
        why: "I say so",
        reversible: false,
        source: "ask",
        sourceRef: "fake",
      }),
    ).toThrow(/ask/);
  });
});

describe("ticks and lifecycle", () => {
  it("folds facts and priorities into one agent-only queued tick, only on change and once per minute", async () => {
    const { k, runtime, harness } = setup();
    await seedQuest(k, "lead", "A", "A");
    k.store.patch("lead", { userAt: null });
    k.reanchor("lead", "failed turn");
    await runtime.tick("lead");
    await runtime.tick("lead");
    let calls = harness.inspection.sdk.callsTo("threads.send");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toContain("queue-if-active");
    expect(JSON.stringify(calls[0])).toContain("agent-only");
    expect(JSON.stringify(calls[0])).toContain("Priorities restated:");
    now += 60_000;
    await runtime.tick("lead");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    k.reanchor("lead", "compacted");
    await runtime.tick("lead");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
    now += 60_000;
    await runtime.tick("lead");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
  });
  it("holds while typing, after a user message and with queued messages", async () => {
    const { k, runtime, harness } = setup();
    await seedQuest(k,"lead", "A", "A");
    k.reanchor("lead", "failed turn");
    k.store.patch("lead", { typingAt: now });
    await runtime.tick("lead");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    now += 46_000;
    k.receiveUser("lead", "How is it going?");
    k.route("lead", { kind: "question", summary: "status" });
    await runtime.tick("lead");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    now += 61_000;
    await runtime.tick("lead");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(JSON.stringify(harness.inspection.sdk.callsTo("threads.send")[0])).toContain(
      "Held 107 s",
    );
  });
  it("does not send a tick with a queued message or a running user turn", async () => {
    const { k, runtime, thread, harness } = setup();
    await seedQuest(k,"lead", "A", "A");
    k.reanchor("lead", "failed turn");
    thread.status = "active";
    await runtime.tick("lead");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    thread.status = "idle";
    runtime.bb.sdk.threads.queuedMessages.list = async () =>
      [{ id: "queued" }] as Awaited<ReturnType<typeof runtime.bb.sdk.threads.queuedMessages.list>>;
    await runtime.tick("lead");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("blocks a late tick at dispatch while the user types", async () => {
    const { runtime, k } = setup();
    k.store.patch("lead", { typingAt: now });
    const ctx = makeMessageDispatchHookContext({
      thread: { id: "lead", status: "idle" },
      initiator: "agent",
      originPluginId: "tavern",
      input: { text: "[Tavern tick]\nFacts", blocks: [] },
    });
    expect((await runtime.dispatch(ctx)).action).toBe("wait");
  });
  it("adds two stale strikes at twenty-minute intervals and starts over after progress", () => {
    const { k } = setup();
    k.bind("child", "ranger", "otto", "project", {
      keeperThreadId: "lead",
      boardQuestId: null,
      waypointId: null,
      errand: true,
      title: "Scout",
      brief: {
        outcome: "Read",
        mode: "make-it-work",
        outOfScope: "",
        doneWhen: "Report",
        context: [],
        questions: [],
        timeboxMinutes: null,
      },
    });
    now += 20 * 60_000;
    k.stale();
    k.stale();
    expect(k.member("child")?.strikes).toBe(1);
    now += 20 * 60_000;
    k.stale();
    expect(k.member("child")?.strikes).toBe(2);
    expect(k.store.events("lead").at(-1)?.text).toContain("call tavern_release for child, with replace:true");
    now += 2 * 20 * 60_000;
    k.stale();
    expect(k.store.events("lead").filter(e => e.type === "member.stale")).toHaveLength(2);
    expect(k.member("child")?.strikes).toBe(2);
    k.activity("child", "working");
    k.activity("child", "idle");
    now += 20 * 60_000;
    k.stale();
    expect(k.store.events("lead").filter(e => e.type === "member.stale").at(-1)?.text).toContain("stale strike 1");
  });
});

describe("host boundaries", () => {
  it("selects journal and the Tavern setup skill in untyped threads; members get their brief and report tools", async () => {
    const { harness, k, runtime } = setup();
    const c = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "untyped" } }),
    );
    expect(c.tools.map((t) => t.name)).toEqual(["journal"]);
    expect(c.skills).toEqual(["journal", "quest-management", "tavern"]);
    expect(c.instructions).toContain("Use journal");
    k.bind("child", "smith", "juno", "project", {
      keeperThreadId: "lead",
      boardQuestId: null,
      waypointId: null,
      errand: true,
      title: "Build",
      brief: {
        outcome: "Read",
        mode: "make-it-work",
        outOfScope: "",
        doneWhen: "Report",
        context: [],
        questions: [],
        timeboxMinutes: null,
      },
    });
    await runtime.prepareRegistry("project");
    const member = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "child" } }),
    );
    expect(member.tools.map((t) => t.name)).toEqual(["journal", "tavern_memory", "tavern_request_sources", "tavern_status", "tavern_report", "tavern_draft_pr"]);
    expect(member.instructions).toContain("Write asks, blockers and failures plainly");
    expect(member.instructions).not.toContain("Character voice rules");
  });
  it("binds from an actual plugin mention before configuration, never metadata", async () => {
    const { runtime, k } = setup();
    const ctx = makeMessageDispatchHookContext({
      thread: { id: "new", status: "pending" },
      project: { id: "project" },
      initiator: "user",
      input: {
        text: "!Keeper Build it",
        blocks: [
          {
            type: "text",
            text: "!Keeper Build it",
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
        ],
      },
    });
    ctx.requestedExecution.permissionMode = "full";
    expect((await runtime.dispatch(ctx)).action).toBe("proceed");
    expect(k.member("new")?.classId).toBe("keeper");
    expect(
      runtime.configure(
        makePluginAgentConfigurationContext({
          thread: { id: "forged" },
          pluginMetadata: { classId: "keeper" },
        }),
      ).tools,
    ).toEqual(["journal"]);
  });
  it("supplies every RPC handler and validates query output against the shared schemas", async () => {
    const { harness, k } = setup();
    await seedQuest(k,"lead", "A", "A");
    for (const method of ["decor", "ledger", "routes", "journal"] as const) {
      const result = await harness.invokeRpc(method, { threadId: "lead" });
      expect(rpcContract[method].output.safeParse(result).success).toBe(true);
    }
    const room = await harness.invokeRpc("room", {});
    expect(rpcContract.room.output.safeParse(room).success).toBe(true);
  });
  it("gates party hires on an explicit greenlight and carries the spawn settings", async () => {
    const { k, runtime, harness, thread } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    k.plan("lead", {
      ...planInput(q.id),
      party: [
        { classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] },
      ],
    });
    thread.environmentId = "env";
    const input = {
      classId: "smith",
      boardQuestId: q.id,
      waypointId: "w1",
      title: "Build",
      brief: {
        outcome: "Build a retry",
        mode: "make-it-work" as const,
        outOfScope: "Deploy",
        doneWhen: "Tests pass",
        context: [],
        questions: [],
        timeboxMinutes: null,
      },
    };
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/greenlight/);
    const ask = k.asks("lead").find((a) => a.state === "open")!;
    k.answerAsk(ask.id, "approve", null, "page", "user");
    await runtime.hire("lead", "project", input);
    expect(k.member("child")).toMatchObject({
      role: "member",
      classId: "smith",
      boardQuestId: q.id,
      waypointId: "w1",
    });
    const spawn = JSON.stringify(harness.inspection.sdk.callsTo("threads.spawn")[0]);
    expect(spawn).toContain('"parentNotifications":"off"');
    expect(spawn).toContain('"model":"openai/gpt-6.1-sol"');
    expect(spawn).toContain('"hireToken"');
    expect(spawn).toContain('"environmentProviderId":"git-worktree"');
    expect(spawn).toContain('"name":"main"');
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/greenlit party has no free seat for another smith/);
  });
  it("drops voice on bad news and refuses done linked entries with no evidence", async () => {
    const { k, port } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    k.bind("child", "smith", "juno", "project", {
      keeperThreadId: "lead",
      boardQuestId: q.id,
      waypointId: "w1",
      errand: false,
      title: "Build",
      brief: {
        outcome: "Build",
        mode: "make-it-work",
        outOfScope: "",
        doneWhen: "Tests",
        context: [],
        questions: [],
        timeboxMinutes: null,
      },
    });
    const report = {
      status: "blocked" as const,
      outcome: "Missing access",
      evidence: [],
      artifacts: [],
      confidence: null,
      voice: "Nope.",
    };
    k.store.recordPullRequest({ keeperThreadId: "lead", boardQuestId: q.id, projectId: "project", url: "https://forge.example/pr/12", forge: null, head: "topic", base: "main", owner: "child", memberHead: "a".repeat(40), pushedHead: "a".repeat(40), verifiedCommit: null, state: "draft" }, 1);
    report.outcome = "x".repeat(4000);
    expect(k.report("child", report).outcome).toBe(report.outcome);
    expect(k.report("child", report).voice).toBeNull();
    expect(k.report("child", report).id).toBe(k.store.all("reports")[0]!.id);
    const get = port.get;
    port.get = (threadId) => ({
      ...get(threadId),
      entries: [
        journalEntrySchema.parse({
          threadId,
          id: "a1",
          description: "Build",
          parentId: null,
          status: "done",
          evidence: [],
          link: { boardQuestId: q.id, waypointId: "w1" },
          owner: null,
          note: null,
          order: 0,
          createdAt: now,
          updatedAt: now,
          createdBy: { kind: "tavern" },
          updatedBy: { kind: "tavern" },
        }),
      ],
    });
    expect(() => k.report("child", { ...report, status: "done" })).toThrow(/evidence/);
  });
  it("stop halts only that quest's party and withdraws its asks without a model", async () => {
    const { k, runtime, harness } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    const other = await seedQuest(k,"lead", "B", "B");
    for (const [threadId, boardQuestId] of [
      ["a", q.id],
      ["b", other.id],
    ])
      k.bind(threadId!, "smith", "juno", "project", {
        keeperThreadId: "lead",
        boardQuestId: boardQuestId!,
        waypointId: null,
        errand: false,
        title: "Build",
        brief: {
          outcome: "Build",
          mode: "make-it-work",
          outOfScope: "",
          doneWhen: "Tests",
          context: [],
          questions: [],
          timeboxMinutes: null,
        },
      });
    const ask = k.ask("lead", { effect: {type:"decision"}, ...askInput, boardQuestId: q.id });
    await runtime.stop(q.id);
    expect(k.quest(q.id).phase).toBe("stopped");
    expect(k.member("a")).toMatchObject({ engagement: "archiving", disposition: "stopped" });
    expect(k.member("b")).toMatchObject({ state: "idle", engagement: "active" });
    expect(k.store.get("asks", ask.id)?.state).toBe("withdrawn");
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("offers Close early for unsettled work and requires a reason to skip optional work", async () => {
    const { k, runtime } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    const plan = planInput(q.id);
    k.plan("lead", plan);
    k.answerAsk(k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
    const early = await runtime.proposeWrap("lead", q.id, "Done", "");
    expect(k.store.get("asks", early.askId!)?.effect?.type).toBe("close-early");
    await runtime.answerAsk(early.askId!, "hold", null, "page", true);
    await expect(
      concludeQuest(runtime, "lead", q.id, "Done", "", [{ waypointId: "w1", reason: "Not needed" }]),
    ).rejects.toThrow(/optional/);
    k.plan("lead", { ...plan, waypoints: plan.waypoints.map((w) => ({ ...w, optional: true })) });
    k.settle("lead", { boardQuestId: q.id, as: "skipped", waypointId: "w1", reason: "Not needed" });
    const close = await runtime.proposeWrap("lead", q.id, "Done", "Optional work left");
    await runtime.answerAsk(close.askId!, "conclude", null, "page", true);
    expect(k.summary(q.id).waypoints[0]!.state).toBe("skipped");
    expect(k.quest(q.id).phase).toBe("done");
  });
  it("does not claim a stop was confirmed while the member is still active", async () => {
    const { k, runtime, thread } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    k.bind("child", "smith", "juno", "project", {
      keeperThreadId: "lead",
      boardQuestId: q.id,
      waypointId: null,
      errand: false,
      title: "Build",
      brief: {
        outcome: "Build",
        mode: "make-it-work",
        outOfScope: "",
        doneWhen: "Tests",
        context: [],
        questions: [],
        timeboxMinutes: null,
      },
    });
    thread.status = "active";
    expect(await runtime.stop(q.id)).toEqual({ phase: "stopping", unconfirmed: 1 });
    expect(k.quest(q.id).endedAt).toBeNull();
  });
  it("rolls linked entries into the map and the check and wrap phases", async () => {
    const { k, port } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    k.plan("lead", planInput(q.id));
    k.answerAsk(k.asks("lead")[0]!.id, "approve", null, "page", "user");
    const entry = journalEntrySchema.parse({
      threadId: "child",
      id: "a1",
      description: "Build",
      parentId: null,
      status: "done",
      evidence: [{ kind: "command", ref: "npm test", detail: "Passed", exitCode: 0 }],
      link: { boardQuestId: q.id, waypointId: "w1" },
      owner: null,
      note: null,
      order: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: "tavern" },
      updatedBy: { kind: "agent", threadId: "warden" },
    });
    port.linkedEntries = () => [entry];
    expect(k.quest(q.id).phase).toBe("build");
    expect(k.summary(q.id).phase).toBe("check");
    expect(k.summary(q.id).waypoints[0]!.state).toBe("reported");
    entry.status = "verified";
    expect(k.quest(q.id).phase).toBe("build");
    expect(k.summary(q.id).phase).toBe("wrap");
    expect(k.summary(q.id).waypoints[0]).toMatchObject({
      state: "verified",
      evidenceCount: 1,
      verifiedBy: "warden",
    });
  });
  it("preserves review attribution and rejection reasons after later notes", async () => {
    const { k, port } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    k.plan("lead", planInput(q.id));
    const entry = journalEntrySchema.parse({
      threadId: "child",
      id: "a1",
      description: "Build",
      parentId: null,
      status: "verified",
      evidence: [],
      link: { boardQuestId: q.id, waypointId: "w1" },
      owner: "child",
      note: null,
      order: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: "tavern" },
      updatedBy: { kind: "agent", threadId: "warden" },
      review: {
        actor: { kind: "agent", threadId: "warden" },
        at: now,
        evidence: [],
        reason: "Checks passed",
      },
    });
    port.linkedEntries = () => [entry];
    expect(k.summary(q.id).waypoints[0]?.verifiedBy).toBe("warden");
    entry.note = "A later note from the maker";
    entry.updatedBy = { kind: "agent", threadId: "maker" };
    expect(k.summary(q.id).waypoints[0]?.verifiedBy).toBe("warden");
    entry.status = "rejected";
    entry.review!.reason = "Missing rollback test";
    expect(k.summary(q.id).waypoints[0]?.rejectedReason).toBe("Missing rollback test");
    entry.review!.reason = null;
    expect(k.summary(q.id).waypoints[0]?.rejectedReason).toBeNull();
    entry.review = null;
    expect(k.summary(q.id).waypoints[0]?.rejectedReason).toBe("A later note from the maker");
  });
  it("keeps events append-only", async () => {
    const { k } = setup();
    await seedQuest(k,"lead", "A", "A");
    expect(() => k.store.db.exec("DELETE FROM tavern_events")).toThrow(/append-only/);
    expect(() => k.store.db.exec("UPDATE tavern_events SET text='changed'")).toThrow(/append-only/);
  });
  it("rechecks caller roles even when a tool is invoked outside its selection", async () => {
    const { harness } = setup();
    await expect(
      harness.behavior.invokeAgentTool(
        "tavern_quest",
        { title: "Fake", short: "Fake" },
        { threadId: "untyped" },
      ),
    ).rejects.toThrow(/Only/);
  });
});
