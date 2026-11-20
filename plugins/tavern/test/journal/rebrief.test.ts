// @vitest-environment node
import { seedQuest } from "../server/support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHost } from "./host";
import { MIGRATIONS } from "../../src/server/migrations";
import { createJournalStore } from "../../src/server/journal/store";
import type { JournalEntry } from "../../src/shared/schema";
import { registerJournal } from "../../src/server/journal";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";

// Live run 4: a same-Smith re-brief left its linked entry done with the first brief's evidence, so the second report passed.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map(f => f())); });
const tavern = { kind: "tavern" as const };
const smith = { kind: "agent" as const, threadId: "m" };
const nineTests = [{ kind: "command" as const, ref: "npm test", detail: "9 tests pass (4 existing + 5 new), fail 0", exitCode: 0 }, { kind: "command" as const, ref: "git status --short", detail: "only the two new untracked files shown", exitCode: null }];
async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 15, 4, 10));
  const h = makeHost(); cleanup.push(h.dispose); h.bb.storage.migrate(h.db, MIGRATIONS);
  const superseded = vi.fn();
  const store = createJournalStore(h.bb, h.db, { roleOf: id => id === "m" ? { classId: "smith", role: "member", waypointId: "w1", boardQuestId: "q" } : null, invalidate: () => {}, superseded, nameOf: id => id === "thr_vex" ? "Vex" : null });
  await store.prepare("m");
  store.linkWaypoint("m", { boardQuestId: "q", waypointId: "w1" }, "Implement labelCount with tests", "m", tavern);
  store.linkWaypoint("m", { boardQuestId: "other", waypointId: "w9" }, "Another quest's waypoint", "m", tavern);
  await store.runTool("m", { action: "add", descriptions: ["Own scratch note"] });
  const done = await store.runTool("m", { action: "done", id: "00", evidence: nineTests } as never);
  expect(done.isError).toBe(false);
  const entry = (id: string) => store.get("m").entries.find(e => e.id === id)!;
  const put = (e: JournalEntry) => h.db.prepare("UPDATE questlog_entries SET data = ? WHERE thread_id = ? AND id = ?").run(JSON.stringify(e), e.threadId, e.id);
  return { ...h, store, superseded, entry, put };
}

describe("a follow-up brief reopens the member's linked work", () => {
  it("turns a done linked entry back to doing and moves its evidence into the note, labelled with the brief it was for", async () => {
    const f = await fixture();
    const doneAt = f.entry("00").doneAt;
    expect(doneAt).not.toBeNull();
    f.store.rebriefed("m", "q", 2);
    const e = f.entry("00");
    expect(e).toMatchObject({ status: "doing", doneAt: null, doneBy: null, evidence: [] });
    expect(e.note).toBe("04:10 Brief v2 arrived; v1 evidence kept for reference: npm test (9 tests pass (4 existing + 5 new), fail 0), git status --short (only the two new untracked files shown).");
    const change = f.store.get("m").changes.at(-1)!;
    expect(change).toMatchObject({ actor: tavern, action: "rebrief", entryIds: ["00"] });
    expect(change.text).toBe('reopened [00] "Implement labelCount with tests": brief v2 arrived after it was done. Its v1 evidence is in the note; attach fresh evidence before marking it done.');
  });
  it("leaves unfinished work, unlinked work and another quest's waypoint alone", async () => {
    const f = await fixture();
    await f.store.runTool("m", { action: "done", id: "01", evidence: nineTests } as never);
    const before = { other: f.entry("01"), own: f.entry("02") };
    f.store.rebriefed("m", "q", 2);
    expect(f.entry("01")).toEqual(before.other);
    expect(f.entry("02")).toEqual(before.own);
    const g = await fixture();
    await g.store.runTool("m", { action: "reopen", id: "00" });
    const open = g.entry("00");
    g.store.rebriefed("m", "q", 2);
    expect(g.entry("00")).toEqual(open);
  });
  it("keeps a rejected entry rejected with its reason, and moves only the member's evidence", async () => {
    const f = await fixture();
    // The member had answered the rejection under v1; that answer no longer counts after v2.
    const review = { actor: { kind: "agent" as const, threadId: "thr_vex" }, at: Date.now() - 60_000, evidence: [{ kind: "file" as const, ref: "src/a.js:2", detail: "wrong value", exitCode: null }], reason: "Outputs are wrong.", previousNote: null, memberEvidenceAt: Date.now() - 30_000 };
    f.put({ ...f.entry("00"), status: "rejected", doneAt: null, doneBy: null, review });
    f.store.rebriefed("m", "q", 2);
    const e = f.entry("00");
    expect(e).toMatchObject({ status: "rejected", review: { ...review, memberEvidenceAt: null }, evidence: [] });
    expect(e.note).toMatch(/v1 evidence kept for reference: npm test/);
    expect(f.superseded).not.toHaveBeenCalled();
  });
  it("reopens a verified entry: the verdict moves to the note, and the service record hears it is superseded, once", async () => {
    const f = await fixture();
    const review = { actor: { kind: "agent" as const, threadId: "thr_vex" }, at: Date.now() - 60_000, evidence: [], reason: null, previousNote: null, memberEvidenceAt: null };
    const verified = { ...f.entry("00"), status: "verified" as const, review };
    f.put(verified);
    f.store.rebriefed("m", "q", 2);
    const e = f.entry("00");
    expect(e).toMatchObject({ status: "doing", review: null, evidence: [], doneAt: null });
    expect(e.note).toMatch(/Verified for brief v1 by Vex \(Warden\)\./);
    expect(f.superseded).toHaveBeenCalledTimes(1);
    expect(f.superseded).toHaveBeenCalledWith({ entry: verified, version: 2, at: Date.now() });
  });
  it("refuses a done that re-attaches only the earlier brief's evidence, and accepts fresh evidence beside it", async () => {
    const f = await fixture();
    f.store.rebriefed("m", "q", 2);
    expect(f.entry("00").rebrief).toEqual({ version: 2, evidence: nineTests });
    const stale = await f.store.runTool("m", { action: "done", id: "00", evidence: [nineTests[0]!] } as never);
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/Attach evidence from work checked against brief v2; these items are from v1\./);
    expect(f.entry("00").status).toBe("doing");
    const fresh = await f.store.runTool("m", { action: "done", id: "00", evidence: [nineTests[0]!, { kind: "command", ref: "npm test", detail: "10 tests pass, fail 0", exitCode: 0 }] } as never);
    expect(fresh.isError).toBe(false);
    expect(f.entry("00").status).toBe("done");
  });
  it("can't be undone by the member or the user, so the stale done never comes back", async () => {
    const f = await fixture();
    f.store.rebriefed("m", "q", 2);
    const undo = await f.store.runTool("m", { action: "undo" });
    expect(undo.isError).toBe(true);
    expect(undo.text).toMatch(/Brief v2 reopened this entry; mark it done with fresh evidence instead/);
    expect(() => f.store.edit("m", { op: "undo" }, { kind: "user" })).toThrow(/Brief v2 reopened this entry/);
    expect(f.entry("00").status).toBe("doing");
  });
  it("is Tavern's alone: the journal tool has no rebrief action", async () => {
    const f = await fixture();
    const out = await f.store.runTool("m", { action: "rebrief" } as never);
    expect(out.isError).toBe(true);
    expect(f.entry("00").status).toBe("done");
  });
  it("does nothing for a thread with no journal, and never throws", async () => {
    const f = await fixture();
    expect(() => f.store.rebriefed("nobody", "q", 2)).not.toThrow();
  });
});

it("replays live run 4: done with 9 tests, brief v2, a note only, and the second done report is refused until fresh evidence", async () => {
  const h = makeHost(); cleanup.push(h.dispose); h.bb.storage.migrate(h.db, MIGRATIONS);
  const data = new KeeperStore(h.db);
  const journal = registerJournal(h.bb, h.db, { roleOf: id => data.get("members", id), invalidate: () => {} });
  const keeper = new Keeper(data, journal);
  const tool = h.tools.get("journal");
  const run = async (input: unknown) => String(await tool.execute(input, { threadId: "m" }));
  keeper.bind("lead", "keeper", "wren", "project");
  const q = await seedQuest(keeper,"lead", "Build labelCount", "Build");
  keeper.bind("m", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Work", errand: false, brief: { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Deploy", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null } });
  await journal.prepare("m");
  journal.linkWaypoint("m", { boardQuestId: q.id, waypointId: "w1" }, "Implement labelCount with tests", "m", tavern);
  const report = { status: "done" as const, outcome: "labelCount built", evidence: [], artifacts: [], confidence: null, voice: null };
  expect(await run({ action: "done", id: "00", evidence: nineTests })).not.toMatch(/^Error/);
  expect(() => keeper.report("m", report)).not.toThrow();
  journal.rebriefed("m", q.id, 2);
  expect(await run({ action: "note", id: "00", note: "pass 10, fail 0" })).not.toMatch(/^Error/);
  expect(() => keeper.report("m", report)).toThrow(/done with evidence first/);
  expect(await run({ action: "done", id: "00", evidence: [{ kind: "command", ref: "npm test", detail: "10 tests pass, fail 0", exitCode: 0 }] })).not.toMatch(/^Error/);
  expect(() => keeper.report("m", report)).not.toThrow();
  expect(journal.get("m").entries[0]!.note).toMatch(/v1 evidence kept for reference: npm test \(9 tests pass/);
});
