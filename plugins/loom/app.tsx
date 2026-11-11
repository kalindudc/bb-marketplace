import { definePluginApp, experimental_THREAD_INFO_ROW_GROUPS as INFO_ROW_GROUPS, type PluginThreadActionRegistration } from "@get-bb/plugin-sdk/app";
import { useLoomBadge } from "./src/ui/badge";
import { createCommands } from "./src/ui/commands";
import { LoomInfoRow } from "./src/ui/chip";
import { LoomHeader } from "./src/ui/header";
import { LoomPage, useLoomPageTitle } from "./src/ui/page";
import { LoomSidebar } from "./src/ui/sidebar";
import { ForgesSection, ForgeTransferSection } from "./src/ui/forges";
import { LoomSegment, LoomSegmentDetails, LoomThreadTab, threadButton, useLoomThread, useThreadInfos } from "./src/ui/thread-surfaces";
import type { ThreadInfo } from "./src/contract";

// bb draws a thread action with placement "header" as a button in the thread's header (bb 0.6.132); the pinned SDK's typings predate the field.
type HeaderAction<Data> = PluginThreadActionRegistration<Data> & { placement: "header" };

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "loom",
    title: "Loom",
    icon: "loom/loom",
    path: "loom",
    component: LoomPage,
    experimental_sidebar: LoomSidebar,
    experimental_useBadge: useLoomBadge,
    experimental_usePageTitle: useLoomPageTitle,
    headerContent: LoomHeader,
  });
  const ticketButton: HeaderAction<Record<string, ThreadInfo>> = { id: "ticket", title: "Loom", icon: "loom/loom", group: "loom", placement: "header", useData: useThreadInfos, item: threadButton };
  app.slots.experimental_threadAction(ticketButton);
  app.slots.experimental_threadContextSegment({ id: "loom", title: "Loom", group: "2_loom", summary: LoomSegment, details: LoomSegmentDetails, useVisible: useLoomThread });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "fixed", id: "loom", title: "Loom", icon: "loom/loom", layout: "flush", component: LoomThreadTab, useVisible: useLoomThread });
  // After bb's own thread rows, which use orders 10 to 30.
  app.slots.experimental_threadInfoRow({ id: "loom", group: INFO_ROW_GROUPS.thread, order: 40, component: LoomInfoRow });
  app.slots.settingsSection({
    id: "forges",
    title: "Forges",
    description: "Command forges any spec names with forge = { profile = \"<id>\" }: their commands, the authors Loom counts as bots, and notes for agents. An edit reaches every project that uses the profile at its next forge call.",
    component: ForgesSection,
  });
  app.slots.settingsSection({
    id: "forge-import-export",
    title: "Import and export",
    description: "Every forge profile as TOML, to keep in a file or copy to another machine.",
    component: ForgeTransferSection,
  });
  for (const command of createCommands()) app.commands.register(command);
});
