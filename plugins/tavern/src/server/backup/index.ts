import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Registry } from "../registry";
import type { SettingsStore } from "../settings/store";
import { BackupService, type ProjectInventory } from "./service";
import { tags } from "../../shared/contract";

export { BackupService } from "./service";
export function createBackupService(bb: BbPluginApi, settings: SettingsStore, registry: Registry, beforeRecordsRestore?: () => void) {
  const { version } = z.object({ version: z.string().min(1) }).parse(JSON.parse(readFileSync(join(registry.directories().builtin, "package.json"), "utf8")));
  return new BackupService({ settings, registry, version, beforeRecordsRestore,
    changed: kind => bb.rpc.experimental_invalidate(["tavern:backups", "tavern:registry", "tavern:settings", "tavern:insights", "tavern:board",
      ...(kind === "restored" ? [tags.deletedQuestCount()] : [])]),
    warn: message => bb.log.warn(message),
    projects: () => registryProjects(bb),
  });
}

export async function registryProjects(bb: BbPluginApi, onFailure: "stop" | "report" = "stop"): Promise<ProjectInventory> {
  const config = await bb.sdk.system.config();
  if (!config.primaryHostId && onFailure === "stop") throw new Error("Project backups require bb's registered server host; no project paths were read.");
  const inventory: ProjectInventory = { projects: [], problems: [] };
  for (const summary of await bb.sdk.projects.list({ includePersonal: true })) {
    let name = summary.name ?? summary.id;
    try {
      const project = await bb.sdk.projects.get({ projectId: summary.id });
      name = project.name;
      const local = project.sources.filter(source => config.primaryHostId && source.hostId === config.primaryHostId), source = local.find(source => source.isDefault) ?? local[0];
      if (!source) {
        if (onFailure === "report" || project.sources.length) inventory.problems.push(`${name}: no server-local checkout; project override files were not read.`);
        continue;
      }
      if (!isAbsolute(source.path)) throw new Error(`Project ${name} has no absolute server-local checkout path.`);
      inventory.projects.push({ id: project.id, name, path: source.path });
    } catch (error) {
      if (onFailure === "stop") throw error;
      inventory.problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  inventory.projects.sort((a, b) => a.id.localeCompare(b.id));
  return inventory;
}
