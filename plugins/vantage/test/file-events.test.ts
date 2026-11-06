import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileEventGate } from "../src/file-events";

interface Row { seq: number; type: string; data: { item: { type: string } } }
const item = (seq: number, type: string): Row => ({ seq, type: "item/completed", data: { item: { type } } });
type ListArgs = { threadId: string; afterSeq?: string; order?: string };

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
// A macrotask turn lets every promise that can settle settle, with no timing to tune.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(options: { rows?: Row[]; cached?: (threadId: string) => boolean; list?: (args: ListArgs) => Promise<Row[]>; timeoutMs?: number; maxCursors?: number } = {}) {
  const rows = options.rows ?? [];
  const lists: ListArgs[] = [];
  const invalidated: string[] = [];
  const gate = createFileEventGate(
    {
      threads: { events: { list: (async (args: ListArgs) => {
        lists.push(args);
        if (options.list !== undefined) return options.list(args);
        const found = rows.filter((row) => row.seq > Number(args.afterSeq ?? 0));
        return args.order === "desc" ? found.reverse() : found;
      }) as never } },
    },
    { invalidate: (threadId) => { invalidated.push(threadId); }, hasThread: options.cached ?? (() => true), timeoutMs: options.timeoutMs, maxCursors: options.maxCursors },
  );
  return { gate, lists, invalidated, rows };
}
const COMPLETED = ["item/completed"];
const append = ["events-appended"];

afterEach(() => { vi.useRealTimers(); });

describe("createFileEventGate", () => {
  it("counts the first completed item of a thread as a change and keeps later messages", async () => {
    const { gate, invalidated, rows } = setup({ rows: [item(1, "agentMessage")] });
    gate.handle("thr_1", append, COMPLETED);
    await gate.pending(["thr_1"]);
    expect(invalidated).toEqual(["thr_1"]);
    rows.push(item(2, "agentMessage"));
    gate.handle("thr_1", append, COMPLETED);
    await gate.pending(["thr_1"]);
    expect(invalidated).toEqual(["thr_1"]);
  });

  it("invalidates for an item of a type it does not know", async () => {
    const { gate, invalidated, rows } = setup({ rows: [item(1, "agentMessage")] });
    gate.handle("thr_1", [], COMPLETED);
    await gate.pending(["thr_1"]);
    rows.push(item(2, "hologram"));
    gate.handle("thr_1", [], COMPLETED);
    await gate.pending(["thr_1"]);
    expect(invalidated).toEqual(["thr_1", "thr_1"]);
  });

  it("reads nothing for a thread nothing is cached for", async () => {
    const { gate, lists, invalidated } = setup({ cached: () => false });
    for (let index = 0; index < 5; index++) gate.handle("thr_1", append, COMPLETED);
    expect([lists, invalidated, gate.pending(["thr_1"])]).toEqual([[], [], null]);
  });

  it("reads nothing for events that carry no completed item", async () => {
    const { gate, lists, invalidated } = setup();
    gate.handle("thr_1", append, ["item/agentMessage/delta"]);
    gate.handle("thr_1", append, ["turn/completed"]);
    expect([invalidated, lists]).toEqual([["thr_1"], []]);
  });

  it("invalidates at once after a history rewrite, whatever the types say", () => {
    const { gate, invalidated, lists } = setup();
    gate.handle("thr_1", ["history-rewritten"], ["thread/tokenUsage/updated"]);
    expect([invalidated, lists]).toEqual([["thr_1"], []]);
  });

  it("stores a baseline for a thread with no items yet, so the next event reads only what is new", async () => {
    const { gate, lists } = setup();
    gate.handle("thr_1", append, COMPLETED);
    await gate.pending(["thr_1"]);
    gate.handle("thr_1", append, COMPLETED);
    await gate.pending(["thr_1"]);
    expect(lists.map((args) => [args.order, args.afterSeq])).toEqual([["desc", undefined], ["asc", "0"]]);
  });

  it("reads once at a time per thread, and once more for any number of events that came in meanwhile", async () => {
    const first = deferred<Row[]>();
    const { gate, lists } = setup({ list: (args) => (lists.length === 1 ? first.promise : Promise.resolve([])) });
    gate.handle("thr_1", append, COMPLETED);
    gate.handle("thr_1", append, COMPLETED);
    gate.handle("thr_1", append, COMPLETED);
    gate.handle("thr_1", append, COMPLETED);
    await flush();
    expect(lists).toHaveLength(1);
    first.resolve([]);
    await gate.pending(["thr_1"]);
    await flush();
    expect(lists).toHaveLength(2);
    expect(gate.pending(["thr_1"])).toBeNull();
  });

  it("makes a waiter wait for a read that started after its event, not only the one in flight", async () => {
    const first = deferred<Row[]>();
    const second = deferred<Row[]>();
    const { gate, lists } = setup({ list: () => (lists.length === 1 ? first.promise : second.promise) });
    gate.handle("thr_1", append, COMPLETED);
    gate.handle("thr_1", append, COMPLETED);
    let done = false;
    void gate.pending(["thr_1"])!.then(() => { done = true; });
    first.resolve([item(1, "agentMessage")]);
    await flush();
    expect(done).toBe(false);
    second.resolve([]);
    await flush();
    expect(done).toBe(true);
  });

  it("holds back only the thread whose read is undecided", async () => {
    const hung = deferred<Row[]>();
    const { gate, invalidated } = setup({ list: (args) => (args.threadId === "thr_slow" ? hung.promise : Promise.resolve([])) });
    gate.handle("thr_slow", append, COMPLETED);
    gate.handle("thr_fast", append, COMPLETED);
    expect(gate.pending(["thr_other"])).toBeNull();
    await gate.pending(["thr_fast"]);
    expect(invalidated).toEqual(["thr_fast"]);
    let slowDone = false;
    void gate.pending(["thr_fast", "thr_slow"])!.then(() => { slowDone = true; });
    await flush();
    expect(slowDone).toBe(false);
    hung.resolve([]);
    await flush();
    expect(slowDone).toBe(true);
    expect(invalidated).toEqual(["thr_fast", "thr_slow"]);
  });

  it("gives up on a read that hangs, counts it as a change and releases the waiters", async () => {
    vi.useFakeTimers();
    const { gate, invalidated } = setup({ list: () => new Promise<Row[]>(() => {}), timeoutMs: 5000 });
    gate.handle("thr_1", append, COMPLETED);
    let done = false;
    void gate.pending(["thr_1"])!.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect([done, invalidated]).toEqual([true, ["thr_1"]]);
  });

  it("ignores a response that arrives after its read timed out, so it cannot move the cursor", async () => {
    vi.useFakeTimers();
    const late = deferred<Row[]>();
    let call = 0;
    const { gate, invalidated, lists } = setup({
      timeoutMs: 5000,
      list: (args) => {
        call++;
        if (call === 1) return late.promise;
        return Promise.resolve(args.order === "desc" ? [item(2, "agentMessage")] : []);
      },
    });
    gate.handle("thr_1", append, COMPLETED);
    await vi.advanceTimersByTimeAsync(5000);
    expect(invalidated).toEqual(["thr_1"]);
    gate.handle("thr_1", append, COMPLETED);
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidated).toEqual(["thr_1", "thr_1"]);
    late.resolve([item(3, "commandExecution")]);
    await vi.advanceTimersByTimeAsync(0);
    gate.handle("thr_1", append, COMPLETED);
    await vi.advanceTimersByTimeAsync(0);
    expect(lists.at(-1)).toMatchObject({ order: "asc", afterSeq: "2" });
    expect(invalidated).toEqual(["thr_1", "thr_1"]);
  });

  it("aborts the request of a read that timed out", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { gate } = setup({ timeoutMs: 5000, list: (args) => { signals.push((args as unknown as { signal: AbortSignal }).signal); return new Promise<Row[]>(() => {}); } });
    gate.handle("thr_1", append, COMPLETED);
    await vi.advanceTimersByTimeAsync(4999);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("ignores a response that arrives after a history reset, so it cannot move the cursor or invalidate again", async () => {
    const inFlight = deferred<Row[]>();
    let call = 0;
    const { gate, invalidated, lists } = setup({ list: () => (++call === 1 ? inFlight.promise : Promise.resolve([item(1, "agentMessage")])) });
    gate.handle("thr_1", append, COMPLETED);
    await flush();
    gate.handle("thr_1", ["history-rewritten"], undefined);
    expect(invalidated).toEqual(["thr_1"]);
    inFlight.resolve([item(9, "commandExecution")]);
    await gate.pending(["thr_1"]);
    await flush();
    expect(invalidated).toEqual(["thr_1"]);
    gate.handle("thr_1", append, COMPLETED);
    await gate.pending(["thr_1"]);
    expect(lists.at(-1)).toMatchObject({ order: "desc" });
  });

  it("keeps a cursor for the most recently read threads only", async () => {
    const { gate, lists, invalidated } = setup({ maxCursors: 2 });
    for (const id of ["thr_a", "thr_b", "thr_c"]) {
      gate.handle(id, append, COMPLETED);
      await gate.pending([id]);
    }
    expect(invalidated).toEqual(["thr_a", "thr_b", "thr_c"]);
    lists.length = 0;
    for (const id of ["thr_c", "thr_a"]) {
      gate.handle(id, append, COMPLETED);
      await gate.pending([id]);
    }
    expect(lists.map((args) => [args.threadId, args.order])).toEqual([["thr_c", "asc"], ["thr_a", "desc"]]);
    expect(invalidated).toEqual(["thr_a", "thr_b", "thr_c", "thr_a"]);
  });

  it("counts a failed read as a change and starts over with a new baseline", async () => {
    let fail = true;
    const { gate, invalidated, lists } = setup({ list: async () => { if (fail) throw new Error("down"); return []; } });
    gate.handle("thr_1", append, COMPLETED);
    await gate.pending(["thr_1"]);
    fail = false;
    gate.handle("thr_1", append, COMPLETED);
    await gate.pending(["thr_1"]);
    expect(invalidated).toEqual(["thr_1", "thr_1"]);
    expect(lists.map((args) => args.order)).toEqual(["desc", "desc"]);
  });
});
