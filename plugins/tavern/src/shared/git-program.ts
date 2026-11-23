import { z } from "zod";

export const gitProgramPathSchema = z.string().min(1).max(32768)
  .refine(path => /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\)/.test(path) && !/[\0\r\n]/.test(path), "Use an absolute path to the Git program.");
export const gitProgramSettingSchema = z.union([z.literal(""), gitProgramPathSchema]);
