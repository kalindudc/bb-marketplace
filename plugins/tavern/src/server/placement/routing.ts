import { z } from "zod";
import type { PlacementPolicyRead, PlacementRule } from "../../shared/placement-settings";
import { normalizeRemote } from "../../scope/remote";
import { StaleDiscoveryError } from "./discovery-store";
import { matchPlacementRule, type PlacementFacts, type PlacementMatch } from "./match";
import type { KnownSource, SdkSource, SourceDiscoveryResult } from "./source-discovery";

export interface RoutingContext {
  keeperThreadId: string;
  projectId: string;
  classId: string;
  questId: string | null;
  signal?: AbortSignal;
}
export interface RoutingDeps {
  readIdentity(): Promise<SdkSource>;
  inspectSource(): Promise<SourceDiscoveryResult>;
}
export interface PlacementRoute {
  match: PlacementMatch;
  facts: PlacementFacts;
  identity: SdkSource | null;
  source: KnownSource | null;
  warnings: string[];
}
function knownMismatch(rule: PlacementRule, facts: PlacementFacts): boolean {
  const fields = [
    [rule.match.projectIds, facts.projectId], [rule.match.classes, facts.classId], [rule.match.questIds, facts.questId],
  ] as const;
  return fields.some(([values, fact]) => values !== undefined && (fact === null || !values.includes(fact)));
}

export async function resolvePlacementRoute(
  policy: PlacementPolicyRead,
  context: RoutingContext,
  deps: RoutingDeps,
): Promise<PlacementRoute> {
  context.signal?.throwIfAborted();
  const facts: PlacementFacts = {
    projectId: context.projectId, classId: context.classId, questId: context.questId,
    repoRemotes: null, keeperPath: null, keeperHome: null, keeperEnvironmentProvider: null,
  };
  let identity: SdkSource | null = null, source: KnownSource | null = null;
  let identityLoaded = false, inspected = false;
  const warnings: string[] = [];
  const result = (): PlacementRoute => ({
    match: matchPlacementRule(policy, facts), facts, identity, source, warnings: [...new Set(warnings)],
  });
  if (policy.state === "invalid") return result();
  for (const rule of policy.settings.rules) {
    if (!rule.enabled || knownMismatch(rule, facts)) continue;
    if (rule.match.keeperEnvironmentProviders !== undefined && !identityLoaded) {
      try {
        identity = await deps.readIdentity();
        facts.keeperEnvironmentProvider = identity.environmentProviderId;
      } catch (error) {
        context.signal?.throwIfAborted();
        warnings.push(error instanceof Error ? error.message : String(error));
      }
      context.signal?.throwIfAborted();
      identityLoaded = true;
    }
    if (rule.match.keeperEnvironmentProviders !== undefined &&
        (facts.keeperEnvironmentProvider === null || !rule.match.keeperEnvironmentProviders.includes(facts.keeperEnvironmentProvider))) continue;
    if ((rule.match.keeperPathGlobs !== undefined || rule.match.repoRemotes !== undefined) && !inspected) {
      const discovery = await deps.inspectSource();
      context.signal?.throwIfAborted();
      inspected = true;
      if (discovery.state === "known") {
        if (identity !== null && (identity.environmentProviderId !== discovery.environmentProviderId ||
            identity.endpoint.hostId !== discovery.endpoint.hostId || identity.endpoint.environmentId !== discovery.endpoint.environmentId))
          throw new StaleDiscoveryError("The source identity changed while matching placement rules; retry.");
        source = discovery;
        facts.keeperPath = discovery.endpoint.root;
        facts.keeperHome = discovery.inspection.home;
        facts.keeperEnvironmentProvider = discovery.environmentProviderId;
        const remotes = "repoRemotes" in discovery.inspection ? discovery.inspection.repoRemotes : undefined;
        if (remotes !== undefined) facts.repoRemotes = z.array(z.string()).parse(remotes).map(normalizeRemote);
        identityLoaded = true;
      } else {
        if (discovery.code === "source-changed" || discovery.code === "cancelled")
          throw new StaleDiscoveryError(discovery.message);
        warnings.push(discovery.message);
      }
    }
    const candidate = matchPlacementRule({ ...policy, settings: { ...policy.settings, rules: [rule] } }, facts);
    if (candidate.state === "matched") return result();
  }
  return result();
}
