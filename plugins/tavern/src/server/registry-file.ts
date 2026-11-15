import { parse } from "yaml";
import { characterDefSchema, classDefSchema, type CharacterDef, type ClassDef } from "../shared/schema";

export function parseRegistryDefinition(kind: "class", raw: string, source: string): ClassDef;
export function parseRegistryDefinition(kind: "character", raw: string, source: string): CharacterDef;
export function parseRegistryDefinition(kind: "class" | "character", raw: string, source: string): ClassDef | CharacterDef;
export function parseRegistryDefinition(kind: "class" | "character", raw: string, source: string): ClassDef | CharacterDef {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("Expected YAML frontmatter");
  const frontmatter: unknown = parse(match[1]!);
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) throw new Error("Frontmatter must be an object");
  const data = { ...frontmatter, body: match[2]!.trim(), source };
  return kind === "class" ? classDefSchema.strict().parse({ provider: null, model: null, reasoning: null, permission: null, environment: null, tools: [], hires: [], greenlight: null, budget: null, ...data }) : characterDefSchema.strict().parse(data);
}
