import type { PluginSettingDescriptors, StandardSchemaV1 } from "@get-bb/plugin-sdk";

/** The realtime channel the server publishes on when a setting changes. */
export const SETTINGS_CHANNEL = "settings";

export type TimeFormat = "24h" | "12h";

export interface SessionLogSettings {
  outputHeadLines: number;
  outputTailLines: number;
  thinkingLines: number;
  expandFailures: boolean;
  showMessages: boolean;
  showThinking: boolean;
  showTools: boolean;
  timeFormat: TimeFormat;
  tintRows: boolean;
}

export const DEFAULT_SETTINGS: SessionLogSettings = {
  outputHeadLines: 4,
  outputTailLines: 4,
  thinkingLines: 3,
  expandFailures: true,
  showMessages: true,
  showThinking: true,
  showTools: true,
  timeFormat: "24h",
  tintRows: true,
};

const OUTPUT_LINES_MAX = 50;
const THINKING_LINES_MAX = 20;
const TIME_FORMATS: readonly TimeFormat[] = ["24h", "12h"];

const isWholeNumber = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

function wholeNumber(max: number): StandardSchemaV1<number, number> {
  return {
    "~standard": {
      version: 1,
      vendor: "session-log",
      validate: (value) => isWholeNumber(value, max)
        ? { value }
        : { issues: [{ message: `Enter a whole number from 0 to ${max}.` }] },
    },
  };
}

export const SETTING_DESCRIPTORS = {
  outputHeadLines: {
    type: "number",
    label: "Output lines from the start",
    description: "Lines of command and tool output shown from the start of a collapsed row.",
    default: DEFAULT_SETTINGS.outputHeadLines,
    experimental_schema: wholeNumber(OUTPUT_LINES_MAX),
  },
  outputTailLines: {
    type: "number",
    label: "Output lines from the end",
    description: "Lines of command and tool output shown from the end of a collapsed row.",
    default: DEFAULT_SETTINGS.outputTailLines,
    experimental_schema: wholeNumber(OUTPUT_LINES_MAX),
  },
  thinkingLines: {
    type: "number",
    label: "Thinking preview lines",
    description: "Lines shown for a collapsed thought. 0 shows only its title.",
    default: DEFAULT_SETTINGS.thinkingLines,
    experimental_schema: wholeNumber(THINKING_LINES_MAX),
  },
  expandFailures: {
    type: "boolean",
    label: "Open failed commands and tools",
    description: "Show the full output of failed commands and tools without expanding them first.",
    default: DEFAULT_SETTINGS.expandFailures,
  },
  showMessages: {
    type: "boolean",
    label: "Show messages when the log opens",
    default: DEFAULT_SETTINGS.showMessages,
  },
  showThinking: {
    type: "boolean",
    label: "Show thinking when the log opens",
    default: DEFAULT_SETTINGS.showThinking,
  },
  showTools: {
    type: "boolean",
    label: "Show tools when the log opens",
    default: DEFAULT_SETTINGS.showTools,
  },
  timeFormat: {
    type: "select",
    label: "Time format",
    options: [...TIME_FORMATS],
    experimental_optionLabels: { "24h": "24-hour (14:02:31)", "12h": "12-hour (2:02:31 PM)" },
    default: DEFAULT_SETTINGS.timeFormat,
  },
  tintRows: {
    type: "boolean",
    label: "Tint rows by type",
    description: "Give agent replies, tool calls, commands, file changes and failures a faint background and a left rail in your theme's colors.",
    default: DEFAULT_SETTINGS.tintRows,
  },
} satisfies PluginSettingDescriptors;

/** Reads stored setting values, keeping the default for any value that is missing or invalid. */
export function parseSettings(values: Readonly<Record<string, unknown>> | undefined): SessionLogSettings {
  const read = values ?? {};
  const lines = (key: "outputHeadLines" | "outputTailLines" | "thinkingLines", max: number) => {
    const value = read[key];
    return isWholeNumber(value, max) ? value : DEFAULT_SETTINGS[key];
  };
  const flag = (key: "expandFailures" | "showMessages" | "showThinking" | "showTools" | "tintRows") => {
    const value = read[key];
    return typeof value === "boolean" ? value : DEFAULT_SETTINGS[key];
  };
  const timeFormat = TIME_FORMATS.find((format) => format === read.timeFormat) ?? DEFAULT_SETTINGS.timeFormat;
  return {
    outputHeadLines: lines("outputHeadLines", OUTPUT_LINES_MAX),
    outputTailLines: lines("outputTailLines", OUTPUT_LINES_MAX),
    thinkingLines: lines("thinkingLines", THINKING_LINES_MAX),
    expandFailures: flag("expandFailures"),
    showMessages: flag("showMessages"),
    showThinking: flag("showThinking"),
    showTools: flag("showTools"),
    timeFormat,
    tintRows: flag("tintRows"),
  };
}
