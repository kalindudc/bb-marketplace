import type { BbPluginApi } from "@get-bb/plugin-sdk";

type EnvironmentProvider = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["listProviders"]>>[number];
export function worktreeProvider(patch: Partial<EnvironmentProvider> = {}): EnvironmentProvider {
  return {
    id: "git-worktree",
    displayName: "Worktree",
    description: null,
    icon: null,
    logoUrl: null,
    pluginId: "environment-git-worktree",
    machineProviderId: null,
    requires: { projectCheckout: true, gitCheckout: true, gitRemote: false, projectless: false },
    inputs: null,
    acceptsEmptyInputs: true,
    availability: { status: "available" },
    machineAvailability: { host: { status: "available" } },
    ...patch,
  };
}
