import { parse } from "smol-toml";
import { z } from "zod";
import { settingsSchema, settingsPatchSchema, sparseTunablesSchema, TUNABLES, type SettingsSnapshot, type SettingsPatch, type SparseTunables,
  type SettingsChange } from "../../shared/settings";
import { displayChanges } from "./store";
import { LIMITS } from "../limits";
import { decodeSettingsToml, encodeSettingsToml, SettingsTomlError, snake } from "./format";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
function linesOf(source: string) {
  const result = new Map<string, number>(), arrays = new Map<string, number>();
  let table: string[] = [], multiline: string | null = null;
  const dotted = (key: string) => key.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.\s]+/g)?.map(part => part.replace(/^["']|["']$/g, "")) ?? [];
  function resolve(parts: string[], arrayHeader = false) {
    const full: string[] = [];
    parts.forEach((part, index) => {
      full.push(part);
      const key = full.join(".");
      if (arrayHeader && index === parts.length - 1) {
        const next = (arrays.get(key) ?? -1) + 1;
        arrays.set(key, next); full.push(String(next));
      } else if (arrays.has(key)) full.push(String(arrays.get(key)));
    });
    return full;
  }
  for (const [offset, line] of source.split(/\r?\n/).entries()) {
    if (multiline) { if (line.includes(multiline)) multiline = null; continue; }
    const header = /^\s*(\[\[?)(.*?)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = resolve(dotted(header[2]!), header[1] === "[[");
      result.set(table.join("."), offset + 1);
      if (header[1] === "[[" && !result.has(table.slice(0, -1).join("."))) result.set(table.slice(0, -1).join("."), offset + 1);
      continue;
    }
    const assignment = /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^=])+?)\s*=/.exec(line);
    if (assignment) result.set([...table, ...dotted(assignment[1]!)].join("."), offset + 1);
    for (const delimiter of ['"""', "'''"]) if ((line.split(delimiter).length - 1) % 2) multiline = delimiter;
  }
  return (path: string[]) => {
    for (let count = path.length; count > 0; count--) {
      const prefix = path.slice(0, count);
      const line = result.get(prefix.join(".")) ?? (prefix.at(-1) === "inputs" ? result.get([...prefix.slice(0, -1), "inputs_json"].join(".")) : undefined);
      if (line !== undefined) return line;
    }
    return 1;
  };
}
export interface TomlProblem { line: number; key: string; message: string; allowed?: string }
export interface TomlPreview { user: SettingsPatch; pinned: SparseTunables; tuned?: SparseTunables; changes: SettingsChange[]; problems: TomlProblem[] }

export function exportToml(snapshot: SettingsSnapshot, withTuned = false) {
  if (snapshot.placementPolicy?.state === "invalid") throw new Error("Machine placement policy is invalid. Repair it before exporting settings.");
  return encodeSettingsToml(snapshot, withTuned);
}
export function previewToml(source: string, snapshot: SettingsSnapshot): TomlPreview {
  const empty: TomlPreview = { user: {}, pinned: {}, changes: [], problems: [] };
  if (Buffer.byteLength(source) > LIMITS.tomlBytes) return { ...empty, problems: [{ line: 1, key: "", message: "Settings file is too large.", allowed: `At most ${LIMITS.tomlBytes} UTF-8 bytes` }] };
  let parsed: Record<string, unknown>;
  try { parsed = parse(source); }
  catch (error) {
    const problem = error as Error & { line?: number };
    return { ...empty, problems: [{ line: problem.line ?? 1, key: "", message: problem.message }] };
  }
  const lineFor = linesOf(source);
  let converted: Record<string, unknown>;
  try { converted = decodeSettingsToml(parsed); }
  catch (error) {
    if (!(error instanceof SettingsTomlError)) throw error;
    const path = error.path.map(snake);
    return { ...empty, problems: [{ line: lineFor(path), key: path.join("."), message: error.message }] };
  }
  const tuning = isObject(converted.tuning) ? converted.tuning : null;
  const pins = tuning?.pinned ?? {};
  if (tuning) delete tuning.pinned;
  const hasTuned = Object.prototype.hasOwnProperty.call(converted, "tuned");
  const tuned = converted.tuned;
  delete converted.tuned;
  if (tuning && !Object.keys(tuning).length) delete converted.tuning;
  const problems: TomlProblem[] = [];
  function validate<T>(schema: z.ZodType<T>, input: unknown, prefix: string[] = []): T | undefined {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
    for (const issue of result.error.issues) {
      const paths = issue.code === "unrecognized_keys" ? issue.keys.map(key => [...issue.path, key]) : [issue.path];
      for (const parts of paths) {
        const canonical = [...prefix, ...parts.map(String)];
        const path = canonical.map((key, index) => canonical[0] === "classes" && index === 1 ? key : snake(key));
        const key = canonical.at(-1)!;
        let range: { min: number; max: number } | undefined = Object.hasOwn(TUNABLES, key) ? TUNABLES[key as keyof typeof TUNABLES] : undefined;
        if (!range && Object.hasOwn(settingsSchema.shape, canonical[0]!)) {
          const section = settingsSchema.shape[canonical[0] as keyof typeof settingsSchema.shape].unwrap();
          let field: z.core.$ZodType | undefined = section instanceof z.ZodObject ? (section.shape as Record<string, z.ZodType>)[key] : undefined;
          while (field instanceof z.ZodDefault || field instanceof z.ZodOptional) field = field.unwrap();
          if (field instanceof z.ZodNumber && field.minValue !== null && field.maxValue !== null)
            range = { min: field.minValue, max: field.maxValue };
        }
        problems.push({ line: lineFor(path), key: path.join("."), message: issue.message,
          ...(range ? { allowed: `${range.min} to ${range.max}` } : {}) });
      }
    }
    return undefined;
  }
  const user = validate(settingsPatchSchema, converted);
  const pinned = validate(sparseTunablesSchema, pins, ["tuning", "pinned"]);
  const machine = hasTuned ? validate(sparseTunablesSchema, tuned, ["tuned"]) : undefined;
  if (problems.length || user === undefined || pinned === undefined) return { ...empty, problems };
  try { encodeSettingsToml({ user, pinned, tuned: machine ?? snapshot.tuned }, true); }
  catch (error) { return { ...empty, problems: [{ line: 1, key: "", message: error instanceof Error ? error.message : String(error) }] }; }
  const before = { user: snapshot.user, pinned: snapshot.pinned, ...(hasTuned ? { tuned: snapshot.tuned } : {}) };
  const after = { user, pinned, ...(hasTuned ? { tuned: machine } : {}) };
  return { user, pinned, ...(hasTuned ? { tuned: machine } : {}), changes: displayChanges(before, after), problems };
}
