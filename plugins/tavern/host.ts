import { fileURLToPath } from "node:url";
import { createTavernHostEntry } from "./src/host/entry";

export { default as tavernGuard } from "./adapters/pi/extension";
export { experimental_providerBridge } from "./src/server/renderer/bridge";
export default createTavernHostEntry({ artifactPath: fileURLToPath(import.meta.url) });
