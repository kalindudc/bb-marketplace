import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Authority, HostOutput } from "../../host-contract";
import type { HostPort } from "../../host/client";
import { DiscoveryStore, StaleDiscoveryError, type DiscoveryBinding } from "./discovery-store";

export type SdkSource = {
  keeperThreadId: string;
  projectId: string;
  endpoint: DiscoveryBinding["endpoint"];
  environmentProviderId: string | null;
};
export interface KnownSource {
  state: "known";
  keeperThreadId: string;
  projectId: string;
  authorityId: string;
  generation: number;
  endpointId: string;
  endpoint: DiscoveryBinding["endpoint"];
  environmentProviderId: string | null;
  inspection: HostOutput<"inspect">;
}
export type SourceDiscoveryResult = KnownSource | {
  state: "unavailable";
  code: "source-unavailable" | "source-changed" | "cancelled";
  message: string;
};
type Proof = { observation: KnownSource; sdk: SdkSource };

export async function readSourceIdentity(
  bb: Pick<BbPluginApi, "sdk">,
  keeperThreadId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<SdkSource> {
  signal?.throwIfAborted();
  const thread = await bb.sdk.threads.get({ threadId: keeperThreadId, ...(signal === undefined ? {} : { signal }) });
  signal?.throwIfAborted();
  if (thread.id !== keeperThreadId || thread.projectId !== projectId || thread.archivedAt !== null || thread.deletedAt !== null)
    throw new Error("The source Keeper is not an active thread in this project.");
  if (!thread.environmentId) throw new Error("The source Keeper has no provisioned environment.");
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId, ...(signal === undefined ? {} : { signal }) });
  signal?.throwIfAborted();
  if (environment.id !== thread.environmentId || environment.projectId !== projectId)
    throw new Error("The source environment no longer belongs to this Keeper and project.");
  if (environment.status !== "ready" || environment.hostLifecycle !== "active" || environment.lifecycle.phase !== "active")
    throw new Error("The source environment or host is not ready and active.");
  if (!environment.path || !environment.hostId) throw new Error("The SDK has not supplied a source host and path.");
  return {
    keeperThreadId, projectId, environmentProviderId: environment.environmentProviderId,
    endpoint: { hostId: environment.hostId, environmentId: environment.id, root: environment.path },
  };
}

export class SourceDiscovery {
  private readonly lifetime = new AbortController();
  private readonly issued = new WeakMap<KnownSource, Proof>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "log" | "onDispose">,
    private readonly host: HostPort,
    private readonly store: DiscoveryStore,
  ) {
    this.unsubscribe = host.onWorkerExit(({ hostId }) => {
      if (this.lifetime.signal.aborted) return;
      try { this.store.invalidateHost(hostId); }
      catch (error) { this.bb.log.warn("Tavern source discovery invalidation failed: " + String(error)); }
    });
    bb.onDispose(() => this.dispose());
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error("Source discovery disposed"));
    this.unsubscribe();
  }

  private signal(caller?: AbortSignal): AbortSignal {
    return caller === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, caller]);
  }

  private invalidate(binding: DiscoveryBinding): void {
    const current = this.store.get(binding.keeperThreadId);
    if (current?.authorityId === binding.authorityId)
      this.store.invalidate(binding.keeperThreadId, binding.generation);
  }

  private assertProof(source: KnownSource): Proof {
    this.lifetime.signal.throwIfAborted();
    const proof = this.issued.get(source);
    if (!proof || !isDeepStrictEqual(proof.observation, source))
      throw new StaleDiscoveryError("The source proof was not issued here or has changed.");
    const current = this.store.assertCurrent(source.keeperThreadId, source.generation);
    if (current.authorityId !== source.authorityId || current.canonicalRoot !== source.endpoint.root ||
        !isDeepStrictEqual(current.endpoint, proof.sdk.endpoint))
      throw new StaleDiscoveryError("The source proof no longer matches its private binding.");
    return proof;
  }

  async revalidate(source: KnownSource, caller?: AbortSignal): Promise<void> {
    const signal = this.signal(caller);
    signal.throwIfAborted();
    const proof = this.assertProof(source);
    const binding = this.store.assertCurrent(source.keeperThreadId, source.generation);
    try {
      const current = await readSourceIdentity(this.bb, source.keeperThreadId, source.projectId, signal);
      signal.throwIfAborted();
      this.assertProof(source);
      if (!isDeepStrictEqual(current, proof.sdk)) throw new StaleDiscoveryError("The SDK source identity changed.");
    } catch (error) {
      this.invalidate(binding);
      throw error;
    }
  }

  async inspect(keeperThreadId: string, projectId: string, caller?: AbortSignal): Promise<SourceDiscoveryResult> {
    const signal = this.signal(caller);
    let binding: DiscoveryBinding | null = null;
    try {
      signal.throwIfAborted();
      binding = this.store.get(keeperThreadId);
      const sdk = await readSourceIdentity(this.bb, keeperThreadId, projectId, signal);
      binding = this.store.bind(keeperThreadId, sdk.endpoint);
      const authority: Authority = {
        placementId: binding.authorityId, generation: binding.generation,
        endpointId: "source", operationId: randomUUID(),
      };
      const acknowledgement = await this.host.call(sdk.endpoint.hostId, "registerEndpoint", {
        placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId,
        endpoint: sdk.endpoint, ownerThreadId: null, access: "source-read", git: "full", workspaceKind: null,
        objectFormat: null, allowedRefs: [],
      }, { signal });
      signal.throwIfAborted();
      this.store.assertCurrent(keeperThreadId, binding.generation);
      if (acknowledgement.generation !== binding.generation)
        throw new StaleDiscoveryError("The host acknowledged another source discovery generation.");
      const inspection = await this.host.call(sdk.endpoint.hostId, "inspect", authority, { signal });
      signal.throwIfAborted();
      this.store.assertCurrent(keeperThreadId, binding.generation);
      let current: SdkSource;
      try { current = await readSourceIdentity(this.bb, keeperThreadId, projectId, signal); }
      catch (error) {
        signal.throwIfAborted();
        throw new StaleDiscoveryError("The SDK source changed during inspection: " + String(error));
      }
      signal.throwIfAborted();
      if (!isDeepStrictEqual(current, sdk)) throw new StaleDiscoveryError("The SDK source changed during inspection.");
      this.store.pin(keeperThreadId, binding.generation, inspection.root);
      const source: KnownSource = {
        state: "known", keeperThreadId, projectId, authorityId: binding.authorityId, generation: binding.generation,
        endpointId: authority.endpointId, endpoint: { ...sdk.endpoint, root: inspection.root },
        environmentProviderId: sdk.environmentProviderId, inspection,
      };
      this.issued.set(source, { observation: structuredClone(source), sdk });
      return source;
    } catch (error) {
      if (binding !== null) this.invalidate(binding);
      return {
        state: "unavailable", code: signal.aborted ? "cancelled" : error instanceof StaleDiscoveryError ? "source-changed" : "source-unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
