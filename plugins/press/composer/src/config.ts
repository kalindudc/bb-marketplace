import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ComposerConfig {
  /** `provider/modelId` that writes the summary, or null for the thread's own model. */
  model: string | null;
  keepRecentTurns: number;
  maxSummaryTokens: number;
  ledger: boolean;
  resumeContract: boolean;
  enabled: boolean;
  /** Share of the summariser's window the serialised conversation may fill. */
  inputBudgetRatio: number;
}

export const DEFAULT_COMPOSER_CONFIG: ComposerConfig = {
  model: null,
  keepRecentTurns: 6,
  maxSummaryTokens: 3000,
  ledger: true,
  resumeContract: true,
  enabled: true,
  inputBudgetRatio: 0.7,
};

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_COMPOSER_CONFIG));

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function pickComposer(policy: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!policy) return {};
  const composer = policy.composer;
  const providers = policy.providers as Record<string, unknown> | undefined;
  const pi = providers?.pi as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {};
  if (composer && typeof composer === "object") {
    for (const [key, value] of Object.entries(composer as Record<string, unknown>)) {
      if (CONFIG_KEYS.has(key)) out[key] = value;
    }
  }
  if (pi && pi.enabled === false) out.enabled = false;
  return out;
}

function coerce(base: ComposerConfig, patch: Record<string, unknown>): ComposerConfig {
  const next = { ...base };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (patch.model === null || patch.model === false) next.model = null;
  else if (typeof patch.model === "string" && patch.model.includes("/")) next.model = patch.model;
  if (Number.isFinite(patch.keepRecentTurns as number) && (patch.keepRecentTurns as number) >= 0) {
    next.keepRecentTurns = Math.floor(patch.keepRecentTurns as number);
  }
  if (Number.isFinite(patch.maxSummaryTokens as number) && (patch.maxSummaryTokens as number) > 0) {
    next.maxSummaryTokens = Math.floor(patch.maxSummaryTokens as number);
  }
  if (typeof patch.ledger === "boolean") next.ledger = patch.ledger;
  if (typeof patch.resumeContract === "boolean") next.resumeContract = patch.resumeContract;
  if (Number.isFinite(patch.inputBudgetRatio as number)) {
    const ratio = patch.inputBudgetRatio as number;
    if (ratio > 0.1 && ratio <= 1) next.inputBudgetRatio = ratio;
  }
  return next;
}

/**
 * The governor resolves the policy (defaults, files, bb settings, per-thread override) and publishes
 * the composer half into the ledger, because a pi extension cannot read bb's database. That published
 * value wins over the files: it is what the user set in bb.
 */
export function applyPublishedConfig(
  config: ComposerConfig,
  published: unknown,
): ComposerConfig {
  if (!published || typeof published !== "object") return config;
  const row = published as Record<string, unknown>;
  const next = { ...config };
  if (row.model === null) next.model = null;
  else if (typeof row.model === "string" && row.model.includes("/")) next.model = row.model;
  if (Number.isFinite(row.maxSummaryTokens as number) && (row.maxSummaryTokens as number) > 0) {
    next.maxSummaryTokens = Math.floor(row.maxSummaryTokens as number);
  }
  if (typeof row.ledger === "boolean") next.ledger = row.ledger;
  if (typeof row.resumeContract === "boolean") next.resumeContract = row.resumeContract;
  return next;
}

/** defaults → <dataDir>/press/policy.json → <workspace>/.bb/press/policy.json */
export function resolveComposerConfig(
  cwd: string = process.cwd(),
  home: string = homedir(),
): ComposerConfig {
  let config = { ...DEFAULT_COMPOSER_CONFIG };
  for (const path of [join(home, ".bb", "press", "policy.json"), join(cwd, ".bb", "press", "policy.json")]) {
    const policy = readJson(path);
    config = coerce(config, pickComposer(policy));
  }
  return config;
}
