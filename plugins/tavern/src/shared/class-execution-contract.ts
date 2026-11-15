import { z } from "zod";

export const classExecutionSchema = z.object({
  providerId: z.string(), model: z.string().optional(), reasoningLevel: z.string().optional(),
  permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
});
export type ClassExecution = z.infer<typeof classExecutionSchema>;
export const classFieldSchema = z.object({
  field: z.string(), value: z.string().nullable(), valueLabel: z.string().optional(), dependsOnProject: z.boolean().optional(),
  source: z.enum(["settings", "project-file", "user-file", "shipped-file", "keeper", "catalog-default", "provider-default", "forced", "role", "preset"]),
  path: z.string().optional(), varies: z.enum(["keeper", "maker"]).optional(), rule: z.string().optional(),
  substitution: z.object({ from: z.string(), to: z.string(), reason: z.string() }).optional(),
});
export const classModeFactsSchema = z.object({
  execution: classExecutionSchema.nullable(), fields: z.array(classFieldSchema), errors: z.array(z.string()), notes: z.array(z.string()),
  requiresPi: z.boolean(),
  projectOverrides: z.array(z.object({ field: z.string(), message: z.string(), path: z.string() })),
  body: z.object({ bytes: z.number(), limit: z.number() }),
});
export type ClassModeFacts = z.infer<typeof classModeFactsSchema>;
export const classExecutionInputSchema = z.object({
  classId: z.string(), projectId: z.string().optional(), providerId: z.string().optional(),
  environmentId: z.string().nullable().optional(), mode: z.enum(["start", "hire"]), makerThreadId: z.string().optional(),
}).strict();
export type ClassExecutionInput = z.infer<typeof classExecutionInputSchema>;
export const classNoticeSchema = z.object({
  message: z.string(), settings: z.boolean(),
  switchExecution: classExecutionSchema.pick({ model: true, reasoningLevel: true }).nullable(),
});
export type ClassNotice = z.infer<typeof classNoticeSchema>;

export function classStartRefusal(expected: ClassExecution, actual: { providerId: string; permissionMode?: string | null; model?: string | null; reasoningLevel?: string | null }, requiresPi: boolean): string | null {
  if (requiresPi && actual.providerId !== "pi")
    return "This class requires Pi to block commands before execution. Choose Pi in the composer, or start a plain thread without this class.";
  const modes = ["accept-edits", "auto", "full"];
  if (expected.permissionMode && expected.permissionMode !== "full" && (!actual.permissionMode || !modes.includes(actual.permissionMode) || modes.indexOf(actual.permissionMode) > modes.indexOf(expected.permissionMode)))
    return `This class allows ${expected.permissionMode} permission; the composer requests ${actual.permissionMode ?? "an unverified permission"}. Choose ${expected.permissionMode} or a narrower permission, or start a plain thread.`;
  return null;
}
