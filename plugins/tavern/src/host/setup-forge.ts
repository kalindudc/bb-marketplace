import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HostInput } from "../host-contract";
import type { SetupLine } from "../shared/setup";
import { forgeCommands, setupScriptPath } from "../shared/setup-forge";
import { shellQuote } from "../scope/sandbox";
import { probeForgeHelp } from "./forge";

type Input = HostInput<"setupForgeInspect">;
const under = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
};
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const checkedRoot = (path: string) => {
  try { return realpathSync(path); }
  catch (error) { if (missing(error)) return resolve(path); throw error; }
};

type CheckedScript = { line: SetupLine; path: string | null; field: typeof forgeCommands[number] };
function scripts(input: Input, resolvedOnly = false): CheckedScript[] {
  const roots = [...input.blockedRoots, join(homedir(), ".bb", "thread-storage")].flatMap(root => [resolve(root), checkedRoot(root)]);
  return input.forges.flatMap<CheckedScript>(({ index, profile }) => {
    if (profile.kind !== "command") return [{ line: { key: `machines.forges.${index}`, status: "unchecked" as const, message: "The built-in forge runs its help check after Apply." }, path: null, field: "open" }];
    return forgeCommands.flatMap<CheckedScript>(field => {
      const command = profile[field];
      if (command === undefined) return [];
      const key = `machines.forges.${index}.${field}`, path = setupScriptPath(command);
      const fail = (message: string) => [{ line: { key, status: "fail" as const, message }, path: null, field }];
      if (!isAbsolute(path) || /[\r\n\0]/.test(path)) return fail("Use one absolute executable path, without shell arguments.");
      try {
        const script = realpathSync(path);
        if (roots.some(root => under(path, root) || under(script, root))) return fail("Move the script outside agent checkouts and thread storage.");
        if (resolvedOnly && script !== path) return fail("The resolved script path changed. Ask for a fresh proposal.");
        if (!statSync(script).isFile()) return fail("The script is not a regular file.");
        accessSync(script, constants.X_OK);
        return [{ line: { key, status: "pass" as const, message: "Executable file outside agent checkouts and thread storage." }, path: script, field }];
      } catch (error) {
        return fail(missing(error) ? "Script does not exist." : "The script could not be inspected as an executable file.");
      }
    });
  });
}
export const inspectSetupForges = (input: Input) => scripts(input).map(({ line, path }) => ({ ...line, ...(path === null ? {} : { resolvedPath: path }) }));

export async function probeSetupForges(input: Input, signal: AbortSignal): Promise<SetupLine[]> {
  const entries = scripts(input, true);
  if (entries.some(({ line }) => line.status === "fail")) return entries.map(({ line }) => line);
  const root = input.root ?? homedir();
  const bound = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const checks: SetupLine[] = [];
  for (const { line, path, field } of entries) {
    let detail: string;
    try {
      const result = await probeForgeHelp(root, path === null ? null : shellQuote(path), field, bound, input.git);
      if (result.code === 0 && !result.timedOut) {
        checks.push({ ...line, status: "pass", message: "Read-only help check passed." });
        continue;
      }
      detail = result.timedOut ? "Probe timed out." : result.code === null ? "Probe ended without an exit code." : `Probe failed with exit code ${result.code}.`;
    } catch {
      signal.throwIfAborted();
      detail = bound.aborted ? "Probe timed out." : "The help probe could not run in the forge environment.";
    }
    checks.push({ ...line, status: "fail", message: detail });
  }
  return checks;
}
