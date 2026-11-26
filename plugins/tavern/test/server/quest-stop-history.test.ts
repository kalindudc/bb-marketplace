// @vitest-environment node
import { seedLegacyQuest, seedQuest } from "./support";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerRpc } from "../../src/server/rpc";
import { rpcContract, type BoardQuestDetail } from "../../src/shared/contract";
import { askSchema, boardQuestSchema } from "../../src/shared/schema";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { makeThreadResponse } from "./host";

function ask(f: ReturnType<typeof setup>, boardQuestId: string | null) {
  return f.k.ask("lead", { effect: {type:"decision"},
    boardQuestId, kind: "decision", question: "Use the private draft?", why: "Your choice",
    options: [{ id: "yes", label: "Use it", detail: "", recommended: true }],
    meanwhile: "Keep reading", holds: [], reversible: true,
  });
}

const causes = ["quest-stopped", "plan-superseded", "keeper-archived", "turn-recovered", "scope-cleared"] as const;

describe("quest stop history", () => {
  it("accepts the old id-only RPC and returns an explicit null reason in detail", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "A", "A");
    registerRpc(f.bb, f.runtime);
    expect(await f.harness.invokeRpc("stopBoardQuest", { id: q.id })).toEqual({ phase: "stopped", unconfirmed: 0 });
    const detail = await f.harness.invokeRpc("boardQuest", { id: q.id }) as BoardQuestDetail;
    expect(detail.quest.stopReason).toBeNull();
    expect(detail.events.find(e => e.type === "quest.stopped")?.data).toMatchObject({ reason: null, withdrawnAskIds: [] });
  });

  it("persists a trimmed reason and exactly the open asks withdrawn by that stop", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "A", "A"), other = seedLegacyQuest(f.k,"lead", "B", "B");
    const first = ask(f, q.id), second = ask(f, q.id), answered = ask(f, q.id), unrelated = ask(f, other.id), local = ask(f, null);
    f.k.answerAsk(answered.id, "yes", "Keep the answer", "page", "user");
    f.advance(1000);
    registerRpc(f.bb, f.runtime);
    await f.harness.invokeRpc("stopBoardQuest", { id: q.id, reason: "  Superseded by the smaller plan.  " });
    const detail = await f.harness.invokeRpc("boardQuest", { id: q.id }) as BoardQuestDetail;
    expect(detail.quest).toMatchObject({ phase: "stopped", stopReason: "Superseded by the smaller plan.", endedAt: f.time() });
    const event = detail.events.find(e => e.type === "quest.stopped")!;
    expect(event.actor).toEqual({ kind: "tavern" });
    expect(event.data).toMatchObject({ reason: "Superseded by the smaller plan.", withdrawnAskIds: [first.id, second.id] });
    for (const entry of [first, second]) expect(f.k.store.get("asks", entry.id)).toMatchObject({ state: "withdrawn", withdrawnAt: event.at, withdrawnCause: "quest-stopped", answer: null });
    expect(f.k.store.get("asks", answered.id)).toMatchObject({ state: "answered", answer: { note: "Keep the answer" } });
    for (const entry of [unrelated, local]) expect(f.k.store.get("asks", entry.id)?.state).toBe("open");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it.each([null, "", " \n "])("normalizes an omitted-looking reason %j to null", async reason => {
    const f = setup(), q = await seedQuest(f.k,"lead", "A", "A");
    await f.runtime.stop(q.id, reason);
    expect(f.k.quest(q.id).stopReason).toBeNull();
  });

  it("enforces the bound at RPC and runtime boundaries before any state change", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "A", "A"), entry = ask(f, q.id);
    registerRpc(f.bb, f.runtime);
    await expect(f.harness.invokeRpc("stopBoardQuest", { id: q.id, reason: "x".repeat(501) })).rejects.toThrow();
    await expect(f.runtime.stop(q.id, "x".repeat(501))).rejects.toThrow();
    expect(f.k.quest(q.id).phase).toBe("scout");
    expect(f.k.store.get("asks", entry.id)?.state).toBe("open");
    expect(f.k.store.events("lead").filter(e => e.type === "quest.stopped")).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    await f.runtime.stop(q.id, "x".repeat(500));
    expect(f.k.quest(q.id).stopReason).toHaveLength(500);
  });

  it("preserves the first stop receipt when an id-only retry arrives later", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "A", "A"), entry = ask(f, q.id);
    await f.runtime.stop(q.id, "No longer needed.");
    const stopped = f.k.quest(q.id), withdrawn = f.k.store.get("asks", entry.id);
    f.advance(60000);
    await f.runtime.stop(q.id);
    expect(f.k.quest(q.id)).toMatchObject({ stopReason: stopped.stopReason, endedAt: stopped.endedAt });
    expect(f.k.store.get("asks", entry.id)).toEqual(withdrawn);
    const receipts = f.k.store.events("lead").filter(e => e.type === "quest.stopped");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.data.withdrawnAskIds).toEqual([entry.id]);
  });

  it("withdraws all of the quest's open asks beyond the normal read page", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "A", "A"), entry = ask(f, q.id);
    for (let i = 0; i < 503; i++) f.k.store.put("asks", `extra-${i}`, { ...entry, id: `extra-${i}` });
    await f.runtime.stop(q.id, "Stop the whole quest.");
    expect(f.k.store.openAsks("lead", q.id)).toEqual([]);
    const event = f.k.store.events("lead").find(e => e.type === "quest.stopped")!;
    expect(event.data.withdrawnAskIds).toHaveLength(504);
    expect(f.k.store.get("asks", "extra-502")).toMatchObject({ withdrawnCause: "quest-stopped", withdrawnAt: event.at });
  });

  it("retries stopping an unconfirmed party without overwriting its first receipt", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "A", "A"), entry = ask(f, q.id);
    f.k.bind("child", "smith", "juno", "project", {
      keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Build",
      brief: { outcome: "Build", mode: "make-it-work", outOfScope: "Production", doneWhen: "Checks", context: [], questions: [], timeboxMinutes: null },
    });
    let active = true;
    const stop = vi.fn(async () => ({ ok: true as const }));
    f.bb.sdk.threads.stop = stop;
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, status: active ? "active" : "idle" });
    expect(await f.runtime.stop(q.id, "Stop requested.")).toEqual({ phase: "stopping", unconfirmed: 1 });
    const stopped = f.k.quest(q.id);
    expect(stopped.endedAt).toBeNull();
    expect(f.k.member("child")?.stopError).toContain("Stop not yet confirmed");
    active = false;
    f.advance(1000);
    await f.runtime.stop(q.id);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(f.k.member("child")).toMatchObject({ engagement: "archived", disposition: "stopped" });
    expect(f.k.quest(q.id)).toMatchObject({ stopReason: "Stop requested.", endedAt: f.time() });
    expect(f.k.store.events("lead").filter(e => e.type === "quest.stopped")).toHaveLength(1);
    expect(f.k.store.get("asks", entry.id)?.withdrawnAt).toBe(stopped.stoppingSince);
  });

  it("rolls the stop metadata back if ledger closure fails", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "A", "A"), entry = ask(f, q.id);
    vi.spyOn(f.k.memory, "closeQuest").mockImplementation(() => { throw new Error("closure unavailable"); });
    await expect(f.runtime.stop(q.id, "Not committed.")).rejects.toThrow("closure unavailable");
    expect(f.k.quest(q.id).phase).toBe("scout");
    expect(f.k.store.get("asks", entry.id)?.state).toBe("open");
    expect(f.k.store.events("lead").filter(e => e.type === "quest.stopped")).toEqual([]);
  });

  it.each(causes)("stamps %s once, without replacing answered history", async cause => {
    const f = setup(), entry = ask(f, null), answered = ask(f, null);
    f.k.answerAsk(answered.id, "yes", "Original", "page", "user");
    f.advance(1000);
    expect(f.k.withdrawAsk(entry.id, cause)).toMatchObject({ id: entry.id, state: "withdrawn", withdrawnAt: f.time(), withdrawnCause: cause });
    const original = f.k.store.get("asks", entry.id);
    f.advance(1000);
    expect(f.k.withdrawAsk(entry.id, "quest-stopped")).toBeNull();
    expect(f.k.store.get("asks", entry.id)).toEqual(original);
    expect(f.k.withdrawAsk(answered.id, cause)).toBeNull();
    expect(f.k.store.get("asks", answered.id)).toMatchObject({ state: "answered", answer: { note: "Original" } });
  });

  it("stamps superseded greenlight asks rather than attributing them to a stop", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "A", "A");
    f.k.plan("lead", planInput(q.id));
    const original = f.k.store.openAsks("lead", q.id)[0]!;
    f.advance(1000);
    f.k.plan("lead", planInput(q.id));
    expect(f.k.store.get("asks", original.id)).toMatchObject({ state: "withdrawn", withdrawnAt: f.time(), withdrawnCause: "plan-superseded" });
    expect(f.k.store.openAsks("lead", q.id)).toHaveLength(1);
  });

  it("stamps archived asks without changing the actor on their existing event", async () => {
    const f = setup(), entry = ask(f, null);
    await f.runtime.threadLifecycle("thread.archived", { thread: makeThreadResponse({ id: "lead", archivedAt: f.time() }), actor: { kind: "user" } });
    expect(f.k.store.get("asks", entry.id)).toMatchObject({ withdrawnCause: "keeper-archived", withdrawnAt: f.time() });
    expect(f.k.store.events("lead").find(e => e.type === "ask.withdrawn")?.actor).toEqual({ kind: "user" });
  });

  it("attributes a recovered turn blocker to recovery, not to stopping the quest", async () => {
    const f = setup(), entry = ask(f, null);
    f.k.store.patch("lead", { failureAskId: entry.id, failureCount: 2 });
    f.bb.sdk.threads.events.list = async () => [{ seq: 1, type: "turn/completed", scope: { kind: "turn", turnId: "recovered" }, data: { status: "completed" }, createdAt: f.time() }] as never;
    await f.runtime.observe(makeThreadResponse({ id: "lead" }), 1);
    expect(f.k.store.get("asks", entry.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "turn-recovered", withdrawnAt: f.time() });
    expect(f.k.store.runtime("lead").failureAskId).toBeNull();
  });

  it("stamps the pending ask when its scope is cleared", async () => {
    const root = mkdtempSync(join(tmpdir(), "tavern-stop-scope-"));
    try {
      const f = setup(), entry = ask(f, null);
      f.runtime.enableScopes({ dataDir: root, installGuard: false, policyOptions: { home: root }, guard: { agentDir: join(root, "agent") } });
      f.k.store.put("scopeRequests", entry.id, {
        keeperThreadId: "lead", boardQuestId: null, memberThreadId: "child", classId: "smith", context: {}, override: {}, widenings: [], reason: "Private widening", initialBrief: null, state: "pending",
      });
      f.k.store.patch("child", { scopePending: entry.id });
      f.runtime.scopes!.clearScope("child");
      expect(f.k.store.get("asks", entry.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "scope-cleared", withdrawnAt: f.time() });
      expect(f.k.store.runtime("child").scopePending).toBeNull();
      const original = f.k.store.get("asks", entry.id);
      f.advance(1000);
      f.runtime.scopes!.clearScope("child");
      expect(f.k.store.get("asks", entry.id)).toEqual(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains new history fields through the record schemas and tolerates old records", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "A", "A"), entry = ask(f, q.id);
    expect(boardQuestSchema.parse(q).stopReason ?? null).toBeNull();
    expect(askSchema.parse(entry).withdrawnCause ?? null).toBeNull();
    expect(boardQuestSchema.parse({ ...q, stopReason: "Changed priority" }).stopReason).toBe("Changed priority");
    expect(askSchema.parse({ ...entry, state: "withdrawn", withdrawnAt: f.time(), withdrawnCause: "scope-cleared" })).toMatchObject({ withdrawnAt: f.time(), withdrawnCause: "scope-cleared" });
    expect(askSchema.safeParse({ ...entry, withdrawnCause: "something-else" }).success).toBe(false);
    expect(rpcContract.stopBoardQuest.input.safeParse({ id: q.id }).success).toBe(true);
  });
});
