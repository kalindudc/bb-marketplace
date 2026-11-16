// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEEPER_TOOLS } from "../../src/server/runtime";
import { registerTools } from "../../src/server/tools";
import { seedQuest } from "./support";
import { setup } from "./runtime-fixture";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

async function fixture() {
  const f = setup(); databases.push(f.k.store.db);
  const returned = await seedQuest(f.k, "lead", "Returned work", "Returned work");
  const stopped = await seedQuest(f.k, "lead", "Stopped work", "Stopped work");
  f.k.store.put("quests", returned.id, { ...returned, phase: "done", planVersion: 3, greenlitVersion: 2, endedAt: f.time() });
  f.k.store.put("quests", stopped.id, { ...stopped, phase: "stopped", planVersion: 1, greenlitVersion: 1, endedAt: f.time(), stoppingSince: f.time() - 5, stopReason: "You stopped it" });
  const member = (id: string) => ({
    keeperThreadId: "lead", boardQuestId: id, waypointId: null, errand: false, title: "Deviation", displayName: "Vale",
    brief: { outcome: "Draft", mode: "make-it-work" as const, doneWhen: "Tests pass", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null },
  });
  f.k.bind("child", "smith", "vale", "project", member(stopped.id));
  return { ...f, returned: f.k.quest(returned.id), stopped: f.k.quest(stopped.id) };
}

describe("quest re-open", () => {
  it.each(["returned", "stopped"] as const)("re-opens a %s quest for deviations and keeps its plan version and greenlight", async which => {
    const f = await fixture();
    const invalidated: string[] = [];
    const signal = vi.spyOn(f.bb.rpc, "experimental_invalidate").mockImplementation(values => { invalidated.push(...values); });
    const before = f[which];
    const reopened = f.k.reopenQuest(before.id);
    expect(reopened).toMatchObject({
      phase: "build", planVersion: before.planVersion, greenlitVersion: before.greenlitVersion,
      endedAt: null, archivedAt: null, stopReason: null, stoppingSince: null,
    });
    expect(f.k.quest(before.id)).toMatchObject({ phase: "build" });
    expect(f.k.store.events("lead").find(event => event.type === "quest.reopened")).toMatchObject({ boardQuestId: before.id, text: `Re-opened ${before.title} for deviations`, data: { planVersion: before.planVersion, phaseBeforeReopen: before.phase } });
    expect(f.k.store.runtime("lead").reanchor).toBe("quest reopened for deviations");
    expect(invalidated).toContain("tavern:map-history");
    signal.mockRestore();
  });

  it("refuses every live or stopping quest, and leaves it untouched", async () => {
    const f = await fixture();
    const live = await seedQuest(f.k, "lead", "Live work", "Live work");
    for (const phase of ["scout", "greenlight", "build", "check", "wrap", "stopping"] as const) {
      f.k.store.put("quests", live.id, { ...f.k.quest(live.id), phase });
      expect(() => f.k.reopenQuest(live.id)).toThrow(/returned or stopped/);
      expect(f.k.quest(live.id).phase).toBe(phase);
    }
    expect(f.k.store.events("lead").some(event => event.type === "quest.reopened")).toBe(false);
  });

  it("refuses a deleted or archived quest: the cellar stays the way back", async () => {
    const f = await fixture();
    f.k.deleteQuest(f.returned.id);
    expect(() => f.k.reopenQuest(f.returned.id)).toThrow(/cellar/);
    expect(f.k.quest(f.returned.id)).toMatchObject({ phase: "done", deletedAt: f.time() });
    f.k.restoreDeletedQuest(f.returned.id);
    f.k.archiveQuests([f.returned.id], true);
    expect(() => f.k.reopenQuest(f.returned.id)).toThrow(/archived.*cellar/);
    expect(f.k.quest(f.returned.id)).toMatchObject({ phase: "done", archivedAt: f.time() });
    f.k.archiveQuests([f.returned.id], false);
    expect(f.k.reopenQuest(f.returned.id)).toMatchObject({ phase: "build", archivedAt: null });
  });

  it("wires a Keeper-only reopen tool that changes only the Keeper's own quest", async () => {
    const f = await fixture(); registerTools(f.bb, f.runtime);
    expect(KEEPER_TOOLS).toContain("tavern_reopen");
    expect(f.harness.inspection.registrations.agentTools.map(tool => tool.name)).toContain("tavern_reopen");
    const result = await f.harness.behavior.invokeAgentTool("tavern_reopen", { boardQuestId: f.returned.id }, { threadId: "lead" });
    expect(String(result)).toMatch(/back in build at plan v3/);
    expect(f.k.quest(f.returned.id).phase).toBe("build");
    f.k.bind("other", "keeper", "bram", "project");
    await expect(f.harness.behavior.invokeAgentTool("tavern_reopen", { boardQuestId: f.stopped.id }, { threadId: "other" })).rejects.toThrow(/own board quests/);
    await expect(f.harness.behavior.invokeAgentTool("tavern_reopen", { boardQuestId: f.stopped.id }, { threadId: "child" })).rejects.toThrow(/Only a Tavern keeper/);
    expect(f.k.quest(f.stopped.id).phase).toBe("stopped");
  });
});
