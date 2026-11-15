// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { boardQuestSchema } from "../../src/shared/schema";

async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Private work", "Private work");
  f.k.store.put("quests", q.id, { ...q, phase: "done", endedAt: f.time() });
  return { ...f, q };
}

describe("quest deletion", () => {
  it("preserves an optional nullable deletion timestamp in the quest schema", async () => {
    const f = await fixture();
    expect(boardQuestSchema.parse({ ...f.q, deletedAt: f.time() })).toHaveProperty("deletedAt", f.time());
    expect(boardQuestSchema.parse({ ...f.q, deletedAt: null })).toHaveProperty("deletedAt", null);
    expect(boardQuestSchema.parse(f.q).deletedAt).toBeUndefined();
  });
  it("hides a deleted quest from visible and cellar lists, and restores it without expiry", async () => {
    const f = await fixture();
    expect(f.k.deleteQuest(f.q.id)).toBe(true);
    expect(f.k.quest(f.q.id)).toMatchObject({ deletedAt: f.time(), archivedAt: f.time() });
    expect(f.k.store.visibleRecords("quests", "lead")).toEqual([]);
    expect(f.k.store.archivedQuestPage(null, 20).quests).toEqual([]);
    expect(f.k.store.archivedQuestCount()).toBe(0);
    f.advance(365 * 86400000);
    expect(f.k.store.deletedQuestPage(null, 20).quests.map(q => q.id)).toEqual([f.q.id]);
    expect(f.k.restoreDeletedQuest(f.q.id)).toBe(true);
    expect(f.k.quest(f.q.id)).toMatchObject({ deletedAt: null, archivedAt: 1000000 });
    expect(f.k.store.archivedQuestCount()).toBe(1);
    expect(f.k.store.events("lead").some(event => event.type === "quest.deleted")).toBe(true);
  });
  it("refuses live deletion and ordinary Bring up of a deleted quest", async () => {
    const f = await fixture();
    const live = await seedQuest(f.k, "lead", "Live work", "Live work");
    expect(() => f.k.deleteQuest(live.id)).toThrow(/done or stopped/);
    f.k.deleteQuest(f.q.id);
    expect(() => f.k.archiveQuests([f.q.id], false)).toThrow(/deleted/);
  });
});
