// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { putQuestFixture, seedQuest } from "./support";
import { registerTools } from "../../src/server/tools";
import { rpcHandlers } from "../../src/server/rpc";

const client = { experimental_caller: { kind: "client" as const }, experimental_signal: new AbortController().signal };
const goal = "Publish the site\nKeep the previous version available.";

function routeGoal(f: ReturnType<typeof setup>, text = goal, rowId = "goal-row", accepted = true) {
  f.k.receiveUser("lead", text, null, rowId, f.time(), accepted);
  return f.k.route("lead", { kind: "new-quest", summary: "Keeper paraphrase", notes: [] });
}

it("serializes overlapping openings, returns the existing quest on retry, and writes one journal mirror", async () => {
  const f = setup();
  const journal = vi.spyOn(f.port, "edit");
  const opening = routeGoal(f, "Build the site", "first-row");
  const first = f.k.openQuest("lead", "Build the site", "Build");
  const retry = f.k.openQuest("lead", "Same opening after lost reply", "Retry");
  const next = routeGoal(f);
  const second = f.k.openQuest("lead", "Publish the site", "Publish");
  const [a, b, c] = await Promise.allSettled([first, retry, second]);
  expect(a).toMatchObject({ status: "fulfilled", value: { title: "Build the site" } });
  expect(b).toEqual(a);
  expect(c).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/quest placement card/i) }) });
  expect(f.k.store.all("quests")).toHaveLength(1);
  expect(journal).toHaveBeenCalledTimes(1);
  expect(f.k.store.get("routes", next.id)?.boardQuestId).toBeNull();
  f.k.endTurn("lead");
  await expect(f.k.openQuest("lead", "Build the site", "Build", opening.id)).resolves.toEqual(a.status === "fulfilled" && a.value);
});

it.each([null, 1_000_000])("refuses a second goal after closure (archivedAt=%s) and offers only a new Keeper", async archivedAt => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Build the site", "Build");
  putQuestFixture(f.k.store, q.id, { ...q, phase: "done", endedAt: f.time(), archivedAt });
  const route = routeGoal(f);
  await expect(f.k.openQuest("lead", "Publish the site", "Publish")).rejects.toThrow(/quest placement card/i);
  const card = f.k.offerQuestStart("lead", route.id);
  expect(card.boardQuestId).toBeNull();
  expect(card.options.map(option => option.id)).toEqual(["new-keeper"]);
});

it("preserves legacy multi-quest steers and requires an explicit parent for a new placement", async () => {
  const f = setup(), a = await seedQuest(f.k, "lead", "Build the site", "Build");
  const b = putQuestFixture(f.k.store, "legacy-quest", { ...a, id: "legacy-quest", title: "Write a guide" });
  f.k.receiveUser("lead", "Keep both offline");
  const steer = f.k.route("lead", { kind: "steer", boardQuestIds: [a.id, b.id], summary: "Offline", notes: [] });
  expect(steer.boardQuestIds).toEqual([a.id, b.id]);
  expect(() => f.k.guard("lead", b.id)).not.toThrow();
  expect(() => f.k.offerQuestStart("lead", steer.id, b.id)).toThrow(/outside goal/i);
  const route = routeGoal(f);
  await expect(f.k.openQuest("lead", "Publish the site", "Publish")).rejects.toThrow(/quest placement card/i);
  expect(() => f.k.offerQuestStart("lead", route.id)).toThrow(/parent/i);
  expect(f.k.offerQuestStart("lead", route.id, b.id).boardQuestId).toBe(b.id);
  expect(f.k.offerQuestStart("lead", route.id, a.id).boardQuestId).toBe(b.id);
});

it("does not accept first goals, unaccepted messages, receipts from another Keeper, or cancelled goals", async () => {
  const f = setup(), first = routeGoal(f, "Build the site", "first-row");
  expect(() => f.k.offerQuestStart("lead", first.id)).toThrow(/first quest/i);
  await f.k.openQuest("lead", "Build the site", "Build");
  f.k.bind("other", "keeper", "moss", "project");
  expect(() => f.k.offerQuestStart("other", first.id)).toThrow();
  const pending = routeGoal(f, goal, "goal-row", false);
  expect(() => f.k.offerQuestStart("lead", pending.id)).toThrow(/accepted/i);
  f.k.receiveUser("lead", goal, null, "goal-row", f.time(), true);
  const card = f.k.offerQuestStart("lead", pending.id);
  f.k.cancelUser("lead", "goal-row");
  await expect(rpcHandlers(f.runtime).answerAsk({ askId: card.id, optionId: "new-keeper", note: null, via: "page" }, client)).rejects.toThrow(/cancelled/i);
  expect(f.k.store.get("asks", card.id)?.answer).toBeNull();
});

it("records one authentic choice across turns, with no delegation, default, hire or send", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Build the site", "Build");
  const route = routeGoal(f);
  registerTools(f.bb, f.runtime);
  const result = await f.harness.behavior.invokeAgentTool("tavern_quest", { op: "choice", routeId: route.id }, { threadId: "lead" });
  const card = f.k.offerQuestStart("lead", route.id);
  expect(result).toContain(`\n::tavern-ask{id="${card.id}"}`);
  expect(f.k.store.openAsks("lead")).toHaveLength(1);
  expect(card).toMatchObject({ boardQuestId: q.id, lane: "user", proceedAt: null,
    effect: { type: "quest-start", goal, sourceMessageId: route.sourceMessageId, projectId: "project" } });
  const input = { askId: card.id, optionId: "side-quest", note: null, via: "page" as const };
  const answer = rpcHandlers(f.runtime).answerAsk;
  await expect(async () => answer(input, { experimental_caller: { kind: "plugin", pluginId: "another" } } as never)).rejects.toThrow(/client/i);
  await expect(f.runtime.answerAsk(card.id, "side-quest", null, "page", true)).rejects.toThrow(/explicit answer/i);
  expect(() => f.k.answerAsk(card.id, "side-quest", null, "timer", "preapproval")).toThrow(/explicit answer/i);
  expect(() => f.k.answerAsk(card.id, "side-quest", null, "timer", "default")).toThrow(/explicit answer/i);
  expect(() => f.k.answerAsk(card.id, "side-quest", null, "chat", "keeper")).toThrow(/explicit answer/i);
  f.k.endTurn("lead");
  await Promise.all([answer(input, client), answer(input, client)]);
  await expect(answer({ ...input, optionId: "new-keeper" }, client)).rejects.toThrow(/no longer open/i);
  expect(f.k.store.get("asks", card.id)?.answer).toMatchObject({ optionId: "side-quest", by: "user" });
  expect(f.k.store.events("lead").filter(e => e.type === "ask.answered" && e.data.askId === card.id)).toHaveLength(1);
  expect(() => f.k.decide("lead", { boardQuestId: q.id, text: "Approve unrelated work", why: "Placement receipt", reversible: false, source: "ask", sourceRef: card.id })).toThrow(/Decision source/i);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it.each(["return", "stop", "sweep"] as const)("keeps the same New Keeper choice after the parent ends via %s", async (end) => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Build the site", "Build");
  const route = routeGoal(f), card = f.k.offerQuestStart("lead", route.id);
  const answer = rpcHandlers(f.runtime).answerAsk;
  const input = { askId: card.id, note: null, via: "page" as const };
  if (end === "return") {
    const closing = await f.runtime.proposeWrap("lead", q.id, "The site is built.", "Nothing");
    await answer({ ...input, askId: closing.askId!, optionId: "close-early" }, client);
  } else if (end === "stop") {
    await f.runtime.stop(q.id);
  } else {
    putQuestFixture(f.k.store, q.id, { ...q, phase: "done", endedAt: f.time(), archivedAt: f.time() });
    await expect(answer({ ...input, optionId: "side-quest" }, client)).rejects.toThrow(/ended/i);
    expect(f.k.store.get("asks", card.id)?.answer).toBeNull();
    f.k.defaults("lead");
  }
  expect(f.k.store.openAsks("lead", undefined, true).find(a => a.id === card.id)).toMatchObject({
    state: "open", boardQuestId: null, effect: { parentQuestId: q.id },
    options: [expect.objectContaining({ id: "new-keeper" })],
  });
  expect(f.k.offerQuestStart("lead", route.id).id).toBe(card.id);
  expect(f.k.store.latestQuestEvent(q.id, end === "stop" ? "quest.stopping" : "quest.wrapped")?.data.withdrawnAskIds ?? []).not.toContain(card.id);
  await expect(answer({ ...input, optionId: "side-quest" }, client)).rejects.toThrow();
  await expect(answer({ ...input, optionId: "new-keeper" }, client)).resolves.toMatchObject({ ok: true });
  expect(f.k.store.get("asks", card.id)?.answer).toMatchObject({ optionId: "new-keeper", by: "user" });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("does not revive a withdrawn placement card", async () => {
  const f = setup();
  await seedQuest(f.k, "lead", "Build the site", "Build");
  const route = routeGoal(f), card = f.k.offerQuestStart("lead", route.id);
  f.k.withdrawAsk(card.id, "keeper-archived");
  await expect(rpcHandlers(f.runtime).answerAsk({ askId: card.id, optionId: "new-keeper", note: null, via: "page" }, client)).rejects.toThrow(/no longer open/i);
  expect(f.k.offerQuestStart("lead", route.id)).toMatchObject({ id: card.id, state: "withdrawn" });
});
