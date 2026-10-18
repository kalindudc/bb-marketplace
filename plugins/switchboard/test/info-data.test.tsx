import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { infoLoaders, loadCached, prefetchInfo, resetInfoCache, useCached, type Loader } from "../src/info-data";
import { sidebarThread } from "./fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = () => act(async () => { await Promise.resolve(); });
const loader = <T,>(key: string, load: () => Promise<T>, delayMs = 0): Loader<T> => ({ key, load, delayMs, prefetch: true });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { resetInfoCache(); vi.useRealTimers(); });

describe("loadCached", () => {
  it("shares one in-flight request per key", async () => {
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);
    const first = loadCached("k", load), second = loadCached("k", load);
    expect(second).toBe(first);
    pending.resolve("value");
    await expect(first).resolves.toBe("value");
    expect(load).toHaveBeenCalledOnce();
  });

  it("reuses a value for under two seconds, then reloads", async () => {
    const load = vi.fn(async () => "value");
    await loadCached("k", load);
    vi.advanceTimersByTime(1_999);
    await expect(loadCached("k", load)).resolves.toBe("value");
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await loadCached("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not store failures", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce("value");
    await expect(loadCached("k", load)).rejects.toThrow("down");
    await expect(loadCached("k", load)).resolves.toBe("value");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps at most 200 values and evicts the oldest", async () => {
    for (let index = 0; index <= 200; index++) await loadCached(`k${index}`, async () => index);
    const reload = vi.fn(async () => -1);
    await expect(loadCached("k1", reload)).resolves.toBe(1);
    await expect(loadCached("k0", reload)).resolves.toBe(-1);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("useCached", () => {
  it("returns null without a loader", () => {
    expect(renderHook(() => useCached(null)).result.current).toBeNull();
  });

  it("shows a stored value at once, then the fresh one", async () => {
    await loadCached("k", async () => "old");
    vi.advanceTimersByTime(2_000);
    const fresh = deferred<string>();
    const { result } = renderHook(() => useCached(loader("k", () => fresh.promise)));
    expect(result.current).toEqual({ status: "ready", value: "old" });
    await act(async () => { fresh.resolve("new"); });
    expect(result.current).toEqual({ status: "ready", value: "new" });
  });

  it("reports loading, then an error only when nothing is stored", async () => {
    const failing = deferred<string>();
    const { result } = renderHook(() => useCached(loader("k", () => failing.promise)));
    expect(result.current).toEqual({ status: "loading" });
    await act(async () => { failing.reject(new Error("down")); });
    expect(result.current).toEqual({ status: "error" });
  });

  it("keeps the stored value when revalidation fails", async () => {
    await loadCached("k", async () => "old");
    vi.advanceTimersByTime(2_000);
    const { result } = renderHook(() => useCached(loader("k", async () => { throw new Error("down"); })));
    await flush();
    expect(result.current).toEqual({ status: "ready", value: "old" });
  });

  it("waits for the loader's delay before calling it", async () => {
    const load = vi.fn(async () => "value");
    const { result } = renderHook(() => useCached(loader("k", load, 250)));
    act(() => { vi.advanceTimersByTime(249); });
    expect(load).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(load).toHaveBeenCalledOnce();
    expect(result.current).toEqual({ status: "ready", value: "value" });
  });

  it("ignores a result that arrives after the key changed or the hook unmounted", async () => {
    const first = deferred<string>(), second = deferred<string>();
    const { result, rerender, unmount } = renderHook(({ entry }) => useCached(entry),
      { initialProps: { entry: loader("a", () => first.promise) } });
    rerender({ entry: loader("b", () => second.promise) });
    await act(async () => { first.resolve("from a"); });
    expect(result.current).toEqual({ status: "loading" });
    unmount();
    await act(async () => { second.resolve("from b"); });
    expect(result.current).toEqual({ status: "loading" });
  });
});

describe("infoLoaders", () => {
  function fakeSdk() {
    const calls: unknown[][] = [];
    const record = <T,>(name: string, value: T) => async (args: unknown) => { calls.push([name, args]); return value; };
    const sdk = {
      threads: {
        defaultExecutionOptions: record("options", null),
        context: record("context", { usage: { usedTokens: 1, modelContextWindow: 10, estimated: false } }),
        conversationOutline: record("outline", { items: [], maxSeq: 0 }),
        interactions: { list: record("interactions", []) },
      },
      environments: {
        get: record("get", { mergeBaseBranch: "origin/main" }),
        status: record("status", { outcome: "not_applicable", reason: "non_git_environment", message: "" }),
      },
    } as unknown as PluginBrowserBbSdk;
    return { sdk, calls };
  }
  const environment = { id: "e", name: null, branchName: "b", path: "/w", isWorktree: true, providerId: null, workspaceDisplayKind: null };

  it("picks loaders by mode and thread", () => {
    const { sdk } = fakeSdk();
    const idle = infoLoaders(sdk, sidebarThread({ id: "t" }), "glance");
    expect(idle.options.key).toBe("options:t");
    expect(idle.usage.key).toBe("usage:t");
    expect(idle.outline).toBeNull();
    expect(idle.asks).toBeNull();
    expect(idle.changes).toBeNull();
    const busy = infoLoaders(sdk, sidebarThread({ id: "t", hasPendingInteraction: true, environment }), "briefing");
    expect(busy.outline?.key).toBe("outline:t");
    expect(busy.asks?.key).toBe("asks:t");
    expect(busy.changes).toMatchObject({ key: "changes:e", delayMs: 250, prefetch: false });
    for (const entry of [busy.options, busy.usage, busy.outline, busy.asks]) expect(entry).toMatchObject({ delayMs: 0, prefetch: true });
    expect(infoLoaders(sdk, sidebarThread(), "full").outline).not.toBeNull();
  });

  it("passes the environment's merge base to git status and unwraps usage", async () => {
    const { sdk, calls } = fakeSdk();
    const loaders = infoLoaders(sdk, sidebarThread({ id: "t", environment }), "glance");
    await loaders.changes!.load();
    expect(calls).toEqual([["get", { environmentId: "e" }], ["status", { environmentId: "e", mergeBaseBranch: "origin/main" }]]);
    await expect(loaders.usage.load()).resolves.toEqual({ usedTokens: 1, modelContextWindow: 10, estimated: false });
  });

  it("prefetches only prefetchable loaders and ignores their errors", async () => {
    const { sdk, calls } = fakeSdk();
    (sdk.threads as { defaultExecutionOptions: unknown }).defaultExecutionOptions = () => { throw new Error("down"); };
    prefetchInfo(infoLoaders(sdk, sidebarThread({ id: "t", hasPendingInteraction: true, environment }), "briefing"));
    await flush();
    expect(calls.map(([name]) => name).sort()).toEqual(["context", "interactions", "outline"]);
  });
});
