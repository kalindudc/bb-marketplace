import { z } from "zod";
import type { TavernRuntime } from "../runtime";
import type { PlacementPolicyRead } from "../../shared/placement-settings";
import { discoverPlacementCatalog } from "./catalog";
import { explicitRuleMatch } from "./match";
import { resolvePlacementRoute, type PlacementRoute } from "./routing";
import { readSourceIdentity } from "./source-discovery";
import { normalizeRemote } from "../../scope/remote";
import { DEFAULT_SETTINGS } from "../../shared/settings";

export const placementPickSchema = z.union([
  z.object({ ruleId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("current") }).strict(),
]);
export type PlacementPick = z.infer<typeof placementPickSchema>;

export async function repoPlacements(runtime: TavernRuntime, keeperThreadId: string, projectId: string, classId: string, questId: string | null = null) {
  runtime.keeper.require(keeperThreadId, "keeper");
  const hostId = (await runtime.bb.sdk.system.config()).primaryHostId;
  if (!hostId) throw new Error("The server has no primary host configured.");
  const ownRepo = runtime.keeper.store.runtime(keeperThreadId).projectId === projectId;
  const policy: PlacementPolicyRead = runtime.settings?.placementPolicy() ?? { state: "valid", revision: 0, settings: DEFAULT_SETTINGS.machines };
  let source: ReturnType<ReturnType<TavernRuntime["placementSources"]>["inspect"]> | undefined;
  let identity: ReturnType<typeof readSourceIdentity> | undefined;
  const deps = {
    readIdentity: () => identity ??= readSourceIdentity(runtime.bb, keeperThreadId, projectId),
    inspectSource: () => source ??= runtime.placementSources().inspect(keeperThreadId, projectId),
  };
  const context = { keeperThreadId, projectId, classId, questId };
  const route = await resolvePlacementRoute(policy, context, deps);
  const [catalog, project] = await Promise.all([discoverPlacementCatalog(runtime.bb, { projectId, hostId }), runtime.bb.sdk.projects.get({ projectId })]);
  const choices: PlacementRoute[] = [];
  if (policy.state === "valid") for (const rule of policy.settings.rules) {
    if (!rule.enabled) continue;
    const candidate = await resolvePlacementRoute({ ...policy, settings: { ...policy.settings, rules: [rule] } }, context, deps);
    if (candidate.match.state !== "matched") continue;
    const target = rule.target;
    if (target.kind === "current" ? !ownRepo : target.machine.type !== "new" || target.workspace !== "dedicated-machine") continue;
    choices.push(candidate);
  }
  const remote = project.gitRemoteUrl ? normalizeRemote(project.gitRemoteUrl) : null;
  const past = remote === null ? [] : runtime.keeper.store.all("placementPicks").filter(pick => pick.remote === remote).sort((a, b) => b.at - a.at).slice(0, 3);
  const lines = [`Repo ${projectId}; environment providers bb offers on ${hostId} (information only; pick a rule below):`];
  for (const provider of catalog.hostEnvironments) lines.push(`- ${provider.displayName} (${provider.id}); inputs schema: ${JSON.stringify(provider.inputs)}; availability: ${provider.availability?.status ?? "unknown"}.`);
  lines.push("New machine per thread (information only; consent and inputs come from a rule):");
  for (const provider of catalog.newMachineEnvironments) {
    if (provider.inputs === null || ["unavailable", "setup-required"].includes(provider.availability?.status ?? "")) continue;
    for (const machine of catalog.machines) {
      if (provider.machineProviderId !== null && provider.machineProviderId !== machine.id) continue;
      lines.push(`- ${provider.id} on ${machine.id}; environment inputs schema: ${JSON.stringify(provider.inputs)}; machine inputs schema: ${JSON.stringify(machine.inputs)}.`);
    }
  }
  for (const pick of past) lines.push(`Earlier picks for this remote: rule ${pick.ruleId} (${choices.some(choice => choice.match.state === "matched" && choice.match.rule.id === pick.ruleId) ? "currently offered" : "not currently offered"}); repo ${pick.projectId}.`);
  lines.push("Placement choices for this repo and class:");
  if (ownRepo) lines.push('- placement={"kind":"current"}; where the Keeper runs.');
  for (const choice of choices) if (choice.match.state === "matched") {
    const rule = choice.match.rule;
    lines.push(`- placement=${JSON.stringify({ ruleId: rule.id })}; ${rule.label}; ${rule.target.kind === "current" ? "where the Keeper runs" : "consent accepted"}; rule target ${JSON.stringify(rule.target)}. All inputs, models and forge come from this rule.`);
  }
  lines.push(policy.state === "invalid" ? "No recommendation: repair the invalid placement policy in Settings, Where work runs."
    : classId === "keeper" ? "Lead default: where the hiring Keeper runs; choose a matching rule explicitly to run elsewhere."
    : route.match.state === "matched" ? `Recommendation: rule ${route.match.rule.label} (${route.match.rule.id}); target ${JSON.stringify(route.match.rule.target)}.`
    : "No matching rule: only the Keeper's own repo may stay where the Keeper runs.");
  return { catalog, route, policy, choices, past, ownRepo, text: lines.join("\n") };
}

export async function pickedRoute(runtime: TavernRuntime, keeperThreadId: string, projectId: string, classId: string, questId: string | null, pick: PlacementPick): Promise<PlacementRoute | null> {
  const choices = await repoPlacements(runtime, keeperThreadId, projectId, classId, questId);
  if (choices.policy.state !== "valid") throw new Error("Repair machine placement in Settings before hiring.");
  if ("kind" in pick) {
    if (!choices.ownRepo) throw new Error(`Repo ${projectId} cannot run where the Keeper runs.`);
    return null;
  }
  const route = choices.choices.find(choice => choice.match.state === "matched" && choice.match.rule.id === pick.ruleId);
  if (!route) throw new Error(`Rule ${pick.ruleId} is not offered for this repo and class.\n${choices.text}`);
  return { ...route, match: explicitRuleMatch(choices.policy, pick.ruleId, route.facts) };
}
