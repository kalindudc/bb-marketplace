// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest, waypointEntry } from "./support";
import { registerRpc } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";
import type { Ask } from "../../src/shared/schema";
import type { Ledger } from "../../src/shared/contract";
import { ASK_KINDS } from "../../src/shared/schema";
import { DELEGATABLE_KINDS, type DelegationKind } from "../../src/shared/quest-authority";

const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const client = { experimental_caller: { kind: "client" as const }, experimental_signal: new AbortController().signal };
const explicitPlugin = { ...client, experimental_caller: { kind: "plugin", pluginId: "tavern" } } as never;

async function fixture(count = 10) {
  const f = setup(); dbs.push(f.k.store.db);
  registerRpc(f.bb, f.runtime); registerTools(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Read the reports", "Read");
  const next = await seedQuest(f.k, "lead", "Read another report", "Another");
  f.k.resetRoutes("lead");
  for (const [quest, n] of [[q, count + 1], [next, 1]] as const) {
    const base = planInput(quest.id);
    f.k.plan("lead", { ...base, waypoints: Array.from({ length: n }, (_, i) => ({ ...base.waypoints[0]!, id: `w${i + 1}`, title: `Read ${i + 1}`, check: "keeper", optional: true })) });
    f.k.answerAsk(f.k.store.openAsks("lead", quest.id).find(a => a.kind === "greenlight")!.id, "approve", null, "page", "user");
  }
  f.port.linkedEntries = id => Array.from({ length: id === q.id ? count + 1 : 1 }, (_, i) => waypointEntry("maker", id, `w${i + 1}`, `a${i + 1}`));
  const acceptances = Array.from({ length: count }, (_, i) => f.k.settle("lead", { boardQuestId: q.id, waypointId: `w${i + 1}`, as: "accepted", reason: "Sources check out" }));
  const settle = (boardQuestId: string, as: "accepted" | "skipped", waypointId = "w1") => f.harness.behavior.invokeAgentTool("tavern_settle", { boardQuestId, waypointId, as, reason: "Sources check out" }, { threadId: "lead" });
  const ledger = (threadId = "lead") => f.harness.invokeRpc("ledger", { threadId }, client) as Promise<Ledger>;
  const undo = (decisionId: string) => f.harness.invokeRpc("undoDecision", { decisionId }, client);
  const reset = (kind: string, context = client) => f.harness.invokeRpc("resetUndoLane", { threadId: "lead", kind }, context);
  const delegate = (boardQuestId = q.id) => f.harness.invokeRpc("delegateQuest", { boardQuestId, kind: "credential", via: "page" }, client);
  const ask = (boardQuestId = q.id, kind: Ask["kind"] = "credential") => f.k.ask("lead", { boardQuestId, kind, effect: { type: "decision" }, question: `Approve ${kind}?`, why: "The member asked", meanwhile: "Continue other work", holds: [], options: [{ id: "yes", label: "Allow", detail: "Allow this act", recommended: true }] });
  const reply = (a = ask()) => f.k.decide("lead", { askId: a.id, optionId: "yes", boardQuestId: a.boardQuestId, text: "Allow", why: "The quest covers it", reversible: true, source: "keeper" });
  return { ...f, q, next, acceptances, settle, ledger, undo, reset, delegate, ask, reply };
}

it("keeps accepting, skipping and reopening with the Keeper after two undos each", async () => {
  const f = await fixture(2);
  for (const call of f.acceptances) await f.undo(call.id);
  for (const as of ["skipped", "open"] as const) {
    if (as === "open") await f.settle(f.q.id, "accepted");
    for (let i = 0; i < 2; i++) {
      const call = f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w1", as, reason: "Review the source again" });
      await f.undo(call.id);
    }
    expect(() => f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w1", as, reason: "Review the source again" })).not.toThrow();
    if (as === "skipped") f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w1", as: "open", reason: "Check the source again" });
  }
  await expect(f.settle(f.next.id, "accepted")).resolves.toBeTruthy();
  expect((await f.ledger()).undoLanes).toEqual([]);
});

it("counts the last ten calls of the routed ask kind, per Keeper, ignoring older or unrelated decisions", async () => {
  const f = await fixture(2);
  await f.delegate(); await f.delegate(f.next.id);
  const calls = Array.from({ length: 12 }, () => f.reply());
  const pending = f.ask(f.next.id);
  f.k.bind("other", "keeper", "wren", "project");
  const q = await seedQuest(f.k, "other", "Separate", "Separate");
  await f.harness.invokeRpc("delegateQuest", { boardQuestId: q.id, kind: "credential", via: "page" }, client);
  const otherAsk = () => f.k.ask("other", { boardQuestId: q.id, kind: "credential", question: "Approve?", why: "Evidence", meanwhile: "", holds: [], options: [{ id: "yes", label: "Allow", detail: "Proceed", recommended: true }], effect: { type: "decision" } });
  const a = otherAsk();
  const other = f.k.decide("other", { askId: a.id, optionId: "yes", boardQuestId: q.id, text: "Allow", why: "Covered", reversible: true, source: "keeper" });
  await f.undo(other.id);
  await f.undo(calls[0]!.id); await f.undo(calls[1]!.id);
  expect((await f.ledger()).undoLanes).toEqual([]);
  expect(f.k.authority.lane(pending)).toBe("keeper");
  for (let i = 0; i < 510; i++) f.k.decide("lead", { text: "Other work", why: "Routine", reversible: true, source: "keeper" });
  await f.undo(calls[2]!.id); await f.undo(calls[3]!.id);
  expect(f.k.authority.lane(pending)).toBe("user");
  expect(f.k.authority.lane(otherAsk())).toBe("keeper");
  expect(() => f.reply(pending)).toThrow(/The user undid 2 of your last 10 credential decisions.*ask the user.*reset/i);
  await expect(f.delegate(f.next.id)).rejects.toThrow("Reset this kind in the Ledger first");
  expect((await f.ledger()).asks).toContainEqual(expect.objectContaining({ id: pending.id, lane: "user" }));
  const nextAsk = f.ask(f.next.id);
  expect(nextAsk.lane).toBe("user");
  await f.undo(calls[4]!.id); await f.undo(calls[4]!.id);
  const ledger = await f.ledger();
  expect(ledger.undoLanes).toEqual([{ kind: "credential", undone: 3, recent: 10 }]);
  expect(ledger.restatement.match(/The user undid 3 of your last 10 credential decisions/g)).toHaveLength(1);
  expect((await f.ledger("other")).undoLanes).toEqual([]);
});

it("requires the user's reset and counts only undos after it, even at the same clock time", async () => {
  const f = await fixture(1);
  await f.delegate();
  const calls = Array.from({ length: 4 }, () => f.reply());
  await f.undo(calls[0]!.id); await f.undo(calls[1]!.id);
  await expect(f.reset("credential", explicitPlugin)).rejects.toThrow(/explicit client/i);
  expect((await f.ledger()).undoLanes).toHaveLength(1);
  await f.reset("credential");
  expect(f.k.authority.lane(f.ask())).toBe("keeper");
  expect(f.k.store.events("lead", 0, 500).filter(e => e.type === "lane.reset")).toMatchObject([{ actor: { kind: "user" }, data: { kind: "credential", surface: "client (unattested)" } }]);
  await f.undo(calls[2]!.id);
  expect((await f.ledger()).undoLanes).toEqual([]);
  await f.undo(calls[3]!.id);
  expect((await f.ledger()).undoLanes).toEqual([{ kind: "credential", undone: 2, recent: 4 }]);
});

it("leaves every existing ask lane unchanged without undos", async () => {
  const f = await fixture(1);
  const lane = (kind: Ask["kind"], unsure = false) => f.k.authority.lane({ kind, boardQuestId: f.q.id, unsure });
  for (const kind of ASK_KINDS) expect(lane(kind)).toBe("user");
  for (const kind of DELEGATABLE_KINDS) await f.harness.invokeRpc("delegateQuest", { boardQuestId: f.q.id, kind, via: "page" }, client);
  for (const kind of ASK_KINDS) {
    expect(lane(kind)).toBe(DELEGATABLE_KINDS.includes(kind as DelegationKind) ? "keeper" : "user");
    expect(lane(kind, true)).toBe("user");
  }
});

it.each(["party", "rangers"] as const)("keeps new %s exceptions with the Keeper after two undos", async kind => {
  const f = await fixture(1);
  const choice = () => f.k.decide("lead", { text: "One extra", why: "Bounded work", reversible: true, source: "keeper", exceeds: kind });
  const one = choice(), two = choice();
  await f.undo(one.id); await f.undo(two.id);
  expect(choice).not.toThrow();
  expect((await f.ledger()).undoLanes).toEqual([]);
});
