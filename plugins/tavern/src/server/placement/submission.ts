import { memberHost } from "../member-engagement";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hostContract, type HostInput, type HostMethod, type HostOutput } from "../../host-contract";
import type { HostPort } from "../../host/client";
import { sourceFetchSchema, type Endpoint, type SourceSnapshot } from "../../shared/placement";
import { journalEntrySchema } from "../../shared/schema";
import type { ContentHoldToken } from "../away/holds";
import type { AwayRuntime } from "../away/runtime";
import type { JournalStore } from "../journal/store";
import type { KeeperStore, ReviewTarget } from "../keeper/store";
import { SourceCaptureError } from "./capture";
import { readSourceIdentity } from "./source-discovery";
import type { PlacementStore } from "./store";
import type { PlacementTransport } from "./transport";
import { isQuiescentThread } from "./quiescence";

type Holds = Pick<AwayRuntime, "requestContentHold" | "confirmHeld" | "inspectHeld" | "finishContentHold">;
type Journal = { prepare: JournalStore["prepare"]; get(threadId: string): Pick<ReturnType<JournalStore["get"]>, "entries"> };
export type SubmissionResult = { state: "captured"; snapshot: SourceSnapshot; reviewTarget: ReviewTarget } | { state: "maker-busy"; message: string };
class MakerBusy extends Error {}

export function journalEntryFingerprint(entry: ReturnType<typeof journalEntrySchema.parse>): string {
  const { review, updatedAt, updatedBy, report: _report, rewrites: _rewrites, doneAt: _doneAt, doneBy: _doneBy, status, ...work } = journalEntrySchema.parse(entry);
  const verdictOwned = review?.at === updatedAt && isDeepStrictEqual(review.actor, updatedBy) && ["verified", "rejected"].includes(status);
  return createHash("sha256").update(JSON.stringify({ ...work, note: verdictOwned ? review.previousNote : work.note, status: verdictOwned ? "done" : status })).digest("hex");
}

export class PlacementSubmissions {
  private readonly pending = new Map<string, { waypointId: string; promise: Promise<SubmissionResult> }>();
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<{ hosts: Set<string>; controller: AbortController }>();

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "onDispose">,
    private readonly host: HostPort,
    private readonly placements: PlacementStore,
    private readonly holds: Holds,
    private readonly keepers: KeeperStore,
    private readonly journal: Journal,
    private readonly transport: PlacementTransport,
  ) {
    const unsubscribe = host.onWorkerExit(({ hostId }) => {
      for (const operation of this.operations) if (operation.hosts.has(hostId)) operation.controller.abort(new Error("The submission host worker exited; retry capture after reconnecting"));
    });
    bb.onDispose(() => { this.lifetime.abort(new Error("Submission capture disposed")); unsubscribe(); });
  }

  capture(makerThreadId: string, waypointId: string, signal?: AbortSignal): Promise<SubmissionResult> {
    const pending = this.pending.get(makerThreadId);
    if (pending) {
      if (pending.waypointId !== waypointId) return Promise.reject(new Error("Another submission capture holds this maker"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      return pending.promise;
    }
    const promise = this.run(makerThreadId, waypointId, signal).finally(() => {
      if (this.pending.get(makerThreadId)?.promise === promise) this.pending.delete(makerThreadId);
    });
    this.pending.set(makerThreadId, { waypointId, promise });
    return promise;
  }

  private async run(makerThreadId: string, waypointId: string, caller?: AbortSignal): Promise<SubmissionResult> {
    const record = this.placements.byMember(makerThreadId), maker = this.keepers.get("members", makerThreadId);
    const canCapture = (member: NonNullable<typeof maker>) => member.state !== "failed" &&
      (member.engagement === "active" || member.engagement === "resting" || member.engagement === "briefing") &&
      memberHost(this.keepers, member).archivedAt === null;
    if (!record || record.slot !== "maker" || !["ready", "running"].includes(record.phase) || !record.hostId || !record.environmentId || !record.root ||
        !record.workspaceKind || !maker || maker.role !== "member" || maker.keeperThreadId !== record.keeperThreadId ||
        !record.questId || maker.boardQuestId !== record.questId || !canCapture(maker))
      throw new Error("Submission capture requires a content-ready active maker and its private placement");
    const busy = (): SubmissionResult => ({ state: "maker-busy", message: `Waiting for ${maker.displayName ?? maker.title ?? maker.threadId} to finish its turn before its work can be checked.` });
    const operation = { hosts: new Set([record.hostId]), controller: new AbortController() };
    const signal = AbortSignal.any([this.lifetime.signal, operation.controller.signal, ...(caller ? [caller] : [])]);
    this.operations.add(operation);
    let token: ContentHoldToken | undefined;
    const entries = () => this.journal.get(makerThreadId).entries.filter(entry => entry.threadId === makerThreadId && entry.link?.boardQuestId === record.questId && entry.link.waypointId === waypointId).map(entry => journalEntrySchema.parse(entry));
    let pinnedEntries: ReturnType<typeof entries> | undefined;
    const current = () => {
      signal.throwIfAborted();
      const live = this.placements.assertCurrent(record.id, record.generation), member = this.keepers.get("members", makerThreadId);
      for (const key of ["memberThreadId", "hostId", "environmentId", "root", "workspaceKind", "reviewTarget", "phase", "sourceSnapshotId", "submissionSnapshotId"] as const)
        if (!isDeepStrictEqual(live[key], record[key])) throw new Error("The maker submission placement changed");
      if (!member || member.keeperThreadId !== maker.keeperThreadId || member.boardQuestId !== maker.boardQuestId ||
          !canCapture(member))
        throw new Error("The maker submission assignment is no longer active");
      if (pinnedEntries && !isDeepStrictEqual(entries(), pinnedEntries)) throw new Error("The maker journal entries changed during submission capture");
    };
    const active = (thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>) => {
      if (thread.id !== makerThreadId || thread.projectId !== record.projectId || thread.environmentId !== record.environmentId || thread.archivedAt !== null || thread.deletedAt !== null)
        throw new Error("The maker SDK thread or environment changed during submission capture");
      if (!isQuiescentThread(thread)) throw new MakerBusy();
      return [thread.updatedAt, thread.latestAttentionAt, thread.queuedMessageCount];
    };
    try {
      current();
      active(await this.bb.sdk.threads.get({ threadId: makerThreadId, signal })); current();
      // A maker that reported done is no longer live for work, so read its finished tree under the idle-only hold preservation uses.
      token = this.holds.requestContentHold(makerThreadId, { operationId: "submission-" + randomUUID(), idleOnly: true, preservation: maker.engagement === "resting" });
      current();
      const confirmed = await this.holds.confirmHeld(token); current();
      if (confirmed.state !== "confirmed") {
        if (confirmed.state === "pending") throw new MakerBusy();
        throw new Error(confirmed.error ?? "The submission content hold is stale");
      }
      const baseline = active(await this.bb.sdk.threads.get({ threadId: makerThreadId, signal })); current();
      const held = () => { current(); if (this.holds.inspectHeld(token!).state !== "confirmed") throw new Error("The submission content hold is no longer confirmed"); };
      const source = await readSourceIdentity(this.bb, makerThreadId, record.projectId, signal); held();
      const home = await readSourceIdentity(this.bb, record.keeperThreadId, record.projectId, signal); held(); operation.hosts.add(home.endpoint.hostId);
      if (source.endpoint.hostId !== record.hostId || source.endpoint.environmentId !== record.environmentId)
        throw new Error("The SDK maker endpoint does not match its placement");
      const fence = async () => {
        held();
        const thread = await this.bb.sdk.threads.get({ threadId: makerThreadId, signal }); held();
        if (!isDeepStrictEqual(active(thread), baseline)) throw new MakerBusy();
        const from = await readSourceIdentity(this.bb, makerThreadId, record.projectId, signal); held();
        const to = await readSourceIdentity(this.bb, record.keeperThreadId, record.projectId, signal); held();
        if (!isDeepStrictEqual(from, source) || !isDeepStrictEqual(to, home)) throw new Error("The submission SDK endpoint identity changed");
      };
      const call = async <M extends HostMethod>(method: M, input: HostInput<M>): Promise<HostOutput<M>> => {
        await fence();
        let reply: HostOutput<M>;
        try { reply = await this.host.call(source.endpoint.hostId, method, input, { signal }); }
        catch (error) { await fence(); throw error; }
        held(); await fence();
        return hostContract[method].output.parse(reply) as HostOutput<M>;
      };
      await this.journal.prepare(makerThreadId); held(); pinnedEntries = entries();
      if (!pinnedEntries.length || pinnedEntries.some(entry => !["done", "verified"].includes(entry.status) || !entry.evidence.length))
        throw new Error("A maker submission needs done journal entries with evidence for this waypoint");
      const authority = { placementId: record.id, generation: record.generation, endpointId: "submission-source", operationId: randomUUID() };
      const ack = await call("registerEndpoint", { placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId,
        endpoint: source.endpoint, ownerThreadId: makerThreadId, access: "source-read", git: "porcelain", workspaceKind: null, objectFormat: null, allowedRefs: [] });
      if (ack.generation !== record.generation) throw new Error("The submission endpoint acknowledged a stale generation");
      const inspection = await call("inspect", authority);
      if (inspection.root !== record.root || !inspection.features.exportChanges)
        throw new SourceCaptureError("source-root-required", "Use a maker environment at the repository root before capturing its submission.");
      const original = record.sourceSnapshotId ? this.placements.snapshot(record.sourceSnapshotId) : null;
      if (!original?.fetch) throw new SourceCaptureError("source-base-unavailable", "The maker has no recorded source base and remote; reconcile its placement before capture.");
      const captured = await call("snapshotWorktree", { ...authority, base: original.base });
      if ("outcome" in captured) throw new SourceCaptureError(captured.code, captured.message, captured.retryable);
      if (captured.head !== inspection.head || captured.headTree !== inspection.tree) throw new SourceCaptureError("source-changed", "The maker source changed during capture; retry when it is idle.", true);
      const previous = this.keepers.runtime(makerThreadId).submissionTarget;
      const previousSnapshot = record.submissionSnapshotId ? this.placements.snapshot(record.submissionSnapshotId) : null;
      if (previous && previousSnapshot?.homeCommit && previous.snapshotId === previousSnapshot.id && previousSnapshot.objectFormat === inspection.objectFormat &&
          previous.makerThreadId === makerThreadId && previous.boardQuestId === record.questId && previous.waypointId === waypointId &&
          previous.expectedTree === captured.tree && previousSnapshot.tree === captured.tree && previous.makerSubmissionId === previousSnapshot.makerSubmissionId &&
          previousSnapshot.home.hostId === home.endpoint.hostId && previousSnapshot.home.environmentId === home.endpoint.environmentId &&
          previous.journalTargets?.length === pinnedEntries.length && pinnedEntries.every(entry => previous.journalTargets!.some(target =>
            target.journalEntryId === entry.id && target.entryFingerprint === journalEntryFingerprint(entry)))) {
        held();
        return { state: "captured", snapshot: previousSnapshot, reviewTarget: previous };
      }
      const makerSubmissionId = randomUUID(), reviewKey = randomUUID(), reviewAssignmentId = randomUUID();
      const journalTargets = pinnedEntries.map(entry => ({ boardQuestId: record.questId!, waypointId, makerThreadId, journalEntryId: entry.id,
        entryFingerprint: journalEntryFingerprint(entry), reviewAssignmentId }));
      await fence();
      let homeEndpoint: Endpoint = home.endpoint;
      if (record.sourceSnapshotId) {
        if (!original || original.home.hostId !== home.endpoint.hostId || original.home.environmentId !== home.endpoint.environmentId)
          throw new Error("The maker's original home snapshot is missing or no longer matches its Keeper");
        homeEndpoint = original.home;
      }
      const snapshot = this.placements.captureSnapshot({ purpose: "submission", keeperThreadId: record.keeperThreadId, projectId: record.projectId,
        sourceThreadId: makerThreadId, makerThreadId, makerSubmissionId, journalTarget: journalTargets[0]!, journalTargets,
        objectFormat: inspection.objectFormat, base: original.base, sourceHead: captured.commit, tree: captured.tree,
        fetch: sourceFetchSchema.parse(original.fetch), source: { ...source.endpoint, root: inspection.root },
        home: homeEndpoint,
        includesUncommitted: captured.includesUncommitted, userHead: captured.head,
        ...(captured.includesUncommitted ? { uncommittedOrigin: { ...source.endpoint, root: inspection.root } } : {}), modifiedPaths: captured.modifiedPaths, untrackedPaths: captured.untrackedPaths });
      const pinned = await this.placements.snapshotOwners.withSubmissionReadReference(record.id, record.generation, snapshot.id, held,
        () => this.transport.bringHome(record.id, record.generation, snapshot.id, signal)); held();
      await fence();
      const reviewTarget: ReviewTarget = { boardQuestId: record.questId, waypointId, makerThreadId, entryIds: pinnedEntries.map(entry => entry.id),
        snapshotId: pinned.id, expectedTree: pinned.tree, makerSubmissionId, reviewKey, journalTargets };
      held();
      this.placements.update(record.id, record.generation, value => ({ ...value, submissionSnapshotId: pinned.id }));
      this.keepers.patch(makerThreadId, { submissionTarget: reviewTarget });
      return { state: "captured", snapshot: pinned, reviewTarget };
    } catch (error) {
      if (error instanceof MakerBusy) return busy();
      throw error;
    } finally {
      if (token) this.holds.finishContentHold(token);
      this.operations.delete(operation);
    }
  }
}
