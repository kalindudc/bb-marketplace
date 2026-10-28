import type { BbPluginApi } from "@get-bb/plugin-sdk";

// The theme ships through bb.themes in package.json; bb still requires a server entry.
export default function gruve(bb: BbPluginApi): void {
  bb.log.info("Gruve theme registered");
}
