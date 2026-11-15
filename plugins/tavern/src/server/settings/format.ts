import { parse, stringify } from "smol-toml";
import type { SettingsSnapshot } from "../../shared/settings";
import { LIMITS } from "../limits";

export const snake = (key: string) => key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`);
const camel = (key: string) => key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const inputParent = (path: string[]) => path[0] === "machines" && path[1] === "rules" && /^\d+$/.test(path[2] ?? "") &&
  path[3] === "target" && (path.length === 4 || path.length === 5 && path[4] === "machine");

export class SettingsTomlError extends Error {
  constructor(readonly path: string[], message: string) { super(message); }
}
function nativeInputs(value: unknown) {
  try { return JSON.stringify(parse(stringify({ value })).value) === JSON.stringify(value); }
  catch { return false; }
}
function convert(value: unknown, encoding: boolean, path: string[] = []): unknown {
  const reasoning = path.length === 3 && path[0] === "classes" && path[2] === "reasoning";
  const quietHours = path.length === 2 && path[0] === "attention" && (path[1] === "quietHours" || path[1] === "quiet_hours");
  if (encoding && value === null) return reasoning ? "default" : quietHours ? "none" : value;
  if (!encoding && (reasoning && value === "default" || quietHours && value === "none")) return null;
  if (Array.isArray(value)) return value.map((item, index) => convert(item, encoding, [...path, String(index)]));
  if (!object(value)) return value;
  const provider = inputParent(path);
  if (!encoding && provider && own(value, "inputs_json") && own(value, "inputs"))
    throw new SettingsTomlError([...path, "inputs_json"], "Use inputs or inputs_json, not both at the same location.");
  const entries: [string, unknown][] = [], seen = new Set<string>();
  for (const [key, item] of Object.entries(value)) {
    let converted = path.length === 1 && path[0] === "classes" ? key : encoding ? snake(key) : camel(key);
    let next: unknown;
    if (provider && key === "inputs") {
      if (encoding && !nativeInputs(item)) { converted = "inputs_json"; next = JSON.stringify(item); }
      else next = item;
    } else if (!encoding && provider && key === "inputs_json") {
      if (typeof item !== "string") throw new SettingsTomlError([...path, key], "inputs_json must be a JSON string.");
      try { next = JSON.parse(item); }
      catch { throw new SettingsTomlError([...path, key], "inputs_json must contain valid JSON."); }
      converted = "inputs";
    } else next = convert(item, encoding, [...path, converted]);
    if (seen.has(converted)) throw new SettingsTomlError([...path, key], "These keys refer to the same setting; use only its snake_case spelling.");
    seen.add(converted); entries.push([converted, next]);
  }
  return Object.fromEntries(entries);
}
export function decodeSettingsToml(parsed: Record<string, unknown>) {
  return convert(parsed, false) as Record<string, unknown>;
}
export function encodeSettingsToml(snapshot: Pick<SettingsSnapshot, "user" | "pinned" | "tuned">, withTuned = false) {
  const result = convert(snapshot.user, true) as Record<string, unknown>;
  if (Object.keys(snapshot.pinned).length) {
    const tuning = object(result.tuning) ? result.tuning : {};
    result.tuning = { ...tuning, pinned: convert(snapshot.pinned, true) };
  }
  if (withTuned) result.tuned = convert(snapshot.tuned, true);
  const text = `# Tavern settings. Unlisted values inherit defaults; tuned values are machine state.\n${stringify(result)}`;
  if (Buffer.byteLength(text) > LIMITS.tomlBytes) throw new Error(`Settings export exceeds ${LIMITS.tomlBytes} UTF-8 bytes. Shorten the placement rules or provider inputs.`);
  return text;
}
