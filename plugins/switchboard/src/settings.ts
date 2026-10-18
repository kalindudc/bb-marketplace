import type { PluginSettingDescriptors, StandardSchemaV1 } from "@get-bb/plugin-sdk";

export const SETTINGS_CHANNEL = "settings";
export const SETTINGS_LOCAL_CHANNEL = "switchboard:settings:local";

export type Density = "compact" | "default" | "two-line";
export type SectionColour = "rail" | "tint" | "swatch";
export type View = "sections" | "status";
export type InfoCardMode = "off" | "glance" | "briefing" | "full";

const isWholeNumber = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

export function wholeNumber(max: number): StandardSchemaV1<number, number> {
  return { "~standard": { version: 1, vendor: "switchboard", validate: (value) =>
    isWholeNumber(value, max) ? { value } : { issues: [{ message: `Expected a whole number from 0 to ${max}` }] },
  } };
}

export interface SwitchboardSettings {
  density: Density;
  sectionColour: SectionColour;
  treeGuides: boolean;
  statusChips: boolean;
  showAge: boolean;
  showBranch: boolean;
  showPullRequests: boolean;
  view: View;
  needsYouShelf: boolean;
  showArchived: boolean;
  staleDays: number;
  snoozeHour: number;
  infoCard: InfoCardMode;
}

export const DEFAULT_SETTINGS: SwitchboardSettings = {
  density: "default",
  sectionColour: "rail",
  treeGuides: true,
  statusChips: true,
  showAge: true,
  showBranch: false,
  showPullRequests: true,
  view: "sections",
  needsYouShelf: false,
  showArchived: false,
  staleDays: 3,
  snoozeHour: 9,
  infoCard: "glance",
};

export const SETTING_DESCRIPTORS = {
  density: {
    type: "select", label: "Thread density",
    description: "Choose compact, comfortable or two-line thread rows.",
    options: ["compact", "default", "two-line"],
    experimental_optionLabels: { compact: "Compact (28 px)", default: "Comfortable (32 px)", "two-line": "Two lines (48 px)" },
    default: DEFAULT_SETTINGS.density,
  },
  sectionColour: {
    type: "select", label: "Section colour",
    description: "Show section colours on a rail, a tinted header, or only the header swatch.",
    options: ["rail", "tint", "swatch"],
    experimental_optionLabels: { rail: "Rail", tint: "Rail and tinted header", swatch: "Swatch only" },
    default: DEFAULT_SETTINGS.sectionColour,
  },
  view: {
    type: "select", label: "Thread view", description: "Group threads by section or by their current status.",
    options: ["sections", "status"],
    experimental_optionLabels: { sections: "Sections", status: "Status lanes" },
    default: DEFAULT_SETTINGS.view,
  },
  needsYouShelf: { type: "boolean", label: "Needs-you shelf", description: "Repeat urgent threads above sections.", default: false },
  showArchived: { type: "boolean", label: "Show archived threads", description: "List archived threads on a shelf at the end of the list.", default: false },
  staleDays: { type: "number", label: "Fade idle threads after (days)", description: "Set to 0 to turn fading off.",
    experimental_schema: wholeNumber(90), default: 3 },
  snoozeHour: { type: "number", label: "Snooze wake hour", description: "Local hour (0–23) on the next day.",
    experimental_schema: wholeNumber(23), default: 9 },
  treeGuides: { type: "boolean", label: "Tree guides", description: "Show connecting lines between parent and child threads.", default: true },
  statusChips: { type: "boolean", label: "Status chips", description: "Show chips for filtering threads by status.", default: true },
  showAge: { type: "boolean", label: "Show age", description: "Show the time since each thread last needed attention.", default: true },
  showBranch: { type: "boolean", label: "Show branch", description: "Show each thread's environment branch name.", default: false },
  showPullRequests: { type: "boolean", label: "Show pull requests", description: "Show pull request numbers on root threads.", default: true },
  infoCard: {
    type: "select", label: "Thread info card",
    description: "Show a card with a thread's details when you hover or tab to its row.",
    options: ["off", "glance", "briefing", "full"],
    experimental_optionLabels: { off: "Off", glance: "At a glance", briefing: "Briefing", full: "Full details" },
    default: DEFAULT_SETTINGS.infoCard,
  },
} satisfies PluginSettingDescriptors;

export function parseSettings(values: Readonly<Record<string, unknown>> | undefined): SwitchboardSettings {
  const read = values ?? {};
  const density = (["compact", "default", "two-line"] as const).find((value) => value === read.density) ?? DEFAULT_SETTINGS.density;
  const sectionColour = (["rail", "tint", "swatch"] as const).find((value) => value === read.sectionColour) ?? DEFAULT_SETTINGS.sectionColour;
  const view = (read.view === "status" || read.view === "sections") ? read.view : DEFAULT_SETTINGS.view;
  const infoCard = (["off", "glance", "briefing", "full"] as const).find((value) => value === read.infoCard) ?? DEFAULT_SETTINGS.infoCard;
  const flag = (key: "treeGuides" | "statusChips" | "showAge" | "showBranch" | "showPullRequests" | "needsYouShelf" | "showArchived") =>
    typeof read[key] === "boolean" ? read[key] as boolean : DEFAULT_SETTINGS[key];
  return {
    density, sectionColour, view, needsYouShelf: flag("needsYouShelf"), showArchived: flag("showArchived"),
    staleDays: isWholeNumber(read.staleDays, 90) ? read.staleDays : DEFAULT_SETTINGS.staleDays,
    snoozeHour: isWholeNumber(read.snoozeHour, 23) ? read.snoozeHour : DEFAULT_SETTINGS.snoozeHour,
    treeGuides: flag("treeGuides"), statusChips: flag("statusChips"),
    showAge: flag("showAge"), showBranch: flag("showBranch"), showPullRequests: flag("showPullRequests"),
    infoCard,
  };
}
