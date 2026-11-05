import {
  definePluginApp, experimental_Icon as Icon, experimental_useAppPanel, type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import "./src/session-log.css";
import { LOG_ACTION_ID, LOG_ICON, LOG_TAB, createCommands, headerAction, requestPanelFocus } from "./src/commands";
import { SessionLogPanel } from "./src/panel";
import { createPreference } from "./src/preference";

const preference = createPreference(window);

interface HeaderButtonProps { threadId: string; projectId: string; isCompactViewport: boolean }
// The header slot bb 0.48 still draws for plugins built against older SDKs, which SDK 0.6.104 no longer types.
type HeaderSlots = {
  experimental_threadHeaderAction?(registration: { id: string; title: string; component: (props: HeaderButtonProps) => ReactNode }): void;
};

function SessionLogButton({ threadId, isCompactViewport }: HeaderButtonProps) {
  const panel = experimental_useAppPanel();
  // A phone header has no room to spare, and the panel launcher already lists the log.
  if (isCompactViewport) return null;
  return (
    <button type="button" aria-label="Open session log" title="Open session log"
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => {
        if (panel.openTab({ tab: LOG_TAB })) requestPanelFocus(threadId);
      }}>
      <Icon name={LOG_ICON} className="size-4" aria-hidden />
    </button>
  );
}

function SessionLogTab({ threadId }: ExperimentalThreadActionTabProps) {
  return <SessionLogPanel threadId={threadId} preference={preference} />;
}

export default definePluginApp((app) => {
  // The id is the one the retired thread panel action had, so a log tab someone left open keeps working.
  app.slots.experimental_tab({
    context: { kind: "thread" }, availability: "action",
    id: LOG_ACTION_ID, title: "Session log", icon: LOG_ICON, layout: "flush", component: SessionLogTab,
  });
  const legacy = app.slots as unknown as HeaderSlots;
  if (typeof legacy.experimental_threadHeaderAction === "function") {
    legacy.experimental_threadHeaderAction({ id: "open-log", title: "Session log", component: SessionLogButton });
  } else {
    // A bb without that slot draws a labelled button after the workspace's Open button instead.
    app.slots.experimental_threadAction(headerAction);
  }
  for (const command of createCommands(preference)) app.commands.register(command);
});
