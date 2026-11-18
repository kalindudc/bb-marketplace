import { parse, stringify } from "smol-toml";
import type { SettingsSnapshot } from "../../shared/settings";
import { exportToml } from "./toml";
export const FORGE_SETTINGS_PAGE_ONLY = "Forge profiles run commands on this machine, so they change only on Tavern's Settings page, Where work runs.";
export function withoutForgeCommands(source: string, snapshot: SettingsSnapshot): { toml: string; skipped: string[]; kept: string[] } {
  const saved = parse(exportToml(snapshot));
  const current = saved.machines as Record<string, unknown> | undefined;
  const profiles = (value: unknown): string[] => Array.isArray(value) ? value.map(profile => typeof profile === "object" && profile !== null && "id" in profile ? String(profile.id) : "unnamed") : [];
  const kept = [...new Set(profiles(current?.forges))];
  let incoming: typeof saved;
  try { incoming = parse(source); }
  catch {
    // Leave syntax errors to previewToml so it can report their original line.
    return { toml: source, skipped: [], kept };
  }
  const machines = incoming.machines as Record<string, unknown> | undefined;
  const skipped = [...new Set(profiles(machines?.forges))];
  if (machines && typeof machines === "object" && !Array.isArray(machines)) delete machines.forges;
  if (current?.forges !== undefined) {
    if (!incoming.machines) incoming.machines = {};
    (incoming.machines as Record<string, unknown>).forges = current.forges;
  }
  return { toml: stringify(incoming), skipped, kept };
}
