// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { putQuestFixture, seedQuest } from "./support";
import { attention } from "../../src/server/attention";
import { rpcHandlers } from "../../src/server/rpc";
it("expired hand-backs stay in attention until a user clears them", () => {
  const f = setup();
  f.k.memory.note("lead", { kind: "waiting-on-user", text: "Access", action: "Approve access", need: "Please approve access.", validUntil: f.time() - 1 });
  expect(attention(f.k.store, { keeperThreadId: "lead" }, f.time()).needYou).toBe(1);
});
it("one hand-back action records one authority act", async () => {
  const f = setup();
  const n = f.k.memory.note("lead", { kind: "waiting-on-user", text: "Access", action: "Approve access", need: "Please approve access." });
  vi.spyOn(f.runtime, "wakeKeeper").mockResolvedValue(undefined as never);
  await rpcHandlers(f.runtime).resolveHandBack({ noteId: n.id, how: "done" }, { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal });
  expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_events WHERE type='authority.acted'").get()).toEqual({ n: 1 });
});
it("nested user acts record one receipt rather than one per transaction wrapper", async () => {
  const f = setup();
  await rpcHandlers(f.runtime).journalEdit({ threadId: "lead", edit: { op: "add", descriptions: ["Work"], parentId: null } }, { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal });
  expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_events WHERE type=\'authority.acted\'").get()).toEqual({ n: 1 });
});
it("attributes legacy project proposals to their recorded Keeper", () => {
  const f = setup();
  const r = f.k.addRule({ scope: "project", scopeId: "project", text: "Rule", source: "keeper-proposed" }, "lead");
  f.k.store.db.prepare("UPDATE tavern_records SET data=json_remove(data,'$.keeperThreadId') WHERE kind='rules' AND id=?").run(r.id);
  expect(attention(f.k.store, { keeperThreadId: "lead" }).needYou).toBe(1);
});
it("Ledger history is paged but all open hand-backs and asks are included", async () => {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "History", "History");
  const ask = f.k.ask("lead", { effect: { type: "decision" }, boardQuestId: q.id, kind: "decision", question: "Answer", why: "User", meanwhile: "Wait", holds: [], options: [{ id: "yes", label: "Yes", detail: "", recommended: true }] });
  for (let i = 0; i < 200; i++) f.k.store.put("asks", `old${i}`, { ...ask, id: `old${i}`, state: "answered" });
  const view = await rpcHandlers(f.runtime).ledger({ threadId: "lead" });
  expect(view.asks.filter(a => a.state !== "open")).toHaveLength(50);
  expect(view.asks.find(a => a.id === ask.id)).toBeTruthy();
  expect((view as any).asksNextCursor).toBeTruthy();
});
