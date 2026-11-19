// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import tavern from "../../server";
import { SettingsFiles } from "../../src/server/settings/files";
import { settingsHandlers } from "../../src/server/settings/rpc";
import { SettingsStore } from "../../src/server/settings/store";
import { placementRuleSchema } from "../../src/shared/placement-settings";
import { settingsViewSchema, type SettingsView } from "../../src/shared/settings";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
  finally { vi.unstubAllEnvs(); }
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-registration-authority-"));
  vi.stubEnv("HOME", root);
  const host = createFakePluginHost({ pluginId: "tavern", experimental_declaredIconNames: ["tavern"], dataDir: join(root, "data") });
  cleanups.push(async () => {
    try { await host.harness.lifecycle.dispose(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  await tavern(host.bb);
  const view = async () => settingsViewSchema.parse(await host.harness.behavior.callRpc("settings", null));
  return { ...host, root, view };
}

async function prepared() {
  const f = await fixture();
  await expect(f.harness.behavior.callRpc("settingsUpdate", {
    revision: 0, patch: { machines: { maxMakers: 9 } }, why: "User setting",
  })).resolves.toHaveProperty("code", "ok");
  const store = new SettingsStore(f.bb.storage.database());
  store.saveSuggestions([{ key: "tickSeconds", value: 75, reason: "Recorded pacing evidence",
    evidence: { section: "attention", chart: "ticks" }, at: Date.now(), revision: 1 }]);
  const path = (await f.view()).file.path;
  expect(path).toBe(join(f.root, ".agents/tavern/settings.toml"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "[machines]\nmax_makers=7\n");
  return { ...f, before: await f.view() };
}

it("refuses plugin-origin machine settings through the actual combined server registration", async () => {
  const { harness } = await fixture();
  const request = harness.behavior.callRpc("settingsUpdate", {
    revision: 0, patch: { machines: { maxMakers: 9 } }, why: "Plugin mutation",
  }, { experimental_caller: { kind: "plugin", pluginId: "other-plugin" } }).then(() => "accepted");
  await expect(request).rejects.toMatchObject({ code: "forbidden" });
  await expect(harness.behavior.callRpc("settings", null)).resolves.toMatchObject({
    revision: 0, effective: { machines: { maxMakers: 2 } },
  });
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
});

const remoteRule = placementRuleSchema.parse({ id: "remote", label: "Remote", enabled: false, match: {},
  consent: { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true },
  target: { kind: "provider", environmentProviderId: "checkout", workspace: "dedicated-machine", inputs: {},
    machine: { type: "new", machineProviderId: "machines", inputs: {} } },
});
const writes = [
  { method: "settingsUpdate", label: "routing, consent and budgets", input: (s: SettingsView) => ({ revision: s.revision,
    patch: { keepers: { partyMax: 12 }, scopes: { mode: "off" }, machines: { rules: [remoteRule] } }, why: "Plugin routing and consent" }) },
  { method: "settingsUndo", label: "Undo", input: (s: SettingsView) => ({ id: s.history[0]!.id, revision: s.revision, why: "Plugin Undo" }) },
  { method: "settingsImport", label: "apply", input: (s: SettingsView) => ({ toml: "[machines]\nmax_makers=5\n", apply: true, revision: s.revision }) },
  { method: "settingsFile", label: "load", input: (s: SettingsView) => ({ action: "load", apply: true, revision: s.revision, expectedHash: s.file.hash! }) },
  { method: "settingsFile", label: "save", input: (s: SettingsView) => ({ action: "save", revision: s.revision }) },
  { method: "settingsEndOverride", label: "end override", input: (s: SettingsView) => ({ boardQuestId: "quest", key: "staleMinutes", revision: s.revision }) },
  { method: "settingsApplySuggestion", label: "apply", input: (s: SettingsView) => ({ key: "tickSeconds", revision: s.revision }) },
];

it.each(writes.flatMap(write => ["other-plugin", "tavern"].map(pluginId => ({ ...write, pluginId }))))(
  "refuses $method $label from $pluginId without changing settings, audit, suggestions or files",
  async ({ method, input, pluginId }) => {
    const f = await prepared(), text = readFileSync(f.before.file.path, "utf8");
    const request = f.harness.behavior.callRpc(method, input(f.before), {
      experimental_caller: { kind: "plugin", pluginId },
    }).then(() => "accepted");
    await expect(request).rejects.toMatchObject({ code: "forbidden" });
    expect(await f.view()).toEqual(f.before);
    expect(readFileSync(f.before.file.path, "utf8")).toBe(text);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  },
);

it.each(["other-plugin", "tavern"])("allows read-only settings and previews from %s", async pluginId => {
  const f = await prepared(), options = { experimental_caller: { kind: "plugin" as const, pluginId } };
  await expect(f.harness.behavior.callRpc("settings", null, options)).resolves.toHaveProperty("revision", 1);
  await expect(f.harness.behavior.callRpc("settingsExport", {}, options)).resolves.toHaveProperty("toml");
  await expect(f.harness.behavior.callRpc("settingsImport", { toml: "[machines]\nmax_makers=5", apply: false }, options)).resolves.toHaveProperty("code", "preview");
  await expect(f.harness.behavior.callRpc("settingsFile", { action: "status" }, options)).resolves.toHaveProperty("preview", null);
  await expect(f.harness.behavior.callRpc("settingsFile", { action: "load", apply: false }, options)).resolves.toHaveProperty("preview.code", "preview");
  expect(await f.view()).toEqual(f.before);
  expect(readFileSync(f.before.file.path, "utf8")).toBe("[machines]\nmax_makers=7\n");
});

it("keeps every mutation available to an explicit client through the combined registration", async () => {
  const f = await prepared(), options = { experimental_caller: { kind: "client" as const } };
  await expect(f.harness.behavior.callRpc("settingsFile", { action: "save", revision: 1 }, options)).resolves.toHaveProperty("file.error", null);
  expect(readFileSync(f.before.file.path, "utf8")).toContain("max_makers = 9");
  writeFileSync(f.before.file.path, "[machines]\nmax_makers=7\n");
  await expect(f.harness.behavior.callRpc("settingsFile", { action: "load", apply: true, revision: 1, expectedHash: (await f.view()).file.hash }, options)).resolves.toHaveProperty("preview.code", "applied");
  await expect(f.harness.behavior.callRpc("settingsImport", { toml: "[machines]\nmax_makers=5\n", apply: true, revision: 2, why: "Client import" }, options)).resolves.toHaveProperty("code", "applied");
  const imported = await f.view(), decision = imported.history.find(row => row.reason === "Client import")!;
  await expect(f.harness.behavior.callRpc("settingsUndo", { id: decision.id, revision: imported.revision, why: "Client Undo" }, options)).resolves.toHaveProperty("code", "ok");
  expect((await f.view()).effective.machines.maxMakers).toBe(7);
  await expect(f.harness.behavior.callRpc("settingsUpdate", {
    revision: (await f.view()).revision, patch: { tuning: { mode: "suggest" } }, why: "Enable suggestions",
  }, options)).resolves.toHaveProperty("code", "ok");
  const store = new SettingsStore(f.bb.storage.database()), revision = (await f.view()).revision;
  store.saveSuggestions([{ key: "tickSeconds", value: 75, reason: "Recorded pacing evidence",
    evidence: { section: "attention", chart: "ticks" }, at: Date.now(), revision }]);
  await expect(f.harness.behavior.callRpc("settingsApplySuggestion", { key: "tickSeconds", revision }, options)).resolves.toHaveProperty("code", "ok");
  expect((await f.view()).rows.find(row => row.key === "tickSeconds")?.value).toBe(75);
  expect((await f.view()).suggestions).toEqual([]);
});

it("fails closed when the shared factory is called without trusted caller context", async () => {
  const f = await fixture(), store = new SettingsStore(f.bb.storage.database());
  const handlers = settingsHandlers(store, new SettingsFiles(store, join(f.root, "settings.toml")));
  expect(() => Reflect.apply(handlers.settingsUpdate, undefined, [{
    revision: 0, patch: { machines: { maxMakers: 9 } }, why: "Missing context",
  }])).toThrow("requires an explicit client action");
  expect((await f.view()).revision).toBe(0);
});
