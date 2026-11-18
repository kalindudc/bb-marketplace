// @vitest-environment node
import { expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput, putQuestFixture, seedQuest } from "./support";

async function legacyQuest(f: ReturnType<typeof setup>) {
  const template = await seedQuest(f.k, "lead", "Template", "Template");
  const quest = { ...template, id: "legacy-q", title: "Legacy", short: "Legacy" };
  putQuestFixture(f.k.store, quest.id, quest);
  return quest;
}

it.each(["no-events", "legacy-phase", "greenlight-answer"])("N1 reopens a pre-upgrade finished quest with fresh words: %s", async history => {
  const f = setup(), q = await legacyQuest(f);
  putQuestFixture(f.k.store, q.id, { ...q, phase: "stopped", updatedAt: f.time() + 10, endedAt: f.time() + 10 });
  if (history === "legacy-phase") f.k.store.event(f.time() + 20, "lead", q.id, "quest.stopped", "Old stop");
  if (history === "greenlight-answer") {
    f.k.store.put("asks", "old-approval", { id: "old-approval", keeperThreadId: "lead", boardQuestId: q.id, kind: "greenlight", question: "Approve?", why: "Party", options: [{ id: "approve", label: "Approve", detail: "Go", recommended: true }], meanwhile: "Wait", holds: [], draft: null, createdAt: f.time(), proceedAt: null, state: "answered", answer: { optionId: "approve", note: null, via: "page", by: "user", at: f.time() + 20 } });
    f.k.store.event(f.time() + 20, "lead", q.id, "ask.answered", "Approved", { askId: "old-approval", optionId: "approve" });
  }
  f.advance(30); f.k.receiveUser("lead", "Reopen Legacy");
  const route = f.k.route("lead", { kind: "steer", boardQuestId: q.id, summary: "Reopen", notes: [] });
  expect(f.k.reopenQuest(q.id, { kind: "agent", threadId: "lead" }, route.sourceMessageId!).phase).toBe("scout");
});
it.each(["quest.opened", "plan.proposed", "quest.phase", "quest.stopping", "quest.stopped", "quest.wrapped", "quest.reopened"])("N1 refuses words older than the latest legacy %s event", async type => {
  const f = setup(), q = await legacyQuest(f);
  putQuestFixture(f.k.store, q.id, { ...q, phase: "stopped" });
  f.advance(1); f.k.receiveUser("lead", "Reopen Legacy"); const route = f.k.route("lead", { kind: "steer", boardQuestId: q.id, summary: "Reopen", notes: [] });
  f.advance(1); f.k.store.event(f.time(), "lead", q.id, type, "Old phase move");
  expect(() => f.k.reopenQuest(q.id, { kind: "agent", threadId: "lead" }, route.sourceMessageId!)).toThrow(/newer than/);
});
it.each([[0, "20:24"], [2, "Tue 20:24"], [9, "10 Nov 20:24"]] as const)("N2 uses a human move-line time after %s days", async (days, expected) => {
  const f = setup(); const heldAt = new Date(2026, 10, 19 - days, 20, 24).getTime(); f.advance(heldAt - f.time());
  const q = await seedQuest(f.k, "lead", "Clock", "Clock"); f.k.setQuestHeld(q.id, true, { kind: "user" });
  f.advance(new Date(2026, 10, 19, 21, 0).getTime() - f.time());
  expect(f.k.summary(q.id).move.text).toBe(`Held by you since ${expected} · Resume`);
});
it.each(["done", "stopped"] as const)("N3 withdraws a stray conclude ask without reviving %s", async phase => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Finished", "Finished");
  f.k.plan("lead", { ...planInput(q.id), waypoints: [{ ...planInput(q.id).waypoints[0]!, optional: true }] });
  f.k.answerAsk(f.k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
  const ask = await f.runtime.proposeWrap("lead", q.id, "Done", "", [{ waypointId: "w1", reason: "Optional" }]);
  putQuestFixture(f.k.store, q.id, { ...f.k.quest(q.id), phase }); await f.runtime.reconcile();
  expect(f.k.quest(q.id).phase).toBe(phase); expect(f.k.store.get("asks", ask.askId!)?.state).toBe("withdrawn");
  expect(f.k.store.events("lead").some(e => e.type === "ask.withdrawn" && e.data.askId === ask.askId && e.data.cause === "conclude-stale-at-upgrade")).toBe(true);
});
it.each(["resume", "stop"])("N4 keeps constant-size held state and delivers retained news after %s", async action => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Hold", "Hold"); f.k.setQuestHeld(q.id, true, { kind: "user" });
  const before = JSON.stringify(f.k.store.runtime("lead"));
  for (let i = 0; i < 250; i++) f.k.store.event(f.time(), "lead", q.id, "journal.changed", `Churn ${i}`);
  f.k.store.event(f.time(), "lead", q.id, "promise.due", "CURSOR_NEWS");
  f.k.store.patch("lead", { userAt: null });
  for (let i = 0; i < 4; i++) { f.advance(61_000); await f.runtime.tick("lead"); }
  expect(JSON.stringify(f.k.store.runtime("lead")).length - before.length).toBeLessThan(100);
  if (action === "stop") await f.runtime.stop(q.id); else f.k.setQuestHeld(q.id, false, { kind: "user" });
  f.advance(61_000); await f.runtime.tick("lead");
  const packets = f.harness.inspection.sdk.callsTo("threads.send").map(c => JSON.stringify(c.args[0])).join("\n");
  expect(packets.match(/CURSOR_NEWS/g)).toHaveLength(1);
  expect(f.k.store.runtime("lead").heldNewsCursors?.[q.id]).toBeUndefined();
  f.advance(61_000); await f.runtime.tick("lead");
  expect(f.harness.inspection.sdk.callsTo("threads.send").map(c => JSON.stringify(c.args[0])).join("\n").match(/CURSOR_NEWS/g)).toHaveLength(1);
});
