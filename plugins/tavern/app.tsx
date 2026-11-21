import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerLanternLight } from "./src/ui/engine/light-overlay";
import { registerPageSurfaces } from "./src/ui/page/register";
import { registerThreadSurfaces } from "./src/ui/thread/register";

export default definePluginApp((app) => {
  registerThreadSurfaces(app);
  registerPageSurfaces(app);
  registerLanternLight(app);
});
