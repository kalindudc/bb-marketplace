import { describe, expect, it } from "vitest";
import type { Prefs } from "../src/contract";
import { createPrefsStore, type KvStorage } from "../src/prefs-store";
import { DEFAULT_PREFS, parentLookup, resolvePref, toggleInput } from "../src/prefs";
import { watchedAttention } from "../src/notify";
import { sidebarThread } from "./fixtures";

const parentOf = parentLookup([{ id: "child", parentThreadId: "root" }, { id: "grandchild", parentThreadId: "child" }, { id: "root", parentThreadId: null }]);
const prefs = (threads: Prefs["threads"], defaults: Partial<Prefs> = {}): Prefs => ({ ...DEFAULT_PREFS, ...defaults, threads });

describe("resolvePref", () => {
  it("watches nothing and tracks no reviews by default", () => {
    expect(resolvePref(DEFAULT_PREFS, "watch", "child", parentOf)).toEqual({ on: false, from: "default", threadId: null });
    expect(resolvePref(DEFAULT_PREFS, "reviews", "child", parentOf).on).toBe(false);
  });

  it("follows the setting when a thread has made no choice", () => {
    expect(resolvePref(prefs({}, { watchByDefault: true }), "watch", "child", parentOf).on).toBe(true);
  });

  it("covers a whole tree once its root opts in, and lets a child opt out again", () => {
    const rooted = prefs({ root: { watch: true } });
    expect(resolvePref(rooted, "watch", "grandchild", parentOf)).toEqual({ on: true, from: "ancestor", threadId: "root" });
    const optedOut = prefs({ root: { watch: true }, child: { watch: false } });
    expect(resolvePref(optedOut, "watch", "grandchild", parentOf)).toEqual({ on: false, from: "ancestor", threadId: "child" });
    expect(resolvePref(optedOut, "watch", "child", parentOf)).toEqual({ on: false, from: "thread", threadId: "child" });
  });

  it("keeps watching and reviews apart", () => {
    expect(resolvePref(prefs({ root: { watch: true } }), "reviews", "root", parentOf).on).toBe(false);
  });

  it("stops on a parent loop instead of running forever", () => {
    const loop = parentLookup([{ id: "a", parentThreadId: "b" }, { id: "b", parentThreadId: "a" }]);
    expect(resolvePref(DEFAULT_PREFS, "watch", "a", loop).from).toBe("default");
  });
});

describe("toggleInput", () => {
  it("writes the thread's own choice when it differs from what it inherits", () => {
    expect(toggleInput(DEFAULT_PREFS, "watch", "child", parentOf)).toEqual({ threadId: "child", watch: true });
  });

  it("clears the thread's own choice when turning it back to what it inherits", () => {
    expect(toggleInput(prefs({ child: { reviews: true } }), "reviews", "child", parentOf)).toEqual({ threadId: "child", reviews: null });
  });

  it("writes false to opt a child out of a watched tree", () => {
    expect(toggleInput(prefs({ root: { watch: true } }), "watch", "child", parentOf)).toEqual({ threadId: "child", watch: false });
  });
});

function memoryKv(): KvStorage & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    set: async (key, value) => { rows.set(key, JSON.parse(JSON.stringify(value))); },
    delete: async (key) => { rows.delete(key); },
  };
}

describe("createPrefsStore", () => {
  it("keeps each thread's fields and drops a thread with none left", async () => {
    const kv = memoryKv();
    const store = createPrefsStore(() => kv);
    await store.setThreadPref({ threadId: "a", watch: true });
    expect(await store.setThreadPref({ threadId: "a", reviews: true })).toEqual({ a: { watch: true, reviews: true } });
    expect(await store.setThreadPref({ threadId: "a", watch: null, reviews: null })).toEqual({});
  });

  it("does not lose a write when two arrive together", async () => {
    const kv = memoryKv();
    const store = createPrefsStore(() => kv);
    await Promise.all([store.setThreadPref({ threadId: "a", watch: true }), store.setThreadPref({ threadId: "b", watch: true })]);
    expect(await store.threadPrefs()).toEqual({ a: { watch: true }, b: { watch: true } });
  });

  it("ignores a stored row it cannot read", async () => {
    const kv = memoryKv();
    kv.rows.set("prefs", { a: { watch: "yes" }, b: { reviews: true } });
    kv.rows.set("reviewed:w", ["not", "a", "record"]);
    const store = createPrefsStore(() => kv);
    expect(await store.threadPrefs()).toEqual({ b: { reviews: true } });
    expect(await store.reviewed(["w"])).toEqual({ w: {} });
  });

  it("keeps a marks row under bb's byte limit even when the paths are not ASCII", async () => {
    const kv = memoryKv();
    const store = createPrefsStore(() => kv);
    const marks = Array.from({ length: 2000 }, (_, index) => ({ mark: `uncommitted\0文档/说明-${index}-${"漢".repeat(20)}.md`, signature: "m:1:0:" }));
    for (let start = 0; start < marks.length; start += 500) await store.setReviewed({ key: "w", marks: marks.slice(start, start + 500) });
    expect(new TextEncoder().encode(JSON.stringify(kv.rows.get("reviewed:w"))).length).toBeLessThanOrEqual(200_000);
  });

  it("keeps every good mark when one stored mark is bad, and drops a stored thread id that is too long", async () => {
    const kv = memoryKv();
    kv.rows.set("reviewed:w", { "uncommitted\0a.ts": "m:1:0:", "uncommitted\0b.ts": "x".repeat(300) });
    kv.rows.set("prefs", { ["t".repeat(5000)]: { watch: true }, ok: { watch: true } });
    const store = createPrefsStore(() => kv);
    expect(await store.reviewed(["w"])).toEqual({ w: { "uncommitted\0a.ts": "m:1:0:" } });
    expect(await store.threadPrefs()).toEqual({ ok: { watch: true } });
  });

  it("keeps the newest marks when a worktree has more than fit, and deletes an empty row", async () => {
    const kv = memoryKv();
    const store = createPrefsStore(() => kv);
    const marks = Array.from({ length: 2100 }, (_, index) => ({ mark: `uncommitted\0f${index}`, signature: "m:1:0:" }));
    for (let start = 0; start < marks.length; start += 500) await store.setReviewed({ key: "w", marks: marks.slice(start, start + 500) });
    const kept = Object.keys((await store.reviewed(["w"])).w!);
    expect(kept).toHaveLength(2000);
    expect(kept[0]).toBe("uncommitted\0f100");
    await store.setReviewed({ key: "w", marks: kept.map((mark) => ({ mark, signature: null })) });
    expect(kv.rows.has("reviewed:w")).toBe(false);
  });
});

describe("watchedAttention", () => {
  const live = new Map([
    ["root", sidebarThread({ id: "root", displayTitle: "Root" })],
    ["child", sidebarThread({ id: "child", displayTitle: "Child", parentThreadId: "root", indicator: "waiting-for-input" })],
    ["other", sidebarThread({ id: "other", displayTitle: "Other", indicator: "unread-error" })],
    ["gone", sidebarThread({ id: "gone", displayTitle: "Gone", parentThreadId: "root", indicator: "waiting-for-input", isArchived: true })],
  ]);

  it("is empty until a thread is watched", () => {
    expect(watchedAttention(live, DEFAULT_PREFS)).toEqual([]);
  });

  it("lists the waiting and failed threads of watched trees, never archived ones", () => {
    expect(watchedAttention(live, prefs({ root: { watch: true } }))).toEqual([{ id: "child", title: "Child", failed: false }]);
    expect(watchedAttention(live, prefs({}, { watchByDefault: true })).map((entry) => [entry.id, entry.failed])).toEqual([["child", false], ["other", true]]);
  });
});
