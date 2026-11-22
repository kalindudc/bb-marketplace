import { homedir } from "node:os";
import type { z } from "zod";
import type { memoryPreflightInput, memoryRunInput, memoryRunOutput } from "../shared/memory";
import { operatorScript, operatorScriptRoots } from "./operator-script";
import { runProcess, type ProcessResult } from "./process";

const options = (timeoutSeconds: number, signal: AbortSignal) => ({ cwd: homedir(), signal, timeoutMs: timeoutSeconds * 1000, maxBuffer: 262_144 });
const failure = (result: ProcessResult) => result.timedOut ? "The command timed out."
  : result.code === null ? "The command ended without an exit code." : `The command failed with exit code ${result.code}.`;

export async function preflightMemory(input: z.infer<typeof memoryPreflightInput>, signal: AbortSignal) {
  const roots = operatorScriptRoots(input.blockedRoots);
  const paths = { save: operatorScript(input.save, roots), find: operatorScript(input.find, roots), curate: operatorScript(input.curate, roots) };
  for (const [op, path] of Object.entries(paths)) {
    try {
      const result = await runProcess(operatorScript(path, roots, true), ["--help"], options(input.timeoutSeconds, signal));
      if (result.timedOut || result.code !== 0) throw new Error(failure(result));
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(`${op} help check failed. ${error instanceof Error ? error.message : "The command could not run."}`);
    }
  }
  return paths;
}
export async function runMemory(input: z.infer<typeof memoryRunInput>, signal: AbortSignal): Promise<z.infer<typeof memoryRunOutput>> {
  try { operatorScript(input.path, operatorScriptRoots(input.blockedRoots), true); }
  catch (error) { return { outcome: "failed", code: "path", message: (error instanceof Error ? error.message : "The executable could not be checked.").slice(0, 300) }; }
  let result: ProcessResult;
  try {
    result = await runProcess(input.path, [], { ...options(input.timeoutSeconds, signal), input: input.content });
  } catch {
    signal.throwIfAborted();
    return { outcome: "failed", code: "process", message: "The command could not run or exceeded the 256 KiB output limit." };
  }
  if (result.timedOut || result.code !== 0) {
    const diagnostic = result.timedOut ? "" : result.stderr.trim().replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 400);
    return { outcome: "failed", code: result.timedOut ? "timeout" : "exit", message: [failure(result), diagnostic].filter(Boolean).join(" ") };
  }
  const output = result.stdout.trim();
  if (input.op !== "find" && (!output || output.length > 300 || /[\x00-\x1f\x7f]/.test(output)))
    return { outcome: "failed", code: "contract", message: "The command must return one note reference of at most 300 characters." };
  return { outcome: "ok", output };
}
