// @vitest-environment node
import { describe, expect, it } from "vitest";
import { searchTerms } from "../src/search";
import { harness, pr, testConfig, TEST_SERVER } from "./helpers";

async function stocked() {
  const h = harness();
  h.lists.authored = [
    pr(1, { author: "me", title: "Retry 429s in the edge router", head_ref: "kd/edge-retries", labels: [{ name: "routing", color: null }] }),
    pr(2, { author: "me", title: "Bump nginx", state: "merged", updated_at: "2026-10-22T10:00:00Z" }),
  ];
  h.lists.review_requested = [
    pr(3, { author: "dana", title: "Edge cache keys", updated_at: "2026-10-23T11:00:00Z" }),
    pr(4, { author: "edgeworth", title: "Payments retries", updated_at: "2026-10-23T11:30:00Z" }),
  ];
  await h.shuttle.sync();
  // The merged PR is in the store from a look-up, as a closed PR of yours would be after a sync.
  h.views[2] = pr(2, { author: "me", title: "Bump nginx", state: "merged" });
  await h.shuttle.lookup("forge:shop/world#2");
  return h;
}

const numbers = (prs: Array<{ number: number }>) => prs.map((p) => p.number);

describe("search", () => {
  it("reads #2213 and !77 as PR numbers, and ignores case and extra spaces", () => {
    expect(searchTerms("  Edge   #2213 !77 2213 #x ")).toEqual([{ text: "edge" }, { number: "2213" }, { number: "77" }, { text: "2213" }, { text: "#x" }]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("finds PRs by title, author, branch, label, repository and number, every word matching", async () => {
    const h = await stocked();
    expect(numbers(h.shuttle.search("edge").prs)).toEqual([3, 1, 4]);
    expect(numbers(h.shuttle.search("edge retries").prs)).toEqual([4, 1]);
    expect(numbers(h.shuttle.search("dana").prs)).toEqual([3]);
    expect(numbers(h.shuttle.search("kd/edge-retries").prs)).toEqual([1]);
    expect(numbers(h.shuttle.search("routing").prs)).toEqual([1]);
    expect(numbers(h.shuttle.search("world#3").prs)).toEqual([3]);
    // "#4" is the number, so the 429 in #1's title does not match it; a bare 4 matches anywhere.
    expect(numbers(h.shuttle.search("#4").prs)).toEqual([4]);
    expect(numbers(h.shuttle.search("42").prs)).toEqual([1]);
    expect(numbers(h.shuttle.search("edge #3").prs)).toEqual([3]);
    expect(h.shuttle.search("nothing like this")).toEqual({ prs: [], total: 0 });
    expect(h.shuttle.search("")).toEqual({ prs: [], total: 0 });
  });

  it("puts open PRs first, then title matches, then the most recently updated", async () => {
    const h = await stocked();
    // #4 matches "edge" only through its author, so the title matches come first, the newer #3 before #1.
    expect(numbers(h.shuttle.search("edge").prs)).toEqual([3, 1, 4]);
    expect(numbers(h.shuttle.search("shop/world").prs)).toEqual([4, 3, 1, 2]);
  });

  it("leaves out the PRs of a disabled server", async () => {
    const h = await stocked();
    h.store.saveConfig(testConfig({ servers: [{ ...TEST_SERVER, sep: "#", enabled: false }] }));
    expect(h.shuttle.search("edge").prs).toEqual([]);
  });
});
