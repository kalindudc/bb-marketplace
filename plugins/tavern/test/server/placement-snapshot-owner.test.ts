// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { BackupRecords } from "../../src/server/backup/records";
import { MIGRATIONS } from "../../src/server/migrations";
import { SnapshotStore, snapshotOwnerId } from "../../src/server/placement/snapshot-store";
import { PlacementStore } from "../../src/server/placement/store";
import { SettingsStore } from "../../src/server/settings/store";
import { placementRecord, sourceSnapshot } from "./placement-fixture";

const hosts = new Set<ReturnType<typeof createFakePluginHost>>();
afterEach(async () => { for (const host of hosts) await host.harness.lifecycle.dispose(); hosts.clear(); });
const fetch = { via: "upstream" as const, remoteName: "origin", remoteUrl: "ssh://git@example.com/team/repo.git",
  trackingRef: "refs/remotes/origin/main", fetchRef: "refs/heads/main" };
function captureInput(overrides = {}) {
  const { id: _id, homeCommit: _commit, homeRef: _ref, createdAt: _at, ...input } = sourceSnapshot({ fetch });
  return { ...input, ...overrides };
}
function fixture() {
  const host = createFakePluginHost({ pluginId: "tavern" }); hosts.add(host);
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join(";\n"));
  return { ...host, db, placements: new PlacementStore(db, () => 100), owners: new SnapshotStore(db) };
}
const limits = { maxMakers: 10, maxCheckers: 10 };

it("addresses identical content and bindings once, independently of time and object key order", () => {
  const f = fixture(), first = f.placements.captureSnapshot(captureInput());
  const later = new PlacementStore(f.db, () => 999);
  const input = captureInput({ fetch: { fetchRef: fetch.fetchRef, trackingRef: fetch.trackingRef, remoteUrl: fetch.remoteUrl, remoteName: fetch.remoteName, via: fetch.via } });
  expect(later.captureSnapshot(input)).toEqual(first);
  expect(first.ownerId).toMatch(/^[a-f0-9]{64}$/);
  expect(first.id).toMatch(/^source-[a-f0-9]{64}$/);
  expect(first.homeRef).toBe("refs/tavern/snapshots/" + first.ownerId);
  const owner = f.owners.get(first.ownerId!)!;
  expect(owner.id).toBe(createHash("sha256").update(JSON.stringify(["tavern-snapshot-owner/1", owner.content])).digest("hex"));
  expect(f.db.prepare("SELECT count(*) AS n FROM tavern_snapshot_owners").get()).toEqual({ n: 1 });
  expect(f.db.prepare("SELECT count(*) AS n FROM tavern_source_snapshots").get()).toEqual({ n: 1 });
});

it("keeps two Keepers' descriptors immutable while sharing one content owner and home import", () => {
  const f = fixture(), first = f.placements.captureSnapshot(captureInput());
  const second = f.placements.captureSnapshot(captureInput({ keeperThreadId: "other-keeper", sourceThreadId: "other-keeper" }));
  expect(second.id).not.toBe(first.id); expect(second.ownerId).toBe(first.ownerId);
  f.placements.pinSnapshot(first.id, "c".repeat(40), first.tree, first.objectFormat);
  expect(f.placements.snapshot(second.id)!.homeCommit).toBe("c".repeat(40));
  expect(f.owners.get(first.ownerId!)!.homeCommit).toBe("c".repeat(40));
  const rows = f.db.prepare("SELECT data FROM tavern_source_snapshots ORDER BY id").all() as { data: string }[];
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(JSON.parse(row.data).homeCommit).toBeNull();
  expect(() => f.placements.pinSnapshot(second.id, "d".repeat(40), first.tree, first.objectFormat)).toThrow(/immutable/i);
  expect(f.placements.captureSnapshot(captureInput())).toMatchObject({ id: first.id, homeCommit: "c".repeat(40) });
});

it.each([
  { base: "b".repeat(40) }, { sourceHead: "b".repeat(40) }, { tree: "b".repeat(40) },
  { fetch: { ...fetch, remoteUrl: "ssh://other@example.com/team/repo.git" } },
  { fetch: { ...fetch, via: "remote-head" } }, { fetch: { ...fetch, remoteName: "upstream" } },
  { fetch: { ...fetch, trackingRef: "refs/remotes/origin/other" } }, { fetch: { ...fetch, fetchRef: "refs/heads/other" } },
  { source: { ...sourceSnapshot().source, root: "/other" } },
  { source: { ...sourceSnapshot().source, hostId: "other-host" } },
  { source: { ...sourceSnapshot().source, environmentId: "other-env" } },
  { home: { ...sourceSnapshot().home, root: "/other" } },
  { home: { ...sourceSnapshot().home, hostId: "other-host" } },
  { home: { ...sourceSnapshot().home, environmentId: "other-env" } },
  { objectFormat: "sha256", base: "a".repeat(64), sourceHead: "a".repeat(64), tree: "a".repeat(64) },
])("gives changed content or provenance a distinct owner: %j", change => {
  const f = fixture(), first = f.placements.captureSnapshot(captureInput());
  const next = f.placements.captureSnapshot(captureInput(change));
  expect(next.ownerId).not.toBe(first.ownerId); expect(next.id).not.toBe(first.id);
});

it("excludes binding-only fields from owner addressing but includes them in the descriptor", () => {
  const f = fixture(), first = f.placements.captureSnapshot(captureInput());
  const submission = f.placements.captureSnapshot(captureInput({ purpose: "submission", sourceThreadId: "maker", makerThreadId: "maker", makerSubmissionId: "submission",
    journalTarget: { boardQuestId: "quest", waypointId: "waypoint", makerThreadId: "maker", journalEntryId: "entry", entryFingerprint: "f".repeat(64), reviewAssignmentId: "review" } }));
  expect(submission.ownerId).toBe(first.ownerId); expect(submission.id).not.toBe(first.id);
  const rebound = { ...first, createdAt: 999, homeCommit: "c".repeat(40), id: "irrelevant", homeRef: "refs/tavern/irrelevant" };
  expect(snapshotOwnerId(rebound)).toBe(first.ownerId);
});

it.each(["source", "review", "preservation", "transfer", "carry"] as const)("derives a live %s reference from placement rows and retains it through cancellation", kind => {
  const f = fixture(), snapshot = f.placements.captureSnapshot(captureInput());
  const record = placementRecord();
  if (kind === "source") record.sourceSnapshotId = snapshot.id;
  if (kind === "review") record.reviewTarget = { snapshotId: snapshot.id, expectedTree: snapshot.tree, makerThreadId: "maker", makerSubmissionId: "submission",
    journal: { boardQuestId: "quest", waypointId: "waypoint", makerThreadId: "maker", journalEntryId: "entry", entryFingerprint: "f".repeat(64), reviewAssignmentId: "review" } };
  if (kind === "preservation") record.preservation.snapshotId = snapshot.id;
  if (kind === "transfer") record.transfers = [{ id: "transfer", generation: 1, snapshotId: snapshot.id, direction: "bring-home", sourceEndpointId: "source", homeEndpointId: "home", verifyEndpointId: "verify",
    sourceSdk: snapshot.source, homeSdk: snapshot.home, phase: "exporting", manifest: null, uploads: [], homeCommit: null }];
  if (kind === "carry") record.carries = [{ id: "carry", generation: 1, snapshotId: snapshot.id, homeEndpointId: "home", memberEndpointId: "member", homeSdk: snapshot.home, memberSdk: snapshot.source,
    branch: "main", holdToken: "hold", replacesTree: null, phase: "holding", manifest: null, head: null }];
  f.placements.reserve(record, limits);
  expect(f.owners.references(snapshot.ownerId!)).toEqual(["placement"]);
  f.placements.cancel("placement", 1);
  expect(() => f.owners.beginRelease(snapshot.ownerId!, 1)).toThrow(/reference/i);
  f.placements.update("placement", 2, value => ({ ...value, preservation: { ...value.preservation, stopConfirmed: true } }), "released");
  f.placements.finishRelease("placement", 2, true);
  expect(f.owners.references(snapshot.ownerId!)).toEqual([]);
  expect(f.owners.beginRelease(snapshot.ownerId!, 1).phase).toBe("releasing");
});

it("sees all descriptors and blocks new or changed references atomically once release begins", () => {
  const f = fixture(), first = f.placements.captureSnapshot(captureInput());
  const second = f.placements.captureSnapshot(captureInput({ keeperThreadId: "other", sourceThreadId: "other" }));
  f.placements.reserve(placementRecord({ sourceSnapshotId: first.id }), limits);
  f.placements.reserve(placementRecord({ id: "second", hireToken: "second", sourceSnapshotId: second.id, keeperThreadId: "other" }), limits);
  expect(f.owners.references(first.ownerId!)).toEqual(["placement", "second"]);
  expect(() => f.owners.beginRelease(first.ownerId!, 1)).toThrow(/reference/i);
  for (const id of ["placement", "second"]) {
    f.placements.cancel(id, 1);
    f.placements.update(id, 2, value => ({ ...value, preservation: { ...value.preservation, stopConfirmed: true } }), "released");
    f.placements.finishRelease(id, 2, true);
  }
  f.placements.reserve(placementRecord({ id: "unbound", hireToken: "unbound" }), limits);
  f.owners.beginRelease(first.ownerId!, 1);
  expect(() => f.placements.reserve(placementRecord({ id: "late", hireToken: "late", sourceSnapshotId: first.id }), limits)).toThrow(/releasing|retained/i);
  expect(() => f.placements.update("unbound", 1, value => ({ ...value, sourceSnapshotId: second.id }))).toThrow(/releasing|retained/i);
  expect(() => f.placements.captureSnapshot(captureInput())).toThrow(/releasing|retained/i);
  expect(() => f.owners.beginRelease(first.ownerId!, 2)).toThrow(/generation/i);
  expect(new SnapshotStore(f.db).get(first.ownerId!)!.phase).toBe("releasing");
});

it("fails closed for changed owner content or descriptor bindings instead of silently healing them", () => {
  const f = fixture(), snapshot = f.placements.captureSnapshot(captureInput());
  const owner = f.owners.get(snapshot.ownerId!)!;
  f.db.prepare("UPDATE tavern_snapshot_owners SET data=? WHERE id=?").run(JSON.stringify({ ...owner, content: { ...owner.content, tree: "b".repeat(40) } }), owner.id);
  expect(() => f.owners.get(owner.id)).toThrow();
  expect(() => f.placements.snapshot(snapshot.id)).toThrow();
});

it("excludes owner authority from portable capture and rejects forged owner imports before inserts", () => {
  const source = fixture(), target = fixture(); source.placements.captureSnapshot(captureInput());
  const records = new BackupRecords(source.db, new SettingsStore(source.db)), snapshot = records.capture();
  expect(snapshot.tables).not.toHaveProperty("tavern_snapshot_owners");
  const forged = structuredClone(snapshot);
  forged.tables.tavern_snapshot_owners = { columns: ["id", "data"], rows: source.db.prepare("SELECT id,data FROM tavern_snapshot_owners").all() as { id: string; data: string }[] };
  expect(() => new BackupRecords(target.db, new SettingsStore(target.db)).restore(forged)).toThrow(/not a Tavern records table/);
  expect(target.db.prepare("SELECT count(*) AS n FROM tavern_snapshot_owners").get()).toEqual({ n: 0 });
});

it("refuses restoration when only private owner rows remain in the destination", () => {
  const source = fixture(), target = fixture(), snapshot = new BackupRecords(source.db, new SettingsStore(source.db)).capture();
  target.placements.captureSnapshot(captureInput());
  target.db.prepare("DELETE FROM tavern_source_snapshots").run();
  expect(() => new BackupRecords(target.db, new SettingsStore(target.db)).restore(snapshot)).toThrow(/empty/i);
});
