// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";
import { Shuttle } from "../src/shuttle";
import { Store } from "../src/db/store";
import { FakePort, harness, memoryDb, pr, TEST_SERVER, testConfig } from "./helpers";

const KEY = (n: number) => `forge:shop/world#${n}`;
const DELTA_KEY = (n: number) => `delta:shop/platform#${n}`;
const DELTA_SERVER = {
  ...TEST_SERVER,
  id: "delta",
  name: "Delta",
  pattern: "^https://delta\\.test/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)",
  link: "https://delta.test/{repo}/pull/{number}",
  read: "delta pr view {number} -R {repo}",
} as const;

describe("boards", () => {
  it("creates boards with ordered cross-server membership and no PR side effects", async () => {
    const h = harness(testConfig({ servers: [TEST_SERVER, DELTA_SERVER] as never }));
    h.views[1] = pr(1, { author: "me", review: "approved" });
    h.views[3] = pr(3, { author: "me", checks: "failed" });
    h.views[22] = pr(22, { repo: "shop/platform", author: "dana", state: "merged", review: "approved" });
    await h.shuttle.sync();

    const created = await h.shuttle.boardCreate(
      {
        name: "  Release train  ",
        description: "  Shipping set  ",
        prs: [KEY(3), "https://delta.test/shop/platform/pull/22", KEY(1)],
      },
      "thr_worker",
    );

    expect(created.board).toMatchObject({
      name: "Release train",
      description: "Shipping set",
      createdBy: "thr_worker",
      prCount: 3,
      attention: 1,
      ready: 1,
      merged: 1,
    });
    expect(created.board.preview.map((pr: { key: string }) => pr.key)).toEqual([KEY(3), DELTA_KEY(22), KEY(1)]);
    expect(created.prs.map((pr: { key: string }) => pr.key)).toEqual([KEY(3), DELTA_KEY(22), KEY(1)]);
    for (const key of [KEY(3), DELTA_KEY(22), KEY(1)]) {
      const view = h.shuttle.view(key);
      expect(view.links).toEqual([]);
      expect(view.tracked).toBe(false);
      expect(view.watch).toBeNull();
    }
    expect(h.port.spawned).toEqual([]);
    expect(h.port.sent).toEqual([]);
  });

  it("keeps trimmed names unique across archived boards and survives a reload", async () => {
    const clock = { now: Date.parse("2026-10-23T12:00:00Z") };
    const db = memoryDb();
    const store = new Store(db, () => clock.now);
    store.saveConfig(testConfig());
    const port = new FakePort();
    const settings = { ...DEFAULT_SETTINGS };
    const shuttle = new Shuttle({ store, port, now: () => clock.now, settings: () => settings });

    const created = await shuttle.boardCreate({ name: "Release cut", description: "Stable set" }, "thr_release");
    const id = created.board.id;
    const archived = shuttle.boardUpdate({ id, archived: true });

    expect(archived.board.archivedAt).not.toBeNull();
    await expect(shuttle.boardCreate({ name: "  release cut  " })).rejects.toThrow(/already exists/i);

    const reloaded = new Shuttle({ store: new Store(db, () => clock.now), port, now: () => clock.now, settings: () => settings });
    expect(reloaded.boards({ query: "cut", archived: "only" })).toMatchObject({
      boards: [{ id, name: "Release cut", description: "Stable set", createdBy: "thr_release" }],
    });
  });

  it("adds and removes membership idempotently and rejects partial batches atomically", async () => {
    const h = harness();
    h.views[1] = pr(1, { author: "dana" });
    h.views[2] = pr(2, { author: "dana" });

    const created = await h.shuttle.boardCreate({ name: "Launch board", prs: [KEY(1)] });
    const id = created.board.id;

    await expect(h.shuttle.boardAdd({ id, prs: [KEY(2), "not a pr"] })).rejects.toThrow(/PR link or a key/i);
    expect(h.shuttle.board(id).prs.map((pr: { key: string }) => pr.key)).toEqual([KEY(1)]);

    const added = await h.shuttle.boardAdd({ id, prs: ["https://forge.test/shop/world/pull/1", KEY(2), KEY(2)] });
    expect(added).toEqual({ board: expect.any(Object), added: [KEY(2)], alreadyPresent: [KEY(1)] });
    expect(added.board.prCount).toBe(2);

    const removed = h.shuttle.boardRemove({ id, prs: ["https://forge.test/shop/world/pull/2", "https://forge.test/shop/world/pull/2"] });
    expect(removed).toEqual({ board: expect.any(Object), removed: [KEY(2)] });
    expect(h.shuttle.board(id).prs.map((pr: { key: string }) => pr.key)).toEqual([KEY(1)]);
    expect(h.shuttle.boardRemove({ id, prs: [KEY(2)] })).toEqual({ board: expect.any(Object), removed: [] });
  });

  it("returns no memberships for a valid PR key that is not cached, without fetching it", async () => {
    const h = harness();
    await h.shuttle.boardCreate({ name: "Unrelated board" });
    const before = h.runner.calls.length;
    expect(h.shuttle.boards({ key: KEY(999), archived: "include" })).toEqual({ boards: [] });
    expect(h.runner.calls).toHaveLength(before);
    expect(() => h.shuttle.boards({ key: "not a key" })).toThrow(/key/i);
  });

  it("fails archived-board adds before any adapter lookup", async () => {
    const h = harness();
    const created = await h.shuttle.boardCreate({ name: "Frozen board" });
    const id = created.board.id;
    h.shuttle.boardUpdate({ id, archived: true });

    const before = h.runner.calls.length;
    await expect(h.shuttle.boardAdd({ id, prs: [KEY(99)] })).rejects.toThrow(/archived/i);
    expect(h.runner.calls).toHaveLength(before);
  });

  it("removes saved canonical keys even after their server is removed from config", async () => {
    const h = harness();
    h.views[1] = pr(1, { author: "dana" });
    const created = await h.shuttle.boardCreate({ name: "Legacy board", prs: [KEY(1)] });
    const id = created.board.id;

    h.store.saveConfig(testConfig({ servers: [] as never }));
    expect(h.shuttle.boardRemove({ id, prs: [KEY(1)] })).toEqual({ board: expect.any(Object), removed: [KEY(1)] });
    expect(h.shuttle.board(id).prs).toEqual([]);
  });

  it("rechecks archived state after async lookups before writing membership", async () => {
    const clock = { now: Date.parse("2026-10-23T12:00:00Z") };
    const db = memoryDb();
    const store = new Store(db, () => clock.now);
    store.saveConfig(testConfig());
    const port = new FakePort();
    const settings = { ...DEFAULT_SETTINGS };
    let shuttle!: Shuttle;
    let boardId = "";
    let archived = false;
    const runner = async (_bin: string, _args: readonly string[], options: { env?: Record<string, string> }) => {
      const env = options.env ?? {};
      if (env.SHUTTLE_OPERATION === "whoami") return { code: 0, stdout: JSON.stringify({ login: "me" }), stderr: "", timedOut: false };
      if (env.SHUTTLE_OPERATION === "view") {
        if (!archived && boardId) {
          archived = true;
          await shuttle.boardUpdate({ id: boardId, archived: true });
        }
        return { code: 0, stdout: JSON.stringify(pr(Number(env.SHUTTLE_NUMBER), { author: "dana" })), stderr: "", timedOut: false };
      }
      return { code: 0, stdout: "[]", stderr: "", timedOut: false };
    };
    shuttle = new Shuttle({ store, port, now: () => clock.now, settings: () => settings, runner });

    const created = await shuttle.boardCreate({ name: "Worker handoff" });
    boardId = created.board.id;

    await expect(shuttle.boardAdd({ id: boardId, prs: [KEY(2)] })).rejects.toThrow(/archived/i);
    const detail = shuttle.board(boardId);
    expect(detail.board.archivedAt).not.toBeNull();
    expect(detail.prs).toEqual([]);
  });

  it("filters boards by member key beyond preview, keeps previews capped, bounds activity, and refreshes board-only PRs", async () => {
    const h = harness();
    h.views[1] = pr(1, { author: "dana" });
    h.views[2] = pr(2, { author: "dana" });
    h.views[3] = pr(3, { author: "me", review: "approved" });
    h.views[4] = pr(4, { author: "dana" });

    const created = await h.shuttle.boardCreate({ name: "Release board", prs: [KEY(1), KEY(2), KEY(3), KEY(4)] });
    const id = created.board.id;

    expect(created.board.preview.map((pr: { key: string }) => pr.key)).toEqual([KEY(1), KEY(2), KEY(3)]);
    const before = h.runner.calls.filter((call) => call.operation === "view").length;
    expect(h.shuttle.boards({ archived: "include", key: KEY(4) })).toMatchObject({ boards: [{ id }] });
    expect(h.runner.calls.filter((call) => call.operation === "view")).toHaveLength(before);

    h.views[4] = pr(4, { author: "dana", state: "merged", review: "approved" });
    await h.shuttle.sync();
    expect(h.shuttle.board(id).prs.find((pr: { key: string }) => pr.key === KEY(4))?.state).toBe("merged");

    h.shuttle.boardUpdate({ id, archived: true });
    h.views[2] = pr(2, { author: "dana", state: "closed" });
    await h.shuttle.sync();
    expect(h.shuttle.board(id).prs.find((pr: { key: string }) => pr.key === KEY(2))?.state).toBe("open");
    await h.shuttle.refreshStale([KEY(2)], 0);
    expect(h.shuttle.board(id).prs.find((pr: { key: string }) => pr.key === KEY(2))?.state).toBe("closed");
    expect(h.shuttle.board(id).board.archivedAt).not.toBeNull();

    for (let i = 0; i < 60; i++) h.shuttle.boardUpdate({ id, description: `Run ${i}` });
    const activity = h.shuttle.board(id).activity;
    expect(activity).toHaveLength(50);
    expect(activity[0]?.text).toMatch(/updated/i);
  });
});
