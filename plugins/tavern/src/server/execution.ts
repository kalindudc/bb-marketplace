import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ClassDef } from "../shared/schema";

type Providers = BbPluginApi["sdk"]["providers"];
type Provider = Awaited<ReturnType<Providers["list"]>>[number];
type Catalog = Awaited<ReturnType<Providers["models"]>>;
type Permission = NonNullable<ClassDef["permission"]>;
const permissions: Permission[] = ["accept-edits", "auto", "full"];
const reasoningOrder = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];

function reasoningRank(level: string) {
  return reasoningOrder.indexOf(level === "ultracode" ? "xhigh" : level);
}
function permissionFor(requested: Permission, modes: Permission[]) {
  const supported = permissions.filter((mode) => modes.includes(mode));
  return (
    supported.find((mode) => permissions.indexOf(mode) >= permissions.indexOf(requested)) ??
    supported.at(-1)
  );
}
function reasoningFor(requested: string, supported: string[], defaultLevel: string) {
  if (supported.includes(requested)) return requested;
  const fallback = supported.includes(defaultLevel) ? defaultLevel : supported[0];
  const rank = reasoningRank(requested);
  if (rank < 0) return fallback;
  const ranked = supported
    .map((level) => ({ level, rank: reasoningRank(level) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  return (ranked.find((candidate) => candidate.rank >= rank) ?? ranked.at(-1))?.level ?? fallback;
}

export function modelFamily(providerId: string | null, model: string | null, metadata?: Catalog["models"][number]) {
  const vendors: [string, RegExp][] = [
    ["anthropic", /(?:^|[^a-z0-9])(?:anthropic|claude)(?:[^a-z0-9]|$)/i],
    ["openai", /(?:^|[^a-z0-9])(?:openai|gpt|codex|o[134])(?:[^a-z]|$)/i],
    ["google", /(?:^|[^a-z0-9])(?:google|gemini|gemma)(?:[^a-z0-9]|$)/i],
    ["meta", /(?:^|[^a-z0-9])(?:meta|llama)(?:[^a-z0-9]|$)/i],
    ["mistral", /(?:^|[^a-z0-9])(?:mistral|mixtral|codestral|devstral)(?:[^a-z0-9]|$)/i],
    ["deepseek", /(?:^|[^a-z0-9])deepseek(?:[^a-z0-9]|$)/i],
    ["xai", /(?:^|[^a-z0-9])(?:xai|grok)(?:[^a-z0-9]|$)/i],
    ["alibaba", /(?:^|[^a-z0-9])(?:alibaba|qwen)(?:[^a-z0-9]|$)/i],
    ["moonshot", /(?:^|[^a-z0-9])(?:moonshot|kimi)(?:[^a-z0-9]|$)/i],
    ["cohere", /(?:^|[^a-z0-9])(?:cohere|command-r)(?:[^a-z0-9]|$)/i],
    ["zhipu", /(?:^|[^a-z0-9])(?:zhipu|glm)(?:[^a-z0-9]|$)/i],
    ["minimax", /(?:^|[^a-z0-9])minimax(?:[^a-z0-9]|$)/i],
  ];
  for (const evidence of [
    metadata ? [metadata.routeProviderId, metadata.displayName, metadata.id].join(" ") : "",
    [providerId, model].join(" "),
  ]) {
    const families = vendors.filter(([, pattern]) => pattern.test(evidence));
    if (families.length) return families.length === 1 ? families[0]![0] : null;
  }
  return null;
}

export interface HireExecution {
  providerId: string;
  model?: string;
  reasoningLevel?: string;
  permissionMode?: Permission;
  notes: string[];
  checkIndependence?: "independent" | "same-family" | "not-established";
}
export async function resolveHireExecution(
  bb: BbPluginApi,
  role: Pick<ClassDef, "id" | "provider" | "model" | "reasoning" | "permission">,
  parent: {
    providerId: string;
    environmentId: string | null;
    projectId: string;
    scoped?: boolean;
    dryRun?: boolean;
    modelRuleId?: string;
    onModelResolved?: (model: Pick<Catalog["models"][number], "model" | "displayName">) => void;
    maker?: { providerId: string | null; model: string | null; environmentId: string | null };
  },
): Promise<HireExecution> {
  const requestedProviderId = role.provider ?? parent.providerId;
  let providerId = requestedProviderId;
  const routing = parent.environmentId ? { environmentId: parent.environmentId } : {};
  const notes: string[] = [];
  let providers: Provider[] = [];
  let catalog: Catalog | null = null;
  try {
    providers = await bb.sdk.providers.list(routing);
  } catch (error) {
    notes.push(`Provider declaration lookup failed: ${String(error).slice(0, 300)}.`);
  }
  try {
    catalog = await bb.sdk.providers.models({
      providerId,
      ...(parent.environmentId ? routing : { projectId: parent.projectId }),
    });
    if (catalog.modelLoadError) {
      const { code, detail } = catalog.modelLoadError;
      notes.push(
        `Model discovery reported ${code}: ${detail ?? "no detail"}; ` +
          "using the advertised catalog where available.",
      );
    }
  } catch (error) {
    notes.push(
      `Model catalog lookup failed: ${String(error).slice(0, 300)}; ` +
        "using provider defaults for model and reasoning.",
    );
  }
  const wantedModel = role.model
    ? catalog?.models.find(candidate => candidate.model === role.model || candidate.id === role.model)?.model ?? role.model
    : catalog?.models.find(candidate => candidate.isDefault)?.model;
  if (parent.scoped && providerId !== "pi" && wantedModel) {
    const pi = providers.find(candidate => candidate.id === "pi" && candidate.available);
    if (pi) {
      try {
        const guarded = await bb.sdk.providers.models({ providerId: "pi", ...(parent.environmentId ? routing : { projectId: parent.projectId }) });
        if (guarded.models.some(candidate => candidate.model === wantedModel || candidate.id === role.model)) {
          providerId = "pi";
          catalog = guarded;
          notes.push(`provider ${requestedProviderId} -> pi (Pi offers ${wantedModel} and Tavern can block commands before they run).`);
        }
      } catch (error) {
        notes.push(`Pi model lookup failed: ${String(error).slice(0, 300)}.`);
      }
    }
  }
  const provider =
    providers.find((candidate) => candidate.id === providerId) ??
    catalog?.providers.find((candidate) => candidate.id === providerId);
  const result: HireExecution = { providerId, notes };
  if (role.permission) {
    const mode = provider
      ? permissionFor(role.permission, provider.capabilities.permissionModes)
      : undefined;
    if (mode) result.permissionMode = mode;
    if (mode !== role.permission) {
      const reason = mode ? `supported by ${providerId}` : "no supported mode could be established";
      notes.push(`permission ${role.permission} -> ${mode ?? "provider default"} (${reason}).`);
    }
  }
  const models = catalog?.models ?? [];
  const requestedModel = role.model
    ? models.find(candidate => candidate.model === role.model) ?? models.find(candidate => candidate.id === role.model) ?? (providerId !== requestedProviderId ? models.find(candidate => candidate.model === wantedModel) : undefined)
    : undefined;
  if (role.model && !requestedModel) {
    const source = parent.modelRuleId ? `rule ${parent.modelRuleId} model` : "class model";
    const setting = parent.modelRuleId ? `the ${role.id} model on rule ${parent.modelRuleId} in Settings, Where work runs,` : `classes.${role.id}.model in Tavern settings`;
    throw new Error(`Cannot hire ${role.id}: ${source} ${role.model} is not offered or could not be verified on ${providerId}. Change ${setting} to an available model. No model substitution was made.`);
  }
  const defaultModel = models.find((candidate) => candidate.isDefault);
  let selected = role.model || role.reasoning || parent.scoped
    ? requestedModel ?? (providerId !== requestedProviderId ? models.find(candidate => candidate.model === wantedModel) : defaultModel)
    : undefined;
  if (role.id === "warden") {
    const maker = parent.maker;
    let metadata = maker?.model ? models.find(candidate => candidate.model === maker.model) : undefined;
    if (maker?.providerId && maker.model && !metadata && maker.providerId !== providerId) {
      try {
        const ownerCatalog = await bb.sdk.providers.models({
          providerId: maker.providerId,
          ...(maker.environmentId ? { environmentId: maker.environmentId } : { projectId: parent.projectId }),
        });
        metadata = [...ownerCatalog.models, ...ownerCatalog.selectedOnlyModels].find(candidate => candidate.model === maker.model);
      } catch (error) {
        notes.push(`Maker model metadata lookup failed: ${String(error).slice(0, 300)}.`);
      }
    }
    const ownerFamily = modelFamily(maker?.providerId ?? null, maker?.model ?? null, metadata);
    const independent = ownerFamily ? models.filter(candidate => {
      if (maker?.model && candidate.model === maker.model) return false;
      const family = modelFamily(providerId, candidate.model, candidate);
      return family !== null && family !== ownerFamily;
    }) : [];
    const configuredDifferent = requestedModel !== undefined && ownerFamily !== null && independent.includes(requestedModel);
    const alternative = independent.find(candidate => candidate === requestedModel) ?? independent.find(candidate => candidate.isDefault) ?? independent[0];
    if (alternative) {
      selected = alternative;
      result.checkIndependence = "independent";
      notes.push(configuredDifferent
        ? `Kept the configured checker model ${alternative.model}: already a different family from maker ${maker!.model ?? maker!.providerId}.`
        : `Independent checker model ${alternative.model}: different family from maker ${maker!.model ?? maker!.providerId}; the configured class model ${role.model ?? "provider default"} was replaced to keep the check independent.`);
    } else {
      const checkerFamily = selected ? modelFamily(providerId, selected.model, selected) : null;
      result.checkIndependence = ownerFamily && checkerFamily === ownerFamily ? "same-family" : "not-established";
      const label = result.checkIndependence === "same-family" ? "same-family check (not independent)" : "check independence not established";
      notes.push(`${label}: no provably different-family model${ownerFamily ? " is advertised" : "; the maker family is unknown"}; using the class model ${role.model ?? "provider default"}.`);
    }
  }
  if (parent.scoped && !selected)
    throw new Error(`Cannot hire ${role.id}: the provider default model could not be verified. Set classes.${role.id}.model in Tavern settings to an available model. No member was hired.`);
  if (selected) {
    result.model = selected.model;
    parent.onModelResolved?.(selected);
  }
  if (role.model && result.model !== role.model) {
    const reason = result.model
      ? result.checkIndependence === "independent" && requestedModel
        ? "independent checker selection"
        : "advertised model alias"
      : "catalog has no advertised default";
    notes.push(`model ${role.model} -> ${result.model ?? "provider default"} (${reason}).`);
  }
  if (selected) {
    const supported = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort);
    const requested = role.reasoning ?? selected.defaultReasoningEffort;
    const level = reasoningFor(requested, supported, selected.defaultReasoningEffort);
    if (level) result.reasoningLevel = level;
    if (role.reasoning && level !== role.reasoning) {
      notes.push(
        `reasoning ${role.reasoning} -> ${level ?? "provider default"} ` +
          `(supported levels for ${selected.model}: ${supported.join(", ") || "not advertised"}).`,
      );
    }
  } else if (role.reasoning) {
    notes.push(
      `reasoning ${role.reasoning} -> provider default ` +
        "(the target model's supported levels could not be established).",
    );
  }
  if (!parent.dryRun) for (const note of notes) bb.log.warn(`Tavern hire ${providerId}: ${note}`);
  return result;
}
