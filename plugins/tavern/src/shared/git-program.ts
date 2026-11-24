import { z } from "zod";

const absoluteProgram = (program: string) => z.string().min(1).max(32768)
  .refine(path => /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\)/.test(path) && !/[\0\r\n]/.test(path), `Use an absolute path to the ${program} program.`);
export const gitProgramPathSchema = absoluteProgram("Git");
export const gitProgramSettingSchema = z.union([z.literal(""), gitProgramPathSchema]);
export const piProgramSettingSchema = z.union([z.literal(""), absoluteProgram("Pi")]);
