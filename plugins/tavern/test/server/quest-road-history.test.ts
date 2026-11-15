// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registerRpc } from "../../src/server/rpc";
import type { BoardQuestDetail } from "../../src/shared/contract";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";

it("reads the last phase before stopping outside the Keeper's 500-event window with one indexed bounded query", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Build", "Build");
  f.advance(10);
  f.k.store.event(f.time(), "lead", q.id, "quest.phase", "Board quest moved to build", { phase: "build" });
  f.advance(10);
  const phaseId = f.k.store.event(f.time(), "lead", q.id, "quest.phase", "Board quest moved to check", { phase: "check" });
  f.advance(10);
  const stoppedAt = f.time();
  f.k.store.put("quests", q.id, { ...q, phase: "stopped", planVersion: 1, greenlitVersion: 1, stoppingSince: stoppedAt, endedAt: stoppedAt, updatedAt: stoppedAt });
  for (let i = 0; i < 501; i++) f.k.store.event(f.time(), "lead", null, "note.added", `Other event ${i}`);
  f.k.store.event(stoppedAt + 100, "lead", q.id, "quest.phase", "Board quest moved to wrap", { phase: "wrap" });
  expect(f.k.store.events("lead", 0, 500).some(e => e.id === phaseId)).toBe(false);
  const prepare = vi.spyOn(f.k.store.db, "prepare");
  registerRpc(f.bb, f.runtime);
  const detail = await f.harness.invokeRpc("boardQuest", { id: q.id }) as BoardQuestDetail;
  expect(detail.events.filter(e => e.id === phaseId)).toHaveLength(1);
  expect(detail.events.find(e => e.id === phaseId)?.data.phase).toBe("check");
  expect(detail.events.filter(e => e.at <= stoppedAt && e.type === "quest.phase")).toHaveLength(1);
  const calls = prepare.mock.calls.filter(([sql]) => sql.includes("WHERE id=coalesce("));
  expect(calls).toHaveLength(1);
  const query = calls[0]![0];
  const args = Array.from({ length: query.match(/\?/g)!.length / 2 }, () => [q.id, stoppedAt]).flat();
  const plan = f.k.store.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args) as { detail: string }[];
  const text = plan.map(p => p.detail).join("\n");
  expect(text).toContain("USING COVERING INDEX tavern_events_quest_phase_time");
  expect(text).not.toMatch(/SCAN tavern_events|USE TEMP B-TREE/);
});

it("recovers the opening receipt for a quest stopped while scouting outside the event window", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Scout", "Scout");
  f.advance(10);
  f.k.store.put("quests", q.id, { ...q, phase: "stopped", stoppingSince: f.time(), endedAt: f.time(), updatedAt: f.time() });
  for (let i = 0; i < 501; i++) f.k.store.event(f.time(), "lead", null, "note.added", `Other event ${i}`);
  expect(f.k.store.events("lead", 0, 500).some(e => e.type === "quest.opened")).toBe(false);
  registerRpc(f.bb, f.runtime);
  const detail = await f.harness.invokeRpc("boardQuest", { id: q.id }) as BoardQuestDetail;
  expect(detail.events.filter(e => e.type === "quest.opened")).toHaveLength(1);
  expect(detail.events.some(e => e.type === "quest.phase")).toBe(false);
});

it.each(["scout", "greenlight", "build", "check"] as const)("preserves %s before stopping, retrieving its receipt outside the event window", async phase => {
  const f = setup(), opened = await seedQuest(f.k, "lead", "Stop phase", "Stop phase");
  if (phase !== "scout") f.k.plan("lead", planInput(opened.id));
  if (phase === "build" || phase === "check") f.k.answerAsk(f.k.store.openAsks("lead").find(a => a.kind === "greenlight")!.id, "approve", null, "page");
  if (phase === "check") {
    f.k.store.put("quests", opened.id, { ...f.k.quest(opened.id), phase: "check" });
    f.k.store.event(f.time(), "lead", opened.id, "quest.phase", "Board quest moved to check");
  } else expect(f.k.store.events("lead").some(e => e.type === "quest.phase")).toBe(false);
  const before = f.k.quest(opened.id);
  expect(before.phase).toBe(phase);
  f.advance(10);
  await f.runtime.stop(opened.id);
  const stop = f.k.store.events("lead").find(e => e.type === "quest.stopping")!;
  expect(stop.data.phaseBeforeStop).toBe(phase);
  expect(f.k.quest(opened.id)).toMatchObject({ phase: "stopped", planVersion: before.planVersion, greenlitVersion: before.greenlitVersion });
  for (let i = 0; i < 501; i++) f.k.store.event(f.time(), "lead", null, "note.added", `Later event ${i}`);
  registerRpc(f.bb, f.runtime);
  const detail = await f.harness.invokeRpc("boardQuest", { id: opened.id }) as BoardQuestDetail;
  expect(detail.events.filter(e => e.id === stop.id)).toHaveLength(1);
  expect(detail.events.find(e => e.id === stop.id)?.data.phaseBeforeStop).toBe(phase);
});

it.each(["open", "withdrawn"] as const)("reads the persisted version of the %s stop-greenlight receipt despite other quests filling the Keeper ask window", async state => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Legacy approval", "Legacy approval");
  f.k.plan("lead", planInput(q.id));
  const ask = f.k.store.openAsks("lead").find(a => a.kind === "greenlight")!;
  f.advance(10);
  if (state === "withdrawn") f.k.withdrawAsk(ask.id, "quest-stopped");
  f.k.store.put("quests", q.id, { ...f.k.quest(q.id), phase: "stopped", stoppingSince: f.time(), endedAt: f.time() });
  for (let i = 0; i < 501; i++) f.k.store.put("asks", `other-${i}`, { ...ask, id: `other-${i}`, boardQuestId: "other", state: "answered" });
  expect(f.k.asks("lead").some(a => a.id === ask.id)).toBe(false);
  registerRpc(f.bb, f.runtime);
  const detail = await f.harness.invokeRpc("boardQuest", { id: q.id }) as BoardQuestDetail;
  expect(detail.asks.find(a => a.id === ask.id)).toMatchObject({ planVersion: 1, state });
});
it.each(["legacy", "recorded"] as const)("retains ambiguous approval metadata after a plan needing no greenlight, with a %s stop", async mode => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Replan", "Replan");
  f.k.plan("lead", planInput(q.id));
  f.k.answerAsk(f.k.store.openAsks("lead").find(a => a.kind === "greenlight")!.id, "approve", null, "page");
  f.k.plan("lead", { ...planInput(q.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
  expect(f.k.quest(q.id)).toMatchObject({ phase: "greenlight", planVersion: 2, greenlitVersion: 1 });
  f.k.plan("lead", planInput(q.id));
  expect(f.k.quest(q.id)).toMatchObject({ phase: "build", planVersion: 3, greenlitVersion: 1 });
  expect(f.k.store.events("lead").some(e => e.type === "quest.phase")).toBe(false);
  f.advance(10);
  if (mode === "recorded") await f.runtime.stop(q.id);
  else f.k.store.put("quests", q.id, { ...f.k.quest(q.id), phase: "stopped", stoppingSince: f.time(), endedAt: f.time() });
  registerRpc(f.bb, f.runtime);
  const detail = await f.harness.invokeRpc("boardQuest", { id: q.id }) as BoardQuestDetail;
  expect(detail.quest).toMatchObject({ planVersion: 3, greenlitVersion: 1 });
  expect(detail.asks.some(a => a.kind === "greenlight" && (a.state === "open" || a.withdrawnCause === "quest-stopped"))).toBe(false);
  expect(detail.events.find(e => e.type === "quest.stopping")?.data.phaseBeforeStop).toBe(mode === "recorded" ? "build" : undefined);
});
