import { glob } from "../../src/scope/paths";
import type { Scope } from "../../src/scope/schema";

export interface PiPromptOptions {
  appendSystemPrompt?: string;
  sections?: Record<string, string>;
  forceSystemPrompt?: string;
  selectedTools?: string[];
  skills?: { name: string; description: string }[];
}

const matches = (patterns: readonly string[], name: string) => patterns.some(pattern => pattern === name || pattern.includes("*") && glob(pattern, name));

export function allowPiTool(scope: Scope, name: string): boolean {
  const loadout = scope.piLoadout;
  const chosen = !loadout || matches(loadout.tools, name) || loadout.optIns?.tools?.includes(name);
  return !!chosen && (!scope.tools.hide || matches(scope.tools.allow, name) && !matches(scope.tools.deny, name));
}

export function trimPiPrompt(options: PiPromptOptions, loadout: Scope["piLoadout"]) {
  if (!loadout || !options.skills) return;
  const described = new Set([...loadout.skills, ...loadout.optIns?.skills ?? []]);
  options.skills = options.skills.map(skill => described.has(skill.name) ? skill : { ...skill, description: "" });
}
