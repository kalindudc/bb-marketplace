import { homedir } from "node:os";
import { operatorScript, operatorScriptRoots } from "./operator-script";
import type { HostInput } from "../host-contract";
import type { SetupLine } from "../shared/setup";
import { forgeCommands, setupScriptPath } from "../shared/setup-forge";
import { shellQuote } from "../scope/sandbox";
import { probeForgeHelp } from "./forge";

type Input = HostInput<"setupForgeInspect">;
type CheckedScript = { line: SetupLine; path: string | null; field: typeof forgeCommands[number] };
function scripts(input: Input, resolvedOnly = false): CheckedScript[] {
  const roots = operatorScriptRoots(input.blockedRoots);
  return input.forges.flatMap<CheckedScript>(({ index, profile }) => {
    if (profile.kind !== "command") return [{ line: { key: `machines.forges.${index}`, status: "unchecked" as const, message: "The built-in forge runs its help check after Apply." }, path: null, field: "open" }];
    return forgeCommands.flatMap<CheckedScript>(field => {
      const command = profile[field];
      if (command === undefined) return [];
      const key = `machines.forges.${index}.${field}`, path = setupScriptPath(command);
      const fail = (message: string) => [{ line: { key, status: "fail" as const, message }, path: null, field }];
      try {
        return [{ line: { key, status: "pass" as const, message: "Executable file outside agent checkouts and thread storage." }, path: operatorScript(path, roots, resolvedOnly), field }];
      } catch (error) {
        return fail(error instanceof Error ? error.message : "The script could not be inspected as an executable file.");
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
