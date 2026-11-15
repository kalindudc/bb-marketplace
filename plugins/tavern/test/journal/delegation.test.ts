// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyAction, awaitingSummary, noteLine, openSummary, type JournalAction } from "../../src/server/journal/engine";
import type { Actor, JournalEntry } from "../../src/shared/schema";

const coordinator: Actor = { kind: "agent", threadId: "thr_coord" };
const MIN = 60_000;
function fixture() {
  let entries: JournalEntry[] = [];
  let counter = 0;
  let now = 1_000 * MIN;
  const run = (action: JournalAction, actor = coordinator) => {
    const result = applyAction(entries, action, { threadId: "thr_coord", actor, now, allocate: () => (counter++).toString(16).padStart(2, "0"), roleOf: () => null });
    entries = result.entries;
    return result;
  };
  return { run, entries: () => entries, get: (id: string) => entries.find((e) => e.id === id)!, tick: (minutes: number) => { now += minutes * MIN; }, now: () => now };
}
const names = (owner: string) => ({ thr_gaetano: "Gaetano", thr_steve: "Steve" })[owner] ?? owner;

describe("delegated entries", () => {
  it("settles an owned entry with a mark, keeps it doing, and done, reopen, start or block clears the mark", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["Class editor fixes, Gaetano"], owner: "thr_gaetano" });
    f.run({ action: "start", id: "00" });
    f.run({ action: "settle", id: "00", reason: "SOURCE SETTLED: 222 tests green" });
    expect(f.get("00")).toMatchObject({ status: "doing", report: { kind: "settled", threadId: "thr_gaetano", summary: "SOURCE SETTLED: 222 tests green", at: f.now() } });
    for (const action of ["done", "reopen", "start", "block"] as const) {
      f.run({ action: "settle", id: "00" });
      f.run({ action, id: "00", ...(action === "block" ? { reason: "held for the gate" } : {}) });
      expect(f.get("00").report ?? null).toBeNull();
      if (action === "done") f.run({ action: "reopen", id: "00" });
    }
    f.run({ action: "done", id: "00" });
    expect(() => f.run({ action: "settle", id: "00" })).toThrow(/already closed/);
  });

  it("takes owner on add, add_step and start, so handing work over is one call that demotes nothing", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["My review", "Round 3"] });
    f.run({ action: "start", id: "00" });
    f.run({ action: "add_step", id: "01", descriptions: ["Journal, Gaetano"], owner: "thr_gaetano" });
    expect(f.get("02").owner).toBe("thr_gaetano");
    f.run({ action: "start", id: "01", owner: "thr_steve" });
    expect(f.entries().map((e) => [e.id, e.status, e.owner])).toEqual([["00", "doing", null], ["01", "doing", "thr_steve"], ["02", "todo", "thr_gaetano"]]);
    f.run({ action: "start", id: "02" });
    expect(f.get("00").status).toBe("doing");
    expect(() => f.run({ action: "done", id: "00", owner: "thr_steve" })).toThrow(/owner only goes with add, split, add_step, start or update/);
  });
  it("clears a mark with wait, without closing or rewriting anything", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["Title bar, Steve"], owner: "thr_steve" });
    f.run({ action: "start", id: "00" }); f.run({ action: "settle", id: "00" });
    const before = f.get("00");
    const result = f.run({ action: "wait", id: "00" });
    expect(result.changed).toBe(true);
    expect(f.get("00")).toMatchObject({ status: "doing", description: before.description, note: before.note });
    expect(f.get("00").report ?? null).toBeNull();
    expect(f.run({ action: "wait", id: "00" }).changed).toBe(false);
  });

  it("counts rewrites since the last status change, and hints after the third", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["Build"] });
    f.run({ action: "update", id: "00", description: "Build, live since 17:05" });
    f.run({ action: "update", id: "00", description: "Build, settled" });
    expect(f.get("00").rewrites).toBe(2);
    expect(f.run({ action: "update", id: "00", description: "Build, settled" }).text).not.toMatch(/Hint/);
    const third = f.run({ action: "update", id: "00", description: "Build, waiting for the gate" });
    expect(third.text).toMatch(/Hint: \[00\] has been reworded 3 times without a status change\. Put progress in a note, close it, or split it\./);
    f.run({ action: "start", id: "00" });
    expect(f.get("00").rewrites).toBe(0);
  });

  it("appends notes with the time, keeps the newest within 2,000 characters, and clears with null", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["Build"] });
    f.run({ action: "note", id: "00", note: "Gaetano started" });
    f.tick(5);
    f.run({ action: "note", id: "00", note: "Gaetano settled; gate next" });
    expect(f.get("00").note).toBe(`${noteLine(1_000 * MIN, "Gaetano started")}\n${noteLine(1_005 * MIN, "Gaetano settled; gate next")}`);
    for (let i = 0; i < 40; i++) f.run({ action: "note", id: "00", note: `step ${i} `.repeat(8) });
    const note = f.get("00").note!;
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(note).toMatch(/step 39/);
    expect(note).not.toMatch(/Gaetano started/);
    f.run({ action: "note", id: "00", note: "Replaced whole", mode: "replace" });
    expect(f.get("00").note).toBe("Replaced whole");
    f.run({ action: "note", id: "00", note: null });
    expect(f.get("00").note).toBeNull();
  });

  it("lists what awaits the agent's check, oldest first, with the owner's name and age", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["Class editor fixes", "Title bar", "My own review"], owner: "thr_gaetano" });
    f.run({ action: "update", id: "01", owner: "thr_steve" });
    f.run({ action: "update", id: "02", owner: null });
    f.run({ action: "start", id: "00" }); f.run({ action: "start", id: "01" });
    f.run({ action: "settle", id: "01", reason: "SOURCE SETTLED" });
    f.tick(40);
    const entries = f.entries().map((e) => e.id === "00" ? { ...e, report: { kind: "idle" as const, at: f.now() - 3 * MIN, threadId: "thr_gaetano", summary: "Built and tested the fix.", by: { kind: "tavern" as const } } } : e);
    expect(awaitingSummary(entries, { name: names, now: f.now() })).toBe([
      "Awaiting your check:",
      "[01] Title bar: Steve reported settled 40 min ago: \"SOURCE SETTLED\". Close it with evidence, or reopen it.",
      "[00] Class editor fixes: Gaetano went idle 3 min ago: \"Built and tested the fix.\". Check its output, then close it, reopen it, or wait on it.",
    ].join("\n"));
    expect(openSummary(entries, 5, { name: names, now: f.now() })).toContain("[00] Class editor fixes (doing; Gaetano)");
  });
});
