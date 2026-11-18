// @vitest-environment node
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

describe("bounded party replacements", () => {
  it.each(["execution", "spawn-400", "spawn-uncertain"])("records no replacement decision for an unstarted %s refusal", async refusal => {
    const f = await approvedParty();
    const first = await f.runtime.hire("lead", "project", f.input);
    f.k.activity(first.threadId, "done");
    if (refusal === "execution") {
      const snapshot = structuredClone(f.runtime.snapshot());
      snapshot.classes.find(role => role.id === "smith")!.model = "unknown/not-advertised";
      vi.spyOn(f.runtime, "snapshot").mockReturnValue(snapshot);
    } else {
      f.bb.sdk.threads.spawn = async () => { throw Object.assign(new Error(refusal), refusal === "spawn-400" ? { status: 400 } : {}); };
    }
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow();
    expect(f.k.store.query("decisions", "keeperThreadId", "lead")).toEqual([]);
    if (refusal !== "spawn-uncertain") {
      await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow();
      expect(f.k.store.query("decisions", "keeperThreadId", "lead")).toEqual([]);
      expect(f.k.store.all("hires")).toEqual([]);
    }
  });
  it("records an uncertain replacement exactly once only after recovery finds the real child", async () => {
    const f = await approvedParty();
    const first = await f.runtime.hire("lead", "project", f.input);
    f.k.activity(first.threadId, "failed");
    f.bb.sdk.threads.spawn = async () => { throw new Error("acknowledgement lost"); };
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("acknowledgement lost");
    expect(f.k.store.query("decisions", "keeperThreadId", "lead")).toEqual([]);
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
    expect(f.k.store.query("decisions", "keeperThreadId", "lead")).toHaveLength(1);
    await recoverHires(f.bb, f.k);
    expect(f.k.store.query("decisions", "keeperThreadId", "lead")).toHaveLength(1);
  });
  it("frees completed, failed and stopped capacity, journal replacements, and persists the two-replacement cap", async () => {
    const { k, runtime, q, input, plan } = await approvedParty();
    const first = await runtime.hire("lead", "project", input);
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/greenlit party/);
    k.activity(first.threadId, "done");
    expect(k.store.allocated(q.id, "smith")).toBe(0);
    const second = await runtime.hire("lead", "project", input);
    k.activity(second.threadId, "failed");
    const restarted = new TavernRuntime(runtime.bb, k, runtime.registry);
    const third = await restarted.hire("lead", "project", input);
    k.activity(third.threadId, "stopped");
    await expect(restarted.hire("lead", "project", input)).rejects.toThrow(
      /two replacements.*plan version/i,
    );
    const decisions = k.store.query("decisions", "keeperThreadId", "lead");
    expect(decisions).toHaveLength(2);
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
  it("gives each same-class slot its own replacement budget", async () => {
    const { k, runtime, input } = await approvedParty(2);
    const first = await runtime.hire("lead", "project", input);
    const second = await runtime.hire("lead", "project", input);
    for (let i = 0; i < 2; i++) {
      const current = k.store
        .query("members", "boardQuestId", input.boardQuestId)
        .find(
          (m) => m.threadId !== second.threadId && !["done", "stopped", "failed"].includes(m.state),
        )!;
      k.activity(current.threadId, "failed");
      await runtime.hire("lead", "project", input);
    }
    const activeFirstSlot = k.store
      .query("members", "boardQuestId", input.boardQuestId)
      .find(
        (m) => m.threadId !== second.threadId && !["done", "stopped", "failed"].includes(m.state),
      )!;
    k.activity(activeFirstSlot.threadId, "failed");
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/two replacements/);
    k.activity(second.threadId, "stopped");
    const replacement = await runtime.hire("lead", "project", input);
    expect(replacement.threadId).not.toBe(first.threadId);
    await expect(runtime.hire("lead", "project", input)).rejects.toThrow(/two replacements/);
  });
});
