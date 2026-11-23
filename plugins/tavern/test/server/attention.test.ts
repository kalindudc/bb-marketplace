// @vitest-environment node
import { expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { putQuestFixture, seedQuest } from "./support";
import { rpcHandlers } from "../../src/server/rpc";
import { attention } from "../../src/server/attention";
import { attentionView } from "../../src/shared/attention";
import { needYouCount } from "../../src/ui/page/model";
import { questNeedYouCount } from "../../src/ui/kit/rows";

async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Attention", "Attention");
  const ask = f.k.ask("lead", { boardQuestId: q.id, effect: { type: "decision" }, question: "Pick a region", why: "Your call", kind: "decision", options: [{ id: "yes", label: "Yes", detail: "", recommended: true }], meanwhile: "Wait", holds: [] });
  const note = f.k.memory.note("lead", { kind: "waiting-on-user", text: "Approve access", action: "Approve access", need: "Please approve access.", boardQuestId: q.id });
  f.k.addRule({ scope: "quest", scopeId: q.id, text: "Confirm this rule", source: "keeper-proposed" }, "lead");
  f.k.store.put("quests", q.id, { ...f.k.quest(q.id), checkerHandoffHold: { id: "hold", reason: "Review", createdAt: f.time(), routeId: "route", sourceMessageId: "message", sourceText: "Hold", release: null } });
  return { ...f, q, ask, note, rpc: rpcHandlers(f.runtime) };
}

it("every surface reads the same four need-you items", async () => {
  const f = await fixture();
  const decor = await f.rpc.decor({ threadId: "lead" });
  const ledger = await f.rpc.ledger({ threadId: "lead" });
  const room = await f.rpc.room({});
  const detail = await f.rpc.boardQuest({ id: f.q.id });
  const views = [decor.keeperView, ledger, room, detail, detail.quest];
  expect(views.map(view => attentionView(view?.attention).needYou)).toEqual([4, 4, 4, 4, 4]);
  expect(needYouCount(room)).toBe(4);
  expect(await f.rpc.attentionCount({})).toEqual({ count: 4 });
  expect(questNeedYouCount(detail.quest)).toBe(4);
  expect(ledger.attention?.items.map(item => item.kind).sort()).toEqual(["ask", "hand-back", "hold", "rule"]);
});

it.each(["archivedAt", "deletedAt"] as const)("adds identity and scope for a Keeper with %s without counting a quest hold as active attention", async goneAt => {
  const f = await fixture();
  const keeper = f.k.member("lead")!;
  f.k.store.put("members", "lead", { ...keeper, displayName: "Wren" });
  f.k.store.patch("lead", { [goneAt]: f.time(), threadCreatedAt: 123 });
  const keeperRule = f.k.addRule({ scope: "keeper", scopeId: "lead", text: "Keep work short", source: "keeper-proposed" }, "lead");
  const room = await f.rpc.room({});
  expect(room.keepers.find(keeper => keeper.member.threadId === "lead")?.archived).toBe(true);
  const list = room.attention!;
  expect(list).toMatchObject({ needYou: 4, heldByYou: 0, counts: { ask: 0, hold: 0, "hand-back": 0, rule: 0, stopped: 4 } });
  expect(await f.rpc.attentionCount({})).toEqual({ count: 4 });
  expect(list.items.find(item => item.id === keeperRule.id)).toMatchObject({ who: { state: "archived", startedAt: 123 }, scope: { kind: "keeper", label: "Wren" } });
  expect(list.items.find(item => item.kind === "rule" && item.questId)).toMatchObject({ who: { state: "archived", questTitle: "Attention" }, scope: { kind: "quest", label: "Attention" } });
  expect(list.items.find(item => item.kind === "hand-back")).toMatchObject({ need: "Please approve access." });
});

it("keeps the only ask from an interrupted Keeper in the Asks group", async () => {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Attention", "Attention");
  const ask = f.k.ask("lead", { boardQuestId: q.id, effect: { type: "decision" }, question: "Which region?", why: "Your call", kind: "decision", options: [{ id: "yes", label: "Yes", detail: "", recommended: true }], meanwhile: "Wait", holds: [] });
  f.k.store.patch("lead", { manualStopAt: f.time() });
  const list = (await rpcHandlers(f.runtime).room({})).attention!;
  expect(list).toMatchObject({ needYou: 1, counts: { ask: 1, stopped: 0 }, items: [expect.objectContaining({ id: ask.id, who: { state: "quiet", startedAt: expect.any(Number), questTitle: q.title } })] });
});

it("projects a sentence for an older hand-back without changing its action", async () => {
  const f = await fixture();
  const { need: _, ...older } = f.note;
  f.k.store.put("notes", older.id, older);
  expect((await f.rpc.room({})).attention?.items.find(item => item.id === older.id)).toMatchObject({
    title: "Approve access",
    need: "Wren handed this back to you.",
  });
});

it("keeps a delegated ask out of every user attention queue", async () => {
  const f = await fixture();
  f.k.store.put("asks", f.ask.id, { ...f.ask, lane: "keeper" });
  const ledger = await f.rpc.ledger({ threadId: "lead" });
  const decor = await f.rpc.decor({ threadId: "lead" });
  const room = await f.rpc.room({});
  const detail = await f.rpc.boardQuest({ id: f.q.id });
  expect([ledger, decor.keeperView, room, detail, detail.quest].map(view => attentionView(view?.attention).needYou)).toEqual([3, 3, 3, 3, 3]);
  expect(await f.rpc.attentionCount({})).toEqual({ count: 3 });
  expect(ledger.asks.some(ask => ask.id === f.ask.id)).toBe(false);
  expect(f.k.store.openAsks("lead").some(ask => ask.id === f.ask.id)).toBe(true);
  expect(f.k.store.openAsks("lead", undefined, true).some(ask => ask.id === f.ask.id)).toBe(false);
});

it("counts a hold and its release ask only once, then omits an archived quest", async () => {
  const f = await fixture();
  f.k.store.put("asks", f.ask.id, { ...f.ask, releaseHoldId: "hold" });
  expect(await f.rpc.attentionCount({})).toEqual({ count: 3 });
  expect(needYouCount(await f.rpc.room({}))).toBe(3);
  f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), archivedAt: f.time() });
  expect(await f.rpc.attentionCount({})).toEqual({ count: 0 });
  expect(needYouCount(await f.rpc.room({}))).toBe(0);
});

it("an old open ask survives 150 newer closed asks", async () => {
  const f = await fixture();
  for (let i = 0; i < 150; i++) f.k.store.put("asks", `closed-${i}`, { ...f.ask, id: `closed-${i}`, state: "answered" });
  const ledger = await f.rpc.ledger({ threadId: "lead" });
  expect(ledger.asks.some(ask => ask.id === f.ask.id)).toBe(true);
  expect(ledger.attention?.items.some(item => item.id === f.ask.id)).toBe(true);
});

it("new counts unseen calls, not pending Keeper events, and has an empty summary seam", async () => {
  const f = await fixture();
  for (const id of ["d1", "d2"]) f.k.store.put("decisions", id, { id, keeperThreadId: "lead", boardQuestId: f.q.id, text: id, source: "keeper", reversible: true, undone: false, seenAt: null, createdAt: f.time() } as any);
  expect(attention(f.k.store, { keeperThreadId: "lead" }).new).toBe(2);
  f.k.store.event(f.time(), "lead", null, "report.filed", "Keeper news", {}, { kind: "user" });
  expect((await f.rpc.decor({ threadId: "lead" })).keeperView?.attention?.new).toBe(2);
  await f.rpc.markDecisionsSeen({ ids: ["d1"] });
  expect(attention(f.k.store, { keeperThreadId: "lead" }).new).toBe(1);
  expect(attention(f.k.store).items.filter(item => item.kind === "summary")).toEqual([]);
});

it("user-held quests have their own Resume group", async () => {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Paused", "Paused");
  putQuestFixture(f.k.store, q.id, { ...q, phase: "held", held: { from: "scout", since: f.time() } });
  expect(await rpcHandlers(f.runtime).attentionCount({})).toEqual({ count: 0 });
  expect(attention(f.k.store)).toMatchObject({ needYou: 0, heldByYou: 1, items: [expect.objectContaining({ kind: "held", action: "Resume" })] });
});
