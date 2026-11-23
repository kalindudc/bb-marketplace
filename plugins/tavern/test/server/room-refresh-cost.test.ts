// @vitest-environment node
import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { rpcHandlers } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";

it("shares room projections across keepers, quests, and waypoint owners", async () => {
  let statements = 0;
  const db = new Database(":memory:", { verbose: () => { statements++; } });
  const { k, runtime } = setup({}, undefined, undefined, db);
  try {
    for (const keeperId of ["lead", "second", "third"]) {
      k.bind(keeperId, "keeper", "wren", "project");
      for (let i = 0; i < 3; i++) {
        const quest = await seedQuest(k, keeperId, `Quest ${i}`, `Q${i}`);
        k.plan(keeperId, planInput(quest.id));
        k.bind(`${keeperId}-maker-${i}`, "smith", "lark", "project", {
          keeperThreadId: keeperId, boardQuestId: quest.id, waypointId: "w1", errand: false, title: "Build",
          brief: { outcome: "Build", mode: "make-it-work", outOfScope: "", doneWhen: "Checks pass", context: [], questions: [], timeboxMinutes: null },
        });
      }
    }
    const handlers = rpcHandlers(runtime);
    statements = 0;
    const result = await handlers.room({});
    const roomStatements = statements;
    statements = 0;
    const badge = await handlers.attentionCount({});
    const badgeStatements = statements;
    console.log("U1 SQL", JSON.stringify({ room: roomStatements, badge: badgeStatements }));
    expect(result.keepers).toHaveLength(3);
    for (const keeper of result.keepers) {
      expect(keeper.boardQuests).toHaveLength(3);
      for (const quest of keeper.boardQuests) expect(quest.waypoints[0]?.ownerMember).toEqual(quest.members[0]);
    }
    expect(badge.count).toBe(result.attention!.needYou);
    expect(roomStatements).toBeLessThanOrEqual(165);
    expect(badgeStatements).toBeLessThanOrEqual(10);
  } finally { k.store.db.close(); }
});
