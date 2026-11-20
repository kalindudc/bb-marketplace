import Sqlite from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { placementRuleSchema } from "../../src/shared/placement-settings";
import { SettingsStore } from "../../src/server/settings/store";
import { SettingsFiles } from "../../src/server/settings/files";
import { registerSettingsRpc } from "../../src/server/settings/rpc";
import { MIGRATIONS } from "../../src/server/migrations";
import type { Database } from "../../src/server/ports";

const cleanups: (() => Promise<void>)[] = [];
function fixture() {
  const host = createFakePluginHost({ pluginId: "tavern" });
  const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join(";\n"));
  const root = mkdtempSync(join(tmpdir(), "placement-rpc-"));
  const store = new SettingsStore(db as unknown as Database), files = new SettingsFiles(store, join(root, "settings.toml"));
  registerSettingsRpc(host.bb, store, files);
  cleanups.push(async () => { await host.harness.lifecycle.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { ...host, store, files };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const plugin = { experimental_caller: { kind: "plugin" as const, pluginId: "other-plugin" } };

it("preserves allowed opaque values through the official JSON RPC input and output driver", async () => {
  const { harness } = fixture();
  const inputs = JSON.parse('{"memoryGb":8,"opaqueKey":{"data":true},"nested":[null,{"Mixed_Key":true}]}');
  const rule = placementRuleSchema.parse({ id: "remote", label: "Remote", enabled: true, match: {},
    consent: { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true },
    target: { kind: "provider", environmentProviderId: "checkout", workspace: "dedicated-machine", inputs,
      machine: { type: "new", machineProviderId: "machines", inputs } } });
  const result = await harness.behavior.callRpc("settingsUpdate", { revision: 0, patch: { machines: { rules: [rule] } }, why: "Enable rule" }) as { code: string; settings: { effective: { machines: { rules: unknown[] } } } };
  expect(result.code).toBe("ok"); expect(JSON.stringify(result.settings.effective.machines.rules)).toBe(JSON.stringify([rule]));
  const exported = await harness.behavior.callRpc("settingsExport", {}) as { toml: string };
  expect(exported.toml).toContain("inputs_json"); expect(Object.prototype).not.toHaveProperty("data");
});

it("refuses plugin-origin settings writes, including replacement, undo and saved-file applies", async () => {
  const { harness, store, files } = fixture();
  const decision = store.update({ revision: 0, patch: { machines: { maxMakers: 9 } }, why: "User setting" })!;
  writeFileSync(files.path, "[machines]\nmax_makers=5\n");
  const calls = [
    ["settingsUpdate", { revision: 1, patch: { machines: { rules: [] } }, why: "Plugin" }],
    ["settingsImport", { toml: "", apply: true, revision: 1 }],
    ["settingsUndo", { id: decision.id, revision: 1, why: "Plugin" }],
    ["settingsFile", { action: "load", apply: true, revision: 1, expectedHash: files.status().hash }],
    ["settingsFile", { action: "save", revision: 1 }],
    ["settingsApplySuggestion", { key: "tickSeconds", revision: 1 }],
  ] as const;
  for (const [method, input] of calls)
    await expect(harness.behavior.callRpc(method, input, plugin)).rejects.toMatchObject({ code: "forbidden" });
  expect(store.snapshot().revision).toBe(1); expect(store.read().machines.maxMakers).toBe(9);
});

it("records the pinned SDK reserved-key limitation and rejects such machine configuration before storage", async () => {
  const { bb, harness, store } = fixture();
  bb.rpc.register({ reservedKeyProbe: { input: z.null(), output: z.unknown() } }, {
    reservedKeyProbe: () => JSON.parse('{"__proto__":{"opaqueFixture":true}}'),
  });
  const probe = await harness.behavior.callRpc("reservedKeyProbe", null);
  expect(Object.hasOwn(probe as object, "__proto__")).toBe(false);
  expect(Object.getPrototypeOf(probe)).toEqual({ opaqueFixture: true });
  expect(Object.prototype).not.toHaveProperty("opaqueFixture");
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const inputs = JSON.parse(`{"nested":[{"${key}":true}]}`);
    await expect(harness.behavior.callRpc("settingsUpdate", { revision: 0, patch: { machines: { rules: [{
      id: "remote", label: "Remote", enabled: false, match: {},
      target: { kind: "provider", environmentProviderId: "checkout", workspace: "linked-worktree", inputs, machine: { type: "keeper" } },
    }] } }, why: "Unsupported input" })).rejects.toMatchObject({ code: "invalid_input", issues: [expect.objectContaining({
      message: `Provider inputs can't use the key ${key} (rules[0].target.inputs.nested[0]): bb's RPC can't carry it`,
    })] });
  }
  expect(store.snapshot().revision).toBe(0);
});
it("allows plugin read/preview calls without granting mutation or creating a file", async () => {
  const { harness, store } = fixture();
  await expect(harness.behavior.callRpc("settings", null, plugin)).resolves.toHaveProperty("placementPolicy.state", "valid");
  await expect(harness.behavior.callRpc("settingsImport", { toml: "[machines]\nmax_makers=10", apply: false }, plugin)).resolves.toHaveProperty("code", "preview");
  await expect(harness.behavior.callRpc("settingsFile", { action: "load", apply: false }, plugin)).resolves.toHaveProperty("preview.code", "invalid");
  expect(store.snapshot().revision).toBe(0);
});
