import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../../src/config";
import { PROMPT_VARIABLES } from "../../src/templates";
import { CONVERSATION_OPERATIONS, MANAGE_OPERATIONS, OPERATION_LABELS, READ_OPERATIONS } from "../../src/ui/constants";
import { checkName, duration, initials, keyLabel, sizeOf } from "../../src/ui/format";
import { formatRoute, parseRoute } from "../../src/ui/route";
import { sampleReviewVariables } from "../../src/ui/settings/prompt";

const key = "delta:shop/world#2261179";

describe("page routes", () => {
  it("reads and writes the four areas, a selected PR in each, and a looked-up PR", () => {
    expect(parseRoute("")).toEqual({ view: "inbox", key: null });
    expect(parseRoute("mine")).toEqual({ view: "mine", key: null });
    expect(parseRoute("done")).toEqual({ view: "done", key: null });
    expect(parseRoute("reviews")).toEqual({ view: "reviews", source: "all", key: null });
    expect(parseRoute("reviews~team")).toEqual({ view: "reviews", source: "team", key: null });
    expect(parseRoute("insights")).toEqual({ view: "insights", tab: "overview" });
    expect(parseRoute("insights/log")).toEqual({ view: "insights", tab: "log" });
    expect(parseRoute("nonsense")).toEqual({ view: "inbox", key: null });

    expect(formatRoute({ view: "inbox", key: null })).toBe("");
    expect(formatRoute({ view: "inbox", key })).toBe("inbox/delta/shop/world/2261179");
    expect(formatRoute({ view: "reviews", source: "all", key })).toBe("reviews/delta/shop/world/2261179");
    expect(formatRoute({ view: "reviews", source: "asked", key: null })).toBe("reviews~asked");
    expect(formatRoute({ view: "insights", tab: "log" })).toBe("insights/log");
    expect(formatRoute({ view: "pr", key })).toBe("pr/delta/shop/world/2261179");
    for (const route of [
      { view: "inbox", key }, { view: "mine", key }, { view: "done", key }, { view: "reviews", source: "team", key }, { view: "reviews", source: "tracked", key: null },
      { view: "pr", key: "gitlab:group/sub/proj#77" }, { view: "insights", tab: "overview" },
    ] as const) {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
    expect(parseRoute("pr/github/a/%E0%A4%A/1")).toEqual({ view: "inbox", key: null });
  });

  it("keeps any search words in one segment, with a selected PR after them", () => {
    expect(parseRoute("search")).toEqual({ view: "search", query: "", key: null });
    expect(formatRoute({ view: "search", query: "edge cache", key: null })).toBe("search/edge%20cache");
    // No words, no results: a selection has nothing to stand in.
    expect(formatRoute({ view: "search", query: "", key })).toBe("search");
    for (const query of ["edge", "kd/edge-retries #2213", "100% done?", "a~b"]) {
      for (const route of [{ view: "search", query, key: null }, { view: "search", query, key }] as const) expect(parseRoute(formatRoute(route))).toEqual(route);
    }
    expect(parseRoute("search/100%")).toEqual({ view: "search", query: "100%", key: null });
  });

  it("never reads a Reviews source as a server id", () => {
    expect(parseRoute("reviews~team/team/acme/app/12")).toEqual({ view: "reviews", source: "team", key: "team:acme/app#12" });
    expect(parseRoute("reviews/team/acme/app/12")).toEqual({ view: "reviews", source: "all", key: "team:acme/app#12" });
  });

  it("opens 0.2's sections in the new areas, keeping a selected PR", () => {
    expect(parseRoute("needs")).toEqual({ view: "inbox", key: null });
    expect(parseRoute("needs/delta/shop/world/2261179")).toEqual({ view: "inbox", key });
    expect(parseRoute("requested")).toEqual({ view: "reviews", source: "asked", key: null });
    expect(parseRoute("requested/github/Shopify/cdn-detective/1494")).toEqual({ view: "reviews", source: "asked", key: "github:Shopify/cdn-detective#1494" });
    expect(parseRoute("team")).toEqual({ view: "reviews", source: "team", key: null });
    expect(parseRoute("mentioned")).toEqual({ view: "reviews", source: "mentioned", key: null });
    expect(parseRoute("watching/delta/shop/world/2261179")).toEqual({ view: "reviews", source: "tracked", key });
    expect(parseRoute("inflight/delta/shop/world/2261179")).toEqual({ view: "mine", key });
    expect(parseRoute("done")).toEqual({ view: "done", key: null });
    expect(parseRoute("activity")).toEqual({ view: "insights", tab: "log" });
  });
});

describe("small formatting", () => {
  it("badges a server by its capitals, or its first two letters", () => {
    expect(initials("GitHub")).toBe("GH");
    expect(initials("GitLab (self-hosted)")).toBe("GL");
    expect(initials("delta")).toBe("De");
  });

  it("drops the server from a key", () => {
    expect(keyLabel("delta:shop/world#2261179")).toBe("shop/world#2261179");
  });

  it("sizes a change by its changed lines", () => {
    expect(sizeOf({ additions: 40, deletions: 9 })).toBe("S");
    expect(sizeOf({ additions: 250, deletions: 49 })).toBe("M");
    expect(sizeOf({ additions: 900, deletions: 99 })).toBe("L");
    expect(sizeOf({ additions: 900, deletions: 100 })).toBe("XL");
    expect(sizeOf({ additions: null, deletions: 3 })).toBeNull();
  });

  it("writes medians short, and a dash without data", () => {
    expect(duration(null)).toBe("—");
    expect(duration(41 * 60_000)).toBe("41m");
    expect(duration(7.5 * 60 * 60_000)).toBe("7.5h");
    expect(duration(2.6 * 24 * 60 * 60_000)).toBe("2.6d");
  });

  it("names a failed check from its item's body", () => {
    expect(checkName("rspec (shard 3) failed")).toBe("rspec (shard 3)");
    expect(checkName("lint")).toBe("lint");
  });

  it("fills every prompt variable the server offers in the preview's sample", () => {
    expect(Object.keys(sampleReviewVariables("")).sort()).toEqual([...PROMPT_VARIABLES].sort());
  });
});

describe("server commands", () => {
  it("labels every operation and puts each in exactly one group of the form", () => {
    expect(Object.keys(OPERATION_LABELS).sort()).toEqual([...OPERATIONS].sort());
    expect(OPERATION_LABELS.merge).toBe("Merge a PR");
    expect(OPERATION_LABELS.reviewed).toBe("PRs you reviewed");
    expect([...READ_OPERATIONS, ...MANAGE_OPERATIONS, ...CONVERSATION_OPERATIONS].sort()).toEqual([...OPERATIONS].sort());
    expect(CONVERSATION_OPERATIONS).toEqual(["merge", "merge_options", "comment", "review", "reply", "resolve"]);
  });
});
