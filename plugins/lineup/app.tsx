import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { MenuAnchor } from "./src/menu";
import { LineupSettings } from "./src/settings";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "lineup",
    // Queued-message editors show the model read-only, so there is nothing to pick there.
    scopes: ["new-thread", "thread"],
    actions: [{ id: "model-menu", component: MenuAnchor }],
  });

  app.slots.settingsSection({
    id: "lineup",
    title: "Lineup",
    description: "The models the Lineup tab of the model menu lists, in this order.",
    component: LineupSettings,
  });
});
