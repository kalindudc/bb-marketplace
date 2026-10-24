import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { createCommands, PANEL_ACTION_ID } from "./src/commands";
import { AttentionToasts, useVantageBadge } from "./src/notify";
import { AGENT_TAB_ID, AgentTab, PAGE_PANEL_ID, PAGE_PATH, VantageHeader, VantagePage, VantageSidebar, usePageTitle } from "./src/page";
import { VantagePanel } from "./src/panel";
import {
  SegmentDetails, SegmentSummary, VantageHeaderButton, VantageInfoSection, openAction, useSegmentVisible,
} from "./src/thread-surfaces";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PAGE_PANEL_ID, title: "Vantage", icon: "FolderGit", path: PAGE_PATH, component: VantagePage,
    experimental_sidebar: VantageSidebar, headerContent: VantageHeader,
    experimental_usePageTitle: usePageTitle, experimental_useBadge: useVantageBadge,
  });
  app.slots.experimental_tab({
    context: { kind: "nav-panel", panelId: PAGE_PANEL_ID }, availability: "fixed",
    id: AGENT_TAB_ID, title: "Agent", icon: "Bot", tooltip: "The selected worktree's agent", layout: "flush", component: AgentTab,
  });
  // The id is the one the retired thread panel action had, so a Vantage tab someone left open keeps working.
  app.slots.experimental_tab({
    context: { kind: "thread" }, availability: "action",
    id: PANEL_ACTION_ID, title: "Vantage", icon: "FolderGit", layout: "flush", component: VantagePanel,
  });
  app.slots.experimental_threadHeaderAction({ id: "open", title: "Vantage", component: VantageHeaderButton });
  app.slots.experimental_threadContextSegment({
    id: "worktrees", title: "Worktrees", group: "3_git", order: 90,
    summary: SegmentSummary, details: SegmentDetails, useVisible: useSegmentVisible,
  });
  app.slots.experimental_threadInfoSection({ id: "worktrees", group: "2_changes", order: 90, component: VantageInfoSection });
  app.slots.experimental_threadAction(openAction);
  app.slots.experimental_appOverlay({ id: "attention", component: AttentionToasts });
  for (const command of createCommands()) app.commands.register(command);
});
