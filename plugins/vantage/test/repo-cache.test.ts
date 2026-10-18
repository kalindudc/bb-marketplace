import { describe, expect, it, vi } from "vitest";
import type { RepoPlan } from "../src/collect";
import { createRepoCache, isDeltaOnly, planCached } from "../src/repo-cache";

const meta = (threadIds: string[] = ["thr_1"], environmentId: string | null = "env_1") => ({ threadIds, environmentId });

function setup(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let now = 1_000;
  const cache = createRepoCache({ ...options, now: () => now });
  return { cache, advance: (ms: number) => { now += ms; } };
}

describe("createRepoCache", () => {
  it("serves a fresh entry without loading again", async () => {
    const { cache } = setup();
    const load = vi.fn(async () => "first");
    expect(await cache.get("k", meta(), load)).toBe("first");
    expect(await cache.get("k", meta(), load)).toBe("first");
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(1);
  });

  it("loads again once the entry is older than the time to live", async () => {
    const { cache, advance } = setup({ ttlMs: 60_000 });
    const load = vi.fn(async () => "value");
    await cache.get("k", meta(), load);
    advance(59_999);
    await cache.get("k", meta(), load);
    expect(load).toHaveBeenCalledTimes(1);
    advance(1);
    await cache.get("k", meta(), load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("counts the time to live from when a slow load finished", async () => {
    const { cache, advance } = setup({ ttlMs: 60_000 });
    const load = vi.fn(async () => { advance(50_000); return "slow"; });
    await cache.get("k", meta(), load);
    advance(30_000);
    await cache.get("k", meta(), load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps an entry for the time to live its value asks for instead of the default", async () => {
    const { cache, advance } = setup({ ttlMs: 60_000 });
    const load = vi.fn(async () => "gone");
    const longer = (value: string) => (value === "gone" ? 600_000 : undefined);
    await cache.get("k", meta(), load, longer);
    advance(599_999);
    await cache.get("k", meta(), load, longer);
    expect(load).toHaveBeenCalledTimes(1);
    advance(1);
    await cache.get("k", meta(), load, longer);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("uses the default time to live when the value asks for none", async () => {
    const { cache, advance } = setup({ ttlMs: 60_000 });
    const load = vi.fn(async () => "present");
    const longer = (value: string) => (value === "gone" ? 600_000 : undefined);
    await cache.get("k", meta(), load, longer);
    advance(60_000);
    await cache.get("k", meta(), load, longer);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one load between concurrent requests for a key", async () => {
    const { cache } = setup();
    let release: (value: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const first = cache.get("k", meta(), load);
    const second = cache.get("k", meta(), load);
    release("shared");
    expect(await Promise.all([first, second])).toEqual(["shared", "shared"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejection, and a later request loads again", async () => {
    const { cache } = setup();
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok");
    await expect(cache.get("k", meta(), load)).rejects.toThrow("boom");
    expect(cache.size()).toBe(0);
    expect(await cache.get("k", meta(), load)).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a load that throws before it returns a promise", async () => {
    const { cache } = setup();
    const load = vi.fn<() => Promise<string>>(() => { throw new Error("sync"); });
    await expect(cache.get("k", meta(), load)).rejects.toThrow("sync");
    expect(cache.size()).toBe(0);
  });

  it("drops only the entries of the threads named", async () => {
    const { cache } = setup();
    for (const [key, ids] of [["a", ["thr_1", "thr_2"]], ["b", ["thr_3"]], ["c", ["thr_2"]]] as const) {
      await cache.get(key, meta([...ids], null), async () => key);
    }
    cache.invalidateThreads(["thr_2", "thr_unknown"]);
    expect(cache.size()).toBe(1);
    const load = vi.fn(async () => "again");
    await cache.get("b", meta(["thr_3"], null), load);
    expect(load).not.toHaveBeenCalled();
    await cache.get("a", meta(["thr_1", "thr_2"], null), load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("drops only the entries of the environment named", async () => {
    const { cache } = setup();
    await cache.get("a", meta(["thr_1"], "env_1"), async () => "a");
    await cache.get("b", meta(["thr_2"], "env_2"), async () => "b");
    await cache.get("c", meta(["thr_3"], null), async () => "c");
    cache.invalidateEnvironment("env_1");
    expect(cache.size()).toBe(2);
    cache.invalidateEnvironment("env_missing");
    expect(cache.size()).toBe(2);
  });

  it("does not store a load that an invalidation overtook", async () => {
    const { cache } = setup();
    let release: (value: string) => void = () => {};
    const slow = cache.get("k", meta(), () => new Promise<string>((resolve) => { release = resolve; }));
    cache.invalidateThreads(["thr_1"]);
    release("stale");
    expect(await slow).toBe("stale");
    const load = vi.fn(async () => "fresh");
    expect(await cache.get("k", meta(), load)).toBe("fresh");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads again when a thread the entry did not know now belongs to the repository", async () => {
    const { cache } = setup();
    const load = vi.fn(async () => "value");
    await cache.get("k", meta(["thr_1"]), load);
    await cache.get("k", meta(["thr_1"]), load);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get("k", meta(["thr_1", "thr_new"]), load);
    expect(load).toHaveBeenCalledTimes(2);
    await cache.get("k", meta(["thr_1"]), load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("clears every entry", async () => {
    const { cache } = setup();
    await cache.get("a", meta(), async () => 1);
    await cache.get("b", meta(), async () => 2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("keeps at most maxEntries, dropping the oldest", async () => {
    const { cache } = setup({ maxEntries: 2 });
    for (const key of ["a", "b", "c"]) await cache.get(key, meta(), async () => key);
    expect(cache.size()).toBe(2);
    const load = vi.fn(async () => "x");
    await cache.get("b", meta(), load);
    await cache.get("c", meta(), load);
    expect(load).not.toHaveBeenCalled();
    await cache.get("a", meta(), load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("planCached", () => {
  const plan = (ref: RepoPlan["ref"], threadIds = ["thr_1"]): RepoPlan => ({
    key: "host_1:/work/one", ref, label: "Project", projectId: "proj_1", root: "/work/one", hostId: "host_1", threadIds, touched: new Map(),
  });

  it("keys an entry by repository and variant, and watches the workspace's environment", async () => {
    const { cache } = setup();
    const load = vi.fn(async () => "files");
    const workspace = plan({ kind: "workspace", environmentId: "env_1", base: null });
    await planCached(cache, workspace, "uncommitted", load);
    await planCached(cache, workspace, "uncommitted", load);
    await planCached(cache, workspace, "branch", load);
    expect(load).toHaveBeenCalledTimes(2);
    cache.invalidateEnvironment("env_1");
    expect(cache.size()).toBe(0);
  });

  it("does not cache a repository made from recorded edits, which differ for every request", async () => {
    const { cache } = setup();
    const load = vi.fn(async () => "files");
    await planCached(cache, plan({ kind: "recorded" }), "uncommitted", load);
    await planCached(cache, plan({ kind: "recorded" }), "uncommitted", load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(0);
  });

  it("loads straight through when there is no cache", async () => {
    const load = vi.fn(async () => "files");
    expect(await planCached(undefined, plan({ kind: "checkout", hostId: "host_1", root: "/work/one", base: null }), "uncommitted", load)).toBe("files");
  });
});

describe("isDeltaOnly", () => {
  it("is true only for a non-empty list of streaming delta types", () => {
    const deltas = [
      "item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta", "item/plan/delta", "item/toolCall/progress",
    ];
    expect(isDeltaOnly(deltas)).toBe(true);
    expect(isDeltaOnly(["item/agentMessage/delta"])).toBe(true);
    expect(isDeltaOnly([...deltas, "item/completed"])).toBe(false);
    expect(isDeltaOnly(["turn/completed"])).toBe(false);
    expect(isDeltaOnly([])).toBe(false);
    expect(isDeltaOnly(undefined)).toBe(false);
  });
});
