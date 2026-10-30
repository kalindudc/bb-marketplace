import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The folder of adapter scripts that ships with this copy of Shuttle. Commands get it as $SHUTTLE_SCRIPTS,
 * so a server set up to run a script from there moves with each upgrade instead of keeping a copy that
 * goes stale. The path is the same from src/ and from the bundled dist/.
 */
export const SCRIPTS_DIR: string | null = (() => {
  const dir = fileURLToPath(new URL("../skills/shuttle/references", import.meta.url));
  return existsSync(dir) ? dir : null;
})();
