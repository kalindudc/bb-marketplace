import { z } from "zod";
import { parseSummaryModel } from "../composer/src/model-spec.ts";
import { PHASE_SIGNALS } from "./snapshot";

export const POINT_IDS = ["phase", "agent", "volume", "turns", "idle", "thrash"] as const;
export const pointIdSchema = z.enum(POINT_IDS);
export const modeSchema = z.enum(["observe", "advisor", "auto"]);
export type PointId = z.infer<typeof pointIdSchema>;

const boundarySignals = new Set<string>([...Object.values(PHASE_SIGNALS), "agentHint"]);
/** Boundary names an earlier release accepted and no longer emits: dropped with a warning, not rejected. */
const RETIRED_BOUNDARY_SIGNALS = new Set<string>(["journal.entry.done"]);
const signalMetrics = {
  sameFileRead: "sameFileReadMax",
  sameCommandFailed: "sameCommandFailedMax",
  subagentReportBytes: "subagentReportBytes",
  toolResultBytes: "toolResultBytes",
} as const;
const signalExpression = /^\s*([a-zA-Z]+)\s*(>=|<=|>|<|==)\s*(\d+(?:\.\d+)?)\s*$/;

export function parseSignalExpression(expression: string) {
  const match = signalExpression.exec(expression);
  if (match === null || !Object.hasOwn(signalMetrics, match[1])) return null;
  const [, name, operator, raw] = match;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return { metric: signalMetrics[name as keyof typeof signalMetrics], operator, value };
}

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
  .loose()
  .superRefine((point, ctx) => {
    point.signals?.forEach((signal, index) => {
      const message = point.when === "boundary" && !boundarySignals.has(signal)
        ? `Unknown boundary signal: ${signal}`
        : point.when === "signal" && parseSignalExpression(signal) === null
          ? `Invalid signal expression: ${signal}`
          : null;
      if (message !== null) ctx.addIssue({ code: "custom", path: ["signals", index], message });
    });
  });

export const vetoSchema = z
  .object({
    midTurn: z.boolean().default(true),
    cooldownSeconds: z.number().min(0).default(600),
    minTurnsBetween: z.number().min(0).default(2),
    belowFloor: z.boolean().default(true),
    previousCompactionFailed: z.boolean().default(true),
  })
  .loose();

export const composerSchema = z
  .object({
    model: z
      .string()
      .nullable()
      .default(null)
      .refine((model) => model === null || parseSummaryModel(model) !== null, { message: "Expected provider/modelId, or null for the thread's own model" }),
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
    mode: modeSchema.default("auto"),
    pointOverrides: z.partialRecord(pointIdSchema, z.boolean()).optional(),
    window: z
      .object({
        softPercent: z.number().min(1).max(100).default(55),
        hardPercent: z.number().min(1).max(100).default(80),
        floorTokens: z.number().int().min(0).default(150_000),
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
  mode: "auto",
  window: { softPercent: 55, hardPercent: 80, floorTokens: 150_000 },
  points: [
    { id: "phase", enabled: true, when: "boundary", signals: Object.values(PHASE_SIGNALS) },
    { id: "agent", enabled: true, when: "agentHint" },
    { id: "volume", enabled: true, when: "toolResultBytes", value: 1_500_000 },
    { id: "turns", enabled: false, when: "turnsSinceCompaction", value: 60 },
    { id: "idle", enabled: false, when: "idleSeconds", value: 300, minPercent: 25 },
    { id: "thrash", enabled: false, when: "signal", signals: ["sameFileRead>=3", "sameCommandFailed>=2", "subagentReportBytes>40000"] },
  ],
  vetoes: { midTurn: true, cooldownSeconds: 600, minTurnsBetween: 2, belowFloor: true, previousCompactionFailed: true },
  composer: { model: null, keepRecentTurns: 6, maxSummaryTokens: 3000, ledger: true, resumeContract: true },
  providers: { pi: { enabled: true } },
};

/** One layer of the resolution order, with a name for error messages. */
export interface PolicyLayer {
  source: string;
  value: unknown;
}

/** Report a layer rejected by validation or used with a clamped soft threshold. */
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

export function clampSoftPercent(softPercent: number, hardPercent: number, source: string, report?: LayerErrorReporter): number {
  if (softPercent <= hardPercent) return softPercent;
  report?.(source, [`window.softPercent (${softPercent}) exceeds window.hardPercent (${hardPercent}); using ${hardPercent} for softPercent`]);
  return hardPercent;
}

function clampWindow(policy: Policy, source: string, report?: LayerErrorReporter): Policy {
  const { softPercent, hardPercent } = policy.window;
  const effectiveSoftPercent = clampSoftPercent(softPercent, hardPercent, source, report);
  return effectiveSoftPercent === softPercent ? policy : { ...policy, window: { ...policy.window, softPercent: effectiveSoftPercent } };
}

/** Drop retired boundary names from a layer's points, so a file written for an earlier release still loads. */
function withoutRetiredSignals(layer: Record<string, unknown>): { value: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  if (!Array.isArray(layer.points)) return { value: layer, dropped };
  const points = layer.points.map((point: unknown, index) => {
    if (!isPlainObject(point) || point.when !== "boundary" || !Array.isArray(point.signals)) return point;
    const signals = point.signals.filter((signal: unknown) => {
      if (typeof signal !== "string" || !RETIRED_BOUNDARY_SIGNALS.has(signal)) return true;
      dropped.push(`points.${index}.signals: ${signal} is a retired boundary signal; dropped`);
      return false;
    });
    return signals.length === point.signals.length ? point : { ...point, signals };
  });
  return { value: dropped.length > 0 ? { ...layer, points } : layer, dropped };
}

function mergePolicyLayers(
  base: Policy,
  layers: readonly PolicyLayer[],
  onLayerError: LayerErrorReporter,
  onWarning?: LayerErrorReporter,
): Policy {
  let merged = base;
  let windowSource = "resolved policy";
  for (const layer of layers) {
    if (layer.value === null || layer.value === undefined) continue;
    if (!isPlainObject(layer.value)) {
      onLayerError(layer.source, ["policy must be a JSON object"]);
      continue;
    }
    const { value, dropped } = withoutRetiredSignals(layer.value);
    if (dropped.length > 0) onWarning?.(layer.source, dropped);
    const next = deepMerge(merged, value);
    const parsed = policySchema.safeParse(next);
    if (!parsed.success) {
      onLayerError(layer.source, issuesOf(parsed.error));
      continue;
    }
    const { softPercent, hardPercent } = parsed.data.window;
    if (softPercent !== merged.window.softPercent || hardPercent !== merged.window.hardPercent) {
      windowSource = layer.source;
    }
    merged = parsed.data;
  }
  return clampWindow(merged, windowSource, onWarning);
}

/** defaults → the given layers, validated layer by layer; a bad layer throws naming itself. */
export function resolvePolicy(layers: readonly PolicyLayer[], onWarning?: LayerErrorReporter): Policy {
  const merged = mergePolicyLayers(DEFAULT_POLICY, layers, (source, issues) => {
    throw new PolicyError(source, issues);
  }, onWarning);
  return policySchema.parse(merged);
}

// A file still owns its points array: settings only patch the known entries that are present,
// which `settingsOwnedPaths` reports as `points[<id>].enabled` and `points[<id>].value`.
export const SETTINGS_OWNED_PATHS: readonly string[] = [
  "mode",
  "window.softPercent",
  "window.hardPercent",
  "window.floorTokens",
  "vetoes.cooldownSeconds",
  "vetoes.minTurnsBetween",
  "composer.model",
  "composer.maxSummaryTokens",
];
const settingsPathSegments = SETTINGS_OWNED_PATHS.map((path) => path.split("."));

export function settingsOwnedPaths(layer: unknown): string[] {
  const owned = SETTINGS_OWNED_PATHS.filter((_, index) =>
    settingsPathSegments[index].reduce<unknown>(
      (value, key) => isPlainObject(value) && Object.hasOwn(value, key) ? value[key] : undefined,
      layer,
    ) !== undefined,
  );
  const points = isPlainObject(layer) && Object.hasOwn(layer, "points") && Array.isArray(layer.points) ? layer.points : [];
  for (const point of points) {
    if (!isPlainObject(point) || typeof point.id !== "string" || !Object.hasOwn(POINT_ENABLED, point.id)) continue;
    if (point.enabled !== undefined) owned.push(`points[${point.id}].enabled`);
    if (point.value !== undefined && Object.hasOwn(POINT_VALUE, point.id)) owned.push(`points[${point.id}].value`);
  }
  return owned;
}

const SETTINGS_KEY: Record<string, keyof PressSettings> = {
  mode: "mode",
  "window.softPercent": "softPercent",
  "window.hardPercent": "hardPercent",
  "window.floorTokens": "floorTokens",
  "vetoes.cooldownSeconds": "cooldownSeconds",
  "vetoes.minTurnsBetween": "minTurnsBetween",
  "composer.model": "composerModel",
  "composer.maxSummaryTokens": "maxSummaryTokens",
};

/** The plugin setting that owns a path `settingsOwnedPaths` reported. */
export function settingsKeyOf(path: string): keyof PressSettings {
  const point = /^points\[(.+)\]\.(enabled|value)$/.exec(path);
  const key = point === null ? SETTINGS_KEY[path] : point[2] === "enabled" ? POINT_ENABLED[point[1]] : POINT_VALUE[point[1]];
  if (key === undefined) throw new Error(`No setting owns ${path}`);
  return key;
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
export function applySettings(policy: Policy, settings: PressSettings, onWindowClamp?: LayerErrorReporter): Policy {
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
  return clampWindow(parsed.data, "settings", onWindowClamp);
}

/**
 * The whole resolution order:
 * built-in defaults → dataDir `policy.json` → workspace `policy.json` → settings (the UI) →
 * per-thread override. The settings win over the files for everything the UI covers, so a stale
 * committed file cannot silently override what the user set in the UI; `policy.json` still owns
 * what the UI cannot express (signal arrays, per-provider switches, custom points). The per-thread
 * override still wins over everything. A bad file or override layer is skipped via the reporter.
 * A soft threshold above the hard threshold is clamped instead of rejecting the layer.
 */
export function resolvePressPolicy(
  fileLayers: readonly PolicyLayer[],
  settings: PressSettings,
  override: PolicyLayer | null,
  onLayerError?: LayerErrorReporter,
): Policy {
  const report: LayerErrorReporter = onLayerError ?? (() => undefined);
  let policy = applySettings(mergePolicyLayers(DEFAULT_POLICY, fileLayers, report, report), settings, report);
  if (override !== null && override.value !== null && override.value !== undefined) {
    policy = mergePolicyLayers(policy, [override], report, report);
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