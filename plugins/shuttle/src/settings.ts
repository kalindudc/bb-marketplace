// The flat settings bb draws on Shuttle's settings page. Servers, presets and automations are
// Shuttle's own settings sections (config.ts).
import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const SETTINGS = {
  pauseAutomations: {
    type: "boolean",
    label: "Pause automations",
    description: "Stops auto reviews and the messages to watched PRs' threads. Lists keep syncing, and buttons still work.",
    default: false,
  },
  syncMinutes: {
    type: "number",
    label: "Sync every (minutes)",
    description: "Minutes between syncs of each server, and between checks of watched PRs for new reviews.",
    default: 3,
    experimental_schema: z.number().int().min(1).max(120),
  },
  doneDays: {
    type: "number",
    label: "Done covers (days)",
    description: "How far back the Done list of your merged and closed PRs goes.",
    default: 14,
    experimental_schema: z.number().int().min(1).max(90),
  },
  reviewSection: {
    type: "string",
    label: "Section for review threads",
    description: "The sidebar section review threads go to, by name; Shuttle creates it when it does not exist. Empty leaves review threads outside any section.",
    default: "",
    experimental_schema: z.string().trim().max(80),
  },
  defaultProject: {
    type: "project",
    label: "Project for review threads",
    description: "Used when no project's git remote matches the PR's repository. Without one, Shuttle asks.",
  },
} satisfies PluginSettingDescriptors;

export interface Settings {
  pauseAutomations: boolean;
  syncMinutes: number;
  doneDays: number;
  defaultProject: string;
  reviewSection: string;
}

export const DEFAULT_SETTINGS: Settings = { pauseAutomations: false, syncMinutes: 3, doneDays: 14, defaultProject: "", reviewSection: "" };

export function toSettings(values: Record<string, unknown>): Settings {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return {
    pauseAutomations: values.pauseAutomations === true,
    syncMinutes: num(values.syncMinutes, DEFAULT_SETTINGS.syncMinutes),
    doneDays: num(values.doneDays, DEFAULT_SETTINGS.doneDays),
    defaultProject: typeof values.defaultProject === "string" ? values.defaultProject : "",
    reviewSection: typeof values.reviewSection === "string" ? values.reviewSection.trim() : "",
  };
}
