import { describe, expect, it, vi } from "vitest";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { CollectDeps } from "../src/collect";
import { collectAll } from "../src/collect-all";
import { environment } from "./fixtures";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
type Thread = ReturnType<typeof makeThreadResponse>;

const thread = (id: string, overrides: Partial<Thread> = {}): Thread =>
  makeThreadResponse({ id, title: id, environmentId: null, updatedAt: NOW - HOUR, ...overrides });

function setup(active: Thread[], archived: Thread[] = []) {
  const list = vi.fn(async (args: { archived?: boolean; includeHidden?: boolean; limit?: number; offset?: number }) => {
    const source = args.archived === true ? archived : active;
    return source.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100));
  });
  const get = vi.fn(async ({ environmentId }: { environmentId: string }) => environment({ id: environmentId }));
  const sdk = { threads: { list }, environments: { get } } as unknown as PluginBbSdk;
  return { deps: { sdk } as CollectDeps, list, get };
}

const run = (deps: CollectDeps, options: { windowHours?: number; maxThreads?: number; includeArchived?: boolean } = {}) =>
  collectAll(deps, { windowHours: 24, maxThreads: 200, now: NOW, includeArchived: true, ...options });

describe("collectAll", () => {
  it("pages the active threads and then the archived ones, hidden threads included", async () => {
    const active = Array.from({ length: 250 }, (_, index) => thread(`a${index}`));
    const { deps, list } = setup(active, [thread("old", { archivedAt: NOW - HOUR })]);
    const { threads } = await run(deps, { maxThreads: 500 });
    expect(list.mock.calls.map(([args]) => [args.archived, args.offset, args.limit, args.includeHidden])).toEqual([
      [false, 0, 100, true], [false, 100, 100, true], [false, 200, 100, true], [true, 0, 100, true],
    ]);
    expect(threads).toHaveLength(251);
  });

  it("scans at most 1,000 active and 500 archived threads", async () => {
    const full = (prefix: string, count: number, extra: Partial<Thread> = {}) =>
      Array.from({ length: count }, (_, index) => thread(`${prefix}${index}`, extra));
    const { deps, list } = setup(full("a", 1200), full("z", 700, { archivedAt: NOW - HOUR }));
    await run(deps, { maxThreads: 500 });
    const offsets = (archived: boolean) => list.mock.calls.filter(([args]) => args.archived === archived).map(([args]) => args.offset);
    expect(offsets(false)).toHaveLength(10);
    expect(offsets(true)).toHaveLength(5);
  });

  it("drops idle threads older than the window and keeps a running old thread", async () => {
    const { deps } = setup([
      thread("fresh", { updatedAt: NOW - 2 * HOUR }),
      thread("stale", { updatedAt: NOW - 30 * HOUR }),
      thread("running", { updatedAt: NOW - 30 * HOUR, status: "active" }),
      thread("starting", { updatedAt: NOW - 30 * HOUR, status: "starting" }),
      thread("pending", { updatedAt: NOW - 30 * HOUR, status: "pending" }),
      thread("failed", { updatedAt: NOW - 30 * HOUR, status: "error" }),
    ]);
    const { threads } = await run(deps);
    expect(threads.map((entry) => entry.id).sort()).toEqual(["fresh", "pending", "running", "starting"]);
  });

  it("keeps an archived thread only when it was archived inside the window", async () => {
    const { deps } = setup([], [
      thread("recent", { archivedAt: NOW - 3 * HOUR, updatedAt: NOW - 3 * HOUR }),
      thread("long-gone", { archivedAt: NOW - 40 * HOUR, updatedAt: NOW - 1 * HOUR }),
    ]);
    const { threads } = await run(deps);
    expect(threads.map((entry) => [entry.id, entry.archived])).toEqual([["recent", true]]);
  });

  it("lists the newest thread first and reports a truncated list at maxThreads", async () => {
    const { deps } = setup([
      thread("b", { updatedAt: NOW - 3 * HOUR }), thread("a", { updatedAt: NOW - 1 * HOUR }), thread("c", { updatedAt: NOW - 5 * HOUR }),
    ]);
    const all = await run(deps);
    expect(all.threads.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(all.truncated).toBe(false);
    const capped = await run(deps, { maxThreads: 2 });
    expect(capped.threads.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(capped.truncated).toBe(true);
  });

  it("gives a child of a kept thread depth 1 and its root, and makes a child of a dropped parent a root", async () => {
    const { deps } = setup([
      thread("root", { updatedAt: NOW - 1 * HOUR }),
      thread("child", { parentThreadId: "root", updatedAt: NOW - 2 * HOUR }),
      thread("grandchild", { parentThreadId: "child", updatedAt: NOW - 3 * HOUR }),
      thread("old-parent", { updatedAt: NOW - 90 * HOUR }),
      thread("orphan", { parentThreadId: "old-parent", updatedAt: NOW - 4 * HOUR }),
    ]);
    const { threads } = await run(deps);
    const summary = (id: string) => threads.find((entry) => entry.id === id)!;
    expect(summary("root")).toMatchObject({ depth: 0, rootThreadId: "root", parentThreadId: null });
    expect(summary("child")).toMatchObject({ depth: 1, rootThreadId: "root", parentThreadId: "root" });
    expect(summary("grandchild")).toMatchObject({ depth: 2, rootThreadId: "root" });
    expect(summary("orphan")).toMatchObject({ depth: 0, rootThreadId: "orphan", parentThreadId: "old-parent" });
  });

  it("does not loop on a parent cycle", async () => {
    const { deps } = setup([thread("x", { parentThreadId: "y" }), thread("y", { parentThreadId: "x" })]);
    const { threads } = await run(deps);
    expect(threads.map((entry) => entry.id).sort()).toEqual(["x", "y"]);
    for (const entry of threads) expect(entry.depth).toBeGreaterThanOrEqual(0);
  });

  it("summarises a thread like collectTree: fallback title, status and environment", async () => {
    const { deps } = setup([thread("t", { title: null, titleFallback: "Fallback", status: "active", environmentId: "env_1" })]);
    const { threads } = await run(deps);
    expect(threads).toEqual([{
      id: "t", title: "Fallback", parentThreadId: null, archived: false, depth: 0, environmentId: "env_1", status: "active", rootThreadId: "t",
    }]);
  });

  it("fetches each distinct environment once and skips one that cannot be read", async () => {
    const { deps, get } = setup([
      thread("a", { environmentId: "env_1" }), thread("b", { environmentId: "env_1" }), thread("c", { environmentId: "env_gone" }),
    ]);
    get.mockImplementation(async ({ environmentId }) => {
      if (environmentId === "env_gone") throw new Error("gone");
      return environment({ id: environmentId });
    });
    const { environments } = await run(deps);
    expect([...environments.keys()]).toEqual(["env_1"]);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("collectAll with archived threads hidden", () => {
  const archivedThread = (id: string, hoursAgo = 3) =>
    thread(id, { archivedAt: NOW - hoursAgo * HOUR, updatedAt: NOW - hoursAgo * HOUR, environmentId: `env_${id}` });
  const withArchived = () => setup(
    [thread("live", { environmentId: "env_live" })],
    [archivedThread("a1"), archivedThread("a2"), archivedThread("gone", 40)],
  );

  it("counts the archived threads inside the window and keeps none of them", async () => {
    const { deps } = withArchived();
    const { threads, archivedHidden } = await run(deps, { includeArchived: false });
    expect(threads.map((entry) => entry.id)).toEqual(["live"]);
    expect(archivedHidden).toBe(2);
  });

  it("keeps the archived threads when they are asked for, and hides none", async () => {
    const { deps } = withArchived();
    const { threads, archivedHidden } = await run(deps, { includeArchived: true });
    expect(threads.map((entry) => entry.id).sort()).toEqual(["a1", "a2", "live"]);
    expect(archivedHidden).toBe(0);
  });

  it("still pages the archived list, because that is how it counts them", async () => {
    const { deps, list } = withArchived();
    await run(deps, { includeArchived: false });
    expect(list.mock.calls.map(([args]) => args.archived)).toEqual([false, true]);
  });

  it("loads no environment for a hidden thread", async () => {
    const { deps, get } = withArchived();
    const { environments } = await run(deps, { includeArchived: false });
    expect(get.mock.calls.map(([args]) => args.environmentId)).toEqual(["env_live"]);
    expect([...environments.keys()]).toEqual(["env_live"]);
  });

  it("does not let hidden threads use up the thread limit", async () => {
    const { deps } = setup([thread("live")], [archivedThread("a1"), archivedThread("a2")]);
    const { threads, truncated } = await run(deps, { includeArchived: false, maxThreads: 1 });
    expect(threads.map((entry) => entry.id)).toEqual(["live"]);
    expect(truncated).toBe(false);
  });
});

