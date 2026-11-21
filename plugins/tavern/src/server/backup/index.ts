import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Registry } from "../registry";
import type { SettingsStore } from "../settings/store";
import { BackupService, type ProjectInventory } from "./service";

export { BackupService } from "./service";
export function createBackupService(bb: BbPluginApi, settings: SettingsStore, registry: Registry, beforeRecordsRestore?: () => void) {
  const { version } = z.object({ version: z.string().min(1) }).parse(JSON.parse(readFileSync(join(registry.directories().builtin, "package.json"), "utf8")));
  return new BackupService({ settings, registry, version, beforeRecordsRestore,
    changed: () => bb.rpc.experimental_invalidate(["tavern:backups", "tavern:registry", "tavern:settings", "tavern:insights", "tavern:board"]),
    warn: message => bb.log.warn(message),
    projects: async (): Promise<ProjectInventory> => {
      const config = await bb.sdk.system.config();
      if (!config.primaryHostId) throw new Error("Project backups require bb's registered server host; no project paths were read.");
      const inventory: ProjectInventory = { projects: [], problems: [] };
      for (const summary of await bb.sdk.projects.list({ includePersonal: true })) {
        const project = await bb.sdk.projects.get({ projectId: summary.id });
        const local = project.sources.filter(source => source.hostId === config.primaryHostId), source = local.find(source => source.isDefault) ?? local[0];
        if (!source) {
          if (project.sources.length) inventory.problems.push(`${project.name}: no server-local checkout; project override files were not read.`);
          continue;
        }
        if (!isAbsolute(source.path)) throw new Error(`Project ${project.name} has no absolute server-local checkout path.`);
        inventory.projects.push({ id: project.id, name: project.name, path: source.path });
      }
      inventory.projects.sort((a, b) => a.id.localeCompare(b.id));
      return inventory;
    },
  });
}
