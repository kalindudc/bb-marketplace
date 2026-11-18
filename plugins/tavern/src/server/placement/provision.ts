import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PlacementRecord } from "../../shared/placement";
import { providerInputsSchema } from "../../shared/placement-settings";
import { rejectedSpawn } from "../hires";
import type { KeeperStore, HireIntent } from "../keeper/store";
import { assertTavernRunning } from "../stop-all";
import { PlacementStore, StalePlacementError } from "./store";

const id = z.string().min(1);
const selectionSchema = z.object({
  type: z.literal("provider"), environmentProviderId: id, inputs: providerInputsSchema,
  machine: z.discriminatedUnion("type", [
    z.object({ type: z.literal("existing"), hostId: id }).strict(),
    z.object({ type: z.literal("new"), machineProviderId: id, inputs: providerInputsSchema }).strict(),
  ]),
}).strict();
type Execution = { providerId: string; model?: string; reasoningLevel?: string; permissionMode: "full" };

export class PlacementProvisioner {
  private readonly spawning = new Map<string, Promise<PlacementRecord>>();

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "pluginId">,
    private readonly placements: PlacementStore,
    private readonly hires: KeeperStore,
  ) {}

  reserve(record: PlacementRecord, limits: { maxMakers: number; maxCheckers: number }, intent: HireIntent): PlacementRecord {
    return this.hires.db.transaction(() => {
      const selection = selectionSchema.parse(record.target);
      if (intent.projectId !== record.projectId || intent.classId !== record.classId ||
          intent.owner.keeperThreadId !== record.keeperThreadId || intent.owner.boardQuestId !== record.questId)
        throw new Error("Hire intent does not match the private placement owner");
      if (!record.rule || record.workspaceKind === null || record.ownsNewMachine !== (selection.machine.type === "new"))
        throw new Error("Provider placement needs a normalized rule, machine and workspace identity");
      if (record.ownsNewMachine && (!record.rule.acceptedConsent.guardInstall || !record.rule.acceptedConsent.remoteDetectionOnly ||
          !record.rule.acceptedConsent.linuxUncontainedChecks)) throw new Error("Provider placement lacks once-per-rule machine consent");
      if (record.workspaceKind === "dedicated-machine" && !record.ownsNewMachine)
        throw new Error("A dedicated-machine placement requires a distinct new machine");
      const snapshot = record.sourceSnapshotId === null ? null : this.placements.snapshot(record.sourceSnapshotId);
      if (!snapshot || snapshot.projectId !== record.projectId || snapshot.keeperThreadId !== record.keeperThreadId)
        throw new Error("Provider placement needs its actual initial or review source snapshot");
      if (record.reviewTarget === null && snapshot.purpose !== "initial")
        throw new Error("A new maker placement needs initial source provenance, not a fabricated submission");
      if (record.reviewTarget !== null && (record.reviewTarget.snapshotId !== snapshot.id || snapshot.purpose !== "submission" ||
          snapshot.homeCommit === null || record.reviewTarget.expectedTree !== snapshot.tree ||
          record.reviewTarget.makerSubmissionId !== snapshot.makerSubmissionId || !isDeepStrictEqual(record.reviewTarget.journal, snapshot.journalTarget)))
        throw new Error("Review placement does not match its exact pinned submission snapshot");
      const prior = this.hires.get("hires", record.hireToken);
      if (prior !== null && !isDeepStrictEqual(prior, intent)) throw new Error("Hire token already belongs to another intent");
      const reserved = this.placements.reserve(record, limits);
      if (prior === null) this.hires.put("hires", record.hireToken, intent);
      return reserved;
    }).immediate();
  }

  bindDispatchedMember(hireToken: string, threadId: string): PlacementRecord {
    return this.hires.db.transaction(() => {
      const record = this.placements.byHireToken(hireToken), intent = this.hires.get("hires", hireToken);
      if (!record || !intent) throw new Error("Unknown private placement hire token");
      this.placements.assertCurrent(record.id, record.generation);
      if (record.memberThreadId !== null && record.memberThreadId !== threadId)
        throw new Error("Immutable placement member binding");
      if (!["provisioning", "bootstrapping"].includes(record.phase)) throw new Error("Placement is not awaiting its initial provision dispatch");
      if (intent.memberThreadId !== undefined && intent.memberThreadId !== threadId)
        throw new Error("Hire intent already has another member binding");
      const bound = this.placements.update(record.id, record.generation, current => ({
        ...current, memberThreadId: threadId, phase: "bootstrapping", blocked: null, resumePhase: null,
        preservation: { ...current.preservation, liveOwnerThreadId: threadId },
      }));
      this.hires.put("hires", hireToken, { ...intent, memberThreadId: threadId });
      return bound;
    }).immediate();
  }

  spawn(placementId: string, generation: number, execution: Execution): Promise<PlacementRecord> {
    const key = `${placementId}:${generation}`;
    const pending = this.spawning.get(key);
    if (pending) return pending;
    const operation = this.spawnOnce(placementId, generation, execution);
    this.spawning.set(key, operation);
    void operation.then(() => this.spawning.delete(key), () => this.spawning.delete(key));
    return operation;
  }

  private async spawnOnce(placementId: string, generation: number, execution: Execution): Promise<PlacementRecord> {
    assertTavernRunning(this.hires);
    const record = this.placements.assertCurrent(placementId, generation);
    const intent = this.hires.get("hires", record.hireToken);
    if (!intent) throw new Error("The private placement hire intent is missing; reconcile before provisioning");
    if (record.memberThreadId !== null) return record;
    if (record.phase !== "reserved") throw new Error("The spawn outcome is unknown or blocked; reconcile its resources before another allocation");
    const environment = selectionSchema.parse(record.target);
    if (execution.permissionMode !== "full" || !execution.providerId) throw new Error("A provider bootstrap needs an explicit configured execution request");
    this.placements.update(placementId, generation, current => ({ ...current, phase: "provisioning" }));
    try {
      const child = await this.bb.sdk.threads.spawn({
        projectId: record.projectId, parentThreadId: record.keeperThreadId, parentNotifications: "off",
        title: intent.owner.displayName ? `${intent.owner.displayName}: ${intent.owner.title}` : intent.owner.title,
        environment, ...execution,
        input: [{ type: "text", mentions: [], visibility: "agent-only", text:
          "Call tavern_ready {} before substantive work. It binds the provisioned checkout and exact source tree; stop and report its blocker if setup fails. " +
          "Readiness is not a guard-loaded receipt. Remote execution is Detection only (remote), never prevention. " +
          "If the destination refuses this configured execution request, report its exact failure; do not substitute another provider or model.\n\n" + (intent.initialInput ?? "") }],
        pluginSubmission: { pluginId: this.bb.pluginId, data: { hireToken: record.hireToken } },
        pluginMetadata: { classId: intent.classId, characterId: intent.characterId, hireToken: record.hireToken },
      });
      const current = this.placements.get(placementId);
      if (!current) throw new StalePlacementError("The placement disappeared during provisioning; reconcile the returned child");
      if (current.generation !== generation || current.desiredState !== "running") {
        if (current.desiredState === "released") this.retainLateChild(current, child.id);
        throw new StalePlacementError("Cancelled or stale placement spawn; the late child remains a preservation owner");
      }
      if (current.memberThreadId === child.id) return current;
      return this.bindDispatchedMember(record.hireToken, child.id);
    } catch (error) {
      const current = this.placements.get(placementId);
      if (!current || current.generation !== generation || current.desiredState !== "running") throw error;
      if (current.memberThreadId !== null && current.phase === "bootstrapping") return current;
      this.placements.block(placementId, generation, { stage: "provision", code: rejectedSpawn(error) ? "spawn-refused" : "spawn-outcome-unknown",
        message: error instanceof Error ? error.message : String(error), retryable: false });
      throw error;
    }
  }

  private retainLateChild(record: PlacementRecord, threadId: string): void {
    this.hires.db.transaction(() => {
      const current = this.placements.assertCurrent(record.id, record.generation, "released");
      if (current.memberThreadId !== null && current.memberThreadId !== threadId)
        throw new Error("A different late child already owns this placement; reconcile both before release");
      this.placements.update(record.id, record.generation, value => ({ ...value,
        memberThreadId: threadId, phase: "preserving", blocked: null, resumePhase: null,
        preservation: { ...value.preservation, liveOwnerThreadId: threadId, source: "pending", stopConfirmed: false,
          reason: "A child arrived after cancellation; preserve it before controlled release." },
      }), "released");
      const intent = this.hires.get("hires", current.hireToken);
      if (intent) this.hires.put("hires", current.hireToken, { ...intent, memberThreadId: threadId });
    }).immediate();
  }
}
