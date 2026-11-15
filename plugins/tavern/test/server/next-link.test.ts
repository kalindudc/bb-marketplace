// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../../src/shared/schema";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";

function entry(questId: string, waypointId: string, status: JournalEntry["status"]): JournalEntry {
  return {
    threadId: "maker",
    boardQuestId: null,
    id: waypointId === "w1" ? "a1" : "a2",
    parentId: null,
    description: "Work",
    status,
    owner: "maker",
    after: [],
    links: [],
    doneAt: null,
    doneBy: null,
    note: null,
    evidence: [{ kind: "command", ref: "npm test", detail: "Passed", exitCode: 0 }],
    review: null,
    link: { boardQuestId: questId, waypointId },
    order: 0,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    createdBy: { kind: "tavern" },
    updatedBy: { kind: "tavern" },
  };
}

describe("quest next-link summaries", () => {
  it("asks for a quest map before a plan exists in the summary, ledger and restatement", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "Small goal", "Small");
    registerRpc(f.bb, f.runtime);
    expect(f.k.summary(q.id).move.text).toBe("Propose the quest map");
    expect(f.k.restatement("lead")).toContain("Next link: Propose the quest map");
    expect(f.k.restatement("lead")).not.toContain("Check the plan");
    const ledger = (await f.harness.invokeRpc("ledger", { threadId: "lead" })) as {
      boardQuests: { move: { text: string } }[];
    };
    expect(ledger.boardQuests[0]!.move.text).toBe("Propose the quest map");
  });

  it.each([
    ["done", "Returned · verified 2 of 2"],
    ["stopped", "Stopped · verified 1 of 2"],
    ["wrap", "Wrapping · verified 2 of 2"],
  ] as const)(
    "describes the outcome for %s instead of suggesting more work",
    async (phase, text) => {
      const f = setup();
      const q = await seedQuest(f.k,"lead", "Completed goal", "Goal");
      const base = planInput(q.id);
      f.k.plan("lead", {
        ...base,
        waypoints: [base.waypoints[0]!, { ...base.waypoints[0]!, id: "w2" }],
      });
      f.port.linkedEntries = () => [
        entry(q.id, "w1", "verified"),
        entry(q.id, "w2", phase === "stopped" ? "todo" : "verified"),
      ];
      f.k.store.put("quests", q.id, {
        ...f.k.quest(q.id),
        phase,
        endedAt: phase === "wrap" ? null : f.time(),
      });
      registerRpc(f.bb, f.runtime);
      expect(f.k.summary(q.id).move).toEqual({ who: phase === "wrap" ? "keeper" : "nobody", text });
      const detail = (await f.harness.invokeRpc("boardQuest", { id: q.id })) as {
        quest: { move: { text: string } };
      };
      const ledger = (await f.harness.invokeRpc("ledger", { threadId: "lead" })) as {
        boardQuests: { move: { text: string } }[];
      };
      expect(detail.quest.move.text).toBe(text);
      expect(ledger.boardQuests[0]!.move.text).toBe(text);
      const restatement = f.k.restatement("lead");
      expect(restatement).not.toContain("Review the done-when");
      expect(restatement).not.toContain("Check the plan");
      if (phase === "wrap") expect(restatement).toContain(`Next link: ${text}`);
      else expect(restatement).not.toContain("Next link:");
    },
  );
});
