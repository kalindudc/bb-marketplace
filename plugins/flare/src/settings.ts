import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const NOTIFY_MODES = ["blockers", "all", "off"] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];
export const FORWARD_MODES = ["blockers", "all", "off"] as const;
export type ForwardMode = (typeof FORWARD_MODES)[number];

export const SETTING_DESCRIPTORS = {
  notify: {
    type: "select",
    label: "Push notifications",
    description:
      "Which flares bb's push notifications plugin sends to your devices. Blockers also covers flares the agent marked urgent. A thread you muted in push notifications is never notified.",
    options: [...NOTIFY_MODES],
    experimental_optionLabels: { blockers: "Blockers and urgent flares", all: "Every flare", off: "None" },
    default: "blockers",
  },
  notifyOnFailure: {
    type: "boolean",
    label: "Notify with the last flare when a turn fails",
    description: "When a turn that sent flares fails, push a notification that names its last flare, so you know where the agent got to.",
    default: false,
  },
  forwardToParent: {
    type: "select",
    label: "Tell the parent agent",
    description:
      "Which flares from a child thread are also sent to its parent's agent, as a note it reads while it works. They are sent only while the parent's turn runs; they never start a turn. The parent's banner and Flares tab show every child flare either way.",
    options: [...FORWARD_MODES],
    experimental_optionLabels: { blockers: "Blockers and urgent flares", all: "Every flare", off: "None" },
    default: "blockers",
  },
  nudgeMinutes: {
    type: "number",
    label: "Remind a quiet agent after (minutes)",
    description:
      "When a turn has run this long without a flare, add a short reminder to it so the agent sends one if it has something to report. At most three reminders a turn; they never start a turn. 0 turns reminders off.",
    experimental_schema: z.number().int().min(0).max(240),
    default: 0,
  },
  nudgeChildThreads: {
    type: "boolean",
    label: "Remind child threads too",
    description: "Also remind threads another thread started, such as minions and delegates. Off keeps reminders to threads you started.",
    default: false,
  },
  tab: {
    type: "select",
    label: "Flares tab shows",
    description:
      "Rendered shows each flare as bb shows a reply, so any block an installed plugin draws (a chart, a page, a diagram) appears. It keeps a hidden companion thread per thread on Flare's renderer, which runs no model and costs nothing. Cards shows Flare's own Markdown cards and starts no companion.",
    options: ["rendered", "cards"],
    experimental_optionLabels: { rendered: "Rendered, like a reply", cards: "Plain cards" },
    default: "rendered",
  },
  keepDays: {
    type: "number",
    label: "Keep flares for (days)",
    description: "Flares older than this are deleted once a day.",
    experimental_schema: z.number().int().min(1).max(3650),
    default: 30,
  },
} satisfies PluginSettingDescriptors;

export interface FlareSettings {
  notify: NotifyMode;
  notifyOnFailure: boolean;
  forwardToParent: ForwardMode;
  nudgeMinutes: number;
  nudgeChildThreads: boolean;
  tab: "rendered" | "cards";
  keepDays: number;
}

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  (values as readonly unknown[]).includes(value) ? (value as T) : fallback;

/** Settings as typed values; a value bb could not validate falls back to its default. */
export function readSettings(values: Record<string, unknown>): FlareSettings {
  const number = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  return {
    notify: oneOf(NOTIFY_MODES, values.notify, "blockers"),
    notifyOnFailure: values.notifyOnFailure === true,
    forwardToParent: oneOf(FORWARD_MODES, values.forwardToParent, "blockers"),
    nudgeMinutes: Math.max(0, Math.floor(number(values.nudgeMinutes, 0))),
    nudgeChildThreads: values.nudgeChildThreads === true,
    tab: values.tab === "cards" ? "cards" : "rendered",
    keepDays: Math.max(1, Math.floor(number(values.keepDays, 30))),
  };
}
