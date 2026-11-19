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
  const note = f.k.memory.note("lead", { kind: "waiting-on-user", text: "Approve access", boardQuestId: q.id } as any);
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
  expect(questNeedYouCount(detail.quest)).toBe(4);
  expect(ledger.attention?.items.map(item => item.kind).sort()).toEqual(["ask", "hand-back", "hold", "rule"]);
});

it("keeps a delegated ask out of every user attention queue", async () => {
  const f = await fixture();
  f.k.store.put("asks", f.ask.id, { ...f.ask, lane: "keeper" });
  const ledger = await f.rpc.ledger({ threadId: "lead" });
  const decor = await f.rpc.decor({ threadId: "lead" });
  const room = await f.rpc.room({});
  const detail = await f.rpc.boardQuest({ id: f.q.id });
  expect([ledger, decor.keeperView, room, detail, detail.quest].map(view => attentionView(view?.attention).needYou)).toEqual([3, 3, 3, 3, 3]);
  expect(ledger.asks.some(ask => ask.id === f.ask.id)).toBe(false);
  expect(f.k.store.openAsks("lead").some(ask => ask.id === f.ask.id)).toBe(true);
  expect(f.k.store.openAsks("lead", undefined, true).some(ask => ask.id === f.ask.id)).toBe(false);
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
  expect(attention(f.k.store)).toMatchObject({ needYou: 0, heldByYou: 1, items: [expect.objectContaining({ kind: "held", action: "Resume" })] });
});
