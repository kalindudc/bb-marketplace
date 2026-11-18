import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { scopeDeliveryFileSchema } from "../../scope/schema";
import { hostScopeStateSchema, type HostScopeState } from "../../scope/host-env";
import { scopeObservationBindingSchema, type ScopeObservationBinding } from "../../scope/store";
import { sha256Schema, type PlacementRecord } from "../../shared/placement";
import type { Database } from "../ports";
import type { HostPort } from "../../host/client";
import type { RemoteScopeObservation } from "../../scope/watch";
import { PlacementStore, StalePlacementError } from "./store";

const id = z.string().min(1).max(200);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const readySchema = hostScopeStateSchema.options[1];
const deliverySchema = z.object({
  memberThreadId: id, environmentId: id, templateDigest: sha256Schema,
  binding: scopeObservationBindingSchema,
  scopeFileJson: z.string().min(1).max(2 * 1024 * 1024).refine(value => Buffer.byteLength(value, "utf8") <= 2 * 1024 * 1024),
  acknowledged: readySchema.shape.acknowledged.nullable(),
}).strict().superRefine((value, ctx) => {
  if (sha(value.scopeFileJson) !== value.binding.scopeDigest)
    ctx.addIssue({ code: "custom", path: ["scopeFileJson"], message: "Exact delivery bytes do not match their digest" });
  if (value.acknowledged !== null && !isDeepStrictEqual(value.acknowledged.binding, value.binding))
    ctx.addIssue({ code: "custom", path: ["acknowledged"], message: "Native acknowledgment belongs to another delivery binding" });
});
export type PlacementDelivery = z.infer<typeof deliverySchema>;

export class PlacementDeliveries {
  constructor(private readonly db: Database, private readonly placements: PlacementStore) {}

  get(placementId: string): PlacementDelivery | null {
    const row = this.db.prepare("SELECT scope_delivery_json FROM tavern_placements WHERE id=?").get(placementId) as
      { scope_delivery_json: string | null } | undefined;
    if (row === undefined || row.scope_delivery_json === null) return null;
    const delivery = deliverySchema.parse(JSON.parse(row.scope_delivery_json));
    if (delivery.binding.placementId !== placementId) throw new Error("Stored scope delivery belongs to another placement");
    return delivery;
  }

  private save(placementId: string, input: PlacementDelivery): PlacementDelivery {
    const delivery = deliverySchema.parse(input);
    this.db.prepare("UPDATE tavern_placements SET scope_delivery_json=? WHERE id=?").run(JSON.stringify(delivery), placementId);
    return delivery;
  }

  private assertEndpoint(record: PlacementRecord): asserts record is PlacementRecord & {
    memberThreadId: string; environmentId: string; hostId: string; root: string;
  } {
    if (record.memberThreadId === null || record.environmentId === null || record.hostId === null || record.root === null || record.workspaceKind === null)
      throw new Error("A host scope delivery requires the actual private member workspace binding");
  }

  private assertCurrentDelivery(record: PlacementRecord, delivery: PlacementDelivery): void {
    this.assertEndpoint(record);
    if (delivery.binding.generation !== record.generation || delivery.binding.placementId !== record.id ||
        delivery.memberThreadId !== record.memberThreadId || delivery.environmentId !== record.environmentId ||
        delivery.binding.hostId !== record.hostId || delivery.binding.cwd !== record.root ||
        delivery.binding.revision !== record.desiredScopeRevision)
      throw new StalePlacementError("The private scope delivery binding changed; discard the stale acknowledgment");
  }

  prepare(placementId: string, generation: number, input: {
    endpointId: string; templateDigest: string; scopeFileJson: string;
  }): PlacementDelivery {
    return this.db.transaction(() => {
      const record = this.placements.assertCurrent(placementId, generation);
      this.assertEndpoint(record);
      id.parse(input.endpointId); sha256Schema.parse(input.templateDigest);
      const envelope = scopeDeliveryFileSchema.parse(JSON.parse(input.scopeFileJson));
      const { bindingTemplate, workspaceBinding, bindingEndpoints: _endpoints, ...outer } = envelope;
      if (bindingTemplate.threadId !== record.memberThreadId || !isDeepStrictEqual(outer, bindingTemplate) ||
          sha(JSON.stringify(bindingTemplate)) !== input.templateDigest)
        throw new Error("Delivery must retain its exact original effective template and originating template fingerprint");
      if (workspaceBinding.placementId !== record.id || workspaceBinding.generation !== generation || workspaceBinding.hostId !== record.hostId ||
          workspaceBinding.environmentId !== record.environmentId || workspaceBinding.root !== record.root || workspaceBinding.kind !== record.workspaceKind)
        throw new Error("Delivery workspace binding does not match the private placement endpoint");
      if (bindingTemplate.preset === "checker") {
        if (!record.reviewTarget || workspaceBinding.snapshotId !== record.reviewTarget.snapshotId || workspaceBinding.expectedTree !== record.reviewTarget.expectedTree)
          throw new Error("A checker workspace binding requires its actual pinned review snapshot and tree");
      } else if (workspaceBinding.snapshotId !== null || workspaceBinding.expectedTree !== null) {
        const snapshot = record.sourceSnapshotId === null ? null : this.placements.snapshot(record.sourceSnapshotId);
        if (!snapshot || workspaceBinding.snapshotId !== snapshot.id || workspaceBinding.expectedTree !== snapshot.tree)
          throw new Error("The workspace snapshot binding does not match this placement's source");
      }
      const previous = this.get(placementId);
      if (previous !== null && previous.binding.generation === generation && previous.memberThreadId === record.memberThreadId &&
          previous.environmentId === record.environmentId && previous.binding.endpointId === input.endpointId &&
          previous.binding.hostId === record.hostId && previous.binding.cwd === record.root && previous.scopeFileJson === input.scopeFileJson &&
          previous.templateDigest === input.templateDigest && previous.binding.revision === record.desiredScopeRevision) return previous;
      const revision = previous?.binding.generation === generation
        ? Math.max(record.desiredScopeRevision, previous.binding.revision + 1) : record.desiredScopeRevision;
      const delivery = deliverySchema.parse({ memberThreadId: record.memberThreadId, environmentId: record.environmentId,
        templateDigest: input.templateDigest, scopeFileJson: input.scopeFileJson, acknowledged: null,
        binding: { placementId, generation, endpointId: input.endpointId, revision, scopeDigest: sha(input.scopeFileJson), hostId: record.hostId, cwd: record.root },
      });
      this.placements.update(placementId, generation, value => ({ ...value, desiredScopeRevision: revision, acknowledgedScopeRevision: null }));
      return this.save(placementId, delivery);
    }).immediate();
  }

  acknowledge(placementId: string, generation: number, expected: ScopeObservationBinding, reply: unknown): PlacementDelivery {
    return this.db.transaction(() => {
      const record = this.placements.assertCurrent(placementId, generation), delivery = this.get(placementId);
      if (delivery === null) throw new StalePlacementError("No current scope delivery exists for this acknowledgment");
      this.assertCurrentDelivery(record, delivery);
      if (!isDeepStrictEqual(expected, delivery.binding)) throw new StalePlacementError("The expected scope binding changed while native delivery was pending");
      const receipt = z.object({ revision: z.number().int().positive(), scopeDigest: sha256Schema,
        scopeFile: readySchema.shape.acknowledged.shape.scopeFile, variables: readySchema.shape.acknowledged.shape.variables }).strict().parse(reply);
      if (receipt.revision !== expected.revision || receipt.scopeDigest !== expected.scopeDigest)
        throw new StalePlacementError("The native acknowledgment has a stale delivery revision or digest");
      const acknowledged = readySchema.shape.acknowledged.parse({ binding: expected, scopeFile: receipt.scopeFile, variables: receipt.variables });
      if (delivery.acknowledged !== null && !isDeepStrictEqual(delivery.acknowledged, acknowledged))
        throw new Error("A repeated native acknowledgment changed its scope path or variables; reconcile the host binding");
      const saved = this.save(placementId, { ...delivery, acknowledged });
      this.placements.update(placementId, generation, value => ({ ...value, acknowledgedScopeRevision: expected.revision }));
      return saved;
    }).immediate();
  }

  observationForThread(threadId: string, host: HostPort): RemoteScopeObservation | undefined {
    const state = this.forThread(threadId);
    if (state === undefined || state.kind === "unavailable") return state;
    const expected = state.expected;
    const current = () => {
      const next = this.forThread(threadId);
      if (next?.kind !== "ready" || !isDeepStrictEqual(next, state))
        throw new StalePlacementError("The remote scope acknowledgment changed during observation");
    };
    const { hostId, cwd, ...binding } = expected;
    return { kind: "ready", hostId, cwd, binding, prepare: async call => {
      current();
      const reply = await host.call(hostId, "prepareCall", { placementId: binding.placementId, generation: binding.generation,
        endpointId: binding.endpointId, operationId: randomUUID(), scopeRevision: binding.revision, call } as import("../../host-contract").HostInput<"prepareCall">);
      current();
      return reply;
    } };
  }

  forThread(threadId: string): HostScopeState | undefined {
    try {
      const record = this.placements.byMember(threadId);
      if (record === null) return undefined;
      if (record.desiredState !== "running" || !["ready", "running"].includes(record.phase))
        return { kind: "unavailable", reason: "The placed member is not content-ready on its current host" };
      const delivery = this.get(record.id);
      if (delivery === null || delivery.acknowledged === null || record.acknowledgedScopeRevision !== record.desiredScopeRevision)
        return { kind: "unavailable", reason: "The placed member has no current native scope delivery acknowledgment" };
      this.assertCurrentDelivery(record, delivery);
      return readySchema.parse({ kind: "ready", templateDigest: delivery.templateDigest, expected: delivery.binding, acknowledged: delivery.acknowledged });
    } catch {
      return { kind: "unavailable", reason: "The private placement scope acknowledgment is stale or invalid; reconcile it before restarting this scoped session" };
    }
  }
}
