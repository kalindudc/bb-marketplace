// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import { TavernRuntime } from "../../src/server/runtime";
import { patchThreadFixture, runtimeFixture } from "./member-fixture";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makeThreadResponse } from "./host";
import { attention } from "../../src/server/attention";
import { rpcHandlers } from "../../src/server/rpc";
import { planInput, seedQuest } from "./support";
import { setup } from "./runtime-fixture";

const client = { experimental_caller: { kind: "client" } } as never;
const plugin = { experimental_caller: { kind: "plugin", pluginId: "tavern" } } as never;
const scout = { classId: "ranger", title: "Scout", brief: { outcome: "Read", doneWhen: "Evidence", outOfScope: "Edits", mode: "make-it-work" as const, context: [], questions: ["What changed?"], timeboxMinutes: 1 } };

async function fixture() {
  const burn = vi.fn().mockResolvedValue({ report: null });
  const f = setup({ plugins: { callRpc: burn } });
  const q = await seedQuest(f.k, "lead", "Budget", "Budget");
  const rpc = rpcHandlers(f.runtime);
  const spend = f.runtime.spend;
  const entry = (id: string, usdNanos: number | null, at = f.time(), threadId = "lead") => spend.ledger.ingest(threadId, [{ source: "Guarded local session", session: "s1", entry: id, at, usdNanos }]);
  return { ...f, q, rpc, spend, burn, entry };
}

describe("quest spend", () => {
  it("starts uncapped, treats missing as unknown, and never takes a cap from a plugin", async () => {
    const f = await fixture();
    expect(await f.rpc.questSpend({ id: f.q.id })).toMatchObject({ budgetCents: null, usdNanos: 0, missing: 0 });
    expect(f.burn).not.toHaveBeenCalled();
    await f.runtime.threadStarted(makeThreadResponse({ id: "lead", status: "active" }));
    await expect(async () => f.rpc.setSpendBudget({ id: f.q.id, budgetCents: 100 }, plugin)).rejects.toThrow(/explicit client action/);
    await f.rpc.setSpendBudget({ id: f.q.id, budgetCents: 100 }, client);
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ budgetCents: 100, reachedAt: null, usdNanos: null });
    expect(attention(f.k.store, { boardQuestId: f.q.id }).items.filter(i => i.id === `spend:${f.q.id}`)).toHaveLength(0);
  });

  it("holds new work exactly at the cap, records one hold, and keeps it until the user raises or removes it", async () => {
    const f = await fixture();
    await f.rpc.setSpendBudget({ id: f.q.id, budgetCents: 100 }, client);
    f.entry("a", 500_000_000);
    f.entry("a", 500_000_000);
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 500_000_000, reachedAt: null });
    f.entry("b", 500_000_000);
    await expect(f.runtime.hire("lead", "project", { ...scout, boardQuestId: f.q.id })).rejects.toThrow(/spend budget/);
    const check = () => attention(f.k.store, { boardQuestId: f.q.id }).items.filter(i => i.id === `spend:${f.q.id}`);
    expect(check()).toHaveLength(1);
    expect(check()[0]?.title).toBe("The quest reached its $1.00 spend budget. New hires and briefs wait until you raise or remove it.");
    await f.runtime.setQuestHeld(f.q.id, true, { kind: "user" });
    await f.runtime.setQuestHeld(f.q.id, false, { kind: "user" });
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 1_000_000_000, reachedAt: f.time() });
    expect(check()).toHaveLength(1);
    expect(f.k.store.events().filter(e => e.type === "spend-budget.reached")).toHaveLength(1);
    await f.rpc.setSpendBudget({ id: f.q.id, budgetCents: 200 }, client);
    expect(check()).toHaveLength(0);
    f.entry("c", 1_000_000_000);
    expect((await f.spend.refresh(f.q.id)).reachedAt).not.toBeNull();
    await f.rpc.setSpendBudget({ id: f.q.id, budgetCents: null }, client);
    expect((await f.spend.refresh(f.q.id)).reachedAt).toBeNull();
    expect(f.k.store.events().filter(e => e.type === "spend-budget.lifted")).toHaveLength(2);
  });

  it("reaches a quest budget during the Keeper sweep from a member's spend", async () => {
    const f = await fixture();
    f.k.bind("child", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: null, errand: false, title: "Read", brief: scout.brief });
    await f.rpc.setSpendBudget({ id: f.q.id, budgetCents: 25 }, client);
    f.entry("member-cost", 260_000_000, f.time(), "child");
    expect(f.k.quest(f.q.id).spendBudget?.reached).toBeNull();

    await f.runtime.sweep();

    expect(f.k.quest(f.q.id).spendBudget?.reached).toEqual({ at: f.time(), usdNanos: 260_000_000 });
  });

  it("applies a proposed cap only when the user approves the exact plan", async () => {
    const f = await fixture();
    f.k.plan("lead", { ...planInput(f.q.id), spendBudgetCents: 150 });
    const ask = f.k.store.openAsks("lead", f.q.id).find(a => a.kind === "greenlight")!;
    expect(await f.rpc.questAuthority({ boardQuestId: f.q.id })).toMatchObject({ spendBudget: null, spendProposal: 150 });
    expect((await f.spend.refresh(f.q.id)).budgetCents).toBeNull();
    await expect(async () => f.rpc.answerAsk({ askId: ask.id, optionId: "approve", note: null, via: "page", pullRequestChoices: [] }, plugin)).rejects.toThrow(/explicit client action/);
    await f.rpc.answerAsk({ askId: ask.id, optionId: "approve", note: null, via: "page", pullRequestChoices: [] }, client);
    expect((await f.spend.refresh(f.q.id)).budgetCents).toBe(150);
    await f.rpc.setSpendBudget({ id: f.q.id, budgetCents: 300 }, client);
    f.k.plan("lead", { ...planInput(f.q.id), spendBudgetCents: 150 });
    expect(f.k.store.openAsks("lead", f.q.id)).toHaveLength(0);
    expect((await f.spend.refresh(f.q.id)).budgetCents).toBe(300);
  });

  it("does not set a cap when a reversible one-slot plan is greenlit automatically", async () => {
    const f = await fixture();
    f.k.settings = () => ({ ...DEFAULT_SETTINGS, keepers: { ...DEFAULT_SETTINGS.keepers, greenlight: "by-size" } });
    f.k.plan("lead", { ...planInput(f.q.id), reversible: true, spendBudgetCents: 150, party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
    expect(f.k.quest(f.q.id).phase).toBe("build");
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ budgetCents: null, proposal: { cents: 150, planVersion: 1 } });
    expect(f.k.store.openAsks("lead", f.q.id)).toHaveLength(0);
    expect(f.k.store.events().filter(e => e.type === "spend-budget.proposal-not-set")).toHaveLength(1);
  });

  it("keeps a recovered brief pending while a running member can report", async () => {
    const f = await fixture();
    f.k.bind("child", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: null, errand: false, title: "Read", brief: scout.brief });
    f.runtime.spawnBriefDelivered("child");
    await f.rpc.setSpendBudget({ id: f.q.id, budgetCents: 25 }, client);
    f.entry("a", 260_000_000);
    await expect(f.runtime.sendRebrief("child", "New work")).rejects.toThrow(/spend budget/);
    expect(f.k.report("child", { status: "done", outcome: "Finished admitted work", evidence: [], artifacts: [], confidence: { intent: 100, safe: 100 }, voice: null }).outcome).toBe("Finished admitted work");
    patchThreadFixture(f.k.store, "child", { pendingBrief: { id: "brief_old", text: "Previously queued work", attempts: 0, nextAttemptAt: f.time(), attemptedAt: null, hostAfterSeq: null, error: null } });
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.retryInitialBriefs("lead");
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toMatchObject({ id: "brief_old", attempts: 0 });
    const rows = [queued049("human", "A human ping", f.time()), queued049("brief", "[Tavern brief] id=brief_old\nPreviously queued work", f.time(), { pluginId: "tavern" })];
    expect(await restarted.dispatch(dispatch049({ threadId: "child", rows }))).toMatchObject({ action: "wait", reason: expect.stringContaining("spend budget") });
    expect(f.harness.inspection.sdk.callsTo("threads.send").some(call => (call.args[0] as { threadId: string }).threadId === "child")).toBe(false);
  });

  it("imports a local spool once, keeps earlier measurements and marks unreadable usage unknown", async () => {
    const f = await fixture(), dir = mkdtempSync(join(tmpdir(), "tavern-spend-import-"));
    try {
      f.spend.ledger.directory = dir;
      const file = join(dir, "lead.json.spend");
      writeFileSync(file, JSON.stringify({ source: "Spoofed source", session: "s1", entry: "a", at: f.time(), usdNanos: 80 }) + "\n");
      expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 80, missing: 0, sources: [{ name: "Guarded local session" }] });
      expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 80, missing: 0 });
      rmSync(file);
      expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 80, missing: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("represents empty or malformed cost sources as missing and never treats empty Burn as zero", async () => {
    const f = await fixture();
    f.burn.mockResolvedValue({ report: { startedAt: f.q.createdAt, updatedAt: f.time(), calls: 3, turns: [] } });
    f.entry("unpriced", null);
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: null, sources: [], missing: 1 });
  });

  it("selects one source per thread without adding family or pre-quest spend", async () => {
    const f = await fixture();
    f.burn.mockResolvedValue({ report: { startedAt: 0, updatedAt: f.time(), calls: 2, estimated: true, turns: [
      { at: f.q.createdAt - 1, calls: 1, cost: 5 }, { at: f.time(), calls: 1, cost: 0.03 },
    ] }, family: { children: [{ threadId: "someone-else" }] } });
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 30_000_000 });
    f.entry("a", 20_000_000);
    f.entry("old", 100_000_000, f.q.createdAt - 1);
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 20_000_000, sources: [{ name: "Guarded local session" }] });
    expect(f.burn.mock.calls.every(([args]) => args.input.threadId === "lead")).toBe(true);
  });

  it("marks local spend partial when the latest admitted activity has no receipt", async () => {
    const f = await fixture();
    f.entry("a", 20_000_000);
    f.advance(60_000);
    await f.runtime.threadStarted(makeThreadResponse({ id: "lead", status: "active" }));
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 20_000_000, missing: 1 });
  });

  it("keeps the last measured Burn subtotal across a read failure and marks it partial", async () => {
    const f = await fixture();
    f.burn.mockResolvedValue({ report: { startedAt: f.q.createdAt, updatedAt: f.time(), calls: 1, turns: [{ at: f.time(), calls: 1, cost: 0.1 }] } });
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 100_000_000, missing: 0 });
    f.advance(11_000);
    f.burn.mockRejectedValue(new Error("Cost source unavailable"));
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    expect(await restarted.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 100_000_000, missing: 1, sources: [{ name: "Burn", readAt: 1_000_000 }] });
  });

  it.each(["{", '{"turns": "invalid"}'])("ignores a malformed saved Burn reading (%s) and accepts a fresh one", async (data) => {
    const f = await fixture();
    f.k.store.db.prepare("INSERT INTO tavern_spend_burn VALUES(?,?,?)").run("lead", f.time(), data);
    await f.runtime.threadStarted(makeThreadResponse({ id: "lead", status: "active" }));
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: null, sources: [], missing: 1 });
    f.advance(11_000);
    f.burn.mockResolvedValue({ report: { startedAt: f.q.createdAt, updatedAt: f.time(), calls: 1, turns: [{ at: f.time(), calls: 1, cost: 0.1 }] } });
    expect(await f.spend.refresh(f.q.id)).toMatchObject({ usdNanos: 100_000_000, missing: 0 });
  });

  it("splits shared Keeper costs only over that Keeper's active quests and keeps measured zero distinct", async () => {
    const f = await fixture();
    const sibling = await seedQuest(f.k, "lead", "Sibling", "Sibling");
    f.k.bind("other", "keeper", "wren", "project");
    const other = await seedQuest(f.k, "other", "Other", "Other");
    f.entry("a", 80);
    f.entry("b", 0, f.time(), "other");
    expect((await f.spend.refresh(f.q.id)).usdNanos).toBe(40);
    expect((await f.spend.refresh(sibling.id)).usdNanos).toBe(40);
    expect((await f.spend.refresh(other.id)).usdNanos).toBe(0);
  });
});
