// @vitest-environment node
import { putQuestFixture } from "./support";
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";

describe("Opening receipt event projection", () => {
  it("projects source events through the quest binding without rewriting the audit history", async () => {
    const f = setup();
    f.k.receiveUser("lead", "A private archived goal");
    const route = f.k.route("lead", { kind: "new-quest", summary: "Private goal", notes: [] });
    const opening = () => f.k.store.db.prepare("SELECT * FROM tavern_events WHERE type IN (\'user.message\',\'route.recorded\') ORDER BY id").all();
    const original = opening();
    expect(original).toHaveLength(2);
    const q = await f.k.openQuest("lead", "A private archived goal", "Private");
    expect(opening()).toEqual(original);
    expect(f.k.store.unreadEvents("lead", 0).filter(event => ["user.message", "route.recorded"].includes(event.type))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "user.message", boardQuestId: q.id }),
      expect.objectContaining({ type: "route.recorded", boardQuestId: q.id }),
    ]));
    f.k.store.event(f.time(), "lead", null, "note.added", "An independent fact");
    putQuestFixture(f.k.store, q.id, { ...q, phase: "done", endedAt: f.time(), archivedAt: f.time() });
    const visible = f.k.store.unreadEvents("lead", 0, 100, true);
    expect(visible.some(event => event.text.includes("private"))).toBe(false);
    expect(f.k.store.roomEvents().some(event => event.text.includes("private"))).toBe(false);
    expect(visible).toContainEqual(expect.objectContaining({ text: "An independent fact", boardQuestId: null }));
    expect(f.k.store.eventCount("lead", 0, true)).toBe(visible.length);
    expect(opening()).toEqual(original);
    expect(f.k.store.events("lead").find(event => event.type === "user.message")?.boardQuestId).toBeNull();
    expect(() => f.k.store.db.prepare("UPDATE tavern_events SET board_quest_id=? WHERE type=\'user.message\'").run(q.id)).toThrow("Tavern events are append-only");
    expect(opening()).toEqual(original);
    expect(f.k.store.get("routes", route.id)?.boardQuestId).toBe(q.id);
  });
  it("indexes the source receipt lookup instead of scanning all routes", () => {
    const f = setup();
    const plan = f.k.store.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM tavern_records opening WHERE opening.kind=\'routes\' AND json_extract(opening.data,\'$.sourceMessageId\')=? AND json_extract(opening.data,\'$.kind\')=\'new-quest\'").all("receipt") as { detail: string }[];
    expect(plan.map(row => row.detail).join("\n")).toContain("USING INDEX tavern_route_source");
  });
});
