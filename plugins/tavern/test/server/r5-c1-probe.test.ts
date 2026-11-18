// @vitest-environment node
import { expect, it } from "vitest";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest, putQuestFixture } from "./support";

async function closing() {
  const f = setup(); registerRpc(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Watch", "Watch");
  f.k.plan("lead", { ...planInput(q.id), waypoints: [{ ...planInput(q.id).waypoints[0]!, optional: true }] });
  f.k.answerAsk(f.k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
  const proposed = await f.runtime.proposeWrap("lead", q.id, "Done", "", [{ waypointId: "w1", reason: "Optional" }]);
  return { ...f, q, askId: proposed.askId! };
}
it.each(["conclude", "hold", "extensions"])("H1 adopts an upgrade conclude ask before %s", async option => {
  const f = await closing(); putQuestFixture(f.k.store, f.q.id, { ...f.k.quest(f.q.id), phase: "wrap" });
  await f.runtime.reconcile();
  expect(f.k.quest(f.q.id).phase).toBe("closing");
  expect(f.k.store.events("lead").find(e => e.data.cause === "conclude-open-at-upgrade")?.data.receipt).toMatchObject({ id: f.askId });
  await f.runtime.answerAsk(f.askId, option, null, "page", true);
  expect(f.k.quest(f.q.id).phase).toBe(option === "conclude" ? "done" : "build");
});
it("H1 refuses the whole answer when its phase effect is invalid", async () => {
  const f = await closing(); putQuestFixture(f.k.store, f.q.id, { ...f.k.quest(f.q.id), phase: "build" });
  await expect(f.runtime.answerAsk(f.askId, "conclude", null, "page", true)).rejects.toThrow();
  expect(f.k.store.get("asks", f.askId)?.state).toBe("open");
});
it("H2 defers held news until the first resumed tick", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch");
  f.k.setQuestHeld(q.id, true, { kind: "user" });
  f.k.store.patch("lead", { cursor: f.k.store.events("lead").at(-1)!.id, userAt: null });
  f.k.store.event(f.time(), "lead", q.id, "promise.due", "HELD_NEWS_MARKER");
  f.k.store.event(f.time(), "lead", null, "promise.due", "OTHER_NEWS");
  f.advance(61_000); await f.runtime.tick("lead");
  const packets = () => f.harness.inspection.sdk.callsTo("threads.send").map(c => JSON.stringify(c.args[0])).join("\n");
  expect(packets()).not.toContain("HELD_NEWS_MARKER");
  f.k.setQuestHeld(q.id, false, { kind: "user" }); f.advance(61_000); await f.runtime.tick("lead");
  expect(packets()).toContain("HELD_NEWS_MARKER");
});
it("H3 keeps held production asks on every RPC surface", async () => {
  const f = setup(); registerRpc(f.bb, f.runtime); const q = await seedQuest(f.k, "lead", "Watch", "Watch");
  const ask = f.k.ask("lead", { kind: "production", boardQuestId: q.id, question: "Deploy?", why: "Approval", meanwhile: "Wait", holds: [], options: [{ id: "yes", label: "Yes", detail: "Deploy", recommended: true }] });
  f.k.setQuestHeld(q.id, true, { kind: "user" });
  for (const [method, input, key] of [["room", {}, "asks"], ["boardQuest", { id: q.id }, "asks"], ["ledger", { threadId: "lead" }, "asks"]] as const) {
    const result = await f.harness.invokeRpc(method, input) as Record<string, { id: string }[]>;
    expect(result[key]!.some(a => a.id === ask.id)).toBe(true);
  }
});
it("M5 records withdrawal during archive", async () => {
  const f = await closing();
  f.runtime.updateThread({ ...await f.bb.sdk.threads.get({ threadId: "lead" }), archivedAt: f.time() });
  expect(f.k.quest(f.q.id).phase).toBe("build");
  expect(f.k.store.get("asks", f.askId)?.withdrawnCause).toBe("keeper-archived");
  expect(f.k.store.events("lead").find(e => e.data.cause === "conclude-withdrawn")?.data.receipt).toMatchObject({ id: f.askId });
});
it("M5 records conclude withdrawal in restored records", async () => {
  const source = await closing(), target = setup();
  source.k.store.patch("lead", { tickDeliveryAskId: source.askId });
  const records = (f: ReturnType<typeof setup>) => new BackupRecords(f.k.store.db, new SettingsStore(f.k.store.db), f.time);
  const snapshot = records(source).capture();
  target.k.store.db.exec("DELETE FROM tavern_records; DELETE FROM tavern_events; DELETE FROM tavern_runtime;");
  records(target).restore(snapshot);
  expect(target.k.quest(source.q.id).phase).toBe("build");
  expect(target.k.store.get("asks", source.askId)?.state).toBe("withdrawn");
  expect(target.k.store.events("lead").find(e => e.data.cause === "conclude-withdrawn")?.data.receipt).toMatchObject({ id: source.askId });
});
it("M5 exits closing when its conclude ask is withdrawn", async () => {
  const f = await closing(); f.k.withdrawAsk(f.askId, "turn-recovered");
  expect(f.k.quest(f.q.id).phase).toBe("build");
});
it("M6 defers an initial brief without changing attempts and delivers after resume", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch"); registerRpc(f.bb, f.runtime);
  const m = f.k.bind("child", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Watch", brief: { outcome: "Watch", outOfScope: "Rest", doneWhen: "Report", mode: "make-it-work", context: [], questions: [], timeboxMinutes: 5 } });
  f.k.store.patch(m.threadId, { pendingBrief: { id: "b1", text: "FIRST_BRIEF", attempts: 0, nextAttemptAt: 0, attemptedAt: null, hostAfterSeq: null, error: null } });
  f.k.setQuestHeld(q.id, true, { kind: "user" }); await f.runtime.retryInitialBriefs("lead");
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(f.k.store.runtime(m.threadId).pendingBrief?.attempts).toBe(0);
  await f.harness.invokeRpc("resumeBoardQuest", { id: q.id }, { experimental_caller: { kind: "client" } });
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
});
it.each(["needing-plan", "fitting-plan", "approve", "undo", "conclude"])("M1 refuses %s while held without writes", async action => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch");
  f.k.plan("lead", planInput(q.id));
  let decisionId = "";
  if (action === "undo" || action === "fitting-plan") {
    decisionId = f.k.decide("lead", { boardQuestId: q.id, text: "Approved", why: "Safe", reversible: true, source: "keeper" }, { questId: q.id, planVersion: 1 }).id;
    f.k.store.put("autoGreenlights", decisionId, { keeperThreadId: "lead", boardQuestId: q.id, planVersion: 1 });
    if (action === "fitting-plan") f.k.plan("lead", { ...planInput(q.id), party: [...planInput(q.id).party, ...planInput(q.id).party] });
  }
  const ask = f.k.store.openAsks("lead", q.id)[0]; f.k.setQuestHeld(q.id, true, { kind: "user" });
  const snapshot = () => JSON.stringify([f.k.store.all("quests"), f.k.store.all("plans"), f.k.store.all("asks"), f.k.store.all("decisions"), f.k.store.events("lead")]);
  const before = snapshot(), message = action === "approve" || action === "undo" ? /This quest is held; resume it first/ : /Watch is held by you since .*; resume it first/;
  if (action === "conclude") await expect(f.runtime.proposeWrap("lead", q.id, "Done", "")).rejects.toThrow(message);
  else expect(() => action === "approve" ? f.k.answerAsk(ask!.id, "approve", null, "page", "user") : action === "undo" ? f.k.undoDecision(decisionId) : f.k.plan("lead", planInput(q.id))).toThrow(message);
  expect(snapshot()).toBe(before);
});
it.each(["opening", "cancelled", "reused"])("M2 refuses a %s message receipt", async reason => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch");
  let messageId = f.k.store.query("routes", "keeperThreadId", "lead")[0]!.sourceMessageId!;
  if (reason !== "opening") {
    f.advance(1); f.k.receiveUser("lead", "Please hold", null, "receipt-row");
    messageId = f.k.route("lead", { kind: "steer", boardQuestId: q.id, summary: "Hold", notes: [] }).sourceMessageId!;
  }
  if (reason === "cancelled") f.k.cancelUser("lead", "receipt-row");
  if (reason === "reused") f.k.setQuestHeld(q.id, true, { kind: "agent", threadId: "lead" }, messageId);
  expect(() => f.k.setQuestHeld(q.id, reason !== "reused", { kind: "agent", threadId: "lead" }, messageId)).toThrow();
});
it.each([true, false])("M2 refuses unused words older than the last phase move, hold=%s", async hold => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch");
  f.advance(1); f.k.receiveUser("lead", "Change this quest");
  const route = f.k.route("lead", { kind: "steer", boardQuestId: q.id, summary: "Direction", notes: [] });
  f.advance(1);
  if (hold) f.k.plan("lead", planInput(q.id));
  else f.k.setQuestHeld(q.id, true, { kind: "user" });
  expect(() => f.k.setQuestHeld(q.id, hold, { kind: "agent", threadId: "lead" }, route.sourceMessageId!)).toThrow(/newer than the last/);
});
it("M2 stores the quoted text", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch");
  f.advance(1); f.k.receiveUser("lead", "Please hold exactly this quest", null, "hold-row");
  const route = f.k.route("lead", { kind: "steer", boardQuestId: q.id, summary: "Hold", notes: [] });
  f.k.setQuestHeld(q.id, true, { kind: "agent", threadId: "lead" }, route.sourceMessageId!);
  expect(f.k.store.events("lead").find(e => e.type === "quest.held")!.data.receipt).toMatchObject({ id: route.sourceMessageId, text: "Please hold exactly this quest" });
});
it("M7 reopens to scout with fresh routed words and quotes its receipt", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch"); await f.runtime.stop(q.id);
  f.advance(1); f.k.receiveUser("lead", "Reopen Watch");
  const route = f.k.route("lead", { kind: "steer", boardQuestId: q.id, summary: "Reopen", notes: [] });
  expect(f.k.reopenQuest(q.id, { kind: "agent", threadId: "lead" }, route.sourceMessageId!).phase).toBe("scout");
  expect(f.k.store.events("lead").find(e => e.type === "quest.reopened")?.data.receipt).toMatchObject({ id: route.sourceMessageId, text: "Reopen Watch" });
});
it("L2 takes the latest stop request outside the 500-event window", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch");
  f.k.plan("lead", planInput(q.id)); const ask = f.k.store.openAsks("lead", q.id)[0]!;
  f.k.recordStop(q.id);
  for (let i = 0; i < 501; i++) f.k.store.event(f.time(), "lead", null, "note.added", `Other ${i}`);
  await f.runtime.retryStops("lead", q.id);
  expect(f.k.store.events("lead").find(e => e.type === "quest.stopped")?.data.withdrawnAskIds).toEqual([ask.id]);
});
it("M7 refuses reopen without a cited user message", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch"); await f.runtime.stop(q.id);
  expect(() => f.k.reopenQuest(q.id, { kind: "agent", threadId: "lead" })).toThrow();
});
it("M3 records an actual stop from closing before withdrawing its conclude ask", async () => {
  const f = await closing(); await f.runtime.stop(f.q.id);
  expect(f.k.store.events("lead").find(e => e.type === "quest.stopping")?.data.phase).toEqual({ from: "closing", to: "stopping" });
  expect(f.k.store.get("asks", f.askId)?.state).toBe("withdrawn");
});
it("M3 retains the held source receipt outside the event window", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch"); registerRpc(f.bb, f.runtime);
  f.k.setQuestHeld(q.id, true, { kind: "user" }); await f.runtime.stop(q.id);
  for (let i = 0; i < 501; i++) f.k.store.event(f.time(), "lead", null, "note.added", `Other ${i}`);
  const detail = await f.harness.invokeRpc("boardQuest", { id: q.id }) as { events: { data: { phase?: { from: string; to: string } } }[] };
  expect(detail.events.some(e => e.data.phase?.from === "scout" && e.data.phase.to === "held")).toBe(true);
});
it("L1 protects held metadata", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch");
  expect(() => f.k.store.put("quests", q.id, { ...f.k.quest(q.id), held: { from: "scout", since: f.time() } })).toThrow(/lifecycle/);
});
