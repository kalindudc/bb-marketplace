import { z } from "zod";

export const POINT_IDS = ["phase", "agent", "volume", "turns", "idle", "thrash"] as const;
export const pointIdSchema = z.enum(POINT_IDS);
export const modeSchema = z.enum(["observe", "advisor", "auto"]);
export type PointId = z.infer<typeof pointIdSchema>;

/** A compaction point: a rule that says "now is a good moment to compact". */
export const pointSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean().default(true),
    when: z.enum(["boundary", "agentHint", "toolResultBytes", "turnsSinceCompaction", "idleSeconds", "signal"]),
    /** `boundary` and `signal` points: the named signals that fire them. */
    signals: z.array(z.string()).optional(),
    /** `toolResultBytes`, `turnsSinceCompaction` and `idleSeconds` points: the threshold. */
    value: z.number().optional(),
    /** Minimum window percent before this point may fire; defaults to `window.softPercent`. */
    minPercent: z.number().min(0).max(100).optional(),
  })
  .loose();

export const vetoSchema = z
  .object({
    midTurn: z.boolean().default(true),
    cooldownSeconds: z.number().min(0).default(600),
    minTurnsBetween: z.number().min(0).default(5),
    belowFloor: z.boolean().default(true),
    previousCompactionFailed: z.boolean().default(true),
  })
  .loose();

export const composerSchema = z
  .object({
    model: z.string().nullable().default(null),
    keepRecentTurns: z.number().int().min(0).default(6),
    maxSummaryTokens: z.number().int().min(0).default(3000),
    ledger: z.boolean().default(true),
    resumeContract: z.boolean().default(true),
  })
  .loose();

export const providerPolicySchema = z.object({ enabled: z.boolean() }).loose();

/** The whole press policy, exactly as `policy.json` in the contract. Unknown fields are kept. */
export const policySchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    mode: modeSchema.default("advisor"),
    pointOverrides: z.partialRecord(pointIdSchema, z.boolean()).optional(),
    window: z
      .object({
        softPercent: z.number().min(1).max(100).default(35),
        hardPercent: z.number().min(1).max(100).default(55),
        floorTokens: z.number().int().min(0).default(60_000),
      })
      .loose(),
    points: z.array(pointSchema).default([]),
    vetoes: vetoSchema,
    composer: composerSchema,
    providers: z.record(z.string(), providerPolicySchema).default({}),
  })
  .loose();

export type Point = z.infer<typeof pointSchema>;
export type Vetoes = z.infer<typeof vetoSchema>;
export type Composer = z.infer<typeof composerSchema>;
export type Policy = z.infer<typeof policySchema>;

/** The built-in defaults, exactly the `policy.json` block in the contract. */
export const DEFAULT_POLICY: Policy = {
  schemaVersion: 1,
  mode: "advisor",
  window: { softPercent: 35, hardPercent: 55, floorTokens: 60_000 },
  points: [
    { id: "phase", enabled: true, when: "boundary", signals: ["plan.approved", "tests.green", "pr.opened", "journal.entry.done"] },
    { id: "agent", enabled: true, when: "agentHint" },
    { id: "volume", enabled: true, when: "toolResultBytes", value: 1_500_000 },
    { id: "turns", enabled: true, when: "turnsSinceCompaction", value: 60 },
    { id: "idle", enabled: true, when: "idleSeconds", value: 300, minPercent: 25 },
    { id: "thrash", enabled: true, when: "signal", signals: ["sameFileRead>=3", "sameCommandFailed>=2", "subagentReportBytes>40000"] },
  ],
  vetoes: { midTurn: true, cooldownSeconds: 600, minTurnsBetween: 5, belowFloor: true, previousCompactionFailed: true },
  composer: { model: null, keepRecentTurns: 6, maxSummaryTokens: 3000, ledger: true, resumeContract: true },
  providers: { pi: { enabled: true } },
};

/** One layer of the resolution order, with a name for error messages. */
export interface PolicyLayer {
  source: string;
  value: unknown;
}

/** What a layer reported invalid: log it (service) or throw it (CLI validation). */
export type LayerErrorReporter = (source: string, issues: readonly string[]) => void;

/** The flat settings from the UI, before `applySettings` maps them onto the policy. */
export interface PressSettings {
  mode: "observe" | "advisor" | "auto";
  softPercent: number;
  hardPercent: number;
  floorTokens: number;
  phasePoint: boolean;
  agentPoint: boolean;
  volumePoint: boolean;
  turnsPoint: boolean;
  idlePoint: boolean;
  thrashPoint: boolean;
  volumeBytes: number;
  turnsBetween: number;
  idleSeconds: number;
  cooldownSeconds: number;
  minTurnsBetween: number;
  composerModel: string;
  maxSummaryTokens: number;
  /** Not part of the policy: whether the service keeps the pi composer installed. */
  autoInstallComposer: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge: objects merge recursively, arrays and scalars replace. `undefined` keeps the base. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? deepMerge((out as Record<string, unknown>)[key], value) : value;
  }
  return out as T;
}

export function mergeThreadOverride(
  stored: string | null,
  patch: { mode?: Policy["mode"]; pointOverrides?: Policy["pointOverrides"] },
): Record<string, unknown> {
  const existing: unknown = stored === null ? {} : JSON.parse(stored);
  if (!isPlainObject(existing)) throw new Error("Thread policy override must be a JSON object");
  return deepMerge(existing, patch);
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`);
}

function checkWindow(policy: Policy): void {
  if (policy.window.softPercent > policy.window.hardPercent) {
    throw new PolicyError(
      "resolved policy",
      [`window.softPercent (${policy.window.softPercent}) must be <= window.hardPercent (${policy.window.hardPercent})`],
    );
  }
}

/** Merge layers over a base, validating after each one; a bad layer goes to the reporter and is skipped. */
function mergePolicyLayers(
  base: unknown,
  layers: readonly PolicyLayer[],
  onLayerError: LayerErrorReporter,
): unknown {
  let merged = base;
  for (const layer of layers) {
    if (layer.value === null || layer.value === undefined) continue;
    if (!isPlainObject(layer.value)) {
      onLayerError(layer.source, ["policy must be a JSON object"]);
      continue;
    }
    const next = deepMerge(merged, layer.value);
    const parsed = policySchema.safeParse(next);
    if (!parsed.success) {
      onLayerError(layer.source, issuesOf(parsed.error));
      continue;
    }
    merged = parsed.data;
  }
  return merged;
}

/** defaults → the given layers, validated layer by layer; a bad layer throws naming itself. */
export function resolvePolicy(layers: readonly PolicyLayer[]): Policy {
  const merged = mergePolicyLayers(DEFAULT_POLICY, layers, (source, issues) => {
    throw new PolicyError(source, issues);
  });
  const policy = policySchema.parse(merged);
  checkWindow(policy);
  return policy;
}

const POINT_ENABLED: Record<string, "phasePoint" | "agentPoint" | "volumePoint" | "turnsPoint" | "idlePoint" | "thrashPoint"> = {
  phase: "phasePoint",
  agent: "agentPoint",
  volume: "volumePoint",
  turns: "turnsPoint",
  idle: "idlePoint",
  thrash: "thrashPoint",
};
const POINT_VALUE: Record<string, "volumeBytes" | "turnsBetween" | "idleSeconds"> = {
  volume: "volumeBytes",
  turns: "turnsBetween",
  idle: "idleSeconds",
};

/**
 * The settings layer: map the flat UI settings onto the policy. Window, vetoes and composer are
 * straightforward; the point toggles and thresholds patch the built-in points by id, so a custom
 * point from `policy.json` passes through untouched.
 */
export function applySettings(policy: Policy, settings: PressSettings): Policy {
  const next: Policy = {
    ...policy,
    mode: settings.mode,
    window: {
      ...policy.window,
      softPercent: settings.softPercent,
      hardPercent: settings.hardPercent,
      floorTokens: settings.floorTokens,
    },
    points: policy.points.map((point) => {
      const enabledKey = POINT_ENABLED[point.id];
      const valueKey = POINT_VALUE[point.id];
      if (enabledKey === undefined && valueKey === undefined) return point;
      return {
        ...point,
        ...(enabledKey !== undefined ? { enabled: settings[enabledKey] } : {}),
        ...(valueKey !== undefined ? { value: settings[valueKey] } : {}),
      };
    }),
    vetoes: { ...policy.vetoes, cooldownSeconds: settings.cooldownSeconds, minTurnsBetween: settings.minTurnsBetween },
    composer: {
      ...policy.composer,
      model: settings.composerModel === "" ? null : settings.composerModel,
      maxSummaryTokens: settings.maxSummaryTokens,
    },
  };
  const parsed = policySchema.safeParse(next);
  if (!parsed.success) throw new PolicyError("settings", issuesOf(parsed.error));
  checkWindow(parsed.data);
  return parsed.data;
}

/**
 * The whole resolution order:
 * built-in defaults → dataDir `policy.json` → workspace `policy.json` → settings (the UI) →
 * per-thread override. The settings win over the files for everything the UI covers, so a stale
 * committed file cannot silently override what the user set in the UI; `policy.json` still owns
 * what the UI cannot express (signal arrays, per-provider switches, custom points). The per-thread
 * override still wins over everything. A bad file or override layer is skipped via the reporter;
 * the settings are trusted (their schema already validated them at write time).
 */
export function resolvePressPolicy(
  fileLayers: readonly PolicyLayer[],
  settings: PressSettings,
  override: PolicyLayer | null,
  onLayerError?: LayerErrorReporter,
): Policy {
  const skip: LayerErrorReporter = onLayerError ?? (() => undefined);
  let policy = applySettings(mergePolicyLayers(DEFAULT_POLICY, fileLayers, skip) as Policy, settings);
  if (override !== null && override.value !== null && override.value !== undefined) {
    policy = policySchema.parse(mergePolicyLayers(policy, [override], skip)) as Policy;
    checkWindow(policy);
    const overrides = policy.pointOverrides;
    if (overrides !== undefined) {
      const points = policy.points.map((point) => ({ ...point, enabled: overrides[point.id as PointId] ?? point.enabled }));
      for (const point of applySettings(DEFAULT_POLICY, settings).points) {
        if (overrides[point.id as PointId] === true && !points.some((current) => current.id === point.id)) {
          points.push({ ...point, enabled: true });
        }
      }
      policy = { ...policy, points };
    }
  }
  return policy;
}

export class PolicyError extends Error {
  constructor(source: string, issues: readonly string[]) {
    super(`press policy ${source}: ${issues.join("; ")}`);
    this.name = "PolicyError";
  }
}

export function formatIssues(error: unknown): string {
  return error instanceof PolicyError ? error.message : String(error);
}