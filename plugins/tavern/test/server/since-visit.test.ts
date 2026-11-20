// @vitest-environment node
import { expect, it, vi } from "vitest";
import { rpcHandlers } from "../../src/server/rpc";
import { MIGRATIONS } from "../../src/server/migrations";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";

async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Watch the rollout", "Watch");
  const post = (title: string) => f.k.postSummary("lead", { boardQuestId: q.id, title, body: "No alerts.", links: [] });
  return { ...f, q, post, rpc: rpcHandlers(f.runtime) };
}

it("does not send a user's own phase change back as news", async () => {
  const f = await fixture();
  f.k.plan("lead", planInput(f.q.id));
  expect((await f.rpc.room({})).sinceVisit?.changedQuests).toBe(1);
  f.k.answerAsk(f.k.store.openAsks("lead", f.q.id)[0]!.id, "approve", null, "page", "user");
  expect((await f.rpc.room({})).sinceVisit?.changedQuests).toBe(0);
});

it("omits a Keeper's hold and resume on the user's routed words", async () => {
  const f = await fixture();
  f.k.plan("lead", planInput(f.q.id));
  const keeper = { kind: "agent" as const, threadId: "lead" };
  for (const hold of [true, false]) {
    f.advance(1);
    f.k.receiveUser("lead", hold ? "Pause here" : "Resume the watch");
    const route = f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "User direction", notes: [] });
    f.k.setQuestHeld(f.q.id, hold, keeper, route.sourceMessageId!);
    const phaseEvent = f.k.store.latestQuestEvent(f.q.id, hold ? "quest.held" : "quest.resumed")!;
    expect(phaseEvent).toMatchObject({ actor: keeper, data: { receipt: { kind: "user-message", id: route.sourceMessageId } } });
    expect((await f.rpc.room({})).sinceVisit?.changedQuests).toBe(0);
    await f.rpc.markVisitSeen({ summaryIds: [], changeIds: [`quest-change:${phaseEvent.id}`] });
    expect(f.k.store.get("attentionSeen", `quest-change:${phaseEvent.id}`)).toBeNull();
  }
});

it("omits Tavern's completion of a recorded user Stop", async () => {
  const f = await fixture();
  f.k.plan("lead", planInput(f.q.id));
  await f.runtime.stop(f.q.id, "Stop this watch");
  expect(f.k.store.latestQuestEvent(f.q.id, "quest.stopping")).toMatchObject({ data: { cause: "stop", receipt: { kind: "user-act" } } });
  expect(f.k.store.latestQuestEvent(f.q.id, "quest.stopped")).toMatchObject({ actor: { kind: "tavern" }, data: { cause: "stopped", receipt: { kind: "members-stopped" } } });
  expect((await f.rpc.room({})).sinceVisit?.changedQuests).toBe(0);
});

it("reads the quest title in the summary selection even when there is no visible phase change", async () => {
  const f = await fixture();
  const summary = f.post("The watch covered both shifts");
  const prepare = vi.spyOn(f.k.store.db, "prepare");
  const visit = (await f.rpc.room({})).sinceVisit!;
  expect(visit.quests).toMatchObject([{ id: f.q.id, title: f.q.title, change: null, summaries: [{ id: summary.id }] }]);
  const summaryRead = prepare.mock.calls.find(([sql]) => sql.startsWith("SELECT json_object") && sql.includes("$.supersedes"))?.[0];
  expect(summaryRead).toContain("json_extract(q.data,'$.title')");
  prepare.mockRestore();
});

it("groups by quest, shows only a count for calls, and marks the exact rendered summaries and receipt", async () => {
  const f = await fixture();
  const first = f.post("Watch result");
  const call = f.k.decide("lead", { boardQuestId: f.q.id, text: "Keep west in scope", why: "Coverage", source: "keeper", reversible: true });
  f.k.plan("lead", planInput(f.q.id));
  const room = await f.rpc.room({});
  const visit = room.sinceVisit!;
  expect(visit).toMatchObject({ summaries: 1, decided: 1, changedQuests: 1, quests: [{ id: f.q.id, title: f.q.title, summaries: [{ id: first.id, title: first.title }], change: { phaseChange: { from: "scout", to: "greenlight" } } }] });
  expect(room.attention).toMatchObject({ summaries: visit.summaries, decided: visit.decided, changedQuests: visit.changedQuests });
  const receipt = visit.quests[0]!.change!.id;
  const later = f.post("Later result");
  f.k.store.event(f.time(), "lead", f.q.id, "quest.phase", "A later transition", { phase: { from: "greenlight", to: "build" } }, { kind: "tavern" });
  await f.rpc.markVisitSeen({ summaryIds: [first.id], changeIds: [receipt] });
  expect(f.k.store.get("attentionSeen", call.id)).toBeNull();
  expect(f.k.store.get("attentionSeen", first.id)).not.toBeNull();
  expect(f.k.store.get("attentionSeen", receipt)).not.toBeNull();
  expect((await f.rpc.room({})).sinceVisit).toMatchObject({ summaries: 1, decided: 1, changedQuests: 1, quests: [{ summaries: [{ id: later.id }], change: { phaseChange: { from: "greenlight", to: "build" } } }] });
});

it("projects the exact seen receipt to the quest without acknowledging it on a data fetch", async () => {
  const f = await fixture();
  f.k.plan("lead", planInput(f.q.id));
  const visit = (await f.rpc.room({})).sinceVisit!;
  const detail = await f.rpc.boardQuest({ id: f.q.id });
  expect(detail.visitChangeId).toBe(visit.quests[0]!.change!.id);
  expect((await f.rpc.room({})).sinceVisit?.changedQuests).toBe(1);
});

it("has no old transitions on first room read after upgrade", async () => {
  const f = await fixture();
  f.k.plan("lead", planInput(f.q.id));
  f.k.store.db.exec(MIGRATIONS.at(-1)!);
  expect((await f.rpc.room({})).sinceVisit?.changedQuests).toBe(0);
  f.k.store.event(f.time(), "lead", f.q.id, "quest.phase", "A later transition", { phase: { from: "greenlight", to: "build" } }, { kind: "tavern" });
  expect((await f.rpc.room({})).sinceVisit?.changedQuests).toBe(1);
});
