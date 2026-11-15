import Database from "better-sqlite3";
import { afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS } from "../../src/server/migrations";
import { Registry } from "../../src/server/registry";
import { SettingsStore } from "../../src/server/settings/store";
import { BackupService } from "../../src/server/backup/service";

export const builtin = fileURLToPath(new URL("../../", import.meta.url));
const resources: { root: string; db: Database.Database }[] = [];
afterEach(() => { for (const { root, db } of resources.splice(0)) { db.close(); rmSync(root, { recursive: true, force: true }); } });
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-backup-"));
  const home = join(root, "global"), project = join(root, "project"); mkdirSync(home); mkdirSync(project);
  const db = new Database(":memory:"); resources.push({ root, db });
  for (const sql of MIGRATIONS) db.exec(sql);
  const changed = vi.fn(), invalidated = vi.fn(), warning = vi.fn(), settings = new SettingsStore(db, () => 1000, changed, warning), registry = new Registry(builtin, home);
  const backup = new BackupService({ settings, registry, version: "test", now: () => 1000, projects: async () => [{ id: "project", name: "A local project", path: project }], changed: invalidated, warn: warning });
  return { root, home, project, db, changed, invalidated, warning, settings, registry, backup };
}
export function override(f: ReturnType<typeof fixture>, project = false) {
  const raw = readFileSync(join(builtin, "classes/smith.md"), "utf8").replace(/label: [^\n]+/, "label: My smith");
  const file = join(project ? join(f.project, ".agents/tavern") : f.home, "classes/custom-name.md");
  mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, raw); return { file, raw };
}
