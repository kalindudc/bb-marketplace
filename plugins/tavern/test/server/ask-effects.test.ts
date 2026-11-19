// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { ASK_EFFECTS, applyAskEffect, type EffectHandlers, legacyAskEffect } from "../../src/server/ask-effects";

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
