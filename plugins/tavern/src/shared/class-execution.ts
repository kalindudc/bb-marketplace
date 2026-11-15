import { z } from "zod";

export const EXECUTION_KEYS = ["provider", "model", "reasoning"] as const;
export type ExecutionKey = typeof EXECUTION_KEYS[number];
export const executionFactSchema = z.object({ value: z.string().nullable(), source: z.enum(["settings", "file"]), file: z.string().nullable() });
export type ExecutionFact = z.infer<typeof executionFactSchema>;
export const executionFactsSchema = z.object({ provider: executionFactSchema, model: executionFactSchema, reasoning: executionFactSchema });
export type ExecutionFacts = z.infer<typeof executionFactsSchema>;

/**
 * What a class runs with and where each value comes from. Settings wins over the class file key by key, as runtime.snapshot merges them;
 * a Settings reasoning of null is an explicit "provider default". null means the project or provider default.
 */
export function effectiveExecution(file: Partial<Record<ExecutionKey, string | null | undefined>>, override: Partial<Record<ExecutionKey, string | null | undefined>> = {}): ExecutionFacts {
  const fact = (key: ExecutionKey): ExecutionFact => {
    const own = file[key] ?? null;
    return override[key] !== undefined ? { value: override[key] ?? null, source: "settings", file: own } : { value: own, source: "file", file: own };
  };
  return { provider: fact("provider"), model: fact("model"), reasoning: fact("reasoning") };
}
