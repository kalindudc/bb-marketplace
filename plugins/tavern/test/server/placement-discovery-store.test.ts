// @vitest-environment node
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { DiscoveryStore } from "../../src/server/placement/discovery-store";
import { PlacementStore } from "../../src/server/placement/store";

const databases: Database.Database[] = [];
const endpoint = { hostId: "guest", environmentId: "env", root: "/guest/checkout" };
function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  return { db, store: new DiscoveryStore(db, () => 100) };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("private source discovery generations", () => {
  it("keeps source-only authority separate from placement reservations and source snapshots", () => {
    const { db, store } = setup();
    expect(store.bind("keeper", endpoint)).toEqual({
      keeperThreadId: "keeper", authorityId: expect.stringMatching(/^discovery_/), generation: 1, state: "current", endpoint,
      canonicalRoot: null, updatedAt: 100,
    });
    expect(new PlacementStore(db).counts("keeper")).toEqual({ makers: 0, checkers: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM tavern_source_snapshots").get()).toEqual({ n: 0 });
  });

  it("reuses an unchanged SDK binding across store reloads without discarding its canonical pin", () => {
    const { db, store } = setup();
    store.bind("keeper", endpoint);
    store.pin("keeper", 1, "/canonical/checkout");
    const reloaded = new DiscoveryStore(db, () => 200);
    expect(reloaded.bind("keeper", { ...endpoint })).toMatchObject({ generation: 1, canonicalRoot: "/canonical/checkout" });
    expect(reloaded.assertCurrent("keeper", 1)).toEqual(store.get("keeper"));
  });

  it("keeps its private authority id across reloads, but gives a fresh store a separate discovery namespace", () => {
    const first = setup(), second = setup();
    const binding = first.store.bind("keeper", endpoint);
    expect(new DiscoveryStore(first.db).bind("keeper", endpoint).authorityId).toBe(binding.authorityId);
    expect(first.store.bind("keeper", { ...endpoint, environmentId: "new-env" }).authorityId).toBe(binding.authorityId);
    expect(second.store.bind("keeper", endpoint).authorityId).not.toBe(binding.authorityId);
  });

  it.each([
    { ...endpoint, hostId: "other-host" },
    { ...endpoint, environmentId: "replacement-env" },
    { ...endpoint, root: "/guest/replacement" },
  ])("fences the previous generation when actual SDK endpoint changes (%#)", replacement => {
    const { store } = setup();
    store.bind("keeper", endpoint);
    store.pin("keeper", 1, "/canonical/checkout");
    expect(store.bind("keeper", replacement)).toMatchObject({ generation: 2, endpoint: replacement, canonicalRoot: null });
    expect(() => store.assertCurrent("keeper", 1)).toThrow(/stale/i);
    expect(() => store.pin("keeper", 1, "/old/late-result")).toThrow(/stale/i);
    expect(store.get("keeper")).toMatchObject({ generation: 2, canonicalRoot: null });
  });

  it("invalidates before a refresh and preserves the existing pin for an unchanged endpoint", () => {
    const { store } = setup();
    store.bind("keeper", endpoint);
    store.pin("keeper", 1, "/canonical/checkout");
    expect(store.invalidate("keeper", 1)).toMatchObject({ generation: 2, state: "invalidated" });
    expect(() => store.assertCurrent("keeper", 2)).toThrow(/invalidated/i);
    expect(store.invalidate("keeper", 1)).toMatchObject({ generation: 2 });
    expect(store.bind("keeper", endpoint)).toMatchObject({ generation: 3, state: "current", canonicalRoot: "/canonical/checkout" });
    expect(() => store.pin("keeper", 1, "/canonical/checkout")).toThrow(/stale/i);
  });

  it("does not let an old failed lookup invalidate a newer successful binding", () => {
    const { store } = setup();
    store.bind("keeper", endpoint);
    store.bind("keeper", { ...endpoint, environmentId: "new-env" });
    expect(store.invalidate("keeper", 1)).toMatchObject({ generation: 2, state: "current" });
    expect(store.assertCurrent("keeper", 2).endpoint.environmentId).toBe("new-env");
  });

  it("durably invalidates rather than silently moving a canonical root behind an unchanged SDK path", () => {
    const { db, store } = setup();
    store.bind("keeper", endpoint);
    store.pin("keeper", 1, "/canonical/checkout");
    expect(() => store.pin("keeper", 1, "/canonical/unexpected")).toThrow(/canonical.*changed/i);
    expect(new DiscoveryStore(db).get("keeper")).toMatchObject({
      generation: 2, state: "invalidated", canonicalRoot: "/canonical/checkout",
    });
    expect(() => store.assertCurrent("keeper", 1)).toThrow(/stale/i);
  });

  it("invalidates every current source on a worker host without touching another host or placing a member", () => {
    const { db, store } = setup();
    store.bind("first", endpoint);
    store.bind("second", { ...endpoint, environmentId: "second-env" });
    store.bind("other", { ...endpoint, hostId: "other-host" });
    expect(store.invalidateHost("guest")).toBe(2);
    expect(store.invalidateHost("guest")).toBe(0);
    expect(store.get("first")).toMatchObject({ generation: 2, state: "invalidated" });
    expect(store.get("second")).toMatchObject({ generation: 2, state: "invalidated" });
    expect(store.assertCurrent("other", 1)).toMatchObject({ state: "current" });
    expect(db.prepare("SELECT count(*) AS n FROM tavern_placements").get()).toEqual({ n: 0 });
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT keeper_thread_id FROM tavern_placement_discoveries WHERE json_extract(record_json,'$.endpoint.hostId')=?").all("guest");
    expect(JSON.stringify(plan)).toContain("tavern_discovery_host");
  });

  it("rejects incomplete SDK identity, malformed persisted data and generation overflow without renewing authority", () => {
    const { db, store } = setup();
    expect(() => store.bind("keeper", { ...endpoint, environmentId: null } as never)).toThrow();
    expect(store.get("keeper")).toBeNull();
    store.bind("keeper", endpoint);
    db.prepare("UPDATE tavern_placement_discoveries SET record_json='{}' WHERE keeper_thread_id=?").run("keeper");
    expect(() => store.bind("keeper", endpoint)).toThrow();
    db.prepare("UPDATE tavern_placement_discoveries SET record_json=?,generation=? WHERE keeper_thread_id=?")
      .run(JSON.stringify({ authorityId: "discovery-fixture", endpoint, state: "current", canonicalRoot: null }), Number.MAX_SAFE_INTEGER, "keeper");
    expect(store.invalidate("keeper", Number.MAX_SAFE_INTEGER)).toMatchObject({
      generation: Number.MAX_SAFE_INTEGER, state: "invalidated",
    });
    expect(() => store.assertCurrent("keeper", Number.MAX_SAFE_INTEGER)).toThrow(/invalidated/i);
    expect(() => store.bind("keeper", endpoint)).toThrow();
    expect(store.get("keeper")).toMatchObject({ generation: Number.MAX_SAFE_INTEGER, state: "invalidated" });
  });

  it("still fences every host binding when one generation has reached the numeric ceiling", () => {
    const { db, store } = setup();
    store.bind("first", endpoint);
    store.bind("second", endpoint);
    db.prepare("UPDATE tavern_placement_discoveries SET generation=? WHERE keeper_thread_id='first'")
      .run(Number.MAX_SAFE_INTEGER);
    expect(store.invalidateHost("guest")).toBe(2);
    expect(store.get("first")).toMatchObject({ generation: Number.MAX_SAFE_INTEGER, state: "invalidated" });
    expect(store.get("second")).toMatchObject({ generation: 2, state: "invalidated" });
    expect(() => store.assertCurrent("first", Number.MAX_SAFE_INTEGER)).toThrow(/invalidated/i);
  });

  it("keeps host-native Windows paths opaque instead of resolving them on the controller", () => {
    const { store } = setup();
    const windows = { ...endpoint, root: "Z:\\projects\\app" };
    store.bind("keeper", windows);
    expect(store.pin("keeper", 1, "Z:\\canonical\\app")).toMatchObject({
      endpoint: windows, canonicalRoot: "Z:\\canonical\\app",
    });
  });
});
