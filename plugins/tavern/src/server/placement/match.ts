import { createHash } from "node:crypto";
import type { PlacementRecord } from "../../shared/placement";
import type { PlacementPolicyRead, PlacementRule } from "../../shared/placement-settings";
import { glob } from "../../scope/paths";
import { normalizeRemote } from "../../scope/remote";

export interface PlacementFacts {
  projectId: string | null;
  repoRemotes: readonly string[] | null;
  keeperPath: string | null;
  keeperHome: string | null;
  keeperEnvironmentProvider: string | null;
  classId: string;
  questId: string | null;
}

type MatchEvidence = PlacementRecord["matchEvidence"];
export type PlacementMatch =
  | { state: "compatibility"; revision: number }
  | { state: "matched"; revision: number; rule: PlacementRule; definitionDigest: string; matchEvidence: MatchEvidence }
  | { state: "blocked"; revision: number; code: "invalid-machine-policy"; problems: Array<{ path: string; message: string }> };

function definitionDigest(rule: PlacementRule): string {
  const canonical = JSON.stringify(rule, (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function pathPattern(pattern: string, home: string | null): string | null {
  const portable = pattern.replaceAll("\\", "/");
  if (portable === "~" || portable.startsWith("~/")) {
    if (home === null) return null;
    return home.replaceAll("\\", "/").replace(/\/$/, "") + portable.slice(1);
  }
  return portable;
}

export function evidenceFor(rule: PlacementRule, facts: PlacementFacts): MatchEvidence | null {
  const evidence: MatchEvidence = [];
  const exact: Array<["projectIds" | "keeperEnvironmentProviders" | "classes" | "questIds", string | null]> = [
    ["projectIds", facts.projectId], ["keeperEnvironmentProviders", facts.keeperEnvironmentProvider],
    ["classes", facts.classId], ["questIds", facts.questId],
  ];
  for (const [field, value] of exact) {
    const patterns = rule.match[field];
    if (patterns === undefined) continue;
    if (value === null || !patterns.includes(value)) return null;
    evidence.push({ field, value, pattern: value });
  }

  if (rule.match.repoRemotes !== undefined) {
    if (facts.repoRemotes === null) return null;
    let matched = false;
    for (const pattern of rule.match.repoRemotes) {
      const canonicalPattern = normalizeRemote(pattern);
      const value = facts.repoRemotes.map(normalizeRemote).find(remote => glob(canonicalPattern, remote));
      if (value === undefined) continue;
      evidence.push({ field: "repoRemotes", value, pattern: canonicalPattern });
      matched = true;
      break;
    }
    if (!matched) return null;
  }

  if (rule.match.keeperPathGlobs !== undefined) {
    if (facts.keeperPath === null) return null;
    const value = facts.keeperPath.replaceAll("\\", "/");
    const pattern = rule.match.keeperPathGlobs.find(item => {
      const expanded = pathPattern(item, facts.keeperHome);
      return expanded !== null && glob(expanded, value);
    });
    if (pattern === undefined) return null;
    evidence.push({ field: "keeperPathGlobs", value, pattern });
  }
  return evidence;
}

export function explicitRuleMatch(policy: PlacementPolicyRead, ruleId: string, facts: PlacementFacts): PlacementMatch {
  if (policy.state === "invalid") return { state: "blocked", revision: policy.revision, code: "invalid-machine-policy", problems: policy.problems };
  const rule = policy.settings.rules.find(rule => rule.enabled && rule.id === ruleId);
  if (!rule) return { state: "compatibility", revision: policy.revision };
  const { classes: _classes, ...match } = rule.match;
  const evidence = evidenceFor({ ...rule, match }, facts);
  return evidence === null ? { state: "compatibility", revision: policy.revision }
    : { state: "matched", revision: policy.revision, rule, definitionDigest: definitionDigest(rule),
      matchEvidence: [...evidence, { field: "placementRuleId", value: rule.id, pattern: rule.id }] };
}

export function matchPlacementRule(policy: PlacementPolicyRead, facts: PlacementFacts): PlacementMatch {
  if (policy.state === "invalid") {
    return { state: "blocked", revision: policy.revision, code: "invalid-machine-policy", problems: policy.problems };
  }
  for (const rule of policy.settings.rules) {
    if (!rule.enabled) continue;
    const matchEvidence = evidenceFor(rule, facts);
    if (matchEvidence === null) continue;
    return { state: "matched", revision: policy.revision, rule, definitionDigest: definitionDigest(rule), matchEvidence };
  }
  return { state: "compatibility", revision: policy.revision };
}
