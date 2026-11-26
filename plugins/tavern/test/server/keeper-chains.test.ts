// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registerTools } from "../../src/server/tools";
import { recoverHires } from "../../src/server/hires";
import { TavernRuntime } from "../../src/server/runtime";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { DEFAULT_SETTINGS, settingsSchema, settingsPatchSchema } from "../../src/shared/settings";
import { makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";

const brief = { outcome: "Coordinate two parallel tracks", mode: "make-it-work" as const, outOfScope: "No deploy", doneWhen: "Both checks pass", context: [], questions: [], timeboxMinutes: null };
const slot = (waypointId: string, depth = 1) => ({ classId: "keeper", characterId: null, model: "anthropic/claude-sonnet-5-5", purpose: brief.outcome, waypointIds: [waypointId], leadEnvelope: { members: 4, rangers: 1, depth } });
const request = (boardQuestId: string, waypointId = "w1") => ({ classId: "keeper", boardQuestId, waypointId, title: brief.outcome, brief });
const leadPlan = (questId: string, ids: string[], depth = 1) => ({ ...planInput(questId), waypoints: ids.map(id => ({ ...planInput(questId).waypoints[0]!, id, owner: "keeper" })), party: ids.map(id => slot(id, depth)) });

async function fixture(ids = ["w1"], opts: { chainDepth?: number; chainMembers?: number; slotDepth?: number } = {}) {
  const f = setup();
  const settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  if (opts.chainDepth || opts.chainMembers) settings.update({ revision: 0, patch: { keepers: { ...(opts.chainDepth ? { chainDepth: opts.chainDepth } : {}), ...(opts.chainMembers ? { chainMembers: opts.chainMembers } : {}) } }, why: "Test the chain limits" });
  const q = await seedQuest(f.k, "lead", "A project in stages", "Stages");
  f.k.plan("lead", leadPlan(q.id, ids, opts.slotDepth));
  approve(f.k, "lead", q.id);
  return { ...f, q };
}

function approve(k: ReturnType<typeof setup>["k"], keeperId: string, qid: string) {
  const ask = k.store.openAsks(keeperId, qid).find(ask => ask.kind === "greenlight")!;
  k.answerAsk(ask.id, "approve", null, "page", "user");
  return ask.id;
}

it("defaults to one layer and twelve seats and validates integer settings without patch defaults", () => {
  expect(DEFAULT_SETTINGS.keepers).toMatchObject({ chainDepth: 1, chainMembers: 12 });
  expect(settingsSchema.parse({ keepers: { ...DEFAULT_SETTINGS.keepers, chainDepth: 3, chainMembers: 1000 } }).keepers.chainDepth).toBe(3);
  for (const patch of [{ chainDepth: 0 }, { chainDepth: 4 }, { chainMembers: 1001 }, { chainMembers: 1.5 }])
    expect(settingsPatchSchema.safeParse({ keepers: patch }).success).toBe(false);
  expect(settingsPatchSchema.parse({ keepers: { partyMax: 6 } })).toEqual({ keepers: { partyMax: 6 } });
});

it("uses the parent environment, accounts for the seat, and opens just one verified hire-backed quest without claiming the user spoke", async () => {
  const f = await fixture();
  const member = await f.runtime.hire("lead", "project", request(f.q.id));
  expect(member).toMatchObject({ keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", engagement: "active", placement: null });
  expect(f.k.store.activeStaffing("lead").map(m => m.threadId)).toEqual([member.threadId]);
  expect(f.k.require(member.threadId, "keeper").threadId).toBe(member.threadId);
  expect(() => f.k.require(member.threadId, "member")).toThrow();
  registerTools(f.bb, f.runtime);
  await expect(f.harness.behavior.invokeAgentTool("tavern_report", {}, { threadId: member.threadId })).rejects.toThrow("Only a Tavern member");
  const [a, b] = await Promise.all([f.k.openQuest(member.threadId, "Parallel tracks", "Tracks"), f.k.openQuest(member.threadId, "Duplicate", "Duplicate")]);
  expect(a.id).toBe(b.id);
  expect(a.keeperThreadId).toBe(member.threadId);
  expect(f.k.store.all("leadLinks")).toEqual([expect.objectContaining({ parentQuestId: f.q.id, parentWaypointId: "w1", childQuestId: a.id, childKeeperThreadId: member.threadId, parentPlan: expect.objectContaining({ version: 1, receipt: expect.objectContaining({ kind: "ask-answer" }) }), state: "linked" })]);
  expect(f.k.store.query("routes", "keeperThreadId", member.threadId)).toEqual([]);
  f.k.endTurn("lead");
  await expect(f.k.openQuest("lead", "Not authorized", "No")).rejects.toThrow(/already has a quest/);
  await expect(f.runtime.hire("lead", "project", request(f.q.id))).rejects.toThrow(/greenlit party has no free seat for another keeper/);
});

it("refuses to open a placement card for an outside goal in a side Keeper", async () => {
  const f = await fixture();
  const child = await f.runtime.hire("lead", "project", request(f.q.id));
  await f.k.openQuest(child.threadId, "Write the guide", "Guide");
  f.k.receiveUser(child.threadId, "Also publish a separate site");
  const route = f.k.route(child.threadId, { kind: "new-quest", summary: "Publish a separate site", notes: [] });
  expect(() => f.k.offerQuestStart(child.threadId, route.id)).toThrow(/hiring Keeper/i);
  expect(f.k.store.openAsks(child.threadId)).toEqual([]);
});

it("uses the global Keeper roster for an automatically assigned child lead", async () => {
  const f = await fixture();
  f.k.bind("other-keeper", "keeper", "moss", "project");
  const child = await f.runtime.hire("lead", "project", request(f.q.id));
  expect(child.characterId).toBe("ada");
});

it("does not rename a live child lead when an older Keeper returns with the same name", async () => {
  const f = await fixture();
  const old = f.k.bind("old", "keeper", "moss", "project");
  f.k.store.put("members", old.threadId, { ...old, createdAt: f.time() - 1_000, displayName: "Moss" });
  f.k.store.patch(old.threadId, { archivedAt: f.time() });
  f.advance(1_000);
  const child = await f.runtime.hire("lead", "project", request(f.q.id));
  expect(child.displayName).toBe("Moss");
  f.advance(1_000);
  await f.runtime.threadLifecycle("thread.unarchived", { thread: makeThreadResponse({ id: old.threadId }) });
  expect([child.threadId, old.threadId].map(id => f.k.member(id)?.displayName)).toEqual(["Moss", "Moss II"]);
});

it("refuses an unapproved, unallocated, or unnamed lead without spawning", async () => {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "No lead authorized", "None");
  await expect(f.runtime.hire("lead", "project", request(q.id))).rejects.toThrow(/greenlight/);
  f.k.plan("lead", leadPlan(q.id, ["w1"]));
  approve(f.k, "lead", q.id);
  await expect(f.runtime.hire("lead", "project", request(q.id, "w2"))).rejects.toThrow(/waypoint/i);
  await expect(f.runtime.hire("lead", "project", { ...request(q.id), waypointId: null })).rejects.toThrow(/waypoint/i);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("rejects a lead plan beyond the depth setting, but allows a second layer with a named envelope and raised setting", async () => {
  const f = await fixture();
  const member = await f.runtime.hire("lead", "project", request(f.q.id));
  const child = await f.k.openQuest(member.threadId, "Work", "Work");
  expect(() => f.k.plan(member.threadId, leadPlan(child.id, ["w1"]))).toThrow(/chain depth/i);
  const deeper = await fixture(["w1"], { chainDepth: 2, slotDepth: 2 });
  const lead = await deeper.runtime.hire("lead", "project", request(deeper.q.id));
  const next = await deeper.k.openQuest(lead.threadId, "Work", "Work");
  deeper.k.plan(lead.threadId, leadPlan(next.id, ["w1"], 2));
  approve(deeper.k, lead.threadId, next.id);
  const grandchild = await deeper.runtime.hire(lead.threadId, "project", request(next.id));
  expect(grandchild.keeperThreadId).toBe(lead.threadId);
});

it.each([false, true])("stops the chain depth first and retries a failed inner stop (host archive: %s)", async hostArchive => {
  const f = await fixture(["w1"], { chainDepth: 2, slotDepth: 2 });
  const lead = await f.runtime.hire("lead", "project", request(f.q.id));
  const child = await f.k.openQuest(lead.threadId, "Child stages", "Child");
  f.k.plan(lead.threadId, leadPlan(child.id, ["w1"], 2));
  approve(f.k, lead.threadId, child.id);
  const inner = await f.runtime.hire(lead.threadId, "project", request(child.id));
  const deepest = await f.k.openQuest(inner.threadId, "Deepest stages", "Deepest");
  const stopped: string[] = [];
  let refuse = true;
  f.bb.sdk.threads.stop = async ({ threadId }) => {
    if (threadId === inner.threadId && refuse) throw new Error("Host unavailable");
    stopped.push(threadId);
    return { ok: true };
  };
  if (hostArchive) await f.runtime.threadLifecycle("thread.archived", { thread: makeThreadResponse({ id: "lead", archivedAt: f.time() }) });
  else await f.runtime.stop(f.q.id);
  expect(f.k.quest(deepest.id).phase).toBe("stopped");
  expect(f.k.quest(child.id).phase).toBe("stopping");
  expect(f.k.quest(f.q.id).phase).toBe("stopping");
  expect(f.k.summary(f.q.id).stopUnconfirmed).toBeGreaterThan(0);
  expect(stopped).toEqual([]);
  refuse = false;
  const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
  await restarted.retryStops("lead", f.q.id, true);
  expect(f.k.store.all("leadLinks").map(link => link.cleanupError)).toEqual([undefined, undefined]);
  expect(stopped).toEqual([inner.threadId, lead.threadId]);
  expect([deepest.id, child.id, f.q.id].map(id => f.k.quest(id).phase)).toEqual(["stopped", "stopped", "stopped"]);
  expect(f.k.store.all("leadLinks").map(link => link.state)).toEqual(["stopped", "stopped"]);
});

it("reserves one lead seat across concurrent hires even when both pass the initial checks", async () => {
  const f = await fixture(["w1", "w2"]);
  f.runtime.settings!.update({ revision: 0, patch: { keepers: { chainMembers: 1 } }, why: "One available seat" });
  const results = await Promise.allSettled([f.runtime.hire("lead", "project", request(f.q.id)), f.runtime.hire("lead", "project", request(f.q.id, "w2"))]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected").map(result => String(result.reason))).toEqual([expect.stringMatching(/chain member/i)]);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.k.store.all("leadLinks")).toHaveLength(1);
});

it("keeps an unresolved lead holder and recovers it only with its own hire nonce", async () => {
  const f = await fixture();
  f.bb.sdk.threads.spawn = vi.fn(async () => { throw new Error("Lost reply"); });
  await expect(f.runtime.hire("lead", "project", request(f.q.id))).rejects.toThrow("Lost reply");
  await expect(f.runtime.hire("lead", "project", request(f.q.id))).rejects.toThrow(/greenlit party has no free seat for another keeper/);
  const reservation = f.k.store.all("leadLinks")[0]!;
  const child = (id: string) => ({ ...makeThreadResponse({ id, parentThreadId: "lead", projectId: "project" }),
    activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
    environmentBranchName: null, environmentHostId: null, environmentIsWorktree: null, environmentName: null, environmentPath: null,
    environmentProviderId: null, environmentWorkspaceDisplayKind: "other" as const, hasPendingInteraction: false,
    latestAttentionAt: 0, pinSortKey: null, originKind: null, queuedWork: "none" as const, titleFallback: null,
  });
  f.bb.sdk.threads.list = vi.fn(async () => [child("real-lead"), child("wrong-lead")]);
  f.bb.sdk.threads.getPluginMetadata = vi.fn<typeof f.bb.sdk.threads.getPluginMetadata>()
    .mockImplementation(async ({ threadId }): ReturnType<typeof f.bb.sdk.threads.getPluginMetadata> => {
      if (threadId === "real-lead") return { hireToken: reservation.hireToken };
      return { classId: "keeper", characterId: "moss" };
    });
  f.advance(60_000 * 60);
  await recoverHires(f.bb, f.k, "lead", threadId => f.runtime.spawnBriefDelivered(threadId));
  expect(f.k.member("wrong-lead")).toBeNull();
  expect(f.k.require("real-lead", "keeper").keeperThreadId).toBe("lead");
  expect(f.k.store.all("leadLinks")).toEqual([expect.objectContaining({ id: reservation.id, childKeeperThreadId: "real-lead" })]);
  expect(f.bb.sdk.threads.spawn).toHaveBeenCalledTimes(1);
});

it("keeps an already hired lead fenced when its parent is held", async () => {
  const f = await fixture();
  const lead = await f.runtime.hire("lead", "project", request(f.q.id));
  f.k.setQuestHeld(f.q.id, true, { kind: "user" });
  await expect(f.k.openQuest(lead.threadId, "Wait", "Wait")).rejects.toThrow(/parent quest is held/i);
  expect(f.k.store.all("leadLinks")[0]?.childQuestId).toBeNull();
});

it("releases a definite rejected spawn without leaving a live lead slot", async () => {
  const f = await fixture();
  const spawn = vi.spyOn(f.bb.sdk.threads, "spawn").mockRejectedValueOnce(Object.assign(new Error("HTTP 400: known refusal"), { status: 400 }));
  await expect(f.runtime.hire("lead", "project", request(f.q.id))).rejects.toThrow("known refusal");
  expect(f.k.store.all("hires")).toHaveLength(0);
  expect(f.k.store.all("leadLinks")).toMatchObject([{ state: "cancelled" }]);
  await expect(f.runtime.hire("lead", "project", request(f.q.id))).resolves.toMatchObject({ classId: "keeper" });
  expect(spawn).toHaveBeenCalledTimes(2);
});
