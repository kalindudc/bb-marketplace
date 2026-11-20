// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { PlacementDeliveries } from "../../src/server/placement/delivery";
import { PlacementStore } from "../../src/server/placement/store";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";
import { scopeForClass } from "../../src/scope/presets";
import { placementRecord, sourceSnapshot } from "./placement-fixture";
import type { PlacementRecord } from "../../src/shared/placement";

const hosts = new Set<ReturnType<typeof createFakePluginHost>>();
afterEach(async () => { for (const host of hosts) await host.harness.lifecycle.dispose(); hosts.clear(); });
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function fixture(beforeDeliveryMigration = false, overrides: Partial<PlacementRecord> = {}) {
  const host = createFakePluginHost({ pluginId: "tavern" }); hosts.add(host);
  const db = host.bb.storage.database();
  const deliveryMigration = MIGRATIONS.findIndex(sql => sql.includes("ADD COLUMN scope_delivery_json"));
  expect(deliveryMigration).toBeGreaterThan(0);
  db.exec((beforeDeliveryMigration ? MIGRATIONS.slice(0, deliveryMigration) : MIGRATIONS).join(";\n"));
  const placements = new PlacementStore(db);
  placements.reserve(placementRecord({ memberThreadId: "member", hostId: "guest", environmentId: "guest-env", root: "/guest/repo", phase: "reserved", ...overrides }),
    { maxMakers: 2, maxCheckers: 2 });
  placements.update("placement", 1, value => ({ ...value, phase: "binding" }));
  const deliveries = new PlacementDeliveries(db, placements);
  const template = { ...scopeForClass(overrides.classId ?? "smith"), threadId: "member", issuedAt: 1 };
  const templateDigest = sha(JSON.stringify(template));
  const scopeFileJson = JSON.stringify({ ...template, bindingTemplate: template, workspaceBinding: {
    kind: "linked-worktree", hostId: "guest", environmentId: "guest-env", root: "/guest/repo", placementId: "placement", generation: 1,
    snapshotId: null, expectedTree: null,
  } });
  const prepare = (text = scopeFileJson, digest = templateDigest) => deliveries.prepare("placement", 1, { endpointId: "member-root", templateDigest: digest, scopeFileJson: text });
  const ready = () => placements.update("placement", 1, value => ({ ...value, phase: "ready" }));
  const reply = (binding: { revision: number; scopeDigest: string }) => ({ revision: binding.revision, scopeDigest: binding.scopeDigest,
    scopeFile: "/guest/tavern/scopes/member.json", variables: { HOME: "/guest/home", TMPDIR: "/guest/tmp" } });
  return { ...host, db, placements, deliveries, template, templateDigest, scopeFileJson, prepare, ready, reply };
}

describe("private exact-byte scope delivery persistence", () => {
  it("migrates an existing placement to null, never a fabricated delivery acknowledgment", () => {
    const f = fixture(true);
    const original = f.placements.get("placement");
    expect(f.db.prepare("PRAGMA table_info(tavern_placements)").all()).not.toContainEqual(expect.objectContaining({ name: "scope_delivery_json" }));
    const index = MIGRATIONS.findIndex(sql => sql.includes("ADD COLUMN scope_delivery_json"));
    f.db.exec(MIGRATIONS.slice(index).join(";\n"));
    expect(f.placements.get("placement")).toEqual(original);
    expect(f.deliveries.get("placement")).toBeNull();
    expect(f.deliveries.forThread("member")).toMatchObject({ kind: "unavailable" });
    expect(f.placements.get("placement")?.acknowledgedScopeRevision).toBeNull();
  });

  it("persists exact incoming bytes and their digest, not normalized JSON or rendered guest bytes", () => {
    const f = fixture(), text = `\n${f.scopeFileJson}\n`;
    const delivery = f.prepare(text);
    expect(delivery).toMatchObject({ memberThreadId: "member", environmentId: "guest-env", templateDigest: f.templateDigest,
      scopeFileJson: text, acknowledged: null, binding: { placementId: "placement", generation: 1, endpointId: "member-root",
        hostId: "guest", cwd: "/guest/repo", revision: 1, scopeDigest: sha(text) } });
    const reloaded = new PlacementDeliveries(f.db, new PlacementStore(f.db));
    expect(reloaded.get("placement")).toEqual(delivery);
    expect(delivery.binding.scopeDigest).not.toBe(sha(f.scopeFileJson));
  });

  it("retries the exact same delivery without raising its revision or discarding its ACK", () => {
    const f = fixture(), first = f.prepare();
    f.deliveries.acknowledge("placement", 1, first.binding, f.reply(first.binding));
    const repeated = f.prepare();
    expect(repeated.binding).toEqual(first.binding);
    expect(repeated.acknowledged).not.toBeNull();
    expect(f.placements.get("placement")?.desiredScopeRevision).toBe(1);
  });

  it("raises the desired revision and invalidates an old ACK even for whitespace-only changed delivery bytes", () => {
    const f = fixture(), first = f.prepare();
    f.deliveries.acknowledge("placement", 1, first.binding, f.reply(first.binding));
    const next = f.prepare(`${f.scopeFileJson}\n`);
    expect(next.binding.revision).toBe(2); expect(next.acknowledged).toBeNull();
    expect(f.placements.get("placement")).toMatchObject({ desiredScopeRevision: 2, acknowledgedScopeRevision: null });
    expect(() => f.deliveries.acknowledge("placement", 1, first.binding, f.reply(first.binding))).toThrow(/stale|changed|revision/i);
  });

  it("keeps the originating template fingerprint separate from the delivery digest", () => {
    const f = fixture(), delivery = f.prepare();
    expect(delivery.templateDigest).toBe(f.templateDigest);
    expect(delivery.templateDigest).not.toBe(delivery.binding.scopeDigest);
    expect(() => f.prepare(f.scopeFileJson, "f".repeat(64))).toThrow(/template/i);
  });

  it("exposes only actual native variables and a matching private ACK once content is ready", () => {
    const f = fixture(), delivery = f.prepare();
    expect(f.deliveries.forThread("member")).toMatchObject({ kind: "unavailable" });
    f.deliveries.acknowledge("placement", 1, delivery.binding, f.reply(delivery.binding));
    expect(f.deliveries.forThread("member")).toMatchObject({ kind: "unavailable" });
    f.ready();
    expect(f.deliveries.forThread("member")).toEqual({ kind: "ready", templateDigest: f.templateDigest, expected: delivery.binding,
      acknowledged: { binding: delivery.binding, scopeFile: "/guest/tavern/scopes/member.json", variables: { HOME: "/guest/home", TMPDIR: "/guest/tmp" } } });
  });

  it.each(["revision", "digest", "scope-file", "variables"])("rejects invalid native ACK %s without publishing readiness", kind => {
    const f = fixture(), delivery = f.prepare(), reply = f.reply(delivery.binding);
    if (kind === "revision") reply.revision++;
    if (kind === "digest") reply.scopeDigest = "f".repeat(64);
    if (kind === "scope-file") reply.scopeFile = "controller-relative.json";
    if (kind === "variables") reply.variables = { ...reply.variables, TAVERN_SCOPE_FILE: "/wrong" } as typeof reply.variables;
    expect(() => f.deliveries.acknowledge("placement", 1, delivery.binding, reply)).toThrow();
    expect(f.deliveries.get("placement")?.acknowledged).toBeNull();
    expect(f.placements.get("placement")?.acknowledgedScopeRevision).toBeNull();
  });

  it.each(["hostId", "cwd", "endpointId", "generation", "placementId"])("rejects a reply attached to another expected %s tuple", key => {
    const f = fixture(), delivery = f.prepare();
    const foreign = { ...delivery.binding, [key]: key === "generation" ? 2 : "foreign" };
    expect(() => f.deliveries.acknowledge("placement", 1, foreign, f.reply(delivery.binding))).toThrow(/stale|changed|binding/i);
  });

  it.each(["hostId", "root", "environmentId"] as const)("does not use an ACK after private destination %s changed", key => {
    const f = fixture(), delivery = f.prepare();
    f.deliveries.acknowledge("placement", 1, delivery.binding, f.reply(delivery.binding)); f.ready();
    f.placements.update("placement", 1, value => ({ ...value, [key]: "changed" }));
    expect(f.deliveries.forThread("member")).toMatchObject({ kind: "unavailable" });
    expect(() => f.deliveries.acknowledge("placement", 1, delivery.binding, f.reply(delivery.binding))).toThrow();
  });

  it("cannot acknowledge or expose a cancelled generation", () => {
    const f = fixture(), delivery = f.prepare(); f.placements.cancel("placement", 1);
    expect(() => f.deliveries.acknowledge("placement", 1, delivery.binding, f.reply(delivery.binding))).toThrow(/stale|released/i);
    expect(f.deliveries.forThread("member")).toMatchObject({ kind: "unavailable" });
  });

  it("fails closed on corrupt persisted authority instead of treating it as a local member", () => {
    const f = fixture(); f.prepare();
    f.db.prepare("UPDATE tavern_placements SET scope_delivery_json=? WHERE id='placement'").run('{"binding":"broken"}');
    expect(() => f.deliveries.get("placement")).toThrow();
    expect(f.deliveries.forThread("member")).toMatchObject({ kind: "unavailable" });
    expect(f.deliveries.forThread("unruled-local")).toBeUndefined();
  });

  it.each(["bindingTemplate", "workspaceBinding", "controllerBinding", "hostBinding", "bindingError"])("requires the agreed incoming envelope, with no %s bypass", key => {
    const f = fixture(), envelope = JSON.parse(f.scopeFileJson);
    if (key === "bindingTemplate" || key === "workspaceBinding") delete envelope[key];
    else envelope[key] = key === "bindingError" ? "bad" : {};
    expect(() => f.prepare(JSON.stringify(envelope))).toThrow();
    expect(f.deliveries.get("placement")).toBeNull();
  });

  it.each(["hostId", "environmentId", "root", "placementId", "generation"])("rejects foreign workspace authority %s before storing delivery bytes", key => {
    const f = fixture(), envelope = JSON.parse(f.scopeFileJson);
    envelope.workspaceBinding[key] = key === "generation" ? 2 : "foreign";
    expect(() => f.prepare(JSON.stringify(envelope))).toThrow(/workspace|binding|placement/i);
    expect(f.deliveries.get("placement")).toBeNull();
  });

  it("accepts the canonical native envelope's empty optional binding endpoint map", () => {
    const f = fixture(), envelope = JSON.parse(f.scopeFileJson);
    envelope.bindingEndpoints = {};
    expect(f.prepare(JSON.stringify(envelope)).scopeFileJson).toBe(JSON.stringify(envelope));
  });

  it("rejects a relative workspace root even when corrupt private placement data repeats it", () => {
    const f = fixture(false, { root: "relative/repo" }), envelope = JSON.parse(f.scopeFileJson);
    envelope.workspaceBinding.root = "relative/repo";
    expect(() => f.prepare(JSON.stringify(envelope))).toThrow();
    expect(f.deliveries.get("placement")).toBeNull();
  });

  it("requires a checker's immutable review target and carries exactly that snapshot/tree in the envelope", () => {
    const missing = fixture(false, { classId: "warden", slot: "checker" });
    expect(() => missing.prepare()).toThrow(/checker.*pinned/i);
    const target = { makerThreadId: "maker", makerSubmissionId: "submission", snapshotId: "submission-snapshot", expectedTree: "c".repeat(40),
      journal: { boardQuestId: "quest", waypointId: "waypoint", makerThreadId: "maker", journalEntryId: "entry", entryFingerprint: "d".repeat(64), reviewAssignmentId: "review" } };
    const f = fixture(false, { classId: "warden", slot: "checker", reviewTarget: target });
    const envelope = JSON.parse(f.scopeFileJson);
    envelope.workspaceBinding.snapshotId = target.snapshotId; envelope.workspaceBinding.expectedTree = target.expectedTree;
    const saved = f.prepare(JSON.stringify(envelope));
    expect(saved.binding.hostId).toBe("guest");
    envelope.workspaceBinding.expectedTree = "e".repeat(40);
    expect(() => f.prepare(JSON.stringify(envelope))).toThrow(/checker.*pinned/i);
    expect(f.deliveries.get("placement")).toEqual(saved);
  });

  it("requires a declared maker snapshot/tree pair to match private source authority", () => {
    const f = fixture(false, { sourceSnapshotId: "snapshot" }), envelope = JSON.parse(f.scopeFileJson);
    envelope.workspaceBinding.snapshotId = "snapshot"; envelope.workspaceBinding.expectedTree = "a".repeat(40);
    expect(() => f.prepare(JSON.stringify(envelope))).toThrow(/snapshot.*binding/i);
    f.placements.saveSnapshot(sourceSnapshot());
    const saved = f.prepare(JSON.stringify(envelope));
    envelope.workspaceBinding.expectedTree = "c".repeat(40);
    expect(() => f.prepare(JSON.stringify(envelope))).toThrow(/snapshot.*binding/i);
    expect(f.deliveries.get("placement")).toEqual(saved);
  });

  it("never imports a delivered ACK through portable capture or restore", () => {
    const source = fixture(), delivery = source.prepare();
    source.deliveries.acknowledge("placement", 1, delivery.binding, source.reply(delivery.binding)); source.ready();
    const records = new BackupRecords(source.db, new SettingsStore(source.db));
    const snapshot = records.capture();
    expect(snapshot.tables).not.toHaveProperty("tavern_placements");
    expect(records.empty()).toBe(false);
    const target = createFakePluginHost({ pluginId: "tavern" }); hosts.add(target);
    const db = target.bb.storage.database(); db.exec(MIGRATIONS.join(";\n"));
    const restored = new BackupRecords(db, new SettingsStore(db));
    restored.restore(snapshot);
    expect(db.prepare("SELECT scope_delivery_json FROM tavern_placements").all()).toEqual([]);
    const forged = structuredClone(snapshot);
    forged.tables.tavern_placements = { columns: ["id", "data", "scope_delivery_json"], rows: [{
      id: "placement", data: JSON.stringify(source.placements.get("placement")), scope_delivery_json: JSON.stringify(source.deliveries.get("placement")),
    }] };
    expect(() => restored.restore(forged)).toThrow(/not a Tavern records table/);
    expect(db.prepare("SELECT scope_delivery_json FROM tavern_placements").all()).toEqual([]);
    expect(() => records.restore(snapshot)).toThrow(/empty/);
    expect(source.deliveries.get("placement")?.acknowledged).not.toBeNull();
  });

  it("retains an ACK on an exact replay but rejects conflicting native variables", () => {
    const f = fixture(), delivery = f.prepare(), reply = f.reply(delivery.binding);
    const saved = f.deliveries.acknowledge("placement", 1, delivery.binding, reply);
    expect(f.deliveries.acknowledge("placement", 1, delivery.binding, reply)).toEqual(saved);
    expect(() => f.deliveries.acknowledge("placement", 1, delivery.binding, { ...reply, variables: { HOME: "/other", TMPDIR: "/guest/tmp" } })).toThrow(/changed/);
    expect(f.deliveries.get("placement")).toEqual(saved);
  });

  it("rejects malformed JSON, over-budget bytes and non-JSON persisted receipts", () => {
    const f = fixture();
    expect(() => f.prepare("not json")).toThrow();
    expect(() => f.prepare(`${" ".repeat(2 * 1024 * 1024)}${f.scopeFileJson}`)).toThrow();
    expect(f.deliveries.get("placement")).toBeNull();
    expect(() => f.db.prepare("UPDATE tavern_placements SET scope_delivery_json=? WHERE id='placement'").run("not json")).toThrow(/CHECK/);
    expect(f.deliveries.get("placement")).toBeNull();
  });

  it("never writes to an SDK host, installs a guard or starts a thread while recording delivery intent", () => {
    const f = fixture(); f.prepare();
    expect(f.harness.inspection.sdk.calls).toEqual([]);
    expect(f.harness.experimental_hostRpcCalls).toEqual([]);
  });
});
