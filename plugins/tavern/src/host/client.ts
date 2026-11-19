import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, type HostInput, type HostMethod, type HostOutput } from "../host-contract";
import { scopeDeliveryFileSchema } from "../scope/schema";

export interface HostPort {
  call<M extends HostMethod>(hostId: string, method: M, input: HostInput<M>, options?: { signal?: AbortSignal }): Promise<HostOutput<M>>;
  onWorkerExit(listener: (event: { hostId: string }) => void): () => void;
}
export function hostCallTimeoutMs(method: HostMethod, input: { networkTimeoutMs?: number }): number {
  if (method === "importCommit" || method === "pushedBase") return Math.min(1_800_000, 2 * (input.networkTimeoutMs ?? 120_000) + 330_000);
  return ["inspect", "snapshotWorktree", "commitAll", "exportChanges", "carryStart", "carryFinish", "carryAbort", "worktreeState", "revokePlacement", "releaseSnapshotRef"].includes(method) ? 330_000 : 30_000;
}
export function createHostPort(bb: Pick<BbPluginApi, "hosts">): HostPort {
  const client = bb.hosts.experimental_client({ contract: hostContract });
  return {
    async call<M extends HostMethod>(hostId: string, method: M, input: HostInput<M>, options?: { signal?: AbortSignal }) {
      if (!hostId) throw new Error("Tavern host calls require an explicit host id.");
      if (method === "registerEndpoint" && hostContract.registerEndpoint.input.parse(input).endpoint.hostId !== hostId)
        throw new Error("The registered endpoint host must match the authenticated target host.");
      if (method === "registerEndpoints" && hostContract.registerEndpoints.input.parse(input).endpoints.some(endpoint => endpoint.endpoint.hostId !== hostId))
        throw new Error("Every registered endpoint host must match the authenticated target host.");
      if (method === "bindScope") {
        const delivery = hostContract.bindScope.input.parse(input);
        if (scopeDeliveryFileSchema.parse(JSON.parse(delivery.scopeFileJson)).workspaceBinding.hostId !== hostId)
          throw new Error("The delivered workspace host must match the authenticated target host.");
      }
      const timeoutMs = hostCallTimeoutMs(method, "networkTimeoutMs" in input ? input : {});
      return client.call(method, input, { hostId, timeoutMs, signal: options?.signal }) as Promise<HostOutput<M>>;
    },
    onWorkerExit: listener => client.experimental_onWorkerExit(listener),
  };
}
