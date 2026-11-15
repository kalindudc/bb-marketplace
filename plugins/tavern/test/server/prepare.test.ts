// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { registerRpc } from "../../src/server/rpc";

describe("cold journal write preparation", () => {
  it("synchronizes Keeper board mirrors after a board phase change", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    const phases: string[] = [];
    f.port.syncBoardQuests = vi.fn(threadId => {
      expect(threadId).toBe("lead");
      phases.push(f.k.quest(q.id).phase);
    });
    await f.runtime.stop(q.id);
    expect(phases).toContain("stopped");
  });
  it("prepares the Keeper log before committing a board quest or allocating its checklist id", async () => {
    const { k, port } = setup();
    let release!: () => void;
    port.prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    port.edit = vi.fn(() => ({ message: "ready" }));
    const pending = seedQuest(k,"lead", "A", "A");
    expect(k.store.all("quests")).toHaveLength(0);
    expect(port.edit).not.toHaveBeenCalled();
    release();
    await pending;
    expect(port.prepare).toHaveBeenCalledWith("lead");
    expect(port.edit).toHaveBeenCalledOnce();
  });
  it("does not commit a board quest when preparation fails", async () => {
    const { k, port } = setup();
    port.prepare = async () => {
      throw new Error("import unavailable");
    };
    await expect(async () => await k.openQuest("lead", "A", "A")).rejects.toThrow(
      "import unavailable",
    );
    expect(k.store.all("quests")).toHaveLength(0);
    expect(k.store.events("lead").some((event) => event.type === "quest.opened")).toBe(false);
  });
  it("prepares the target log before a quest-edit RPC allocates an entry", async () => {
    const f = setup();
    registerRpc(f.bb, f.runtime);
    let ready = false;
    f.port.prepare = async () => {
      await Promise.resolve();
      ready = true;
    };
    f.port.edit = vi.fn(() => {
      if (!ready) throw new Error("write before prepare");
      return { message: "allocated" };
    });
    const result = await f.harness.invokeRpc("journalEdit", {
      threadId: "lead",
      edit: { op: "add", descriptions: ["Read"], parentId: null },
    });
    expect(result).toEqual({ ok: true, message: "allocated" });
  });
  it("prepares the hired member log before linking its waypoint", async () => {
    const { k, port, runtime } = setup();
    const q = await seedQuest(k,"lead", "A", "A");
    k.plan("lead", {
      ...planInput(q.id),
      party: [
        {
          classId: "smith",
          characterId: null,
          model: null,
          purpose: "Build",
          waypointIds: ["w1"],
        },
      ],
    });
    k.answerAsk(k.asks("lead")[0]!.id, "approve", null, "page");
    let ready: string | null = null;
    port.prepare = async (threadId) => {
      await Promise.resolve();
      ready = threadId;
    };
    port.linkWaypoint = vi.fn((threadId) => {
      if (ready !== threadId) throw new Error("link before prepare");
      return "a1";
    });
    const member = await runtime.hire("lead", "project", {
      classId: "smith",
      boardQuestId: q.id,
      waypointId: "w1",
      title: "Build",
      brief: {
        outcome: "Build",
        mode: "make-it-work",
        outOfScope: "",
        doneWhen: "Pass",
        context: [],
        questions: [],
        timeboxMinutes: null,
      },
    });
    expect(ready).toBe(member.threadId);
    expect(port.linkWaypoint).toHaveBeenCalledOnce();
  });
});
