import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { UpdatesOverlay } from "./src/overlay";

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "installed-updates", component: UpdatesOverlay });
});
