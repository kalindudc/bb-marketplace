import { z } from "zod";
import { providerInputsSchema, settingsJsonValueSchema } from "../../shared/placement-settings";

type Json = z.infer<typeof providerInputsSchema>;
type Problem = { path: string; message: string };
type Substitution = "keeper.branch" | "source.commit" | "source.base" | "member.branch" | "quest.id";
export type PlacementSubstitutions = Partial<Record<Substitution, string | null>>;
export type PlacementInputsCheck =
  | { state: "valid"; inputs: Json; supplied: boolean; method: "advertised-empty" | "json-schema-subset" }
  | { state: "unsupported"; inputs: Json; supplied: true; issues: Problem[] }
  | { state: "invalid"; issues: Problem[] };

const substitutions = new Set<Substitution>(["keeper.branch", "source.commit", "source.base", "member.branch", "quest.id"]);
const annotations = new Set(["title", "description", "examples", "default", "readOnly", "writeOnly", "deprecated", "$comment"]);
const schemaMaps = new Set(["properties", "$defs", "definitions"]);
const schemaArrays = new Set(["prefixItems", "anyOf", "oneOf", "allOf"]);
const schemaSingles = new Set(["additionalProperties", "additionalItems", "items", "not"]);
const scalarKeywords = new Set([
  "$schema", "$ref", "type", "enum", "const", "required", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems",
  "minProperties", "maxProperties",
]);
const formats = new Set(["email", "uri", "uuid", "date-time", "date", "time", "duration", "hostname", "ipv4", "ipv6"]);
const types = new Set(["null", "boolean", "string", "number", "integer", "array", "object"]);
const integerBounds = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
const numericBounds = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const untypedKeywords = new Set(["$schema", "$defs", "definitions", "$ref", "enum", "const", "anyOf", "oneOf", "allOf"]);

class SubstitutionError extends Error {
  constructor(readonly path: string, message: string) { super(message); }
}

function fillInputs(value: Json, values: PlacementSubstitutions, path = "inputs"): Json {
  if (typeof value === "string") return value.replace(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/g, (whole, name: string) => {
    if (!substitutions.has(name as Substitution)) throw new SubstitutionError(path, `Unknown substitution ${whole}.`);
    const replacement = Object.hasOwn(values, name) ? values[name as Substitution] : undefined;
    if (typeof replacement !== "string" || replacement.length === 0)
      throw new SubstitutionError(path, `Substitution ${whole} is unavailable; do not guess a value.`);
    return replacement;
  });
  if (Array.isArray(value)) return value.map((item, index) => fillInputs(item, values, `${path}[${index}]`));
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, fillInputs(item, values, `${path}[${JSON.stringify(key)}]`)]),
  );
  return value;
}

function isObject(value: Json | undefined): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validationSchema(schema: Json): { schema: Json; problem: string | null } {
  let problem: string | null = null;
  const unsupported = (path: string, message: string) => { problem ??= `${path}: ${message}`; };
  const visit = (node: Json, path: string): Json => {
    if (typeof node === "boolean") return node;
    if (!isObject(node)) { unsupported(path, "Expected a JSON Schema object or boolean."); return node; }
    const keys = Object.keys(node).filter(key => !annotations.has(key));
    for (const [key, value] of Object.entries(node)) {
      if (integerBounds.has(key) && (typeof value !== "number" || !Number.isInteger(value) || value < 0))
        unsupported(`${path}.${key}`, "Expected a nonnegative integer bound.");
      if (numericBounds.has(key) && (typeof value !== "number" || key === "multipleOf" && value <= 0))
        unsupported(`${path}.${key}`, "Expected a numeric bound, with positive multipleOf.");
    }
    if (node.$ref !== undefined && (typeof node.$ref !== "string" || node.$ref.length === 0))
      unsupported(path, "Expected a nonempty reference string.");
    if (node.$schema !== undefined && ![
      "https://json-schema.org/draft/2020-12/schema", "http://json-schema.org/draft-07/schema#",
      "http://json-schema.org/draft-04/schema#",
    ].includes(String(node.$schema))) unsupported(path, "The advertised schema dialect is not locally supported.");
    if (node.type !== undefined) {
      const declared = Array.isArray(node.type) ? node.type : [node.type];
      if (declared.length === 0 || declared.some(type => typeof type !== "string" || !types.has(type)))
        unsupported(path, "The advertised type is not supported.");
    }
    const compositions = keys.filter(key => schemaArrays.has(key) && key !== "prefixItems");
    if (compositions.length > 1) unsupported(path, "Combined composition keywords need provider-side validation.");
    if (node.$ref !== undefined && keys.some(key => !["$ref", "$schema", "$defs", "definitions"].includes(key)))
      unsupported(path, "Reference siblings need provider-side validation.");
    if (node.format !== undefined && (typeof node.format !== "string" || !formats.has(node.format)))
      unsupported(path, "The advertised string format is not locally supported.");
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some(key => typeof key !== "string")))
      unsupported(path, "The advertised required fields are invalid.");
    const hasLiteral = node.enum !== undefined || node.const !== undefined;
    if (hasLiteral) {
      const literals = node.enum === undefined ? [node.const] : node.enum;
      if (!Array.isArray(literals) || literals.some(value => value !== null && typeof value === "object") ||
          (node.enum !== undefined && node.const !== undefined) ||
          keys.some(key => !["enum", "const", "type", "$schema", "$defs", "definitions", ...compositions].includes(key))) {
        unsupported(path, "Literal constraints need provider-side validation.");
      } else if (node.type !== undefined) {
        try {
          const type = z.fromJSONSchema({ type: node.type } as Parameters<typeof z.fromJSONSchema>[0]);
          if (literals.some(value => !type.safeParse(value).success))
            unsupported(path, "Literal values conflict with the advertised type.");
        } catch { unsupported(path, "The literal type is not supported."); }
      }
    }
    if (node.type === undefined && keys.some(key => !untypedKeywords.has(key)))
      unsupported(path, "Untyped constraints need provider-side validation.");
    return Object.fromEntries(Object.entries(node).flatMap(([key, value]) => {
      // Defaults are annotations; applying them here could waive a required property.
      if (annotations.has(key)) return [];
      if (schemaMaps.has(key)) {
        if (!isObject(value)) { unsupported(`${path}.${key}`, "Expected a schema map."); return [[key, value]]; }
        return [[key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child, `${path}.${key}[${JSON.stringify(name)}]`)]))]];
      }
      if (schemaArrays.has(key) || key === "items" && Array.isArray(value)) {
        if (!Array.isArray(value)) { unsupported(`${path}.${key}`, "Expected a schema array."); return [[key, value]]; }
        return [[key, value.map((child, index) => visit(child, `${path}.${key}[${index}]`))]];
      }
      if (schemaSingles.has(key)) return [[key, visit(value, `${path}.${key}`)]];
      if (!scalarKeywords.has(key)) unsupported(`${path}.${key}`, "Keyword is not locally supported.");
      return [[key, value]];
    }));
  };
  const result = visit(schema, "schema");
  return { schema: result, problem };
}

export function validatePlacementInputs(
  provider: { id: string; inputs: Json | null; acceptsEmptyInputs: boolean },
  supplied: Json | undefined,
  values: PlacementSubstitutions = {},
): PlacementInputsCheck {
  if (supplied === undefined) return provider.acceptsEmptyInputs
    ? { state: "valid", inputs: null, supplied: false, method: "advertised-empty" }
    : { state: "invalid", issues: [{ path: "inputs", message: `Provider ${provider.id} requires inputs.` }] };
  if (provider.inputs === null) return {
    state: "invalid", issues: [{ path: "inputs", message: `Provider ${provider.id} advertises no inputs schema; omit inputs instead.` }],
  };
  const checked = providerInputsSchema.safeParse(supplied);
  if (!checked.success) return { state: "invalid", issues: checked.error.issues.map(issue => ({ path: "inputs", message: issue.message })) };
  let inputs: Json;
  try { inputs = fillInputs(checked.data, values); }
  catch (error) {
    if (!(error instanceof SubstitutionError)) throw error;
    return { state: "invalid", issues: [{ path: error.path, message: error.message }] };
  }
  const expanded = providerInputsSchema.safeParse(inputs);
  if (!expanded.success) return { state: "invalid", issues: expanded.error.issues.map(issue => ({ path: "inputs", message: issue.message })) };
  const unsupported = (message: string): PlacementInputsCheck => ({
    state: "unsupported", inputs, supplied: true, issues: [{ path: "schema", message }],
  });
  if (!settingsJsonValueSchema.safeParse(provider.inputs).success || Buffer.byteLength(JSON.stringify(provider.inputs)) > 256 * 1024)
    return unsupported("The advertised schema exceeds the local validation bounds.");
  const supported = validationSchema(provider.inputs);
  if (supported.problem !== null) return unsupported(supported.problem);
  let validator: z.ZodType;
  try { validator = z.fromJSONSchema(supported.schema as Parameters<typeof z.fromJSONSchema>[0]); }
  catch (error) { return unsupported(error instanceof Error ? error.message : "The advertised schema cannot be locally validated."); }
  try {
    const parsed = validator.safeParse(inputs);
    return parsed.success
      ? { state: "valid", inputs, supplied: true, method: "json-schema-subset" }
      : { state: "invalid", issues: parsed.error.issues.map(issue => ({ path: ["inputs", ...issue.path].join("."), message: issue.message })) };
  } catch (error) { return unsupported(error instanceof Error ? error.message : "The advertised schema cannot be locally validated."); }
}
