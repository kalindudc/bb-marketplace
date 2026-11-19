import { isMap, isNode, parse, parseDocument } from "yaml";
import { characterDefSchema, classDefSchema, type CharacterDef, type ClassDef } from "../shared/schema";

const FRONTMATTER = /^(---(\r?\n))([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export function withCharacterAvatar(raw: string, avatar: string): string {
  const match = FRONTMATTER.exec(raw);
  if (!match) throw new Error("Expected YAML frontmatter");
  const opening = match[1]!, newline = match[2]!, frontmatter = match[3]!;
  const map = parseDocument(frontmatter).contents;
  if (!isMap(map) || !map.range) throw new Error("Frontmatter must be an object");
  const node = map.get("avatar", true);
  const value = JSON.stringify(avatar);
  if (isNode(node) && node.range) {
    const [start, end] = node.range;
    const lineBreak = frontmatter.slice(start, end).match(/\r?\n$/)?.[0] ?? "";
    return raw.slice(0, opening.length + start) + value + lineBreak + raw.slice(opening.length + end);
  }
  const start = map.range[0];
  const indent = frontmatter.slice(frontmatter.lastIndexOf("\n", start - 1) + 1, start);
  const offset = opening.length + start + (map.flow ? 1 : 0);
  const field = `avatar: ${value}${map.flow ? ", " : newline + indent}`;
  return raw.slice(0, offset) + field + raw.slice(offset);
}

export function parseRegistryDefinition(kind: "class", raw: string, source: string): ClassDef;
export function parseRegistryDefinition(kind: "character", raw: string, source: string): CharacterDef;
export function parseRegistryDefinition(kind: "class" | "character", raw: string, source: string): ClassDef | CharacterDef;
export function parseRegistryDefinition(kind: "class" | "character", raw: string, source: string): ClassDef | CharacterDef {
  const match = FRONTMATTER.exec(raw);
  if (!match) throw new Error("Expected YAML frontmatter");
  const frontmatter: unknown = parse(match[3]!);
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) throw new Error("Frontmatter must be an object");
  const data = { ...frontmatter, body: match[4]!.trim(), source };
  return kind === "class" ? classDefSchema.strict().parse({ provider: null, model: null, reasoning: null, permission: null, environment: null, tools: [], hires: [], greenlight: null, budget: null, ...data }) : characterDefSchema.strict().parse(data);
}
