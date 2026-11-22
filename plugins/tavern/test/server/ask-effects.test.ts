// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { ASK_EFFECTS, applyAskEffect, type EffectHandlers, legacyAskEffect } from "../../src/server/ask-effects";
import { AttentionSnapshot, askNeedsUser } from "../../src/server/attention";
import type { Ask } from "../../src/shared/schema";

it("never routes effects with only acknowledgement to the user", () => {
  const f = setup();
  for (const type of Object.keys(ASK_EFFECTS)) {
    const notice = ["scope-blocker", "registry-blocker", "placement-blocker", "retry-brief", "retry-stop", "answer-blocker"].includes(type);
    const ask = { lane: "user", keeperThreadId: "lead", effect: { type }, options: [{ id: "review" }] } as Ask;
    expect(askNeedsUser(f.k.store, ask), type).toBe(!notice);
  }
});

it("preserves a historical blocker with alternatives and does not turn an acknowledgement into a user ask", () => {
  const { k } = setup();
  const ask = k.ask("lead", { kind: "blocker", effect: { type: "answer-blocker" }, question: "Which way?", why: "Pick a route",
    options: [{ id: "wait", label: "Wait", detail: "", recommended: false }, { id: "redirect", label: "Redirect", detail: "", recommended: false }],
    holds: [], meanwhile: "" });
  const acknowledgement = { ...ask, id: "review", options: ask.options.slice(0, 1) };
  k.store.put("asks", acknowledgement.id, acknowledgement);
  k.moveNoticeAsks();
  expect(k.store.get("asks", acknowledgement.id)?.state).toBe("open");
  expect(k.store.openAsks("lead", undefined, true).map(a => a.id)).toEqual([ask.id]);
  expect(new AttentionSnapshot(k.store).asks.map(a => a.id)).toEqual([ask.id]);
});

it.each([true, false])("settles old scope alerts exactly once (typed: %s)", typed => {
  const f = setup();
  const legacy = {
    id: "old-ask", keeperThreadId: "lead", boardQuestId: null, kind: "blocker", lane: "user",
    question: "Scope blocked Robin", why: "write-path: Outside allowed roots", meanwhile: "", holds: [],
    options: [{ id: "review", label: "Review the blocked call", detail: "No permission change", recommended: true }],
    state: "open", answer: null, proceedAt: null, createdAt: f.time(), draft: null,
    ...(typed ? { effect: { type: "scope-blocker", memberThreadId: "member" } } : {}),
  } satisfies Ask;
  f.k.store.put("asks", legacy.id, legacy);
  if (!typed) f.k.store.put("askMeta", legacy.id, { scopeThreadId: "member" });
  f.k.moveNoticeAsks();
  f.k.moveNoticeAsks();
  expect(f.k.store.get("asks", legacy.id)).toMatchObject({ state: "answered", answer: { by: "tavern", note: "Moved to the Keeper." } });
  expect(new AttentionSnapshot(f.k.store).asks).toEqual([]);
  expect(f.k.store.events("lead").filter(event => event.type === "blocker.moved")).toMatchObject([
    { actor: { kind: "tavern" }, text: expect.stringContaining(legacy.why), data: { memberThreadId: "member", askId: legacy.id } },
  ]);
});

it.each([
  [{ kind: "greenlight" }, { planVersion: 3 }, {}, { type: "greenlight", planVersion: 3 }],
  [{ kind: "conclude" }, { wrapDraft: { outcome: "done", left: "none" } }, {}, { type: "conclude", draft: { outcome: "done", left: "none" } }],
  [{ releaseHoldId: "hold" }, {}, {}, { type: "release-hold", holdId: "hold" }],
  [{}, { stopMemberThreadId: "member" }, {}, { type: "retry-stop", memberThreadId: "member" }],
  [{}, { stopHireTokens: ["token"] }, {}, { type: "retry-stop", hireTokens: ["token"] }],
  [{}, { briefDelivery: { threadId: "member", briefId: "brief" } }, {}, { type: "retry-brief", threadId: "member", briefId: "brief" }],
  [{ kind: "scope", scopeChange: { memberThreadId: "member" } }, {}, {}, { type: "grant-scope", memberThreadId: "member" }],
  [{ id: "ask" }, {}, { failureAskId: "ask" }, { type: "retry-provider" }],
  [{ id: "ask" }, {}, { tickDeliveryAskId: "ask" }, { type: "retry-tick" }],
  [{ kind: "blocker" }, {}, {}, { type: "answer-blocker" }],
  [{}, { scopeThreadId: "member" }, {}, { type: "scope-blocker", memberThreadId: "member" }],
  [{}, { guardHire: { fingerprint: "f", providerId: "p", model: "m", characterId: null, displayName: "Name" } }, {}, { type: "detection-hire", binding: { fingerprint: "f", providerId: "p", model: "m", characterId: null, displayName: "Name" } }],
  [{ kind: "greenlight" }, {}, {}, { type: "decision" }],
  [{}, {}, {}, { type: "decision" }],
])("maps an exact old shape without changing the record", (ask, meta, runtime, expected) => {
  const original = structuredClone(ask);
  expect(legacyAskEffect(ask as never, meta as never, runtime as never)).toEqual(expected);
  expect(ask).toEqual(original);
});
it.each(Object.keys(ASK_EFFECTS))("dispatches %s to exactly its declared handler", type => {
  const handlers = Object.fromEntries(Object.keys(ASK_EFFECTS).map(key => [key, vi.fn()])) as Partial<EffectHandlers>;
  if (["scope-blocker", "registry-blocker"].includes(type)) {
    expect(() => applyAskEffect({ type } as never, handlers, { by: "user", id: "answer" })).toThrow(/belongs to the Keeper/);
    expect(Object.values(handlers).every(handler => vi.mocked(handler).mock.calls.length === 0)).toBe(true);
    return;
  }
  applyAskEffect({ type } as never, handlers, { by: "user", id: "answer" });
  for (const [key, handler] of Object.entries(handlers)) expect(handler).toHaveBeenCalledTimes(key === type ? 1 : 0);
});
it("hydrates old records on every read without writing a migration", () => {
  const f = setup();
  const saved = f.k.ask("lead", { effect: {type:"decision"}, kind: "decision", question: "Plain?", why: "Choice", options: [{ id: "yes", label: "Yes", detail: "", recommended: false }], meanwhile: "Scout", holds: [] });
  const { effect: _effect, ...old } = saved;
  f.k.store.put("asks", saved.id, old);
  f.k.store.put("askMeta", saved.id, { briefDelivery: { threadId: "member", briefId: "brief" } });
  const before = f.k.store.db.prepare("SELECT data FROM tavern_records WHERE kind='asks' AND id=?").get(saved.id);
  const expected = { type: "retry-brief", threadId: "member", briefId: "brief" };
  expect(f.k.store.get("asks", saved.id)?.effect).toEqual(expected);
  expect(f.k.store.query("asks", "keeperThreadId", "lead")[0]?.effect).toEqual(expected);
  expect(f.k.store.visibleRecords("asks", "lead")[0]?.effect).toEqual(expected);
  expect(f.k.store.latest("asks")[0]?.effect).toEqual(expected);
  expect(f.k.store.all("asks")[0]?.effect).toEqual(expected);
  expect(f.k.store.openAsks()[0]?.effect).toEqual(expected);
  expect(f.k.store.db.prepare("SELECT data FROM tavern_records WHERE kind='asks' AND id=?").get(saved.id)).toEqual(before);
});
it("answers an unmatched old shape as a plain decision", async () => {
  const f = setup();
  const ask = f.k.ask("lead", { effect: {type:"decision"}, kind: "decision", question: "Plain?", why: "Choice", options: [{ id: "yes", label: "Yes", detail: "", recommended: false }], meanwhile: "Scout", holds: [] });
  const { effect: _effect, ...old } = ask;
  f.k.store.put("asks", ask.id, old);
  await f.runtime.answerAsk(ask.id, "yes", null, "page", true);
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ effect: { type: "decision" }, state: "answered" });
});
it("records one withdrawal event with its cause", () => {
  const f = setup();
  const ask = f.k.ask("lead", { effect: {type:"decision"}, kind: "decision", question: "Plain?", why: "Choice", options: [{ id: "yes", label: "Yes", detail: "", recommended: false }], meanwhile: "Scout", holds: [] });
  f.k.withdrawAsk(ask.id, "plan-superseded");
  f.k.withdrawAsk(ask.id, "plan-superseded");
  expect(f.k.store.events().filter(e => e.type === "ask.withdrawn")).toMatchObject([{ data: { askId: ask.id, cause: "plan-superseded" } }]);
});
