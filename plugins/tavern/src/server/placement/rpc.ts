import type { BbPluginApi, ExperimentalPluginRpcHandlerContext, ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import { placementContract, type PlacementCatalogView, type PlacementPreview, type PlacementPreviewInput, type PlacementWarning } from "../../shared/placement-rpc";
import { tags } from "../../shared/contract";
import { POSTURE } from "../../shared/placement-view";
import { DEFAULT_SETTINGS } from "../../shared/settings";
import type { PlacementPolicyRead, PlacementRule } from "../../shared/placement-settings";
import { normalizeRemote } from "../../scope/remote";
import type { TavernRuntime } from "../runtime";
import { requireUserAct, type OptionalRpcContext } from "../authority";
import { discoverPlacementCatalog } from "./catalog";
import { evidenceFor, matchPlacementRule, type PlacementFacts } from "./match";
import { readSourceIdentity } from "./source-discovery";
import { PlacementStore } from "./store";

type Project = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["get"]>>;
const compatibilityPosture = "Today's placement and guard rules apply; this preview does not establish an execution posture.";

function defaultSource(project: Project) {
  const defaults = project.sources.filter(source => source.isDefault);
  return defaults.length === 1 ? defaults[0] : project.sources.length === 1 ? project.sources[0] : null;
}
function projectRemotes(project: Project): string[] {
  return project.gitRemoteUrl === null ? [] : [normalizeRemote(project.gitRemoteUrl)];
}
function explains(policy: PlacementPolicyRead, facts: PlacementFacts): PlacementPreview["steps"] {
  if (policy.state === "invalid") return [];
  let reached = false;
  return policy.settings.rules.map(rule => {
    if (!rule.enabled) return { ruleId: rule.id, outcome: "off", miss: null };
    if (reached) return { ruleId: rule.id, outcome: "unreached", miss: null };
    for (const [field, patterns] of Object.entries(rule.match)) {
      if (evidenceFor({ ...rule, match: { [field]: patterns } }, facts) !== null) continue;
      const values: Record<string, string | null> = {
        projectIds: facts.projectId, classes: facts.classId, questIds: facts.questId,
        keeperEnvironmentProviders: facts.keeperEnvironmentProvider, keeperPathGlobs: facts.keeperPath,
        repoRemotes: facts.repoRemotes === null ? null : `${facts.repoRemotes.length} known remote(s); none matched`,
      };
      return { ruleId: rule.id, outcome: "miss", miss: { field, value: values[field], pattern: patterns.join(" or ") } };
    }
    reached = true;
    return { ruleId: rule.id, outcome: "matched", miss: null };
  });
}
function relevantRules(policy: PlacementPolicyRead, input: PlacementPreviewInput): PlacementRule[] {
  if (policy.state === "invalid") return [];
  return policy.settings.rules.filter(rule => {
    const known: Array<[string[] | undefined, string | null]> = [
      [rule.match.projectIds, input.projectId], [rule.match.classes, input.classId], [rule.match.questIds, input.questId],
    ];
    return rule.enabled && known.every(([patterns, value]) => patterns === undefined || value !== null && patterns.includes(value));
  });
}

async function previewFacts(runtime: TavernRuntime, policy: PlacementPolicyRead, input: PlacementPreviewInput, signal?: AbortSignal) {
  const facts: PlacementFacts = {
    projectId: input.projectId, classId: input.classId, questId: input.questId,
    repoRemotes: null, keeperPath: input.keeperPath, keeperHome: null, keeperEnvironmentProvider: null,
  };
  const warnings: PlacementWarning[] = [];
  const rules = relevantRules(policy, input);
  if (!rules.length) return { facts, warnings };
  const options = signal === undefined ? {} : { signal };
  if (input.keeperThreadId === null) {
    warnings.push({ code: "no-keeper", text: "Without a Keeper, project metadata and the optional path are hypothetical, not admission proof." });
    if (input.projectId !== null) {
      const project = await runtime.bb.sdk.projects.get({ projectId: input.projectId, ...options });
      signal?.throwIfAborted();
      if (project.id !== input.projectId) throw new Error("Project metadata changed while previewing; retry.");
      facts.keeperPath ??= defaultSource(project)?.path ?? null;
      facts.repoRemotes = projectRemotes(project);
    }
    return { facts, warnings };
  }
  if (input.projectId === null) throw new Error("Choose a project when previewing a Keeper.");
  const member = runtime.keeper.member(input.keeperThreadId);
  if (member?.role !== "keeper" || runtime.keeper.store.runtime(member.threadId).projectId !== input.projectId)
    throw new Error("Choose a Keeper in this project.");
  const inspectionNeeded = rules.some(rule => rule.match.repoRemotes !== undefined ||
    rule.match.keeperPathGlobs !== undefined && (input.keeperPath === null || rule.match.keeperPathGlobs.some(pattern => /^~(?:\/|$)/.test(pattern))));
  if (inspectionNeeded) {
    const source = await runtime.placementSources().inspect(input.keeperThreadId, input.projectId, signal);
    signal?.throwIfAborted();
    if (source.state === "known") {
      facts.keeperPath ??= source.endpoint.root;
      facts.keeperHome = source.inspection.home;
      facts.keeperEnvironmentProvider = source.environmentProviderId;
      if (source.inspection.repoRemotes !== undefined) facts.repoRemotes = source.inspection.repoRemotes.map(normalizeRemote);
    } else {
      if (source.code === "source-changed" || source.code === "cancelled") throw new Error(source.message);
      warnings.push({ code: "source-unreadable", text: source.message });
    }
  } else if (rules.some(rule => rule.match.keeperEnvironmentProviders !== undefined)) {
    try {
      const identity = await readSourceIdentity(runtime.bb, input.keeperThreadId, input.projectId, signal);
      facts.keeperEnvironmentProvider = identity.environmentProviderId;
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push({ code: "identity-unreadable", text: error instanceof Error ? error.message : String(error) });
    }
  }
  return { facts, warnings };
}

async function catalog(runtime: TavernRuntime, input: { projectId?: string; hostId?: string }, signal?: AbortSignal): Promise<PlacementCatalogView> {
  signal?.throwIfAborted();
  const options = signal === undefined ? {} : { signal };
  const [projects, config] = await Promise.all([
    runtime.bb.sdk.projects.list({ includePersonal: true, ...options }), runtime.bb.sdk.system.config(options),
  ]);
  signal?.throwIfAborted();
  if (input.projectId !== undefined && !projects.some(project => project.id === input.projectId)) throw new Error("Choose an existing project for this catalog.");
  const projectId = input.projectId ?? projects.find(project => project.kind === "standard")?.id ?? projects[0]?.id;
  const hostId = input.hostId ?? config.primaryHostId;
  if (hostId === null) throw new Error("No primary host is configured; choose an explicit host.");
  let discovered;
  if (projectId !== undefined) discovered = await discoverPlacementCatalog(runtime.bb, { projectId, hostId, ...options });
  else {
    const [providers, machines, hosts] = await Promise.all([
      runtime.bb.sdk.environments.listProviders(options), runtime.bb.sdk.hosts.experimental_listProviders(options),
      runtime.bb.sdk.hosts.list({ includeCreating: true, ...options }),
    ]);
    discovered = { hostEnvironments: providers.filter(provider => provider.machineProviderId === null),
      compositions: providers.filter(provider => provider.machineProviderId !== null), machines, hosts };
  }
  signal?.throwIfAborted();
  const environments = [...new Map([...discovered.hostEnvironments, ...discovered.compositions].map(provider => [provider.id, provider])).values()];
  return {
    hostId,
    environments: environments.map(provider => ({
      id: provider.id, displayName: provider.displayName, description: provider.description ?? "",
      machineProviderId: provider.machineProviderId, environmentProviderId: provider.environmentProviderId ?? null,
      inputs: provider.inputs, acceptsEmptyInputs: provider.acceptsEmptyInputs,
    })),
    machines: discovered.machines.map(provider => ({ id: provider.id, displayName: provider.displayName, description: provider.description ?? "", inputs: provider.inputs, acceptsEmptyInputs: provider.acceptsEmptyInputs })),
    hosts: discovered.hosts.map(host => ({ id: host.id, name: host.name, connected: host.status === "connected" })),
    projects: projects.map(project => ({ id: project.id, name: project.name, remotes: projectRemotes(project), path: defaultSource(project)?.path ?? null })),
  };
}

async function preview(runtime: TavernRuntime, input: PlacementPreviewInput, signal?: AbortSignal): Promise<PlacementPreview> {
  signal?.throwIfAborted();
  const policy: PlacementPolicyRead = runtime.settings?.placementPolicy() ?? { state: "valid", revision: 0, settings: DEFAULT_SETTINGS.machines };
  const { facts, warnings } = await previewFacts(runtime, policy, input, signal);
  signal?.throwIfAborted();
  if ((runtime.settings?.placementPolicy().revision ?? 0) !== policy.revision) throw new Error("Machine settings changed while previewing; retry.");
  const match = matchPlacementRule(policy, facts);
  const { keeperHome: _home, ...publicFacts } = facts;
  const base = { revision: policy.revision, facts: { ...publicFacts, repoRemotes: facts.repoRemotes === null ? null : [...facts.repoRemotes] }, steps: explains(policy, facts), warnings: warnings.map(warning => warning.text), warningDetails: warnings };
  if (match.state === "blocked") return { ...base, verdict: { state: "blocked", code: match.code, problems: match.problems } };
  if (match.state === "compatibility") return { ...base, verdict: { state: "compatibility", posture: compatibilityPosture } };
  if (policy.state !== "valid") throw new Error("A matched rule requires a valid machine policy.");
  const config = runtime.config(input.questId);
  const keeperClass = runtime.snapshot().classes.find(role => role.id === (runtime.keeper.member(input.keeperThreadId ?? "")?.classId ?? "keeper"));
  const baseCeiling = keeperClass?.source === "builtin" ? config.keepers.partyMax : keeperClass?.budget?.members ?? config.keepers.partyMax;
  const partyCeiling = runtime.settings?.hasUser("keepers.partyMax") ? Math.min(baseCeiling, config.keepers.partyMax) : baseCeiling;
  if (match.rule.target.kind === "current") return { ...base, verdict: {
    state: "matched", ruleId: match.rule.id, matchEvidence: match.matchEvidence, blocked: null, posture: compatibilityPosture,
    remote: null, slot: null, slotsInUse: null, slotCap: null, partyCeiling,
  } };
  const supported = match.rule.target.machine.type === "new" && match.rule.target.workspace === "dedicated-machine";
  const slot = input.classId === "warden" ? "checker" : "maker";
  const counts = input.keeperThreadId === null ? { makers: 0, checkers: 0 } : new PlacementStore(runtime.keeper.store.db).counts(input.keeperThreadId);
  return { ...base, verdict: {
    state: "matched", ruleId: match.rule.id, matchEvidence: match.matchEvidence,
    blocked: supported ? null : { code: "unsupported-target", message: "This rule's target isn't supported in this version." },
    posture: supported ? POSTURE.remote : null, remote: supported ? true : null, slot, slotsInUse: slot === "maker" ? counts.makers : counts.checkers,
    slotCap: slot === "maker" ? policy.settings.maxMakers : policy.settings.maxCheckers, partyCeiling,
  } };
}

export function placementHandlers(runtime: TavernRuntime): OptionalRpcContext<ExperimentalPluginRpcHandlersWithContext<typeof placementContract>> {
  return {
    placementModelFailures: () => runtime.keeper.store.all("placementModelFailures"),
    placementModelFailureClear: (input, context?: ExperimentalPluginRpcHandlerContext) => { requireUserAct(context, "placementModelFailureClear"); runtime.clearPlacementModelFailure(input.id); return { ok: true }; },
    placementRetry: async (input, context?: ExperimentalPluginRpcHandlerContext) => {
      requireUserAct(context, "placementRetry");
      const { placementId, generation } = input;
      context?.experimental_signal?.throwIfAborted();
      const record = new PlacementStore(runtime.keeper.store.db).get(placementId);
      if (!record) return { ok: false, message: "This placement no longer exists." };
      if (record.generation !== generation) return { ok: false, message: "This placement changed. Refresh before retrying." };
      try {
        await runtime.placements().controller.retry(placementId, generation);
        return { ok: true, message: null };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      } finally {
        runtime.bb.rpc.experimental_invalidate([tags.room(), tags.rows(), ...(record.questId ? [tags.boardQuest(record.questId)] : []), ...(record.memberThreadId ? [tags.thread(record.memberThreadId)] : []), tags.thread(runtime.placements().store.currentKeeper(record))]);
      }
    },
    placementCatalog: (input, context?: ExperimentalPluginRpcHandlerContext) => catalog(runtime, input, context?.experimental_signal),
    placementPreview: (input, context?: ExperimentalPluginRpcHandlerContext) => preview(runtime, input, context?.experimental_signal),
  };
}
