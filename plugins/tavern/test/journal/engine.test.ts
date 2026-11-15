// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyAction, noteLine, type JournalAction } from "../../src/server/journal/engine";
import type { Actor, JournalEntry } from "../../src/shared/schema";

const agent: Actor = { kind: "agent", threadId: "smith" };
const proof = [{ kind: "command" as const, ref: "npm test", detail: "passed", exitCode: 0 }];
function fixture() {
  let entries: JournalEntry[] = [];
  let counter = 576;
  const run = (action: JournalAction, actor = agent, warden = false) => {
    const result = applyAction(entries, action, { threadId: "smith", actor, now: 1000,
      allocate: () => (counter++).toString(36), roleOf: () => warden ? { classId: "warden", role: "member", boardQuestId: "board", waypointId: "w1" } : null });
    entries = result.entries;
    return result;
  };
  return { run, entries: () => entries };
}

describe("journal rules", () => {
  it("adds and splits atomically and returns short ids", () => {
    const f = fixture();
    expect(f.run({ action: "add", descriptions: ["Build", "Check"] }).entryIds).toEqual(["g0", "g1"]);
    f.run({ action: "split", id: "g0", descriptions: ["one", "two"] });
    expect(f.entries().map(e => e.parentId)).toEqual([null, "g0", "g0", null]);
    expect(() => f.run({ action: "add", descriptions: ["ok", " "] })).toThrow();
    expect(f.entries()).toHaveLength(4);
  });
  it("checks final batch status and does not close a parent with open children", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["parent"] });
    f.run({ action: "add_step", id: "g0", descriptions: ["child"] });
    expect(() => f.run({ action: "done", id: "g0" })).toThrow(/steps/);
    f.run({ action: "toggle", ids: ["g0", "g1", "g1"] });
    expect(f.entries().every(e => e.status === "done")).toBe(true);
    f.run({ action: "reopen", id: "g1" });
    expect(f.entries().every(e => e.status === "todo")).toBe(true);
  });
  it("keeps one doing entry among the agent's own, and lets owned entries be doing side by side", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["Mine one", "Mine two"] });
    f.run({ action: "add", descriptions: ["Class editor (Gaetano)", "Title bar (Steve)", "Away fix (Tim)"], owner: "Gaetano" });
    f.run({ action: "update", id: "g3", owner: "Steve" });
    f.run({ action: "update", id: "g4", owner: "Tim" });
    for (const id of ["g2", "g3", "g4"]) f.run({ action: "start", id });
    f.run({ action: "start", id: "g0" });
    expect(f.entries().map(e => e.status)).toEqual(["doing", "todo", "doing", "doing", "doing"]);
    f.run({ action: "start", id: "g1" });
    // Starting the agent's own entry demotes only its other own entry; owned work stays in progress.
    expect(f.entries().map(e => e.status)).toEqual(["todo", "doing", "doing", "doing", "doing"]);
    // Taking the owner off a doing entry while another unowned entry is doing would break the rule, so it is refused.
    expect(() => f.run({ action: "update", id: "g2", owner: null })).toThrow(/one of your own entries/);
  });
  it("treats an entry owned by its own thread (a member's linked waypoint) as the agent's own work", async () => {
    const { planLine } = await import("../../src/server/journal/engine");
    const f = fixture();
    f.run({ action: "add", descriptions: ["Waypoint one", "Waypoint two"], owner: "smith" });
    f.run({ action: "start", id: "g0" }); f.run({ action: "start", id: "g1" });
    expect(f.entries().map(e => e.status)).toEqual(["todo", "doing"]);
    expect(planLine(f.entries())).toBe("0 of 2 done. Next: [g1] Waypoint two (doing).");
  });
  it("says what the agent does next and whom it waits on", async () => {
    const { planLine } = await import("../../src/server/journal/engine");
    const f = fixture();
    f.run({ action: "add", descriptions: ["Review the plan"] });
    f.run({ action: "add", descriptions: ["Class editor", "Title bar"], owner: "Gaetano" });
    f.run({ action: "update", id: "g2", owner: "Steve" });
    f.run({ action: "start", id: "g1" }); f.run({ action: "start", id: "g2" });
    expect(planLine(f.entries())).toBe("0 of 3 done. Next: [g0] Review the plan (todo). Waiting on: [g1] Gaetano, [g2] Steve.");
    f.run({ action: "done", id: "g0" });
    expect(planLine(f.entries())).toBe("1 of 3 done. Waiting on: [g1] Gaetano, [g2] Steve.");
    f.run({ action: "done", ids: ["g1", "g2"] }); f.run({ action: "add", descriptions: ["Machines (Momo)"], owner: "Momo" });
    expect(planLine(f.entries())).toBe("3 of 4 done. Next: [g3] Machines (Momo) (todo, Momo).");
  });
  it("has one doing entry, reasoned blocks and idempotent done/reopen", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["one", "two"] });
    f.run({ action: "start", id: "g0" });
    f.run({ action: "start", id: "g1" });
    expect(f.entries().map(e => e.status)).toEqual(["todo", "doing"]);
    expect(() => f.run({ action: "block", id: "g1" })).toThrow(/reason/);
    f.run({ action: "block", id: "g1", reason: "waiting for owner" });
    f.run({ action: "done", id: "g0" });
    expect(f.run({ action: "done", id: "g0" }).changed).toBe(false);
    f.run({ action: "reopen", id: "g0" });
    expect(f.run({ action: "reopen", id: "g0" }).changed).toBe(false);
  });
  it("requires evidence on linked entries and matching Warden authority for verdicts", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["deliver"] });
    f.run({ action: "link", id: "g0", link: { boardQuestId: "board", waypointId: "w1" } }, { kind: "tavern" });
    expect(() => f.run({ action: "done", id: "g0" })).toThrow(/evidence/);
    f.run({ action: "done", id: "g0", evidence: proof });
    expect(() => f.run({ action: "verify", id: "g0", evidence: proof })).toThrow(/Warden/);
    f.run({ action: "verify", id: "g0", evidence: proof }, { kind: "agent", threadId: "warden" }, true);
    expect(f.entries()[0]).toMatchObject({ status: "verified", doneBy: agent, updatedBy: { kind: "agent", threadId: "warden" } });
    f.run({ action: "reject", id: "g0", reason: "misses retry" }, { kind: "agent", threadId: "warden" }, true);
    expect(f.entries()[0]).toMatchObject({ status: "rejected", note: "misses retry" });
  });
  it("supports reorder and reparent on both levels with two-level constraints", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["a", "b", "c"] });
    f.run({ action: "reparent", id: "g2", parentId: "g0" });
    expect(() => f.run({ action: "reparent", id: "g0", parentId: "g1" })).toThrow(/steps/);
    f.run({ action: "reparent", id: "g2" });
    f.run({ action: "reorder", id: "g2", targetId: "g0" });
    expect(f.entries().map(e => e.id)).toEqual(["g2", "g0", "g1"]);
  });
  it("cascades deletes only with all open children explicitly selected", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["parent"] });
    f.run({ action: "split", id: "g0", descriptions: ["step"] });
    expect(() => f.run({ action: "delete", id: "g0" })).toThrow(/steps/);
    f.run({ action: "delete", ids: ["g0", "g1"] });
    expect(f.entries()).toEqual([]);
  });
  it("caps descriptions, entries and evidence and validates missing ids", () => {
    const f = fixture();
    expect(() => f.run({ action: "add", descriptions: ["x".repeat(501)] })).toThrow();
    expect(() => f.run({ action: "done", id: "zz" })).toThrow(/not found/);
    f.run({ action: "add", descriptions: Array.from({ length: 200 }, (_, i) => `entry ${i}`) });
    expect(() => f.run({ action: "add", descriptions: ["overflow"] })).toThrow(/200/);
    expect(() => f.run({ action: "done", id: "g0", evidence: Array(31).fill(proof[0]) })).toThrow(/30/);
  });
  it("stores notes, owners, links, dependencies and actor/time, and enforces readiness", () => {
    const f = fixture();
    f.run({ action: "add", descriptions: ["a", "b"] });
    f.run({ action: "update", id: "g1", description: "after a", after: ["g0"], owner: "smith", links: proof });
    expect(() => f.run({ action: "start", id: "g1" })).toThrow(/depend/);
    f.run({ action: "note", id: "g0", note: "decision" });
    f.run({ action: "done", id: "g0", evidence: proof });
    f.run({ action: "start", id: "g1" });
    // An agent's note is a timed line in a running log.
    expect(f.entries()[0]).toMatchObject({ note: noteLine(1000, "decision"), doneAt: 1000, doneBy: agent });
    expect(f.entries()[1]).toMatchObject({ owner: "smith", after: ["g0"], links: proof });
    expect(() => f.run({ action: "update", id: "g0", after: ["g1"] })).toThrow(/cycl/);
  });
});
