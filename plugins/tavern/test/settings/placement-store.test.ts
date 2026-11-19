import Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { placementRuleSchema } from "../../src/shared/placement-settings";
import { settingsSnapshotSchema } from "../../src/shared/settings";
import { SettingsStore, SettingsConflict } from "../../src/server/settings/store";
import { exportToml, previewToml } from "../../src/server/settings/toml";
import { importSettings } from "../../src/server/settings/files";
import { MIGRATIONS } from "../../src/server/migrations";
import type { Database } from "../../src/server/ports";

const databases: Sqlite.Database[] = [];
function fixture() {
  const db = new Sqlite(":memory:"); databases.push(db); db.exec(MIGRATIONS.join("\n"));
  const warnings: string[] = [];
  const store = new SettingsStore(db as unknown as Database, Date.now, undefined, message => { warnings.push(message); });
  const row = () => (db.prepare("SELECT data FROM tavern_settings WHERE id=1").get() as { data: string }).data;
  return { db, store, warnings, row };
}
function local(id: string) { return placementRuleSchema.parse({ id, label: id, enabled: true, match: {}, target: { kind: "current" } }); }
function remote(id: string, inputs: unknown) {
  return placementRuleSchema.parse({ id, label: id, enabled: true, match: { classes: ["smith"] },
    consent: { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true },
    target: { kind: "provider", environmentProviderId: "unavailable-is-preserved", workspace: "dedicated-machine", inputs,
      machine: { type: "new", machineProviderId: "unknown-provider", inputs } } });
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe("placement settings persistence", () => {
  it("round trips partial and complete class model choices through TOML", () => {
    const { store } = fixture();
    const classModels = { smith: { model: "vendor/model" }, warden: { provider: "pi", model: "vendor/checker", reasoning: "high" } };
    store.update({ revision: 0, patch: { machines: { rules: [{ ...local("models"), classModels }] } }, why: "Models on machines" });
    const preview = previewToml(exportToml(store.snapshot()), store.snapshot());
    expect(preview.problems).toEqual([]);
    expect(preview.user.machines?.rules?.[0]?.classModels).toEqual(classModels);
  });
  it("reads legacy absent policy without rewriting the database or changing authorization budgets", () => {
    const { store, row } = fixture(), before = row();
    expect(store.placementPolicy()).toEqual({ state: "valid", revision: 0, settings: { maxMakers: 2, maxCheckers: 2, rules: [], forges: [] } });
    expect(store.read().keepers.partyMax).toBe(5); expect(row()).toBe(before);
  });
  it("atomically reorders rules without resetting caps or budgets and undoes only that array", () => {
    const { store } = fixture();
    store.update({ revision: 0, patch: { machines: { maxMakers: 200, maxCheckers: 100, rules: [local("one"), local("two")] }, keepers: { partyMax: 17 } }, why: "Set placement" });
    const changed = store.update({ revision: 1, patch: { machines: { rules: [local("two"), local("one")] } }, why: "Reorder" })!;
    expect(store.read().machines).toMatchObject({ maxMakers: 200, maxCheckers: 100 });
    expect(changed.changes.map(change => change.key)).toEqual(["machines.rules"]);
    store.update({ revision: 2, patch: { tavern: { voice: "light" } }, why: "Unrelated" });
    store.undo(changed.id, "Undo order", 3);
    expect(store.read().machines.rules.map(rule => rule.id)).toEqual(["one", "two"]);
    expect(store.read().keepers.partyMax).toBe(17); expect(store.read().tavern.voice).toBe("light");
    expect(() => store.update({ revision: 0, patch: { machines: { rules: [] } }, why: "Stale" })).toThrow(SettingsConflict);
  });
  it("keeps corrupted policy blocked through unrelated edits and allows explicit repair", () => {
    const { db, store, row } = fixture();
    const broken = { maxMakers: 20, rules: "not-an-array" };
    db.prepare("UPDATE tavern_settings SET data=? WHERE id=1").run(JSON.stringify({ user: { machines: broken, keepers: { partyMax: 19 } }, pinned: {}, tuned: {}, overrides: {} }));
    expect(store.placementPolicy()).toMatchObject({ state: "invalid", revision: 0 });
    expect(store.read().keepers.partyMax).toBe(19);
    expect(() => settingsSnapshotSchema.parse(store.snapshot())).not.toThrow();
    expect(store.snapshot().placementPolicy).toMatchObject({ state: "invalid" });
    expect(() => exportToml(store.snapshot())).toThrow(/placement.*invalid|invalid.*placement/i);
    store.update({ revision: 0, patch: { attention: { reviewBudget: 7 } }, why: "Unrelated" });
    expect(JSON.parse(row()).user.machines).toEqual(broken);
    expect(store.placementPolicy()).toMatchObject({ state: "invalid", revision: 1 });
    expect(() => store.update({ revision: 1, patch: { machines: { maxMakers: 30 } }, why: "Not a repair" })).toThrow(/rules|repair/i);
    store.update({ revision: 1, patch: { machines: { rules: [local("repaired")] } }, why: "Repair the policy" });
    expect(store.placementPolicy()).toMatchObject({ state: "valid", revision: 2, settings: { maxMakers: 20, rules: [{ id: "repaired" }] } });
  });
  it("blocks present invalid policy and unreadable state rather than selecting compatibility routes", () => {
    const { db, store } = fixture();
    for (const machines of [null, 1, [], { maxMakers: 0 }, { obsolete: true }, { rules: [local("same"), local("same")] }]) {
      db.prepare("UPDATE tavern_settings SET data=? WHERE id=1").run(JSON.stringify({ user: { machines }, pinned: {}, tuned: {}, overrides: {} }));
      expect(store.placementPolicy().state).toBe("invalid"); expect(() => store.read()).not.toThrow();
    }
    db.prepare("UPDATE tavern_settings SET data=? WHERE id=1").run("{broken");
    expect(store.placementPolicy().state).toBe("invalid"); expect(() => store.snapshot()).not.toThrow();
    expect(importSettings(store, "", true, 0).code).toBe("applied");
    expect(store.placementPolicy().state).toBe("valid");
  });
  it("preserves opaque keys through audits, response validation, history and undo", () => {
    const { store } = fixture(), input = JSON.parse('{"memoryGb":8,"opaqueKey":{"data":true},"nested":[null,{"Mixed_Key":true}]}');
    const original = remote("remote", input);
    store.update({ revision: 0, patch: { machines: { rules: [original] } }, why: "Configure" });
    const replaced = store.update({ revision: 1, patch: { machines: { rules: [] } }, why: "Disable" })!;
    expect(JSON.stringify(replaced.changes[0]!.from)).toBe(JSON.stringify([original]));
    expect(JSON.stringify(settingsSnapshotSchema.parse(store.snapshot()).history[0]!.changes[0]!.from)).toBe(JSON.stringify([original]));
    store.undo(replaced.id, "Restore", 2);
    expect(JSON.stringify(store.read().machines.rules)).toBe(JSON.stringify([original]));
    expect(Object.prototype).not.toHaveProperty("data");
  });
  it("refuses machine-policy Undo while corrupted rules would hide that change", () => {
    const { db, store, row } = fixture();
    const change = store.update({ revision: 0, patch: { machines: { maxMakers: 20 } }, why: "Capacity" })!;
    const raw = JSON.parse(row()); raw.user.machines.rules = "broken";
    db.prepare("UPDATE tavern_settings SET data=? WHERE id=1").run(JSON.stringify(raw));
    const before = row();
    expect(store.snapshot().history[0]!.undoable).toBe(false);
    expect(() => store.undo(change.id, "Undo capacity", 1)).toThrow(/repair/i);
    expect(row()).toBe(before);
  });
  it("rejects unexportable whole configurations atomically", () => {
    const { store, row } = fixture(), before = row(), inputs = "x".repeat(32766);
    expect(() => store.update({ revision: 0, patch: { machines: { rules: [remote("one", inputs), remote("two", inputs)] } }, why: "Too large" })).toThrow(/131072|128|large|bytes/i);
    expect(row()).toBe(before); expect(store.snapshot().history).toEqual([]);
  });
});

describe("placement TOML", () => {
  it.each([null, { memoryGb: 8, fromLaptopBranch: "{keeper.branch}", NestedKey: [{ Mixed_Key: true }] },
    { nested: [null, { Nullable: null }] }, JSON.parse('{"opaqueKey":{"data":true},"nested":[{"mixedKey":null}]}')])("round-trips native or escaped inputs without rewriting data keys: %j", inputs => {
    const { store } = fixture(), rule = remote("roundtrip", inputs);
    store.update({ revision: 0, patch: { machines: { maxMakers: 333, rules: [rule] } }, why: "Roundtrip" });
    const toml = exportToml(store.snapshot());
    expect(toml).toContain("max_makers = 333"); expect(toml).toContain("[[machines.rules]]");
    const preview = previewToml(toml, store.snapshot());
    expect(preview.problems).toEqual([]); expect(preview.changes).toEqual([]);
    expect(JSON.stringify(preview.user.machines?.rules)).toBe(JSON.stringify([rule]));
    if (inputs === null || JSON.stringify(inputs).includes("null") || Object.hasOwn(inputs as object, "__proto__")) expect(toml).toContain("inputs_json");
    else { expect(toml).toContain("memoryGb"); expect(toml).not.toContain("memory_gb"); }
  });
  it.each(["__proto__", "constructor", "prototype"])("rejects reserved key %s in TOML with its source line and nested path", key => {
    const { store } = fixture();
    const inputs = JSON.stringify({ nested: [Object.fromEntries([[key, true]])] });
    const toml = `[[machines.rules]]
id="bad"
label="Bad"
enabled=false
match={}
[machines.rules.target]
kind="provider"
environment_provider_id="env"
workspace="linked-worktree"
inputs_json='${inputs}'
[machines.rules.target.machine]
type="keeper"`;
    const preview = previewToml(toml, store.snapshot());
    expect(preview.problems).toEqual([expect.objectContaining({ line: 10,
      message: `Provider inputs can't use the key ${key} (rules[0].target.inputs.nested[0]): bb's RPC can't carry it` })]);
    expect(importSettings(store, toml, true, 0).code).toBe("invalid");
    expect(store.snapshot().revision).toBe(0);
  });
  it("reports conflicts and JSON errors at their own array-table line", () => {
    const { store } = fixture();
    const source = '[[machines.rules]]\nid="one"\nlabel="One"\nenabled=false\nmatch={}\n[machines.rules.target]\nkind="provider"\nenvironment_provider_id="env"\nworkspace="linked-worktree"\ninputs={}\ninputs_json="null"\n[machines.rules.target.machine]\ntype="keeper"';
    expect(previewToml(source, store.snapshot()).problems).toContainEqual(expect.objectContaining({ line: 11, key: "machines.rules.0.target.inputs_json" }));
    expect(previewToml(source.replace('inputs={}\n', "").replace('inputs_json="null"', 'inputs_json="broken"'), store.snapshot()).problems[0]!.line).toBe(10);
    const caps = previewToml("[machines]\nmax_makers=1001\nmax_checkers=0", store.snapshot());
    expect(caps.problems).toEqual(expect.arrayContaining([expect.objectContaining({ line: 2, allowed: "1 to 1000" }), expect.objectContaining({ line: 3, allowed: "1 to 1000" })]));
  });
});
