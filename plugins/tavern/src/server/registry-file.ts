import { isCollection, isMap, isNode, parse, parseDocument, stringify } from "yaml";
import { z } from "zod";
import { characterDefSchema, classDefSchema, type CharacterDef, type ClassDef } from "../shared/schema";

export type RegistryKind = "class" | "character";
export type Definition = ClassDef | CharacterDef;
export type RegistryRecord = { format: "full"; id: string; definition: Definition } | { format: "patch"; id: string; fields: Record<string, unknown> };
const PATCH = "tavern-registry-patch/1";
const classFields = classDefSchema.omit({ id: true, source: true }).strict().partial();
const characterFields = characterDefSchema.omit({ id: true, source: true }).strict().partial();
const patchSchema = z.strictObject({ format: z.literal(PATCH), id: classDefSchema.shape.id, fields: z.unknown() });
const defaults = { provider: null, model: null, reasoning: null, permission: null, environment: null, tools: [], hires: [], greenlight: null, budget: null };
const schema = (kind: RegistryKind) => kind === "class" ? classDefSchema.strict() : characterDefSchema.strict();

const FRONTMATTER = /^(---(\r?\n))([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export function withCharacterField(raw: string, key: string, value: unknown): string {
  const match = FRONTMATTER.exec(raw);
  if (!match) throw new Error("Expected YAML frontmatter");
  const opening = match[1]!, newline = match[2]!, frontmatter = match[3]!;
  const map = parseDocument(frontmatter).contents;
  if (!isMap(map) || !map.range) throw new Error("Frontmatter must be an object");
  const indentAt = (start: number) => frontmatter.slice(frontmatter.lastIndexOf("\n", start - 1) + 1, start);
  const block = (data: unknown, indent: string) => stringify(data, { lineWidth: 0 }).trimEnd().replaceAll("\n", newline + indent);
  const node = map.get(key, true);
  if (isNode(node) && node.range) {
    const [start, end] = node.range;
    const lineBreak = frontmatter.slice(start, end).match(/\r?\n$/)?.[0] ?? "";
    const replacement = isCollection(node) && !node.flow ? block(value, indentAt(start)) : JSON.stringify(value);
    return raw.slice(0, opening.length + start) + replacement + lineBreak + raw.slice(opening.length + end);
  }
  const start = map.range[0], indent = indentAt(start);
  const offset = opening.length + start + (map.flow ? 1 : 0);
  const field = map.flow ? `${key}: ${JSON.stringify(value)}, ` : `${block({ [key]: value }, indent)}${newline}${indent}`;
  return raw.slice(0, offset) + field + raw.slice(offset);
}

export function parseRegistryDefinition(kind: "class", raw: string, source: string): ClassDef;
export function parseRegistryDefinition(kind: "character", raw: string, source: string): CharacterDef;
export function parseRegistryDefinition(kind: "class" | "character", raw: string, source: string): ClassDef | CharacterDef;
export function parseRegistryDefinition(kind: RegistryKind, raw: string, source: string): Definition {
  const { frontmatter, body } = split(raw);
  return schema(kind).parse({ ...(kind === "class" ? defaults : {}), ...frontmatter, body, source });
}

function split(raw: string) {
  const match = FRONTMATTER.exec(raw);
  if (!match) throw new Error("Expected YAML frontmatter");
  const frontmatter: unknown = parse(match[3]!);
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) throw new Error("Frontmatter must be an object");
  return { frontmatter, body: match[4]!.trim() };
}

export function parseRegistryRecord(kind: RegistryKind, raw: string, source: string): RegistryRecord {
  const { frontmatter, body } = split(raw);
  if (Object.hasOwn(frontmatter, "format")) {
    const { id, fields } = patchSchema.parse(frontmatter);
    if (body) throw new Error("Put patch fields, including the prompt, under fields in the frontmatter.");
    const parsed = (kind === "class" ? classFields : characterFields).parse(fields);
    if (!Object.keys(parsed).length) throw new Error("A registry patch needs at least one field.");
    return { format: "patch", id, fields: parsed };
  }
  const definition = schema(kind).parse({ ...(kind === "class" ? defaults : {}), ...frontmatter, body, source });
  return { format: "full", id: definition.id, definition };
}

export function applyRegistryRecord(kind: RegistryKind, entry: RegistryRecord, base: Definition | undefined, source: string): Definition {
  if (entry.format === "full") return entry.definition;
  if (!base) throw new Error(`Patch for ${entry.id} has no lower definition to inherit.`);
  return schema(kind).parse({ ...base, ...entry.fields, source });
}

export function formatPatch(id: string, fields: Record<string, unknown>) {
  return `---\n${stringify({ format: PATCH, id, fields }, { lineWidth: 0 })}---\n`;
}

export function formatDefinition(definition: Definition) {
  const { source: _source, body, ...frontmatter } = definition;
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n${body}\n`;
}
