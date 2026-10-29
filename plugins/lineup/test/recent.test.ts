import { describe, expect, it, vi } from "vitest";
import { collectRecent, MAX_THREADS_SCANNED, ThreadModelCache, type ThreadSummary } from "../src/recent";

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

  it("reads at most MAX_THREADS_SCANNED threads", async () => {
    const many = Array.from({ length: MAX_THREADS_SCANNED + 50 }, (_, n) => ({ id: `t${n}`, providerId: "pi", updatedAt: n }));
    const lookup = vi.fn(async () => "same");
    await collectRecent(many, new ThreadModelCache(lookup), 25);
    expect(lookup).toHaveBeenCalledTimes(MAX_THREADS_SCANNED);
  });
});
