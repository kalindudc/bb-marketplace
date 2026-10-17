import {
  definePluginApp, experimental_Icon as Icon, useBbNavigate,
  type PluginThreadHeaderActionProps, type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { createCommands, LOG_ACTION_ID, requestPanelFocus } from "./src/commands";
import { SessionLogPanel } from "./src/panel";
import { createPreference } from "./src/preference";

// Declared in package.json (bb.branding.experimental_icons) as ./icons/logs.svg.
const LOG_ICON = "session-log/logs";
const preference = createPreference(window);

function SessionLogButton({ threadId }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return (
    <button type="button" aria-label="Open session log" title="Open session log"
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => {
        if (navigate.openThreadPanel({ actionId: LOG_ACTION_ID })) requestPanelFocus(threadId);
      }}>
      <Icon name={LOG_ICON} className="size-4" aria-hidden />
    </button>
  );
}

function SessionLogTab(props: PluginThreadPanelProps) {
  return <SessionLogPanel {...props} preference={preference} />;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: LOG_ACTION_ID,
    title: "Session log",
    icon: LOG_ICON,
    layout: "flush",
    component: SessionLogTab,
  });
  app.slots.experimental_threadHeaderAction({
    id: "open-log",
    title: "Session log",
    component: SessionLogButton,
  });
  for (const command of createCommands(preference)) app.commands.register(command);
});
