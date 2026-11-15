import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Selection = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"];

export async function resolveHireEnvironment(
  bb: BbPluginApi,
  projectId: string,
  environmentId: string | null,
  needsWorktree: boolean,
): Promise<Selection> {
  if (!needsWorktree) {
    return environmentId
      ? { type: "reuse", environmentId }
      : { type: "project-default" };
  }
  if (!environmentId)
    throw new Error("Cannot hire a Smith: a ready Git checkout is required before an isolated worktree can be made.");
  const environment = await bb.sdk.environments.get({ environmentId });
  if (!environment.isGitRepo)
    throw new Error("Cannot hire a Smith: this environment is not a Git checkout; an isolated worktree is required.");
  if (environment.environmentProviderId !== null &&
      environment.environmentProviderId !== "git-worktree" &&
      environment.environmentProviderId !== "project-checkout")
    throw new Error(`Cannot hire a Smith: environment provider ${environment.environmentProviderId} is not supported for isolated worktrees. Use Project checkout or Worktree on a Git checkout.`);

  let providers;
  try {
    providers = await bb.sdk.environments.listProviders({ projectId, hostId: environment.hostId });
  } catch (error) {
    throw new Error(`Cannot hire a Smith: worktree provider eligibility could not be checked: ${String(error)}`);
  }
  const provider = providers.find(item => item.id === "git-worktree" && item.machineProviderId === null);
  if (!provider)
    throw new Error("Cannot hire a Smith: the git-worktree provider is not available for this project and machine.");
  const blocked = [provider.availability, provider.machineAvailability[environment.hostId]]
    .find(availability => availability && availability.status !== "available");
  if (blocked && blocked.status !== "available")
    throw new Error(`Cannot hire a Smith: an isolated Git worktree cannot be made: ${blocked.message}`);

  return {
    type: "provider",
    environmentProviderId: "git-worktree",
    machine: { type: "existing", hostId: environment.hostId },
    inputs: {
      branch: environment.branchName
        ? { kind: "named", name: environment.branchName }
        : { kind: "default" },
    },
  };
}
