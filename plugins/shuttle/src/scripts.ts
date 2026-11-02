import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The reference folder (skills/shuttle/references) of this copy of Shuttle. Commands get it as
 * $SHUTTLE_SCRIPTS; Shuttle ships no adapter of its own there, so a command written for an older
 * version that ran one finds it gone. The path is the same from src/ and from the bundled dist/.
 */
export const SCRIPTS_DIR: string | null = (() => {
  const dir = fileURLToPath(new URL("../skills/shuttle/references", import.meta.url));
  return existsSync(dir) ? dir : null;
})();
