import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountGruveAppearance } from "./src/mount";
import { GruveAppearanceSettings } from "./src/settings-section";

export default definePluginApp((app) => {
  // The theme's colours are the theme sheet's job; the settings change it, so
  // they are applied to the window from a content script.
  app.contentScripts.register({
    id: "appearance",
    mount: ({ pluginId, signal }) => mountGruveAppearance({ document, pluginId, signal }),
  });
  app.slots.settingsSection({
    id: "appearance",
    title: "Appearance",
    description: "What the settings above look like. Changes apply as you save them.",
    component: GruveAppearanceSettings,
  });
});
