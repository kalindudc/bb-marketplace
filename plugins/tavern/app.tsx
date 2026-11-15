import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerPageSurfaces } from "./src/ui/page/register";
import { registerThreadSurfaces } from "./src/ui/thread/register";

export default definePluginApp((app) => {
  registerThreadSurfaces(app);
  registerPageSurfaces(app);
});
