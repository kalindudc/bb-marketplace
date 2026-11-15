// @vitest-environment node
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS } from "../../src/server/migrations";
import { Registry } from "../../src/server/registry";
import { SettingsStore } from "../../src/server/settings/store";
import { createBackupService } from "../../src/server/backup/index";
import { createFakePluginHost } from "../server/host";

const builtin = fileURLToPath(new URL("../../", import.meta.url)), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "tavern-backup-factory-")); roots.push(root);
  const home = join(root, "global"), project = join(root, "project"); mkdirSync(home); mkdirSync(join(project, ".agents/tavern/classes"), { recursive: true });
  const sdk = { system: { config: vi.fn(async () => ({ primaryHostId: "server" as string | null })) }, projects: { list: vi.fn(async () => [{ id: "local" }, { id: "remote" }]), get: vi.fn(async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId, sources: projectId === "local" ? [{ hostId: "remote", path: "/must-not-be-read", isDefault: true }, { hostId: "server", path: project, isDefault: false }] : [{ hostId: "remote", path: "/must-not-be-read", isDefault: true }] })) } };
  const host = createFakePluginHost({ pluginId: "tavern", sdk });
  const db = new Database(":memory:"); for (const sql of MIGRATIONS) db.exec(sql);
  const settings = new SettingsStore(db), backup = createBackupService(host.bb, settings, new Registry(builtin, home));
  return { root, home, project, sdk, host, backup };
}
it("does not fetch project metadata for an ordinary global backup", async () => {
  const f = setup(); expect((await f.backup.export({})).code).toBe("ok");
  expect(f.sdk.system.config).not.toHaveBeenCalled(); expect(f.sdk.projects.list).not.toHaveBeenCalled();
});
it("uses only registered server-local roots and records remote omissions", async () => {
  const f = setup(), raw = readFileSync(join(builtin, "classes/smith.md"), "utf8");
  writeFileSync(join(f.project, ".agents/tavern/classes/local-name.md"), raw);
  const result = await f.backup.export({ projects: true }), bundle = JSON.parse(result.json!);
  expect(f.sdk.projects.list).toHaveBeenCalledWith({ includePersonal: true });
  expect(bundle.manifest.projects).toEqual([{ id: "local", name: "local", path: f.project }]);
  expect(bundle.files["projects/local/classes/local-name.md"]).toBe(raw);
  expect(bundle.manifest.problems.join(" ")).toContain("remote: no server-local checkout");
  expect(f.host.harness.inspection.sdk.callsTo("projects.list")).toHaveLength(1);
});
it("fails closed without a registered server host", async () => {
  const f = setup(); f.sdk.system.config.mockResolvedValue({ primaryHostId: null });
  await expect(f.backup.export({ projects: true })).rejects.toThrow("registered server host");
  expect(f.sdk.projects.list).not.toHaveBeenCalled();
});
it("refuses relative paths even when a project lists them for the server host", async () => {
  const f = setup(); f.sdk.projects.get.mockImplementation(async ({ projectId }) => ({ id: projectId, name: projectId, sources: [{ hostId: "server", path: "relative", isDefault: true }] }));
  await expect(f.backup.export({ projects: true })).rejects.toThrow("absolute server-local");
});
