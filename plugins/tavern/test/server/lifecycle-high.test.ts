// @vitest-environment node
import { seedQuest } from "./support";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null };
async function party() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Build", brief });
  return { ...f, q };
}
it.each(["confirm", "widen"] as const)("%s a broad rule only resumes its own Keeper", action => {
  const { k } = setup();
  k.bind("other", "keeper", "wren", "project");
  k.store.patch("other", { manualStopAt: k.now() });
  k.store.patch("lead", { manualStopAt: k.now() });
  const rule = k.addRule({ scope: action === "confirm" ? "global" : "keeper", scopeId: action === "confirm" ? null : "lead", text: "Run checks", source: "keeper-proposed" }, "lead");
  if (action === "confirm") k.confirmRule(rule.id, true); else k.widenRule(rule.id, "global");
  expect(k.store.runtime("other").manualStopAt).toBe(k.now());
  expect(k.store.runtime("lead").manualStopAt).toBeNull();
});
it.each(["done", "stopped"] as const)("drops pending briefs after a quest is %s", async phase => {
  const f = await party();
  f.k.store.patch("child", { pendingBrief: { id: "old", text: "Again", attempts: 0, nextAttemptAt: 0, attemptedAt: null, hostAfterSeq: null, error: null } });
  f.k.store.put("quests", f.q.id, { ...f.q, phase, endedAt: f.time() });
  await f.runtime.retryInitialBriefs("lead");
  expect(f.k.store.runtime("child").pendingBrief).toBeNull();
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(f.k.store.events("lead").some(event => event.type === "member.brief-refused" && event.data.memberThreadId === "child")).toBe(true);
});
it.each(["archivedAt", "deletedAt"] as const)("checks current host %s immediately before sending a brief", async field => {
  const f = await party();
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, [field]: f.time() }));
  await expect(f.runtime.sendRebrief("child", "Again")).rejects.toThrow(/can't take new work/);
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(f.k.store.runtime("child").pendingBrief).toBeNull();
});
it("a deleted Keeper withdraws asks, records deletion and clears failure state", () => {
  const f = setup();
  const ask = f.k.ask("lead", { kind: "blocker", question: "Retry?", why: "Failed", options: [{ id: "retry", label: "Retry", detail: "", recommended: true }], meanwhile: "Wait", holds: [] });
  f.k.store.patch("lead", { failureCount: 2, tickRefusalCount: 2, failureAskId: ask.id });
  f.runtime.updateThread(makeThreadResponse({ id: "lead", deletedAt: f.time(), archivedAt: null }));
  expect(f.k.store.runtime("lead")).toMatchObject({ deletedAt: f.time(), archivedAt: f.time(), failureCount: 0, tickRefusalCount: 0, failureAskId: null });
  expect(f.k.store.get("asks", ask.id)?.state).toBe("withdrawn");
});
it("withdraws a Keeper's asks when fresh host reads confirm it is not found", async () => {
  const f = setup();
  const ask = f.k.ask("lead", { kind: "blocker", question: "Retry?", why: "Failed", options: [{ id: "retry", label: "Retry", detail: "", recommended: true }], meanwhile: "Wait", holds: [] });
  f.k.store.patch("lead", { failureCount: 2, failureAskId: ask.id });
  f.bb.sdk.threads.get = vi.fn(async () => { throw Object.assign(new Error("thread missing"), { status: 404 }); });
  await f.runtime.sweep();
  expect(f.k.store.get("asks", ask.id)?.state).toBe("withdrawn");
  expect(f.k.store.runtime("lead")).toMatchObject({ failureCount: 0, failureAskId: null, deletedAt: f.time() });
});
it("persists only delivered rebrief text, once across repeated retries", async () => {
  const f = await party();
  f.runtime.spawnBriefDelivered("child");
  vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValueOnce(new Error("offline"));
  await f.runtime.sendRebrief("child", "New acceptance criteria");
  expect(JSON.stringify(f.k.store.runtime("child").brief)).not.toContain("New acceptance criteria");
  f.advance(61_000);
  await f.runtime.retryInitialBriefs("lead");
  await f.runtime.retryInitialBriefs("lead");
  const persisted = JSON.stringify(f.k.store.runtime("child").brief);
  expect(persisted.match(/New acceptance criteria/g)).toHaveLength(1);
  expect(persisted).toContain("Follow-up v2");
});
