import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { JumpstartPanel } from "./src/panel";

export default definePluginApp((app) => {
  const panel = app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "failed-threads",
    label: "Resume failed threads",
    icon: "RotateCcw",
    component: JumpstartPanel,
  });

  app.commands.register({
    id: "resume-failed-threads",
    title: "Jumpstart: resume failed threads",
    run: () => panel.open(),
  });
});
