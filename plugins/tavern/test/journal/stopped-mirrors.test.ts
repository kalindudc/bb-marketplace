// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { createJournalStore } from "../../src/server/journal/store";
import type { BoardQuest } from "../../src/shared/schema";
import { makeHost } from "./host";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map((f) => f())); });
type Quest = Pick<BoardQuest, "id" | "title" | "phase" | "updatedAt" | "endedAt">;
async function fixture(threadId: string, keeper: boolean) {
  const h = makeHost(); cleanup.push(h.dispose); h.bb.storage.migrate(h.db, MIGRATIONS);
  const quests: Quest[] = [{ id: "vault", title: "Vault", phase: "scout", updatedAt: 100, endedAt: null }, { id: "audit", title: "Audit", phase: "scout", updatedAt: 100, endedAt: null }];
  const store = createJournalStore(h.bb, h.db, {
    roleOf: (id) => keeper && id === threadId ? { classId: "keeper", role: "keeper", boardQuestId: null, waypointId: null } : null,
    boardQuestsOf: (id) => id === threadId ? quests : [], invalidate: vi.fn(),
  });
  await store.prepare(threadId);
  for (const q of quests) store.edit(threadId, { op: "add", descriptions: [`Board quest: ${q.title} (${q.id})`], parentId: null }, { kind: "agent", threadId });
  await store.runTool(threadId, { action: "add", descriptions: ["Ordinary chore"] });
  const phase = (id: string, p: Quest["phase"]) => { const q = quests.find((x) => x.id === id)!; q.phase = p; q.updatedAt = 200; q.endedAt = p === "stopped" || p === "done" ? 200 : null; };
  return { ...h, store, phase };
}

describe("a stopped quest's mirror", () => {
  it("is cleared by a default clear without ever counting as done, while a stopping mirror stays", async () => {
    const f = await fixture("k", true);
    f.phase("vault", "stopped"); f.phase("audit", "stopping");
    const before = f.store.get("k");
    expect(before.entries.find((e) => e.boardQuestId === "vault")).toMatchObject({ status: "blocked", doneAt: null, doneBy: null });
    expect(before.progress.done).toBe(0);
    const out = await f.store.runTool("k", { action: "clear" });
    expect(out.isError).toBe(false);
    const after = f.store.get("k").entries;
    expect(after.map((e) => e.boardQuestId ?? e.description)).toEqual(["audit", "Ordinary chore"]);
    expect(f.store.get("k").progress.done).toBe(0);
    // The stopping mirror is still in flight, so even clear all keeps it.
    await f.store.runTool("k", { action: "clear", all: true });
    expect(f.store.get("k").entries.map((e) => e.boardQuestId)).toEqual(["audit"]);
  });

  it("comes back blocked, not done, when the clear is undone", async () => {
    const f = await fixture("k", true);
    f.phase("vault", "stopped");
    await f.store.runTool("k", { action: "clear" });
    await f.store.runTool("k", { action: "undo" });
    expect(f.store.get("k").entries.find((e) => e.boardQuestId === "vault")).toMatchObject({ status: "blocked", doneAt: null });
    await f.store.runTool("k", { action: "redo" });
    expect(f.store.get("k").entries.some((e) => e.boardQuestId === "vault")).toBe(false);
  });

  it("never makes a journal stale, named or awaiting a check", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000_000);
    const f = await fixture("s", false);
    f.phase("vault", "stopped"); f.phase("audit", "done");
    await f.store.runTool("s", { action: "done", id: f.store.get("s").entries.find((e) => !e.boardQuestId)!.id });
    f.db.prepare("UPDATE questlog_changes SET at = 100").run();
    f.db.prepare("UPDATE questlog_logs SET agent_changed_at = 100, noted_at = NULL").run();
    const skipped: string[] = [], send = vi.fn(async () => {});
    expect(await f.store.deliverNote("s", 200, send, (r) => skipped.push(r))).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(skipped[0]).toMatch(/no reminder is due/);
    expect(f.store.awaiting("s")).toBe("");
  });
});
