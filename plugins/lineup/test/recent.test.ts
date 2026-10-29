import { describe, expect, it, vi } from "vitest";
import {
  collectRecent,
  listAllThreads,
  MAX_THREAD_PAGES,
  MAX_THREADS_SCANNED,
  THREAD_PAGE_SIZE,
  ThreadModelCache,
  type ThreadSummary,
} from "../src/recent";

const threads: ThreadSummary[] = [
  { id: "old", providerId: "codex", updatedAt: 100 },
  { id: "new", providerId: "pi", updatedAt: 300 },
  { id: "mid", providerId: "pi", updatedAt: 200 },
  { id: "none", providerId: "pi", updatedAt: 250 },
];
const models: Record<string, string | null> = { old: "gpt-5.5", new: "openai/gpt-5.5", mid: "openai/gpt-5.5", none: null };

describe("collectRecent", () => {
  it("lists distinct models newest first and skips threads with no model", async () => {
    const cache = new ThreadModelCache(async (id) => models[id] ?? null);
    expect(await collectRecent(threads, cache, 25)).toEqual([
      { providerId: "pi", model: "openai/gpt-5.5", usedAt: 300 },
      { providerId: "codex", model: "gpt-5.5", usedAt: 100 },
    ]);
  });

  it("stops at the limit", async () => {
    const lookup = vi.fn(async (id: string) => models[id] ?? null);
    const result = await collectRecent(threads, new ThreadModelCache(lookup), 1);
    expect(result).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("asks again only about threads that changed", async () => {
    const lookup = vi.fn(async (id: string) => models[id] ?? null);
    const cache = new ThreadModelCache(lookup);
    await collectRecent(threads, cache, 25);
    expect(lookup).toHaveBeenCalledTimes(4);
    await collectRecent(threads.map((t) => (t.id === "mid" ? { ...t, updatedAt: 400 } : t)), cache, 25);
    expect(lookup).toHaveBeenCalledTimes(5);
    expect(lookup).toHaveBeenLastCalledWith("mid");
  });

  it("skips a thread whose lookup fails, reports it, and asks again next time", async () => {
    const failures: string[] = [];
    let broken = true;
    const cache = new ThreadModelCache(
      async (id) => {
        if (id === "new" && broken) throw new Error("thread not found");
        return models[id] ?? null;
      },
      (thread, error) => failures.push(`${thread.id}: ${(error as Error).message}`),
    );
    expect(await collectRecent(threads, cache, 25)).toEqual([
      { providerId: "pi", model: "openai/gpt-5.5", usedAt: 200 },
      { providerId: "codex", model: "gpt-5.5", usedAt: 100 },
    ]);
    expect(failures).toEqual(["new: thread not found"]);
    broken = false;
    expect((await collectRecent(threads, cache, 25))[0]).toEqual({ providerId: "pi", model: "openai/gpt-5.5", usedAt: 300 });
  });

  it("reads at most MAX_THREADS_SCANNED threads", async () => {
    const many = Array.from({ length: MAX_THREADS_SCANNED + 50 }, (_, n) => ({ id: `t${n}`, providerId: "pi", updatedAt: n }));
    const lookup = vi.fn(async () => "same");
    await collectRecent(many, new ThreadModelCache(lookup), 25);
    expect(lookup).toHaveBeenCalledTimes(MAX_THREADS_SCANNED);
  });
});

describe("listAllThreads", () => {
  const many = Array.from({ length: THREAD_PAGE_SIZE * 2 + 7 }, (_, n) => ({ id: `t${n}`, providerId: "pi", updatedAt: n, title: "x" }));

  it("reads page after page until a short page, keeping only the summaries", async () => {
    const pages: Array<[number, number]> = [];
    const all = await listAllThreads(async (offset, limit) => {
      pages.push([offset, limit]);
      return many.slice(offset, offset + limit);
    });
    expect(pages).toEqual([
      [0, THREAD_PAGE_SIZE],
      [THREAD_PAGE_SIZE, THREAD_PAGE_SIZE],
      [THREAD_PAGE_SIZE * 2, THREAD_PAGE_SIZE],
    ]);
    expect(all).toHaveLength(many.length);
    expect(all[0]).toEqual({ id: "t0", providerId: "pi", updatedAt: 0 });
  });

  it("finds the newest threads wherever bb's order puts them", async () => {
    const shuffled = [...many].reverse().map((thread, n) => ({ ...thread, updatedAt: n === THREAD_PAGE_SIZE + 3 ? 1e12 : thread.updatedAt }));
    const all = await listAllThreads(async (offset, limit) => shuffled.slice(offset, offset + limit));
    const recent = await collectRecent(all, new ThreadModelCache(async (id) => `model-${id}`), 1);
    expect(recent[0]!.usedAt).toBe(1e12);
  });

  it("stops when a server ignores the offset and repeats a page", async () => {
    const page = vi.fn(async () => many.slice(0, THREAD_PAGE_SIZE));
    expect(await listAllThreads(page)).toHaveLength(THREAD_PAGE_SIZE);
    expect(page).toHaveBeenCalledTimes(2);
    expect(MAX_THREAD_PAGES).toBeGreaterThan(2);
  });
});
