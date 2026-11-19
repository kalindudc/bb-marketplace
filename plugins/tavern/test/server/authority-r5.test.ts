// @vitest-environment node
import { expect, it, vi } from "vitest";
import { defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { setup } from "./runtime-fixture";
import { seedQuest, planInput, waypointEntry } from "./support";
import { registerRpc } from "../../src/server/rpc";
import { userActHandlers, commitUserAct } from "../../src/server/authority";
import { SettingsStore } from "../../src/server/settings/store";
import { settingsCommands } from "../../src/server/settings/cli";
import { QUEST_TRANSITIONS } from "../../src/server/keeper/quest-lifecycle";
import { LimitPolicy } from "../../src/server/limit-policy";
const client = { experimental_caller: { kind: "client" as const }, experimental_signal: new AbortController().signal };
it("does not attach a user receipt to an overdue promise triggered by an answer", async () => {
  const f = setup(); registerRpc(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Watch", "Watch");
  f.k.memory.note("lead", { kind: "commitment", text: "Report by noon", boardQuestId: q.id, dueAt: f.time() + 1000 });
  f.advance(120000);
  const ask = f.k.ask("lead", { effect: {type:"decision"}, kind: "decision", boardQuestId: q.id, question: "Proceed?", why: "Choice", options: [{ id: "yes", label: "Yes", detail: "", recommended: true }], meanwhile: "Wait", holds: [] });
  await f.harness.invokeRpc("answerAsk", { askId: ask.id, optionId: "yes", note: null, via: "page" }, client);
  await f.runtime.settleWakes();
  const due = f.k.store.events("lead", 0, 1000).filter(e => e.type === "promise.due");
  expect(due.length).toBeGreaterThan(0);
  for (const e of due) { expect(e.actor).toEqual({ kind: "tavern" }); expect(e.data).not.toHaveProperty("authority"); }
});
it("commits its receipt atomically without leaking it into a timer", async () => {
  const f = setup(); let completion: Promise<void> | undefined;
  const event = f.k.store.event.bind(f.k.store);
  vi.spyOn(f.k.store, "event").mockImplementation((...args) => {
    if (args[3] === "authority.acted") expect(f.k.store.db.inTransaction).toBe(true);
    return event(...args);
  });
  const handlers = userActHandlers({ undoDecision: (_input: unknown, _context?: unknown) => {
    completion = new Promise(resolve => setTimeout(() => {
      f.k.store.event(f.time(), "lead", null, "later.unrelated", "Background");
      resolve();
    }, 0));
    return { ok: true };
  } }, f.k.store, () => f.time());
  handlers.undoDecision({}, client);
  await completion;
  const background = f.k.store.events().find(e => e.type === "later.unrelated");
  expect(background?.actor).toEqual({ kind: "tavern" });
  expect(background?.data).not.toHaveProperty("authority");
});
it("rolls back the receipt together with a refused act", () => {
  const f = setup();
  const handlers = userActHandlers({ undoDecision: (_input: unknown, _context?: unknown) => {
    f.k.store.patch("lead", { heldAt: 123 });
    throw new Error("Refused act");
  } }, f.k.store, () => f.time());
  expect(() => handlers.undoDecision({}, client)).toThrow("Refused act");
  expect(f.k.store.runtime("lead").heldAt).toBeNull();
  expect(f.k.store.events().filter(e => e.type === "authority.acted")).toEqual([]);
});
it("keeps mutations atomic even when there is no user receipt", () => {
  const f = setup();
  expect(() => commitUserAct(f.k.store, () => f.time(), undefined, () => {
    f.k.store.patch("lead", { heldAt: 123 });
    throw new Error("Refused transition");
  })).toThrow("Refused transition");
  expect(f.k.store.runtime("lead").heldAt).toBeNull();
  expect(f.k.store.events().filter(e => e.type === "authority.acted")).toEqual([]);
});
it("keeps the user's raised party allowance with the built-in Keeper", async () => {
  const f = setup(), config = f.runtime.config.bind(f.runtime);
  f.runtime.config = q => { const c = config(q); return { ...c, keepers: { ...c.keepers, partyMax: 8 } }; };
  const input = { classId: "wanderer", errand: true, title: "Look", brief: { outcome: "Read", doneWhen: "Evidence", outOfScope: "Changes", mode: "make-it-work" as const, context: [], questions: [], timeboxMinutes: 1 } };
  for (let i = 0; i < 8; i++) await expect(f.runtime.hire("lead", "project", input)).resolves.toBeTruthy();
  await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/party budget/);
});
it.each([8, 3])("keeps a custom class's soft party size below partyMax %s", async partyMax => {
  const f = setup(), config = f.runtime.config.bind(f.runtime), snapshot = f.runtime.snapshot();
  snapshot.classes = snapshot.classes.map(role => role.id === "keeper" ? { ...role, source: "global" as const, budget: { rangers: 3, rangerMinutes: 5, ...role.budget, members: 2 } } : role);
  vi.spyOn(f.runtime, "snapshot").mockReturnValue(snapshot);
  f.runtime.config = q => { const c = config(q); return { ...c, keepers: { ...c.keepers, partyMax } }; };
  const input = { classId: "wanderer", errand: true, title: "Look", brief: { outcome: "Read", doneWhen: "Evidence", outOfScope: "Changes", mode: "make-it-work" as const, context: [], questions: [], timeboxMinutes: 1 } };
  for (let i = 0; i < 2; i++) await expect(f.runtime.hire("lead", "project", input)).resolves.toBeTruthy();
  for (let i = 0; i < 2; i++) await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/party budget/);
  const allowOne = () => f.k.decide("lead", { text: "One extra helper", why: "Bounded work", reversible: true, source: "keeper", exceeds: "party" });
  allowOne();
  await expect(f.runtime.hire("lead", "project", input)).resolves.toBeTruthy();
  await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/party budget/);
  for (let count = 3; count < partyMax; count++) {
    allowOne();
    await expect(f.runtime.hire("lead", "project", input)).resolves.toBeTruthy();
  }
  const unused = allowOne();
  await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/party budget/);
  expect(new LimitPolicy(f.k).softDecision("lead", null, "party")).toBe(unused.id);
});
it.each([true, false])("honours the recorded agent settings grant: %s", async enabled => {
  const f = setup(), store = new SettingsStore(f.k.store.db);
  store.update({ revision: 0, patch: { tavern: { agentsMayChangeSettings: enabled } }, why: "User's grant" });
  const cli = defineCli({ name: "tavern", summary: "Tavern", commands: settingsCommands({} as BbPluginApi, store) });
  const result = await cli.run(["settings", "set", "tavern.characters=false", "--apply"], { threadId: "lead" });
  expect(result.exitCode).toBe(enabled ? 0 : 1);
  expect(store.read().tavern.characters).toBe(!enabled);
  if (enabled) expect(store.historySince(0).find(row => row.threadId === "lead")?.threadId).toBe("lead");
  const blocked = await cli.run(["settings", "set", "keepers.partyMax=8", "--apply"], { threadId: "lead" });
  expect(blocked.exitCode).toBe(1);
});
it("keeps an incomplete legacy greenlight open with a useful refusal", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Build", "Build");
  f.k.plan("lead", planInput(q.id));
  const a = f.k.store.openAsks("lead", q.id)[0]!, { effect: _effect, ...old } = a;
  f.k.store.put("asks", a.id, old);
  await expect(f.runtime.answerAsk(a.id, "approve", null, "page", true)).rejects.toThrow(/old ask.*plan version/i);
  expect(f.k.store.openAsks("lead", q.id)).toHaveLength(1);
  expect(f.k.quest(q.id).phase).toBe("greenlight");
});
it("keeps an incomplete legacy conclude ask open and visible", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Build", "Build");
  const plan = planInput(q.id);
  f.k.plan("lead", { ...plan, waypoints: [{ ...plan.waypoints[0]!, optional: true }] });
  f.k.answerAsk(f.k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
  const entry = waypointEntry("maker", q.id), get = f.port.get;
  f.port.get = id => ({ ...get(id), entries: id === "maker" ? [entry] : [] }); f.port.linkedEntries = () => [entry];
  await f.runtime.proposeWrap("lead", q.id, "Built", "", [{ waypointId: "w1", reason: "Not needed" }]);
  const ask = f.k.store.openAsks("lead", q.id).find(a => a.kind === "conclude")!, { effect: _effect, ...old } = ask;
  f.k.store.put("asks", ask.id, old);
  await expect(f.runtime.answerAsk(ask.id, "conclude", null, "page", true)).rejects.toThrow(/old ask.*conclusion draft/i);
  expect(f.k.store.openAsks("lead", q.id)).toHaveLength(1);
  expect(f.k.quest(q.id).phase).toBe("closing");
});
it("creates a provider retry with its final typed effect in the first write", () => {
  const f = setup(), put = f.k.store.put.bind(f.k.store), effects: unknown[] = [];
  vi.spyOn(f.k.store, "put").mockImplementation((kind, id, value) => {
    if (kind === "asks") effects.push((value as { effect?: unknown }).effect);
    return put(kind, id, value);
  });
  f.runtime.failed("lead", "boom"); f.runtime.failed("lead", "boom");
  expect(effects).toEqual([{ type: "retry-provider" }]);
});
it("has no explicit-user lifecycle row for reopening", () => {
  expect(QUEST_TRANSITIONS.filter(row => row.cause === "reopen").every(row => !row.actors.includes("user") && row.receipt === "user-message")).toBe(true);
});
it("ends unused review allowances with the quest", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Watch", "Watch");
  new LimitPolicy(f.k).allowReview(q.id, "client (unattested)");
  await f.runtime.stop(q.id);
  expect(f.k.quest(q.id).reviewAllowance?.filter(g => g.usedBy === null) ?? []).toEqual([]);
});
