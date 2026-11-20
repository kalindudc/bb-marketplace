import { cliCommand, PLUGIN_CLI_OUTPUT_MAX_BYTES, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { normalizeRemote } from "../../scope/remote";
import type { SettingsStore } from "./store";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export function setupDiscoveryCommands(bb: BbPluginApi, store: SettingsStore) {
  return {
    "setup discover": cliCommand({
      summary: "Read project checkouts, providers, model catalogs and current Tavern placement settings",
      options: {
        project: { type: "string", description: "Show one project and its provider catalogs" },
        host: { type: "string", description: "Check providers on this host instead of the primary host" },
      },
      async run({ options }, context) {
        const [projects, config] = await Promise.all([bb.sdk.projects.list({ includePersonal: true }), bb.sdk.system.config()]);
        const hostId = options.host ?? config.primaryHostId;
        const modelProjectId = options.project ?? context.projectId ?? null;
        if (modelProjectId !== null && !projects.some(project => project.id === modelProjectId))
          throw new PluginCliError("Choose an existing project for discovery.");
        const routing = hostId === null ? {} : { hostId };
        const projectRouting = modelProjectId === null ? {} : { projectId: modelProjectId };
        const [offered, unrouted, machines, providers] = await Promise.all([
          bb.sdk.environments.listProviders({ ...routing, ...projectRouting }),
          hostId === null ? [] : bb.sdk.environments.listProviders(projectRouting),
          bb.sdk.hosts.experimental_listProviders(),
          bb.sdk.providers.list(routing),
        ]);
        const environments = [...new Map([
          ...offered.map(provider => [provider.id, provider] as const),
          ...unrouted.filter(provider => provider.machineProviderId !== null && !offered.some(item => item.id === provider.id)).map(provider => [provider.id, provider] as const),
        ]).values()];

        const repositories = [];
        for (const project of projects) {
          if (options.project && project.id !== options.project) continue;
          const repos = [];
          for (const { path, hostId, isDefault } of project.sources) {
            const source = { path, hostId, isDefault, defaultBranch: null };
            try {
              const matches = await bb.sdk.environments.list({ path, hostId, projectId: project.id });
              const branches = [...new Set(matches.filter(env => env.path === path && env.hostId === hostId && env.projectId === project.id)
                .flatMap(env => env.defaultBranch ? [env.defaultBranch] : []))];
              repos.push({ ...source, defaultBranch: branches.length === 1 ? branches[0] : null,
                ...(branches.length > 1 ? { error: "bb reports conflicting default branches for this checkout." } : {}) });
            } catch (error) {
              repos.push({ ...source, error: errorText(error) });
            }
          }
          repositories.push({ id: project.id, name: project.name, kind: project.kind, repos,
            remotes: project.gitRemoteUrl === null ? [] : [normalizeRemote(project.gitRemoteUrl)] });
        }

        const catalogs = await Promise.all(providers.map(async provider => {
          const summary = { id: provider.id, displayName: provider.displayName, available: provider.available };
          if (!provider.available) return { ...summary, models: [], error: "The provider is unavailable on this host." };
          try {
            const catalog = await bb.sdk.providers.models({ ...routing, ...projectRouting, providerId: provider.id });
            const models = catalog.models.map(({ id, model, displayName, isDefault, supportedReasoningEfforts }) =>
              ({ id, model, displayName, isDefault, reasoning: supportedReasoningEfforts.map(level => level.reasoningEffort) }));
            const load = catalog.modelLoadError;
            return { ...summary, models, error: load ? [load.code, load.detail].filter(Boolean).join(": ") : null };
          } catch (error) {
            return { ...summary, models: [], error: errorText(error) };
          }
        }));
        const placement = store.placementPolicy();
        const result = { revision: placement.revision, hostId, modelProjectId, projects: repositories, environments, machines, providers: catalogs, placement };
        const pretty = JSON.stringify(result, null, 2);
        const stdout = Buffer.byteLength(pretty) <= PLUGIN_CLI_OUTPUT_MAX_BYTES ? pretty : JSON.stringify(result);
        if (Buffer.byteLength(stdout) > PLUGIN_CLI_OUTPUT_MAX_BYTES)
          throw new PluginCliError("Discovery is too large to print as one JSON document. Use --project <id> to narrow the project list.");
        return { exitCode: 0, stdout };
      },
    }),
  };
}
