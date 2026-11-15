import { randomUUID } from "node:crypto";
import { sourceBaseSchema } from "../../host-contract";
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

  async initial(source: KnownSource, signal?: AbortSignal): Promise<SourceSnapshot> {
    signal?.throwIfAborted();
    await this.discovery.revalidate(source, signal);
    const inspection = source.inspection;
    if (!inspection.features.exportChanges)
      throw new SourceCaptureError("source-root-required", "Use a Keeper environment at the repository root. Tavern cannot carry a folder inside a larger Git repository without copying files outside that folder.");
    if (inspection.sourceBase === undefined)
      throw new SourceCaptureError("source-base-unavailable", "The source worker did not supply a read-only source base; update or reconnect it before capturing source.", true);
    const sourceBase = sourceBaseSchema.parse(inspection.sourceBase);
    if (sourceBase.outcome === "unavailable")
      throw new SourceCaptureError(sourceBase.code, sourceBase.message, sourceBase.retryable);
    const { outcome: _outcome, base, ...provenance } = sourceBase;
    const fetch = sourceFetchSchema.parse(provenance);
    const state = await this.host.call(source.endpoint.hostId, "worktreeState", {
      placementId: source.authorityId, generation: source.generation, endpointId: source.endpointId,
      operationId: randomUUID(), base,
    }, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    await this.discovery.revalidate(source, signal);
    if (state.dirty || state.unfinishedMerge)
      throw new SourceCaptureError("initial-source-dirty", "The user source has dirty files or an unfinished merge. Commit or resolve them yourself before capture; Tavern will not commit this checkout.");
    if (state.head !== inspection.head || state.tree !== inspection.tree)
      throw new SourceCaptureError("source-changed", "The source head or tree changed during capture; inspect it again before retrying.", true);
    return this.placements.captureSnapshot({
      purpose: "initial", keeperThreadId: source.keeperThreadId, projectId: source.projectId,
      sourceThreadId: source.keeperThreadId, makerThreadId: null, makerSubmissionId: null, journalTarget: null,
      objectFormat: inspection.objectFormat, base, sourceHead: inspection.head, tree: inspection.tree, fetch,
      source: source.endpoint, home: source.endpoint,
    });
  }
}
