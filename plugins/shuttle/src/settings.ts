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
  archiveReviewThreads: {
    type: "boolean",
    label: "Archive finished review threads",
    description:
      "Archive a review thread Shuttle started, with its child threads, once its review is done: its draft posted or discarded, you reviewed the PR, or the PR merged or closed. The next review of the PR brings the thread back, without its child threads. Threads you picked yourself are never archived.",
    default: true,
  },
  defaultProject: {
    type: "project",
    label: "Project for review threads",
    description: "Used when no project's git remote matches the PR's repository. Without one, Shuttle asks.",
  },
  autoAgent: {
    type: "boolean",
    label: "Auto agent",
    description:
      "When one of your PRs has no agent, make the bb thread that opened it the agent: the thread whose id is in the branch name, or whose branch the PR is from. Off by default, so threads that follow their own PRs (such as Loom's) are left alone.",
    default: false,
  },
  inboxRequests: {
    type: "boolean",
    label: "New review requests in the Inbox",
    description: "PRs that ask for your review by name, or mention you, come to the Inbox for their first days. Off, they wait in Reviews.",
    default: true,
  },
  inboxRequestDays: {
    type: "number",
    label: "Days a new request stays in the Inbox",
    description: "After this, a request you have not reviewed waits in Reviews › Asked me.",
    default: 3,
    experimental_schema: z.number().int().min(1).max(30),
  },
  botAuthors: {
    type: "string",
    label: "Bot authors",
    description: "Authors Reviews hides with Hide bots, as globs separated by commas, on top of the accounts a server marks as bots.",
    default: "dependabot*, renovate*, *[bot], *-actuator, *.gserviceaccount.com",
    experimental_schema: z.string().trim().max(1000),
  },
} satisfies PluginSettingDescriptors;

export interface Settings {
  pauseAutomations: boolean;
  syncMinutes: number;
  doneDays: number;
  defaultProject: string;
  reviewSection: string;
  archiveReviewThreads: boolean;
  autoAgent: boolean;
  inboxRequests: boolean;
  inboxRequestDays: number;
  botAuthors: string[];
}

export const DEFAULT_BOT_AUTHORS = "dependabot*, renovate*, *[bot], *-actuator, *.gserviceaccount.com";
const globs = (text: string) => text.split(",").map((g) => g.trim()).filter(Boolean);

export const DEFAULT_SETTINGS: Settings = {
  pauseAutomations: false,
  syncMinutes: 3,
  doneDays: 14,
  defaultProject: "",
  reviewSection: "",
  archiveReviewThreads: true,
  autoAgent: false,
  inboxRequests: true,
  inboxRequestDays: 3,
  botAuthors: globs(DEFAULT_BOT_AUTHORS),
};

export function toSettings(values: Record<string, unknown>): Settings {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return {
    pauseAutomations: values.pauseAutomations === true,
    syncMinutes: num(values.syncMinutes, DEFAULT_SETTINGS.syncMinutes),
    doneDays: num(values.doneDays, DEFAULT_SETTINGS.doneDays),
    defaultProject: typeof values.defaultProject === "string" ? values.defaultProject : "",
    reviewSection: typeof values.reviewSection === "string" ? values.reviewSection.trim() : "",
    archiveReviewThreads: values.archiveReviewThreads !== false,
    autoAgent: values.autoAgent === true,
    inboxRequests: values.inboxRequests !== false,
    inboxRequestDays: num(values.inboxRequestDays, DEFAULT_SETTINGS.inboxRequestDays),
    botAuthors: globs(typeof values.botAuthors === "string" ? values.botAuthors : DEFAULT_BOT_AUTHORS),
  };
}
