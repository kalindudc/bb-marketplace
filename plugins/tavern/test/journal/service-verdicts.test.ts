// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHost } from "./host";
import { MIGRATIONS } from "../../src/server/migrations";
import { createJournalStore } from "../../src/server/journal/store";
import type { JournalReview } from "../../src/server/ports";

const dispose: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(dispose.splice(0).map(f => f())); });
async function fixture() {
  const f = makeHost(); dispose.push(f.dispose); f.bb.storage.migrate(f.db, MIGRATIONS);
  const reviewed = vi.fn<(input: JournalReview) => void>();
  const store = createJournalStore(f.bb, f.db, { reviewed, invalidate: vi.fn(), nameOf: id => id === "checker" ? "Fern" : id === "thr_keeper" ? "Wren II" : null, roleOf: t => t === "checker" ? { classId: "warden", role: "member", boardQuestId: "q", waypointId: "w1" } : t === "thr_keeper" ? { classId: "keeper", role: "keeper", boardQuestId: null, waypointId: null } : null });
  await store.ready("maker");
  const id = store.linkWaypoint("maker", { boardQuestId: "q", waypointId: "w1" }, "Prove this", "maker", { kind: "tavern" });
  const proof = [{ kind: "command" as const, ref: "node check", detail: "Pass", exitCode: 0 }];
  await store.runTool("maker", { action: "done", id, evidence: proof });
  return { ...f, store, reviewed, id, proof };
}
it.each(["tool", "steer"] as const)("names a Warden and Keeper in the member's next journal %s", async delivery => {
  const f = await fixture();
  expect((await f.store.runTool("checker", { action: "verify", threadId: "maker", id: f.id, evidence: f.proof })).isError).toBe(false);
  f.store.edit("maker", { op: "update", entryId: f.id, description: "Prove the follow-up" }, { kind: "agent", threadId: "thr_keeper" });
  let text = "";
  if (delivery === "tool") text = (await f.store.runTool("maker", { action: "list" })).text;
  else expect(await f.store.deliverNote("maker", null, async note => { text = note; })).toBe(true);
  expect(text).toContain(`- Fern verified [${f.id}]`);
  expect(text).toContain(`- Wren II updated [${f.id}]`);
  expect(text).toContain("Your journal changed since your last call:");
  expect(f.store.pending("maker")).toEqual([]);
});

it("names an unknown agent by ID and starts the caller's own receipt with You", async () => {
  const f = await fixture();
  f.store.edit("maker", { op: "note", entryId: f.id, note: "A note" }, { kind: "agent", threadId: "thr_unknown" });
  expect((await f.store.runTool("maker", { action: "list" })).text).toContain(`- Agent thr_unknown noted [${f.id}]`);
  expect((await f.store.runTool("maker", { action: "note", id: f.id, note: "My own note" })).text).toMatch(/^You noted /);
});

describe("private journal verdict receipts", () => {
  it("emits exactly one private before/after receipt for each successful verify or reject, never ordinary edits", async () => {
    const f = await fixture(); expect(f.reviewed).not.toHaveBeenCalled();
    await f.store.runTool("checker", { action: "reject", threadId: "maker", id: f.id, reason: "Missing regression" });
    expect(f.reviewed).toHaveBeenCalledTimes(1);
    expect(f.reviewed.mock.calls[0]![0]).toMatchObject({ before: { status: "done" }, after: { status: "rejected" }, sequence: expect.any(Number) });
    await f.store.runTool("maker", { action: "done", id: f.id, evidence: [{ ...f.proof[0]!, detail: "New case passes" }] });
    await f.store.runTool("checker", { action: "verify", threadId: "maker", id: f.id, evidence: f.proof });
    expect(f.reviewed).toHaveBeenCalledTimes(2);
    const receipt = f.reviewed.mock.calls[1]![0];
    expect(receipt.before.review).toMatchObject({ reason: "Missing regression", memberEvidenceAt: expect.any(Number) });
    expect(receipt.after.review).toMatchObject({ reason: null, actor: { kind: "agent", threadId: "checker" } });
    expect(receipt.sequence).toBeGreaterThan(f.reviewed.mock.calls[0]![0].sequence);
  });
  it("withdraws and restores the original review proof through grouped undo and redo", async () => {
    const f = await fixture();
    await f.store.runTool("checker", { action: "verify", threadId: "maker", id: f.id, evidence: f.proof });
    const original = f.reviewed.mock.calls[0]![0];
    f.store.edit("maker", { op: "undo" }, { kind: "agent", threadId: "checker" });
    expect(f.reviewed.mock.calls.at(-1)![0]).toMatchObject({ before: original.before, after: original.after, undone: true });
    f.store.edit("maker", { op: "redo" }, { kind: "agent", threadId: "checker" });
    expect(f.reviewed.mock.calls.at(-1)![0]).toMatchObject({ before: original.before, after: original.after, undone: false });
  });
  it("allows the assigned Warden to undo a mistaken rejection without fabricated maker evidence", async () => {
    const f = await fixture();
    await f.store.runTool("checker", { action: "reject", threadId: "maker", id: f.id, reason: "Mistaken rejection" });
    f.store.edit("maker", { op: "undo" }, { kind: "agent", threadId: "checker" });
    expect(f.store.get("maker").entries[0]!.status).toBe("done");
    expect(f.reviewed.mock.calls.at(-1)![0]).toMatchObject({ undone: true, after: { status: "rejected" } });
    expect(() => f.store.edit("maker", { op: "redo" }, { kind: "agent", threadId: "maker" })).toThrow(/Warden/);
    f.store.edit("maker", { op: "redo" }, { kind: "agent", threadId: "checker" });
    expect(f.store.get("maker").entries[0]!.status).toBe("rejected");
  });
  it("rolls back the journal and its undo state when receipt withdrawal is refused", async () => {
    const f = await fixture();
    await f.store.runTool("checker", { action: "verify", threadId: "maker", id: f.id, evidence: f.proof });
    const before = f.store.get("maker").entries;
    f.reviewed.mockImplementation(() => { throw new Error("This quest has ended and its record is written, so this verdict can't be undone."); });
    expect(() => f.store.edit("maker", { op: "undo" }, { kind: "agent", threadId: "checker" })).toThrow(/record is written/);
    expect(f.store.get("maker").entries).toEqual(before);
    expect(f.store.get("maker").canRedo).toBe(false);
  });
  it("does not create receipts for an unauthorized or invalid review", async () => {
    const f = await fixture();
    expect((await f.store.runTool("intruder", { action: "verify", threadId: "maker", id: f.id, evidence: f.proof })).isError).toBe(true);
    expect((await f.store.runTool("checker", { action: "verify", threadId: "maker", id: f.id })).isError).toBe(true);
    expect(f.reviewed).not.toHaveBeenCalled();
  });
  it("commits the review and its private receipt atomically", async () => {
    const f = await fixture(); const before = f.store.get("maker").entries;
    f.reviewed.mockImplementation(() => { throw new Error("Receipt write failed"); });
    expect((await f.store.runTool("checker", { action: "verify", threadId: "maker", id: f.id, evidence: f.proof })).isError).toBe(true);
    expect(f.store.get("maker").entries).toEqual(before);
    expect(f.store.get("maker").changes.some(c => c.action === "verify")).toBe(false);
  });
});
