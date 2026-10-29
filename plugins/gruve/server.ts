import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { SETTINGS_CHANNEL, SETTING_DESCRIPTORS } from "./src/settings";

export default function gruve(bb: BbPluginApi): void {
  // The appearance runs in app.tsx; the server owns its values and tells the
  // settings page when they change, so the window applies them as they are saved.
  const settings = bb.settings.define(SETTING_DESCRIPTORS);
  settings.onChange(() => bb.realtime.publish(SETTINGS_CHANNEL, {}));
  bb.log.info("Gruve theme registered");
}
