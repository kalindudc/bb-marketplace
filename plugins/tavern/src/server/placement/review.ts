import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createHostPort } from "../../host/client";
import { hostContract } from "../../host-contract";
import { tags } from "../../shared/contract";
import { KeeperStore } from "../keeper/store";
import type { Database, JournalDeps, JournalPort } from "../ports";
import { PlacementStore, StalePlacementError } from "./store";
import { journalEntryFingerprint } from "./submission";
import { makerForWaypoint } from "../assignments";
import type { ReviewTarget } from "../keeper/store";

export class PlacementReview {
  private readonly placements;
  private readonly keepers;
  private host: ReturnType<typeof createHostPort> | undefined;
  private readonly lifetime = new AbortController();
  constructor(private readonly bb: BbPluginApi, db: Database, private readonly journal: Pick<JournalPort, "get">, private readonly deps: JournalDeps) {
    this.placements = new PlacementStore(db); this.keepers = new KeeperStore(db);
    bb.onDispose(() => this.lifetime.abort(new Error("Warden verdict checks disposed")));
  }

  async beforeVerdict(callerThreadId: string, targetThreadId: string, entryIds: string[]): Promise<(() => string | void) | void> {
    const initial = this.placements.byMember(callerThreadId);
    if (!initial?.reviewTarget) return;
    const superseded = (reason: string): never => {
      const message = `${reason} Hire a new Warden for this waypoint; this Warden's pinned tree is out of date.`;
      this.keepers.event(Date.now(), initial.keeperThreadId, initial.questId, "review.superseded", message, { memberThreadId: callerThreadId }, { kind: "tavern" });
      this.deps.invalidate([tags.thread(initial.keeperThreadId), ...(initial.questId ? [tags.boardQuest(initial.questId)] : [])]);
      throw new Error(message);
    };
    const target = this.keepers.runtime(callerThreadId).reviewTarget, pinned = initial.reviewTarget;
    if (!target?.reviewKey || !target.journalTargets?.length || !target.waypointFingerprint || targetThreadId !== pinned.makerThreadId ||
        !entryIds.length || entryIds.some(id => !target.entryIds.includes(id))) throw new Error("The verdict does not match this Warden's pinned maker journal targets.");
    const snapshot = this.placements.snapshot(pinned.snapshotId), makerPlacement = this.placements.byMember(pinned.makerThreadId);
    if (!snapshot || !makerPlacement) return superseded("The pinned maker submission is unavailable.");
    const validateCurrent = () => {
      const record = this.placements.assertCurrent(initial.id, initial.generation);
      let maker;
      try { maker = this.placements.assertCurrent(makerPlacement.id, makerPlacement.generation); }
      catch (error) {
        if (error instanceof StalePlacementError) return superseded("The maker's placement was released or replaced.");
        throw error;
      }
      const warden = this.keepers.get("members", callerThreadId), makerMember = this.keepers.get("members", pinned.makerThreadId);
      const role = this.deps.roleOf(callerThreadId), state = this.keepers.runtime(callerThreadId);
      if (!isDeepStrictEqual(record.reviewTarget, pinned) || !isDeepStrictEqual(state.reviewTarget, target))
        superseded("The review no longer matches its pinned snapshot and journal assignment.");
      if (!["ready", "running"].includes(record.phase) || record.hostId !== initial.hostId || record.environmentId !== initial.environmentId || record.root !== initial.root ||
          !record.hostId || !record.root || !record.acknowledgedScopeRevision || state.released || state.archivedAt != null)
        throw new Error("The Warden placement or content readiness changed before its verdict.");
      let waypointFingerprint: string;
      try { waypointFingerprint = reviewWaypointFingerprint(this.keepers, target); }
      catch { throw new Error("The quest or waypoint is no longer active; no verdict is needed."); }
      if (!warden || warden.classId !== "warden" || warden.checkerMakerThreadId !== pinned.makerThreadId || warden.checkerWaypointId !== target.waypointId ||
          warden.boardQuestId !== target.boardQuestId || ["done", "stopped", "failed"].includes(warden.state) ||
          role?.classId !== "warden" || role.boardQuestId !== target.boardQuestId ||
          !(role.checkerWaypointIds ? role.checkerWaypointIds.includes(target.waypointId) : role.waypointId === null || role.waypointId === target.waypointId) ||
          !makerMember || makerMember.boardQuestId !== target.boardQuestId || this.keepers.runtime(pinned.makerThreadId).released ||
          waypointFingerprint !== target.waypointFingerprint)
        superseded("The reviewed waypoint or Warden assignment changed.");
      const submission = this.keepers.runtime(pinned.makerThreadId).submissionTarget;
      if (maker.submissionSnapshotId !== pinned.snapshotId || submission?.makerSubmissionId !== pinned.makerSubmissionId || submission.reviewKey !== target.reviewKey ||
          submission.snapshotId !== pinned.snapshotId || target.snapshotId !== pinned.snapshotId || target.expectedTree !== pinned.expectedTree ||
          !isDeepStrictEqual(submission.journalTargets, target.journalTargets))
        superseded("The maker has a newer submission.");
      if (snapshot.tree !== pinned.expectedTree || snapshot.makerSubmissionId !== pinned.makerSubmissionId ||
          !isDeepStrictEqual(snapshot.journalTargets, target.journalTargets) || !isDeepStrictEqual(snapshot.journalTarget, pinned.journal))
        superseded("The review no longer matches its pinned snapshot and journal assignment.");
      const entries = this.journal.get(pinned.makerThreadId).entries.filter(entry => entry.link?.boardQuestId === target.boardQuestId && entry.link.waypointId === target.waypointId);
      if (entries.length !== target.journalTargets!.length || target.journalTargets!.some(journal => {
        const entry = entries.find(entry => entry.id === journal.journalEntryId);
        return journal.makerThreadId !== pinned.makerThreadId || journal.boardQuestId !== target.boardQuestId || journal.waypointId !== target.waypointId ||
          !entry || !["done", "verified", "rejected"].includes(entry.status) || !entry.evidence.length || journalEntryFingerprint(entry) !== journal.entryFingerprint;
      })) superseded("The maker journal entries changed since submission.");
    };
    const assertCurrent = () => {
      this.lifetime.signal.throwIfAborted();
      validateCurrent();
    };
    assertCurrent();
    const identity = async () => {
      const thread = await this.bb.sdk.threads.get({ threadId: callerThreadId, signal: this.lifetime.signal }); assertCurrent();
      if (thread.id !== callerThreadId || thread.projectId !== initial.projectId || thread.environmentId !== initial.environmentId || thread.archivedAt !== null || thread.deletedAt !== null)
        throw new Error("The Warden SDK thread or environment changed before its verdict.");
      const environment = await this.bb.sdk.environments.get({ environmentId: thread.environmentId!, signal: this.lifetime.signal }); assertCurrent();
      if (environment.hostId !== initial.hostId || environment.id !== initial.environmentId || environment.path !== initial.root || environment.projectId !== initial.projectId ||
          environment.status !== "ready" || environment.hostLifecycle !== "active" || environment.lifecycle.phase !== "active")
        throw new Error("The Warden SDK host or checkout changed before its verdict.");
    };
    await identity(); assertCurrent();
    const checked = hostContract.worktreeState.output.parse(await (this.host ??= createHostPort(this.bb)).call(initial.hostId!, "worktreeState", {
      placementId: initial.id, generation: initial.generation, endpointId: "carry-member", operationId: randomUUID(), base: snapshot.base, baseTree: pinned.expectedTree, trackedOnly: true,
    }, { signal: this.lifetime.signal }));
    assertCurrent(); await identity(); assertCurrent();
    if (checked.dirty || checked.unfinishedMerge || checked.tree !== pinned.expectedTree)
      throw new Error(`The checked tracked content differs from the submitted work.${checked.changed.length ? ` Changed paths: ${checked.changed.join(", ")}.` : ""} Restore your checkout to the pinned tree, then verify again.`);
    return () => {
      assertCurrent();
      if (checked.changed.length) return `Untracked files present during the check: ${checked.changed.join(", ")}. The verdict covers the pinned tree and clean tracked content.`;
    };
  }
}

export function reviewWaypointFingerprint(keepers: KeeperStore, target: ReviewTarget): string {
  const quest = keepers.get("quests", target.boardQuestId);
  const plan = quest ? keepers.get("plans", `${quest.id}:${quest.planVersion}`) : null;
  const waypoint = plan?.waypoints.find(item => item.id === target.waypointId);
  if (!plan || !waypoint || !quest || ["done", "stopped", "stopping"].includes(quest.phase)) throw new Error("The reviewed waypoint is no longer active.");
  const members = keepers.all("members").filter(member => member.boardQuestId === quest.id && !keepers.runtime(member.threadId).released);
  // Preserve existing fingerprints when a plan makes its implicit Warden check explicit.
  const { check, ...work } = waypoint;
  const binding = check === "warden" ? work : waypoint;
  return createHash("sha256").update(JSON.stringify({ waypoint: binding, maker: makerForWaypoint(plan, members, waypoint.id) })).digest("hex");
}
