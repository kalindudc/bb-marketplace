// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { makeHost } from "./host";
import { createJournalStore } from "../../src/server/journal/store";
import { MIGRATIONS as JOURNAL_MIGRATIONS } from "../../src/server/migrations";
import type { JournalDeps } from "../../src/server/ports";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });
function fixture(metadata: Record<string, unknown> = {}, roles: JournalDeps["roleOf"] = () => null, legacyEnabled = false) {
  const invalidations: string[][] = [];
  const { bb, db, mirrors, dispose, ...host } = makeHost(metadata, legacyEnabled);
  cleanup.push(dispose);
  bb.storage.migrate(db, JOURNAL_MIGRATIONS);
  const deps: JournalDeps = { roleOf: roles, invalidate: t => invalidations.push(t) };
  const store = createJournalStore(bb, db, deps);
  return { store, db, bb, mirrors, invalidations, ...host };
}
const proof = [{ kind: "command" as const, ref: "npm test", detail: "pass", exitCode: 0 }];

describe("SQLite journal store", () => {
  it("persists, groups batch add and split, and never reuses deleted or undone ids", async () => {
    const { store } = fixture();
    await store.ready("t");
    await store.runTool("t", { action: "add", descriptions: ["one", "two"] });
    expect(store.get("t").entries.map(e => e.id)).toEqual(["00", "01"]);
    await store.runTool("t", { action: "undo" });
    expect(store.get("t").entries).toEqual([]);
    await store.runTool("t", { action: "redo" });
    expect(store.get("t").entries).toHaveLength(2);
    await store.runTool("t", { action: "split", id: "00", descriptions: ["a", "b"] });
    await store.runTool("t", { action: "undo" });
    expect(store.get("t").entries).toHaveLength(2);
    await store.runTool("t", { action: "clear", all: true });
    await store.runTool("t", { action: "add", descriptions: ["new"] });
    expect(store.get("t").entries[0]?.id).toBe("04");
    expect(store.get("t").canRedo).toBe(false);
  });
  it("rolls back failed mutations and persists only 50 history actions", async () => {
    const { store, db } = fixture();
    await store.ready("t");
    for (let i = 0; i < 55; i++) await store.runTool("t", { action: "add", descriptions: [`entry ${i}`] });
    expect(db.prepare("SELECT count(*) AS n FROM questlog_history").get()).toEqual({ n: 50 });
    const before = store.get("t");
    const bad = await store.runTool("t", { action: "split", id: "00", descriptions: ["x".repeat(501)] });
    expect(bad.isError).toBe(true);
    expect(store.get("t")).toEqual(before);
  });
  it("delivers descriptive UI edits once and mirrors minions' exact namespace and shape", async () => {
    const { store, mirrors } = fixture();
    await store.ready("t");
    store.edit("t", { op: "add", descriptions: ["retry"], parentId: null }, { kind: "user" });
    store.edit("t", { op: "status", entryIds: ["00"], status: "done" }, { kind: "user" });
    expect((await store.runTool("t", { action: "list" })).text).toContain('The user ticked [00] "retry" done');
    expect((await store.runTool("t", { action: "list" })).text).not.toContain("Your journal changed");
    await store.flush("t");
    expect(mirrors.at(-1)).toEqual({ threadId: "t", pluginId: "quests", set: { progress: { done: 1, total: 1, current: null } } });
  });
  it("imports legacy hex ids and reserves historical used ids without deleting metadata", async () => {
    const legacy = { log: { version: 1, quests: [{ id: "a3", description: "old", done: true, createdAt: 123 }],
      steps: [{ id: "ff", parentId: "a3", description: "step", done: true, createdAt: 124 }], usedIds: ["a3", "ff", "e1"], history: [], redoStack: [] } };
    const { store, db } = fixture(legacy);
    await store.ready("t");
    expect(store.get("t").entries[0]).toMatchObject({ id: "a3", status: "done", createdAt: 123, createdBy: { kind: "import", from: "pi-quests" } });
    expect(db.prepare("SELECT id FROM questlog_reserved WHERE id = 'e1'").get()).toEqual({ id: "e1" });
    expect(legacy.log.quests).toHaveLength(1);
  });
  it("fails loudly on malformed legacy or history data and never overwrites it", async () => {
    const f = fixture({ log: { version: 2 } });
    await expect(f.store.ready("t")).rejects.toThrow(/invalid|version/i);
    const g = fixture(); await g.store.ready("t");
    await g.store.runTool("t", { action: "add", descriptions: ["a"] });
    g.db.prepare("UPDATE questlog_history SET before_data = ?").run('{"broken":true}');
    expect((await g.store.runTool("t", { action: "undo" })).isError).toBe(true);
    expect(g.store.get("t").entries).toHaveLength(1);
  });
  it("implements linking, cross-thread verification, rejection notification and rejects privilege escalation through undo", async () => {
    const { store } = fixture({}, t => t === "warden" ? { classId: "warden", role: "member", boardQuestId: "b", waypointId: "w1", checkerEntryReview: () => ({}) } : null);
    await store.ready("smith");
    const id = store.linkWaypoint("smith", { boardQuestId: "b", waypointId: "w1" }, "deliver", "smith", { kind: "tavern" });
    expect(store.linkWaypoint("smith", { boardQuestId: "b", waypointId: "w1" }, "deliver", "smith", { kind: "tavern" })).toBe(id);
    expect((await store.runTool("smith", { action: "done", id })).isError).toBe(true);
    await store.runTool("smith", { action: "done", id, evidence: proof });
    expect((await store.runTool("intruder", { action: "verify", threadId: "smith", id, evidence: proof })).isError).toBe(true);
    expect((await store.runTool("warden", { action: "verify", threadId: "smith", id, evidence: proof })).isError).toBe(false);
    expect(store.linkedEntries("b")[0]?.status).toBe("verified");
    await store.runTool("warden", { action: "reopen", threadId: "smith", id });
    await store.runTool("smith", { action: "done", id, evidence: proof });
    await store.runTool("warden", { action: "reject", threadId: "smith", id, reason: "missing branch" });
    expect((await store.runTool("smith", { action: "undo" })).isError).toBe(true);
    expect((await store.runTool("smith", { action: "list" })).text).toContain("missing branch");
  });
  it("lists filters and gets evidence; warns on unlinked completion without evidence", async () => {
    const { store } = fixture(); await store.ready("t");
    await store.runTool("t", { action: "add", descriptions: ["one", "two"], owner: "t" });
    expect((await store.runTool("t", { action: "done", id: "00" })).text).toContain("without evidence");
    await store.runTool("t", { action: "block", id: "01", reason: "waiting" });
    expect((await store.runTool("t", { action: "list", filter: "blocked" })).text).toContain("two");
    expect((await store.runTool("t", { action: "list", filter: "open" })).text).not.toContain("[00]");
    expect((await store.runTool("t", { action: "list", filter: "mine" })).text).toContain("one");
    expect((await store.runTool("t", { action: "get", id: "01" })).text).toContain("waiting");
    expect((await store.runTool("t", { action: "skill" })).text).toContain("board quest");
    expect((await store.runTool("t", { action: "rules" })).text).toContain("Warden");
  });
  it("stays read-only and does not mirror while pi-quests is enabled", async () => {
    const { store, mirrors } = fixture({}, () => null, true); await store.ready("t");
    expect(store.get("t").toolOwnedElsewhere).toBe(true);
    expect((await store.runTool("t", { action: "add", descriptions: ["blocked"] })).isError).toBe(true);
    await store.flush("t"); expect(mirrors).toEqual([]);
  });
});
