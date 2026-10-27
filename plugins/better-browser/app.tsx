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
    title: "Your browser",
    description: "Pick the browser and profile bb's Browser follows. Its sessions sync into bb, sign-in pages finish there, and Cmd+click opens links there.",
    component: SettingsSection,
  });
});
