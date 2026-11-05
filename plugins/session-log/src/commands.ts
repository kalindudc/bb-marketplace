import { toast } from "sonner";
import type {
  ExperimentalTabReference, PluginCommandRegistration, PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";
import type { ExpandedPreference } from "./preference";

export const LOG_ACTION_ID = "log";
// Declared in package.json (bb.branding.experimental_icons) as ./icons/logs.svg.
export const LOG_ICON = "session-log/logs";
export const LOG_TAB: ExperimentalTabReference & { availability: "action" } = {
  id: LOG_ACTION_ID, context: { kind: "thread" }, availability: "action",
};

let focusThreadId: string | null = null;
const focusListeners = new Set<() => void>();

export function requestPanelFocus(threadId: string): void {
  focusThreadId = threadId;
  for (const listener of [...focusListeners]) listener();
}

export function consumePanelFocus(threadId: string): boolean {
  if (focusThreadId !== threadId) return false;
  focusThreadId = null;
  return true;
}

export function onPanelFocusRequest(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => { focusListeners.delete(listener); };
}

/** The thread header's labelled Session log button, for a bb that no longer draws plugin icon buttons there. */
export const headerAction: PluginThreadActionRegistration = {
  id: "open-log",
  title: "Session log",
  icon: LOG_ICON,
  group: "1_open",
  placement: "header",
  item: ({ thread, experimental_panel }) => ({
    label: "Session log",
    icon: LOG_ICON,
    run: () => {
      if (experimental_panel.openTab({ tab: LOG_TAB })) requestPanelFocus(thread.id);
    },
  }),
};

export function createCommands(preference: Pick<ExpandedPreference, "toggle">): PluginCommandRegistration[] {
  return [
    {
      id: "open",
      title: "Session Log: Open for this thread",
      defaultShortcut: { key: "l", mod: true, shift: true },
      isAvailable: ({ threadId }) => threadId !== null,
      run({ threadId, experimental_panel }) {
        if (threadId !== null && experimental_panel.openTab({ tab: LOG_TAB })) requestPanelFocus(threadId);
      },
    },
    {
      id: "toggle-expanded",
      title: "Session Log: Toggle expanded view",
      run() {
        toast(preference.toggle() ? "Session log: everything expanded" : "Session log: previews");
      },
    },
  ];
}
