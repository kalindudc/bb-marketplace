import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionLogStore, type SessionLogStore } from "../src/store";
import { childRowsOf } from "../src/merge";
import type { SessionLogSdk, ThreadEventRow, TimelineResponse } from "../src/types";
import {
  acceptedEvent, assistantRow, commandRow, requestEvent, timelineResponse, turnRow, userRow,
} from "./fixtures";

type TimelineArgs = Parameters<SessionLogSdk["threads"]["timeline"]>[0];
type EventsArgs = Parameters<SessionLogSdk["threads"]["events"]["list"]>[0];
type EventsResponder = (args: EventsArgs, call: number) => ThreadEventRow[] | Promise<ThreadEventRow[]>;
const stores: SessionLogStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeSdk(
  respond: (args: TimelineArgs, call: number) => TimelineResponse | Promise<TimelineResponse>,
  respondEvents: EventsResponder = () => [],
) {
  const calls: TimelineArgs[] = [];
  const eventCalls: EventsArgs[] = [];
  const callbacks = new Map<string, (event: unknown) => void>();
  let getCalls = 0;
  let unsubscribeCount = 0;
  const sdk = {
    threads: {
      timeline: (args: TimelineArgs) => {
        calls.push(args);
        return Promise.resolve(respond(args, calls.length));
      },
      events: {
        list: (args: EventsArgs) => {
          eventCalls.push(args);
          return Promise.resolve().then(() => respondEvents(args, eventCalls.length));
        },
      },
      get: async () => {
        getCalls++;
        return { projectId: "proj_1" } as Awaited<ReturnType<SessionLogSdk["threads"]["get"]>>;
      },
    },
    subscribe: (args: { event: string; callback: (event: unknown) => void }) => {
      callbacks.set(args.event, args.callback);
      return () => { callbacks.delete(args.event); unsubscribeCount++; };
    },
  } as unknown as SessionLogSdk;
  return {
    sdk,
    calls,
    eventCalls,
    get getCalls() { return getCalls; },
    get unsubscribeCount() { return unsubscribeCount; },
    get subscribed() { return [...callbacks.keys()]; },
    emitThread(changes: Array<"events-appended" | "history-rewritten" | "history-compacted">) {
      callbacks.get("thread:changed")?.({ type: "changed", entity: "thread", id: "thr_1", changes });
    },
    emitConnection(reconnected: boolean) {
      callbacks.get("realtime:connection")?.({ state: "connected", reconnected, reconnectDelayMs: null });
    },
  };
}

function makeStore(sdk: SessionLogSdk, refreshIntervalMs = 500) {
  const store = createSessionLogStore({ sdk, threadId: "thr_1", refreshIntervalMs });
  stores.push(store);
  return store;
}

describe("createSessionLogStore", () => {
  it("subscribes immediately, loads every page newest to oldest and reads projectId once", async () => {
    const shared = commandRow("shared");
    const older = timelineResponse([
      userRow("first"),
      turnRow("fold", { children: [commandRow("older"), shared] }),
    ]);
    const latest = timelineResponse([
      turnRow("fold", { children: [shared, assistantRow("newer")] }),
      assistantRow("last"),
    ], {
      maxSeq: 40,
      timelinePage: {
        historySnapshot: "snap",
        olderCursor: { anchorId: "fold", anchorSeq: 10 },
        olderRowsSourceSeqEnd: 10,
        returnedSegmentCount: 1,
      },
    });
    const fake = fakeSdk((_args, call) => call === 1 ? latest : older);
    const store = makeStore(fake.sdk);
    expect(fake.subscribed).toEqual(["thread:changed", "realtime:connection"]);
    expect(store.getSnapshot().status).toBe("loading");

    await settle();

    expect(fake.calls).toEqual([
      { threadId: "thr_1", includeNestedRows: "true" },
      { threadId: "thr_1", includeNestedRows: "true", beforeAnchorId: "fold", beforeAnchorSeq: "10" },
    ]);
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["first", "fold", "last"]);
    expect(childRowsOf(store.getSnapshot().rows[1]!)?.map((row) => row.id)).toEqual(["older", "shared", "newer"]);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", projectId: "proj_1", error: null });
    expect(fake.getCalls).toBe(1);
  });

  it("throttles a burst to one in-flight refresh and one trailing request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = userRow("first");
    const second = assistantRow("second");
    const pending = deferred<TimelineResponse>();
    const fake = fakeSdk((_args, call) => {
      if (call === 1) return timelineResponse([first], { maxSeq: 10 });
      if (call === 2) return pending.promise;
      return timelineResponse([], { maxSeq: 12, delta: { upsertRows: [] } });
    });
    const store = makeStore(fake.sdk);
    await settle();
    for (let i = 0; i < 8; i++) fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.afterSequence).toBe("10");

    for (let i = 0; i < 8; i++) fake.emitThread(["events-appended"]);
    pending.resolve(timelineResponse([], {
      maxSeq: 11,
      delta: { upsertRows: [second], rowOrder: ["first", "second"] },
    }));
    await settle();
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(499);
    expect(fake.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]?.afterSequence).toBe("11");
  });

  it("applies delta upserts to the latest window and preserves the full list", async () => {
    vi.useFakeTimers();
    const first = userRow("first");
    const original = commandRow("cmd", { output: "old" });
    const updated = commandRow("cmd", { output: "new" });
    const fake = fakeSdk((_args, call) => call === 1
      ? timelineResponse([first, original], { maxSeq: 20 })
      : timelineResponse([], { maxSeq: 21, delta: { upsertRows: [updated] } }));
    const store = makeStore(fake.sdk);
    await settle();
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getSnapshot().rows).toEqual([first, updated]);
    expect(fake.calls).toHaveLength(2);
  });

  it("refetches without afterSequence when a delta refers to a missing id", async () => {
    vi.useFakeTimers();
    const first = userRow("first");
    const added = assistantRow("added");
    const fake = fakeSdk((_args, call) => {
      if (call === 1) return timelineResponse([first], { maxSeq: 10 });
      if (call === 2) return timelineResponse([], {
        maxSeq: 11,
        delta: { upsertRows: [], rowOrder: ["first", "missing"] },
      });
      return timelineResponse([first, added], { maxSeq: 11 });
    });
    const store = makeStore(fake.sdk);
    await settle();
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls.map((call) => call.afterSequence)).toEqual([undefined, "10", undefined]);
    expect(store.getSnapshot().rows).toEqual([first, added]);
  });

  it("reloads on rewritten history and refreshes after reconnect", async () => {
    vi.useFakeTimers();
    const replacement = userRow("replacement");
    const fake = fakeSdk((_args, call) => call === 1
      ? timelineResponse([userRow("original")], { maxSeq: 10 })
      : call === 2
        ? timelineResponse([replacement], { maxSeq: 20 })
        : timelineResponse([], { maxSeq: 20, delta: { upsertRows: [] } }));
    const store = makeStore(fake.sdk);
    await settle();
    fake.emitThread(["history-rewritten"]);
    await settle();
    expect(fake.calls[1]?.afterSequence).toBeUndefined();
    expect(store.getSnapshot().rows).toEqual([replacement]);
    fake.emitConnection(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls).toHaveLength(2);
    fake.emitConnection(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls[2]?.afterSequence).toBe("20");
  });

  it("restarts a failed older-page walk once, shows the error, and retry recovers", async () => {
    const latest = timelineResponse([assistantRow("last")], {
      timelinePage: {
        historySnapshot: "stale",
        olderCursor: { anchorId: "last", anchorSeq: 10 },
        olderRowsSourceSeqEnd: 10,
        returnedSegmentCount: 1,
      },
    });
    const fake = fakeSdk((_args, call) => {
      if (call === 1 || call === 3) return latest;
      if (call === 2 || call === 4) throw new Error("HTTP 400 stale cursor");
      return timelineResponse([userRow("recovered")]);
    });
    const store = makeStore(fake.sdk);
    await settle();
    expect(fake.calls).toHaveLength(4);
    expect(store.getSnapshot()).toMatchObject({ status: "error", rows: [], error: "HTTP 400 stale cursor" });
    store.retry();
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: "ready", error: null });
    expect(store.getSnapshot().rows[0]?.id).toBe("recovered");
    expect(fake.getCalls).toBe(1);
  });

  it("keeps rows on a refresh error and clears the error after success", async () => {
    vi.useFakeTimers();
    const first = userRow("first");
    const fake = fakeSdk((_args, call) => {
      if (call === 1) return timelineResponse([first], { maxSeq: 10 });
      if (call === 2) throw new Error("temporarily offline");
      return timelineResponse([], { maxSeq: 11, delta: { upsertRows: [] } });
    });
    const store = makeStore(fake.sdk);
    await settle();
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", rows: [first], error: "temporarily offline" });
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", rows: [first], error: null });
  });

  it("refreshes once after an event received while loading", async () => {
    vi.useFakeTimers();
    const pending = deferred<TimelineResponse>();
    const fake = fakeSdk((_args, call) => call === 1
      ? pending.promise
      : timelineResponse([], { maxSeq: 10, delta: { upsertRows: [] } }));
    const store = makeStore(fake.sdk);
    fake.emitThread(["events-appended"]);
    pending.resolve(timelineResponse([userRow("first")], { maxSeq: 10 }));
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getSnapshot().status).toBe("ready");
    expect(fake.calls).toHaveLength(2);
  });

  it("unsubscribes on dispose and ignores a request that resolves afterward", async () => {
    vi.useFakeTimers();
    const first = userRow("first");
    const pending = deferred<TimelineResponse>();
    const fake = fakeSdk((_args, call) => call === 1
      ? timelineResponse([first], { maxSeq: 10 })
      : pending.promise);
    const store = makeStore(fake.sdk);
    await settle();
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    const before = store.getSnapshot();
    store.dispose();
    expect(fake.unsubscribeCount).toBe(2);
    fake.emitThread(["events-appended"]);
    pending.resolve(timelineResponse([assistantRow("late")], { maxSeq: 11 }));
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls).toHaveLength(2);
    expect(store.getSnapshot()).toBe(before);
  });

  it("reads every page of request events on load and keeps the hidden messages beside the rows", async () => {
    const page = Array.from({ length: 100 }, (_, index) => acceptedEvent(index + 1, `creq_visible_${index}`));
    const fake = fakeSdk(
      () => timelineResponse([userRow("first")], { maxSeq: 300 }),
      (_args, call) => call === 1 ? page : [requestEvent(250), acceptedEvent(252, "creq_250")],
    );
    const store = makeStore(fake.sdk);
    await settle();

    const query = { threadId: "thr_1", types: ["client/turn/requested", "turn/input/accepted", "client/turn/rejected"], order: "asc", limit: "100" };
    expect(fake.eventCalls).toEqual([{ ...query, afterSeq: "0" }, { ...query, afterSeq: "100" }]);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", hiddenError: null });
    expect(store.getSnapshot().hidden.map(({ id, seq }) => [id, seq])).toEqual([["hidden:creq_250", 252]]);
  });

  it("reads new request events with each refresh and settles a steer once it is accepted", async () => {
    vi.useFakeTimers();
    const fake = fakeSdk(
      (_args, call) => call === 1
        ? timelineResponse([userRow("first")], { maxSeq: 20 })
        : timelineResponse([], { maxSeq: 30, delta: { upsertRows: [] } }),
      (_args, call) => call === 1 ? [requestEvent(20)] : call === 2 ? [acceptedEvent(22, "creq_20")] : [],
    );
    const store = makeStore(fake.sdk);
    await settle();
    const pendingSteer = store.getSnapshot().hidden;
    expect(pendingSteer.map(({ seq }) => seq)).toEqual([20]);

    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.eventCalls.map((call) => call.afterSeq)).toEqual(["0", "20"]);
    expect(store.getSnapshot().hidden.map(({ seq }) => seq)).toEqual([22]);

    const settledSteer = store.getSnapshot().hidden;
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.eventCalls.map((call) => call.afterSeq)).toEqual(["0", "20", "22"]);
    expect(store.getSnapshot().hidden).toBe(settledSteer);
  });

  it("keeps the log usable when request events fail, then catches up from the same point", async () => {
    vi.useFakeTimers();
    const fake = fakeSdk(
      (_args, call) => call === 1
        ? timelineResponse([userRow("first")], { maxSeq: 20 })
        : timelineResponse([], { maxSeq: 30, delta: { upsertRows: [] } }),
      (_args, call) => {
        if (call === 1) throw new Error("events unavailable");
        return [requestEvent(25)];
      },
    );
    const store = makeStore(fake.sdk);
    await settle();
    expect(store.getSnapshot()).toMatchObject({
      status: "ready", error: null, hidden: [], hiddenError: "events unavailable",
    });
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["first"]);

    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.eventCalls.map((call) => call.afterSeq)).toEqual(["0", "0"]);
    expect(store.getSnapshot()).toMatchObject({ hiddenError: null });
    expect(store.getSnapshot().hidden.map(({ id }) => id)).toEqual(["hidden:creq_25"]);
  });

  it("rereads request events from the start when history is rewritten", async () => {
    vi.useFakeTimers();
    const fake = fakeSdk(
      (_args, call) => timelineResponse([userRow(`load-${call}`)], { maxSeq: 20 }),
      (_args, call) => call === 1 ? [requestEvent(15)] : [],
    );
    const store = makeStore(fake.sdk);
    await settle();
    expect(store.getSnapshot().hidden).toHaveLength(1);
    fake.emitThread(["history-rewritten"]);
    await settle();
    expect(fake.eventCalls.map((call) => call.afterSeq)).toEqual(["0", "0"]);
    expect(store.getSnapshot().hidden).toEqual([]);
  });

  it("retries a transient project lookup failure instead of caching the rejection", async () => {
    const fake = fakeSdk(() => timelineResponse([userRow("recovered")]));
    let lookups = 0;
    const sdk: SessionLogSdk = {
      ...fake.sdk,
      threads: {
        ...fake.sdk.threads,
        get: async () => {
          lookups++;
          if (lookups === 1) throw new Error("project temporarily unavailable");
          return { projectId: "proj_1" } as Awaited<ReturnType<SessionLogSdk["threads"]["get"]>>;
        },
      },
    };
    const store = makeStore(sdk);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: "error", error: "project temporarily unavailable" });
    store.retry();
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: "ready", projectId: "proj_1", error: null });
    expect(store.getSnapshot().rows[0]?.id).toBe("recovered");
    expect(lookups).toBe(2);
  });
});
