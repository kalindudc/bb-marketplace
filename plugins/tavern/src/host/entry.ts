import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@get-bb/plugin-sdk";
import { resolve } from "node:path";
import { hostContract, type HostOutput } from "../host-contract";
import { createArtifacts } from "./artifacts";
import { NativeGuard } from "./guard";
import { inspectHost } from "./inspect";
import { abortError } from "./process";
import { HostError, HostRegistry } from "./registry";
import { NativeScopes, type NativeScopePaths } from "./scopes";
import { createTransport } from "./transport";
import { draftPush, draftOpen, forgePullRequest } from "./forge";
import { inspectSetupForges, probeSetupForges } from "./setup-forge";
import { pushedBase } from "./pushed-base";
import { snapshotWorktree } from "./snapshot";

export interface TavernHostEntryOptions { artifactPath: string; paths?: NativeScopePaths }
export function createTavernHostEntry(options: TavernHostEntryOptions) {
  const controller = new AbortController(), calls = new Set<Promise<unknown>>();
  let closed = false;
  let state: { dataDir: string; lifecycle: AbortSignal; registry: HostRegistry; transport: ReturnType<typeof createTransport>; artifacts: ReturnType<typeof createArtifacts>; scopes: NativeScopes; guard: NativeGuard } | undefined;
  const services = (context: ExperimentalHostRpcContext) => {
    const dataDir = resolve(context.experimental_paths.dataDir);
    if (state && (state.dataDir !== dataDir || state.lifecycle !== context.lifecycle.signal))
      throw new HostError("host-paths-changed", "A worker cannot switch its native data directory or lifecycle to another host context.");
    if (!state) {
      const registry = new HostRegistry(dataDir);
      state = { dataDir, lifecycle: context.lifecycle.signal, registry, transport: createTransport(registry), artifacts: createArtifacts(registry), scopes: new NativeScopes(registry, { paths: options.paths }), guard: new NativeGuard(registry, { artifactPath: options.artifactPath, agentDir: options.paths?.piAgentDir }) };
    }
    return state;
  };
  const invoke = <T>(context: ExperimentalHostRpcContext, work: (signal: AbortSignal) => T | Promise<T>): Promise<T> => {
    const signal = AbortSignal.any([context.signal, context.lifecycle.signal, controller.signal]);
    const pending = (async () => {
      if (closed || signal.aborted) throw abortError();
      const result = await work(signal);
      if (signal.aborted) throw abortError();
      return result;
    })();
    calls.add(pending); void pending.then(() => calls.delete(pending), () => calls.delete(pending));
    return pending;
  };
  const call = <T>(context: ExperimentalHostRpcContext, work: (native: ReturnType<typeof services>, signal: AbortSignal) => T | Promise<T>) =>
    invoke(context, signal => work(services(context), signal));
  return experimental_defineHostEntry({
    contract: hostContract,
    handlers: {
      registerEndpoint: (input, context) => call(context, (native, signal) => native.registry.registerEndpoint(input, signal)),
      registerEndpoints: (input, context) => call(context, (native, signal) => native.registry.registerEndpoints(input, signal)),
      releaseEndpoint: (input, context) => call(context, (native, signal) => native.registry.releaseEndpoint(input, signal)),
      releaseSnapshotRef: (input, context) => call(context, (native, signal) => native.transport.releaseSnapshotRef(input, signal)),
      registerTransfer: (input, context) => call(context, native => native.registry.registerTransfer(input)),
      revokePlacement: (input, context) => call(context, async (native, signal) => {
        const result = native.registry.revokePlacement(input);
        await native.registry.settlePlacement(input.placementId, input.generation);
        if (signal.aborted) throw abortError();
        return result;
      }),
      inspect: (input, context) => call(context, (native, signal) => native.registry.operation(input, signal, combined => inspectHost(native.registry, input, combined))),
      prepareGuard: (input, context) => call(context, (native, signal) => native.guard.prepareGuard(input, signal)),
      bindScope: (input, context) => call(context, (native, signal) => native.scopes.bindScope(input, signal)),
      prepareCall: (input, context) => call(context, (native, signal) => native.scopes.prepareCall(input, signal)),
      sessionStatus: (input, context) => call(context, (native, signal) => native.scopes.sessionStatus(input, signal)),
      communicationHolds: (input, context) => call(context, (native, signal) => native.scopes.communicationHolds(input, signal)),
      revokeDraftReceipts: (input, context) => call(context, (native, signal) => native.scopes.revokeDraftReceipts(input, signal)),
      issueClusterGrant: (input, context) => call(context, (native, signal) => native.scopes.issueClusterGrant(input, signal)),
      revokeClusterGrant: (input, context) => call(context, (native, signal) => native.scopes.revokeClusterGrant(input, signal)),
      releaseScope: (input, context) => call(context, (native, signal) => native.scopes.releaseScope(input, signal)),
      worktreeState: (input, context) => call(context, (native, signal) => native.transport.worktreeState(input, signal)),
      pushedBase: (input, context) => call(context, (native, signal) => pushedBase(native.registry, input, signal)),
      snapshotWorktree: (input, context) => call(context, async (native, signal) => {
        try { return await snapshotWorktree(native.registry, input, signal); }
        catch (error) {
          if (!(error instanceof HostError)) throw error;
          return { outcome: "unavailable" as const, code: error.code, message: error.message, retryable: error.retryable };
        }
      }),
      draftPush: (input, context) => call(context, (native, signal) => draftPush(native.registry, input, signal)),
      draftOpen: (input, context) => call(context, (native, signal) => draftOpen(native.registry, input, signal)),
      setupForgeInspect: (input, context) => invoke(context, () => inspectSetupForges(input)),
      setupForgeProbe: (input, context) => invoke(context, signal => probeSetupForges(input, signal)),
      forgePullRequest: (input, context) => call(context, (native, signal) => forgePullRequest(native.registry, input, signal)),
      commitAll: (input, context) => call(context, (native, signal) => native.transport.commitAll(input, signal)),
      exportChanges: (input, context) => call(context, (native, signal) => native.transport.exportChanges(input, signal)),
      readBlob: (input, context) => call(context, (native, signal) => native.transport.readBlob(input, signal)),
      importChunk: (input, context) => call(context, (native, signal) => native.transport.importChunk(input, signal)),
      dropUploads: (input, context) => call(context, (native, signal) => native.transport.dropUploads(input, signal)),
      importCommit: (input, context) => call(context, (native, signal) => native.transport.importCommit(input, signal)),
      carryStart: (input, context) => call(context, (native, signal) => native.transport.carryStart(input, signal)),
      carryWrite: (input, context) => call(context, (native, signal) => native.transport.carryWrite(input, signal)),
      carryDelete: (input, context) => call(context, (native, signal) => native.transport.carryDelete(input, signal)),
      carryFinish: (input, context) => call(context, (native, signal) => native.transport.carryFinish(input, signal)),
      carryAbort: (input, context) => call(context, (native, signal) => native.transport.carryAbort(input, signal)),
      inspectArtifacts: (input, context) => call(context, async (native, signal) => {
        const files: HostOutput<"inspectArtifacts">["files"] = [], notPreserved: NonNullable<HostOutput<"inspectArtifacts">["notPreserved"]> = [];
        for (const relativePath of input.relativePaths) {
          try {
            const inspected = await native.artifacts.inspectArtifacts({ ...input, relativePaths: [relativePath] }, signal);
            files.push(...inspected.files);
          } catch (error) {
            if (!(error instanceof HostError) || error.code !== "artifact-unavailable" && error.code !== "unsafe-artifact") throw error;
            notPreserved.push({ relativePath, code: error.code, message: error.message });
          }
        }
        return { files, ...(notPreserved.length ? { notPreserved } : {}) };
      }),
      readArtifact: (input, context) => call(context, (native, signal) => native.artifacts.readArtifact(input, signal)),
      artifactChunk: (input, context) => call(context, (native, signal) => native.artifacts.artifactChunk(input, signal)),
      finishArtifact: (input, context) => call(context, (native, signal) => native.artifacts.finishArtifact(input, signal)),
    },
    dispose: async () => { closed = true; controller.abort(); await Promise.allSettled([...calls]); },
  });
}
