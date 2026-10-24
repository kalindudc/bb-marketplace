import { describe, expect, it } from "vitest";
import { attentionOf, toastsFor } from "../src/notify";
import { createReviewStore, type KvStorage } from "../src/review-store";
import { sidebarThread } from "./fixtures";

function memoryKv(): KvStorage & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    set: async (key, value) => { rows.set(key, JSON.parse(JSON.stringify(value))); },
    delete: async (key) => { rows.delete(key); },
  };
}

describe("createReviewStore", () => {
  it("does not lose a mark when two writes to one worktree arrive together", async () => {
    const kv = memoryKv();
    const store = createReviewStore(() => kv);
    await Promise.all([
      store.setReviewed({ key: "w", marks: [{ mark: "uncommitted\0a.ts", signature: "m:1:0:" }] }),
      store.setReviewed({ key: "w", marks: [{ mark: "uncommitted\0b.ts", signature: "m:2:0:" }] }),
    ]);
    expect(await store.reviewed(["w"])).toEqual({ w: { "uncommitted\0a.ts": "m:1:0:", "uncommitted\0b.ts": "m:2:0:" } });
  });

  it("ignores a stored row it cannot read", async () => {
    const kv = memoryKv();
    kv.rows.set("reviewed:w", ["not", "a", "record"]);
    const store = createReviewStore(() => kv);
    expect(await store.reviewed(["w"])).toEqual({ w: {} });
  });

  it("keeps a marks row under bb's byte limit even when the paths are not ASCII", async () => {
    const kv = memoryKv();
    const store = createReviewStore(() => kv);
    const marks = Array.from({ length: 2000 }, (_, index) => ({ mark: `uncommitted\0文档/说明-${index}-${"漢".repeat(20)}.md`, signature: "m:1:0:" }));
    for (let start = 0; start < marks.length; start += 500) await store.setReviewed({ key: "w", marks: marks.slice(start, start + 500) });
    expect(new TextEncoder().encode(JSON.stringify(kv.rows.get("reviewed:w"))).length).toBeLessThanOrEqual(200_000);
  });

  it("keeps every good mark when one stored mark is bad", async () => {
    const kv = memoryKv();
    kv.rows.set("reviewed:w", { "uncommitted\0a.ts": "m:1:0:", "uncommitted\0b.ts": "x".repeat(300) });
    const store = createReviewStore(() => kv);
    expect(await store.reviewed(["w"])).toEqual({ w: { "uncommitted\0a.ts": "m:1:0:" } });
  });

  it("keeps the newest marks when a worktree has more than fit, and deletes an empty row", async () => {
    const kv = memoryKv();
    const store = createReviewStore(() => kv);
    const marks = Array.from({ length: 2100 }, (_, index) => ({ mark: `uncommitted\0f${index}`, signature: "m:1:0:" }));
    for (let start = 0; start < marks.length; start += 500) await store.setReviewed({ key: "w", marks: marks.slice(start, start + 500) });
    const kept = Object.keys((await store.reviewed(["w"])).w!);
    expect(kept).toHaveLength(2000);
    expect(kept[0]).toBe("uncommitted\0f100");
    await store.setReviewed({ key: "w", marks: kept.map((mark) => ({ mark, signature: null })) });
    expect(kv.rows.has("reviewed:w")).toBe(false);
  });
});

describe("attentionOf", () => {
  const live = new Map([
    ["root", sidebarThread({ id: "root", displayTitle: "Root" })],
    ["child", sidebarThread({ id: "child", displayTitle: "Child", parentThreadId: "root", indicator: "waiting-for-input" })],
    ["other", sidebarThread({ id: "other", displayTitle: "Other", indicator: "unread-error" })],
    ["gone", sidebarThread({ id: "gone", displayTitle: "Gone", parentThreadId: "root", indicator: "waiting-for-input", isArchived: true })],
  ]);

  it("lists every thread that waits for you or failed, never an archived one", () => {
    expect(attentionOf(live)).toEqual([{ id: "child", title: "Child", failed: false }, { id: "other", title: "Other", failed: true }]);
  });
});

describe("toastsFor", () => {
  const waiting = [{ id: "a", title: "A", failed: false }, { id: "b", title: "B", failed: true }];

  it("toasts nothing on the first look, which bb's sidebar already shows", () => {
    expect(toastsFor(null, waiting, null, true)).toEqual([]);
  });

  it("toasts only threads that started waiting since the last look, and not the one on screen", () => {
    expect(toastsFor(new Set(["a"]), waiting, null, true).map((entry) => entry.id)).toEqual(["b"]);
    expect(toastsFor(new Set(), waiting, "a", true).map((entry) => entry.id)).toEqual(["b"]);
  });

  it("toasts nothing while toasts are off", () => {
    expect(toastsFor(new Set(), waiting, null, false)).toEqual([]);
  });
});
