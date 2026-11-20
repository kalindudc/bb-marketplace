// @vitest-environment node
import { putQuestFixture } from "./support";
import { seedQuest } from "./support";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { planInput } from "./support";
import { recoverHires } from "../../src/server/hires";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null };
async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.plan("lead", { ...planInput(q.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
  f.k.answerAsk(f.k.store.openAsks("lead")[0]!.id, "approve", null, "page", "user");
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  return { ...f, q, input: { classId: "smith", title: "Build", boardQuestId: q.id, waypointId: "w1", brief } };
}
it("rechecks the quest immediately before spawning after an awaited environment lookup", async () => {
  const f = await fixture();
  const original = f.bb.sdk.environments.listProviders;
  f.bb.sdk.environments.listProviders = vi.fn(async () => { await f.runtime.stop(f.q.id); return original(); });
  await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/ended|stopping|cancelled/);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
it.each(["stop", "wrap"] as const)("stops and archives a child returned after %s won the spawn race", async ended => {
  const f = await fixture();
  f.bb.sdk.threads.spawn = vi.fn(async () => {
    if (ended === "stop") await f.runtime.stop(f.q.id);
    else putQuestFixture(f.k.store, f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
    return makeThreadResponse({ id: "late", parentThreadId: "lead" });
  });
  await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/ended|stopping|cancelled/);
  expect(f.bb.sdk.threads.stop).toHaveBeenCalledWith({ threadId: "late" });
  expect(f.harness.inspection.sdk.callsTo("threads.archive").some(call => JSON.stringify(call.args).includes("late"))).toBe(true);
  expect(f.k.member("late")).toMatchObject({ engagement: "archived", disposition: "stopped" });
  expect(f.k.store.all("hires")).toHaveLength(0);
});
it("keeps a replacement waiting while the previous member's release is unconfirmed", async () => {
  const f = await fixture();
  const member = await f.runtime.hire("lead", "project", f.input);
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, status: threadId === member.threadId ? "stopping" : "idle" }));
  expect(await f.runtime.release("lead", member.threadId, "Replace")).toBe(false);
  await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/allocates|live|pending/);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});
it("recovery never delivers a late child brief into an ended quest", async () => {
  const f = await fixture();
  f.k.store.put("hires", "token", { classId: "smith", characterId: "juno", projectId: "project", classDefinition: { ...f.runtime.snapshot().classes.find(role => role.id === "smith")!, body: "PINNED RECOVERED ROLE" }, createdAt: 0, initialInput: "Build", owner: { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: null, errand: false, title: "Build", brief } });
  putQuestFixture(f.k.store, f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
  f.bb.sdk.threads.list = vi.fn(async () => [{ ...makeThreadResponse({ id: "late", parentThreadId: "lead" }),
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
    environmentBranchName: null, environmentHostId: null, environmentIsWorktree: null, environmentName: null, environmentPath: null,
    environmentProviderId: null, environmentWorkspaceDisplayKind: "other" as const, hasPendingInteraction: false,
    latestAttentionAt: 0, pinSortKey: null, originKind: null, queuedWork: "none" as const, titleFallback: null,
  }]);
  f.bb.sdk.threads.getPluginMetadata = vi.fn(async () => ({ hireToken: "token" }));
  const delivered = vi.fn();
  await recoverHires(f.bb, f.k, "lead", delivered);
  expect(delivered).not.toHaveBeenCalled();
  expect(f.bb.sdk.threads.stop).toHaveBeenCalledWith({ threadId: "late" });
  expect(f.k.member("late")).toMatchObject({ engagement: "archived", disposition: "stopped" });
  expect(f.k.store.runtime("late").classDefinition?.body).toBe("PINNED RECOVERED ROLE");
  expect(f.k.store.get("hires", "token")).toBeNull();
});
