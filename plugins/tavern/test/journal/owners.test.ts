// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHost } from "./host";
import { createJournalStore } from "../../src/server/journal/store";
import { watchOwners, firstLine } from "../../src/server/journal/owners";
import { MIGRATIONS } from "../../src/server/migrations";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map((f) => f())); });
function fixture(names: Record<string, string> = { thr_gaetano: "Gaetano" }) {
  const host = makeHost(); cleanup.push(host.dispose);
  host.bb.storage.migrate(host.db, MIGRATIONS);
  const invalidations: string[][] = [];
  const store = createJournalStore(host.bb, host.db, { roleOf: () => null, invalidate: (t) => invalidations.push(t), nameOf: (id) => names[id] ?? null });
  watchOwners(host.bb, store);
  return { ...host, store, invalidations };
}
const said = (seq: number, text: string) => ({ seq, createdAt: 5_000, type: "item/completed", data: { item: { id: `m${seq}`, type: "agentMessage", text } } });
async function coordinator(f: ReturnType<typeof fixture>) {
  await f.store.ready("thr_coord");
  await f.store.runTool("thr_coord", { action: "add", descriptions: ["Class editor fixes, Gaetano"], owner: "thr_gaetano" });
  await f.store.runTool("thr_coord", { action: "add", descriptions: ["My own review"] });
  await f.store.runTool("thr_coord", { action: "start", id: "00" });
}

describe("delegated entries follow their owner threads", () => {
  it("marks an owned entry when its owner goes idle, quoting the first line of its last message", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10 * 60_000);
    const f = fixture(); await coordinator(f);
    f.setEvents([said(1, "old reply"), said(2, "\n**Result:** done — all four fixes are in.\nMore detail")]);
    await f.emit("thread.idle", { thread: { id: "thr_gaetano" } });
    const entry = f.store.get("thr_coord").entries.find((e) => e.id === "00")!;
    expect(entry).toMatchObject({ status: "doing", report: { kind: "idle", threadId: "thr_gaetano", summary: "Result: done — all four fixes are in.", at: 10 * 60_000, by: { kind: "tavern" } } });
    expect(f.invalidations.flat()).toContain("tavern:journal:thr_coord");
    expect(f.store.awaiting("thr_coord")).toMatch(/\[00\] Class editor fixes, Gaetano: Gaetano went idle just now: "Result: done — all four fixes are in\."/);
  });

  it("leaves closed, linked and own entries alone, and keeps a settled mark when the owner idles again", async () => {
    const f = fixture(); await coordinator(f);
    await f.store.runTool("thr_coord", { action: "settle", id: "00", reason: "SOURCE SETTLED" });
    f.setEvents([said(1, "ack")]);
    await f.emit("thread.idle", { thread: { id: "thr_gaetano" } });
    expect(f.store.get("thr_coord").entries.find((e) => e.id === "00")!.report).toMatchObject({ kind: "settled", summary: "SOURCE SETTLED" });
    await f.emit("thread.idle", { thread: { id: "thr_coord" } });
    expect(f.store.get("thr_coord").entries.find((e) => e.id === "01")!.report ?? null).toBeNull();
  });

  it("calls out an owner whose thread was archived or deleted", async () => {
    const f = fixture(); await coordinator(f);
    await f.emit("thread.archived", { thread: { id: "thr_gaetano" } });
    expect(f.store.awaiting("thr_coord")).toMatch(/Gaetano's thread was archived just now\. Reassign it, close it or delete it\./);
    await f.emit("thread.deleted", { thread: { id: "thr_gaetano" } });
    expect(f.store.awaiting("thr_coord")).toMatch(/Gaetano's thread was deleted/);
  });

  it("names an owner by its Tavern character, else by its bb thread title, else as a thread", async () => {
    const f = fixture({});
    f.threads.set("thr_steve", { id: "thr_steve", status: "idle", title: "Steve · You are the title bar designer", originKind: null });
    expect(f.store.ownerLabel("thr_gaetano")).toBe("thread thr_gaetano");
    await f.store.learnOwner("thr_steve");
    expect(f.store.ownerLabel("thr_steve")).toBe("Steve");
    expect(f.store.ownerLabel("Zack")).toBe("Zack");
    const named = fixture();
    expect(named.store.ownerLabel("thr_gaetano")).toBe("Gaetano");
  });

  it("reads the first line of a message as plain text", () => {
    expect(firstLine("\n\n## **Result:** `done` and _green_\nrest")).toBe("Result: done and green");
    expect(firstLine("x".repeat(400))).toHaveLength(160);
    expect(firstLine("   ")).toBeNull();
  });
});
