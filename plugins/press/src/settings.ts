import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { PressSettings } from "./policy";

/**
 * The settings surface: everything the user can set in the UI, in bb plugin config, or on the
 * plugin's settings page. Each key maps onto one knob of the policy (`applySettings`); anything the
 * UI cannot express stays in `policy.json`. All keys have defaults so `get()` is never optional.
 */
export const pressSettings: Record<string, PluginSettingDescriptor> = {
  mode: {
    type: "select",
    label: "Mode",
    description: "observe records what Press would do, advisor proposes and waits for you, auto compacts on its own",
    options: ["observe", "advisor", "auto"],
    experimental_optionLabels: {
      observe: "Observe — record only",
      advisor: "Advisor — propose and wait",
      auto: "Auto — compact on its own",
    },
    default: "advisor",
  },
  softPercent: {
    type: "number",
    label: "Compact at (percent of window)",
    experimental_schema: z.number().int().min(5).max(95),
    default: 35,
  },
  hardPercent: {
    type: "number",
    label: "Force at (percent of window)",
    description: "The backstop: fires no matter what the vetoes say",
    experimental_schema: z.number().int().min(10).max(99),
    default: 55,
  },
  floorTokens: {
    type: "number",
    label: "Never compact below (tokens)",
    experimental_schema: z.number().int().min(0),
    default: 60_000,
  },
  phasePoint: {
    type: "boolean",
    label: "Compact at phase boundaries (plan approved, tests green, PR opened)",
    default: true,
  },
  agentPoint: {
    type: "boolean",
    label: "Compact when an agent marks a point",
    description: "The compaction_point tool or bb press point",
    default: true,
  },
  volumePoint: {
    type: "boolean",
    label: "Compact on a large tool result",
    default: true,
  },
  volumeBytes: {
    type: "number",
    label: "A large tool result (bytes)",
    experimental_schema: z.number().int().min(0),
    default: 1_500_000,
  },
  turnsPoint: {
    type: "boolean",
    label: "Compact after many turns",
    default: true,
  },
  turnsBetween: {
    type: "number",
    label: "Turns between compactions",
    experimental_schema: z.number().int().min(1),
    default: 60,
  },
  idlePoint: {
    type: "boolean",
    label: "Compact after idle time",
    default: true,
  },
  idleSeconds: {
    type: "number",
    label: "Idle time (seconds)",
    experimental_schema: z.number().int().min(0),
    default: 300,
  },
  thrashPoint: {
    type: "boolean",
    label: "Compact on thrash (the same file re-read, the same command failing)",
    default: true,
  },
  cooldownSeconds: {
    type: "number",
    label: "Cooldown after a compaction (seconds)",
    experimental_schema: z.number().int().min(0),
    default: 600,
  },
  minTurnsBetween: {
    type: "number",
    label: "Minimum turns between compactions",
    experimental_schema: z.number().int().min(0),
    default: 5,
  },
  composerModel: {
    type: "string",
    label: "Model that writes the summary",
    description: "Empty means the thread's own model",
    default: "",
  },
  maxSummaryTokens: {
    type: "number",
    label: "Summary budget (tokens)",
    experimental_schema: z.number().int().min(0),
    default: 3000,
  },
  autoInstallComposer: {
    type: "boolean",
    label: "Install the composer into pi automatically",
    description: "Keeps ~/.pi/agent/extensions/press-composer up to date with this plugin's composer",
    default: true,
  },
};

export const DEFAULT_SETTINGS: PressSettings = {
  mode: "advisor",
  softPercent: 35,
  hardPercent: 55,
  floorTokens: 60_000,
  phasePoint: true,
  agentPoint: true,
  volumePoint: true,
  turnsPoint: true,
  idlePoint: true,
  thrashPoint: true,
  volumeBytes: 1_500_000,
  turnsBetween: 60,
  idleSeconds: 300,
  cooldownSeconds: 600,
  minTurnsBetween: 5,
  composerModel: "",
  maxSummaryTokens: 3000,
  autoInstallComposer: true,
};

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(max, Math.max(min, Math.round(value)));
  return Object.is(clamped, -0) ? 0 : clamped;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Settings as the policy sees them. Values come back typed from `get()`, but a corrupt store or a
 * fake host can hand us anything, so each field falls back to its default and numbers are clamped
 * to their range: bad stored data degrades to the defaults instead of poisoning every evaluation.
 */
export function normalizeSettings(values: Record<string, unknown>): PressSettings {
  return {
    mode: values.mode === "observe" || values.mode === "auto" ? values.mode : "advisor",
    softPercent: intInRange(values.softPercent, DEFAULT_SETTINGS.softPercent, 5, 95),
    hardPercent: intInRange(values.hardPercent, DEFAULT_SETTINGS.hardPercent, 10, 99),
    floorTokens: intInRange(values.floorTokens, DEFAULT_SETTINGS.floorTokens, 0, Number.MAX_SAFE_INTEGER),
    phasePoint: boolOr(values.phasePoint, DEFAULT_SETTINGS.phasePoint),
    agentPoint: boolOr(values.agentPoint, DEFAULT_SETTINGS.agentPoint),
    volumePoint: boolOr(values.volumePoint, DEFAULT_SETTINGS.volumePoint),
    turnsPoint: boolOr(values.turnsPoint, DEFAULT_SETTINGS.turnsPoint),
    idlePoint: boolOr(values.idlePoint, DEFAULT_SETTINGS.idlePoint),
    thrashPoint: boolOr(values.thrashPoint, DEFAULT_SETTINGS.thrashPoint),
    volumeBytes: intInRange(values.volumeBytes, DEFAULT_SETTINGS.volumeBytes, 0, Number.MAX_SAFE_INTEGER),
    turnsBetween: intInRange(values.turnsBetween, DEFAULT_SETTINGS.turnsBetween, 1, Number.MAX_SAFE_INTEGER),
    idleSeconds: intInRange(values.idleSeconds, DEFAULT_SETTINGS.idleSeconds, 0, Number.MAX_SAFE_INTEGER),
    cooldownSeconds: intInRange(values.cooldownSeconds, DEFAULT_SETTINGS.cooldownSeconds, 0, Number.MAX_SAFE_INTEGER),
    minTurnsBetween: intInRange(values.minTurnsBetween, DEFAULT_SETTINGS.minTurnsBetween, 0, Number.MAX_SAFE_INTEGER),
    composerModel: typeof values.composerModel === "string" ? values.composerModel : "",
    maxSummaryTokens: intInRange(values.maxSummaryTokens, DEFAULT_SETTINGS.maxSummaryTokens, 0, Number.MAX_SAFE_INTEGER),
    autoInstallComposer: boolOr(values.autoInstallComposer, DEFAULT_SETTINGS.autoInstallComposer),
  };
}
