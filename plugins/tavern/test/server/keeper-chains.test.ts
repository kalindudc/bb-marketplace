// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registerTools } from "../../src/server/tools";
import { recoverHires } from "../../src/server/hires";
import { TavernRuntime } from "../../src/server/runtime";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { DEFAULT_SETTINGS, settingsPatchSchema } from "../../src/shared/settings";
import { makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";
import { rpcHandlers } from "../../src/server/rpc";
import { readRequestSources } from "../../src/server/request-sources";
import { searchAnswers } from "../../src/server/summaries";
import { planInput, seedQuest } from "./support";

const brief = { outcome: "Coordinate two parallel tracks", mode: "make-it-work" as const, outOfScope: "No deploy", doneWhen: "Both checks pass", context: [], questions: [], timeboxMinutes: null };
const slot = (waypointId: string, depth = 1) => ({ classId: "keeper", characterId: null, model: "anthropic/claude-sonnet-5-5", purpose: brief.outcome, waypointIds: [waypointId], leadEnvelope: { members: 4, rangers: 1, depth } });
const request = (boardQuestId: string, waypointId = "w1") => ({ classId: "keeper", boardQuestId, waypointId, title: brief.outcome, brief });
const leadPlan = (questId: string, ids: string[], depth = 1) => ({ ...planInput(questId), waypoints: ids.map(id => ({ ...planInput(questId).waypoints[0]!, id, owner: "keeper" })), party: ids.map(id => slot(id, depth)) });

async function fixture(ids = ["w1"], opts: { chainDepth?: number; chainMembers?: number; slotDepth?: number } = {}) {
  const f = setup();
  const settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  if (opts.chainMembers) settings.update({ revision: 0, patch: { keepers: { chainMembers: opts.chainMembers } }, why: "Test the chain limit" });
  if (opts.chainDepth) f.k.store.db.prepare("UPDATE tavern_settings SET data=json_set(data,'$.user.keepers.chainDepth',?) WHERE id=1").run(opts.chainDepth);
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

it("defaults to twelve linked party seats and validates integer settings without patch defaults", () => {
  expect(DEFAULT_SETTINGS.keepers.chainMembers).toBe(12);
  for (const patch of [{ chainDepth: 2 }, { chainMembers: 1001 }, { chainMembers: 1.5 }])
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
  const report = { status: "done", outcome: "Result", evidence: [], artifacts: [] };
  await expect(f.harness.behavior.invokeAgentTool("tavern_report", report, { threadId: "lead" })).rejects.toThrow("Only a Tavern member");
  await expect(f.harness.behavior.invokeAgentTool("tavern_report", report, { threadId: member.threadId })).rejects.toThrow(/open child quest/);
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

it.each([false, true])("stops the chain depth first and retries a failed inner stop (host archive: %s)", async hostArchive => {
  const f = await fixture(["w1"], { chainDepth: 2, slotDepth: 2 });
  const lead = await f.runtime.hire("lead", "project", request(f.q.id));
  const child = await f.k.openQuest(lead.threadId, "Child stages", "Child");
  const token = "legacy-hire", linkId = "legacy-seat";
  const seat = f.k.store.get("leadLinks", lead.leadLinkId!)!;
  const owner = { keeperThreadId: lead.threadId, boardQuestId: child.id, waypointId: "w1", errand: false, title: "Legacy nested seat", brief };
  f.k.store.put("leadLinks", linkId, { ...seat, id: linkId, hireToken: token, parentKeeperThreadId: lead.threadId, parentQuestId: child.id,
    childKeeperThreadId: null, childQuestId: null, state: "reserved" });
  f.k.store.put("hires", token, { classId: "keeper", characterId: null, projectId: "project", leadLinkId: linkId, owner, createdAt: f.time(), initialInput: "Legacy brief" });
  const inner = f.k.bind("legacy-inner", "keeper", null, "project", owner, token);
  f.runtime.spawnBriefDelivered(inner.threadId);
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

it("loads historical chain depth without exposing it as a live setting", async () => {
  const f = await fixture(["w1"], { chainDepth: 3 });
  expect(f.runtime.config().keepers).not.toHaveProperty("chainDepth");
  expect(f.runtime.settings!.snapshot().user).not.toHaveProperty("keepers.chainDepth");
  expect(settingsPatchSchema.safeParse({ keepers: { chainDepth: 3 } }).success).toBe(false);
});

const client = { experimental_caller: { kind: "client" as const }, experimental_signal: new AbortController().signal };

it("binds the accepted side choice once, forwards only the exact steer, and returns a routine result to Answers", async () => {
  const f = await fixture(["w1", "w2"]);
  registerTools(f.bb, f.runtime);
  const tools = f.harness.behavior;
  f.k.receiveUser("lead", "Publish the guide. Keep the old URL.");
  const outside = f.k.route("lead", { kind: "new-quest", summary: "Publish", notes: [] });
  const card = f.k.offerQuestStart("lead", outside.id);
  const input = { ...request(f.q.id), sideQuestAskId: card.id };
  await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/answered/i);
  await rpcHandlers(f.runtime).answerAsk({ askId: card.id, optionId: "side-quest", note: null, via: "page" }, client);
  const member = await f.runtime.hire("lead", "project", input);
  expect(f.k.store.leadLinksBy("parentQuestId", f.q.id)[0]).toMatchObject({ sideQuestAskId: card.id });
  expect(JSON.stringify(f.harness.inspection.sdk.callsTo("threads.spawn"))).toContain("Publish the guide. Keep the old URL.");
  expect((await f.runtime.hire("lead", "project", input)).threadId).toBe(member.threadId);
  await expect(f.runtime.hire("lead", "project", { ...input, waypointId: "w2" })).rejects.toThrow(/reserved|waypoint/i);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.k.openingGoalHint(member.threadId)).toContain("You are a side Keeper");
  const child = await f.k.openQuest(member.threadId, "Publish the guide", "Guide");
  expect(f.k.store.runtime(member.threadId).pending).toEqual([]);
  f.k.receiveUser("lead", "Move the new guide to /handbook; leave /guide in place.");
  const steer = f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Move it", notes: [] });
  f.k.bind("other-keeper", "keeper", null, "project");
  await expect(f.runtime.tell("other-keeper", member.threadId, "Forwarding this change", undefined, undefined, undefined, steer.id)).rejects.toThrow(/own party/i);
  await expect(f.runtime.tell("lead", member.threadId, "Forwarding this change", undefined, undefined, undefined, outside.id)).rejects.toThrow(/steer/i);
  await expect(tools.invokeAgentTool("tavern_tell", { member: member.threadId, text: "Forwarding this change", sourceRouteId: steer.id }, { threadId: "lead" })).resolves.toContain("Brief delivered");
  const manifest = f.k.store.runtime(member.threadId).requestSources!;
  expect(manifest.sources.map(source => source.routeId)).toEqual([steer.id]);
  expect(readRequestSources(f.k, member.threadId, { manifestId: manifest.id }).text).toBe("Move the new guide to /handbook; leave /guide in place.");
  const report = await tools.invokeAgentTool("tavern_report", { status: "done", outcome: "Guide moved.", sourceRouteId: steer.id, evidence: [], artifacts: [] }, { threadId: member.threadId });
  expect(report).toContain("Report written");
  expect(f.k.store.query("reports", "boardQuestId", f.q.id)).toEqual([expect.objectContaining({ memberThreadId: member.threadId, childQuestId: child.id, waypointId: null })]);
  expect(f.k.member(member.threadId)?.engagement).toBe("active");
  expect(f.k.summary(f.q.id).waypoints[0]?.state).not.toMatch(/reported|verified|done/);
  const draft = { boardQuestId: f.q.id, title: "Guide moved", body: "The guide now lives under /handbook.", links: [], answers: [steer.id] };
  expect(() => f.k.postSummary("lead", { ...draft, childQuestId: f.q.id })).toThrow(/only a side quest/);
  const push = vi.spyOn(f.runtime, "push").mockResolvedValue(undefined);
  await tools.invokeAgentTool("tavern_summary", { ...draft, childQuestId: child.id }, { threadId: "lead" });
  expect(push).toHaveBeenCalledExactlyOnceWith("lead", "New Keeper answer", draft.title, undefined, "answer");
  const answer = f.k.store.all("summaries").find(summary => summary.childQuestId === child.id)!;
  expect(() => f.k.postSummary("lead", { ...draft, childQuestId: child.id })).toThrow(/already has an answer/);
  expect(() => f.k.postSummary("lead", draft)).toThrow(/already has an answer/);
  expect(f.k.postSummary("lead", { ...draft, childQuestId: child.id, supersedes: answer.id })).toMatchObject({ supersedes: answer.id });
  expect(searchAnswers(f.k.store, "Guide moved", 10, f.q.id).answers).toEqual(expect.arrayContaining([expect.objectContaining({ id: answer.id, childQuestId: child.id })]));
});

it("refuses a side seat in a child despite historical depth settings", async () => {
  const f = await fixture(["w1"], { chainDepth: 2, slotDepth: 2 });
  const lead = await f.runtime.hire("lead", "project", request(f.q.id));
  const child = await f.k.openQuest(lead.threadId, "Child work", "Child");
  expect(() => f.k.plan(lead.threadId, leadPlan(child.id, ["w1"], 2))).toThrow(/side Keeper.*Keeper/i);
  await expect(f.runtime.hire(lead.threadId, "project", request(child.id))).rejects.toThrow(/side Keeper.*Keeper/i);
  expect(f.k.store.all("leadLinks")).toHaveLength(1);
});

it("rejects a parent return with a running side Keeper and stops only the side Keeper on a direct stop", async () => {
  const f = await fixture();
  const lead = await f.runtime.hire("lead", "project", request(f.q.id));
  const child = await f.k.openQuest(lead.threadId, "Child work", "Child");
  const stopped: string[] = [];
  f.bb.sdk.threads.stop = async ({ threadId }) => { stopped.push(threadId); return { ok: true }; };
  await expect(f.runtime.proposeWrap("lead", f.q.id, "Done", "Nothing")).rejects.toThrow(/side quest/i);
  await f.runtime.stop(child.id);
  expect(stopped).toEqual([lead.threadId]);
  expect(f.k.quest(f.q.id).phase).toBe("build");
  expect(f.k.quest(child.id).phase).toBe("stopped");
  expect(f.k.store.all("leadLinks")[0]?.result).toBeUndefined();
});

it.each(["parent", "child"] as const)("won't forward a steer while the %s has reached its spend cap", async cap => {
  const f = await fixture();
  const lead = await f.runtime.hire("lead", "project", request(f.q.id));
  const child = await f.k.openQuest(lead.threadId, "Child work", "Child");
  const id = cap === "parent" ? f.q.id : child.id;
  f.k.store.put("quests", id, { ...f.k.quest(id), spendBudget: { cents: 100, reached: { at: f.time(), usdNanos: 1_000_000_000 } } });
  f.k.receiveUser("lead", "Review the glossary as well.");
  const route = f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Glossary", notes: [] });
  await expect(f.runtime.tell("lead", lead.threadId, "Review the glossary", undefined, undefined, undefined, route.id)).rejects.toThrow(/spend budget/);
  expect(f.harness.inspection.sdk.callsTo("threads.send").filter(call => (call.args[0] as { threadId: string }).threadId === lead.threadId)).toHaveLength(0);
});

it("stops a root Keeper and its side Keeper once each in the same Stop all receipt", async () => {
  const f = await fixture();
  const lead = await f.runtime.hire("lead", "project", request(f.q.id));
  await f.k.openQuest(lead.threadId, "Child work", "Child");
  const stopped: string[] = [];
  f.bb.sdk.threads.stop = async ({ threadId }) => { stopped.push(threadId); return { ok: true }; };
  const result = await f.runtime.stopAll.stop({ kind: "agent", threadId: "lead" });
  expect(stopped.sort()).toEqual(["lead", lead.threadId].sort());
  expect(result).toMatchObject({ state: "stopped", receipt: { stopped: 2, failed: 0 } });
});

it("cancels an in-flight side brief when Stop all stops the lead and child", async () => {
  const f = await fixture();
  const lead = await f.runtime.hire("lead", "project", request(f.q.id));
  await f.k.openQuest(lead.threadId, "Child work", "Child");
  f.k.receiveUser("lead", "Review the glossary as well.");
  const route = f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Glossary", notes: [] });
  let started!: () => void, finish!: () => void;
  const startedDelivery = new Promise<void>(resolve => { started = resolve; });
  const finishDelivery = new Promise<void>(resolve => { finish = resolve; });
  const send = f.bb.sdk.threads.send.bind(f.bb.sdk.threads);
  vi.spyOn(f.bb.sdk.threads, "send").mockImplementation(async args => {
    if (args.threadId === lead.threadId) {
      started();
      await finishDelivery;
    }
    return send(args);
  });
  const before = f.k.store.runtime(lead.threadId).requestSources;
  const tell = f.runtime.tell("lead", lead.threadId, "Review the glossary", undefined, undefined, undefined, route.id);
  await startedDelivery;
  try { await f.runtime.stopAll.stop({ kind: "agent", threadId: "lead" }); }
  finally { finish(); }
  await expect(tell).resolves.toMatchObject({ status: "cancelled" });
  expect(f.k.store.runtime(lead.threadId).requestSources).toEqual(before);
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
