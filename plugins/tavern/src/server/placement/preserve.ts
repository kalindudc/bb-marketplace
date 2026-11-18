import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CHUNK_BYTES, hostContract, repoPathSchema, type Authority, type HostInput, type HostMethod, type HostOutput } from "../../host-contract";
import type { HostPort } from "../../host/client";
import { artifactManifestSchema, endpointSchema, sourceFetchSchema, type Endpoint, type PlacementRecord, type SourceSnapshot } from "../../shared/placement";
import type { ContentHoldToken } from "../away/holds";
import type { AwayRuntime } from "../away/runtime";
import type { JournalStore } from "../journal/store";
import { isNotFound } from "../host-errors";
import { isQuiescentThread } from "./quiescence";
import type { KeeperStore } from "../keeper/store";
import type { PlacementServices } from "./services";
import { readSourceIdentity } from "./source-discovery";
import type { PlacementStore } from "./store";
import type { PlacementTransport } from "./transport";

type Holds = Pick<AwayRuntime, "requestContentHold" | "confirmHeld" | "inspectHeld" | "finishContentHold">;
type Journal = { prepare: JournalStore["prepare"]; get(threadId: string): Pick<ReturnType<JournalStore["get"]>, "entries"> };
export type PreservationResult = { state: "unplaced" | "released" } | { state: "waiting" | "blocked" | "lost"; message: string };
const activitySchema = z.object({ updatedAt: z.number(), latestAttentionAt: z.number(), queuedMessageCount: z.number().int().nonnegative() }).strict();
const savedManifestSchema = artifactManifestSchema.safeExtend({ activityBaseline: activitySchema.optional(), home: endpointSchema.optional() });
type SavedManifest = z.infer<typeof savedManifestSchema>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
class MemberBusy extends Error {}

export function hasLostOwner(record: PlacementRecord): boolean {
  return ["lost", "unknown", "unpreserved"].includes(record.preservation.source) || record.blocked?.code === "preservation-owner-lost" ||
    record.preservation.source === "saved" && record.preservation.artifacts === "unknown" && record.preservation.liveOwnerThreadId === null;
}

export class PlacementPreservation {
  private readonly pending = new Map<string, Promise<PreservationResult>>();
  private readonly lifetime = new AbortController();
  private readonly operations = new Map<string, AbortController>();

  static observe(bb: BbPluginApi, services: () => Pick<PlacementServices, "store" | "preserve">): void {
    const lost = (matches: (record: PlacementRecord) => boolean, reason: string) => {
      for (let after: string | null = null; ;) {
        const page = services().store.activePage(after, 1000);
        for (const record of page) if (record.memberThreadId && matches(record)) services().preserve.observeLoss(record.memberThreadId, reason);
        if (page.length < 1000) break;
        after = page[page.length - 1]!.id;
      }
    };
    bb.events.on("experimental_host.deleted", ({ host }) => lost(record => record.hostId === host.id, `The member host ${host.id} was removed before controlled release.`));
    bb.events.on("experimental_environment.removed", ({ removal }) => lost(record => record.environmentId === removal.environmentId, `The member environment ${removal.environmentId} was removed before controlled release.`));
  }

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "onDispose">,
    private readonly host: HostPort,
    private readonly placements: PlacementStore,
    private readonly holds: Holds,
    private readonly keepers: KeeperStore,
    private readonly journal: Journal,
    private readonly transport: PlacementTransport,
  ) {
    bb.onDispose(() => this.lifetime.abort(new Error("Placement preservation disposed")));
  }

  manifest(id: string): SavedManifest | null {
    const row = this.keepers.db.prepare("SELECT data FROM tavern_records WHERE kind='placementArtifactManifests' AND id=?").get(id) as { data: string } | undefined;
    if (!row) return null;
    const manifest = savedManifestSchema.parse(JSON.parse(row.data));
    if (manifest.id !== id) throw new Error("The preservation manifest identity changed");
    return manifest;
  }

  private saveManifest(manifest: SavedManifest): void {
    const parsed = savedManifestSchema.parse(manifest);
    this.keepers.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('placementArtifactManifests',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(parsed.id, JSON.stringify(parsed));
  }

  observeLoss(threadId: string, reason: string): void {
    const record = this.placements.byMember(threadId);
    if (!record || record.phase === "released") return;
    const saved = (record.preservation.source === "saved" || record.preservation.source === "not-needed") && (["saved", "not-declared"].includes(record.preservation.artifacts) || record.preservation.artifacts === "unpreserved" && record.preservation.artifactManifestId !== null);
    if (saved && (record.phase === "releasing" || record.phase === "blocked" && record.resumePhase === "releasing")) return;
    this.operations.get(threadId)?.abort(new Error(reason));
    if (record.preservation.source === "saved" && record.preservation.artifacts === "pending") reason = `Declared artifacts are unknown. ${reason}`;
    this.placements.update(record.id, record.generation, value => ({ ...value, phase: "preserving", blocked: null, resumePhase: null,
      preservation: { ...value.preservation, source: value.preservation.source === "saved" ? "saved" : "lost",
        artifacts: value.preservation.artifacts === "pending" ? "unknown" : value.preservation.artifacts, liveOwnerThreadId: null, stopConfirmed: false, reason },
    }), record.desiredState);
    this.placements.block(record.id, record.generation, { stage: "preserve", code: "preservation-owner-lost", message: reason, retryable: false }, record.desiredState);
  }

  beforeRelease(threadId: string, reason: string): Promise<PreservationResult> {
    const pending = this.pending.get(threadId);
    if (pending) return pending;
    const promise = this.run(threadId, reason).finally(() => { if (this.pending.get(threadId) === promise) this.pending.delete(threadId); });
    this.pending.set(threadId, promise);
    return promise;
  }

  private async finishLost(record: PlacementRecord): Promise<PreservationResult> {
    const threadId = record.memberThreadId;
    if (!threadId) throw new Error("A lost member placement has no member identity");
    let message = record.preservation.reason ?? "The member owner was lost before preservation finished.";
    if (record.phase === "released") return { state: "lost", message };
    const signal = this.lifetime.signal;
    const current = () => { signal.throwIfAborted(); return this.placements.assertCurrent(record.id, record.generation, record.desiredState); };
    const snapshot = record.preservation.snapshotId ? this.placements.snapshot(record.preservation.snapshotId) : null;
    const manifest = record.preservation.artifactManifestId ? this.manifest(record.preservation.artifactManifestId) : null;
    const home = manifest?.home ?? snapshot?.home;
    try {
      if (home) for (const endpointId of ["preserve-home", ...(manifest?.files.length ? ["preserve-artifact-store"] : [])]) {
        current();
        try {
          const reply = await this.host.call(home.hostId, "releaseEndpoint", { placementId: record.id, generation: record.generation, endpointId, operationId: randomUUID() }, { signal });
          current();
          if (!reply.released) throw new Error("The native home endpoint release was not acknowledged");
        } catch (error) {
          current();
          message += ` Home endpoint ${endpointId} cleanup was not confirmed: ${error instanceof Error ? error.message : String(error)}`;
          this.placements.update(record.id, record.generation, value => ({ ...value, preservation: { ...value.preservation, reason: message } }), record.desiredState);
        }
      }
      let thread;
      try { thread = await this.bb.sdk.threads.get({ threadId, signal }); current(); }
      catch (error) { current(); if (!isNotFound(error)) throw error; thread = null; }
      if (thread && thread.archivedAt === null && thread.deletedAt === null) {
        await this.bb.sdk.threads.archive({ threadId, signal }); current();
        try { thread = await this.bb.sdk.threads.get({ threadId, signal }); current(); }
        catch (error) { current(); if (!isNotFound(error)) throw error; thread = null; }
        if (thread && thread.archivedAt === null && thread.deletedAt === null) throw new Error("The lost member's archive is not confirmed; retry cleanup");
      }
      const source = record.preservation.source === "saved" ? "saved" : record.preservation.source === "lost" ? "lost" : "unknown";
      this.keepers.db.transaction(() => {
        const cancelled = record.desiredState === "released" ? current() : this.placements.cancel(record.id, record.generation);
        this.placements.update(cancelled.id, cancelled.generation, value => ({ ...value, phase: "releasing", blocked: null, resumePhase: null,
          preservation: { ...record.preservation, source, liveOwnerThreadId: null, stopConfirmed: true, reason: message },
        }), "released");
        this.placements.finishRelease(cancelled.id, cancelled.generation, true);
        const member = this.keepers.get("members", threadId);
        const outcome = source === "saved" ? record.preservation.artifacts === "unknown" ? "its source was saved; declared artifacts are unknown" : "its work was saved" : "its work was not saved";
        this.keepers.event(Date.now(), record.keeperThreadId, record.questId, "member.work-lost", `Released ${member?.displayName ?? threadId}; ${outcome}: ${message.replace(/^Declared artifacts are unknown\. /, "")}`, { memberThreadId: threadId, placementId: record.id });
      }).immediate();
      return { state: "lost", message };
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      current();
      this.placements.block(record.id, record.generation, { stage: "release", code: "loss-cleanup-pending", message: failure, retryable: true }, record.desiredState);
      return { state: "blocked", message: failure };
    }
  }

  private async run(threadId: string, reason: string): Promise<PreservationResult> {
    const record = this.placements.byMember(threadId);
    if (!record) return { state: "unplaced" };
    if (hasLostOwner(record)) return this.finishLost(record);
    if (record.phase === "released") return { state: "released" };
    const member = this.keepers.get("members", threadId);
    if (!member) return { state: "blocked", message: "The placed member's private owner is missing; its resources have not been released." };
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.operations.set(threadId, controller);
    const current = () => {
      signal.throwIfAborted();
      const live = this.placements.assertCurrent(record.id, record.generation, record.desiredState);
      for (const key of ["memberThreadId", "hostId", "environmentId", "root", "sourceSnapshotId", "submissionSnapshotId", "reviewTarget"] as const)
        if (!isDeepStrictEqual(live[key], record[key])) throw new Error("The preservation placement assignment changed");
      return live;
    };
    const update = (change: (value: PlacementRecord) => PlacementRecord) => { current(); return this.placements.update(record.id, record.generation, change, record.desiredState); };
    let token: ContentHoldToken | undefined;
    let capturedActivity: unknown;
    let archiveConfirmed = false;
    const waiting = () => `Waiting for ${member.displayName ?? member.title ?? threadId} to finish its turn so its work can be saved.${member.stopPending || /stop unconfirmed/i.test(reason) ? " Stop unconfirmed." : ""}`;
    const block = (message: string, code: string, stage: "preserve" | "release" = "preserve", retryable = true) => {
      current();
      const live = this.placements.get(record.id)!;
      this.placements.block(record.id, record.generation, { stage, code, message, retryable }, record.desiredState);
      this.placements.update(record.id, record.generation, value => ({ ...value, preservation: { ...value.preservation, reason: message,
        liveOwnerThreadId: archiveConfirmed ? null : live.preservation.liveOwnerThreadId } }), record.desiredState);
    };
    let releasing = record.phase === "releasing" || record.phase === "blocked" && record.resumePhase === "releasing";
    try {
      if (releasing) {
        const thread = await this.bb.sdk.threads.get({ threadId, signal }); current();
        if (thread.archivedAt === null && thread.deletedAt === null) releasing = false;
      }
      const initialThread = await this.bb.sdk.threads.get({ threadId, signal }); current();
      let neverProvisioned = false;
      if (!releasing && !record.environmentId && !record.hostId && !record.root && initialThread.environmentId === null &&
          isQuiescentThread(initialThread) && initialThread.archivedAt === null && initialThread.deletedAt === null) {
        const confirmed = await this.bb.sdk.threads.get({ threadId, signal }); current();
        neverProvisioned = isDeepStrictEqual(initialThread, confirmed);
      }
      if (!releasing) {
        update(value => ({ ...value, phase: "preserving", blocked: null, resumePhase: null,
          preservation: { ...value.preservation, source: "pending", liveOwnerThreadId: threadId, stopConfirmed: false, reason } }));
        const active = (thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>) => {
          current();
          if (thread.id !== threadId || thread.projectId !== record.projectId) throw new Error("The preservation thread identity changed");
          if (thread.archivedAt !== null || thread.deletedAt !== null) { this.observeLoss(threadId, "The member thread was archived or deleted before preservation finished."); signal.throwIfAborted(); }
          if (!isQuiescentThread(thread) || this.keepers.get("members", threadId)?.stopPending) throw new MemberBusy(waiting());
          if (neverProvisioned && thread.environmentId !== null) throw new Error("The member environment attached during preservation; retry cleanup");
          return [thread.updatedAt, thread.latestAttentionAt, thread.queuedMessageCount];
        };
        active(await this.bb.sdk.threads.get({ threadId, signal })); current();
        token = this.holds.requestContentHold(threadId, { operationId: "preserve-" + randomUUID(), idleOnly: true, preservation: true });
        const confirmed = await this.holds.confirmHeld(token); current();
        if (confirmed.state === "pending") throw new MemberBusy(waiting());
        if (confirmed.state !== "confirmed") throw new Error(confirmed.error ?? "The preservation content hold is stale");
        const baseline = active(await this.bb.sdk.threads.get({ threadId, signal })); capturedActivity = baseline;
        if (!neverProvisioned && initialThread.environmentId === null) throw new Error("The member has no provisioned environment; retry once its state is confirmed");
        const source = neverProvisioned ? null : await readSourceIdentity(this.bb, threadId, record.projectId, signal); current();
        const home = await readSourceIdentity(this.bb, record.keeperThreadId, record.projectId, signal); current();
        if (source && !record.hostId && !record.environmentId && !record.root) {
          update(value => ({ ...value, hostId: source.endpoint.hostId, environmentId: source.endpoint.environmentId, root: source.endpoint.root }));
          Object.assign(record, { hostId: source.endpoint.hostId, environmentId: source.endpoint.environmentId, root: source.endpoint.root });
        }
        if (source && record.hostId && (record.hostId !== source.endpoint.hostId || record.environmentId !== source.endpoint.environmentId || record.root !== source.endpoint.root))
          throw new Error("The member SDK endpoint no longer matches its placement");
        const storage = await this.bb.sdk.threads.storageLocation({ threadId, signal }); current();
        const held = () => { current(); if (this.holds.inspectHeld(token!).state !== "confirmed") throw new Error("The preservation content hold is no longer confirmed"); };
        const fence = async () => {
          held();
          if (!isDeepStrictEqual(active(await this.bb.sdk.threads.get({ threadId, signal })), baseline)) throw new MemberBusy(waiting());
          held();
          const from = neverProvisioned ? null : await readSourceIdentity(this.bb, threadId, record.projectId, signal); held();
          const to = await readSourceIdentity(this.bb, record.keeperThreadId, record.projectId, signal); held();
          const location = await this.bb.sdk.threads.storageLocation({ threadId, signal }); held();
          if (!isDeepStrictEqual(from, source) || !isDeepStrictEqual(to, home) || !isDeepStrictEqual(storage, location)) throw new Error("The preservation SDK endpoint identity changed");
        };
        const call = async <M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>> => {
          await fence();
          const reply = await this.host.call(hostId, method, input, { signal }); held(); await fence();
          return hostContract[method].output.parse(reply) as HostOutput<M>;
        };
        const authority = (endpointId: string): Authority => ({ placementId: record.id, generation: record.generation, endpointId, operationId: randomUUID() });
        const register = async (endpointId: string, endpoint: Endpoint, ownerThreadId: string, access: "source-read" | "artifact-read" | "artifact-store") => {
          const ack = await call(endpoint.hostId, "registerEndpoint", { placementId: record.id, generation: record.generation, endpointId, endpoint, ownerThreadId, access, workspaceKind: null, objectFormat: null, allowedRefs: [] });
          if (ack.generation !== record.generation) throw new Error("The preservation endpoint acknowledged a stale generation");
          return authority(endpointId);
        };
        let snapshot: SourceSnapshot | null = null;
        if (source) {
          const from = await register("preserve-source", source.endpoint, threadId, "source-read");
          const inspection = await call(source.endpoint.hostId, "inspect", from);
          if (inspection.root !== source.endpoint.root || !inspection.features.exportChanges) throw new Error("Preservation requires the member's complete repository root");
          const base = inspection.sourceBase;
          if (!base || base.outcome !== "ok") throw new Error(base?.message ?? "The member has no fetchable source base for preservation");
          const captured = await call(source.endpoint.hostId, "snapshotWorktree", { ...from, base: base.base });
          if ("outcome" in captured) {
            block(captured.message, captured.code, "preserve", captured.retryable);
            return { state: "blocked", message: captured.message };
          }
          if (captured.head !== inspection.head || captured.headTree !== inspection.tree) throw new Error("The member source changed during preservation; retry when it is idle");
          const pinned = [record.preservation.snapshotId, record.submissionSnapshotId, record.sourceSnapshotId]
            .map(id => id ? this.placements.snapshot(id) : null)
            .find(snapshot => snapshot?.homeCommit && snapshot.objectFormat === inspection.objectFormat && snapshot.tree === captured.tree &&
              isDeepStrictEqual(snapshot.home, home.endpoint));
          if (pinned) snapshot = pinned;
          else {
            const { outcome: _outcome, base: _base, ...fetch } = base;
            snapshot = this.placements.captureSnapshot({ purpose: "wip", keeperThreadId: record.keeperThreadId, projectId: record.projectId,
              sourceThreadId: threadId, makerThreadId: threadId, makerSubmissionId: null, journalTarget: null,
              objectFormat: inspection.objectFormat, base: base.base, sourceHead: captured.commit, tree: captured.tree,
              fetch: sourceFetchSchema.parse(fetch), source: { ...source.endpoint, root: inspection.root }, home: home.endpoint,
              includesUncommitted: captured.includesUncommitted, userHead: captured.head,
              ...(captured.includesUncommitted ? { uncommittedOrigin: source.endpoint } : {}), modifiedPaths: captured.modifiedPaths, untrackedPaths: captured.untrackedPaths });
          }
          const capturedSnapshotId = snapshot.id;
          update(value => ({ ...value, preservation: { ...value.preservation, snapshotId: capturedSnapshotId } }));
          if (!snapshot.homeCommit) snapshot = await this.transport.bringHome(record.id, record.generation, snapshot.id, signal, record.desiredState);
          held(); await fence();
        }
        const snapshotId = snapshot?.id ?? null;
        update(value => ({ ...value, preservation: { ...value.preservation, source: neverProvisioned ? "not-needed" : "saved", snapshotId,
          reason: neverProvisioned ? "never provisioned" : reason } }));
        const homeAuthority = await register("preserve-home", home.endpoint, record.keeperThreadId, "source-read");
        const homeInspection = await call(home.endpoint.hostId, "inspect", homeAuthority);
        await this.journal.prepare(threadId); held();
        const declared = [...new Set(this.journal.get(threadId).entries.flatMap(entry => entry.evidence.filter(item => item.kind === "file").map(item => item.ref)))];
        if (declared.length > 50_000) throw new Error("The declared evidence exceeds the 50,000-file preservation limit");
        const roots = [...(source ? [{ endpointId: "preserve-artifacts-workspace", endpoint: source.endpoint }] : []), { endpointId: "preserve-artifacts-storage", endpoint: { hostId: storage.hostId, environmentId: null, root: storage.storageRootPath } }];
        const artifactBatch = snapshot ?? { id: "preserve-artifacts-" + digest([record.id, record.generation]), objectFormat: homeInspection.objectFormat,
          base: homeInspection.head, sourceHead: homeInspection.head, tree: homeInspection.tree };
        const manifest: SavedManifest = { home: home.endpoint, activityBaseline: activitySchema.parse({ updatedAt: baseline[0], latestAttentionAt: baseline[1], queuedMessageCount: baseline[2] }), id: "preserve-" + digest([record.id, record.generation, artifactBatch.id]), placementId: record.id,
          placementGeneration: record.generation, snapshotId: artifactBatch.id, files: [], saved: [], notPreserved: [] };
        const registered = new Set<string>();
        for (const path of declared) {
          if (!repoPathSchema.safeParse(posix.isAbsolute(path) ? path.slice(1) : path).success) { manifest.notPreserved.push(`${path}: unsafe artifact path`); continue; }
          if (!posix.isAbsolute(path) && !source) { manifest.notPreserved.push(`${path}: the member has no provisioned checkout for this relative path`); continue; }
          const absolute = posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(source!.endpoint.root, path);
          const root = roots.filter(root => absolute.startsWith(root.endpoint.root.replace(/\/$/, "") + "/")).sort((a, b) => b.endpoint.root.length - a.endpoint.root.length)[0];
          if (!root) { manifest.notPreserved.push(`${path}: outside the allowed checkout and thread-storage roots`); continue; }
          const relativePath = posix.relative(root.endpoint.root, absolute);
          if (!repoPathSchema.safeParse(relativePath).success) { manifest.notPreserved.push(`${path}: unsafe artifact path`); continue; }
          if (!registered.has(root.endpointId)) { await register(root.endpointId, root.endpoint, threadId, "artifact-read"); registered.add(root.endpointId); }
          try {
            const inspected = await call(root.endpoint.hostId, "inspectArtifacts", { ...authority(root.endpointId), relativePaths: [relativePath] });
            if (inspected.notPreserved?.length) {
              if (inspected.files.length || inspected.notPreserved.length !== 1 || inspected.notPreserved[0]!.relativePath !== relativePath) throw new Error("The artifact refusal did not match its declaration");
              manifest.notPreserved.push(`${path}: ${inspected.notPreserved[0]!.message}`);
              continue;
            }
            if (inspected.files.length !== 1 || inspected.files[0]!.relativePath !== relativePath || inspected.files[0]!.sourceEndpointId !== root.endpointId) throw new Error("The artifact inspection did not match its declaration");
            if (!manifest.files.some(file => file.id === inspected.files[0]!.id)) manifest.files.push(inspected.files[0]!);
          } catch (error) {
            held();
            if (!error || typeof error !== "object" || !("code" in error) || !["artifact-unavailable", "unsafe-artifact"].includes(String(error.code))) throw error;
            manifest.notPreserved.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        this.saveManifest(manifest);
        update(value => ({ ...value, preservation: { ...value.preservation, artifactManifestId: manifest.id, artifacts: declared.length ? "pending" : "not-declared" } }));
        if (manifest.files.length) {
          if (!homeInspection.artifactDirectory) throw new Error("The home host did not report durable artifact storage");
          const to = await register("preserve-artifact-store", { hostId: home.endpoint.hostId, environmentId: null, root: homeInspection.artifactDirectory }, record.keeperThreadId, "artifact-store");
          for (const file of manifest.files) {
            const root = roots.find(root => root.endpointId === file.sourceEndpointId)!;
            const transferId = "artifact-" + digest([manifest.id, file.id]);
            const transfer = { transferId, snapshotId: artifactBatch.id, direction: "artifacts" as const, objectFormat: artifactBatch.objectFormat,
              base: artifactBatch.base, head: artifactBatch.sourceHead, tree: artifactBatch.tree, fromEndpointId: file.sourceEndpointId, toEndpointId: to.endpointId, allowedRefs: [], uploads: [], artifacts: [file] };
            const sourceAuthority = { ...authority(file.sourceEndpointId), transferId }, targetAuthority = { ...to, transferId };
            for (const [hostId, native] of [[root.endpoint.hostId, sourceAuthority], [home.endpoint.hostId, targetAuthority]] as const) {
              const ack = await call(hostId, "registerTransfer", { ...native, ...transfer });
              if (ack.transferId !== transferId) throw new Error("The host acknowledged a different artifact transfer");
            }
            const hash = createHash("sha256");
            for (let offset = 0; offset < file.size || offset === 0; offset += CHUNK_BYTES) {
              const length = Math.min(CHUNK_BYTES, file.size - offset);
              const chunk = await call(root.endpoint.hostId, "readArtifact", { ...sourceAuthority, artifactId: file.id, offset, length });
              const bytes = Buffer.from(chunk.data, "base64");
              if (bytes.length !== length || bytes.toString("base64") !== chunk.data) throw new Error("The artifact host returned an invalid or truncated chunk");
              hash.update(bytes);
              const uploaded = await call(home.endpoint.hostId, "artifactChunk", { ...targetAuthority, artifactId: file.id, offset, data: chunk.data });
              if (uploaded.size < offset + length || uploaded.size > file.size) throw new Error("The artifact upload has the wrong byte count");
            }
            if (hash.digest("hex") !== file.sha256) throw new Error("The artifact bytes do not match their declared SHA-256");
            const saved = await call(home.endpoint.hostId, "finishArtifact", { ...targetAuthority, artifactId: file.id });
            if (saved.sha256 !== file.sha256 || saved.size !== file.size) throw new Error("The durable artifact receipt does not match its declared bytes");
            manifest.saved.push({ artifactId: file.id, storageKey: saved.storageKey, sha256: saved.sha256 }); this.saveManifest(manifest);
          }
        }
        await fence();
        if (!isDeepStrictEqual(declared, [...new Set(this.journal.get(threadId).entries.flatMap(entry => entry.evidence.filter(item => item.kind === "file").map(item => item.ref)))])) throw new Error("The declared journal evidence changed during preservation");
        update(value => ({ ...value, phase: "releasing", blocked: null, resumePhase: null, preservation: { ...value.preservation,
          artifacts: manifest.notPreserved.length ? "unpreserved" : declared.length ? "saved" : "not-declared", stopConfirmed: true,
          reason: (neverProvisioned ? "never provisioned" : reason) + (manifest.notPreserved.length ? "; Declared files not saved: " + manifest.notPreserved.join("; ") : "") } }));
        releasing = true;
      }
      let thread = await this.bb.sdk.threads.get({ threadId, signal }); current();
      if (thread.archivedAt === null && thread.deletedAt === null) {
        if (!isQuiescentThread(thread) || capturedActivity && !isDeepStrictEqual([thread.updatedAt, thread.latestAttentionAt, thread.queuedMessageCount], capturedActivity)) {
          releasing = false;
          update(value => ({ ...value, phase: "preserving", blocked: null, resumePhase: null, preservation: { ...value.preservation,
            source: "pending", artifacts: value.preservation.artifacts === "not-declared" ? "not-declared" : "pending", liveOwnerThreadId: threadId, stopConfirmed: false } }));
          throw new MemberBusy(waiting());
        }
        await this.bb.sdk.threads.archive({ threadId, signal }); current();
        thread = await this.bb.sdk.threads.get({ threadId, signal }); current();
        if (thread.archivedAt === null && thread.deletedAt === null) throw new Error("The member archive is not confirmed; its machine release is unknown");
      }
      archiveConfirmed = true;
      const live = current(), snapshot = live.preservation.snapshotId ? this.placements.snapshot(live.preservation.snapshotId) : null;
      if (!snapshot?.homeCommit && live.preservation.source !== "not-needed") throw new Error("The saved preservation snapshot is missing");
      const manifest = live.preservation.artifactManifestId ? this.manifest(live.preservation.artifactManifestId) : null;
      const home = manifest?.home ?? snapshot?.home;
      for (const endpointId of home ? ["preserve-home", ...(manifest && manifest.files.length ? ["preserve-artifact-store"] : [])] : []) {
        const reply = await this.host.call(home!.hostId, "releaseEndpoint", { placementId: record.id, generation: record.generation, endpointId, operationId: randomUUID() }, { signal }); current();
        if (!reply.released) throw new Error("The native home endpoint release was not acknowledged");
      }
      const cancelled = record.desiredState === "released" ? current() : this.placements.cancel(record.id, record.generation);
      this.placements.update(cancelled.id, cancelled.generation, value => ({ ...value, phase: "releasing", blocked: null, resumePhase: null,
        preservation: { ...live.preservation, liveOwnerThreadId: null, stopConfirmed: true } }), "released");
      this.placements.finishRelease(cancelled.id, cancelled.generation, true);
      return { state: "released" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const live = this.placements.get(record.id);
      if (live?.generation === record.generation && live.desiredState === record.desiredState && live.blocked?.code !== "preservation-owner-lost") {
        const details = message.slice(0, 16_000);
        block(details, error instanceof MemberBusy ? "preserve-member-busy" : "preservation-failed", releasing ? "release" : "preserve");
      }
      return { state: error instanceof MemberBusy ? "waiting" : "blocked", message };
    } finally {
      if (token) this.holds.finishContentHold(token);
      this.operations.delete(threadId);
    }
  }
}
