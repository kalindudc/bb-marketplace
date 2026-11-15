import { z } from "zod";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export function readStored<S extends z.core.$ZodType>(schema: S, value: unknown, path: string, warn: (message: string) => void): z.output<S> | undefined {
  let shape: z.core.$ZodType = schema;
  while (shape instanceof z.ZodOptional || shape instanceof z.ZodDefault || shape instanceof z.ZodNullable) {
    if (shape instanceof z.ZodNullable && value === null) break;
    shape = shape.unwrap();
  }
  let candidate = value;
  if ((shape instanceof z.ZodObject || shape instanceof z.ZodRecord) && record(value)) {
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) {
      const allowed = !["__proto__", "constructor", "prototype"].includes(key) && (shape instanceof z.ZodObject ? own(shape.shape, key) : z.safeParse(shape.keyType, key).success);
      if (!allowed) { warn(`Tavern ignored obsolete stored setting ${path}.${key}; defaults or inheritance apply.`); continue; }
      const child = shape instanceof z.ZodObject ? shape.shape[key] : shape.valueType;
      const parsed = readStored(child, item, `${path}.${key}`, warn);
      if (parsed !== undefined) entries.push([key, parsed]);
    }
    candidate = Object.fromEntries(entries);
  }
  const parsed = z.safeParse(schema, candidate);
  if (parsed.success) return parsed.data;
  warn(`Tavern ignored invalid stored setting ${path}; defaults or inheritance apply.`);
  return undefined;
}
