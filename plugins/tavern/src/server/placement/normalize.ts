import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PlacementRule } from "../../shared/placement-settings";
import type { EnvironmentProviderInfo, MachineProviderInfo } from "./catalog";
import { validatePlacementInputs, type PlacementSubstitutions } from "./inputs";

type SpawnEnvironment = NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"]>;
type ProviderEnvironment = Extract<SpawnEnvironment, { type: "provider" }>;
type Availability = EnvironmentProviderInfo["availability"];

export interface NormalizedProviderPlacement {
  ruleId: string;
  compositionId: string | null;
  environment: ProviderEnvironment;
  hostId: string | null;
  remote: boolean;
  ownsNewMachine: boolean;
  workspaceKind: "linked-worktree" | "dedicated-machine";
  destinationValidationRequired: true;
  warnings: string[];
}

export class PlacementValidationError extends Error {
  constructor(readonly ruleId: string, readonly code: string, message: string) {
    super(`Machine rule ${ruleId}: ${message}`);
    this.name = "PlacementValidationError";
  }
}

export async function normalizeProviderPlacement(bb: BbPluginApi, args: {
  rule: PlacementRule;
  projectId: string;
  keeperHostId: string;
  serverHostId: string;
  substitutions: PlacementSubstitutions;
  signal?: AbortSignal;
}): Promise<NormalizedProviderPlacement> {
  args.signal?.throwIfAborted();
  const { rule, projectId, signal } = args;
  const fail = (code: string, message: string): never => { throw new PlacementValidationError(rule.id, code, message); };
  if (!rule.enabled) fail("rule-disabled", "This rule is disabled; resolve placement again.");
  const target = rule.target;
  if (target.kind !== "provider") throw new PlacementValidationError(rule.id, "provider-target-required", "Current placement uses the existing hire path.");
  const selector = target.machine;
  if (target.workspace === "dedicated-machine" && selector.type !== "new")
    fail("dedicated-machine-required", "Dedicated-machine placement needs a new machine for this member.");
  const consent = () => {
    if (!rule.consent.guardInstall || !rule.consent.remoteDetectionOnly || !rule.consent.linuxUncontainedChecks)
      fail("needs-rule-consent", "Confirm this rule's marked guard installation, remote detection-only execution and Linux checks without containment in Settings.");
  };
  if (selector.type === "new") consent();
  const options = signal === undefined ? {} : { signal };
  const project = await bb.sdk.projects.get({ projectId, ...options });
  signal?.throwIfAborted();
  if (project.id !== projectId || project.sources.some(source => source.projectId !== projectId))
    fail("project-changed", "The project source identity changed; resolve placement again.");
  let hostId: string | null;
  if (selector.type === "new") hostId = null;
  else if (selector.type === "existing") hostId = selector.hostId;
  else if (selector.type === "keeper") hostId = args.keeperHostId;
  else {
    const defaults = project.sources.filter(source => source.isDefault);
    const source = defaults.length === 1 ? defaults[0] : defaults.length === 0 && project.sources.length === 1 ? project.sources[0] : undefined;
    if (source === undefined) fail(project.sources.length === 0 ? "project-source-missing" : "project-source-ambiguous",
      "Choose one unambiguous default project checkout before using project-checkout placement.");
    hostId = source!.hostId;
  }
  const remote = hostId === null || hostId !== args.serverHostId;
  if (remote) consent();
  if (hostId !== null) {
    const host = await bb.sdk.hosts.get({ hostId, ...options });
    signal?.throwIfAborted();
    if (host.id !== hostId) fail("host-changed", "The selected host identity changed; resolve placement again.");
    if (host.lifecycle.phase !== "active") fail(`host-${host.lifecycle.phase}`, `Selected host is ${host.lifecycle.phase}; recover that host before hiring.`);
    if (host.status !== "connected") fail("host-disconnected", "Selected host is disconnected; reconnect it before hiring.");
    if (host.maxPermissionMode !== "full") fail("host-permission-ceiling", "The selected host does not permit Tavern's full permission mode; only its owner can change that ceiling.");
  }
  const providers = await bb.sdk.environments.listProviders({ projectId, ...(hostId === null ? {} : { hostId }), ...options });
  signal?.throwIfAborted();
  const unique = <T extends { id: string }>(entries: T[], id: string, missing: string): T => {
    const found = entries.filter(entry => entry.id === id);
    if (found.length > 1) fail("provider-catalog-ambiguous", `Provider ${id} has duplicate catalog entries; repair discovery before hiring.`);
    if (found.length === 0) fail(missing, `Provider ${id} is not advertised for the selected destination; restore it or edit this rule.`);
    return found[0]!;
  };
  const selected = unique(providers, target.environmentProviderId, "environment-provider-missing");
  const warnings: string[] = [];
  const availability = (provider: EnvironmentProviderInfo) => {
    const statuses: Availability[] = [provider.availability];
    if (hostId !== null && Object.hasOwn(provider.machineAvailability, hostId)) statuses.push(provider.machineAvailability[hostId]!);
    for (const status of statuses) {
      if (status?.status === "unavailable" || status?.status === "setup-required")
        fail(`provider-${status.status}`, `Provider ${provider.id}: ${status.message}`);
    }
    const actual = statuses[statuses.length - 1];
    if (actual?.status !== "available") {
      if (hostId !== null) fail("provider-availability-unknown", `Provider ${provider.id} availability is not established on the selected host; retry discovery there.`);
      warnings.push(`Provider ${provider.id} availability is not established; revalidate on the actual provisioned destination before readiness.`);
    }
  };
  const inputs = (provider: Pick<EnvironmentProviderInfo, "id" | "inputs" | "acceptsEmptyInputs">,
    supplied: Parameters<typeof validatePlacementInputs>[1], path: string) => {
    const result = validatePlacementInputs(provider, supplied, args.substitutions);
    if (result.state !== "valid") return fail(result.state === "unsupported" ? "provider-schema-unsupported" : "provider-inputs-invalid",
      `${path} for provider ${provider.id}: ${result.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
    return result.inputs;
  };
  let concrete = selected;
  const composition = selected.machineProviderId !== null;
  if (composition) {
    if (selector.type !== "new" || selected.machineProviderId !== selector.machineProviderId || !selected.environmentProviderId)
      fail("composition-invalid", "The composition needs its advertised concrete environment and matching new-machine provider; edit this rule.");
    const found = providers.filter(provider => provider.id === selected.environmentProviderId);
    if (found.length !== 1 || found[0]!.machineProviderId !== null)
      fail("composition-invalid", "The composition's concrete environment is missing, ambiguous or another composition; repair discovery.");
    concrete = found[0]!;
  }
  for (const provider of new Set([selected, concrete])) {
    if ((provider.requires.gitRemote || hostId === null && provider.requires.projectCheckout) && !project.gitRemoteUrl)
      fail("project-remote-required", `Provider ${provider.id} needs a project Git remote to set up the selected destination; configure one before hiring.`);
    if (hostId !== null && provider.requires.projectCheckout && !project.sources.some(source => source.hostId === hostId))
      fail("project-checkout-required", `Provider ${provider.id} needs a project checkout on the selected host; add that source before hiring.`);
  }
  availability(selected);
  if (concrete !== selected) availability(concrete);
  const environmentInputs = inputs(selected, target.inputs, "target.inputs");
  if (concrete !== selected) inputs(concrete, target.inputs, "target.inputs");
  let machine: NonNullable<ProviderEnvironment["machine"]>;
  if (selector.type === "new") {
    const machines = await bb.sdk.hosts.experimental_listProviders(options);
    signal?.throwIfAborted();
    const provider: MachineProviderInfo = unique(machines, selector.machineProviderId, "machine-provider-missing");
    const machineInputs = inputs(provider, selector.inputs, "target.machine.inputs");
    if (composition && (selected.machineInputs !== undefined || selected.machineAcceptsEmptyInputs !== undefined)) {
      if (selected.machineInputs === undefined || selected.machineAcceptsEmptyInputs === undefined)
        fail("composition-invalid", "The composition's machine input contract is incomplete; repair discovery.");
      inputs({ id: selected.id, inputs: selected.machineInputs!, acceptsEmptyInputs: selected.machineAcceptsEmptyInputs! }, selector.inputs, "target.machine.inputs");
    }
    machine = { type: "new", machineProviderId: provider.id, inputs: machineInputs };
  } else {
    machine = { type: "existing", hostId: hostId! };
  }
  signal?.throwIfAborted();
  return {
    ruleId: rule.id, compositionId: composition ? selected.id : null,
    environment: { type: "provider", environmentProviderId: concrete.id, inputs: environmentInputs, machine },
    hostId, remote, ownsNewMachine: selector.type === "new", workspaceKind: target.workspace,
    destinationValidationRequired: true, warnings: [...new Set(warnings)],
  };
}
