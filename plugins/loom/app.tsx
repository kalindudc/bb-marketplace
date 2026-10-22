import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TicketChip } from "./src/ui/chip";
import { LoomPage } from "./src/ui/page";
import { mountRailBadge } from "./src/ui/rail-badge";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "loom", title: "Loom", icon: "loom/loom", path: "loom", component: LoomPage });
  app.slots.experimental_threadHeaderAction({ id: "ticket", title: "Loom", component: TicketChip });
  app.contentScripts.register({ id: "rail-badge", mount: mountRailBadge });
});
