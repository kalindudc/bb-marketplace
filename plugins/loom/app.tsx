import { definePluginApp, experimental_THREAD_INFO_ROW_GROUPS as INFO_ROW_GROUPS } from "@get-bb/plugin-sdk/app";
import { useLoomBadge } from "./src/ui/badge";
import { LoomInfoRow, TicketChip } from "./src/ui/chip";
import { LoomPage, useLoomPageTitle } from "./src/ui/page";
import { LoomSidebar } from "./src/ui/sidebar";

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
  });
  app.slots.experimental_threadHeaderAction({ id: "ticket", title: "Loom", component: TicketChip });
  // After bb's own thread rows, which use orders 10 to 30.
  app.slots.experimental_threadInfoRow({ id: "loom", group: INFO_ROW_GROUPS.thread, order: 40, component: LoomInfoRow });
});
