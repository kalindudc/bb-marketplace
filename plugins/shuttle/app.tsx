import "./src/ui/links/links.css";
import { definePluginApp, experimental_THREAD_INFO_SECTION_GROUPS as INFO_SECTION_GROUPS } from "@get-bb/plugin-sdk/app";
import { PANEL_ACTION_ID, PANEL_PATH } from "./src/ui/constants";
import { ShuttleHeader } from "./src/ui/header";
import { mountLinks } from "./src/ui/links/dom";
import { LinkOverlay } from "./src/ui/links/overlay";
import { useNeedsBadge, useShuttlePageTitle } from "./src/ui/navigation";
import { ShuttlePage } from "./src/ui/page";
import { ShuttlePanel } from "./src/ui/panel";
import { AutomationsSection } from "./src/ui/settings/automations";
import { PresetsSection } from "./src/ui/settings/presets";
import { ServersSection } from "./src/ui/settings/servers";
import { TransferSection } from "./src/ui/settings/transfer";
import { ShuttleSidebar } from "./src/ui/sidebar";
import { tabParams } from "./src/ui/tab";
import { PullRequestsAction, PullRequestsDetails, PullRequestsInfo, PullRequestsSummary, useHasThreadPrs } from "./src/ui/thread-prs";

export default definePluginApp((app) => {
  // Git links in thread messages: the page script marks them, the overlay draws their cards.
  app.contentScripts.register({ id: "git-links", mount: ({ signal }) => mountLinks(signal) });
  app.slots.experimental_appOverlay({ id: "link-cards", component: LinkOverlay });
  app.slots.navPanel({
    id: "shuttle",
    title: "Shuttle",
    icon: "shuttle/shuttle",
    path: PANEL_PATH,
    component: ShuttlePage,
    headerContent: ShuttleHeader,
    experimental_sidebar: ShuttleSidebar,
    experimental_useBadge: useNeedsBadge,
    experimental_usePageTitle: useShuttlePageTitle,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: PANEL_ACTION_ID,
    title: "Shuttle",
    icon: "shuttle/shuttle",
    layout: "flush",
    component: ShuttlePanel,
    run: ({ threadId, openPanel }) => {
      openPanel({ params: tabParams(threadId) });
    },
  });
  app.slots.experimental_threadInfoSection({ id: "pull-requests", group: INFO_SECTION_GROUPS.related, order: 5, component: PullRequestsInfo });
  // GitHub PR Status sorts its segment under "2_pullRequest"; Shuttle's sits beside it.
  app.slots.experimental_threadContextSegment({
    id: "pull-requests",
    title: "Pull requests",
    group: "2_pullRequest",
    order: 20,
    summary: PullRequestsSummary,
    details: PullRequestsDetails,
    action: PullRequestsAction,
    useVisible: useHasThreadPrs,
  });
  app.slots.settingsSection({
    id: "servers",
    title: "Servers",
    description: "Where Shuttle finds pull requests. GitHub is built in; any other server runs on commands that print JSON.",
    component: ServersSection,
  });
  app.slots.settingsSection({
    id: "presets",
    title: "Review presets",
    description: "What an AI review runs with. Start AI review offers each one, the default first.",
    component: PresetsSection,
  });
  app.slots.settingsSection({
    id: "automations",
    title: "Automations",
    description: "What Shuttle does without you. Everything it does shows in Insights › Automation log.",
    component: AutomationsSection,
  });
  app.slots.settingsSection({
    id: "import-export",
    title: "Import and export",
    description: "Every setting above as TOML, to copy between machines or keep in your dotfiles.",
    component: TransferSection,
  });
});
