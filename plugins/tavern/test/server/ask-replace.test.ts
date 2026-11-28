// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { registerRpc } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";
import { rpcContract } from "../../src/shared/contract";
import type { AskEffect } from "../../src/shared/schema";
import { setup } from "./runtime-fixture";
import { planInput, seedLegacyQuest, seedQuest } from "./support";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function fixture() {
  const f = setup();
  databases.push(f.k.store.db);
  registerTools(f.bb, f.runtime);
  registerRpc(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Check the release", "Release");
  const input = { boardQuestId: q.id, kind: "decision", question: "Does this release work?", why: "Only you can test it", options: [{ id: "done", label: "Done" }], meanwhile: "Read feedback", holds: [] };
  const call = (input: object, threadId = "lead") => f.harness.behavior.invokeAgentTool("tavern_ask", input, { threadId });
  const open = async (variant: object = {}, threadId = "lead") => {
    const result = await call({ operation: "open", ...input, ...variant }, threadId);
    const id = /::tavern-ask\{id="([^"]+)"\}/.exec(result as string)![1]!;
    return f.k.store.get("asks", id)!;
  };
  const withdraw = (askId: string, reason = "The build was rolled back", threadId = "lead") => call({ operation: "withdraw", askId, reason }, threadId);
  const answer = (askId: string) => f.harness.invokeRpc("answerAsk", { askId, optionId: "done", via: "page" });
  const room = async () => rpcContract.room.output.parse(await f.harness.invokeRpc("room", {}));
  const count = async () => rpcContract.attentionCount.output.parse(await f.harness.invokeRpc("attentionCount", {})).count;
  const read = (askId: string) => f.k.store.get("asks", askId);
  return { ...f, q, call, open, input, withdraw, answer, room, count, read };
}

it("replaces all listed asks and publishes only the new card with its explicitly named holds", async () => {
  const f = await fixture();
  const one = await f.open({ holds: ["w1", "w2"] });
  const two = await f.open({ holds: ["w3"] });
  const unrelated = await f.open();
  expect(await f.count()).toBe(3);
  const question = "Does the newer release work?";
  const replacement = await f.open({ question, holds: ["w1", "w3"], replaces: [one.id, two.id] });
  expect(await f.count()).toBe(2);
  const { asks } = await f.room();
  expect(asks.map(a => a.id)).toEqual(expect.arrayContaining([replacement.id, unrelated.id]));
  expect(asks).toHaveLength(2);
  expect(f.k.store.openAsks("lead", f.q.id).flatMap(a => a.holds)).toEqual(["w1", "w3"]);
  for (const ask of [one, two]) {
    expect(f.read(ask.id)).toMatchObject({ state: "withdrawn", answer: null, withdrawnCause: "replaced", replacedByAskId: replacement.id });
    expect(f.k.store.events("lead").find(e => e.type === "ask.withdrawn" && e.data.askId === ask.id)).toMatchObject({ actor: { kind: "agent", threadId: "lead" }, data: { cause: "replaced", replacedByAskId: replacement.id, replacementQuestion: question } });
  }
});

it("withdraws with a reason but never completes a user waypoint or records an answer", async () => {
  const f = await fixture();
  const plan = planInput(f.q.id);
  f.k.plan("lead", { ...plan, waypoints: [{ ...plan.waypoints[0]!, actor: "user", check: "you", owner: null }] });
  f.k.answerAsk(f.k.store.openAsks("lead", f.q.id)[0]!.id, "approve", null, "page", "user");
  const one = await f.open({ waypointId: "w1", completeOn: ["done"] });
  const two = await f.open({ waypointId: "w1", completeOn: ["done"], replaces: [one.id] });
  expect(f.k.summary(f.q.id).waypoints[0]).toMatchObject({ state: "planned", askId: two.id });
  const reason = "The build was rolled back";
  await expect(f.withdraw(two.id, reason)).resolves.toContain("withdrawn");
  expect(f.read(two.id)).toMatchObject({ state: "withdrawn", answer: null, withdrawnCause: "keeper-withdrawn", withdrawnReason: reason });
  expect(f.k.store.events("lead").find(e => e.type === "ask.withdrawn" && e.data.askId === two.id)).toMatchObject({ text: reason, actor: { kind: "agent", threadId: "lead" } });
  expect(await f.count()).toBe(0);
  expect((await f.room()).asks).toEqual([]);
  expect(f.k.summary(f.q.id).waypoints[0]?.state).toBe("planned");
  expect(f.k.summary(f.q.id).waypoints[0]?.askId).toBeFalsy();
  await expect(f.answer(two.id)).rejects.toThrow(/no longer open/);
});

it("withdraws an early-close card without waiving work or ending the quest", async () => {
  const f = await fixture();
  const close = await f.runtime.proposeWrap("lead", f.q.id, "Wrap while work is open", "Still needs checking");
  const id = close.askId!;
  expect(f.k.quest(f.q.id).phase).toBe("closing");
  await expect(f.withdraw(id)).resolves.toContain("withdrawn");
  expect(f.k.quest(f.q.id)).toMatchObject({ phase: "scout", endedAt: null });
  expect(f.k.quest(f.q.id).waivers).toBeUndefined();
  expect(f.read(id)).toMatchObject({ state: "withdrawn", answer: null });
  expect(f.k.store.events("lead").find(e => e.type === "ask.withdrawn" && e.data.askId === id)).toMatchObject({ actor: { kind: "agent", threadId: "lead" } });
});

it.each(["answered", "withdrawn", "foreign", "another quest"])("refuses a mixed replacement list containing an ask that is %s", async (state) => {
  const f = await fixture();
  const good = await f.open();
  let bad;
  if (state === "foreign") {
    f.k.bind("other", "keeper", "moss", "project");
    const quest = await seedQuest(f.k, "other", "Another release", "Another");
    bad = await f.open({ boardQuestId: quest.id }, "other");
    await expect(f.withdraw(bad.id)).rejects.toThrow(/owned by this Keeper/);
  } else if (state === "another quest") {
    const quest = seedLegacyQuest(f.k, "lead", "Earlier release", "Earlier");
    bad = await f.open({ boardQuestId: quest.id });
  } else {
    bad = await f.open();
    if (state === "answered") await f.answer(bad.id);
    else f.k.withdrawAsk(bad.id, "turn-recovered");
    await expect(f.withdraw(bad.id)).rejects.toThrow(/no longer open/);
  }
  const before = f.k.store.all("asks");
  await expect(f.call({ ...f.input, replaces: [good.id, bad.id] })).rejects.toThrow(new RegExp(`${bad.id}.*(?:no longer open|owned by this Keeper|same quest)`));
  expect(f.k.store.all("asks")).toEqual(before);
});

const tavernEffects: AskEffect[] = [
  { type: "grant-scope", memberThreadId: "maker" },
  { type: "greenlight", planVersion: 1 },
  { type: "quest-start", sourceMessageId: "message", routeId: "route", parentQuestId: null, projectId: "project", goal: "Check the release" },
  { type: "communication-hold", hold: { id: "10000000-0000-4000-8000-000000000000", act: "send", tool: "post", target: "example", body: "Release update", threadId: "maker", scopeIssuedAt: 1, at: 2, callDigest: null, rulesDigest: "a".repeat(64) } },
];

it.each(tavernEffects)("refuses to withdraw or replace a Tavern-owned $type card", async effect => {
  const f = await fixture();
  const stale = await f.open();
  const managed = await f.open();
  f.k.store.put("asks", managed.id, { ...managed, effect });
  const asks = f.k.store.all("asks"), events = f.k.store.events("lead");
  await expect(f.withdraw(managed.id)).rejects.toThrow(/Tavern owns this card/);
  await expect(f.call({ ...f.input, replaces: [stale.id, managed.id] })).rejects.toThrow(/Tavern owns this card/);
  expect(f.k.store.all("asks")).toEqual(asks);
  expect(f.k.store.events("lead")).toEqual(events);
});

it("does not keep a partial withdrawal if saving the new card fails", async () => {
  const f = await fixture();
  const old = await f.open();
  const put = f.k.store.put.bind(f.k.store);
  const write = vi.spyOn(f.k.store, "put").mockImplementation((kind, id, record) => {
    if (kind === "asks" && id !== old.id) throw new Error("Storage unavailable");
    return put(kind, id, record);
  });
  try {
    await expect(f.open({ replaces: [old.id] })).rejects.toThrow("Storage unavailable");
    expect(f.read(old.id)).toEqual(old);
    expect(f.k.store.events("lead").some(e => e.type === "ask.withdrawn")).toBe(false);
  } finally { write.mockRestore(); }
});

it("keeps the recorded user answer if the answer wins the race", async () => {
  const f = await fixture();
  const ask = await f.open();
  let didCommit!: () => void, finishAnswer!: () => void;
  const committed = new Promise<void>(resolve => { didCommit = resolve; });
  const pending = new Promise<void>(resolve => { finishAnswer = resolve; });
  const returnFromAway = f.runtime.away.return.bind(f.runtime.away);
  const postCommit = vi.spyOn(f.runtime.away, "return").mockImplementation(async (...args) => {
    didCommit();
    await pending;
    return returnFromAway(...args);
  });
  const answer = f.answer(ask.id);
  try {
    await Promise.race([committed, answer.then(() => { throw new Error("Answer did not reach the post-commit hook"); })]);
    await expect(f.open({ replaces: [ask.id] })).rejects.toThrow(/no longer open/);
    await expect(f.withdraw(ask.id)).rejects.toThrow(/no longer open/);
  } finally {
    finishAnswer();
    postCommit.mockRestore();
  }
  await answer;
  expect(f.read(ask.id)).toMatchObject({ state: "answered", answer: { by: "user", optionId: "done" } });
  expect(f.k.store.openAsks("lead", f.q.id)).toEqual([]);
});

it("rejects a missing or multiline withdrawal reason and mixed operations", async () => {
  const f = await fixture();
  const ask = await f.open();
  await expect(f.withdraw(ask.id, " ")).rejects.toThrow(/reason/);
  await expect(f.withdraw(ask.id, "First line\nSecond line")).rejects.toThrow(/reason/);
  await expect(f.call({ operation: "withdraw", askId: ask.id, reason: "Moot", replaces: [ask.id] })).rejects.toThrow(/replaces/);
  expect(f.read(ask.id)).toEqual(ask);
});
