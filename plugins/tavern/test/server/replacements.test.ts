// @vitest-environment node
import { fixtureActivity } from "./member-fixture";
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { recoverHires } from "../../src/server/hires";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { TavernRuntime } from "../../src/server/runtime";

const brief = {
  outcome: "Build",
  mode: "make-it-work" as const,
  outOfScope: "Deploy",
  doneWhen: "Tests pass",
  context: [],
  questions: [],
  timeboxMinutes: null,
};
async function approvedParty(slots = 1) {
  const fixture = setup();
  const q = await seedQuest(fixture.k,"lead", "A", "A");
  const plan = {
    ...planInput(q.id),
    party: Array.from({ length: slots }, () => ({
      classId: "smith",
      characterId: null,
      model: null,
      purpose: "Build",
      waypointIds: [],
    })),
  };
  fixture.k.plan("lead", plan);
  fixture.k.answerAsk(fixture.k.asks("lead")[0]!.id, "approve", null, "page", "user");
  const input = { classId: "smith", boardQuestId: q.id, title: "Build", brief };
  return { ...fixture, q, plan, input };
}

async function failAndRelease(f: Awaited<ReturnType<typeof approvedParty>>, threadId: string) {
  f.k.activity(threadId, "failed");
  const name = f.k.name(f.k.member(threadId)!);
  await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(`These members failed: ${name}. Release them or retry their work`);
  f.bb.sdk.threads.stop = async () => ({ ok: true });
  expect(await f.runtime.release("lead", threadId, "Free the slot after failure")).toBe(true);
}

function replacementDecisions(f: Awaited<ReturnType<typeof approvedParty>>) {
  return f.k.store.query("decisions", "keeperThreadId", "lead").filter(d => d.text.startsWith("Start replacement "));
}

describe("bounded party replacements", () => {
  it.each(["execution", "spawn-400", "spawn-uncertain"])("records no replacement decision for an unstarted %s refusal", async refusal => {
    const f = await approvedParty();
    const first = await f.runtime.hire("lead", "project", f.input);
    await failAndRelease(f, first.threadId);
    if (refusal === "execution") {
      const snapshot = structuredClone(f.runtime.snapshot());
      snapshot.classes.find(role => role.id === "smith")!.model = "unknown/not-advertised";
      vi.spyOn(f.runtime, "snapshot").mockReturnValue(snapshot);
    } else {
      f.bb.sdk.threads.spawn = async () => { throw Object.assign(new Error(refusal), refusal === "spawn-400" ? { status: 400 } : {}); };
    }
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(refusal === "execution" ? /unknown\/not-advertised/ : refusal);
    expect(replacementDecisions(f)).toEqual([]);
    if (refusal !== "spawn-uncertain") {
      await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow();
      expect(replacementDecisions(f)).toEqual([]);
      expect(f.k.store.all("hires")).toEqual([]);
    }
  });
  it("records an uncertain replacement exactly once only after recovery finds the real child", async () => {
    const f = await approvedParty();
    const first = await f.runtime.hire("lead", "project", f.input);
    await failAndRelease(f, first.threadId);
    f.bb.sdk.threads.spawn = async () => { throw new Error("acknowledgement lost"); };
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("acknowledgement lost");
    expect(replacementDecisions(f)).toEqual([]);
    expect(f.k.store.query("decisions", "keeperThreadId", "lead")).toHaveLength(1);
    const [row] = f.k.store.db.prepare("SELECT id FROM tavern_records WHERE kind='hires'").all() as { id: string }[];
    f.advance(6 * 60_000);
    f.bb.sdk.threads.list = async () => [{
      id: "recovered", parentThreadId: "lead", projectId: "project", createdAt: f.time(), updatedAt: f.time(),
      archivedAt: null, deletedAt: null, status: "idle", providerId: "pi", runtime: { displayStatus: "idle" },
      activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
      environmentId: null, environmentBranchName: null, environmentHostId: null, environmentIsWorktree: null,
      environmentName: null, environmentPath: null, environmentProviderId: null, environmentWorkspaceDisplayKind: "other",
      hasPendingInteraction: false, lastReadAt: null, latestAttentionAt: f.time(), lifecycleOwnerThreadId: null,
      originKind: null, originPluginId: "tavern", parentNotifications: "off", pinSortKey: null, pinnedAt: null,
      queuedWork: "none", sectionId: null, sourceThreadId: null, title: "Recovered", titleFallback: null, visibility: "visible",
    }];
    f.bb.sdk.threads.getPluginMetadata = async () => ({ hireToken: row!.id });
    await recoverHires(f.bb, f.k);
    expect(f.k.member("recovered")).not.toBeNull();
    expect(replacementDecisions(f)).toHaveLength(1);
    await recoverHires(f.bb, f.k);
    expect(replacementDecisions(f)).toHaveLength(1);
    expect(f.k.store.query("decisions", "keeperThreadId", "lead")).toHaveLength(2);
  });
  it("frees completed, explicitly released and stopped capacity, journals replacements, and persists the replacement cap", async () => {
    const f = await approvedParty();
    const { k, runtime, q, input, plan } = f;
    const first = await runtime.hire("lead", "project", input);
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/greenlit party/);
    fixtureActivity(k, first.threadId, "done");
    expect(k.store.allocated(q.id, "smith")).toBe(0);
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/is resting/);
    f.bb.sdk.threads.stop = async () => ({ ok: true });
    const replacement = await runtime.replaceMember("lead", "project", first.threadId, "Needs a fresh context");
    if (replacement.state !== "replaced") throw new Error(JSON.stringify(replacement));
    await failAndRelease(f, replacement.threadId);
    const restarted = new TavernRuntime(runtime.bb, k, runtime.registry);
    const third = await restarted.hire("lead", "project", input);
    fixtureActivity(k, third.threadId, "stopped");
    for (let i = 2; i < runtime.config().keepers.replacementsPerSlot; i++) {
      const next = await restarted.hire("lead", "project", input);
      fixtureActivity(k, next.threadId, "stopped");
    }
    await expect(restarted.hire("lead", "project", input)).rejects.toThrow(/Limit: keepers.replacementsPerSlot = 4/);
    const decisions = replacementDecisions(f);
    expect(k.store.query("decisions", "keeperThreadId", "lead")).toHaveLength(6);
    expect(decisions).toHaveLength(4);
    for (const decision of decisions)
      expect(decision).toMatchObject({
        boardQuestId: q.id,
        source: "keeper",
        reversible: true,
        undone: false,
      });
    expect(decisions.every((d) => /replacement/i.test(d.text))).toBe(true);
    expect(k.asks("lead").filter((a) => a.state === "open")).toHaveLength(0);
    k.plan("lead", { ...plan, changeNote: "A fresh attempt" });
    await expect(restarted.hire("lead", "project", input)).resolves.toBeTruthy();
  });
  it("lets a Smith cover a different waypoint without re-briefing a resting maker", async () => {
    const f = setup();
    const q = await seedQuest(f.k, "lead", "Two builds", "Build");
    const base = planInput(q.id), firstWaypoint = base.waypoints[0]!;
    f.k.plan("lead", { ...base,
      waypoints: [firstWaypoint, { ...firstWaypoint, id: "w2" }],
      party: ["w1", "w2"].map(id => ({ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: [id] })),
    });
    f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
    const hire = (waypointId: string) => f.runtime.hire("lead", "project", { classId: "smith", boardQuestId: q.id, waypointId, title: "Build", brief });
    const resting = await hire("w1");
    fixtureActivity(f.k, resting.threadId, "done");
    await expect(hire("w1")).rejects.toThrow(/is resting.*tavern_tell/);
    await expect(hire("w2")).resolves.toMatchObject({ waypointId: "w2" });
    expect(f.k.member(resting.threadId)?.engagement).toBe("resting");
  });
  it("honors an explicit replacement even while another member of that class rests", async () => {
    const f = await approvedParty(2);
    const first = await f.runtime.hire("lead", "project", f.input);
    const second = await f.runtime.hire("lead", "project", f.input);
    fixtureActivity(f.k, first.threadId, "done");
    f.bb.sdk.threads.stop = async () => ({ ok: true });
    await expect(f.runtime.replaceMember("lead", "project", second.threadId, "Replace stuck turn")).resolves.toMatchObject({ state: "replaced" });
    expect(f.k.member(first.threadId)?.engagement).toBe("resting");
  });
  it("gives each same-class slot its own replacement budget", async () => {
    const f = await approvedParty(2);
    const { k, runtime, input } = f;
    const first = await runtime.hire("lead", "project", input);
    const second = await runtime.hire("lead", "project", input);
    for (let i = 0; i < runtime.config().keepers.replacementsPerSlot; i++) {
      const current = k.store
        .query("members", "boardQuestId", input.boardQuestId)
        .find(
          (m) => m.threadId !== second.threadId && m.engagement === "active",
        )!;
      await failAndRelease(f, current.threadId);
      await runtime.hire("lead", "project", input);
    }
    const activeFirstSlot = k.store
      .query("members", "boardQuestId", input.boardQuestId)
      .find(
        (m) => m.threadId !== second.threadId && m.engagement === "active",
      )!;
    await failAndRelease(f, activeFirstSlot.threadId);
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/Limit: keepers.replacementsPerSlot = 4/);
    fixtureActivity(k, second.threadId, "stopped");
    const replacement = await runtime.hire("lead", "project", input);
    expect(replacement.threadId).not.toBe(first.threadId);
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/Limit: keepers.replacementsPerSlot = 4/);
  });
});
