import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Providers = BbPluginApi["sdk"]["providers"];
export type Provider = Awaited<ReturnType<Providers["list"]>>[number];
export type Catalog = Awaited<ReturnType<Providers["models"]>>;
export type Model = Catalog["models"][number];
export function provider(
  id = "pi",
  permissionModes: Provider["capabilities"]["permissionModes"] = ["full"],
): Provider {
  return {
    id,
    displayName: id,
    available: true,
    pluginId: id,
    logoUrl: null,
    completedTurnDisplay: "collapse",
    composerActions: [],
    maintenance: { health: false, installation: false, usage: false },
    capabilities: {
      modelCatalogScope: "host",
      permissionModes,
      supportsFork: false,
      supportsNativeUserQuestion: false,
      supportsServiceTier: false,
      supportsSessionRewind: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
    },
    reasoningLevels: ["low", "medium", "high", "xhigh"].map((id) => ({ id, label: id })),
  };
}
export function model(
  name = "anthropic/claude-sonnet-5-5",
  levels = ["low", "medium", "high"],
  isDefault = true,
  defaultLevel = levels[0]!,
): Model {
  return {
    id: `id:${name}`,
    model: name,
    displayName: name,
    description: "Test model",
    isDefault,
    reasoningDiscovery: "known",
    defaultReasoningEffort: defaultLevel,
    supportedReasoningEfforts: levels.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
  };
}
export function catalog(
  models = [model(), model("openai/gpt-6.1-sol", ["low", "high", "xhigh"], false)],
  providers = [provider()],
): Catalog {
  return {
    models,
    providers,
    permissionCeiling: "full",
    selectedOnlyModels: [],
    modelLoadError: null,
  };
}
export function providerSdk(): Providers {
  return {
    list: async () => [provider()],
    models: async () => catalog(),
    catalog: async () => [],
    setEnabled: async () => [],
  };
}
