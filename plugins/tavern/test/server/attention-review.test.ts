// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { putQuestFixture, seedQuest } from "./support";
import { attention } from "../../src/server/attention";
import { rpcHandlers } from "../../src/server/rpc";
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
