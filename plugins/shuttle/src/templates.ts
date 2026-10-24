// Prompt templates: pure, so the settings UI can preview a prompt without pulling in the server.
export const PROMPT_VARIABLES = ["url", "key", "server", "repo", "number", "sep", "display", "head", "base", "title", "author", "skill", "skill_line", "view_command", "note"] as const;
/** The act prompt follows the items in a watch message, so it gets the first PR's variables only. */
export const ACT_PROMPT_VARIABLES = ["url", "key", "display", "head", "title", "view_command"] as const;

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/gu, (whole, name: string) => (name in vars ? vars[name]! : whole));
}

/** One line of server text: no newlines, no fences, bounded, so it cannot pose as Shuttle's own text. */
export function inert(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").replace(/`{3,}/gu, "''").replace(/~{3,}/gu, "--").trim();
  return flat.length > max ? `${flat.slice(0, max)}\u2026` : flat;
}
