import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SettingsSection } from "./src/ui/settings";
import { BrowserToolbarControl } from "./src/ui/toolbar";

export default definePluginApp((app) => {
  app.slots.experimental_browserToolbarAction({
    id: "better-browser",
    title: "Better Browser",
    component: BrowserToolbarControl,
  });
  app.slots.settingsSection({
    id: "better-browser",
    title: "Connection",
    component: SettingsSection,
  });
});
