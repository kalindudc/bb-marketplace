import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type EnvironmentProviderInfo = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["listProviders"]>>[number];
export type MachineProviderInfo = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["experimental_listProviders"]>>[number];
export type PlacementHostInfo = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];

export interface PlacementCatalog {
  projectId: string;
  hostId: string;
  hostEnvironments: EnvironmentProviderInfo[];
  compositions: EnvironmentProviderInfo[];
  machines: MachineProviderInfo[];
  hosts: PlacementHostInfo[];
}

export async function discoverPlacementCatalog(
  bb: BbPluginApi,
  args: { projectId: string; hostId: string; signal?: AbortSignal },
): Promise<PlacementCatalog> {
  args.signal?.throwIfAborted();
  const { projectId, hostId } = args;
  const cancellation = args.signal === undefined ? {} : { signal: args.signal };
  const [hostEnvironments, unscopedEnvironments, machines, hosts] = await Promise.all([
    bb.sdk.environments.listProviders({ projectId, hostId, ...cancellation }),
    bb.sdk.environments.listProviders({ projectId, ...cancellation }),
    bb.sdk.hosts.experimental_listProviders(cancellation),
    bb.sdk.hosts.list({ includeCreating: true, ...cancellation }),
  ]);
  args.signal?.throwIfAborted();
  return {
    projectId,
    hostId,
    hostEnvironments,
    compositions: unscopedEnvironments.filter(provider => provider.machineProviderId !== null),
    machines,
    hosts,
  };
}
