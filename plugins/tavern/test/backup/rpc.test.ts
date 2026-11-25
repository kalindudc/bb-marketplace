// @vitest-environment node
import { expect, it } from "vitest";
import { backupContract } from "../../src/shared/backup";
import { sealBundle } from "../../src/server/backup/codec";
import { registerBackupRpc } from "../../src/server/backup/rpc";
import { createFakePluginHost } from "../server/host";
import { fixture, override } from "./helpers";
function setup() {
  const f = fixture(), host = createFakePluginHost({ pluginId: "tavern", sdk: {} });
  registerBackupRpc(host.bb, f.backup); return { ...f, ...host };
}
it("returns the agreed list and save payloads without implementation-only fields", async () => {
  const f = setup();
  const list = backupContract.backupList.output.parse(await f.harness.invokeRpc("backupList", {}));
  expect(list).toMatchObject({ dir: f.backup.dir, keep: 14, backups: [], error: null, exportLimitBytes: 8 * 1024 * 1024 });
  expect(list.dataBytes).toBeGreaterThan(0);
  const saved = await f.harness.invokeRpc("backupSave", { withData: false, projects: false });
  expect(backupContract.backupSave.output.parse(saved).code).toBe("ok");
  expect(saved).not.toHaveProperty("manifest"); expect(saved).not.toHaveProperty("path");
});
it("exports selected parts and returns the selected source file verbatim", async () => {
  const f = setup(), custom = override(f);
  const file = backupContract.registryFile.output.parse(await f.harness.invokeRpc("registryFile", { kind: "class", id: "smith" }));
  expect(file).toMatchObject({ text: custom.raw, filename: "custom-name.md", source: "global" });
  const result = backupContract.backupExport.output.parse(await f.harness.invokeRpc("backupExport", { withData: false, projects: false, parts: ["characters"] }));
  expect(result.code).toBe("ok");
  if (result.code === "ok") { const bundle = JSON.parse(result.json); expect(bundle.manifest.counts.classes).toBe(0); expect(bundle.manifest.files.every((file: { kind: string }) => file.kind === "character")).toBe(true); }
});
it("reports the data estimate and refuses an over-8-MiB RPC export without partial JSON", async () => {
  const f = setup();
  f.db.prepare("INSERT INTO tavern_events(at,keeper_thread_id,board_quest_id,actor,type,text,data) VALUES(1,NULL,NULL,?,?,?,?)").run('{"kind":"tavern"}', "backup.size", "", JSON.stringify({ value: "x".repeat(8 * 1024 * 1024) }));
  const list = backupContract.backupList.output.parse(await f.harness.invokeRpc("backupList", {}));
  expect(list.dataBytes).toBeGreaterThan(list.exportLimitBytes);
  const result = backupContract.backupExport.output.parse(await f.harness.invokeRpc("backupExport", { withData: true, projects: false }));
  expect(result.code).toBe("too-large");
  if (result.code === "too-large") { expect(result.bytes).toBeGreaterThan(result.limit); expect(result.limit).toBe(8 * 1024 * 1024); expect(result.json).toBeNull(); }
});
it("refuses non-client backup restores and skips forge profiles even for a client", async () => {
  const source = setup(), target = setup();
  source.settings.update({ revision: 0, patch: { machines: { forges: [{ id: "incoming", name: "Incoming", enabled: true, kind: "command", open: "incoming" }] }, tavern: { repeatSeconds: 7 } }, why: "Page" });
  target.settings.update({ revision: 0, patch: { machines: { forges: [{ id: "current", name: "Current", enabled: true, kind: "command", open: "current" }] } }, why: "Page" });
  const exported = await source.backup.export({}), from = { bundle: exported.json! };
  await expect(target.harness.invokeRpc("backupRestore", { from, apply: false }, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow("backupRestore requires an explicit client action");
  const preview = backupContract.backupRestore.output.parse(await target.harness.invokeRpc("backupRestore", { from, apply: false }));
  expect(preview.skippedForgeProfiles).toContain("incoming");
  const applied = backupContract.backupRestore.output.parse(await target.harness.invokeRpc("backupRestore", { from, apply: true, previewHash: preview.previewHash }));
  expect(applied.code).toBe("applied");
  expect(target.settings.read().machines.forges.map(profile => profile.id)).toEqual(["current"]);
  expect(target.settings.read().tavern.repeatSeconds).toBe(7);
});
it("restores legacy speech settings without reintroducing the caps", async () => {
  const f = setup();
  const exported = JSON.parse((await f.backup.export({ parts: ["settings"] })).json!);
  const from = { bundle: JSON.stringify(sealBundle(exported.manifest, [{
    ...exported.manifest.files[0], text: "[tavern]\ncontextual_speech = true\nspeech_thread_limit = 8\nspeech_install_limit = 60",
  }])) };
  const preview = backupContract.backupRestore.output.parse(await f.harness.invokeRpc("backupRestore", { from, apply: false }));
  expect(preview.code).toBe("preview");
  const applied = backupContract.backupRestore.output.parse(await f.harness.invokeRpc("backupRestore", { from, apply: true, previewHash: preview.previewHash }));
  expect(applied.code).toBe("applied");
  expect(f.settings.snapshot().user).toEqual({ tavern: { contextualSpeech: true } });
});
it("refuses incoming speech launch options and preserves local options absent in a backup", async () => {
  const source = setup(), target = setup();
  const local = { speechExtensions: ["/fixture/local.ts"], speechInstructions: "Keep it quiet.", speechRecentMessages: 0 };
  target.settings.update({ revision: 0, patch: { tavern: local }, why: "Direct settings" });
  const plain = { bundle: (await source.backup.export({ parts: ["settings"] })).json! };
  source.settings.update({ revision: 0, patch: { tavern: { speechExtensions: ["/fixture/imported.ts"], speechInstructions: "Incoming.", speechRecentMessages: 10 } }, why: "Direct settings" });
  const unsafe = { bundle: (await source.backup.export({ parts: ["settings"] })).json! };
  const blocked = backupContract.backupRestore.output.parse(await target.harness.invokeRpc("backupRestore", { from: unsafe, apply: false }));
  expect(blocked.code).toBe("invalid");
  expect(blocked.problems.join(" ")).toMatch(/speech_extensions.*speech_instructions.*speech_recent_messages/);
  const preview = backupContract.backupRestore.output.parse(await target.harness.invokeRpc("backupRestore", { from: plain, apply: false }));
  const applied = backupContract.backupRestore.output.parse(await target.harness.invokeRpc("backupRestore", { from: plain, apply: true, previewHash: preview.previewHash }));
  expect(applied.code).toBe("applied");
  expect(target.settings.read().tavern).toMatchObject(local);
});
it("returns stale-safe restore previews through the registered RPC shape", async () => {
  const source = setup(); override(source);
  const exported = await source.backup.export({}), target = setup(), from = { bundle: exported.json! };
  const preview = backupContract.backupRestore.output.parse(await target.harness.invokeRpc("backupRestore", { from, apply: false }));
  expect(preview.code).toBe("preview");
  target.settings.update({ revision: 0, patch: { data: { backupKeep: 5 } }, why: "Changed after preview" });
  expect(backupContract.backupRestore.output.parse(await target.harness.invokeRpc("backupRestore", { from, apply: true, previewHash: preview.previewHash })).code).toBe("stale");
});
