// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import tavern from "../../server";
import { SettingsFiles } from "../../src/server/settings/files";
import { registerSettingsRpc } from "../../src/server/settings/rpc";
import { SettingsStore } from "../../src/server/settings/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { settingsMutationSchema, settingsViewSchema } from "../../src/shared/settings";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const dispose of cleanup.splice(0)) await dispose(); } finally { vi.unstubAllEnvs(); } });
async function fixture(combined = false) {
  const root = mkdtempSync(join(tmpdir(), "tavern-placement-repair-"));
  vi.stubEnv("HOME", root);
  const f = createFakePluginHost({ pluginId: "tavern", experimental_declaredIconNames: ["tavern"], dataDir: join(root, "data") });
  cleanup.push(async () => { await f.harness.lifecycle.dispose(); rmSync(root, { recursive: true, force: true }); });
  if (combined) await tavern(f.bb);
  const db = f.bb.storage.database();
  if (!combined) db.exec(MIGRATIONS.join("\n"));
  const pending = { afterCommit: undefined as (() => void) | undefined };
  const store = new SettingsStore(db, () => 1000, () => { const next = pending.afterCommit; pending.afterCommit = undefined; next?.(); }, () => {});
  if (!combined) registerSettingsRpc(f.bb, store, new SettingsFiles(store, join(root, "settings.toml")));
  const stored = () => (db.prepare("SELECT revision,data FROM tavern_settings WHERE id=1").get() as { revision: number; data: string });
  const corrupt = (value: unknown) => db.prepare("UPDATE tavern_settings SET data=? WHERE id=1").run(JSON.stringify({
    user: { machines: value, classes: { smith: { model: "unrelated-setting" } } }, pinned: {}, tuned: {}, overrides: {},
  }));
  return { ...f, db, store, stored, corrupt, pending,
    view: async () => settingsViewSchema.parse(await f.harness.behavior.callRpc("settings", null)),
    update: async (patch: unknown, revision = store.snapshot().revision) => settingsMutationSchema.parse(await f.harness.behavior.callRpc("settingsUpdate", { revision, patch, why: "Rule edit" })),
  };
}

describe("invalid machine policy repair read", () => {
  it.each([undefined, { maxMakers: 7, rules: [] }])("does not expose raw policy for valid or absent machine settings: %j", async value => {
    const f = await fixture();
    if (value !== undefined) f.corrupt(value);
    const before = f.stored();
    expect(f.store.placementRepair()).toMatchObject({ placementPolicy: { state: "valid", revision: 0 }, placementRawJson: null });
    expect(await f.view()).toHaveProperty("placementRawJson", null);
    expect(f.stored()).toEqual(before);
  });

  it.each([null, 3, [], { rules: "broken" }, { maxMakers: 0, rules: [] }])("returns invalid values as JSON text, without repairing or defaulting them: %j", async value => {
    const f = await fixture(); f.corrupt(value); const before = f.stored();
    const read = f.store.placementRepair();
    expect(read.placementPolicy).toMatchObject({ state: "invalid", revision: 0 });
    expect(read.placementRawJson).toBe(JSON.stringify(value));
    expect(await f.view()).toMatchObject({ placementPolicy: { state: "invalid", revision: 0 }, placementRawJson: JSON.stringify(value) });
    expect(f.stored()).toEqual(before); expect(f.store.snapshot().history).toEqual([]);
  });

  it("survives the SDK's reserved-key output normalization by carrying only JSON text", async () => {
    const f = await fixture(true);
    const value = JSON.parse('{"rules":[{"id":"bad","target":{"inputs":{"MixedKey":[{"__proto__":{"still":"data"},"constructor":null}]}}}]}');
    f.corrupt(value);
    const view = await f.view();
    expect(view.placementRawJson).toBe(JSON.stringify(value));
    const restored = JSON.parse(view.placementRawJson!);
    expect(Object.hasOwn(restored.rules[0].target.inputs.MixedKey[0], "__proto__")).toBe(true);
    expect(restored).toEqual(value);
    expect(Object.prototype).not.toHaveProperty("still");
  });

  it.each(["{broken", JSON.stringify({ user: null }), JSON.stringify({ user: [] })])("does not expose unrelated raw settings when the stored envelope is unreadable: %s", async text => {
    const f = await fixture(); f.db.prepare("UPDATE tavern_settings SET data=? WHERE id=1").run(text);
    expect(f.store.placementRepair()).toMatchObject({ placementPolicy: { state: "invalid" }, placementRawJson: null });
    expect(await f.view()).toHaveProperty("placementRawJson", null);
    expect(f.stored().data).toBe(text);
  });

  it("keeps the same invalid value through unrelated edits, then clears raw data only after explicit repair", async () => {
    const f = await fixture(true), value = { maxMakers: 9, rules: "broken" }; f.corrupt(value);
    const unrelated = await f.update({ tavern: { voice: "light" } });
    expect(unrelated).toMatchObject({ code: "ok", settings: { placementPolicy: { state: "invalid", revision: 1 }, placementRawJson: JSON.stringify(value) } });
    const repaired = await f.update({ machines: { rules: [] } });
    expect(repaired).toMatchObject({ code: "ok", settings: { placementPolicy: { state: "valid", revision: 2 }, placementRawJson: null } });
    expect(f.store.read().machines).toMatchObject({ maxMakers: 9, rules: [] });
  });

  it("returns detached policy data so display consumers cannot change admission", async () => {
    const f = await fixture(); f.corrupt({ rules: "broken" });
    const result = f.store.placementRepair();
    if (result.placementPolicy.state !== "invalid") throw new Error("Expected invalid policy");
    result.placementPolicy.problems[0]!.message = "changed";
    expect(f.store.placementPolicy()).not.toMatchObject({ problems: [{ message: "changed" }] });
  });
});

describe("committed settings decision receipt", () => {
  it("returns the exact update decision through the actual combined server registration", async () => {
    const f = await fixture(true);
    const result = await f.update({ machines: { maxMakers: 8 } });
    expect(result).toMatchObject({ code: "ok", revision: 1, decisionId: expect.any(String) });
    const decision = f.store.snapshot().history.find(row => row.id === result.decisionId);
    expect(decision).toMatchObject({ reason: "Rule edit", changes: [{ key: "machines.maxMakers", to: 8 }] });
  });

  it("does not guess history[0] when a synchronous post-commit change writes a later decision", async () => {
    const f = await fixture();
    f.pending.afterCommit = () => { f.store.update({ revision: 1, patch: { tavern: { voice: "light" } }, why: "Later decision" }); };
    const result = await f.update({ machines: { maxMakers: 8 } });
    expect(result).toMatchObject({ code: "ok", revision: 2, decisionId: expect.any(String) });
    expect(result.decisionId).not.toBe(result.settings!.history[0]!.id);
    expect(result.settings!.history.find(row => row.id === result.decisionId)?.reason).toBe("Rule edit");
    expect(result.settings!.history[0]!.reason).toBe("Later decision");
  });

  it("returns a new Undo decision id rather than the decision being undone", async () => {
    const f = await fixture(true), first = await f.update({ machines: { maxMakers: 8 } });
    const result = settingsMutationSchema.parse(await f.harness.behavior.callRpc("settingsUndo", {
      id: first.decisionId, revision: 1, why: "Undo rule edit",
    }));
    expect(result).toMatchObject({ code: "ok", revision: 2, decisionId: expect.any(String) });
    expect(result.decisionId).not.toBe(first.decisionId);
    expect(result.settings!.history.find(row => row.id === result.decisionId)?.reason).toBe("Undo rule edit");
    expect(result.settings!.effective.machines.maxMakers).toBe(2);
  });

  it("omits a receipt for a no-op rather than recycling the previous decision", async () => {
    const f = await fixture(true); await f.update({ machines: { maxMakers: 8 } });
    const result = await f.update({ machines: { maxMakers: 8 } });
    expect(result).toMatchObject({ code: "ok", revision: 1 });
    expect(Object.hasOwn(result, "decisionId")).toBe(false);
  });

  it("omits receipts for stale and invalid mutations", async () => {
    const f = await fixture(true); await f.update({ machines: { maxMakers: 8 } });
    const stale = await f.update({ machines: { maxMakers: 9 } }, 0);
    const invalid = settingsMutationSchema.parse(await f.harness.behavior.callRpc("settingsUndo", { id: "missing", revision: 1, why: "No decision" }));
    expect(stale.code).toBe("stale"); expect(invalid.code).toBe("invalid");
    expect(Object.hasOwn(stale, "decisionId")).toBe(false);
    expect(Object.hasOwn(invalid, "decisionId")).toBe(false);
    expect(f.store.snapshot().revision).toBe(1);
  });
});
