import { z } from "zod";
import { argumentError } from "./arguments";

type JsonSchema = z.core.JSONSchema.JSONSchema;

function objectBranches(schema: JsonSchema): JsonSchema[] {
  const branches = schema.anyOf ?? schema.oneOf;
  return branches ? branches.flatMap(objectBranches) : [schema];
}

export function toolInput<S extends z.ZodType>(schema: S, operations?: readonly string[]) {
  const parameters = z.toJSONSchema(schema, { io: "input" });
  if (!parameters.anyOf && !parameters.oneOf) return { parameters, parse: (input: unknown, active: S = schema) => active.safeParse(input) };

  const branches = objectBranches(parameters);
  const key = operations ? "operation" : schema instanceof z.ZodDiscriminatedUnion ? schema.def.discriminator : null;
  if (!key || !(schema instanceof z.ZodUnion) || branches.some(branch => branch.type !== "object") ||
    operations && (operations.length !== branches.length || operations.length !== schema.options.length))
    throw new Error("Tool input unions need flat object variants and an operation selector.");

  const parse = (input: unknown, active: S = schema): z.ZodSafeParseResult<z.output<S>> => {
    if (!operations || !input || typeof input !== "object" || !Object.hasOwn(input, "operation")) return active.safeParse(input);
    if (!(active instanceof z.ZodUnion)) throw new Error("Tool input operations need matching variants.");
    const { operation, ...args } = input as Record<string, unknown>;
    const index = typeof operation === "string" ? operations.indexOf(operation) : -1;
    if (index < 0) throw new Error(`operation: choose ${operations.join(" or ")}.`);
    const result = z.safeParse(active.options[index]!, args);
    if (!result.success) throw new Error(`operation ${operation}: ${argumentError(result.error).message}`);
    return result as z.ZodSafeParseSuccess<z.output<S>>;
  };
  const modes = operations ?? branches.map(branch => {
    const selector = branch.properties?.[key];
    if (typeof selector !== "object" || typeof selector.const !== "string")
      throw new Error(`Tool input discriminator ${key} needs string literals.`);
    return selector.const;
  });
  const labels = operations ?? branches.map((branch, index) => {
    const mode = modes[index]!;
    if (modes.indexOf(mode) === modes.lastIndexOf(mode)) return mode;
    const qualifiers = Object.entries(branch.properties ?? {}).flatMap(([name, property]) =>
      name !== key && typeof property === "object" && typeof property.const === "string" ? [property.const] : []);
    return [mode, ...qualifiers].join("/");
  });
  const fields = new Map<string, { required: string[]; optional: string[]; shapes: Map<string, JsonSchema> }>();
  for (const [index, branch] of branches.entries()) {
    for (const [name, property] of Object.entries(branch.properties ?? {})) {
      if (name === key || typeof property !== "object") continue;
      const field = fields.get(name) ?? { required: [], optional: [], shapes: new Map() };
      (branch.required?.includes(name) ? field.required : field.optional).push(labels[index]!);
      field.shapes.set(JSON.stringify(property), property);
      fields.set(name, field);
    }
  }
  const required = [key];
  const properties: Record<string, JsonSchema> = {
    [key]: { type: "string", enum: [...new Set(modes)], description: "Use only fields for the chosen operation." },
  };
  for (const [name, field] of fields) {
    const shapes = [...field.shapes.values()];
    const shape = shapes.length === 1 ? { ...shapes[0] } : { anyOf: shapes };
    if (field.required.length === branches.length) required.push(name);
    else delete shape.default;
    properties[name] = {
      ...shape,
      description: [shape.description, field.required.length && `Required for ${field.required.join(", ")}.`,
        field.optional.length && `Optional for ${field.optional.join(", ")}.`].filter(Boolean).join(" "),
    };
  }
  // Only the model sees the flat shape; the original branches still validate every call.
  const { $schema, $defs } = parameters;
  return { parameters: { $schema, ...($defs && { $defs }), type: "object", properties, required, additionalProperties: false } satisfies JsonSchema, parse };
}
