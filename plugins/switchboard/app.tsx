import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./src/switchboard.css";
import { ThreadList } from "./src/thread-list";
import { createCommands } from "./src/commands";

export default definePluginApp((app) => {
  for (const command of createCommands()) app.commands.register(command);
  app.slots.experimental_threadList({
    id: "switchboard",
    title: "Switchboard",
    description: "Your bb sections as coloured groups, children as trees, and status at a glance.",
    component: ThreadList,
  });
});
