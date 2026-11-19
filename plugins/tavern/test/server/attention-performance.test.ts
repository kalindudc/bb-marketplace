// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { rpcHandlers } from "../../src/server/rpc";
async function loadData(f: ReturnType<typeof setup>) {
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) ids.push((await seedQuest(f.k, "lead", `Q${i}`, `Q${i}`)).id);
  const put = f.k.store.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES(?,?,?)");
  f.k.store.atomic(() => {
    for (let i = 0; i < 4000; i++) put.run("notes", `n${i}`, JSON.stringify({ id: `n${i}`, keeperThreadId: "lead", boardQuestId: ids[i % 40], kind: i % 2 ? "fact" : "waiting-on-user", text: "x".repeat(200), action: "a", dueAt: null, condition: null, validUntil: null, sourceMessageId: null, routeId: null, state: i % 10 ? "done" : "open", createdAt: 1, updatedAt: 1 }));
    for (let i = 0; i < 3000; i++) put.run("decisions", `d${i}`, JSON.stringify({ id: `d${i}`, keeperThreadId: "lead", boardQuestId: ids[i % 40], text: "d", why: "w", source: "keeper", reversible: true, undone: false, seenAt: i % 3 ? 5 : null, createdAt: i }));
    for (let i = 0; i < 3000; i++) put.run("asks", `a${i}`, JSON.stringify({ id: `a${i}`, keeperThreadId: "lead", boardQuestId: ids[i % 40], question: "q", why: "w", kind: "decision", options: [], meanwhile: "m", holds: [], state: "answered", createdAt: i, effect: { type: "decision" } }));
  });
}
it("keeps reads, rows, payloads and latency bounded on R9's dataset", async () => {
  const f = setup();
  await loadData(f);
  const handlers = rpcHandlers(f.runtime);
  const views = {
    room: async () => { const payload = await handlers.room({}); return { payload, attention: payload.attention }; },
    ledger: async () => { const payload = await handlers.ledger({ threadId: "lead" }); return { payload, attention: payload.attention }; },
    decor: async () => { const payload = await handlers.decor({ threadId: "lead" }); return { payload, attention: payload.keeperView?.attention }; },
  };
  const limits = { room: { ms: 250, bytes: 300_000, items: 70 }, ledger: { ms: 300, bytes: 400_000, items: 420 }, decor: { bytes: 55_000, items: 70 } };
  for (const method of ["room", "ledger", "decor"] as const) {
    await views[method]();
    const samples: number[] = [];
    for (let n = 0; n < 5; n++) { const start = performance.now(); await views[method](); samples.push(performance.now() - start); }
    const reads = vi.spyOn(f.k.store.db, "prepare");
    const all = vi.spyOn(f.k.store, "all");
    const { payload, attention } = await views[method]();
    expect(reads.mock.calls.filter(([sql]) => sql.startsWith("SELECT r.data") && sql.includes("WHERE r.kind=?") && sql.endsWith("ORDER BY r.rowid"))).toHaveLength(5);
    expect(all.mock.calls.filter(([kind]) => ["notes", "quests", "rules", "asks", "decisions"].includes(kind))).toHaveLength(0);
    reads.mockRestore(); all.mockRestore();
    const ms = samples.sort((a, b) => a - b)[2]!;
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    process.stdout.write(`ATTENTION_METRICS ${JSON.stringify({ method, ms, bytes, items: attention?.items.length })}\n`);
    expect(attention).toMatchObject({ needYou: 400, new: 1000, heldByYou: 0 });
    expect(attention!.items.length).toBeLessThanOrEqual(limits[method].items);
    expect(bytes).toBeLessThanOrEqual(limits[method].bytes);
    if (method !== "decor") expect(ms).toBeLessThanOrEqual(limits[method].ms);
  }
}, 60000);
