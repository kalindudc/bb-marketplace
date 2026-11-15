// @vitest-environment node
import { seedQuest } from "./support";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { planInput, waypointEntry } from "./support";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import { LIMITS } from "../../src/server/limits";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null };
const slot = { classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] };
async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  return { ...f, q };
}
function settings(f: ReturnType<typeof setup>) {
  const store = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(store, new InsightsReader(f.k.store.db, store, f.time));
  return store;
}
function bind(f: Awaited<ReturnType<typeof fixture>>) {
  return f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", errand: false, title: "Build", brief });
}
it("undoing an automatic approval cannot reopen a stopping quest or release its pending member", async () => {
  const f = await fixture();
  f.k.settings = () => ({ ...DEFAULT_SETTINGS, keepers: { ...DEFAULT_SETTINGS.keepers, greenlight: "by-size" } });
  f.k.plan("lead", { ...planInput(f.q.id), reversible: true, party: [slot] });
  const decision = f.k.store.query("decisions", "boardQuestId", f.q.id)[0]!;
  bind(f);
  f.k.activity("child", "working");
  let status: "active" | "idle" = "active";
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, status: threadId === "child" ? status : "idle" }));
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopping", unconfirmed: 1 });
  const stoppingSince = f.k.quest(f.q.id).stoppingSince;
  await f.runtime.undoDecision(decision.id);
  expect(f.k.quest(f.q.id)).toMatchObject({ phase: "stopping", greenlitVersion: 1, stoppingSince });
  expect(f.k.store.openAsks("lead", f.q.id)).toHaveLength(0);
  expect(f.k.store.runtime("child").released).toBeFalsy();
  expect(f.k.member("child")?.stopPending).toBe(true);
  status = "idle";
  await f.runtime.retryStops("lead", f.q.id, true);
  expect(f.k.quest(f.q.id).phase).toBe("stopped");
});
it("tuning refuses a stopping quest without storing an override", async () => {
  const f = await fixture();
  const store = settings(f), override = vi.spyOn(store, "override");
  f.k.recordStop(f.q.id);
  expect(() => f.runtime.tune("lead", f.q.id, { staleMinutes: 30 }, "Wait longer")).toThrow(/ended|stopping/);
  expect(override).not.toHaveBeenCalled();
});
it("visible reviews retain manually stopped Keepers while the automatic hire budget excludes them", async () => {
  const f = await fixture();
  f.k.plan("lead", planInput(f.q.id));
  bind(f);
  f.port.linkedEntries = () => [waypointEntry("child", f.q.id)];
  f.k.store.patch("lead", { manualStopAt: f.time() });
  expect(f.runtime.review()).toMatchObject({ waiting: 1, items: [{ boardQuestId: f.q.id }] });
  expect(f.runtime.review("automatic").waiting).toBe(0);
  f.k.store.patch("lead", { archivedAt: f.time() });
  expect(f.runtime.review().waiting).toBe(0);
});
it("a stopping quest projects no next step or unasked outside-gate reminder", async () => {
  const f = await fixture();
  const plan = planInput(f.q.id);
  f.k.plan("lead", { ...plan, party: [], waypoints: plan.waypoints.map(w => ({ ...w, actor: "outside" as const })) });
  f.k.answerAsk(f.k.store.openAsks("lead")[0]!.id, "approve", null, "page");
  expect(f.k.memory.unaskedGateEntries("lead")).toHaveLength(1);
  f.k.recordStop(f.q.id);
  expect(f.k.summary(f.q.id).move).toEqual({ who: "nobody", text: "Stopping" });
  expect(f.k.memory.unaskedGateEntries("lead")).toHaveLength(0);
  expect(f.k.restatement("lead")).toContain("Next link: Stopping");
  expect(f.k.restatement("lead")).not.toContain("Next link: w1:");
});
it.each(["active", "stopping"] as const)("Stop discovers a cached done member whose host is %s and waits for confirmation", async running => {
  const f = await fixture();
  bind(f);
  f.k.activity("child", "done");
  let status: typeof running | "idle" = running;
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, status: threadId === "child" ? status : "idle" }));
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopping", unconfirmed: 1 });
  expect(f.bb.sdk.threads.stop).toHaveBeenCalledWith({ threadId: "child" });
  expect(f.k.member("child")?.stopPending).toBe(true);
  status = "idle";
  await f.runtime.retryStops("lead", f.q.id, true);
  expect(f.k.quest(f.q.id).phase).toBe("stopped");
});
it("Stop verifies an idle cached done member without interrupting it", async () => {
  const f = await fixture();
  bind(f);
  f.k.activity("child", "done");
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopped", unconfirmed: 0 });
  expect(f.bb.sdk.threads.get).toHaveBeenCalledWith({ threadId: "child" });
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
});
it("a failed fresh lookup of a done member keeps Stop pending and surfaces its error", async () => {
  const f = await fixture();
  bind(f);
  f.k.activity("child", "done");
  f.bb.sdk.threads.get = vi.fn(async () => { throw new Error("host unavailable"); });
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopping", unconfirmed: 1 });
  expect(f.k.member("child")?.stopError).toContain("host unavailable");
  expect(f.bb.sdk.threads.get).toHaveBeenCalledTimes(1);
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
});
it.each(["archivedAt", "deletedAt", "not-found"] as const)("Stop verifies a cached done member is %s without stopping it", async gone => {
  const f = await fixture();
  bind(f);
  f.k.activity("child", "done");
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => {
    if (gone === "not-found") throw Object.assign(new Error("Missing"), { status: 404 });
    return makeThreadResponse({ id: threadId, [gone]: f.time(), status: "active" });
  });
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopped", unconfirmed: 0 });
  expect(f.bb.sdk.threads.get).toHaveBeenCalledWith({ threadId: "child" });
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
});
it("Stop remains unconfirmed while a done member's rebrief send is still in flight", async () => {
  const f = await fixture();
  bind(f);
  f.k.activity("child", "done");
  let accept!: () => void;
  const sent = new Promise<{ ok: true; delivery: "sent" }>(resolve => { accept = () => resolve({ ok: true, delivery: "sent" }); });
  f.bb.sdk.threads.send = vi.fn(() => sent);
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  const telling = f.runtime.tell("lead", "child", "Again").catch(error => error as Error);
  await vi.waitFor(() => expect(f.bb.sdk.threads.send).toHaveBeenCalledTimes(1));
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopping", unconfirmed: 1 });
  accept();
  await telling;
  await f.runtime.retryStops("lead", f.q.id, true);
  expect(f.k.quest(f.q.id).phase).toBe("stopped");
});
it("overlapping Stop calls share one confirmation and write one final event", async () => {
  const f = await fixture();
  bind(f);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => { await gate; return makeThreadResponse({ id: threadId, status: "idle" }); });
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  const first = f.runtime.stop(f.q.id);
  await vi.waitFor(() => expect(f.bb.sdk.threads.get).toHaveBeenCalled());
  const second = f.runtime.stop(f.q.id);
  release();
  await Promise.all([first, second]);
  expect(f.bb.sdk.threads.stop).toHaveBeenCalledTimes(1);
  expect(f.k.store.events("lead").filter(event => event.type === "quest.stopped")).toHaveLength(1);
});
it("an unidentified pending hire is listed and raises one retryable Stop blocker after two minutes", async () => {
  const f = await fixture();
  f.k.store.put("hires", "unidentified", { classId: "smith", characterId: null, projectId: "project", createdAt: f.time(), owner: { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", errand: false, title: "Unidentified build hire", brief } });
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopping", unconfirmed: 1 });
  expect(f.k.summary(f.q.id).stopPendingHires).toEqual([{ token: "unidentified", classId: "smith", title: "Unidentified build hire" }]);
  expect(f.k.store.openAsks("lead", f.q.id)).toHaveLength(0);
  f.advance(120_000);
  await f.runtime.retryStops("lead");
  await f.runtime.retryStops("lead");
  const asks = f.k.store.openAsks("lead", f.q.id);
  expect(asks).toHaveLength(1);
  expect(asks[0]?.why).toContain("Unidentified build hire");
  expect(asks[0]?.why).toContain("may have started a thread");
  expect(asks[0]?.options.map(option => option.id)).toEqual(["retry"]);
  f.advance(LIMITS.hireGraceMs);
  f.bb.sdk.threads.list = vi.fn(async () => { throw new Error("Child scan limit reached; reservation retained"); });
  await expect(f.runtime.answerAsk(asks[0]!.id, "retry", null, "page")).resolves.toBeUndefined();
  expect(f.bb.sdk.threads.list).toHaveBeenCalled();
  expect(f.k.quest(f.q.id).phase).toBe("stopping");
});
it("a pending-hire Stop blocker withdraws itself after recovery clears the reservation", async () => {
  const f = await fixture();
  f.k.store.put("hires", "unidentified", { classId: "smith", characterId: null, projectId: "project", createdAt: f.time(), owner: { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", errand: false, title: "Unidentified build hire", brief } });
  await f.runtime.stop(f.q.id);
  f.advance(120_000);
  await f.runtime.retryStops("lead");
  const ask = f.k.store.openAsks("lead", f.q.id)[0];
  expect(ask).toBeDefined();
  f.k.store.remove("hires", "unidentified");
  await f.runtime.retryStops("lead");
  expect(f.k.quest(f.q.id).phase).toBe("stopped");
  expect(f.k.store.get("asks", ask!.id)?.state).toBe("withdrawn");
});
it.each(["member", "hire"] as const)("the real sweep retains a %s Stop blocker through defaults until confirmation", async kind => {
  const f = await fixture();
  let status: "active" | "idle" = "active";
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, status: threadId === "child" ? status : "idle" }));
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  if (kind === "member") bind(f);
  else f.k.store.put("hires", "unidentified", { classId: "smith", characterId: null, projectId: "project", createdAt: f.time(), owner: { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", errand: false, title: "Unidentified build hire", brief } });
  await f.runtime.stop(f.q.id);
  const defaults = vi.spyOn(f.k, "defaults");
  f.advance(120_000);
  await f.runtime.sweep();
  expect(defaults).toHaveBeenCalledWith("lead", expect.any(Function));
  const asks = f.k.store.openAsks("lead", f.q.id);
  expect(asks).toHaveLength(1);
  const ask = asks[0]!;
  expect(f.k.store.get("askMeta", ask.id)).toMatchObject(kind === "member" ? { stopMemberThreadId: "child" } : { stopHireTokens: ["unidentified"] });
  f.advance(10_000);
  await f.runtime.sweep();
  expect(defaults).toHaveBeenCalledTimes(2);
  expect(f.k.store.get("asks", ask.id)?.state).toBe("open");
  expect(f.k.store.openAsks("lead", f.q.id).map(row => row.id)).toEqual([ask.id]);
  status = "idle";
  if (kind === "hire") f.k.store.remove("hires", "unidentified");
  f.advance(15_000);
  await f.runtime.sweep();
  expect(f.k.quest(f.q.id).phase).toBe("stopped");
  expect(f.k.store.get("asks", ask.id)?.state).toBe("withdrawn");
});
it("the Keeper ledger uses the automatic review count while the user keeps the present count", async () => {
  const f = await fixture();
  f.k.plan("lead", planInput(f.q.id));
  bind(f);
  f.port.linkedEntries = () => [waypointEntry("child", f.q.id)];
  f.k.store.patch("lead", { manualStopAt: f.time() });
  f.k.bind("observer", "keeper", "wren", "project");
  expect(f.runtime.review().waiting).toBe(1);
  expect(f.k.memory.review().waiting).toBe(0);
  expect(f.k.restatement("observer")).toContain("Review queue: 0 of 3");
});
it("the Keeper tick uses the automatic review count while the user keeps the present count", async () => {
  const f = await fixture();
  f.k.plan("lead", planInput(f.q.id));
  bind(f);
  f.port.linkedEntries = () => [waypointEntry("child", f.q.id)];
  f.k.store.patch("lead", { manualStopAt: f.time() });
  f.k.bind("observer", "keeper", "wren", "project");
  f.k.store.event(f.time(), "observer", null, "promise.due", "Review the pending fact");
  expect(f.runtime.review().waiting).toBe(1);
  await f.runtime.tick("observer");
  const sent = f.harness.inspection.sdk.callsTo("threads.send").map(call => (call.args[0] as { input: { text: string }[] }).input[0]!.text);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Review queue: 0 of 3");
  expect(sent[0]).not.toContain("Review queue: 1 of 3");
});
it("a cancelled reservation does not consume the live party budget", async () => {
  const f = await fixture();
  settings(f).update({ revision: 0, patch: { keepers: { partyMax: 1 } }, why: "One live member" });
  f.k.plan("lead", { ...planInput(f.q.id), party: [slot] });
  f.k.answerAsk(f.k.store.openAsks("lead")[0]!.id, "approve", null, "page");
  f.k.store.put("hires", "cancelled", { classId: "smith", characterId: null, projectId: "project", createdAt: f.time(), cancelledAt: f.time(), owner: { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", errand: false, title: "Old cancelled hire", brief } });
  await expect(f.runtime.hire("lead", "project", { classId: "smith", title: "Build", boardQuestId: f.q.id, waypointId: "w1", brief })).resolves.toMatchObject({ role: "member" });
});
