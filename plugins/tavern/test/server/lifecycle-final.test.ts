// @vitest-environment node
import { seedQuest } from "./support";
import { expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { makeThreadResponse } from "./host";
import { rpcHandlers } from "../../src/server/rpc";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null };
const askInput = { kind: "decision" as const, question: "Proceed?", why: "Choice", options: [{ id: "yes", label: "Yes", detail: "", recommended: true }], reversible: true, meanwhile: "Wait", holds: [] };
async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.plan("lead", { ...planInput(q.id), waypoints: planInput(q.id).waypoints.map(w => ({ ...w, optional: true })) });
  f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Build", brief });
  return { ...f, q, wrap: () => f.runtime.wrap("lead", q.id, "Done", "", [{ waypointId: "w1", reason: "Optional" }]) };
}
it("wrap withdraws every open ask without an away window and never defaults it", async () => {
  const f = await fixture();
  const ask = f.k.ask("lead", { ...askInput, boardQuestId: f.q.id, proceedInMinutes: 1 });
  await f.wrap();
  expect(f.k.store.get("asks", ask.id)?.state).toBe("withdrawn");
  f.advance(120_000);
  f.k.defaults();
  expect(f.k.store.events("lead").filter(e => e.type === "ask.defaulted")).toHaveLength(0);
});
it.each(["stopped", "stopping"] as const)("wrap refuses a %s quest without rewriting its final state", async phase => {
  const f = await fixture();
  f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase, endedAt: phase === "stopped" ? 99 : null });
  await expect(f.wrap()).rejects.toThrow(/stopped|stopping/);
  expect(f.k.quest(f.q.id).phase).toBe(phase);
});
it.each(["released", "failed", "stopped"] as const)("wrap leaves %s members and their threads alone", async state => {
  const f = await fixture();
  if (state === "released") f.k.store.patch("child", { released: { reason: "Done here", decisionId: "d" } });
  else f.k.store.put("members", "child", { ...f.k.member("child")!, state });
  const before = f.k.member("child");
  await f.wrap();
  expect(f.k.member("child")?.state).toBe(before?.state);
  expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
});
it.each(["done", "stopped", "stopping"] as const)("all Keeper write paths refuse a %s quest", async phase => {
  const f = await fixture();
  f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase });
  const actions = [
    () => f.k.ask("lead", { ...askInput, boardQuestId: f.q.id }),
    () => f.k.decide("lead", { boardQuestId: f.q.id, text: "Do it", why: "Small", reversible: true, source: "keeper" }),
    () => f.k.memory.note("lead", { boardQuestId: f.q.id, kind: "commitment", text: "Later", dueAt: f.time() + 1000 }),
    () => f.k.memory.gate("lead", { boardQuestId: f.q.id, waypointId: "w1", askedWho: "Human", via: "chat" }),
    () => f.k.validateRoute("lead", "steer", f.q.id),
    () => f.k.addRule({ scope: "quest", scopeId: f.q.id, text: "Checks", source: "keeper-proposed" }, "lead"),
  ];
  for (const action of actions) expect(action).toThrow(/ended|stopping|stopped|returned/);
});
it.each(["done", "stopped", "released", "ended"] as const)("stores a late report from %s without reviving the member or notifying the Keeper", async state => {
  const f = await fixture();
  if (state === "released") f.k.store.patch("child", { released: { reason: "Done", decisionId: "d" } });
  else if (state === "ended") f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
  else f.k.store.put("members", "child", { ...f.k.member("child")!, state });
  const before = f.k.member("child")?.state;
  const report = f.k.report("child", { status: "blocked", outcome: "Late", evidence: [], artifacts: [], confidence: { intent: 100, safe: 100 }, voice: null });
  expect(f.k.store.get("reports", report.id)).not.toBeNull();
  expect(f.k.member("child")?.state).toBe(before);
  expect(f.k.store.events("lead").some(e => e.type === "report.filed")).toBe(false);
  expect(f.k.store.events("lead").some(e => e.type === "report.late")).toBe(true);
});
it("waiting activity cannot reopen a done member and thread updates cannot reopen ended work", async () => {
  const f = await fixture();
  f.k.activity("child", "done");
  f.k.activity("child", "waiting");
  expect(f.k.member("child")?.state).toBe("done");
  f.k.store.put("members", "child", { ...f.k.member("child")!, state: "stopped" });
  f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "stopped", endedAt: f.time() });
  f.runtime.updateThread(makeThreadResponse({ id: "child", status: "idle" }));
  expect(f.k.member("child")?.state).toBe("stopped");
});
it("archive and journal housekeeping do not resume a manually stopped Keeper", async () => {
  const f = await fixture();
  f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
  f.k.store.patch("lead", { manualStopAt: f.time() });
  f.k.archiveQuests([f.q.id], true);
  expect(f.k.store.runtime("lead").manualStopAt).toBe(f.time());
  await rpcHandlers(f.runtime).journalEdit({ threadId: "child", edit: { op: "add", descriptions: ["Keep notes"], parentId: null } });
  expect(f.k.store.runtime("lead").manualStopAt).toBe(f.time());
});
