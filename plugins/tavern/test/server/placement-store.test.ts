// @vitest-environment node
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { PlacementStore } from "../../src/server/placement/store";
import { digest, gitSha, placementRecord, sourceSnapshot } from "./placement-fixture";

const databases: Database.Database[] = [];
const limits = { maxMakers: 2, maxCheckers: 2 };
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  return { db, store: new PlacementStore(db, () => 100) };
}
function record(id: string, overrides = {}) {
  return placementRecord({ id, hireToken: `hire-${id}`, allocationKey: `allocation-${id}`, ...overrides });
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("durable machine reservations", () => {
  it("enforces independent maker/checker caps per Keeper, across quests and errands", () => {
    const { store } = setup();
    store.reserve(record("maker-quest"), limits);
    store.reserve(record("maker-errand", { questId: null }), limits);
    expect(() => store.reserve(record("too-many"), limits)).toThrow(/maker.*2/i);
    store.reserve(record("checker", { classId: "warden", slot: "checker" }), limits);
    store.reserve(record("other-keeper", { keeperThreadId: "other" }), limits);
    expect(store.counts("keeper")).toEqual({ makers: 2, checkers: 1 });
    expect(store.counts("other")).toEqual({ makers: 1, checkers: 0 });
  });

  it("counts all nonreleased records, not the first 500 or only running members", () => {
    const { db, store } = setup();
    const large = { maxMakers: 1000, maxCheckers: 1000 };
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) store.reserve(record(`maker-${i}`), large);
    })();
    store.block("maker-1", 1, { stage: "allocate", code: "quota", message: "Increase quota", retryable: true });
    store.cancel("maker-2", 1);
    expect(store.counts("keeper")).toEqual({ makers: 1000, checkers: 0 });
    expect(() => store.reserve(record("overflow"), large)).toThrow(/maker.*1000/i);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM tavern_placements WHERE json_extract(data,'$.keeperThreadId')=? AND json_extract(data,'$.rule') IS NOT NULL AND json_extract(data,'$.phase')<>'released'").all("keeper");
    expect(JSON.stringify(plan)).toContain("tavern_placement_slots");
  });

  it("excludes unruled legacy/local records from machine caps", () => {
    const { store } = setup();
    for (let i = 0; i < 4; i++) store.reserve(record(`legacy-${i}`, { rule: null }), { maxMakers: 1, maxCheckers: 1 });
    store.reserve(record("ruled"), { maxMakers: 1, maxCheckers: 1 });
    expect(store.counts("keeper")).toEqual({ makers: 1, checkers: 0 });
  });

  it("reconciles duplicate hire tokens without allocating or resetting advanced state", () => {
    const { db, store } = setup();
    const original = store.reserve(record("first"), limits);
    store.update(original.id, 1, current => ({ ...current, memberThreadId: "child", phase: "provisioning" }));
    const reloaded = new PlacementStore(db, () => 200);
    const retried = reloaded.reserve({ ...record("first"), id: "must-not-allocate" }, limits);
    expect(retried.id).toBe("first");
    expect(retried.memberThreadId).toBe("child");
    expect(retried.phase).toBe("provisioning");
    expect(reloaded.byHireToken("hire-first")).toEqual(retried);
    expect(reloaded.counts("keeper").makers).toBe(1);
    expect(() => reloaded.reserve({ ...record("first"), keeperThreadId: "intruder" }, limits)).toThrow(/hire token/i);
  });

  it("retains every active record through paged scans and excludes released rows", () => {
    const { store } = setup();
    for (const id of ["c", "a", "b"]) store.reserve(record(id), { maxMakers: 5, maxCheckers: 2 });
    expect(store.activePage(null, 2).map(item => item.id)).toEqual(["a", "b"]);
    expect(store.activePage("b", 2).map(item => item.id)).toEqual(["c"]);
    expect(() => store.activePage(null, 0)).toThrow();
    expect(() => store.activePage(null, 1001)).toThrow();
  });

  it("keeps the original resume phase across repeated blockers", () => {
    const { store } = setup();
    store.reserve(record("member"), limits);
    store.update("member", 1, current => ({ ...current, phase: "carrying" }));
    store.block("member", 1, { stage: "carry", code: "offline", message: "Reconnect", retryable: true });
    store.block("member", 1, { stage: "observe", code: "still-offline", message: "Reconnect", retryable: true });
    expect(store.get("member")?.resumePhase).toBe("carrying");
    expect(store.retry("member", 1).phase).toBe("carrying");
    expect(store.get("member")?.blocked).toBeNull();
  });

  it("fences a cancellation durably before a late callback and makes repeated cancellation idempotent", async () => {
    const { db, store } = setup();
    store.reserve(record("member"), limits);
    let complete!: () => void;
    const delayed = new Promise<void>(resolve => { complete = resolve; });
    const callback = delayed.then(() => store.update("member", 1, current => ({ ...current, phase: "ready" })));
    const cancelled = store.cancel("member", 1);
    expect(cancelled.generation).toBe(2);
    expect(cancelled.desiredState).toBe("released");
    expect(new PlacementStore(db).get("member")).toEqual(cancelled);
    expect(store.cancel("member", 1)).toEqual(cancelled);
    complete();
    await expect(callback).rejects.toThrow(/stale.*generation/i);
    expect(store.get("member")?.desiredState).toBe("released");
    expect(() => store.update("member", 2, current => ({ ...current, phase: "ready" }))).toThrow(/desired state/i);
  });

  it("invalidates old preservation claims for a live owner and can block/retry release recovery", () => {
    const { store } = setup();
    store.reserve(record("member", { memberThreadId: "child", preservation: {
      ...placementRecord().preservation, source: "saved", snapshotId: "old-snapshot", liveOwnerThreadId: "child",
    } }), limits);
    const cancelled = store.cancel("member", 1);
    expect(cancelled.preservation.source).toBe("pending");
    expect(cancelled.preservation.liveOwnerThreadId).toBe("child");
    store.block("member", 2, { stage: "preserve", code: "offline", message: "Reconnect before release", retryable: true }, "released");
    expect(store.get("member")?.resumePhase).toBe("preserving");
    expect(store.retry("member", 2, "released").phase).toBe("preserving");
    expect(() => store.update("member", 2, current => ({ ...current, phase: "ready" }), "released")).toThrow(/released|cancel/i);
  });

  it("pins reservation authority and does not let an update silently reroute a member", () => {
    const { store } = setup();
    store.reserve(record("member"), limits);
    for (const patch of [
      { id: "other" }, { generation: 2 }, { hireToken: "other" }, { slot: "checker" as const },
      { target: { type: "project-default" } }, { keeperThreadId: "other" }, { rule: null },
    ]) expect(() => store.update("member", 1, current => ({ ...current, ...patch }))).toThrow(/immutable/i);
  });

  it("requires reconciliation, confirmed stop and preservation before controlled release", () => {
    const { store } = setup();
    store.reserve(record("member", { memberThreadId: "child", preservation: {
      ...placementRecord().preservation, source: "pending", artifacts: "pending", liveOwnerThreadId: "child",
    } }), limits);
    store.cancel("member", 1);
    expect(() => store.finishRelease("member", 2, false)).toThrow(/reconcil/i);
    expect(() => store.finishRelease("member", 2, true)).toThrow(/preserv|stop/i);
    expect(store.counts("keeper").makers).toBe(1);
    store.update("member", 2, current => ({ ...current, preservation: {
      ...current.preservation, stopConfirmed: true, source: "unknown", artifacts: "unknown",
    } }), "released");
    expect(() => store.finishRelease("member", 2, true)).toThrow(/preserv/i);
    expect(() => store.update("member", 2, current => ({ ...current, phase: "released" }), "released")).toThrow(/finishRelease/);
  });

  it("releases a never-started reservation only after resource reconciliation and a confirmed stop", () => {
    const { store } = setup();
    store.reserve(record("unused"), limits);
    store.cancel("unused", 1);
    store.update("unused", 2, current => ({ ...current, preservation: { ...current.preservation, stopConfirmed: true } }), "released");
    expect(store.finishRelease("unused", 2, true).phase).toBe("released");
    expect(store.finishRelease("unused", 2, true).phase).toBe("released");
    expect(store.counts("keeper")).toEqual({ makers: 0, checkers: 0 });
    expect(store.activePage(null, 10)).toEqual([]);
  });

  it("does not hide corrupt persisted placement records", () => {
    const { db, store } = setup();
    db.prepare("INSERT INTO tavern_placements(id,data) VALUES(?,?)").run("bad", JSON.stringify({ id: "bad" }));
    expect(() => store.get("bad")).toThrow();
  });
});

describe("immutable source snapshots", () => {
  it("persists initial source before any maker submission and only pins a verified home tree", () => {
    const { db, store } = setup();
    store.saveSnapshot(sourceSnapshot());
    expect(new PlacementStore(db).snapshot("snapshot")).toEqual(sourceSnapshot());
    expect(() => store.pinSnapshot("snapshot", gitSha, digest, "sha256")).toThrow(/object-format-mismatch/);
    expect(() => store.pinSnapshot("snapshot", gitSha, "c".repeat(40), "sha1")).toThrow(/tree/i);
    const pinned = store.pinSnapshot("snapshot", gitSha, gitSha, "sha1");
    expect(pinned.homeCommit).toBe(gitSha);
    expect(store.pinSnapshot("snapshot", gitSha, gitSha, "sha1")).toEqual(pinned);
    expect(() => store.pinSnapshot("snapshot", "c".repeat(40), gitSha, "sha1")).toThrow(/immutable/i);
  });

  it("never mutates content identity or clears an already pinned home commit on retry", () => {
    const { store } = setup();
    store.saveSnapshot(sourceSnapshot());
    store.pinSnapshot("snapshot", gitSha, gitSha, "sha1");
    expect(store.saveSnapshot(sourceSnapshot()).homeCommit).toBe(gitSha);
    expect(() => store.saveSnapshot(sourceSnapshot({ tree: "c".repeat(40) }))).toThrow(/immutable/i);
    expect(() => store.saveSnapshot(sourceSnapshot({ homeCommit: gitSha }))).toThrow(/pinSnapshot/i);
  });
});
