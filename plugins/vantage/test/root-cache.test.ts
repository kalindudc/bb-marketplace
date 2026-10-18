import { describe, expect, it } from "vitest";
import { createRootCache } from "../src/root-cache";

function setup(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let now = 1_000;
  const cache = createRootCache({ ...options, now: () => now });
  return { cache, advance: (ms: number) => { now += ms; } };
}

const entry = { root: "/work/repo", relative: "src" };

describe("createRootCache", () => {
  it("peeks a stored path and does not list it as missing", () => {
    const { cache } = setup();
    cache.store("host_1", "/work/repo/src", entry);
    expect(cache.peek("host_1", "/work/repo/src")).toEqual(entry);
    expect(cache.missing("host_1", ["/work/repo/src"])).toEqual([]);
  });

  it("lists only the paths it does not know, per machine", () => {
    const { cache } = setup();
    cache.store("host_1", "/a", entry);
    expect(cache.missing("host_1", ["/a", "/b", "/c"])).toEqual(["/b", "/c"]);
    expect(cache.missing("host_2", ["/a"])).toEqual(["/a"]);
    expect(cache.peek("host_2", "/a")).toBeUndefined();
  });

  it("forgets an entry once it is ten minutes old by default", () => {
    const { cache, advance } = setup();
    cache.store("host_1", "/a", entry);
    advance(10 * 60_000 - 1);
    expect(cache.peek("host_1", "/a")).toEqual(entry);
    advance(1);
    expect(cache.peek("host_1", "/a")).toBeUndefined();
    expect(cache.missing("host_1", ["/a"])).toEqual(["/a"]);
  });

  it("honours a custom time to live and restarts it when a path is stored again", () => {
    const { cache, advance } = setup({ ttlMs: 1_000 });
    cache.store("host_1", "/a", entry);
    advance(800);
    cache.store("host_1", "/a", entry);
    advance(800);
    expect(cache.peek("host_1", "/a")).toEqual(entry);
    advance(200);
    expect(cache.peek("host_1", "/a")).toBeUndefined();
  });

  it("drops the oldest entries beyond the cap", () => {
    const { cache } = setup({ maxEntries: 2 });
    cache.store("host_1", "/a", entry);
    cache.store("host_1", "/b", entry);
    cache.store("host_1", "/c", entry);
    expect(cache.peek("host_1", "/a")).toBeUndefined();
    expect(cache.peek("host_1", "/b")).toEqual(entry);
    expect(cache.peek("host_1", "/c")).toEqual(entry);
  });

  it("counts a path stored again as the newest when the cap drops entries", () => {
    const { cache } = setup({ maxEntries: 2 });
    cache.store("host_1", "/a", entry);
    cache.store("host_1", "/b", entry);
    cache.store("host_1", "/a", entry);
    cache.store("host_1", "/c", entry);
    expect(cache.peek("host_1", "/b")).toBeUndefined();
    expect(cache.peek("host_1", "/a")).toEqual(entry);
  });

  it("keeps paths outside git as null roots", () => {
    const { cache } = setup();
    cache.store("host_1", "/tmp/x", { root: null, relative: null });
    expect(cache.peek("host_1", "/tmp/x")).toEqual({ root: null, relative: null });
    expect(cache.missing("host_1", ["/tmp/x"])).toEqual([]);
  });

  it("keeps a machine id and a path apart even when they could run together", () => {
    const { cache } = setup();
    cache.store("a", "b/c", entry);
    expect(cache.peek("a/b", "c")).toBeUndefined();
  });

  it("clears everything", () => {
    const { cache } = setup();
    cache.store("host_1", "/a", entry);
    cache.clear();
    expect(cache.peek("host_1", "/a")).toBeUndefined();
    expect(cache.missing("host_1", ["/a"])).toEqual(["/a"]);
  });
});
