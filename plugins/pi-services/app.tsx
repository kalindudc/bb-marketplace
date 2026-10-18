import { definePluginApp } from "@get-bb/plugin-sdk/app";
import {
  PiServicesSettingsSection,
  RegenerateTitleButton,
} from "./src/ui";

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "regenerate-title",
    title: "Regenerate title with pi",
    component: RegenerateTitleButton,
  });

  app.slots.settingsSection({
    id: "pi-services",
    title: "Pi AI Services",
    description: "Configure how the pi CLI generates thread titles and commit messages.",
    component: PiServicesSettingsSection,
  });
});
