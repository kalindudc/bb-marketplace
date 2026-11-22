import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const under = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
};
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
export function operatorScriptRoots(blockedRoots: readonly string[]) {
  return [...blockedRoots, join(homedir(), ".bb", "thread-storage")].flatMap(root => {
    try { return [resolve(root), realpathSync(root)]; }
    catch (error) { if (missing(error)) return [resolve(root)]; throw error; }
  });
}
export function operatorScript(path: string, roots: readonly string[], resolvedOnly = false) {
  if (!isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error("Use one absolute executable path, without shell arguments.");
  let script: string;
  try { script = realpathSync(path); }
  catch (error) { throw new Error(missing(error) ? "Script does not exist." : "The script could not be inspected as an executable file."); }
  if (roots.some(root => under(path, root) || under(script, root))) throw new Error("Move the script outside agent checkouts and thread storage.");
  if (resolvedOnly && script !== path) throw new Error("The resolved script path changed. Ask for a fresh proposal.");
  try {
    if (statSync(script).isFile()) {
      accessSync(script, constants.X_OK);
      return script;
    }
  } catch { throw new Error("The script could not be inspected as an executable file."); }
  throw new Error("The script is not a regular file.");
}
