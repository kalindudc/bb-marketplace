// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapters";
import { prSummarySchema, toSummary } from "../src/model";
import { FastLane } from "../src/fast-lane";
import { pollWatches } from "../src/watch";
import { harness, pr, testConfig, TEST_SERVER } from "./helpers";

const WRITE_SERVER = { ...TEST_SERVER, enabled: true, sep: "#" as const, commands: { ...TEST_SERVER.commands, merge: "mg", merge_options: "mo" } };
const NO_AUTO = { enabled: false, when: ["requested" as const], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "never" as const };
const KEY = (n: number) => `forge:acme/app#${n}`;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SQUASH = { method: "squash" as const, head: "h1", auto: false, deleteBranch: false };

const mine = (n: number, extra: Record<string, unknown> = {}) => pr(n, { author: "me", review: "approved", head: "h1", ...extra });
const summary = (raw: Record<string, unknown>) => toSummary(prSummarySchema.parse(raw));

async function synced(authored: unknown[], others: unknown[] = []) {
  const h = harness(testConfig({ servers: [WRITE_SERVER] as never, autoReview: NO_AUTO }));
  h.answers.merge = "";
  h.lists.authored = authored;
  h.lists.review_requested = others;
  await h.shuttle.sync();
  return h;
}

/** One tick, and the fast-lane reads it started. */
async function tick(h: ReturnType<typeof harness>) {
  await h.shuttle.tick();
  await h.shuttle.fastLaneSettled();
}

const views = (h: ReturnType<typeof harness>) => h.runner.calls.filter((call) => call.operation === "view").map((call) => Number(call.env.SHUTTLE_NUMBER));

describe("a stale snapshot", () => {
  it("never moves a merged or closed PR back to open with an older answer, but lets a reopen through", async () => {
    const h = await synced([]);
    const merged = h.store.upsertPr("forge", summary(mine(1, { state: "merged", closed_at: "2026-10-23T11:59:00Z", updated_at: "2026-10-23T11:59:00Z" })), "u", true);
    expect(merged).toMatchObject({ state: "merged", closed_at: Date.parse("2026-10-23T11:59:00Z") });
    const stale = h.store.upsertPr("forge", summary(mine(1, { state: "open", updated_at: "2026-10-23T10:00:00Z", title: "Older" })), "u", true);
    expect(stale).toMatchObject({ state: "merged", closed_at: Date.parse("2026-10-23T11:59:00Z"), updated_at: Date.parse("2026-10-23T11:59:00Z"), title: "Older" });
    const reopened = h.store.upsertPr("forge", summary(mine(1, { state: "open", updated_at: "2026-10-23T12:05:00Z" })), "u", true);
    expect(reopened).toMatchObject({ state: "open", closed_at: null });
    // Without a time on either side there is nothing to compare, so the server's answer stands.
    h.store.upsertPr("forge", summary(mine(2, { state: "closed", updated_at: "2026-10-23T11:59:00Z" })), "u", true);
    expect(h.store.upsertPr("forge", summary(mine(2, { state: "open", updated_at: null })), "u", true).state).toBe("open");
  });

  it("keeps a merge that landed while a sync's list read was on its way", async () => {
    const h = await synced([mine(1)]);
    const adapter = h.shuttle.adapter("forge");
    const real = adapter.list.bind(adapter);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let read!: () => void;
    const wasRead = new Promise<void>((resolve) => (read = resolve));
    adapter.list = async (operation, options, signal) => {
      const out = await real(operation, options, signal);
      if (operation === "authored" && options.state !== "closed") {
        read();
        await held;
      }
      return out;
    };
    h.clock.now += 4 * MINUTE;
    const sync = h.shuttle.sync();
    await wasRead;
    // The list said open; the merge lands, and the server's own read after it says merged.
    let mergedYet = false;
    const realMerge = adapter.merge.bind(adapter);
    adapter.merge = async (...args) => {
      const out = await realMerge(...args);
      mergedYet = true;
      return out;
    };
    Object.defineProperty(h.views, 1, { configurable: true, get: () => mine(1, mergedYet ? { state: "merged", updated_at: "2026-10-23T12:03:00Z", closed_at: "2026-10-23T12:03:00Z" } : {}) });
    h.shuttle.queueMerge(KEY(1), SQUASH);
    await h.shuttle.mergesSettled();
    expect(h.store.prByKey(KEY(1))!.state).toBe("merged");
    release();
    await sync;
    expect(h.shuttle.view(KEY(1))).toMatchObject({ state: "merged", next: { kind: "merged" } });
  });
});

describe("the merge queue on the server", () => {
  it("shows your PR that waits in the server's merge queue, and says Shuttle added it there", async () => {
    const h = await synced([mine(1)]);
    let merged = false;
    const adapter = h.shuttle.adapter("forge");
    const real = adapter.merge.bind(adapter);
    adapter.merge = async (...args) => {
      const out = await real(...args);
      merged = true;
      return out;
    };
    Object.defineProperty(h.views, 1, { configurable: true, get: () => mine(1, merged ? { in_merge_queue: true, auto_merge: true, updated_at: "2026-10-23T12:00:30Z" } : {}) });
    h.shuttle.queueMerge(KEY(1), SQUASH);
    await h.shuttle.mergesSettled();
    expect(h.shuttle.merges()[0]).toMatchObject({ state: "done", outcome: "sent" });
    expect(h.shuttle.view(KEY(1))).toMatchObject({ state: "open", inMergeQueue: true, next: { kind: "in_merge_queue", label: "In the merge queue", inbox: false } });
    const texts = h.shuttle.activity(5).map((e) => e.text);
    expect(texts).toContain("Added acme/app#1 to the merge queue on Forge.");
    expect(texts.some((text) => text.includes("may be waiting"))).toBe(false);
  });

  it("keeps the merge queue from a list until a read says otherwise", async () => {
    const h = await synced([mine(1, { in_merge_queue: true })]);
    expect(h.store.prByKey(KEY(1))!.in_merge_queue).toBe(1);
    h.lists.authored = [mine(1)];
    h.clock.now += 4 * MINUTE;
    await h.shuttle.sync();
    expect(h.store.prByKey(KEY(1))!.in_merge_queue).toBe(1);
    h.lists.authored = [mine(1, { in_merge_queue: false })];
    h.clock.now += 4 * MINUTE;
    await h.shuttle.sync();
    expect(h.shuttle.view(KEY(1))).toMatchObject({ inMergeQueue: false, next: { kind: "ready_to_merge" } });
  });
});

describe("the fast lane", () => {
  it("reads your PRs with a merge pending on each tick between syncs, without a sync", async () => {
    const h = await synced([mine(1, { auto_merge: true }), mine(2), mine(3, { in_merge_queue: true }), mine(5, { state: "merged", auto_merge: true })], [pr(4, { auto_merge: true })]);
    h.views[1] = mine(1, { state: "merged", auto_merge: true, updated_at: "2026-10-23T12:00:20Z", closed_at: "2026-10-23T12:00:20Z" });
    h.views[3] = mine(3, { in_merge_queue: true });
    const before = h.runner.calls.length;
    const fullSync = h.store.kv("full_sync_at");
    const publishes = h.port.publishes;
    h.clock.now += MINUTE;
    await tick(h);
    expect(views(h).sort()).toEqual([1, 3]);
    expect(h.runner.calls.slice(before).map((call) => call.operation).sort()).toEqual(["view", "view"]);
    expect(h.store.kv("full_sync_at")).toBe(fullSync);
    expect(h.shuttle.view(KEY(1))).toMatchObject({ state: "merged", next: { kind: "merged" } });
    expect(h.port.publishes).toBe(publishes + 1);

    // Nothing changed on the next tick: nothing to publish, and PR 1 has nothing pending any more.
    const again = h.port.publishes;
    h.clock.now += MINUTE / 2;
    await tick(h);
    expect(views(h).sort()).toEqual([1, 3, 3]);
    expect(h.port.publishes).toBe(again);
  });

  it("reads at most three PRs a tick from a command server, the least recently read first", async () => {
    const h = await synced([1, 2, 3, 4, 5].map((n) => mine(n, { auto_merge: true })));
    for (const n of [1, 2, 3, 4, 5]) h.views[n] = mine(n, { auto_merge: true });
    h.clock.now += MINUTE;
    await tick(h);
    expect(views(h)).toEqual([1, 2, 3]);
    h.clock.now += MINUTE / 2;
    await tick(h);
    expect(views(h)).toEqual([1, 2, 3, 4, 5, 1]);
  });

  it("follows Shuttle's own merges, and one the server took in the last day while the PR stays open", async () => {
    const h = await synced([mine(1), mine(2), mine(3)]);
    const id = (n: number) => h.store.prByKey(KEY(n))!.id;
    const queued = h.store.addMerge({ pr_id: id(1), server: "forge", method: "squash", head: "h1", auto: 0, delete_branch: 0, subject: null });
    const sent = h.store.addMerge({ pr_id: id(2), server: "forge", method: "squash", head: "h1", auto: 0, delete_branch: 0, subject: null });
    h.store.finishMerge(sent.id, { state: "done", outcome: "sent" });
    const old = h.store.addMerge({ pr_id: id(3), server: "forge", method: "squash", head: "h1", auto: 0, delete_branch: 0, subject: null });
    h.clock.now -= 2 * DAY;
    h.store.finishMerge(old.id, { state: "done", outcome: "sent" });
    h.clock.now += 2 * DAY;
    for (const n of [1, 2, 3]) h.views[n] = mine(n);
    const lane = new FastLane(h.shuttle, { backOff: () => null, holdOff: () => {} });
    lane.start(() => false);
    await lane.settled();
    expect(views(h).sort()).toEqual([1, 2]);
    expect(queued.id).toBeGreaterThan(0);
  });

  it("reads a whole server at once where the adapter can, and keeps what it read when one PR fails", async () => {
    const h = await synced([1, 2, 3, 4, 5].map((n) => mine(n, { auto_merge: true })));
    const adapter = h.shuttle.adapter("forge") as Adapter;
    const asked: number[][] = [];
    adapter.viewMany = async (refs) => {
      asked.push(refs.map((ref) => ref.number));
      return refs.map((ref) => (ref.number === 2
        ? { repo: ref.repo, number: ref.number, summary: null, error: "not found" }
        : { repo: ref.repo, number: ref.number, summary: summary(mine(ref.number, { state: "merged", updated_at: "2026-10-23T12:00:10Z" })), error: null }));
    };
    h.clock.now += MINUTE;
    await tick(h);
    expect(asked).toEqual([[1, 2, 3, 4, 5]]);
    expect(views(h)).toEqual([]);
    expect([1, 2, 3, 4, 5].map((n) => h.store.prByKey(KEY(n))!.state)).toEqual(["merged", "open", "merged", "merged", "merged"]);
  });

  it("leaves a server alone while a sync of it runs, on every tick until that sync is done, and reads it again after", async () => {
    const h = await synced([mine(1, { auto_merge: true })]);
    h.views[1] = mine(1, { auto_merge: true });
    const held = h.hold("whoami");
    h.clock.now += MINUTE;
    const sync = h.shuttle.sync(undefined, ["forge"]);
    await held.reached;
    await tick(h);
    expect(views(h)).toEqual([]);
    // A tick due a full sync joins the server's sync under way, and its fast lane still leaves the server alone.
    h.clock.now += 4 * MINUTE;
    await tick(h);
    h.clock.now += MINUTE / 2;
    await tick(h);
    expect(views(h)).toEqual([]);
    held.release();
    await sync;
    await h.shuttle.syncsSettled();
    h.clock.now += MINUTE / 2;
    await tick(h);
    expect(views(h)).toEqual([1]);
  });
});

describe("watching learns merges and closes", () => {
  async function watched(n = 2) {
    const h = await synced(Array.from({ length: n }, (_, i) => mine(i + 1)));
    h.port.addThread("thr_owner", "Envoy work");
    for (let i = 1; i <= n; i++) await h.shuttle.link(KEY(i), "thr_owner");
    await pollWatches(h.shuttle, "forge");
    return h;
  }

  it("patches the PR's state from the activity read and publishes", async () => {
    const h = await watched();
    h.activity[1] = { items: [], state: "merged", closed_at: "2026-10-23T12:00:10Z", updated_at: "2026-10-23T12:00:10Z" };
    h.activity[2] = { items: [], state: "open", draft: true, updated_at: "2026-10-23T12:00:10Z" };
    const publishes = h.port.publishes;
    await pollWatches(h.shuttle, "forge");
    expect(h.store.prByKey(KEY(1))).toMatchObject({ state: "merged", closed_at: Date.parse("2026-10-23T12:00:10Z"), updated_at: Date.parse("2026-10-23T12:00:10Z") });
    expect(h.store.prByKey(KEY(2))!.state).toBe("draft");
    expect(h.port.publishes).toBeGreaterThan(publishes);
    const quiet = h.port.publishes;
    h.activity[2] = { items: [], state: "open", draft: true, updated_at: "2026-10-23T12:00:10Z" };
    await pollWatches(h.shuttle, "forge");
    expect(h.port.publishes).toBe(quiet);
  });

  it("reads three watched PRs at a time, and a PR that fails does not stop the others", async () => {
    const h = await watched(7);
    const adapter = h.shuttle.adapter("forge");
    const real = adapter.activity.bind(adapter);
    let running = 0;
    let most = 0;
    const read: number[] = [];
    adapter.activity = async (repo, number, signal, options) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      read.push(number);
      if (number === 4) throw new Error("timed out");
      return real(repo, number, signal, options);
    };
    await pollWatches(h.shuttle, "forge");
    expect(most).toBe(3);
    expect(read.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(h.store.watch(h.store.prByKey(KEY(4))!.id)!.error).toBe("timed out");
    expect(h.store.watch(h.store.prByKey(KEY(5))!.id)!.error).toBeNull();
  });
});
