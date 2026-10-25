import { describe, expect, it } from "vitest";
import { rowTime, sortPrs } from "../../src/ui/sort";
import { DAY, HOUR, mine, NOW } from "./helpers";

const a = mine({ repo: "Shopify/edgey", number: 7, createdAt: NOW - 3 * DAY, updatedAt: NOW - HOUR, additions: 10, deletions: 5 });
const b = mine({ repo: "get-bb/bb", number: 12, createdAt: NOW - DAY, updatedAt: NOW - 2 * HOUR, additions: 400, deletions: 300 });
const c = mine({ repo: "get-bb/bb", number: 30, createdAt: null, updatedAt: NOW - 3 * HOUR, additions: null, deletions: null });
const keys = (prs: readonly { key: string }[]) => prs.map((pr) => pr.key);

describe("sorting PRs", () => {
  it("sorts by when they opened either way, with unknown times last both ways", () => {
    expect(keys(sortPrs([a, b, c], "newest"))).toEqual([b.key, a.key, c.key]);
    expect(keys(sortPrs([c, b, a], "oldest"))).toEqual([a.key, b.key, c.key]);
  });

  it("sorts by last update, repository and size", () => {
    expect(keys(sortPrs([c, a, b], "updated"))).toEqual([a.key, b.key, c.key]);
    // Repository names compare without case; the newest number comes first within one.
    expect(keys(sortPrs([a, b, c], "repo"))).toEqual([c.key, b.key, a.key]);
    expect(keys(sortPrs([c, a, b], "size"))).toEqual([b.key, a.key, c.key]);
  });

  it("breaks ties by the most recent update, so rows keep their places", () => {
    const twin = mine({ number: 99, createdAt: a.createdAt, updatedAt: NOW - 10 * 60_000 });
    expect(keys(sortPrs([a, twin], "newest"))).toEqual([twin.key, a.key]);
  });

  it("does not change the list it was given", () => {
    const list = [c, a, b];
    sortPrs(list, "newest");
    expect(keys(list)).toEqual([c.key, a.key, b.key]);
  });

  it("shows the time the list is sorted by", () => {
    expect(rowTime(a, "updated")).toBe("1h");
    expect(rowTime(a, "newest")).toBe("opened 3d ago");
    expect(rowTime(c, "oldest")).toBeNull();
    expect(rowTime(mine({ state: "merged", closedAt: NOW - 2 * HOUR }), "closed")).toBe("merged 2h ago");
    expect(rowTime(mine({ state: "closed", closedAt: NOW - DAY }), "closed")).toBe("closed 1d ago");
  });
});
