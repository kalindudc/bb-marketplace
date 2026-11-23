import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseSummaryModel } from "../composer/src/model-spec.ts";
import { clampSoftPercent, type LayerErrorReporter, type PressSettings } from "./policy";

/** The defaults every install starts from; the settings page and policy defaults both read these. */
export const DEFAULT_SETTINGS: PressSettings = {
  mode: "auto",
  softPercent: 55,
  hardPercent: 80,
  floorTokens: 150_000,
  phasePoint: true,
  agentPoint: true,
  volumePoint: true,
  turnsPoint: false,
  idlePoint: false,
  thrashPoint: false,
  volumeBytes: 1_500_000,
  turnsBetween: 60,
  idleSeconds: 300,
  cooldownSeconds: 600,
  minTurnsBetween: 2,
  composerModel: "",
  maxSummaryTokens: 3000,
  autoInstallComposer: true,
};

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
    default: DEFAULT_SETTINGS.mode,
  },
  softPercent: {
    type: "number",
    label: "Points can fire from (percent of window)",
    description: "Compaction points without their own minimum only count at or above this percentage.",
    experimental_schema: z.number().int().min(5).max(95),
    default: DEFAULT_SETTINGS.softPercent,
  },
  hardPercent: {
    type: "number",
    label: "Force at (percent of window)",
    description: "The backstop: waits for an idle thread and for cooldown, but skips the other vetoes.",
    experimental_schema: z.number().int().min(10).max(99),
    default: DEFAULT_SETTINGS.hardPercent,
  },
  floorTokens: {
    type: "number",
    label: "Never compact below (tokens)",
    experimental_schema: z.number().int().min(0),
    default: DEFAULT_SETTINGS.floorTokens,
  },
  phasePoint: {
    type: "boolean",
    label: "Compact at phase boundaries (plan approved, tests green, PR opened)",
    default: DEFAULT_SETTINGS.phasePoint,
  },
  agentPoint: {
    type: "boolean",
    label: "Compact when an agent marks a point",
    description: "The compaction_point tool or bb press point",
    default: DEFAULT_SETTINGS.agentPoint,
  },
  volumePoint: {
    type: "boolean",
    label: "Compact on a large tool result",
    default: DEFAULT_SETTINGS.volumePoint,
  },
  volumeBytes: {
    type: "number",
    label: "A large tool result (bytes)",
    experimental_schema: z.number().int().min(0),
    default: DEFAULT_SETTINGS.volumeBytes,
  },
  turnsPoint: {
    type: "boolean",
    label: "Compact after many turns",
    default: DEFAULT_SETTINGS.turnsPoint,
  },
  turnsBetween: {
    type: "number",
    label: "Turns between compactions",
    experimental_schema: z.number().int().min(1),
    default: DEFAULT_SETTINGS.turnsBetween,
  },
  idlePoint: {
    type: "boolean",
    label: "Compact after idle time",
    default: DEFAULT_SETTINGS.idlePoint,
  },
  idleSeconds: {
    type: "number",
    label: "Idle time (seconds)",
    experimental_schema: z.number().int().min(0),
    default: DEFAULT_SETTINGS.idleSeconds,
  },
  thrashPoint: {
    type: "boolean",
    label: "Compact on thrash (the same file re-read, the same command failing)",
    default: DEFAULT_SETTINGS.thrashPoint,
  },
  cooldownSeconds: {
    type: "number",
    label: "Cooldown after a compaction attempt (seconds)",
    experimental_schema: z.number().int().min(0),
    default: DEFAULT_SETTINGS.cooldownSeconds,
  },
  minTurnsBetween: {
    type: "number",
    label: "Minimum turns between compactions",
    experimental_schema: z.number().int().min(0),
    default: DEFAULT_SETTINGS.minTurnsBetween,
  },
  composerModel: {
    type: "string",
    label: "Model that writes the summary",
    description: "provider/modelId; empty means the thread's own model",
    experimental_schema: z.string().refine((model) => model === "" || parseSummaryModel(model) !== null, { message: "Expected provider/modelId" }),
    default: DEFAULT_SETTINGS.composerModel,
  },
  maxSummaryTokens: {
    type: "number",
    label: "Summary budget (tokens)",
    experimental_schema: z.number().int().min(0),
    default: DEFAULT_SETTINGS.maxSummaryTokens,
  },
  autoInstallComposer: {
    type: "boolean",
    label: "Install the composer into pi automatically",
    description: "Keeps ~/.pi/agent/extensions/press-composer up to date with this plugin's composer",
    default: DEFAULT_SETTINGS.autoInstallComposer,
  },
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
export function normalizeSettings(values: Record<string, unknown>, onWindowClamp?: LayerErrorReporter): PressSettings {
  const hardPercent = intInRange(values.hardPercent, DEFAULT_SETTINGS.hardPercent, 10, 99);
  const softPercent = intInRange(values.softPercent, DEFAULT_SETTINGS.softPercent, 5, 95);
  return {
    mode: values.mode === "observe" || values.mode === "advisor" || values.mode === "auto" ? values.mode : DEFAULT_SETTINGS.mode,
    softPercent: clampSoftPercent(softPercent, hardPercent, "settings", onWindowClamp),
    hardPercent,
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
    composerModel: typeof values.composerModel === "string" && parseSummaryModel(values.composerModel) !== null ? values.composerModel : "",
    maxSummaryTokens: intInRange(values.maxSummaryTokens, DEFAULT_SETTINGS.maxSummaryTokens, 0, Number.MAX_SAFE_INTEGER),
    autoInstallComposer: boolOr(values.autoInstallComposer, DEFAULT_SETTINGS.autoInstallComposer),
  };
}
