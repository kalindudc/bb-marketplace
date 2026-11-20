import { z } from "zod";
import { shellQuote } from "../scope/sandbox";
import { forgeProfileSchema } from "./placement-settings";

export const setupForgeInput = z.object({
  root: z.string().min(1).nullable(),
  git: z.enum(["full", "porcelain"]).optional(),
  blockedRoots: z.array(z.string().min(1)),
  forges: z.array(z.object({ index: z.number().int().nonnegative(), profile: forgeProfileSchema }).strict()).max(50),
}).strict();

export const forgeCommands = ["open", "state", "close"] as const;
export function setupScriptPath(command: string) {
  if (command.startsWith("'")) {
    const path = command.slice(1, -1).replaceAll("'\\''", "'");
    if (shellQuote(path) === command) return path;
  }
  return command;
}
export function setupScriptCommand(command: string) {
  const path = setupScriptPath(command);
  return path.startsWith("/") && !/^[\w./-]+$/.test(path) ? shellQuote(path) : path;
}
