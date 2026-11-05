// @vitest-environment node
import { describe, expect, it } from "vitest";
import { searchIndex } from "../src/search";
import { allViews, VIEW_INDEX_MS } from "../src/views";
import { harness, pr, testConfig, TEST_SERVER } from "./helpers";

async function synced() {
  const h = harness();
  h.lists.review_requested = [pr(1, { title: "Retry 429s", body: "Moves the Envoy filters." }), pr(2, { title: "Edge cache keys" })];
  await h.shuttle.sync();
  return h;
}

describe("the indexes every read shares", () => {
  it("builds every PR's view once for every read until something is written", async () => {
    const h = await synced();
    const first = allViews(h.shuttle);
    const version = h.store.version;
    h.shuttle.inbox();
    h.shuttle.list("reviews");
    h.shuttle.overview();
    // Reading writes nothing, so every read is served from the same views.
    expect(h.store.version).toBe(version);
    expect(allViews(h.shuttle)[0]).toBe(first[0]);
    expect(Object.isFrozen(first[0])).toBe(true);
    h.shuttle.track("forge:acme/app#2", true);
    const after = allViews(h.shuttle);
    expect(after[0]).not.toBe(first[0]);
    expect(after.find((view) => view.number === 2)!.tracked).toBe(true);
  });

  it("builds them again when only the clock or the settings moved", async () => {
    const h = await synced();
    const first = allViews(h.shuttle);
    h.clock.now += VIEW_INDEX_MS - 1;
    expect(allViews(h.shuttle)[0]).toBe(first[0]);
    h.clock.now += 1;
    const later = allViews(h.shuttle);
    expect(later[0]).not.toBe(first[0]);
    h.settings.botAuthors = ["sam"];
    const settled = allViews(h.shuttle);
    expect(settled[0]).not.toBe(later[0]);
    expect(settled.every((view) => view.bot)).toBe(true);
  });

  it("keeps search text until a write, and leaves out the PRs of a disabled server", async () => {
    const h = await synced();
    const first = searchIndex(h.shuttle);
    expect(searchIndex(h.shuttle)).toBe(first);
    expect(first.map((entry) => entry.pr.body)).toEqual([null, null]);
    expect(h.shuttle.descriptionMatches("envoy")).toEqual(["forge:acme/app#1"]);
    h.lists.review_requested = [pr(1, { title: "Retry 429s", body: "Moves the WAF rules." }), pr(2, { title: "Edge cache keys" })];
    await h.shuttle.sync();
    expect(h.shuttle.descriptionMatches("envoy")).toEqual([]);
    expect(h.shuttle.descriptionMatches("waf")).toEqual(["forge:acme/app#1"]);
    h.store.saveConfig(testConfig({ servers: [{ ...TEST_SERVER, sep: "#", enabled: false }] }));
    expect(searchIndex(h.shuttle)).toEqual([]);
  });

  it("reads the config once and again only after it is saved", async () => {
    const h = await synced();
    const config = h.store.config();
    expect(h.store.config()).toBe(config);
    expect(Object.isFrozen(config.servers[0])).toBe(true);
    h.store.saveConfig(testConfig({ servers: [{ ...TEST_SERVER, name: "Forge 2", sep: "#", enabled: true }] }));
    expect(h.store.config()).not.toBe(config);
    expect(h.shuttle.server("forge")!.name).toBe("Forge 2");
  });

  it("builds them before the page hears about a change, when the port can say so", async () => {
    const h = await synced();
    const before = allViews(h.shuttle);
    h.shuttle.track("forge:acme/app#1", true);
    h.shuttle.warmIndexes();
    const warmed = allViews(h.shuttle);
    expect(warmed[0]).not.toBe(before[0]);
    // Warming again while nothing changed builds nothing.
    h.shuttle.warmIndexes();
    expect(allViews(h.shuttle)[0]).toBe(warmed[0]);
  });
});
