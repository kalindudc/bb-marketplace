// @vitest-environment node
import { describe, expect, it } from "vitest";
import { compareRanks, describedWords, matchText, rankOf } from "../src/match";
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
  await h.shuttle.lookup("forge:acme/app#2");
  return h;
}

const numbers = (prs: Array<{ number: number }>) => prs.map((p) => p.number);

describe("search", () => {
  it("reads #2213 and !77 as PR numbers, @dana as a login, and ignores case and extra spaces", () => {
    expect(searchTerms("  Edge   #2213 !77 2213 #x @Dana @ ")).toEqual([{ text: "edge" }, { number: "2213" }, { number: "77" }, { text: "2213" }, { text: "#x" }, { text: "dana" }, { text: "@" }]);
    expect(searchTerms("   ")).toEqual([]);
    expect(searchTerms(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" "))).toHaveLength(20);
  });

  it("counts each word for the first field that holds it: title, repository, details, then description", () => {
    const text = matchText({
      key: "forge:acme/app#12", title: "Retry the router", repo: "acme/app", number: 12, sep: "#", author: "dana",
      headRef: "dana/retries", base: "main", serverName: "Forge", labels: [{ name: "routing" }], body: "Fixes the Router's timeouts on deploy.",
    });
    expect(rankOf(searchTerms("router acme dana deploy"), text)).toEqual({ title: 1, repo: 1, details: 1, description: 1 });
    // "router" is in the title and the description; it counts once, for the title.
    expect(rankOf(searchTerms("router"), text)).toEqual({ title: 1, repo: 0, details: 0, description: 0 });
    expect(rankOf(searchTerms("app#12 routing #1"), text)).toEqual({ title: 0, repo: 0, details: 2, description: 0 });
    expect(rankOf(searchTerms("router #2"), text)).toBeNull();
    expect(rankOf(searchTerms("router zebra"), text)).toBeNull();
    // Without the description, words known to be in it still count for it, and so does any part of them.
    const bare = { ...text, description: "" };
    expect(describedWords(["router", "deploy", "timeouts"], bare)).toEqual(["deploy", "timeouts"]);
    expect(rankOf(searchTerms("router deplo"), bare, ["deploy"])).toEqual({ title: 1, repo: 0, details: 0, description: 1 });
    expect(rankOf(searchTerms("router deployed"), bare, ["deploy"])).toBeNull();
    // A template's HTML comments are not the description.
    const templated = matchText({ key: "k", title: "t", repo: "r", number: 1, sep: "#", author: "a", headRef: null, base: null, serverName: "S", labels: null, body: "<!-- Describe the rollback plan -->\nFixes it." });
    expect(rankOf(searchTerms("rollback"), templated)).toBeNull();
    expect(rankOf(searchTerms("fixes"), templated)).toEqual({ title: 0, repo: 0, details: 0, description: 1 });
    const ranks = [
      { title: 0, repo: 0, details: 0, description: 2 },
      { title: 0, repo: 1, details: 0, description: 1 },
      { title: 1, repo: 0, details: 0, description: 1 },
      { title: 0, repo: 0, details: 1, description: 1 },
      { title: 2, repo: 0, details: 0, description: 0 },
    ];
    expect([...ranks].sort(compareRanks)).toEqual([ranks[4], ranks[2], ranks[1], ranks[3], ranks[0]]);
  });

  it("finds PRs by title, author, branch, label, repository and number, every word matching", async () => {
    const h = await stocked();
    expect(numbers(h.shuttle.search("edge").prs)).toEqual([3, 1, 4]);
    expect(numbers(h.shuttle.search("edge retries").prs)).toEqual([4, 1]);
    expect(numbers(h.shuttle.search("dana").prs)).toEqual([3]);
    expect(numbers(h.shuttle.search("kd/edge-retries").prs)).toEqual([1]);
    expect(numbers(h.shuttle.search("routing").prs)).toEqual([1]);
    expect(numbers(h.shuttle.search("app#3").prs)).toEqual([3]);
    // "#4" is the number, so the 429 in #1's title does not match it; a bare 4 matches anywhere.
    expect(numbers(h.shuttle.search("#4").prs)).toEqual([4]);
    expect(numbers(h.shuttle.search("42").prs)).toEqual([1]);
    expect(numbers(h.shuttle.search("edge #3").prs)).toEqual([3]);
    expect(h.shuttle.search("nothing like this")).toEqual({ prs: [], total: 0 });
    expect(h.shuttle.search("")).toEqual({ prs: [], total: 0 });
  });

  it("puts open PRs first, then title matches, repository, details and description, then the newest", async () => {
    const h = await stocked();
    // #4 matches "edge" only through its author, so the title matches come first, the newer #3 before #1.
    expect(numbers(h.shuttle.search("edge").prs)).toEqual([3, 1, 4]);
    // A merged PR with the word in its title still comes after every open match, so merged ones never crowd them out.
    h.views[9] = pr(9, { author: "me", title: "Edge logging", state: "merged" });
    await h.shuttle.lookup("forge:acme/app#9");
    expect(numbers(h.shuttle.search("edge").prs)).toEqual([3, 1, 4, 9]);
    // Every PR matches through its repository; the merged ones go last.
    expect(numbers(h.shuttle.search("acme/app").prs)).toEqual([4, 3, 1, 2, 9]);
  });

  it("finds words in descriptions, after the PRs that hold them anywhere else", async () => {
    const h = harness();
    h.lists.review_requested = [
      pr(5, { title: "Tidy the logs", body: "Moves the Envoy filters into one place.", updated_at: "2026-10-23T11:50:00Z" }),
      pr(6, { title: "Envoy upgrade", updated_at: "2026-10-23T09:00:00Z" }),
      pr(7, { title: "Docs", author: "envoy-bot", updated_at: "2026-10-23T11:00:00Z" }),
      pr(8, { repo: "acme/envoy", title: "Bump", updated_at: "2026-10-23T10:00:00Z" }),
    ];
    await h.shuttle.sync();
    expect(numbers(h.shuttle.search("envoy").prs)).toEqual([6, 8, 7, 5]);
    expect(numbers(h.shuttle.search("envoy filters").prs)).toEqual([5]);
    expect(numbers(h.shuttle.search("tidy filters").prs)).toEqual([5]);
  });

  it("names only the PRs that need their description to match, for the lists' filters", async () => {
    const h = harness();
    h.lists.review_requested = [
      pr(5, { title: "Tidy the logs", body: "Moves the Envoy filters into one place." }),
      pr(6, { title: "Envoy upgrade", body: "Envoy 1.31." }),
    ];
    await h.shuttle.sync();
    expect(h.shuttle.descriptionMatches("envoy")).toEqual(["forge:acme/app#5"]);
    expect(h.shuttle.descriptionMatches("envoy tidy")).toEqual(["forge:acme/app#5"]);
    expect(h.shuttle.descriptionMatches("upgrade")).toEqual([]);
    expect(h.shuttle.descriptionMatches("")).toEqual([]);
  });

  it("keeps a list's description without counting the list as the PR's own read", async () => {
    const h = harness();
    h.lists.review_requested = [pr(5, { title: "Tidy the logs", body: "Moves the Envoy filters." })];
    await h.shuttle.sync();
    const listed = h.store.prByKey("forge:acme/app#5")!;
    expect(listed.body).toBe("Moves the Envoy filters.");
    expect(listed.viewed_at).toBeNull();
    // The PR on screen is still read by itself once, for what lists lack.
    h.views[5] = pr(5, { title: "Tidy the logs", body: "Moves the Envoy filters." });
    await h.shuttle.refreshStale(["forge:acme/app#5"], 60_000);
    expect(h.runner.calls.filter((call) => call.operation === "view")).toHaveLength(1);
    expect(h.store.prByKey("forge:acme/app#5")!.viewed_at).not.toBeNull();
  });

  it("leaves out the PRs of a disabled server", async () => {
    const h = await stocked();
    h.store.saveConfig(testConfig({ servers: [{ ...TEST_SERVER, sep: "#", enabled: false }] }));
    expect(h.shuttle.search("edge").prs).toEqual([]);
  });
});
