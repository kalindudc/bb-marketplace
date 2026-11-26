// @vitest-environment node
import { putQuestFixture } from "./support";
import { seedLegacyQuest } from "./support";
import { describe, expect, it } from "vitest";
import { registerRpc } from "../../src/server/rpc";
import { readStatus, statusInput } from "../../src/server/status";
import { KeeperStore } from "../../src/server/keeper/store";
import type { BoardQuest } from "../../src/shared/schema";
import { setup } from "./runtime-fixture";

function fixture() {
  const f = setup();
  registerRpc(f.bb, f.runtime);
  const quest = async (
    title: string,
    phase: BoardQuest["phase"] = "done",
    keeper = "lead",
  ) => {
    const opened = seedLegacyQuest(f.k, keeper, title, title);
    return putQuestFixture(f.k.store, opened.id, {
      ...opened,
      phase,
      endedAt: ["done", "stopped"].includes(phase) ? f.time() : null,
    });
  };
  const archive = (ids: string[], archived = true) =>
    f.harness.invokeRpc("archiveBoardQuests", { ids, archived }) as Promise<{
      ok: true;
      changed: number;
    }>;
  return { ...f, quest, archive };
}

describe("finished board quest archive", () => {
  it("hides archived quests and their recent events while preserving detail and restore history", async () => {
    const f = fixture();
    const live = await f.quest("Live goal", "scout");
    const done = await f.quest("Returned goal", "scout");
    f.k.ask("lead", { effect: {type:"decision"},
      boardQuestId: done.id,
      kind: "decision",
      question: "Old question",
      why: "History",
      options: [{ id: "a", label: "A", detail: "", recommended: true }],
      meanwhile: "Nothing",
      holds: [],
    });
    putQuestFixture(f.k.store, done.id, { ...done, phase: "done", endedAt: f.time() });
    f.k.store.put("decisions", "old-decision", {
      id: "old-decision",
      keeperThreadId: "lead",
      boardQuestId: done.id,
      text: "Old decision",
      why: "History",
      source: "keeper",
      sourceRef: null,
      reversible: true,
      undone: false,
      createdAt: f.time(),
    });
    f.k.store.event(
      f.time(),
      "lead",
      live.id,
      "test.visible",
      "Keep this visible",
    );
    for (let i = 0; i < 65; i++)
      f.k.store.event(
        f.time(),
        "lead",
        done.id,
        "test.hidden",
        "Archived history",
      );
    expect(await f.archive([done.id, done.id])).toEqual({
      ok: true,
      changed: 1,
      notes: [expect.stringContaining("stays: it has another quest on the board")],
      pendingArchives: [],
    });
    const room = (await f.harness.invokeRpc("room", {})) as {
      archivedCount: number;
      keepers: { boardQuests: BoardQuest[] }[];
      recent: { boardQuestId: string | null; text: string }[];
    };
    expect(room.archivedCount).toBe(1);
    expect(room).toMatchObject({ asks: [], decidedForYou: [] });
    expect(room.keepers[0]!.boardQuests.map((q) => q.id)).toEqual([live.id]);
    expect(
      room.recent.some((event) => event.text === "Keep this visible"),
    ).toBe(true);
    expect(room.recent.some((event) => event.boardQuestId === done.id)).toBe(
      false,
    );
    const ledger = (await f.harness.invokeRpc("ledger", {
      threadId: "lead",
    })) as {
      boardQuests: BoardQuest[];
    };
    expect(ledger.boardQuests.map((q) => q.id)).toEqual([live.id]);
    expect(ledger).toMatchObject({ asks: [], decidedForYou: [], decisions: [{ id: "old-decision" }] });
    expect(f.k.restatement("lead")).not.toContain(done.title);
    const detail = (await f.harness.invokeRpc("boardQuest", {
      id: done.id,
    })) as {
      quest: BoardQuest;
    };
    expect(detail.quest.archivedAt).toBe(f.time());
    expect(
      f.k.store
        .events("lead", 0, 100)
        .find((event) => event.type === "quest.archived")?.actor.kind,
    ).toBe("user");
    expect(f.bb.rpc.experimental_invalidate).toHaveBeenCalledWith(
      expect.arrayContaining(["tavern:room", `tavern:quest:${done.id}`]),
    );
    expect(await f.archive([done.id], false)).toEqual({ ok: true, changed: 1, notes: [], pendingArchives: [] });
    expect(f.k.quest(done.id).archivedAt).toBeNull();
    expect(
      f.k.store
        .events("lead", 0, 100)
        .some((event) => event.type === "quest.restored"),
    ).toBe(true);
    const restored = (await f.harness.invokeRpc("room", {})) as typeof room;
    expect(restored.archivedCount).toBe(0);
    expect(restored.keepers[0]!.boardQuests.map((q) => q.id)).toContain(
      done.id,
    );
  });
  it("validates the whole batch, refuses unfinished quests and is idempotent", async () => {
    const f = fixture();
    const done = await f.quest("Done");
    const active = await f.quest("Active", "wrap");
    await expect(f.archive([done.id, active.id])).rejects.toThrow(
      "done or stopped",
    );
    expect(f.k.quest(done.id).archivedAt).toBeNull();
    await expect(f.archive([done.id, "missing"])).rejects.toThrow();
    expect(f.k.quest(done.id).archivedAt).toBeNull();
    const stopped = await f.quest("Stopped", "stopped");
    expect((await f.archive([done.id, stopped.id])).changed).toBe(2);
    expect((await f.archive([done.id, stopped.id])).changed).toBe(0);
    expect(
      f.k.store
        .events("lead")
        .filter((event) => event.type === "quest.archived"),
    ).toHaveLength(2);
    expect((await f.archive([done.id], false)).changed).toBe(1);
    expect((await f.archive([done.id], false)).changed).toBe(0);
  });
  it("pages newest first with stable tie cursors, counts every Keeper, and survives restoration of a cursor row", async () => {
    const f = fixture();
    f.k.bind("other", "keeper", "wren", "project");
    const quests = await Promise.all(
      ["A", "B", "C", "D", "E"].map((title, i) =>
        f.quest(title, "done", i % 2 ? "other" : "lead"),
      ),
    );
    await f.archive(quests.map((q) => q.id));
    const expected = quests
      .sort((a, b) => b.id.localeCompare(a.id))
      .map((q) => q.id);
    type Page = {
      boardQuests: BoardQuest[];
      nextCursor: string | null;
      total: number;
    };
    const page = (cursor: string | null) =>
      f.harness.invokeRpc("archivedBoardQuests", {
        cursor,
        limit: 2,
      }) as Promise<Page>;
    const first = await page(null);
    expect(first.boardQuests.map((q) => q.id)).toEqual(expected.slice(0, 2));
    expect(first.total).toBe(5);
    await f.archive([first.boardQuests[1]!.id], false);
    const second = await page(first.nextCursor);
    const third = await page(second.nextCursor);
    expect(
      [...first.boardQuests, ...second.boardQuests, ...third.boardQuests].map(
        (q) => q.id,
      ),
    ).toEqual(expected);
    expect(second.total).toBe(4);
    expect(third.nextCursor).toBeNull();
    expect(new KeeperStore(f.k.store.db).archivedQuestCount()).toBe(4);
    await expect(page("not-a-cursor")).rejects.toThrow(
      "Invalid archive cursor",
    );
  });
  it("filters archived rows before room and restatement limits so old active quests remain visible", async () => {
    const f = fixture();
    const active = await f.quest("Older active goal", "scout");
    const finished: BoardQuest[] = [];
    for (let i = 0; i < 105; i++) finished.push(await f.quest(`Finished ${i}`));
    await f.archive(finished.map((q) => q.id));
    const room = (await f.harness.invokeRpc("room", {})) as {
      keepers: { boardQuests: BoardQuest[] }[];
      archivedCount: number;
    };
    expect(room.archivedCount).toBe(105);
    expect(room.keepers[0]!.boardQuests.map((q) => q.id)).toEqual([active.id]);
    expect(f.k.restatement("lead")).toContain(active.title);
    const status = readStatus(f.runtime, "lead", statusInput.parse({}));
    expect(JSON.stringify(status)).toContain(active.title);
    expect(JSON.stringify(status)).not.toContain("Finished ");
    expect(status).toMatchObject({ archivedCount: 105 });
  });
  it("status exposes archived history only as a per-Keeper count, including explicit report and event requests", async () => {
    const f = fixture();
    const done = await f.quest("Private archived title");
    f.k.store.put("reports", "old-report", {
      id: "old-report",
      memberThreadId: "maker",
      keeperThreadId: "lead",
      boardQuestId: done.id,
      waypointId: null,
      status: "done",
      outcome: "Old archived outcome",
      evidence: [],
      artifacts: [],
      confidence: null,
      voice: null,
      createdAt: f.time(),
      deliveredAt: f.time(),
    });
    f.k.store.event(
      f.time(),
      "lead",
      done.id,
      "report.done",
      "Old archived outcome",
    );
    await f.archive([done.id]);
    for (const input of [
      {},
      { boardQuestId: done.id },
      { reportId: "old-report" },
      { section: "reports" },
      { section: "events" },
      { section: "asks" },
    ]) {
      const status = readStatus(f.runtime, "lead", statusInput.parse(input));
      expect(status).toMatchObject({ archivedCount: 1 });
      expect(JSON.stringify(status)).not.toContain("Private archived title");
      expect(JSON.stringify(status)).not.toContain("Old archived outcome");
    }
    f.k.bind("other", "keeper", "wren", "project");
    expect(readStatus(f.runtime, "other", statusInput.parse({}))).toMatchObject(
      {
        archivedCount: 0,
      },
    );
  });
  it("retains a multi-quest steer for its remaining live target when the first target is archived", async () => {
    const f = fixture();
    const first = await f.quest("Finished target", "scout");
    const remaining = await f.quest("Remaining target", "scout");
    f.k.receiveUser("lead", "Keep the rollback");
    f.k.route("lead", {
      kind: "steer",
      boardQuestIds: [first.id, remaining.id],
      summary: "Keep the rollback",
    });
    putQuestFixture(f.k.store, first.id, {
      ...first,
      phase: "done",
      endedAt: f.time(),
    });
    await f.archive([first.id]);
    expect(f.k.restatement("lead")).toContain(`${remaining.id},`);
    expect(f.k.restatement("lead")).toContain('user "Keep the rollback"');
    const ledger = (await f.harness.invokeRpc("ledger", {
      threadId: "lead",
    })) as {
      routes: { boardQuestIds: string[] }[];
    };
    expect(ledger.routes[0]!.boardQuestIds).toContain(remaining.id);
  });
  it("uses the archive index for cursor paging and count queries", async () => {
    const f = fixture();
    const done = await f.quest("Done");
    await f.archive([done.id]);
    const plan = f.k.store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT data FROM tavern_records WHERE kind='quests' AND archived_at IS NOT NULL ORDER BY archived_at DESC, id DESC LIMIT 10",
      )
      .all();
    expect(JSON.stringify(plan)).toContain("tavern_quest_archive");
  });
});
