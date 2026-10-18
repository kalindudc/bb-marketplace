import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk";
import type { Overview, OverviewInput, OverviewTarget, ShellInput } from "../src/contract";
import { createVantageStore } from "../src/store";
import { branchRepo, fileChange, overview, repo, sharedFile, threadSummary, worktree } from "./fixtures";

type Callback = (event: unknown) => void;

interface PendingCall { input: OverviewInput; resolve(value: Overview): void; reject(error: Error): void }
interface PendingShell { input: ShellInput; resolve(value: Overview): void; reject(error: Error): void }

function setup(options: { refreshDelayMs?: number; target?: OverviewTarget; includeArchived?: boolean } = {}) {
  const callbacks = { "thread:changed": new Set<Callback>(), "environment:changed": new Set<Callback>(), "realtime:connection": new Set<Callback>() };
  const unsubscribed: string[] = [];
  const sdk = {
    subscribe: vi.fn((args: { event: keyof typeof callbacks; callback: Callback; threadId?: string }) => {
      callbacks[args.event].add(args.callback);
      return () => {
        callbacks[args.event].delete(args.callback);
        unsubscribed.push(args.event);
      };
    }),
  } as unknown as Pick<PluginBrowserBbSdk, "subscribe">;
  const calls: PendingCall[] = [];
  const shells: PendingShell[] = [];
  const shell = vi.fn((input: ShellInput) => new Promise<Overview>((resolve, reject) => {
    shells.push({ input, resolve, reject });
  }));
  // `rpc.call` counts the overview requests only, so the tests of refreshes need not know about the shell.
  const rpc = {
    call: vi.fn((input: OverviewInput) => new Promise<Overview>((resolve, reject) => {
      calls.push({ input, resolve, reject });
    })),
  };
  const transport = {
    call: ((method: "shell" | "overview", input: ShellInput | OverviewInput) => (
      method === "shell" ? shell(input as ShellInput) : rpc.call(input as OverviewInput)
    )) as never,
  };
  const store = createVantageStore({ rpc: transport, sdk, target: { kind: "tree", threadId: "thr_1" }, includeArchived: true, ...options });
  const emit = (event: keyof typeof callbacks, payload: object) => {
    for (const callback of [...callbacks[event]]) callback(payload);
  };
  const thread = (id: string, changes: string[], metadata?: object) => emit("thread:changed", { entity: "thread", type: "changed", id, changes, metadata });
  return { store, sdk, rpc, shell, shells, calls, emit, thread, callbacks, unsubscribed };
}

const tree = overview({
  threads: [threadSummary({ id: "thr_1" }), threadSummary({ id: "thr_child", parentThreadId: "thr_1", depth: 1, environmentId: "env_2" })],
  environmentIds: ["env_1", "env_2"],
});

async function loaded(options: { refreshDelayMs?: number; target?: OverviewTarget; includeArchived?: boolean } = {}) {
  const harness = setup(options);
  harness.calls[0]!.resolve(tree);
  await vi.advanceTimersByTimeAsync(0);
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("loading", () => {
  it("starts in loading, requests the overview once, and publishes it when it arrives", async () => {
    const { store, rpc, calls } = setup();
    expect(store.getSnapshot()).toEqual({ status: "loading", overview: null, scope: "uncommitted", refreshing: false, error: null });
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(calls[0]?.input).toEqual({ target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    calls[0]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toEqual({ status: "ready", overview: tree, scope: "uncommitted", refreshing: false, error: null });
  });

  it("reports a failed first load and recovers when refreshed", async () => {
    const { store, calls } = setup();
    calls[0]!.reject(new Error("bb is down"));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ status: "error", overview: null, error: "bb is down" });
    store.refresh();
    expect(store.getSnapshot()).toMatchObject({ status: "loading", error: null });
    calls[1]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", overview: tree, error: null });
  });

  it("keeps the last overview and shows the error when a refresh fails", async () => {
    const { store, calls, thread } = await loaded();
    await vi.advanceTimersByTimeAsync(1500);
    thread("thr_1", ["events-appended"]);
    expect(store.getSnapshot()).toMatchObject({ refreshing: true, overview: tree });
    calls[1]!.reject(new Error("timed out"));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toEqual({ status: "ready", overview: tree, scope: "uncommitted", refreshing: false, error: "timed out" });
    thread("thr_1", ["events-appended"]);
    await vi.advanceTimersByTimeAsync(1500);
    calls[2]!.resolve(overview({ threadId: "thr_1" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().error).toBeNull();
  });
});

describe("thread events", () => {
  it("ignores events for threads outside the tree", async () => {
    const { rpc, thread } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_elsewhere", ["events-appended", "archived-changed", "environment-changed", "parent-changed", "history-rewritten"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it("ignores events without a thread id and changes that cannot alter the files", async () => {
    const { rpc, thread, emit } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    emit("thread:changed", { entity: "thread", type: "changed", changes: ["events-appended"] });
    thread("thr_1", ["title-changed", "read-state-changed", "status-changed", "queue-changed", "pin-state-changed", "tabs-changed"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["events-appended without event types", ["events-appended"], undefined],
    ["events-appended with item/completed", ["events-appended"], { eventTypes: ["item/agentMessage/delta", "item/completed"] }],
    ["events-appended with turn/completed", ["events-appended"], { eventTypes: ["turn/completed"] }],
    ["archived-changed", ["archived-changed"], undefined],
    ["environment-changed", ["environment-changed"], undefined],
    ["parent-changed", ["parent-changed"], undefined],
  ])("refreshes for a tree thread's %s", async (_name, changes, metadata) => {
    const { rpc, thread } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_child", changes, metadata);
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it("ignores events-appended that carry only streaming deltas", async () => {
    const { rpc, thread } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_1", ["events-appended"], { eventTypes: ["item/agentMessage/delta", "item/commandExecution/outputDelta"] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it("refreshes when any thread is created, since it may be a new child", async () => {
    const { rpc, thread } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_new_elsewhere", ["thread-created"]);
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it("sends refresh: true after the history of a tree thread was rewritten or compacted", async () => {
    const { calls, thread } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_child", ["history-rewritten"]);
    expect(calls[1]?.input).toEqual({ target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true, refresh: true });
    calls[1]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(1500);
    thread("thr_1", ["history-compacted"]);
    expect(calls[2]?.input).toMatchObject({ refresh: true });
  });

  it("subscribes to every thread, not just this one", async () => {
    const { sdk } = await loaded();
    const subscribe = sdk.subscribe as unknown as ReturnType<typeof vi.fn>;
    const threadSubscription = subscribe.mock.calls.map(([args]) => args).find((args) => args.event === "thread:changed");
    expect(threadSubscription).toBeDefined();
    expect(threadSubscription).not.toHaveProperty("threadId");
  });
});

describe("throttling", () => {
  it("answers a burst with one request and one trailing request 1,500 ms after the first ended", async () => {
    const { rpc, calls, thread } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_1", ["events-appended"]);
    expect(rpc.call).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 20; index++) thread("thr_child", ["events-appended"]);
    expect(rpc.call).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(700);
    calls[1]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(1499);
    expect(rpc.call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.call).toHaveBeenCalledTimes(3);

    calls[2]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.call).toHaveBeenCalledTimes(3);
  });

  it("makes an event that comes soon after a request wait out the delay", async () => {
    const { rpc, thread } = await loaded();
    thread("thr_1", ["events-appended"]);
    expect(rpc.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(rpc.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it("keeps the strongest request when a burst mixes a plain refresh with a rewrite", async () => {
    const { calls, thread } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_1", ["events-appended"]);
    thread("thr_1", ["history-rewritten"]);
    thread("thr_1", ["events-appended"]);
    calls[1]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls[2]?.input).toMatchObject({ refresh: true });
  });

  it("uses the configured delay", async () => {
    const { rpc, thread } = await loaded({ refreshDelayMs: 200 });
    thread("thr_1", ["events-appended"]);
    await vi.advanceTimersByTimeAsync(199);
    expect(rpc.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });
});

describe("environment and connection events", () => {
  it("refreshes for a listed environment's git and status changes only", async () => {
    const { rpc, emit, calls } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    emit("environment:changed", { entity: "environment", type: "changed", id: "env_other", changes: ["git-refs-changed"] });
    emit("environment:changed", { entity: "environment", type: "changed", id: "env_1", changes: ["metadata-changed"] });
    emit("environment:changed", { entity: "environment", type: "changed", changes: ["git-refs-changed"] });
    expect(rpc.call).toHaveBeenCalledTimes(1);
    for (const change of ["work-status-changed", "git-refs-changed", "status-changed"]) {
      emit("environment:changed", { entity: "environment", type: "changed", id: "env_2", changes: [change] });
      expect(rpc.call).toHaveBeenCalledTimes(calls.length);
      calls[calls.length - 1]!.resolve(tree);
      await vi.advanceTimersByTimeAsync(1500);
    }
    expect(rpc.call).toHaveBeenCalledTimes(4);
  });

  it("refreshes after the connection came back, not when it merely changed state", async () => {
    const { rpc, emit } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    emit("realtime:connection", { state: "connecting", reconnected: false, reconnectDelayMs: 100 });
    expect(rpc.call).toHaveBeenCalledTimes(1);
    emit("realtime:connection", { state: "connected", reconnected: true, reconnectDelayMs: null });
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });
});

describe("scope and manual refresh", () => {
  it("reloads at once with the new scope and drops the stale result", async () => {
    const { store, rpc, calls } = await loaded();
    store.setScope("branch");
    expect(rpc.call).toHaveBeenCalledTimes(2);
    expect(calls[1]?.input).toEqual({ target: { kind: "tree", threadId: "thr_1" }, scope: "branch", includeArchived: true });
    expect(store.getSnapshot()).toMatchObject({ scope: "branch", refreshing: true, overview: tree });

    const fresh = overview({ scope: "branch", repos: [] });
    calls[1]!.resolve(fresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toEqual({ status: "ready", overview: fresh, scope: "branch", refreshing: false, error: null });
  });

  it("does not let a request for the old scope overwrite the new one", async () => {
    const { store, calls } = await loaded();
    store.refresh();
    expect(calls).toHaveLength(2);
    store.setScope("branch");
    expect(calls).toHaveLength(3);
    const fresh = overview({ scope: "branch" });
    calls[2]!.resolve(fresh);
    await vi.advanceTimersByTimeAsync(0);
    calls[1]!.resolve(overview({ scope: "uncommitted", warnings: ["stale"] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().overview).toBe(fresh);
    expect(store.getSnapshot().refreshing).toBe(false);
  });

  it("does nothing when the scope does not change", async () => {
    const { store, rpc } = await loaded();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setScope("uncommitted");
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("refresh() starts at once, and refresh({ hard: true }) asks the server to forget its cache", async () => {
    const { store, calls } = await loaded();
    store.refresh();
    expect(calls[1]?.input).toEqual({ target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true });
    calls[1]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(0);
    store.refresh({ hard: true });
    expect(calls[2]?.input).toEqual({ target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true, refresh: true });
  });

  it("waits for the running request of the same scope instead of overlapping it", async () => {
    const { store, rpc, calls } = await loaded();
    store.refresh();
    store.refresh();
    store.refresh({ hard: true });
    expect(rpc.call).toHaveBeenCalledTimes(2);
    calls[1]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.call).toHaveBeenCalledTimes(3);
    expect(calls[2]?.input).toMatchObject({ refresh: true });
  });
});

describe("snapshots and disposal", () => {
  it("notifies subscribers only when the snapshot changed", async () => {
    const { store, calls } = setup();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    calls[0]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(store.getSnapshot()).toBe(second);
    unsubscribe();
    store.setScope("branch");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes every callback on dispose and ignores late results", async () => {
    const { store, callbacks, unsubscribed, calls, rpc } = await loaded();
    store.refresh();
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispose();
    expect(unsubscribed.sort()).toEqual(["environment:changed", "realtime:connection", "thread:changed"]);
    expect(callbacks["thread:changed"].size + callbacks["environment:changed"].size + callbacks["realtime:connection"].size).toBe(0);
    calls[1]!.resolve(overview({ warnings: ["late"] }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.getSnapshot().overview).toBe(tree);
    expect(listener).not.toHaveBeenCalled();
    store.refresh();
    store.setScope("branch");
    expect(rpc.call).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it("cancels a trailing request on dispose", async () => {
    const { store, rpc, thread } = await loaded();
    thread("thr_1", ["events-appended"]);
    store.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });
});

describe("every thread", () => {
  const ALL: OverviewTarget = { kind: "all" };
  const everyThread = overview({
    threads: [threadSummary({ id: "thr_a" }), threadSummary({ id: "thr_b", environmentId: "env_2" })],
    environmentIds: ["env_1", "env_2"], target: ALL, windowHours: 24, threadId: "",
  });
  const allLoaded = async (options: { refreshDelayMs?: number } = {}) => {
    const harness = setup({ target: ALL, ...options });
    harness.calls[0]!.resolve(everyThread);
    await vi.advanceTimersByTimeAsync(0);
    return harness;
  };
  let visibility: "visible" | "hidden" = "visible";
  const setVisibility = (next: "visible" | "hidden") => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  beforeEach(() => {
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });
  afterEach(() => {
    delete (document as unknown as { visibilityState?: string }).visibilityState;
  });

  it("asks for the all target", async () => {
    const { calls, store } = setup({ target: ALL });
    expect(calls[0]?.input).toEqual({ target: ALL, scope: "uncommitted", includeArchived: true });
    store.dispose();
  });

  it("refreshes for any thread's file changes, even one that is not in the overview", async () => {
    const { rpc, thread } = await allLoaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_unseen", ["events-appended"], { eventTypes: ["item/completed"] });
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it("still ignores deltas and changes that cannot alter files", async () => {
    const { rpc, thread } = await allLoaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_a", ["events-appended"], { eventTypes: ["item/agentMessage/delta"] });
    thread("thr_a", ["title-changed", "read-state-changed"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it("asks for a hard refresh after a history rewrite, like a tree", async () => {
    const { calls, thread } = await allLoaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_unseen", ["history-rewritten"]);
    expect(calls[1]?.input).toEqual({ target: ALL, scope: "uncommitted", includeArchived: true, refresh: true });
  });

  it("waits 5 seconds after a request ended before it refreshes again", async () => {
    const { rpc, thread } = await allLoaded();
    thread("thr_a", ["events-appended"]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(rpc.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it("only follows the environments the overview lists", async () => {
    const { rpc, emit } = await allLoaded();
    await vi.advanceTimersByTimeAsync(5000);
    emit("environment:changed", { entity: "environment", type: "changed", id: "env_other", changes: ["git-refs-changed"] });
    expect(rpc.call).toHaveBeenCalledTimes(1);
    emit("environment:changed", { entity: "environment", type: "changed", id: "env_2", changes: ["git-refs-changed"] });
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it("refreshes every 60 seconds while the page is visible, and not while it is hidden", async () => {
    const { rpc, calls } = await allLoaded();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(rpc.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.call).toHaveBeenCalledTimes(2);
    calls[1]!.resolve(everyThread);
    await vi.advanceTimersByTimeAsync(0);
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it("refreshes when the page becomes visible, and not when it becomes hidden", async () => {
    const { rpc } = await allLoaded();
    await vi.advanceTimersByTimeAsync(5000);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rpc.call).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it("refreshes at once on request, which is how the settings signal reaches it", async () => {
    const { rpc, store } = await allLoaded();
    store.refresh();
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });

  it("stops the heartbeat and the visibility listener on dispose", async () => {
    const { rpc, store } = await allLoaded();
    store.dispose();
    await vi.advanceTimersByTimeAsync(180_000);
    setVisibility("hidden");
    setVisibility("visible");
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it("does not run a heartbeat or follow visibility for a tree", async () => {
    const { rpc } = await loaded();
    await vi.advanceTimersByTimeAsync(180_000);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(5000);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });
});

describe("the instant outline", () => {
  const outline = overview({ ...tree, partial: true, scope: "uncommitted" });

  it("asks for the outline and the full overview together on the first load", async () => {
    const { store, shell, rpc, shells, calls } = setup({ includeArchived: false });
    expect(shell).toHaveBeenCalledTimes(1);
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(shells[0]?.input).toEqual({ target: { kind: "tree", threadId: "thr_1" }, includeArchived: false });
    expect(calls[0]?.input).toEqual({ target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: false });
    store.dispose();
  });

  it("paints the outline first and replaces it with the full result", async () => {
    const { store, shells, calls } = setup();
    shells[0]!.resolve(outline);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toEqual({ status: "ready", overview: outline, scope: "uncommitted", refreshing: true, error: null });
    calls[0]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toEqual({ status: "ready", overview: tree, scope: "uncommitted", refreshing: false, error: null });
  });

  it("keeps the full result when it arrives first, and drops a late outline", async () => {
    const { store, shells, calls } = setup();
    calls[0]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(0);
    shells[0]!.resolve(outline);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ overview: tree, refreshing: false });
  });

  it("stays loading when the outline fails, until the full result arrives", async () => {
    const { store, shells, calls } = setup();
    shells[0]!.reject(new Error("no outline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ status: "loading", overview: null, error: null });
    calls[0]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", overview: tree, error: null });
  });

  it("reports a failed full overview as before, keeping the outline that was already drawn", async () => {
    const { store, shells, calls } = setup();
    shells[0]!.resolve(outline);
    await vi.advanceTimersByTimeAsync(0);
    calls[0]!.reject(new Error("timed out"));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", overview: outline, refreshing: false, error: "timed out" });
  });

  it("shows the scope the store is in, whatever the outline says", async () => {
    const { store, shells, calls } = await loaded();
    await vi.advanceTimersByTimeAsync(0);
    store.setScope("branch");
    shells[1]!.resolve(outline);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().overview).toMatchObject({ partial: true, scope: "branch" });
    calls[1]!.resolve(overview({ scope: "branch" }));
  });

  it("asks for no outline when a refresh follows an event, a refresh button or a heartbeat", async () => {
    const { store, shell, rpc, thread } = await loaded();
    await vi.advanceTimersByTimeAsync(5000);
    thread("thr_1", ["events-appended"]);
    expect(rpc.call).toHaveBeenCalledTimes(2);
    store.refresh({ hard: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it("asks for an outline again when the scope changes", async () => {
    const { store, shell, shells, rpc, calls } = await loaded();
    store.setScope("branch");
    expect(shell).toHaveBeenCalledTimes(2);
    expect(rpc.call).toHaveBeenCalledTimes(2);
    expect(shells[1]?.input).toEqual({ target: { kind: "tree", threadId: "thr_1" }, includeArchived: true });
    expect(calls[1]?.input).toMatchObject({ scope: "branch" });
  });

  it("reloads with the new flag when archived threads are switched on or off", async () => {
    const { store, shell, shells, rpc, calls } = await loaded({ includeArchived: false });
    store.setIncludeArchived(true);
    expect(shell).toHaveBeenCalledTimes(2);
    expect(rpc.call).toHaveBeenCalledTimes(2);
    expect(shells[1]?.input).toMatchObject({ includeArchived: true });
    expect(calls[1]?.input).toMatchObject({ includeArchived: true });
    calls[1]!.resolve(tree);
    await vi.advanceTimersByTimeAsync(0);
    store.setIncludeArchived(false);
    expect(calls[2]?.input).toMatchObject({ includeArchived: false });
  });

  describe("switching archived threads keeps the active rows on screen", () => {
    const live = threadSummary({ id: "thr_1" });
    const old = threadSummary({ id: "thr_old", archived: true, environmentId: "env_old" });
    const activeRow = worktree({ key: "host_1:/work/live", threadIds: ["thr_1"], uncommitted: [fileChange({ path: "a.ts" })] });
    const archivedRow = worktree({ key: "host_1:/work/old", threadIds: ["thr_old"], state: "loading", uncommitted: [] });
    const activeRepo = repo({ key: "host_1:/work/live", threadIds: ["thr_1"] });
    const archivedRepo = branchRepo({ key: "host_1:/code/proj@old", threadIds: ["thr_old"] });
    const full = overview({ threads: [live], worktrees: [activeRow], repos: [activeRepo], warnings: ["kept"], archivedHidden: 1 });

    it("adds the archived rows from the outline under the active ones, whose numbers stay", async () => {
      const { store, shells, calls } = setup({ includeArchived: false });
      calls[0]!.resolve(full);
      await vi.advanceTimersByTimeAsync(0);
      store.setIncludeArchived(true);
      shells[1]!.resolve(overview({
        partial: true, threads: [live, old], archivedHidden: 0,
        worktrees: [{ ...activeRow, state: "loading", uncommitted: [] }, archivedRow],
        repos: [{ ...activeRepo, state: "loading" }, { ...archivedRepo, state: "loading" }],
      }));
      await vi.advanceTimersByTimeAsync(0);
      const shown = store.getSnapshot();
      expect(shown.refreshing).toBe(true);
      expect(shown.overview?.partial).toBe(false);
      expect(shown.overview?.worktrees).toEqual([activeRow, archivedRow]);
      expect(shown.overview?.repos.map((entry) => [entry.key, entry.state])).toEqual([[activeRepo.key, "ready"], [archivedRepo.key, "loading"]]);
      expect(shown.overview?.threads.map((thread) => thread.id)).toEqual(["thr_1", "thr_old"]);
      expect(shown.overview).toMatchObject({ archivedHidden: 0, warnings: ["kept"] });
      calls[1]!.resolve(overview({ threads: [live, old], worktrees: [activeRow, { ...archivedRow, state: "ready" }] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getSnapshot().overview?.worktrees.map((entry) => entry.state)).toEqual(["ready", "ready"]);
    });

    it("removes only the archived rows when archived threads are switched off", async () => {
      const { store, shells, calls } = setup({ includeArchived: true });
      calls[0]!.resolve(overview({
        threads: [live, old], worktrees: [activeRow, { ...archivedRow, state: "ready" }], repos: [activeRepo, archivedRepo],
        sharedFiles: [sharedFile({ worktreeKeys: [activeRow.key, archivedRow.key] })],
      }));
      await vi.advanceTimersByTimeAsync(0);
      store.setIncludeArchived(false);
      shells[1]!.resolve(overview({ partial: true, threads: [live], archivedHidden: 1, worktrees: [{ ...activeRow, state: "loading" }] }));
      await vi.advanceTimersByTimeAsync(0);
      const shown = store.getSnapshot().overview;
      expect(shown?.worktrees).toEqual([activeRow]);
      expect(shown?.repos).toEqual([activeRepo]);
      expect(shown?.sharedFiles).toEqual([]);
      expect(shown?.archivedHidden).toBe(1);
    });

    it("still paints a plain outline when nothing has loaded yet", async () => {
      const { store, shells } = setup({ includeArchived: false });
      store.setIncludeArchived(true);
      const outline = overview({ partial: true, threads: [live, old], worktrees: [archivedRow] });
      shells[1]!.resolve(outline);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getSnapshot().overview).toEqual(outline);
    });
  });

  it("does nothing when the flag is set to the value it already has", async () => {
    const { store, shell, rpc } = await loaded({ includeArchived: false });
    store.setIncludeArchived(false);
    expect(shell).toHaveBeenCalledTimes(1);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it("drops the outline and the result of a load that the flag change replaced", async () => {
    const { store, shells, calls } = setup({ includeArchived: false });
    store.setIncludeArchived(true);
    shells[0]!.resolve(overview({ ...outline, archivedHidden: 3 }));
    calls[0]!.resolve(overview({ warnings: ["old load"] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ overview: null, status: "loading" });
    shells[1]!.resolve(outline);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().overview).toEqual(outline);
  });

  it("asks for the outline of the all-threads target too", async () => {
    const { shells, store } = setup({ target: { kind: "all" }, includeArchived: false });
    expect(shells[0]?.input).toEqual({ target: { kind: "all" }, includeArchived: false });
    store.dispose();
  });

  it("ignores an outline that arrives after dispose", async () => {
    const { store, shells } = setup();
    store.dispose();
    shells[0]!.resolve(outline);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().overview).toBeNull();
  });
});
