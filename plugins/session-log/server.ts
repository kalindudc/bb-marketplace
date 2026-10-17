import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { SETTINGS_CHANNEL, SETTING_DESCRIPTORS } from "./src/settings";

// The log runs in app.tsx; the server owns the settings and tells open panels when they change.
export default function sessionLog(bb: BbPluginApi): void {
  const settings = bb.settings.define(SETTING_DESCRIPTORS);
  settings.onChange(() => bb.realtime.publish(SETTINGS_CHANNEL, {}));
  bb.log.info("loaded");
}
