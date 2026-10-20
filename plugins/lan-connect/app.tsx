import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { LanSection } from "./src/section";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "lan-connect",
    title: "Devices on your network",
    description: "Pair a phone or laptop on this network to use bb in its browser.",
    component: LanSection,
  });
  app.slots.settingsSection({
    id: "lan-connect-mobile",
    experimental_page: "mobile",
    title: "LAN Connect",
    description: "Use bb in a browser on this network, without bb connect.",
    component: LanSection,
  });
});
