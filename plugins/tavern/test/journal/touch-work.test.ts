// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS as JOURNAL_MIGRATIONS } from "../../src/server/migrations";
import { createJournalStore, QUIET_AFTER_MS, staleLines } from "../../src/server/journal/store";
import type { JournalEntry } from "../../src/shared/schema";
import { makeHost } from "./host";

// Beena's finding: every tool event of a working thread refetched the room on every open Tavern page while nothing visible changed.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map(f => f())); });
async function working() {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const host = makeHost(); cleanup.push(host.dispose); host.bb.storage.migrate(host.db, JOURNAL_MIGRATIONS);
  const invalidate = vi.fn();
  const store = createJournalStore(host.bb, host.db, { roleOf: () => null, invalidate });
  await store.ready("t");
  await store.runTool("t", { action: "add", descriptions: ["work"] });
  await store.runTool("t", { action: "start", id: "00" });
  invalidate.mockClear();
  return { store, invalidate };
}

describe("tool activity in the journal", () => {
  it("invalidates nothing while the thread is active, however many tools run", async () => {
    const { store, invalidate } = await working();
    for (let i = 1; i <= 20; i++) { vi.setSystemTime(1_000_000 + i * 1000); store.touchWork("t", 1_000_000 + i * 1000); }
    expect(invalidate).not.toHaveBeenCalled();
    expect(store.progress("t").quietSince).toBeNull();
  });
  it("invalidates once when a tool wakes a quiet thread", async () => {
    const { store, invalidate } = await working();
    const later = 1_000_000 + QUIET_AFTER_MS + 60_000;
    vi.setSystemTime(later);
    expect(store.progress("t").quietSince).toBe(1_000_000);
    invalidate.mockClear();
    store.touchWork("t", later);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(store.progress("t").quietSince).toBeNull();
    store.touchWork("t", later + 1000);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
  it("invalidates once, from a server timer, when an active thread goes quiet", async () => {
    const { store, invalidate } = await working();
    store.touchWork("t", 1_010_000);
    await vi.advanceTimersByTimeAsync(QUIET_AFTER_MS + 10_000 - 1);
    expect(invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(store.progress("t").quietSince).toBe(1_010_000);
    await vi.advanceTimersByTimeAsync(QUIET_AFTER_MS * 3);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
  it("arms no timer for a thread with nothing in progress, and still records the activity", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const host = makeHost(); cleanup.push(host.dispose); host.bb.storage.migrate(host.db, JOURNAL_MIGRATIONS);
    const invalidate = vi.fn();
    const store = createJournalStore(host.bb, host.db, { roleOf: () => null, invalidate });
    await store.ready("t"); await store.runTool("t", { action: "add", descriptions: ["later"] }); invalidate.mockClear();
    store.touchWork("t", 1_005_000);
    expect(host.db.prepare("SELECT last_tool_at FROM questlog_logs WHERE thread_id = 't'").get()).toEqual({ last_tool_at: 1_005_000 });
    await vi.advanceTimersByTimeAsync(QUIET_AFTER_MS * 2);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("the reminder's finished-looking check", () => {
  const agent = { kind: "agent" as const, threadId: "t" };
  const entry = (id: string, status: JournalEntry["status"], description: string, note: string | null = null) => ({ threadId: "t", id, parentId: null, description, status, owner: null, after: [], links: [], doneAt: null, doneBy: null, note, evidence: [], review: null, link: null, boardQuestId: null, report: null, order: Number.parseInt(id, 16), createdAt: 1, createdBy: agent, updatedAt: 1, updatedBy: agent }) as JournalEntry;
  it("names an open entry whose description reads finished, but never a blocked one, whose reason explains it", () => {
    const lines = staleLines([
      entry("18", "blocked", "Reliability first: live run 4 approved, waiting on the build", "23:10 blocked until the reload"),
      entry("19", "todo", "Map page pass: approved by Pedro"),
      entry("1a", "todo", "Tidy the README", "approved in the note, which is not read"),
    ], {});
    expect(lines).toEqual(['[19] reads as finished ("approved") and is still open.']);
  });
});
