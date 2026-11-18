import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CHUNK_BYTES, hostContract, type Authority, type HostInput, type HostMethod, type HostOutput, type TransferRegistration } from "../../host-contract";
import type { HostPort } from "../../host/client";
import { sourceTransferReceiptSchema, type PlacementRecord, type SourceSnapshot, type SourceTransferReceipt } from "../../shared/placement";
import { requireSnapshotFetch } from "./capture";
import { readSourceIdentity, type SdkSource } from "./source-discovery";
import { PlacementStore } from "./store";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Manifest = HostOutput<"exportChanges">;
const sharedTransfers = new WeakMap<object, Map<string, Promise<SourceSnapshot>>>();

function validateManifest(snapshot: SourceSnapshot, value: unknown, head = snapshot.sourceHead): Manifest {
  const manifest = hostContract.exportChanges.output.parse(value);
  if (manifest.base !== snapshot.base || manifest.head !== head || manifest.tree !== snapshot.tree)
    throw new Error("The exported manifest does not match the immutable source snapshot");
  const paths = new Set<string>();
  for (const change of manifest.changes) {
    if (paths.has(change.path)) throw new Error("The exported manifest has duplicate paths");
    paths.add(change.path);
    if (change.status !== "D" && (change.mode === undefined || change.blob === undefined || change.size === undefined ||
        change.blob.length !== (snapshot.objectFormat === "sha1" ? 40 : 64)))
      throw new Error("The exported manifest has incomplete or wrong-format blob identity");
    if (change.status === "D" && (change.mode !== undefined || change.blob !== undefined || change.size !== undefined))
      throw new Error("A deleted manifest entry cannot carry blob metadata");
  }
  return manifest;
}

export class PlacementTransport {
  private readonly pending = new Map<string, { key: string; promise: Promise<SourceSnapshot> }>();
  private readonly lifetime = new AbortController();
  private readonly shared: Map<string, Promise<SourceSnapshot>>;
  private readonly operations = new Set<{ hosts: Set<string>; controller: AbortController }>();

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "onDispose">,
    private readonly host: HostPort,
    private readonly placements: PlacementStore,
  ) {
    this.shared = sharedTransfers.get(bb) ?? new Map();
    sharedTransfers.set(bb, this.shared);
    const unsubscribe = host.onWorkerExit(({ hostId }) => {
      for (const operation of this.operations) if (operation.hosts.has(hostId)) operation.controller.abort(new Error("The transport host worker exited; reconcile before retrying"));
    });
    bb.onDispose(() => { this.lifetime.abort(new Error("Placement transport disposed")); unsubscribe(); });
  }

  bringHome(placementId: string, generation: number, snapshotId: string, signal?: AbortSignal, desiredState: PlacementRecord["desiredState"] = "running"): Promise<SourceSnapshot> {
    const key = JSON.stringify([generation, snapshotId, desiredState]);
    const pending = this.pending.get(placementId);
    if (pending) {
      if (pending.key !== key) return Promise.reject(new Error("Another content transfer is in progress for this placement"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      return pending.promise;
    }
    const promise = this.dispatch(placementId, generation, snapshotId, signal, desiredState).finally(() => {
      if (this.pending.get(placementId)?.promise === promise) this.pending.delete(placementId);
    });
    this.pending.set(placementId, { key, promise });
    return promise;
  }

  private async dispatch(placementId: string, generation: number, snapshotId: string, caller: AbortSignal | undefined, desiredState: PlacementRecord["desiredState"]): Promise<SourceSnapshot> {
    const snapshot = this.placements.snapshot(snapshotId);
    if (desiredState === "released") {
      const record = this.placements.assertCurrent(placementId, generation, desiredState);
      if (record.preservation.snapshotId !== snapshotId || snapshot?.purpose !== "wip" ||
          !(record.phase === "preserving" || record.phase === "blocked" && record.resumePhase === "preserving"))
        throw new Error("A cancelled placement may transfer only its fenced preservation snapshot");
    }
    if (!snapshot?.ownerId) return this.run(placementId, generation, snapshotId, caller, desiredState);
    const record = this.placements.assertCurrent(placementId, generation, desiredState), owners = this.placements.snapshotOwners;
    const owner = owners.forDescriptor(snapshot);
    const current = () => {
      this.lifetime.signal.throwIfAborted(); caller?.throwIfAborted();
      const live = this.placements.assertCurrent(placementId, generation, desiredState), retained = owners.forDescriptor(snapshot);
      if (retained.generation !== owner.generation || retained.phase !== "retained") throw new Error("Stale snapshot owner generation or lifecycle");
      for (const key of ["sourceSnapshotId", "memberThreadId", "hostId", "environmentId", "root", "reviewTarget", "preservation"] as const)
        if (!isDeepStrictEqual(live[key], record[key])) throw new Error("The placement content assignment changed");
      if (snapshot.keeperThreadId !== live.keeperThreadId || snapshot.projectId !== live.projectId ||
          !([live.sourceSnapshotId, live.submissionSnapshotId, live.reviewTarget?.snapshotId, live.preservation.snapshotId].includes(snapshotId) ||
            snapshot.purpose === "submission" && snapshot.makerThreadId === live.memberThreadId && owners.hasSubmissionReadReference(placementId, generation, snapshotId)))
        throw new Error("Snapshot ownership or read reference does not match this placement");
      if (!(snapshot.purpose === "wip" && live.preservation.snapshotId === snapshot.id) && snapshot.purpose !== "initial" && (live.reviewTarget
        ? live.reviewTarget.snapshotId !== snapshotId || live.reviewTarget.expectedTree !== snapshot.tree ||
          live.reviewTarget.makerSubmissionId !== snapshot.makerSubmissionId || !isDeepStrictEqual(live.reviewTarget.journal, snapshot.journalTarget)
        : snapshot.makerThreadId !== live.memberThreadId)) throw new Error("Snapshot maker or review assignment does not match this placement");
      const observed = this.placements.snapshot(snapshotId);
      if (!isDeepStrictEqual({ ...observed, homeCommit: null }, { ...snapshot, homeCommit: null })) throw new Error("The immutable source descriptor changed");
    };
    current();
    const key = JSON.stringify([owner.id, owner.generation]);
    let pending = this.shared.get(key);
    if (!pending) {
      const running = this.runShared(snapshot, owner.generation, current, caller).finally(() => {
        if (this.shared.get(key) === running) this.shared.delete(key);
      });
      this.shared.set(key, running); pending = running;
    }
    await pending; current();
    const home = await readSourceIdentity(this.bb, snapshot.keeperThreadId, snapshot.projectId, caller); current();
    const receipt = owners.forDescriptor(snapshot).homeTransfer?.receipt;
    if (receipt?.phase !== "verified" || !isDeepStrictEqual(home.endpoint, receipt.homeSdk)) throw new Error("The SDK home endpoint changed after shared import");
    return this.placements.snapshot(snapshotId)!;
  }

  private async runShared(snapshot: SourceSnapshot, generation: number, placementCurrent: () => void, caller?: AbortSignal): Promise<SourceSnapshot> {
    const owners = this.placements.snapshotOwners, ownerId = snapshot.ownerId!, token = randomUUID();
    const fetch = requireSnapshotFetch(snapshot);
    if (!snapshot.sourceThreadId) throw new Error("Transport requires a source thread with a current SDK endpoint");
    const operation = { hosts: new Set([snapshot.source.hostId, snapshot.home.hostId]), controller: new AbortController() };
    const signal = AbortSignal.any([this.lifetime.signal, operation.controller.signal, ...(caller ? [caller] : [])]);
    placementCurrent(); owners.claimOperation(ownerId, generation, token); this.operations.add(operation);
    const current = () => { signal.throwIfAborted(); placementCurrent(); return owners.assertOperation(ownerId, generation, token); };
    let home: SdkSource, source: SdkSource | undefined;
    const phase = current().homeTransfer?.receipt.phase;
    const reconcileOnly = phase === "applying" || phase === "verified";
    const identities = async () => {
      current();
      const to = await readSourceIdentity(this.bb, snapshot.keeperThreadId, snapshot.projectId, signal); current();
      const from = reconcileOnly ? undefined : await readSourceIdentity(this.bb, snapshot.sourceThreadId!, snapshot.projectId, signal); current();
      return { from, to };
    };
    const fence = async () => {
      const next = await identities(); current();
      if (!isDeepStrictEqual(next.from, source) || !isDeepStrictEqual(next.to, home)) throw new Error("The SDK shared transport endpoint identity changed");
    };
    const call = async <M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>> => {
      current(); await fence(); current();
      const reply = await this.host.call(hostId, method, input, { signal }); current();
      await fence(); current();
      return hostContract[method].output.parse(reply) as HostOutput<M>;
    };
    try {
      const sdk = await identities(); current(); source = sdk.from; home = sdk.to;
      for (const [identity, endpoint] of [[source, snapshot.source], [home, snapshot.home]] as const)
        if (identity && (identity.endpoint.hostId !== endpoint.hostId || identity.endpoint.environmentId !== endpoint.environmentId))
          throw new Error("The SDK transport endpoint no longer matches the shared snapshot");
      const id = "home-" + digest(JSON.stringify([ownerId, generation]));
      const existing = current().homeTransfer;
      let receipt = owners.setHomeTransfer(ownerId, generation, token, {
        sourceOwnerThreadId: existing?.sourceOwnerThreadId ?? source!.keeperThreadId,
        homeOwnerThreadId: existing?.homeOwnerThreadId ?? home.keeperThreadId,
        receipt: sourceTransferReceiptSchema.parse({ id, generation, snapshotId: ownerId, direction: "bring-home",
          sourceEndpointId: id + "-source", homeEndpointId: id + "-home", verifyEndpointId: id + "-verify",
          sourceSdk: source?.endpoint ?? existing!.receipt.sourceSdk, homeSdk: home.endpoint,
          phase: "exporting", manifest: null, uploads: [], homeCommit: null }),
      });
      const binding = current().homeTransfer!;
      const authority = (endpointId: string): Authority => ({ placementId: "snapshot-" + ownerId, generation, endpointId, operationId: randomUUID() });
      const from = authority(receipt.sourceEndpointId), to = authority(receipt.homeEndpointId), verify = authority(receipt.verifyEndpointId);
      const registrations = [
        ...(!reconcileOnly ? [{ native: from, endpoint: snapshot.source, endpointSdk: receipt.sourceSdk, ownerThreadId: binding.sourceOwnerThreadId, access: "source-read" as const, refs: [] }] : []),
        { native: to, endpoint: snapshot.home, endpointSdk: receipt.homeSdk, ownerThreadId: binding.homeOwnerThreadId, access: "home-import" as const, refs: [snapshot.homeRef] },
        { native: verify, endpoint: snapshot.home, endpointSdk: receipt.homeSdk, ownerThreadId: binding.homeOwnerThreadId, access: "source-read" as const, refs: [] },
      ];
      for (const item of registrations) {
        const registered = await call(item.endpoint.hostId, "registerEndpoint", { placementId: item.native.placementId, generation, endpointId: item.native.endpointId,
          endpoint: item.endpointSdk, ownerThreadId: item.ownerThreadId, access: item.access, workspaceKind: null, objectFormat: snapshot.objectFormat, allowedRefs: item.refs }); current();
        if (registered.generation !== generation) throw new Error("The host acknowledged a stale snapshot owner generation");
        const inspected = await call(item.endpoint.hostId, "inspect", item.native); current();
        if (inspected.objectFormat !== snapshot.objectFormat) throw new Error("object-format-mismatch");
        if (inspected.root !== item.endpoint.root || !(item.access === "home-import" ? inspected.features.objectImport : inspected.features.exportChanges))
          throw new Error("The native shared transport root or capability does not match the snapshot");
      }
      const transfer = (native: Authority, head: string, transferId: string, uploads: string[], refs: string[]): TransferRegistration => ({
        ...native, transferId, snapshotId: ownerId, direction: "bring-home", objectFormat: snapshot.objectFormat,
        base: snapshot.base, head, tree: snapshot.tree, fromEndpointId: from.endpointId, toEndpointId: to.endpointId, allowedRefs: refs, uploads, artifacts: [],
      });
      const register = async (hostId: string, input: TransferRegistration) => {
        current(); const ack = await call(hostId, "registerTransfer", input); current();
        if (ack.transferId !== input.transferId) throw new Error("The host acknowledged another shared transfer identity");
      };
      let exported: Manifest;
      if (reconcileOnly) {
        const manifest = receipt.manifest!;
        if (digest(manifest.json) !== manifest.digest) throw new Error("The durable shared manifest digest changed");
        exported = validateManifest(snapshot, JSON.parse(manifest.json));
      } else {
        await register(snapshot.source.hostId, transfer(from, snapshot.sourceHead, id, [], [])); current();
        const observed = await call(snapshot.source.hostId, "exportChanges", { ...from, transferId: id }); current();
        exported = validateManifest(snapshot, observed);
      }
      const json = JSON.stringify(exported), manifest = { json, digest: digest(json) };
      const files = exported.changes.filter(change => change.status !== "D"), uploads = files.map((_, index) => id + "-" + index);
      if (receipt.manifest !== null && (!isDeepStrictEqual(receipt.manifest, manifest) || !isDeepStrictEqual(receipt.uploads, uploads)))
        throw new Error("The immutable shared transfer manifest changed on retry");
      if (receipt.manifest === null) receipt = owners.updateHomeTransfer(ownerId, generation, token, { manifest, uploads, phase: "uploading" });
      await register(snapshot.home.hostId, transfer(to, snapshot.sourceHead, id, uploads, [snapshot.homeRef])); current();
      if (!reconcileOnly) {
        for (const [index, file] of files.entries()) {
          const hash = createHash(snapshot.objectFormat).update(`blob ${file.size}\0`);
          for (let offset = 0; offset < file.size! || offset === 0; offset += CHUNK_BYTES) {
            const length = Math.min(CHUNK_BYTES, file.size! - offset);
            const chunk = await call(snapshot.source.hostId, "readBlob", { ...from, transferId: id, sha: file.blob!, offset, length }); current();
            const bytes = Buffer.from(chunk.data, "base64");
            if (bytes.length !== length || bytes.toString("base64") !== chunk.data) throw new Error("The host returned an invalid or truncated shared blob chunk");
            hash.update(bytes);
            const uploaded = await call(snapshot.home.hostId, "importChunk", { ...to, transferId: id, upload: uploads[index]!, offset, data: chunk.data }); current();
            if (uploaded.size < offset + length || uploaded.size > file.size!) throw new Error("The shared upload receipt has the wrong byte count");
          }
          if (hash.digest("hex") !== file.blob) throw new Error("The shared blob bytes do not match their immutable Git hash");
        }
        receipt = owners.updateHomeTransfer(ownerId, generation, token, { phase: "applying" });
      }
      const entries = exported.changes.map(change => change.status === "D" ? { path: change.path, delete: true as const }
        : { path: change.path, mode: change.mode!, upload: uploads[files.indexOf(change)]! });
      const made = await call(snapshot.home.hostId, "importCommit", { ...to, transferId: id, remote: fetch.remoteUrl, baseBranch: fetch.fetchRef,
        message: exported.message, author: exported.author, entries, refs: [snapshot.homeRef], networkTimeoutMs: 120_000 }); current();
      if (made.outcome === "unavailable") throw new Error(`Shared home import blocked [${made.code}]: ${made.message}`);
      if (made.outcome !== "ok") throw new Error("The imported home tree does not match the immutable shared snapshot");
      const verification = { ...transfer(verify, made.sha, id + "-verify", [], []), fromEndpointId: verify.endpointId };
      await register(snapshot.home.hostId, verification); current();
      const verified = await call(snapshot.home.hostId, "exportChanges", { ...verify, transferId: verification.transferId }); current();
      validateManifest(snapshot, verified, made.sha);
      await call(snapshot.home.hostId, "dropUploads", { ...to, transferId: id, uploads }); current();
      await fence(); current();
      owners.completeHomeTransfer(ownerId, generation, token, made.sha, snapshot.tree, snapshot.objectFormat);
      current(); return this.placements.snapshot(snapshot.id)!;
    } finally {
      owners.finishOperation(ownerId, generation, token); this.operations.delete(operation);
    }
  }

  private async run(placementId: string, generation: number, snapshotId: string, caller: AbortSignal | undefined, desiredState: PlacementRecord["desiredState"]): Promise<SourceSnapshot> {
    const record = this.placements.assertCurrent(placementId, generation, desiredState);
    const snapshot = this.placements.snapshot(snapshotId);
    if (!snapshot || snapshot.keeperThreadId !== record.keeperThreadId || snapshot.projectId !== record.projectId ||
        snapshot.purpose === "initial" && snapshot.id !== record.sourceSnapshotId ||
        snapshot.purpose !== "initial" && snapshot.makerThreadId !== record.memberThreadId)
      throw new Error("Snapshot ownership does not match this placement");
    const fetch = requireSnapshotFetch(snapshot);
    if (snapshot.sourceThreadId === null) throw new Error("Transport requires a source thread with a current SDK endpoint");
    const operation = { hosts: new Set([snapshot.source.hostId, snapshot.home.hostId]), controller: new AbortController() };
    this.operations.add(operation);
    const signal = AbortSignal.any([this.lifetime.signal, operation.controller.signal, ...(caller === undefined ? [] : [caller])]);
    const current = () => {
      signal.throwIfAborted();
      const live = this.placements.assertCurrent(placementId, generation, desiredState);
      for (const key of ["sourceSnapshotId", "memberThreadId", "hostId", "environmentId", "root", "reviewTarget"] as const)
        if (!isDeepStrictEqual(live[key], record[key])) throw new Error("The placement content assignment changed");
      return live;
    };
    let source: SdkSource, home: SdkSource;
    const identities = async () => {
      current();
      const from = await readSourceIdentity(this.bb, snapshot.sourceThreadId!, snapshot.projectId, signal); current();
      const to = await readSourceIdentity(this.bb, snapshot.keeperThreadId, snapshot.projectId, signal); current();
      return { from, to };
    };
    const fence = async () => {
      const next = await identities();
      if (!isDeepStrictEqual(next.from, source) || !isDeepStrictEqual(next.to, home)) throw new Error("The SDK transport endpoint identity changed");
    };
    const call = async <M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>> => {
      await fence(); current();
      const reply = await this.host.call(hostId, method, input, { signal }); current();
      await fence(); current();
      return hostContract[method].output.parse(reply) as HostOutput<M>;
    };
    try {
      const sdk = await identities(); source = sdk.from; home = sdk.to;
      for (const [identity, endpoint] of [[source, snapshot.source], [home, snapshot.home]] as const)
        if (identity.endpoint.hostId !== endpoint.hostId || identity.endpoint.environmentId !== endpoint.environmentId)
          throw new Error("The SDK transport endpoint no longer matches the snapshot");
      const id = "home-" + digest(JSON.stringify([placementId, generation, snapshotId]));
      const initial = sourceTransferReceiptSchema.parse({
        id, generation, snapshotId, direction: "bring-home", sourceEndpointId: id + "-source", homeEndpointId: id + "-home", verifyEndpointId: id + "-verify",
        sourceSdk: source.endpoint, homeSdk: home.endpoint, phase: "exporting", manifest: null, uploads: [], homeCommit: null,
      });
      let receipt = current().transfers?.find(transfer => transfer.id === id);
      if (receipt) {
        for (const key of ["generation", "snapshotId", "direction", "sourceEndpointId", "homeEndpointId", "verifyEndpointId", "sourceSdk", "homeSdk"] as const)
          if (!isDeepStrictEqual(receipt[key], initial[key])) throw new Error("Immutable transfer endpoint identity changed");
      } else {
        this.placements.update(placementId, generation, value => ({ ...value, transfers: [...(value.transfers ?? []), initial] }), desiredState);
        receipt = initial;
      }
      const authority = (endpointId: string): Authority => ({ placementId, generation, endpointId, operationId: randomUUID() });
      const from = authority(receipt.sourceEndpointId), to = authority(receipt.homeEndpointId), verify = authority(receipt.verifyEndpointId);
      for (const [native, identity, endpoint, access, refs] of [
        [from, source, snapshot.source, "source-read", []],
        [to, home, snapshot.home, "home-import", [snapshot.homeRef]],
        [verify, home, snapshot.home, "source-read", []],
      ] as const) {
        const registered = await call(endpoint.hostId, "registerEndpoint", { placementId, generation, endpointId: native.endpointId,
          endpoint: identity.endpoint, ownerThreadId: identity.keeperThreadId, access, workspaceKind: null, objectFormat: snapshot.objectFormat, allowedRefs: [...refs] });
        if (registered.generation !== generation) throw new Error("The host acknowledged a stale endpoint generation");
        const inspected = await call(endpoint.hostId, "inspect", native);
        if (inspected.objectFormat !== snapshot.objectFormat) throw new Error("object-format-mismatch");
        if (inspected.root !== endpoint.root || !(access === "home-import" ? inspected.features.objectImport : inspected.features.exportChanges))
          throw new Error("The native transport endpoint root or repository capability does not match the snapshot");
      }
      const transfer = (native: Authority, head: string, transferId: string, uploads: string[], refs: string[]): TransferRegistration => ({
        ...native, transferId, snapshotId, direction: "bring-home", objectFormat: snapshot.objectFormat,
        base: snapshot.base, head, tree: snapshot.tree, fromEndpointId: from.endpointId, toEndpointId: to.endpointId,
        allowedRefs: refs, uploads, artifacts: [],
      });
      const registeredTransfer = async (hostId: string, registration: TransferRegistration) => {
        const ack = await call(hostId, "registerTransfer", registration);
        if (ack.transferId !== registration.transferId) throw new Error("The host acknowledged another transfer identity");
      };
      await registeredTransfer(snapshot.source.hostId, transfer(from, snapshot.sourceHead, id, [], []));
      const exported = validateManifest(snapshot, await call(snapshot.source.hostId, "exportChanges", { ...from, transferId: id }));
      const json = JSON.stringify(exported), manifest = { json, digest: digest(json) };
      const files = exported.changes.filter(change => change.status !== "D");
      const uploads = files.map((_, index) => id + "-" + index);
      if (receipt.manifest !== null && (!isDeepStrictEqual(receipt.manifest, manifest) || !isDeepStrictEqual(receipt.uploads, uploads)))
        throw new Error("The immutable transfer manifest changed on retry");
      const update = (change: Partial<SourceTransferReceipt>) => {
        current();
        const updated = this.placements.update(placementId, generation, value => ({ ...value,
          transfers: value.transfers!.map(item => item.id === id ? { ...item, ...change } : item),
        }), desiredState);
        receipt = updated.transfers!.find(item => item.id === id)!;
      };
      if (receipt.manifest === null) update({ manifest, uploads, phase: "uploading" });
      await registeredTransfer(snapshot.home.hostId, transfer(to, snapshot.sourceHead, id, uploads, [snapshot.homeRef]));
      if (receipt.phase !== "verified") {
        for (const [index, file] of files.entries()) {
          const hash = createHash(snapshot.objectFormat).update(`blob ${file.size}\0`);
          for (let offset = 0; offset < file.size! || offset === 0; offset += CHUNK_BYTES) {
            const length = Math.min(CHUNK_BYTES, file.size! - offset);
            const chunk = await call(snapshot.source.hostId, "readBlob", { ...from, transferId: id, sha: file.blob!, offset, length });
            const bytes = Buffer.from(chunk.data, "base64");
            if (bytes.length !== length || bytes.toString("base64") !== chunk.data) throw new Error("The host returned an invalid or truncated blob chunk");
            hash.update(bytes);
            const uploaded = await call(snapshot.home.hostId, "importChunk", { ...to, transferId: id, upload: uploads[index]!, offset, data: chunk.data });
            if (uploaded.size < offset + length || uploaded.size > file.size!) throw new Error("The host upload receipt has the wrong byte count");
          }
          if (hash.digest("hex") !== file.blob) throw new Error("The exported blob bytes do not match their immutable Git hash");
        }
        update({ phase: "applying" });
      }
      const entries = exported.changes.map(change => change.status === "D" ? { path: change.path, delete: true as const }
        : { path: change.path, mode: change.mode!, upload: uploads[files.indexOf(change)]! });
      const made = await call(snapshot.home.hostId, "importCommit", { ...to, transferId: id, remote: fetch.remoteUrl,
        baseBranch: fetch.fetchRef, message: exported.message, author: exported.author, entries, refs: [snapshot.homeRef], networkTimeoutMs: 120_000 });
      if (made.outcome === "unavailable") throw new Error(`Home import blocked [${made.code}]: ${made.message}`);
      if (made.outcome !== "ok") throw new Error("The imported home tree does not match the immutable source snapshot");
      const verification = { ...transfer(verify, made.sha, id + "-verify", [], []), fromEndpointId: verify.endpointId };
      await registeredTransfer(snapshot.home.hostId, verification);
      validateManifest(snapshot, await call(snapshot.home.hostId, "exportChanges", { ...verify, transferId: verification.transferId }), made.sha);
      await call(snapshot.home.hostId, "dropUploads", { ...to, transferId: id, uploads });
      await fence(); current();
      return this.placements.completeHomeTransfer(placementId, generation, id, made.sha, snapshot.tree, snapshot.objectFormat, desiredState);
    } finally { this.operations.delete(operation); }
  }
}
