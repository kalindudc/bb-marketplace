// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { transitionQuest, QUEST_TRANSITIONS, displayStage, nextNewsBy } from "../../src/server/keeper/quest-lifecycle";
import type { BoardQuest } from "../../src/shared/schema";
import { planInput } from "./support";

function fixture(phase: BoardQuest["phase"] = "scout") {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  const store = new KeeperStore(db);
  const quest: BoardQuest = { id: "q", keeperThreadId: "k", title: "Watch", short: "Watch", phase, planVersion: 1, greenlitVersion: null, createdAt: 1, updatedAt: 1, endedAt: null, archivedAt: null, ...(phase === "held" ? { held: { from: "scout" as const, since: 1 } } : {}) };
  db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('quests',?,?)").run(quest.id, JSON.stringify(quest));
  return { store, quest };
}

describe("quest lifecycle", () => {
  it("pins the allowed rows and records each cause atomically", () => {
    expect([...new Set(QUEST_TRANSITIONS.map(row => row.cause))].sort()).toEqual(["approve", "approve-lead", "approve-lead-user", "auto-approve", "close", "close-early", "conclude", "conclude-lead", "conclude-open-at-upgrade", "conclude-withdrawn", "extensions", "hold", "keep-open", "open", "open-lead", "plan", "ranger-plan", "reopen", "replacement-plan", "resume", "stop", "stop-chain", "stopped", "undo"]);
    for (const row of QUEST_TRANSITIONS) {
      const { store, quest } = fixture(row.from ?? "scout");
      if (row.from === null) store.remove("quests", quest.id);
      if (row.cause === "resume") {
        quest.held = { from: row.to as "scout" | "greenlight" | "build", since: 1 };
        store.db.prepare("UPDATE tavern_records SET data=? WHERE id=?").run(JSON.stringify(quest), quest.id);
      }
      if (row.cause === "reopen" && row.to === "build") {
        quest.greenlitVersion = 1;
        store.db.prepare("UPDATE tavern_records SET data=? WHERE id=?").run(JSON.stringify(quest), quest.id);
      }
      const actor = row.actors.includes("user") ? { kind: "user" as const } : row.actors.includes("agent") ? { kind: "agent" as const, threadId: "k" } : { kind: "tavern" as const };
      const receipt = { kind: row.receipt, id: row.cause === "ranger-plan" ? "q:1" : "receipt" };
      const patch = row.cause === "ranger-plan" ? { checkPlanVersion: 1 } : undefined;
      if (patch) {
        expect(() => transitionQuest(store, quest, row.to, row.cause, actor, receipt, 2, { patch })).toThrow(/recorded Ranger-only plan/);
        store.put("plans", receipt.id, {
          ...planInput(quest.id), reversible: false, version: 1, fromSteer: null, createdAt: 1, alwaysAskKinds: [],
          party: [{ classId: "ranger", characterId: null, model: null, purpose: "Scout", waypointIds: ["w1"] }],
        });
      }
      if (row.cause === "replacement-plan") {
        expect(() => transitionQuest(store, quest, row.to, row.cause, actor, receipt, 2)).toThrow(/earlier party approval/);
        continue;
      }
      const leadReceiptErrors: Record<string, RegExp> = {
        "open-lead": /recorded lead hire receipt/,
        "approve-lead": /exact lead-plan approval/,
        "approve-lead-user": /exact lead-plan approval/,
        "conclude-lead": /exact child request/,
      };
      const missingLeadReceipt = leadReceiptErrors[row.cause];
      if (missingLeadReceipt) {
        expect(() => transitionQuest(store, quest, row.to, row.cause, actor, receipt, 2)).toThrow(missingLeadReceipt);
        expect(store.events("k")).toEqual([]);
        continue;
      }
      const result = transitionQuest(store, quest, row.to, row.cause, actor, receipt, 2, { patch });
      expect(result.phase).toBe(row.to);
      const event = store.events("k", 0, 10).at(-1)!;
      expect(event.data.phase).toEqual({ from: row.from, to: row.to });
      expect(event.actor).toEqual(actor);
      expect(event.data.receipt).toEqual(receipt);
    }
  });
  it("refuses every unlisted move, wrong actor and wrong receipt", () => {
    const states = ["scout", "greenlight", "build", "held", "closing", "done", "stopping", "stopped"] as const;
    for (const cause of new Set(QUEST_TRANSITIONS.map(row => row.cause))) for (const from of states) {
      const { store, quest } = fixture(from);
      for (const to of states) {
        if (QUEST_TRANSITIONS.some(row => row.from === from && row.to === to && row.cause === cause)) continue;
        expect(() => transitionQuest(store, quest, to, cause, { kind: "user" }, { kind: "user-act", id: "page" }, 2)).toThrow();
      }
    }
    for (const row of QUEST_TRANSITIONS) {
      const { store, quest } = fixture(row.from ?? "scout");
      if (row.from === null) store.remove("quests", quest.id);
      expect(() => transitionQuest(store, quest, row.to, row.cause, { kind: "import", from: "forged" }, { kind: row.receipt, id: "x" }, 2)).toThrow();
      expect(() => transitionQuest(store, quest, row.to, row.cause, { kind: "user" }, { kind: "forged", id: "x" }, 2)).toThrow();
    }
    const { store, quest } = fixture();
    expect(() => transitionQuest(store, quest, "held", "hold", { kind: "agent", threadId: "k" }, { kind: "user-act", id: "page" }, 2)).toThrow();
    expect(() => transitionQuest(store, quest, "held", "hold", { kind: "user" }, { kind: "plan", id: "x" }, 2)).toThrow();
  });
  it("no other writer can change the stored field, regardless of spelling", () => {
    const { store, quest } = fixture();
    const key = ["ph", "ase"].join("");
    expect(() => store.put("quests", quest.id, { ...quest, [key]: "build" })).toThrow(/lifecycle/);
    expect(store.get("quests", quest.id)?.phase).toBe("scout");
  });
  it("rolls back the phase when recording its event fails", () => {
    const { store, quest } = fixture();
    vi.spyOn(store, "event").mockImplementation(() => { throw new Error("Receipt log failed"); });
    expect(() => transitionQuest(store, quest, "held", "hold", { kind: "user" }, { kind: "user-act", id: "page" }, 2)).toThrow("Receipt log failed");
    expect(store.get("quests", quest.id)?.phase).toBe("scout");
    expect(store.events("k")).toEqual([]);
  });
  it("derives review and wrap on read, including legacy stored stages", () => {
    expect(displayStage("build", [{ state: "reported" }], true)).toBe("check");
    expect(displayStage("build", [{ state: "verified" }], true)).toBe("wrap");
    expect(displayStage("check", [{ state: "planned" }], true)).toBe("build");
    expect(displayStage("wrap", [], false)).toBe("build");
    expect(displayStage("held", [{ state: "verified" }], true)).toBe("held");
  });
  it("next news is the earliest live time box or due promise, only in scout", () => {
    expect(nextNewsBy("scout", [300, 100], [200])).toBe(100);
    expect(nextNewsBy("scout", [], [200])).toBe(200);
    expect(nextNewsBy("scout", [], [])).toBeNull();
    expect(nextNewsBy("build", [100], [200])).toBeNull();
  });
});
