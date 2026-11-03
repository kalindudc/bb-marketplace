import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { createCommands, PANEL_ACTION_ID } from "./src/commands";
import { AttentionToasts, useVantageBadge } from "./src/notify";
import { AGENT_TAB_ID, AgentTab, PAGE_PANEL_ID, PAGE_PATH, VantageHeader, VantagePage, VantageSidebar, usePageTitle } from "./src/page";
import { VantagePanel } from "./src/panel";
import {
  RowLineItem, SegmentDetails, SegmentSummary, VantageCardSection, VantageInfoSection, openAction, useRowLines, useSegmentVisible,
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
  app.slots.experimental_threadContextSegment({
    id: "worktrees", title: "Worktrees", group: "3_git", order: 90,
    summary: SegmentSummary, details: SegmentDetails, useVisible: useSegmentVisible,
  });
  // Before bb's Child threads section in the thread context card; the segment above hides itself while the card shows.
  app.slots.experimental_threadContextCardSection({ id: "worktrees", title: "Worktrees", group: "1_related", order: 5, component: VantageCardSection });
  app.slots.experimental_threadInfoSection({ id: "worktrees", group: "2_changes", order: 90, component: VantageInfoSection });
  app.slots.experimental_threadRowMetadata({ id: "changes", order: 50, useData: useRowLines, component: RowLineItem });
  app.slots.experimental_threadAction(openAction);
  app.slots.experimental_appOverlay({ id: "attention", component: AttentionToasts });
  for (const command of createCommands()) app.commands.register(command);
});
