import type { BbPluginApi } from "@get-bb/plugin-sdk";

// bb requires a server entry; all of this plugin's behaviour runs in app.tsx.
export default function followThinking(bb: BbPluginApi) {
  bb.log.info("loaded");
}
