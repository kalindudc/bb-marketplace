import {
  definePluginApp, experimental_Icon as Icon, useBbNavigate,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { createCommands, PANEL_ACTION_ID } from "./src/commands";
import { Hint } from "./src/hint";
import { VantagePanel } from "./src/panel";

function VantageButton(_props: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return (
    <Hint label="Vantage: what this thread and its child threads changed, by worktree and repository">
      <button type="button" aria-label="Open Vantage"
        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => { navigate.openThreadPanel({ actionId: PANEL_ACTION_ID }); }}>
        <Icon name="FolderGit" className="size-4" aria-hidden />
      </button>
    </Hint>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Vantage",
    icon: "FolderGit",
    layout: "flush",
    component: VantagePanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "open",
    title: "Vantage",
    component: VantageButton,
  });
  for (const command of createCommands()) app.commands.register(command);
});
