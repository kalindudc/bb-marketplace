import { toast } from "sonner";
import type { PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import type { ExpandedPreference } from "./preference";

export const LOG_ACTION_ID = "log";

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

export function createCommands(preference: Pick<ExpandedPreference, "toggle">): PluginCommandRegistration[] {
  return [
    {
      id: "open",
      title: "Session Log: Open for this thread",
      defaultShortcut: { key: "l", mod: true, shift: true },
      isAvailable: ({ threadId }) => threadId !== null,
      run({ threadId, openPanel }) {
        if (threadId !== null && openPanel({ actionId: LOG_ACTION_ID })) requestPanelFocus(threadId);
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
