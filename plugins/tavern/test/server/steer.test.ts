import { withMemberFixtures } from "./member-fixture";
import { seedQuest } from "./support";
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { Keeper } from "../../src/server/keeper/service";
import { fakePort, planInput } from "./support";

let keeper: Keeper;
beforeEach(() => {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  keeper = withMemberFixtures(new Keeper(new KeeperStore(db), fakePort(), () => 1_000_000));
  keeper.bind("lead", "keeper", "wren", "project");
});

describe("two-quest steer replay", () => {
  it("changes only the named quest; questions and asides change neither plan", async () => {
    const a = await seedQuest(keeper,"lead", "Vault cutover", "Vault");
    const b = await seedQuest(keeper,"lead", "Proxy retry", "Proxy");
    keeper.plan("lead", { ...planInput(a.id) });
    keeper.plan("lead", { ...planInput(b.id) });
    const replay = [
      ["Vault: stage first", "steer", a.id],
      ["What is waiting?", "question", null],
      ["Look up lunch menus", "aside", null],
      ["Proxy: retry only once", "steer", b.id],
      ["Which model checks it?", "question", null],
      ["Vault: keep the rollback", "steer", a.id],
      ["Check the weather", "aside", null],
      ["Proxy: stop the extra rollout", "steer", b.id],
      ["What is the ETA?", "question", null],
      ["Vault: test staging again", "steer", a.id],
    ] as const;
    for (const [text, kind, boardQuestId] of replay) {
      const versions = [keeper.quest(a.id).planVersion, keeper.quest(b.id).planVersion];
      keeper.receiveUser("lead", text);
      const route = keeper.route("lead", { kind, boardQuestId, summary: text });
      if (kind === "steer")
        keeper.plan("lead", { ...planInput(boardQuestId!), fromSteer: route.id });
      expect(keeper.quest(a.id).planVersion).toBe(
        versions[0]! + (kind === "steer" && boardQuestId === a.id ? 1 : 0),
      );
      expect(keeper.quest(b.id).planVersion).toBe(
        versions[1]! + (kind === "steer" && boardQuestId === b.id ? 1 : 0),
      );
    }
    expect(keeper.store.all("routes")).toHaveLength(12);
    expect(keeper.store.all("routes").filter(route => route.kind === "new-quest")).toHaveLength(2);
  });
  it("allows planning after a plain aside while rejecting invalid routes and foreign writes", async () => {
    const quest = await seedQuest(keeper,"lead", "A", "A");
    keeper.endTurn("lead");
    keeper.receiveUser("lead", "An unrelated aside");
    expect(() =>
      keeper.route("lead", { kind: "aside", boardQuestId: quest.id, summary: "aside" }),
    ).toThrow(/must not/);
    keeper.route("lead", { kind: "aside", summary: "aside" });
    keeper.plan("lead", planInput(quest.id));
    expect(keeper.quest(quest.id).planVersion).toBe(1);
    keeper.receiveUser("lead", "Change the plan");
    expect(() => keeper.route("lead", { kind: "steer", summary: "unsure" })).toThrow(/quest/);
    keeper.bind("other", "keeper", "moss", "project");
    expect(() => keeper.plan("other", planInput(quest.id))).toThrow(/own/);
  });
});
