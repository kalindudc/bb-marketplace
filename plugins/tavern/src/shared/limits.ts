import { z } from "zod";

function bound(label: string, unit: string, fallback: number, max: number, help: string, advanced = false) {
  return { label, unit, default: fallback, min: 1, max, help, advanced };
}

export const LIMIT_FIELDS = {
  intake: {
    proseChars: { ...bound("Stored agent prose", "characters", 16000, 64000, "Bounds each accepted prose field so a single report, plan or journal entry cannot fill the store or overwhelm the next reader. Long prose is shortened with notice."), min: 64 },
    briefPromptBytes: { ...bound("Brief prompt budget", "bytes", 32000, 64000, "Bounds the brief repeated in member prompts and sent at hire. Tavern saves the full brief and omits context paths whole rather than changing them.", true), min: 1024 },
  },
  journal: {
    entriesMax: bound("Active journal entries", "items", 200, 1000, "Bounds the live checklist Tavern reads and checks on each edit. Earlier entries remain readable if you lower it."),
    noteKeepChars: bound("Journal note retention", "characters", 2000, 16000, "Keeps the running note on an entry from growing without bound. New lines replace the oldest first."),
    reminderBytes: { ...bound("Journal reminder size", "bytes", 4096, 16000, "Protects the thread's prompt budget when Tavern adds a journal reminder to an active turn.", true), min: 128 },
  },
  transport: {
    draftBodyChars: bound("Exact draft body", "characters", 8000, 32000, "Bounds the saved send-as-you preview that must be delivered intact for approval. Oversized drafts are refused, never shortened.", true),
    toolResultChars: { ...bound("Agent tool result size", "characters", 18000, 64000, "Protects model context from long tool results. Only the returned text is clipped; saved work stays intact.", true), min: 512 },
  },
} as const;

type Fields = typeof LIMIT_FIELDS;
export type LimitGroup = keyof Fields;
type LimitName<G extends LimitGroup> = Extract<keyof Fields[G], string>;
export type LimitValues = { [G in LimitGroup]: { -readonly [K in keyof Fields[G]]: number } };
export type LimitSettingKey = { [G in LimitGroup]: `limits.${G}.${LimitName<G>}` }[LimitGroup];

type Rule = ReturnType<typeof bound>;
type LimitShape<G extends LimitGroup, T extends z.ZodType> = { -readonly [K in keyof Fields[G]]: T };
export function limitRule(key: string): Rule | undefined {
  const [section, group, name] = key.split(".");
  if (section !== "limits" || !group || !name || !Object.hasOwn(LIMIT_FIELDS, group)) return;
  const fields: Record<string, Rule> = LIMIT_FIELDS[group as LimitGroup];
  return Object.hasOwn(fields, name) ? fields[name] : undefined;
}
function sections<T extends z.ZodType>(field: (key: string, rule: Rule) => T) {
  return Object.fromEntries(Object.entries(LIMIT_FIELDS).map(([group, definitions]) => [group,
    z.object(Object.fromEntries(Object.entries(definitions).map(([name, rule]) => [name, field(`limits.${group}.${name}`, rule)]))).strict(),
  ])) as { [G in LimitGroup]: z.ZodObject<LimitShape<G, T>> };
}
function valueSchema(key: string, rule: Rule) {
  return z.number().int().min(rule.min, `${key} must be at least ${rule.min}.`).max(rule.max, `${key} may be at most ${rule.max}.`);
}
const defaultSections = sections((key, rule) => valueSchema(key, rule).default(rule.default));
const defaultGroups = Object.fromEntries(Object.entries(defaultSections).map(([group, schema]) => [group,
  (schema as z.ZodObject<Record<string, z.ZodDefault<z.ZodNumber>>>).prefault({}),
])) as { [G in LimitGroup]: z.ZodPrefault<z.ZodObject<LimitShape<G, z.ZodDefault<z.ZodNumber>>>> };
const patchSections = sections((key, rule) => valueSchema(key, rule).optional());
export const limitsSettingsSchema = z.object(defaultGroups).strict().prefault({});
export const limitsPatchSchema = z.object(patchSections).strict().partial();

export function limitMessage(key: string, value: number) {
  const area = key.startsWith("limits.") ? "Limits" : key.startsWith("attention.") ? "Your attention" : "Keepers and decisions";
  return `Limit: ${key} = ${value} (Settings, ${area})`;
}

export class IntakeLimits {
  constructor(private readonly values?: LimitValues, private readonly notices?: Set<string>) {}

  private truncate(schema: z.ZodString, key: LimitSettingKey, max?: number) {
    if (max === undefined) return schema;
    return schema.overwrite(value => {
      if (value.length <= max) return value;
      this.notices?.add(`Text truncated. ${limitMessage(key, max)}`);
      return `${value.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
    });
  }

  prose(schema: z.ZodString) {
    return this.truncate(schema, "limits.intake.proseChars", this.values?.intake.proseChars);
  }

  journalNote(schema: z.ZodString) {
    return this.truncate(schema, "limits.journal.noteKeepChars", this.values?.journal.noteKeepChars);
  }

  draftBody(schema: z.ZodString) {
    const max = this.values?.transport.draftBodyChars;
    return max === undefined ? schema : schema.max(max, limitMessage("limits.transport.draftBodyChars", max));
  }
}

export const storedLimits = new IntakeLimits();
