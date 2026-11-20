// @vitest-environment node
import { withMemberFixtures } from "./member-fixture";
import { putQuestFixture } from "./support";
import { seedQuest } from "./support";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardQuest, Decision } from "../../src/shared/schema";
import type { BoardQuestDetail, Ledger, Room, ThreadDecor } from "../../src/shared/contract";
import { decisionSchema } from "../../src/shared/schema";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { TavernRuntime } from "../../src/server/runtime";
import { registerRpc } from "../../src/server/rpc";
import { createFakePluginHost } from "./host";
import { setup } from "./runtime-fixture";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
type Mark = { ok: true; ids: string[]; undoToken: string | null };
function fixture() {
  const f = setup();
  databases.push(f.k.store.db);
  registerRpc(f.bb, f.runtime);
  const call = <T = unknown>(name: string, input: unknown) => f.harness.invokeRpc(name, input) as Promise<T>;
  const decide = (id: string, extra: Partial<Decision> = {}) => f.k.store.put("decisions", id, {
    id, keeperThreadId: "lead", boardQuestId: null, text: id, why: "Reversible draft", source: "keeper",
    sourceRef: null, reversible: true, undone: false, createdAt: f.time(), ...extra,
  });
  const quest = async (phase: BoardQuest["phase"], archived = false) => {
    const q = await seedQuest(f.k,"lead", phase, phase);
    putQuestFixture(f.k.store, q.id, { ...q, phase, endedAt: f.time(), archivedAt: archived ? f.time() : null });
    return q.id;
  };
  const mark = (input: unknown) => call<Mark>("markDecisionsSeen", input);
  const unseen = (undoToken: string) => call<{ ok: true; ids: string[] }>("markDecisionsUnseen", { undoToken });
  return { ...f, call, decide, quest, mark, unseen };
}

describe("decision acknowledgement", () => {
  it("keeps optional seenAt sparse and accepts null or an epoch", () => {
    const f = fixture(), d = f.decide("sparse");
    expect(decisionSchema.parse(d)).not.toHaveProperty("seenAt");
    expect(decisionSchema.parse({ ...d, seenAt: null })).toHaveProperty("seenAt", null);
    expect(decisionSchema.parse({ ...d, seenAt: f.time() })).toHaveProperty("seenAt", f.time());
    expect(() => decisionSchema.parse({ ...d, seenAt: -1 })).toThrow();
  });

  it("uses one attention predicate before the cap, retaining returned/stopped and unscoped decisions", async () => {
    const f = fixture();
    const active = await f.quest("scout"), returned = await f.quest("done"), stopped = await f.quest("stopped"), cellared = await f.quest("done", true);
    for (const [id, boardQuestId] of [["active", active], ["returned", returned], ["stopped", stopped], ["unscoped", null]] as const) f.decide(id, { boardQuestId });
    f.k.bind("other", "keeper", "wren", "project");
    f.decide("other", { keeperThreadId: "other" });
    for (let i = 0; i < 130; i++) f.decide(`history-${i}`, { boardQuestId: cellared });
    f.decide("seen", { seenAt: f.time() });
    f.decide("null-seen", { seenAt: null });
    f.decide("undone", { undone: true });
    f.decide("user", { source: "user" });
    f.decide("consequential", { reversible: false });
    const room = await f.call<Room>("room", {}), ledger = await f.call<Ledger>("ledger", { threadId: "lead" }), decor = await f.call<ThreadDecor>("decor", { threadId: "lead" });
    expect(room.decidedForYou.map(d => d.id).sort()).toEqual(["active", "null-seen", "other", "returned", "stopped", "unscoped"]);
    expect(room.decidedCount).toBe(6);
    expect(ledger.decidedCount).toBe(5);
    expect(ledger.decidedForYou).toEqual(decor.keeperView!.decidedForYou);
    expect(decor.keeperView!.decidedCount).toBe(5);
    expect(ledger.decidedThroughId).toBe(decor.keeperView!.decidedThroughId);
    expect((await f.call<BoardQuestDetail>("boardQuest", { id: cellared })).decisions).toHaveLength(100);
  });

  it("marks only changed visible ids without undoing or waking the Keeper or changing its memory", async () => {
    const f = fixture(), q = await f.quest("done");
    f.decide("one", { boardQuestId: q }); f.decide("two");
    f.k.store.patch("lead", { manualStopAt: f.time() });
    const statement = f.k.restatement("lead"), runtime = f.k.store.runtime("lead"), events = f.k.store.events("lead", 0, 500);
    const tick = vi.spyOn(f.runtime, "tick");
    const result = await f.mark({ ids: ["one", "one", "missing"] });
    expect(result.ids).toEqual(["one"]); expect(result.undoToken).toEqual(expect.any(String));
    expect(f.k.store.get("decisions", "one")).toMatchObject({ seenAt: f.time(), undone: false });
    expect(f.k.restatement("lead")).toBe(statement);
    expect(f.k.store.runtime("lead")).toEqual(runtime);
    expect(f.k.store.events("lead", 0, 500)).toEqual(events);
    expect(tick).not.toHaveBeenCalled();
    expect((await f.call<Room>("room", {})).decidedForYou.map(d => d.id)).toEqual(["two"]);
    expect(await f.mark({ ids: ["one"] })).toEqual({ ok: true, ids: [], undoToken: null });
    expect(f.bb.rpc.experimental_invalidate).toHaveBeenLastCalledWith(expect.arrayContaining(["tavern:room", "tavern:thread:lead", `tavern:quest:${q}`]));
    expect(await f.unseen(result.undoToken!)).toEqual({ ok: true, ids: ["one"] });
    expect(f.k.store.get("decisions", "one")).toMatchObject({ undone: false });
    expect(f.k.restatement("lead")).toBe(statement);
  });

  it("keeps tokens durable across runtime replacement and ignores stale Undo even at the same clock time", async () => {
    const f = fixture(); f.decide("one");
    const first = await f.mark({ ids: ["one"] });
    const host = createFakePluginHost({ pluginId: "tavern", sdk: {} });
    const keeper = withMemberFixtures(new Keeper(new KeeperStore(f.k.store.db), f.port, f.time));
    registerRpc(host.bb, new TavernRuntime(host.bb, keeper, f.runtime.registry));
    await host.harness.invokeRpc("markDecisionsUnseen", { undoToken: first.undoToken });
    const second = await f.mark({ ids: ["one"] });
    expect(second.undoToken).not.toBe(first.undoToken);
    expect(await f.unseen(first.undoToken!)).toEqual({ ok: true, ids: [] });
    expect(f.k.store.get("decisions", "one")!.seenAt).toBe(f.time());
    expect(await f.unseen(second.undoToken!)).toEqual({ ok: true, ids: ["one"] });
  });

  it("retains the acknowledgement and its Undo token in a cold SQLite image", async () => {
    const f = fixture(); f.decide("one");
    const marked = await f.mark({ ids: ["one"] });
    const db = new Database(f.k.store.db.serialize());
    databases.push(db);
    const host = createFakePluginHost({ pluginId: "tavern", sdk: {} });
    const keeper = withMemberFixtures(new Keeper(new KeeperStore(db), f.port, f.time));
    registerRpc(host.bb, new TavernRuntime(host.bb, keeper, f.runtime.registry));
    expect(keeper.store.get("decisions", "one")!.seenAt).toBe(f.time());
    expect(await host.harness.invokeRpc("markDecisionsUnseen", { undoToken: marked.undoToken })).toEqual({ ok: true, ids: ["one"] });
    expect(keeper.store.get("decisions", "one")!.seenAt).toBeNull();
    expect(f.k.store.get("decisions", "one")!.seenAt).toBe(f.time());
  });

  it("preserves seen state through cellar and bring-up, and Undo never reopens a business decision", async () => {
    const f = fixture(), id = await f.quest("done"); f.decide("one", { boardQuestId: id });
    const result = await f.mark({ ids: ["one"] });
    await f.call("archiveBoardQuests", { ids: [id], archived: true });
    const detail = await f.call<BoardQuestDetail>("boardQuest", { id });
    expect(detail.decisions[0]).toMatchObject({ id: "one", seenAt: f.time() });
    expect((await f.call<Ledger>("ledger", { threadId: "lead" })).decisions[0]!.id).toBe("one");
    await f.call("archiveBoardQuests", { ids: [id], archived: false });
    expect((await f.call<Room>("room", {})).decidedForYou).toEqual([]);
    f.k.undoDecision("one");
    await f.unseen(result.undoToken!);
    expect(f.k.store.get("decisions", "one")!.undone).toBe(true);
    expect((await f.call<Room>("room", {})).decidedForYou).toEqual([]);
  });

  it("counts past the page cap and marks all without acknowledging post-snapshot arrivals", async () => {
    const f = fixture();
    for (let i = 0; i < 205; i++) f.decide(`old-${i}`);
    const before = await f.call<Room>("room", {});
    expect(before.decidedForYou).toHaveLength(20); expect(before.decidedCount).toBe(205);
    const decor = await f.call<ThreadDecor>("decor", { threadId: "lead" });
    const ledger = await f.call<Ledger>("ledger", { threadId: "lead" });
    expect(decor.keeperView).toMatchObject({ decidedCount: 205, decidedThroughId: before.decidedThroughId });
    expect(ledger.decidedForYou).toEqual(before.decidedForYou);
    expect(ledger.decidedCount).toBe(205);
    f.decide("new-after-render");
    const result = await f.mark({ all: true, throughId: before.decidedThroughId });
    expect(result.ids).toHaveLength(205);
    expect((await f.call<Room>("room", {})).decidedForYou.map(d => d.id)).toEqual(["new-after-render"]);
    expect((await f.unseen(result.undoToken!)).ids).toHaveLength(205);
  });

  it("scopes all to one Keeper, with null and missing watermarks distinguished", async () => {
    const f = fixture();
    expect((await f.call<Room>("room", {})).decidedThroughId).toBeNull();
    f.decide("lead"); f.decide("other", { keeperThreadId: "other" });
    expect(await f.mark({ all: true, throughId: null })).toEqual({ ok: true, ids: [], undoToken: null });
    expect((await f.mark({ all: true, keeperThreadId: "lead" })).ids).toEqual(["lead"]);
    expect((await f.call<Room>("room", {})).decidedForYou.map(d => d.id)).toEqual(["other"]);
  });

  it("does not let newer seen or undone history crowd an older unseen item off the page", async () => {
    const f = fixture(); f.decide("still-unseen");
    for (let i = 0; i < 130; i++) {
      f.decide(`seen-${i}`, { seenAt: f.time() });
      f.decide(`undone-${i}`, { undone: true });
    }
    const room = await f.call<Room>("room", {});
    expect(room.decidedForYou.map(d => d.id)).toEqual(["still-unseen"]);
    expect(room.decidedCount).toBe(1);
  });

  it("uses the partial attention index rather than scanning all decision history", async () => {
    const f = fixture(); f.decide("one");
    const prepare = vi.spyOn(f.k.store.db, "prepare");
    await f.call("room", {});
    const query = prepare.mock.calls.find(([sql]) => sql.startsWith("SELECT r.data") && sql.includes("WHERE r.kind=?") && sql.includes("$.reversible"))![0];
    prepare.mockRestore();
    const plan = f.k.store.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all("decisions") as { detail: string }[];
    expect(plan.map(step => step.detail)).toEqual(expect.arrayContaining([
      expect.stringContaining("tavern_decision_attention"),
    ]));
  });

  it("does not acknowledge non-attention decisions or accept a missing snapshot anchor", async () => {
    const f = fixture(); f.decide("user", { source: "user" });
    f.decide("consequential", { reversible: false }); f.decide("undone", { undone: true });
    const q = await f.quest("done", true); f.decide("cellared", { boardQuestId: q });
    expect(await f.mark({ ids: ["user", "consequential", "undone", "cellared"] })).toEqual({ ok: true, ids: [], undoToken: null });
    f.decide("visible");
    await expect(f.mark({ all: true, throughId: "missing" })).rejects.toThrow("refresh");
    expect(f.k.store.get("decisions", "visible")).not.toHaveProperty("seenAt");
    expect(await f.unseen("missing-token")).toEqual({ ok: true, ids: [] });
  });

  it("rolls back the whole acknowledgement and its token if a write fails", async () => {
    const f = fixture(); f.decide("blocked"); f.decide("first");
    f.k.store.db.exec(`CREATE TRIGGER reject_seen BEFORE UPDATE ON tavern_records
      WHEN NEW.kind='decisions' AND NEW.id='blocked' AND json_extract(NEW.data,'$.seenAt') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'test seen write rejected'); END`);
    await expect(f.mark({ ids: ["first", "blocked"] })).rejects.toThrow("test seen write rejected");
    expect(f.k.store.get("decisions", "first")).not.toHaveProperty("seenAt");
    expect(f.k.store.db.prepare("SELECT count(*) AS n FROM tavern_records WHERE kind='decisionSeen'").get()).toEqual({ n: 0 });
  });

  it.each([{}, { ids: [] }, { ids: Array(201).fill("one") }, { ids: ["one"], all: true }, { all: true, seen: false }])("rejects invalid mark input %j before writes", async input => {
    const f = fixture(); f.decide("one");
    await expect(f.mark(input)).rejects.toThrow();
    expect(f.k.store.get("decisions", "one")).not.toHaveProperty("seenAt");
  });

  it("pages all history newest first, scoped to the Keeper and quest, including seen and cellared records", async () => {
    const f = fixture(), q = await f.quest("done", true);
    for (let i = 0; i < 135; i++) f.decide(`history-${i}`, { boardQuestId: q, seenAt: i % 2 ? f.time() : null, undone: i % 3 === 0 });
    for (let i = 0; i < 110; i++) f.decide(`other-quest-${i}`);
    const detail = await f.call<BoardQuestDetail>("boardQuest", { id: q });
    expect(detail.decisionsTotal).toBe(135);
    expect(detail.decisions[0]!.id).toBe("history-134");
    expect(detail.decisionsNextCursor).toEqual(expect.any(String));
    f.decide("later", { boardQuestId: q });
    await f.mark({ ids: ["other-quest-109"] });
    const next = await f.call<{ decisions: Decision[]; nextCursor: string | null; total: number }>("decisionHistory", { keeperThreadId: "lead", boardQuestId: q, cursor: detail.decisionsNextCursor });
    expect(next.total).toBe(136); expect(next.nextCursor).toBeNull();
    expect([...detail.decisions, ...next.decisions].map(d => d.id)).toEqual(Array.from({ length: 135 }, (_, i) => `history-${134 - i}`));
    await expect(f.call("decisionHistory", { keeperThreadId: "other", boardQuestId: q, cursor: detail.decisionsNextCursor })).rejects.toThrow();
    await expect(f.call("decisionHistory", { keeperThreadId: "lead", cursor: "not-a-cursor" })).rejects.toThrow();
    const ledger = await f.call<Ledger>("ledger", { threadId: "lead" });
    expect(ledger.decisionsTotal).toBe(246); expect(ledger.decisionsNextCursor).toEqual(expect.any(String));
  });
});
