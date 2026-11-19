import { randomUUID } from "node:crypto";
import { hostContract, sourceBaseSchema, type HostOutput } from "../../host-contract";
import type { HostPort } from "../../host/client";
import { sourceFetchSchema, type SourceFetch, type SourceSnapshot } from "../../shared/placement";
import { SourceDiscovery, type KnownSource } from "./source-discovery";
import { PlacementStore } from "./store";

export class SourceCaptureError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message); this.name = "SourceCaptureError";
  }
}

export function requireSnapshotFetch(snapshot: SourceSnapshot): SourceFetch {
  if (snapshot.fetch === undefined)
    throw new SourceCaptureError("source-fetch-provenance-missing", "This older snapshot has no pinned fetch provenance; capture its source again before transporting it.");
  return sourceFetchSchema.parse(snapshot.fetch);
}

export class SourceCapture {
  constructor(
    private readonly discovery: SourceDiscovery,
    private readonly host: HostPort,
    private readonly placements: PlacementStore,
  ) {}

  async initial(source: KnownSource, signal?: AbortSignal, options?: { pushedBaseOnly?: boolean }): Promise<SourceSnapshot> {
    signal?.throwIfAborted();
    await this.discovery.revalidate(source, signal);
    const inspection = source.inspection;
    if (!inspection.features.exportChanges)
      throw new SourceCaptureError("source-root-required", "Use a Keeper environment at the repository root. Tavern cannot carry a folder inside a larger Git repository without copying files outside that folder.");
    if (options?.pushedBaseOnly) {
      const pushed = hostContract.pushedBase.output.parse(await this.host.call(source.endpoint.hostId, "pushedBase", {
        placementId: source.authorityId, generation: source.generation, endpointId: source.endpointId, operationId: randomUUID(),
      }, signal === undefined ? undefined : { signal }));
      signal?.throwIfAborted();
      await this.discovery.revalidate(source, signal);
      const endpoint = { ...source.endpoint, root: pushed.root };
      return this.placements.captureSnapshot({ purpose: "initial", keeperThreadId: source.keeperThreadId, projectId: source.projectId,
        sourceThreadId: source.keeperThreadId, makerThreadId: null, makerSubmissionId: null, journalTarget: null,
        objectFormat: inspection.objectFormat, base: pushed.base, sourceHead: pushed.base, tree: pushed.tree, fetch: pushed.fetch,
        includesUncommitted: false, userHead: pushed.base, modifiedPaths: 0, untrackedPaths: 0, source: endpoint, home: endpoint });
    }
    if (inspection.sourceBase === undefined)
      throw new SourceCaptureError("source-base-unavailable", "The source worker did not supply a read-only source base; update or reconnect it before capturing source.", true);
    const sourceBase = sourceBaseSchema.parse(inspection.sourceBase);
    if (sourceBase.outcome === "unavailable")
      throw new SourceCaptureError(sourceBase.code, sourceBase.message, sourceBase.retryable);
    const { outcome: _outcome, base, ...provenance } = sourceBase;
    const fetch = sourceFetchSchema.parse(provenance);
    let state: HostOutput<"snapshotWorktree">;
    try {
      state = hostContract.snapshotWorktree.output.parse(await this.host.call(source.endpoint.hostId, "snapshotWorktree", {
        placementId: source.authorityId, generation: source.generation, endpointId: source.endpointId,
        operationId: randomUUID(), base,
      }, signal === undefined ? undefined : { signal }));
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error) {
        const reason = error as Error & { code?: string; retryable?: boolean };
        throw new SourceCaptureError(reason.code ?? "source-snapshot-failed", reason.message, reason.retryable ?? false);
      }
      throw error;
    }
    signal?.throwIfAborted();
    await this.discovery.revalidate(source, signal);
    if ("outcome" in state) throw new SourceCaptureError(state.code, state.message, state.retryable);
    if (state.head !== inspection.head || state.headTree !== inspection.tree)
      throw new SourceCaptureError("source-changed", "The source head or tree changed during capture; inspect it again before retrying.", true);
    return this.placements.captureSnapshot({
      purpose: "initial", keeperThreadId: source.keeperThreadId, projectId: source.projectId,
      sourceThreadId: source.keeperThreadId, makerThreadId: null, makerSubmissionId: null, journalTarget: null,
      objectFormat: inspection.objectFormat, base, sourceHead: state.commit, tree: state.tree, fetch,
      includesUncommitted: state.includesUncommitted, userHead: state.head,
      ...(state.includesUncommitted ? { uncommittedOrigin: source.endpoint } : {}),
      modifiedPaths: state.modifiedPaths, untrackedPaths: state.untrackedPaths,
      source: source.endpoint, home: source.endpoint,
    });
  }
}
