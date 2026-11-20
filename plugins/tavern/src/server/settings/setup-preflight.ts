import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostInput, HostOutput } from "../../host-contract";
import { createHostPort } from "../../host/client";
import { HOME_FORGE_GIT } from "../../shared/forge-command";
import type { PlacementRule } from "../../shared/placement-settings";
import type { TavernSettings } from "../../shared/settings";
import type { SetupLine } from "../../shared/setup";
import type { ClassDef } from "../../shared/schema";

export type SetupScope = { projectId: string | null; threadId: string | null };
type CatalogRoute = { hostId: string; projectId?: string } | { environmentId: string };
type ForgeInput = HostInput<"setupForgeInspect">;
export type SetupChecks = {
  forges: ForgeInput["forges"];
  rules: { index: number; rule: PlacementRule }[];
  classes: string[];
};
const futureMachine = "No machine exists for this rule. Tavern checks the model when the first member starts there.";
const description = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 400);

export class SetupPreflight {
  constructor(private readonly bb: BbPluginApi, private readonly classFor: (projectId: string | null, id: string) => Promise<ClassDef | undefined>) {}

  private async forgeInput(hostId: string, { projectId, threadId }: SetupScope, forges: SetupChecks["forges"], signal?: AbortSignal): Promise<ForgeInput> {
    const roots = new Set<string>();
    const [host, projects] = await Promise.all([
      this.bb.sdk.hosts.get({ hostId, signal }),
      this.bb.sdk.projects.list({ includePersonal: true, signal }),
    ]);
    for (const source of projects.flatMap(project => project.sources)) if (source.hostId === hostId) roots.add(source.path);
    const project = projects.find(project => project.id === projectId);
    if (host.threadStorageRootPath) roots.add(host.threadStorageRootPath);
    if (threadId) {
      const storage = await this.bb.sdk.threads.storageLocation({ threadId, signal });
      if (storage.hostId === hostId) roots.add(storage.storageRootPath);
    }
    const sources = project?.sources.filter(source => source.hostId === hostId) ?? [];
    const root = (sources.find(source => source.isDefault) ?? (sources.length === 1 ? sources[0] : undefined))?.path ?? null;
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const batch = await this.bb.sdk.environments.list({ hostId, limit, offset, signal });
      for (const env of batch) if (env.path) roots.add(env.path);
      if (batch.length < limit) break;
    }
    return { root, git: HOME_FORGE_GIT, blockedRoots: [...roots], forges };
  }

  async inspect(settings: TavernSettings, checks: SetupChecks, scope: SetupScope, signal?: AbortSignal) {
    const lines: SetupLine[] = [];
    let hostId: string | null = null;
    let forgeInput: ForgeInput | null = null;
    let paths: HostOutput<"setupForgeInspect"> = [];
    if (checks.forges.length || checks.classes.length || checks.rules.length) {
      try { hostId = (await this.bb.sdk.system.config({ signal })).primaryHostId; }
      catch (error) { signal?.throwIfAborted(); lines.push({ key: "setup.host", status: "fail", message: description(error) }); }
    }
    if (checks.forges.length) {
      try {
        if (hostId === null) throw new Error("bb has no primary host for forge checks.");
        forgeInput = await this.forgeInput(hostId, scope, checks.forges, signal);
        paths = await createHostPort(this.bb).call(hostId, "setupForgeInspect", forgeInput, { signal });
        lines.push(...paths.map(({ key, status, message }) => ({ key, status, message })));
      } catch (error) {
        signal?.throwIfAborted();
        lines.push({ key: "machines.forges", status: "fail", message: description(error) });
      }
    }

    const catalog = new Map<string, ReturnType<BbPluginApi["sdk"]["providers"]["models"]>>();
    const checkModel = async (key: string, id: string, override: { provider?: string; model?: string }, route: CatalogRoute, projectId: string | null) => {
      try {
        const role = settings.classes[id];
        const inherited = !((override.provider ?? role?.provider) && (override.model ?? role?.model)) ? await this.classFor(projectId, id) : undefined;
        const providerId = override.provider ?? role?.provider ?? inherited?.provider ?? (projectId === null ? null : (await this.bb.sdk.projects.defaultExecutionOptions({ projectId, signal }))?.providerId);
        if (!providerId) throw new Error("Name the provider to verify this class’s model.");
        const model = override.model ?? role?.model ?? inherited?.model;
        const cacheKey = JSON.stringify({ providerId, route });
        let lookup = catalog.get(cacheKey);
        if (!lookup) { lookup = this.bb.sdk.providers.models({ ...route, providerId, signal }); catalog.set(cacheKey, lookup); }
        const result = await lookup;
        if (result.modelLoadError) throw new Error(`bb could not load the catalog for ${providerId}: ${result.modelLoadError.code}.`);
        const found = result.models.find(entry => model ? entry.model === model || entry.id === model : entry.isDefault);
        if (!found) throw new Error(model ? `The target catalog for ${providerId} does not offer ${model}.` : `The target catalog for ${providerId} does not list a default model.`);
        lines.push({ key, status: "pass", message: `The target catalog offers ${found.model}.` });
      } catch (error) {
        signal?.throwIfAborted();
        lines.push({ key, status: "fail", message: description(error) });
      }
    };
    const hostRoute = (id: string, projectId: string | null) => ({ hostId: id, ...(projectId === null ? {} : { projectId }) });
    for (const id of checks.classes) {
      const key = `classes.${id}.model`;
      if (hostId === null) lines.push({ key, status: "fail", message: "bb has no primary host for class model checks." });
      else await checkModel(key, id, {}, hostRoute(hostId, scope.projectId), scope.projectId);
    }

    const threadEnvironment = async () => {
      if (!scope.threadId) return null;
      const thread = await this.bb.sdk.threads.get({ threadId: scope.threadId, signal });
      return thread.environmentId ? this.bb.sdk.environments.get({ environmentId: thread.environmentId, signal }) : null;
    };
    let local: ReturnType<typeof threadEnvironment> | undefined;
    let machines: ReturnType<BbPluginApi["sdk"]["hosts"]["experimental_listProviders"]> | undefined;
    for (const { index, rule } of checks.rules) {
      const key = `machines.rules.${index}`;
      const future = rule.target.kind === "provider" && rule.target.machine.type === "new";
      const projects = rule.match.projectIds ?? [scope.projectId];
      for (const projectId of projects) {
        try {
          const target = rule.target;
          const selector = target.kind === "provider" ? target.machine : null;
          let targetHost = hostId, environmentId: string | undefined;
          if (selector?.type === "existing") targetHost = selector.hostId;
          else if (selector?.type === "project-checkout") {
            if (projectId === null) throw new Error("Name the project whose checkout hosts this rule.");
            const project = await this.bb.sdk.projects.get({ projectId, signal });
            const defaults = project.sources.filter(source => source.isDefault);
            const source = defaults.length === 1 ? defaults[0] : !defaults.length && project.sources.length === 1 ? project.sources[0] : undefined;
            if (!source) throw new Error("bb has no unambiguous default checkout for this project.");
            targetHost = source.hostId;
          } else if (!future && (target.kind === "provider" || Object.keys(rule.classModels ?? {}).length)) {
            local ??= threadEnvironment();
            const env = await local;
            if (env) { targetHost = env.hostId; environmentId = env.id; }
          }
          if (target.kind === "provider") {
            const providers = await this.bb.sdk.environments.listProviders({ ...(projectId === null ? {} : { projectId }), ...(future || !targetHost ? {} : { hostId: targetHost }), signal });
            const provider = providers.find(provider => provider.id === target.environmentProviderId);
            if (!provider) throw new Error(`bb does not offer environment provider ${target.environmentProviderId} for this target.`);
            const availability = targetHost && !future ? provider.machineAvailability?.[targetHost] ?? provider.availability : provider.availability;
            if (availability?.status === "unavailable" || availability?.status === "setup-required") throw new Error(availability.message);
            if (selector?.type === "new") {
              machines ??= this.bb.sdk.hosts.experimental_listProviders({ signal });
              if (!(await machines).some(provider => provider.id === selector.machineProviderId)) throw new Error(`bb does not offer machine provider ${selector.machineProviderId}.`);
              if (provider.machineProviderId !== null && provider.machineProviderId !== selector.machineProviderId)
                throw new Error("The environment provider is offered with a different machine provider.");
            }
            lines.push({ key: `${key}.target`, status: "pass", message: `bb offers ${target.environmentProviderId} for this target.` });
          }
          for (const [id, override] of Object.entries(rule.classModels ?? {})) {
            const modelKey = `${key}.classModels.${id}`;
            if (future) lines.push({ key: modelKey, status: "unchecked", message: futureMachine });
            else if (!targetHost) lines.push({ key: modelKey, status: "fail", message: "bb cannot identify the host for this rule’s model." });
            else await checkModel(modelKey, id, override, environmentId ? { environmentId } : hostRoute(targetHost, projectId), projectId);
          }
        } catch (error) {
          signal?.throwIfAborted();
          lines.push({ key: `${key}.target`, status: "fail", message: description(error) });
          if (future) for (const id of Object.keys(rule.classModels ?? {})) lines.push({ key: `${key}.classModels.${id}`, status: "unchecked", message: futureMachine });
        }
      }
    }
    return { lines, paths, forge: forgeInput && hostId ? { hostId, input: forgeInput } : null };
  }

  async probe(target: { hostId: string; input: ForgeInput }, signal?: AbortSignal): Promise<SetupLine[]> {
    try { return await createHostPort(this.bb).call(target.hostId, "setupForgeProbe", target.input, { signal }); }
    catch (error) {
      signal?.throwIfAborted();
      return [{ key: "machines.forges", status: "fail", message: description(error) }];
    }
  }
}
