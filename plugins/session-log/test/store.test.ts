import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionLogStore, type SessionLogStore } from "../src/store";
import { childRowsOf } from "../src/merge";
import type { SessionLogSdk, ThreadEventRow, TimelineDeltaResponse, TimelineResponse } from "../src/types";
import {
  acceptedEvent, assistantRow, commandRow, requestEvent, timelineDelta, timelineResponse, turnRow, userRow,
} from "./fixtures";

type TimelineArgs = Parameters<SessionLogSdk["threads"]["timeline"]>[0];
type TimelineAnswer = TimelineResponse | TimelineDeltaResponse;
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
  respond: (args: TimelineArgs, call: number) => TimelineAnswer | Promise<TimelineAnswer>,
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

/** Answers events reads the way bb does: newest first before a seq, or oldest first after one. */
function eventServer(events: ThreadEventRow[]): EventsResponder {
  return (args) => {
    const limit = Number(args.limit ?? 100);
    const sorted = [...events].sort((left, right) => left.seq - right.seq);
    if (args.order === "desc") {
      const before = args.beforeSeq === undefined ? Infinity : Number(args.beforeSeq);
      return sorted.filter((event) => event.seq < before).reverse().slice(0, limit);
    }
    return sorted.filter((event) => event.seq > Number(args.afterSeq ?? 0)).slice(0, limit);
  };
}

const eventRead = (args: EventsArgs) => args.order === "desc"
  ? args.beforeSeq === undefined ? "newest" : `before ${args.beforeSeq}`
  : `after ${args.afterSeq}`;

function makeStore(sdk: SessionLogSdk, refreshIntervalMs = 500, visible = true) {
  const store = createSessionLogStore({ sdk, threadId: "thr_1", refreshIntervalMs, visible });
  stores.push(store);
  return store;
}

describe("createSessionLogStore", () => {
  it("subscribes immediately, loads only the latest window, and reads older pages one at a time on request", async () => {
    // Older pages wait as long as the last request took; a frozen clock makes that no wait at all.
    vi.useFakeTimers();
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
    expect(fake.calls).toEqual([{ threadId: "thr_1", includeNestedRows: "true" }]);
    expect(store.getSnapshot()).toMatchObject({
      status: "ready", projectId: "proj_1", error: null, hasOlder: true, loadingOlder: false, olderError: null,
    });
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["fold", "last"]);

    store.loadOlder();
    expect(store.getSnapshot().loadingOlder).toBe(true);
    await settle();
    expect(fake.calls[1]).toEqual({ threadId: "thr_1", includeNestedRows: "true", beforeAnchorId: "fold", beforeAnchorSeq: "10" });
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["first", "fold", "last"]);
    expect(childRowsOf(store.getSnapshot().rows[1]!)?.map((row) => row.id)).toEqual(["older", "shared", "newer"]);
    expect(store.getSnapshot()).toMatchObject({ hasOlder: false, loadingOlder: false });
    store.loadOlder();
    await settle();
    expect(fake.calls).toHaveLength(2);
    expect(fake.getCalls).toBe(1);
  });

  it("reads every older page while asked to load the whole session, and stops when asked", async () => {
    // Older pages wait as long as the last request took; a frozen clock makes that no wait at all.
    vi.useFakeTimers();
    const page = (anchorSeq: number | null) => ({
      historySnapshot: "snap",
      olderCursor: anchorSeq === null ? null : { anchorId: `anchor-${anchorSeq}`, anchorSeq },
      olderRowsSourceSeqEnd: null,
      returnedSegmentCount: 1,
    });
    const pages: Record<string, TimelineResponse> = {
      latest: timelineResponse([assistantRow("newest", { sourceSeqStart: 40, sourceSeqEnd: 40 })], { timelinePage: page(40) }),
      "anchor-40": timelineResponse([assistantRow("third", { sourceSeqStart: 30, sourceSeqEnd: 30 })], { timelinePage: page(30) }),
      "anchor-30": timelineResponse([assistantRow("second", { sourceSeqStart: 20, sourceSeqEnd: 20 })], { timelinePage: page(20) }),
      "anchor-20": timelineResponse([assistantRow("first", { sourceSeqStart: 10, sourceSeqEnd: 10 })], { timelinePage: page(null) }),
    };
    const fake = fakeSdk((args) => pages[args.beforeAnchorId ?? "latest"]!);
    const store = makeStore(fake.sdk);
    await settle();
    store.setLoadAll(true);
    store.setLoadAll(false);
    await settle();
    expect(fake.calls.map((call) => call.beforeAnchorId)).toEqual([undefined, "anchor-40"]);
    expect(store.getSnapshot().hasOlder).toBe(true);
    store.setLoadAll(true);
    for (let i = 0; i < 4; i++) await settle();
    expect(fake.calls.map((call) => call.beforeAnchorId)).toEqual([undefined, "anchor-40", "anchor-30", "anchor-20"]);
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["first", "second", "third", "newest"]);
    expect(store.getSnapshot()).toMatchObject({ hasOlder: false, loadingOlder: false });
  });

  it("reads a refused cursor's page again from a fresh chain of pages", async () => {
    // Older pages wait as long as the last request took; a frozen clock makes that no wait at all.
    vi.useFakeTimers();
    const page = (anchorId: string, anchorSeq: number) => ({
      historySnapshot: "snap", olderCursor: { anchorId, anchorSeq }, olderRowsSourceSeqEnd: null, returnedSegmentCount: 1,
    });
    const newest = assistantRow("newest", { sourceSeqStart: 60, sourceSeqEnd: 60 });
    const fake = fakeSdk((args, call) => {
      if (call === 1) return timelineResponse([newest], { timelinePage: page("stale", 50) });
      if (args.beforeAnchorId === "stale") throw new Error("HTTP 400 Timeline pagination cursor is no longer available");
      if (args.beforeAnchorId === "fresh") {
        return timelineResponse([
          userRow("old", { sourceSeqStart: 40, sourceSeqEnd: 40 }),
          commandRow("between", { sourceSeqStart: 55, sourceSeqEnd: 55 }),
        ], { timelinePage: page("oldest", 30) });
      }
      return timelineResponse([newest], { timelinePage: page("fresh", 55) });
    });
    const store = makeStore(fake.sdk);
    await settle();
    store.loadOlder();
    await settle();
    expect(fake.calls.map((call) => call.beforeAnchorId)).toEqual([undefined, "stale", undefined, "fresh"]);
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["old", "newest"]);
    expect(store.getSnapshot()).toMatchObject({ hasOlder: true, loadingOlder: false, olderError: null });
    store.loadOlder();
    await settle();
    expect(fake.calls.at(-1)?.beforeAnchorId).toBe("oldest");
  });

  it("shows an older-page error and waits for loadOlder before trying again", async () => {
    // Older pages wait as long as the last request took; a frozen clock makes that no wait at all.
    vi.useFakeTimers();
    const latest = timelineResponse([assistantRow("last")], {
      timelinePage: {
        historySnapshot: "snap", olderCursor: { anchorId: "last", anchorSeq: 10 }, olderRowsSourceSeqEnd: null,
        returnedSegmentCount: 1,
      },
    });
    let failing = true;
    const fake = fakeSdk((args) => {
      if (args.beforeAnchorId === undefined) return latest;
      if (failing) throw new Error("HTTP 500 server busy");
      return timelineResponse([userRow("first")]);
    });
    const store = makeStore(fake.sdk);
    await settle();
    store.setLoadAll(true);
    await settle();
    expect(fake.calls.map((call) => call.beforeAnchorId)).toEqual([undefined, "last", undefined, "last"]);
    expect(store.getSnapshot()).toMatchObject({
      status: "ready", error: null, hasOlder: true, loadingOlder: false, olderError: "HTTP 500 server busy",
    });
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["last"]);
    await settle();
    expect(fake.calls).toHaveLength(4);

    failing = false;
    store.loadOlder();
    expect(store.getSnapshot().olderError).toBeNull();
    await settle();
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["first", "last"]);
    expect(store.getSnapshot()).toMatchObject({ hasOlder: false, olderError: null });
  });

  it("drops an older page that a reload overtook", async () => {
    // Older pages wait as long as the last request took; a frozen clock makes that no wait at all.
    vi.useFakeTimers();
    const pending = deferred<TimelineAnswer>();
    const fake = fakeSdk((args, call) => {
      if (args.beforeAnchorId !== undefined) return pending.promise;
      return timelineResponse([assistantRow(`load-${call}`)], {
        timelinePage: {
          historySnapshot: "snap", olderCursor: { anchorId: "older", anchorSeq: 10 }, olderRowsSourceSeqEnd: null,
          returnedSegmentCount: 1,
        },
      });
    });
    const store = makeStore(fake.sdk);
    await settle();
    store.loadOlder();
    await settle();
    fake.emitThread(["history-rewritten"]);
    pending.resolve(timelineResponse([userRow("stale-older")]));
    await settle();
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["load-3"]);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", hasOlder: true, loadingOlder: false });
  });

  it("throttles a burst to one in-flight refresh and one trailing request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = userRow("first");
    const second = assistantRow("second");
    const pending = deferred<TimelineAnswer>();
    const fake = fakeSdk((_args, call) => {
      if (call === 1) return timelineResponse([first], { maxSeq: 10, tag: "tag-10" });
      if (call === 2) return pending.promise;
      return timelineDelta({ afterTag: "tag-11", tag: "tag-12", maxSeq: 12 });
    });
    const store = makeStore(fake.sdk);
    await settle();
    for (let i = 0; i < 8; i++) fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]).toEqual({ threadId: "thr_1", includeNestedRows: "true", afterTag: "tag-10" });

    for (let i = 0; i < 8; i++) fake.emitThread(["events-appended"]);
    pending.resolve(timelineDelta({
      afterTag: "tag-10", tag: "tag-11", maxSeq: 11, upsertRows: [second], rowOrder: [[0, 1], "second"],
    }));
    await settle();
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(499);
    expect(fake.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]?.afterTag).toBe("tag-11");
  });

  it("applies delta upserts to the latest window and preserves the full list", async () => {
    vi.useFakeTimers();
    const first = userRow("first");
    const original = commandRow("cmd", { output: "old" });
    const updated = commandRow("cmd", { output: "new" });
    const fake = fakeSdk((_args, call) => call === 1
      ? timelineResponse([first, original], { maxSeq: 20 })
      : timelineDelta({ maxSeq: 21, upsertRows: [updated] }));
    const store = makeStore(fake.sdk);
    await settle();
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getSnapshot().rows).toEqual([first, updated]);
    expect(store.getSnapshot().rows[0]).toBe(first);
    expect(fake.calls).toHaveLength(2);
  });

  it("takes a whole window in place of a delta when bb no longer has the log's baseline", async () => {
    vi.useFakeTimers();
    const first = userRow("first");
    const replaced = assistantRow("replaced");
    const fake = fakeSdk((_args, call) => {
      if (call === 1) return timelineResponse([first], { maxSeq: 10 });
      if (call === 2) return timelineResponse([first, replaced], { maxSeq: 11, tag: "tag-2" });
      return timelineDelta({ afterTag: "tag-2", tag: "tag-3" });
    });
    const store = makeStore(fake.sdk);
    await settle();
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getSnapshot().rows).toEqual([first, replaced]);
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls.map((call) => call.afterTag)).toEqual([undefined, "tag-1", "tag-2"]);
  });

  it.each([
    ["names a row it does not send", timelineDelta({ rowOrder: [[0, 1], "missing"] })],
    ["was computed from another window", timelineDelta({ afterTag: "tag-0" })],
  ])("refetches the whole latest window when a delta %s", async (_case, delta) => {
    vi.useFakeTimers();
    const first = userRow("first");
    const added = assistantRow("added");
    const fake = fakeSdk((_args, call) => {
      if (call === 1) return timelineResponse([first], { maxSeq: 10 });
      if (call === 2) return delta;
      return timelineResponse([first, added], { maxSeq: 11, tag: "tag-11" });
    });
    const store = makeStore(fake.sdk);
    await settle();
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls.map((call) => call.afterTag)).toEqual([undefined, "tag-1", undefined]);
    expect(store.getSnapshot().rows).toEqual([first, added]);
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls[3]?.afterTag).toBe("tag-11");
  });

  it("applies older row updates to loaded rows from a whole window, and from a delta only when they change", async () => {
    vi.useFakeTimers();
    const prefix = turnRow("prefix", { children: [commandRow("child-a")] });
    const update = turnRow("prefix", { children: [commandRow("child-b")] });
    const page = {
      historySnapshot: "snap",
      olderCursor: { anchorId: "window", anchorSeq: 20 },
      olderRowsSourceSeqEnd: 20,
      returnedSegmentCount: 1,
    };
    const fake = fakeSdk((args, call) => {
      // The update names a row the log has not loaded yet, so it is left for the older page to carry.
      if (call === 1) return timelineResponse([assistantRow("window")], { maxSeq: 30, timelinePage: { ...page, olderRowUpdates: [update] } });
      if (call === 2) return timelineResponse([prefix], { maxSeq: 20 });
      if (call === 3) return timelineDelta({ afterTag: "tag-1", tag: "tag-2", maxSeq: 31 });
      if (call === 4) {
        return timelineDelta({ afterTag: args.afterTag, tag: "tag-3", maxSeq: 32, fields: { timelinePage: { olderRowUpdates: null } } });
      }
      return timelineDelta({ afterTag: args.afterTag, tag: "tag-4", maxSeq: 33, fields: { timelinePage: { olderRowUpdates: [update] } } });
    });
    const store = makeStore(fake.sdk);
    await settle();
    expect(store.getSnapshot().rows.map((row) => row.id)).toEqual(["window"]);
    store.loadOlder();
    await settle();
    const loaded = store.getSnapshot().rows;
    expect(loaded.map((row) => row.id)).toEqual(["prefix", "window"]);
    expect(childRowsOf(loaded[0]!)?.map((row) => row.id)).toEqual(["child-a"]);

    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls).toHaveLength(3);
    expect(store.getSnapshot().rows).toBe(loaded);
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls).toHaveLength(4);
    expect(store.getSnapshot().rows).toBe(loaded);
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls).toHaveLength(5);
    expect(childRowsOf(store.getSnapshot().rows[0]!)?.map((row) => row.id)).toEqual(["child-a", "child-b"]);
  });

  it("does not load or refresh while the tab is hidden, and catches up once when it shows", async () => {
    vi.useFakeTimers();
    const first = userRow("first");
    const added = assistantRow("added");
    const fake = fakeSdk((_args, call) => call === 1
      ? timelineResponse([first], { maxSeq: 10 })
      : timelineDelta({ maxSeq: 11, upsertRows: [added], rowOrder: [[0, 1], "added"] }));
    const store = makeStore(fake.sdk, 500, false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toHaveLength(0);
    expect(store.getSnapshot().status).toBe("loading");

    store.setVisible(true);
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: "ready", rows: [first] });

    store.setVisible(false);
    for (let i = 0; i < 5; i++) {
      fake.emitThread(["events-appended"]);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(fake.calls).toHaveLength(1);
    expect(fake.eventCalls).toHaveLength(1);

    store.setVisible(true);
    await settle();
    expect(fake.calls).toHaveLength(2);
    expect(store.getSnapshot().rows).toEqual([first, added]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toHaveLength(2);
  });

  it("waits longer between refreshes when the server takes longer to answer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fake = fakeSdk(async (_args, call) => {
      if (call === 1) return timelineResponse([userRow("first")], { maxSeq: 10 });
      // The server takes 400 ms to build this window.
      await new Promise((done) => setTimeout(done, 400));
      return timelineDelta({ afterTag: `tag-${call - 1}`, tag: `tag-${call}` });
    });
    makeStore(fake.sdk);
    await settle();
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(400);
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(1_599);
    expect(fake.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.calls).toHaveLength(3);
  });

  it("reloads on rewritten history and refreshes after reconnect", async () => {
    vi.useFakeTimers();
    const replacement = userRow("replacement");
    const fake = fakeSdk((_args, call) => call === 1
      ? timelineResponse([userRow("original")], { maxSeq: 10 })
      : call === 2
        ? timelineResponse([replacement], { maxSeq: 20 })
        : timelineDelta({ maxSeq: 20 }));
    const store = makeStore(fake.sdk);
    await settle();
    fake.emitThread(["history-rewritten"]);
    await settle();
    expect(fake.calls[1]?.afterTag).toBeUndefined();
    expect(store.getSnapshot().rows).toEqual([replacement]);
    fake.emitConnection(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls).toHaveLength(2);
    fake.emitConnection(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.calls[2]?.afterTag).toBe("tag-1");
  });

  it("reads the latest window a second time when the first read fails, then shows the error, and retry recovers", async () => {
    const fake = fakeSdk((_args, call) => {
      if (call <= 2) throw new Error("HTTP 503 starting up");
      return timelineResponse([userRow("recovered")]);
    });
    const store = makeStore(fake.sdk);
    await settle();
    expect(fake.calls).toHaveLength(2);
    expect(store.getSnapshot()).toMatchObject({ status: "error", rows: [], error: "HTTP 503 starting up" });
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
      return timelineDelta({ maxSeq: 11 });
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
    const pending = deferred<TimelineAnswer>();
    const fake = fakeSdk((_args, call) => call === 1
      ? pending.promise
      : timelineDelta({ maxSeq: 10 }));
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
    const pending = deferred<TimelineAnswer>();
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

  it("reads request events newest first, only back to the oldest loaded row, and further with each older page", async () => {
    // Older pages wait as long as the last request took; a frozen clock makes that no wait at all.
    vi.useFakeTimers();
    const events: ThreadEventRow[] = [
      ...Array.from({ length: 150 }, (_, index) => acceptedEvent(index + 1, `creq_visible_${index}`)),
      requestEvent(200), requestEvent(260), acceptedEvent(262, "creq_260"),
    ];
    const fake = fakeSdk(
      (args) => args.beforeAnchorId
        ? timelineResponse([userRow("older", { sourceSeqStart: 100, sourceSeqEnd: 100 })])
        : timelineResponse([userRow("first", { sourceSeqStart: 255, sourceSeqEnd: 255 })], {
          maxSeq: 300,
          timelinePage: {
            historySnapshot: "snap", olderCursor: { anchorId: "first", anchorSeq: 250 }, olderRowsSourceSeqEnd: null,
            returnedSegmentCount: 1,
          },
        }),
      eventServer(events),
    );
    const store = makeStore(fake.sdk);
    await settle();

    const query = { threadId: "thr_1", types: ["client/turn/requested", "turn/input/accepted", "client/turn/rejected"], limit: "100" };
    expect(fake.eventCalls).toEqual([{ ...query, order: "desc" }]);
    expect(store.getSnapshot()).toMatchObject({ status: "ready", hiddenError: null });
    expect(store.getSnapshot().hidden.map(({ id, seq }) => [id, seq])).toEqual([["hidden:creq_260", 262]]);

    store.loadOlder();
    await settle();
    expect(fake.eventCalls).toEqual([{ ...query, order: "desc" }, { ...query, order: "desc", beforeSeq: "54" }]);
    expect(store.getSnapshot().hidden.map(({ id, seq }) => [id, seq])).toEqual([["hidden:creq_200", 200], ["hidden:creq_260", 262]]);
  });

  it("reads new request events with each refresh and settles a steer once it is accepted", async () => {
    vi.useFakeTimers();
    const events: ThreadEventRow[] = [requestEvent(20)];
    const fake = fakeSdk(
      (_args, call) => call === 1
        ? timelineResponse([userRow("first")], { maxSeq: 20 })
        : timelineDelta({ maxSeq: 30 }),
      eventServer(events),
    );
    const store = makeStore(fake.sdk);
    await settle();
    const pendingSteer = store.getSnapshot().hidden;
    expect(pendingSteer.map(({ seq }) => seq)).toEqual([20]);

    events.push(acceptedEvent(22, "creq_20"));
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.eventCalls.map(eventRead)).toEqual(["newest", "after 20"]);
    expect(store.getSnapshot().hidden.map(({ seq }) => seq)).toEqual([22]);

    const settledSteer = store.getSnapshot().hidden;
    fake.emitThread(["events-appended"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.eventCalls.map(eventRead)).toEqual(["newest", "after 20", "after 22"]);
    expect(store.getSnapshot().hidden).toBe(settledSteer);
  });

  it("keeps the log usable when request events fail, then reads the newest ones again", async () => {
    vi.useFakeTimers();
    const fake = fakeSdk(
      (_args, call) => call === 1
        ? timelineResponse([userRow("first")], { maxSeq: 20 })
        : timelineDelta({ maxSeq: 30 }),
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
    expect(fake.eventCalls.map(eventRead)).toEqual(["newest", "newest"]);
    expect(store.getSnapshot()).toMatchObject({ hiddenError: null });
    expect(store.getSnapshot().hidden.map(({ id }) => id)).toEqual(["hidden:creq_25"]);
  });

  it("rereads request events from the newest when history is rewritten", async () => {
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
    expect(fake.eventCalls.map(eventRead)).toEqual(["newest", "newest"]);
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
