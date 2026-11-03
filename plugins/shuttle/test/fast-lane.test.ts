// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { RunOptions, RunResult } from "../src/adapters/exec";
import { GithubAdapter } from "../src/adapters/github";
import { harness, pr, testConfig, type Harness } from "./helpers";

const NO_AUTO = { enabled: false, when: ["requested" as const], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "never" as const };
const MINUTE = 60_000;
const RATE_LIMIT = "HTTP 429: too many requests";

const mine = (n: number, extra: Record<string, unknown> = {}) => pr(n, { author: "me", review: "approved", head: "h1", ...extra });
const views = (h: Harness) => h.runner.calls.filter((call) => call.operation === "view").map((call) => Number(call.env.SHUTTLE_NUMBER));
const laneLogs = (h: Harness) => h.port.logs.filter((line) => line.startsWith("fast lane"));
const settled = (promise: Promise<unknown>) => {
  const box = { done: false };
  void promise.then(() => (box.done = true), () => (box.done = true));
  return box;
};

async function synced(authored: unknown[]) {
  const h = harness(testConfig({ autoReview: NO_AUTO }));
  h.lists.authored = authored;
  await h.shuttle.sync();
  return h;
}

/** One tick, and the fast-lane reads it started. */
async function tick(h: Harness) {
  await h.shuttle.tick();
  await h.shuttle.fastLaneSettled();
}

describe("the fast lane holds up nothing", () => {
  it("lets the tick deliver and start a sync while a command server is slow to answer a view, and never reads a server twice at once", async () => {
    const h = await synced([mine(1, { auto_merge: true })]);
    h.views[1] = mine(1, { auto_merge: true });
    const deliver = vi.spyOn(h.shuttle, "deliver");
    const slow = h.hold("view");
    h.clock.now += MINUTE;
    const first = settled(h.shuttle.tick());
    await slow.reached;
    await vi.waitFor(() => expect(first.done).toBe(true));
    expect(deliver).toHaveBeenCalledTimes(1);

    // The next tick skips the server whose read still runs; a due sync starts anyway.
    h.clock.now += h.settings.syncMinutes * MINUTE;
    await h.shuttle.tick();
    expect(h.shuttle.syncingServer("forge")).toBe(true);
    expect(views(h)).toEqual([1]);
    await h.shuttle.syncsSettled();
    slow.release();
    await h.shuttle.fastLaneSettled();
    expect(deliver).toHaveBeenCalledTimes(3);
  });
});

describe("the fast lane on a command server", () => {
  it("takes turns by the last read it tried, so PRs whose reads fail do not take every tick, and logs each failure once", async () => {
    const h = await synced([1, 2, 3, 4].map((n) => mine(n, { auto_merge: true })));
    h.views[4] = mine(4, { auto_merge: true });
    h.clock.now += MINUTE;
    await tick(h);
    expect(views(h)).toEqual([1, 2, 3]);
    h.clock.now += MINUTE / 2;
    await tick(h);
    expect(views(h)).toEqual([1, 2, 3, 4, 1, 2]);
    // A failed read is not a read: the PR keeps its old copy's time.
    expect(h.store.prByKey("forge:acme/app#1")!.fetched_at).toBeLessThan(h.clock.now - MINUTE);
    expect(laneLogs(h)).toHaveLength(3);
  });
});

describe("the fast lane backs off", () => {
  it("asks nothing of a server whose sync hit a rate limit, until its next sync passes", async () => {
    const h = await synced([mine(1, { auto_merge: true })]);
    h.views[1] = mine(1, { auto_merge: true });
    h.lists.team_requested = new Error(RATE_LIMIT) as unknown as unknown[];
    h.clock.now += h.settings.syncMinutes * MINUTE;
    await h.shuttle.sync();
    expect(h.store.server("forge")!.state).toBe("partial");
    for (let i = 0; i < 3; i++) {
      h.clock.now += MINUTE / 2;
      await tick(h);
    }
    expect(views(h)).toEqual([]);
    h.lists.team_requested = [];
    h.clock.now += h.settings.syncMinutes * MINUTE;
    await tick(h);
    await h.shuttle.syncsSettled();
    h.clock.now += MINUTE / 2;
    await tick(h);
    expect(views(h)).toEqual([1]);
  });

  it("asks nothing more of a server after a read of its own hits a rate limit or finds it down, and logs that once", async () => {
    for (const failure of [RATE_LIMIT, "view took longer than 60s"]) {
      const h = await synced([1, 2, 3, 4].map((n) => mine(n, { auto_merge: true })));
      for (const n of [2, 3, 4]) h.views[n] = mine(n, { auto_merge: true });
      h.views[1] = new Error(failure);
      h.clock.now += MINUTE;
      await tick(h);
      expect(views(h)).toEqual([1]);
      for (let i = 0; i < 3; i++) {
        h.clock.now += MINUTE / 2;
        await tick(h);
      }
      expect(views(h)).toEqual([1]);
      expect(laneLogs(h)).toHaveLength(1);
      expect(h.runner.calls.filter((call) => call.operation === "whoami")).toHaveLength(1);
      // The next sync passes, and the fast lane picks up where it stopped.
      h.views[1] = mine(1, { auto_merge: true });
      h.clock.now += h.settings.syncMinutes * MINUTE;
      await tick(h);
      await h.shuttle.syncsSettled();
      h.clock.now += MINUTE / 2;
      await tick(h);
      expect(views(h)).toHaveLength(4);
    }
  });
});

describe("one back-off for the fast lane and the sync", () => {
  it("puts off the recheck of a server whose fast-lane read hit a rate limit", async () => {
    const h = await synced([mine(1, { auto_merge: true })]);
    h.lists.review_requested = new Error("HTTP 503: service unavailable") as unknown as unknown[];
    h.clock.now += h.settings.syncMinutes * MINUTE;
    await tick(h);
    await h.shuttle.syncsSettled();
    const failedAt = h.store.server("forge")!.last_sync_at!;
    expect(h.shuttle.overview().servers[0]).toMatchObject({ state: "partial", failures: 1, nextSyncAt: failedAt + 60_000 });
    h.views[1] = new Error(RATE_LIMIT);
    h.clock.now += MINUTE / 2;
    await tick(h);
    expect(views(h)).toEqual([1]);
    const whoami = h.runner.calls.filter((call) => call.operation === "whoami").length;
    h.clock.now = failedAt + 60_000;
    await tick(h);
    await h.shuttle.syncsSettled();
    expect(h.runner.calls.filter((call) => call.operation === "whoami")).toHaveLength(whoami);
  });
});

describe("GitHub's batched read", () => {
  it("sends no more batches once GitHub says it is limiting Shuttle", async () => {
    const calls: string[][] = [];
    const run = async (_bin: string, args: readonly string[], _options: RunOptions): Promise<RunResult> => {
      calls.push([...args]);
      return { code: 1, stdout: "", stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)", timedOut: false };
    };
    const gh = new GithubAdapter({ id: "github", name: "GitHub", kind: "github", enabled: true, sep: "#", commands: {} }, run);
    const out = await gh.viewMany(Array.from({ length: 23 }, (_, i) => ({ repo: "acme/api", number: i + 1 })));
    expect(calls).toHaveLength(1);
    expect(out).toHaveLength(23);
    expect(out.every((row) => row.summary === null && /rate limit/u.test(row.error ?? ""))).toBe(true);
  });
});

describe("auto-merge and the merge queue", () => {
  it("are read on every tick for their first hour pending, then at most every five minutes; Shuttle's own merges stay on every tick", async () => {
    const h = await synced([mine(1, { auto_merge: true }), mine(2)]);
    h.settings.syncMinutes = 24 * 60;
    h.views[1] = mine(1, { auto_merge: true });
    h.views[2] = mine(2);
    const sent = h.store.addMerge({ pr_id: h.store.prByKey("forge:acme/app#2")!.id, server: "forge", method: "squash", head: "h1", auto: 0, delete_branch: 0, subject: null });
    h.store.finishMerge(sent.id, { state: "done", outcome: "sent" });
    const read = () => {
      const all = views(h);
      h.runner.calls.length = 0;
      return all.sort();
    };
    h.clock.now += MINUTE;
    await tick(h);
    expect(read()).toEqual([1, 2]);
    h.clock.now += MINUTE / 2;
    await tick(h);
    expect(read()).toEqual([1, 2]);
    // An hour after the fast lane found it pending, the auto-merge PR is read once every five minutes.
    h.clock.now += 60 * MINUTE;
    await tick(h);
    expect(read()).toEqual([1, 2]);
    for (let i = 0; i < 9; i++) {
      h.clock.now += MINUTE / 2;
      await tick(h);
    }
    expect(read()).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2]);
    h.clock.now += MINUTE / 2;
    await tick(h);
    expect(read()).toEqual([1, 2]);
  });
});

describe("the fast lane after a sync moved on", () => {
  it("does not undo a newer reopen with an older answer that was still on its way", async () => {
    const h = await synced([mine(1, { auto_merge: true })]);
    const slow = h.hold("view");
    h.clock.now += MINUTE;
    await h.shuttle.tick();
    await slow.reached;
    // Meanwhile the PR was closed and reopened, and a sync stored the newer open copy.
    h.lists.authored = [mine(1, { auto_merge: true, updated_at: "2026-10-23T10:00:20Z" })];
    await h.shuttle.sync();
    h.views[1] = mine(1, { auto_merge: true, state: "closed", updated_at: "2026-10-23T10:00:10Z" });
    slow.release();
    await h.shuttle.fastLaneSettled();
    expect(h.shuttle.view("forge:acme/app#1")).toMatchObject({ state: "open", updatedAt: Date.parse("2026-10-23T10:00:20Z") });
  });

  it("sends nothing more once a sync backs the server off during its pass", async () => {
    const h = await synced([1, 2, 3].map((n) => mine(n, { auto_merge: true })));
    for (const n of [1, 2, 3]) h.views[n] = mine(n, { auto_merge: true });
    const slow = h.hold("view");
    h.clock.now += MINUTE;
    await h.shuttle.tick();
    await slow.reached;
    h.lists.team_requested = new Error(RATE_LIMIT) as unknown as unknown[];
    await h.shuttle.sync();
    expect(h.store.server("forge")!.state).toBe("partial");
    slow.release();
    await h.shuttle.fastLaneSettled();
    expect(views(h)).toEqual([1]);
  });

  it("keeps the good answers of a batch in which one PR's answer backs the server off", async () => {
    const h = await synced([mine(1, { auto_merge: true }), mine(2, { auto_merge: true })]);
    const adapter = h.shuttle.adapter("forge");
    h.views[2] = mine(2, { state: "merged", updated_at: "2026-10-23T11:00:00Z" });
    const merged = await adapter.view("acme/app", 2);
    let asked = 0;
    adapter.viewMany = async (refs) => {
      asked += 1;
      return refs.map((ref) => (ref.number === 1 ? { ...ref, summary: null, error: RATE_LIMIT } : { ...ref, summary: merged, error: null }));
    };
    h.clock.now += MINUTE;
    await tick(h);
    expect(h.shuttle.view("forge:acme/app#2").state).toBe("merged");
    expect(laneLogs(h)).toHaveLength(1);
    h.clock.now += MINUTE / 2;
    await tick(h);
    expect(asked).toBe(1);
  });
});

describe("the fast lane and a sync that came through", () => {
  it("does not hold off a server for a read that failed after a clean sync asked it again, whichever finished first", async () => {
    for (const order of ["sync first", "read first"] as const) {
      const h = await synced([mine(1, { auto_merge: true })]);
      const slow = h.hold("view");
      h.clock.now += MINUTE;
      await h.shuttle.tick();
      await slow.reached;
      h.views[1] = new Error(RATE_LIMIT);
      h.clock.now += 1000;
      if (order === "sync first") {
        await h.shuttle.sync();
        slow.release();
        await h.shuttle.fastLaneSettled();
      } else {
        const sync = h.shuttle.sync();
        slow.release();
        await h.shuttle.fastLaneSettled();
        await sync;
      }
      h.views[1] = mine(1, { auto_merge: true });
      h.clock.now += MINUTE / 2;
      await tick(h);
      expect(views(h)).toEqual([1, 1]);
    }
  });
});
