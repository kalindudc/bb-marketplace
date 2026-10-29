import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ProjectSources, ThreadSources } from "./src/ui/panels.tsx";

export default definePluginApp((app) => {
 app.slots.navPanel({ id: "sources", title: "Sources", icon: "BookOpen", path: "sources", component: ProjectSources });
 app.slots.experimental_tab({ id: "sources", title: "Sources", icon: "BookOpen", context: { kind: "thread" }, availability: "fixed", layout: "flush", component: ThreadSources });
});
